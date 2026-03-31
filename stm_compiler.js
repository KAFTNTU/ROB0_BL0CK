/* ================================================================
   Батарея: оновлення UI
   STM32 шле пакет [0xA6, hi, lo] (ADC значення) кожні 5с
   ================================================================ */
window.updateBatUI = function(adcVal) {
    const volts = adcVal / 376.0;
    let pct = Math.round((volts - 7.0) / 1.4 * 100);
    pct = Math.max(0, Math.min(100, pct));
    window._batPct   = pct;
    window._batVolts = Math.round(volts * 100) / 100;
    const lbl = document.getElementById('batPct');
    if (lbl) lbl.textContent = pct + '%';
    if (typeof window._updateBatDisplayBlocks === 'function') window._updateBatDisplayBlocks();
};

/* ================================================================
   stm_compiler.js
   Компілятор Blockly → байткод для program_runer STM32

   Підключити в index.html після blocks_car_fixed3.js:
     <script src="stm_compiler.js"></script>
   ================================================================ */

(function () {

/* ---- Опкоди (мусять збігатись з program_runner.h) ---- */
const OP = {
    DRIVE_SET:    0x01, DRIVE:        0x02,
    DRIVE4_SET:   0x03, DRIVE4:       0x04,
    SET_MOTOR:    0x05, STOP:         0x06,
    WAIT:         0x07, SET_SPEED:    0x08,

    JUMP:         0x10, JUMP_IF_F:    0x11,
    REPEAT_START: 0x12, REPEAT_END:   0x13,
    LOOP_END:     0x14,

    PUSH_CONST:   0x20, PUSH_SENSOR:  0x21,
    PUSH_BOOL:    0x22, PUSH_TIMER:   0x23,
    TIMER_RESET:  0x24,

    CMP_LT:  0x30, CMP_GT:  0x31, CMP_EQ:  0x32,
    CMP_NEQ: 0x33, CMP_LTE: 0x34, CMP_GTE: 0x35,
    AND: 0x38, OR: 0x39, NOT: 0x3A,
    ADD: 0x40, SUB: 0x41, MUL: 0x42, DIV: 0x43,
    END: 0xFF,

    /* --- Дисплей 0x50-0x5F --- */
    PAUSE:       0x09,  /* чекати ms без зупинки моторів */
    DISP_CLEAR:  0x50,
    DISP_TEXT:   0x51,
    DISP_NUMBER: 0x52,
    DISP_PIXEL:  0x53,
    DISP_LINE:   0x54,
    DISP_BITMAP: 0x55,
    DISP_SMILE:  0x56,
    DISP_UPDATE: 0x57,
    DISP_RLE:    0x58,  /* RLE bitmap */
    DISP_FILL:   0x59,  /* заповнити екран */
    DISP_PIXEL_DYN: 0x5B,  /* піксель ON, x/y зі стеку */
    DISP_PIXEL_CLR: 0x5C,  /* піксель OFF, x/y зі стеку */
    DISP_PIXEL_GET: 0x5D,  /* перевірити піксель, x/y зі стеку → push 0/1 */

    /* --- Анімація 0x60-0x63 --- */
    DISP_FRAME_STORE: 0x60, /* [idx, rleLen_hi, rleLen_lo, rle...] — зберегти RLE кадр в таблиці */
    DISP_FRAME_LOAD:  0x61, /* [idx] — розпакувати кадр idx в буфер дисплея */
    DISP_HUD:         0x5E, /* [] — повернути стандартний HUD */
};

/* ---- Протокольні команди ---- */
const PCMD = {
    BEGIN: 0xA0, END: 0xA1,
    RUN:   0xA2, STOP: 0xA3,
    CLEAR: 0xA4, CHUNK: 0xB0,
    SAVE:  0xA5,  /* зберегти в FRAM автоматично */
};

/* ================================================================
   Клас Compiler
   ================================================================ */
class Compiler {
    constructor() {
        this.buf = [];     /* байти програми */
        this.errors = [];  /* попередження/помилки */
        this._warnedDisp = false; /* щоб не спамити лог */
    }

    /* --- Базові emit --- */
    emit(b)    { this.buf.push(b & 0xFF); }
    emit16(v)  {
        v = Math.round(v);
        if (v < 0)      v = v & 0xFFFF;
        if (v > 65535)  v = 65535;
        this.buf.push((v >> 8) & 0xFF, v & 0xFF);
    }
    emitI8(v)  {
        v = Math.round(Math.max(-100, Math.min(100, v || 0)));
        this.buf.push(v < 0 ? v + 256 : v);
    }
    emitMs(sec) {
        const ms = Math.round(Math.max(0, Math.min(65535, (sec || 0) * 1000)));
        this.emit16(ms);
    }

    pc() { return this.buf.length; }

    /* Емітувати placeholder адресу (2 байти) → повертає індекс для backpatch */
    placeholder() {
        const idx = this.buf.length;
        this.buf.push(0, 0);
        return idx;
    }

    /* Заповнити placeholder поточним pc */
    patch(idx) {
        const addr = this.pc();
        this.buf[idx]     = (addr >> 8) & 0xFF;
        this.buf[idx + 1] = addr & 0xFF;
    }

    /* Заповнити placeholder конкретною адресою */
    patchAddr(idx, addr) {
        this.buf[idx]     = (addr >> 8) & 0xFF;
        this.buf[idx + 1] = addr & 0xFF;
    }

    /* ================================================================
       Головна функція: компілювати workspace
       ================================================================ */
    compile(workspace) {
        const starts = workspace.getBlocksByType('start_hat', false);
        if (!starts || starts.length === 0) {
            this.errors.push('Немає блоку "Старт"!');
            return null;
        }
        /* Debug: показати ланцюжок блоків */
        let dbgBlock = starts[0].getNextBlock();
        const dbgChain = [];
        while (dbgBlock) {
            dbgChain.push(dbgBlock.type);
            dbgBlock = dbgBlock.getNextBlock();
        }
        _log('📋 Блоки: ' + (dbgChain.length ? dbgChain.join(' → ') : '(немає!)'), 'info');

        this.compileStmt(starts[0].getNextBlock());
        this.emit(OP.END);
        return new Uint8Array(this.buf);
    }

    /* ================================================================
       Компіляція ланцюжка блоків (statement)
       ================================================================ */
    compileStmt(block) {
        if (!block) return;

        switch (block.type) {

            /* ---- Рух ---- */
            case 'robot_move': {
                const l = this.staticNum(block.getInputTargetBlock('L'), 0);
                const r = this.staticNum(block.getInputTargetBlock('R'), 0);
                this.emit(OP.DRIVE_SET);
                this.emitI8(l); this.emitI8(r);
                break;
            }
            case 'robot_move_soft': {
                const t = this.staticNum(block.getInputTargetBlock('TARGET'), 100);
                const s = this.staticNum(block.getInputTargetBlock('SEC'), 1);
                this.emit(OP.DRIVE);
                this.emitI8(t); this.emitI8(t);
                this.emitMs(s);
                break;
            }
            case 'robot_turn_timed': {
                const dir = block.getFieldValue('DIR');
                const sec = this.staticNum(block.getInputTargetBlock('SEC'), 0.5);
                const l   = dir === 'LEFT' ? -80 : 80;
                const r   = dir === 'LEFT' ?  80 : -80;
                this.emit(OP.DRIVE);
                this.emitI8(l); this.emitI8(r);
                this.emitMs(sec);
                this.emit(OP.STOP);
                break;
            }
            case 'robot_stop':
                this.emit(OP.STOP);
                break;

            case 'robot_set_speed': {
                const spd = this.staticNum(block.getInputTargetBlock('SPEED'), 100);
                this.emit(OP.SET_SPEED);
                this.emit(Math.round(Math.max(0, Math.min(100, spd))));
                break;
            }
            case 'move_4_motors': {
                this.emit(OP.DRIVE4_SET);
                this.emitI8(this.staticNum(block.getInputTargetBlock('M1'), 0));
                this.emitI8(this.staticNum(block.getInputTargetBlock('M2'), 0));
                this.emitI8(this.staticNum(block.getInputTargetBlock('M3'), 0));
                this.emitI8(this.staticNum(block.getInputTargetBlock('M4'), 0));
                break;
            }
            case 'motor_single': {
                const mid = parseInt(block.getFieldValue('MOTOR') || '1');
                const spd = this.staticNum(block.getInputTargetBlock('SPEED'), 0);
                this.emit(OP.SET_MOTOR);
                this.emit(mid);
                this.emitI8(spd);
                break;
            }

            /* ---- Очікування ---- */
            case 'wait_seconds': {
                /* ВИПРАВЛЕНО: PAUSE чекає без зупинки моторів (WAIT зупиняв) */
                const sec = this.staticNum(block.getInputTargetBlock('SECONDS'), 1)
                         || this.staticNum(block.getInputTargetBlock('SEC'), 1);
                this.emit(OP.PAUSE);
                this.emitMs(sec);
                break;
            }
            case 'wait_until_sensor': {
                /* Компілюємо як: while NOT(cond) { loop } */
                const sens  = parseInt(block.getFieldValue('SENS') || '1') - 1; /* ВИПРАВЛЕНО: 0-індекс */
                const opStr = block.getFieldValue('OP') || 'LT';
                const val   = this.staticNum(block.getInputTargetBlock('VAL'), 50);

                const loopStart = this.pc();
                this.emit(OP.PUSH_SENSOR); this.emit(sens);
                this.emit(OP.PUSH_CONST);  this.emit16(val);
                this.emitCmp(opStr);          /* 1 = умова виконана */
                this.emit(OP.NOT);             /* ВИПРАВЛЕНО: інвертуємо → 0 поки не виконана */
                this.emit(OP.JUMP_IF_F);      /* якщо 0 (умова виконана) — виходити */
                const exitPh = this.placeholder();
                this.emit(OP.JUMP);            /* умова ще не виконана — повернутись */
                this.emit16(loopStart);
                this.patch(exitPh);            /* вийти сюди коли умова виконана */
                break;
            }

            /* ---- Таймер ---- */
            case 'timer_reset':
                this.emit(OP.TIMER_RESET);
                break;

            /* ---- Умова if / if-else ---- */
            case 'controls_if': {
                const mutation  = block.mutationToDom ? block.mutationToDom() : null;
                const elseifCnt = mutation ? parseInt(mutation.getAttribute('elseif') || '0') : 0;
                const hasElse   = mutation ? !!parseInt(mutation.getAttribute('else') || '0') : false;

                const endJumps = [];

                /* if + elseif гілки */
                for (let i = 0; i <= elseifCnt; i++) {
                    this.compileExpr(block.getInputTargetBlock('IF' + i));
                    this.emit(OP.JUMP_IF_F);
                    const nextPh = this.placeholder();
                    this.compileStmt(block.getInputTargetBlock('DO' + i));
                    this.emit(OP.JUMP);
                    endJumps.push(this.placeholder());
                    this.patch(nextPh);
                }

                /* else гілка */
                if (hasElse) {
                    this.compileStmt(block.getInputTargetBlock('ELSE'));
                }

                /* Всі jump-to-end → сюди */
                for (const j of endJumps) this.patch(j);
                break;
            }

            /* ---- Цикл: repeat N разів ---- */
            case 'controls_repeat_ext': {
                const count = Math.max(1, Math.round(
                    this.staticNum(block.getInputTargetBlock('TIMES'), 1)
                ));
                this.emit(OP.REPEAT_START);
                this.emit16(count);
                const bodyStart = this.pc(); /* REPEAT_START зберігає цю адресу автоматично */
                this.compileStmt(block.getInputTargetBlock('DO'));
                this.emit(OP.REPEAT_END);
                break;
            }

            /* ---- Цикл: безкінечний ---- */
            case 'controls_forever': {
                const loopStart = this.pc();
                this.compileStmt(block.getInputTargetBlock('DO'));
                this.emit(OP.LOOP_END);
                this.emit16(loopStart);
                /* Після безкінечного циклу наступних блоків немає */
                return;
            }

            /* ---- Цикл: поки / доки ---- */
            case 'controls_whileUntil': {
                const mode      = block.getFieldValue('MODE') || 'WHILE';
                const loopStart = this.pc();

                this.compileExpr(block.getInputTargetBlock('BOOL'));
                if (mode === 'UNTIL') this.emit(OP.NOT); /* UNTIL = поки НЕ умова */

                this.emit(OP.JUMP_IF_F);
                const exitPh = this.placeholder();

                this.compileStmt(block.getInputTargetBlock('DO'));
                this.emit(OP.LOOP_END);
                this.emit16(loopStart);

                this.patch(exitPh);
                break;
            }

            /* ---- Кастомні блоки що відрізняються від Blockly стандарту ---- */
            case 'loop_forever': {
                const loopStart = this.pc();
                this.compileStmt(block.getInputTargetBlock('DO'));
                this.emit(OP.LOOP_END);
                this.emit16(loopStart);
                return; /* після forever немає наступних блоків */
            }

            case 'loop_repeat_pause': {
                const count = Math.max(1, Math.round(
                    this.staticNum(block.getInputTargetBlock('TIMES'), 1)
                ));
                const pause = this.staticNum(block.getInputTargetBlock('PAUSE'), 0);
                this.emit(OP.REPEAT_START);
                this.emit16(count);
                this.compileStmt(block.getInputTargetBlock('DO'));
                if (pause > 0) {
                    this.emit(OP.WAIT);
                    this.emitMs(pause);
                }
                this.emit(OP.REPEAT_END);
                break;
            }

            default:
                /* Спробувати компілювати як вираз (блоки дисплея, анімації тощо) */
                if (block.type.startsWith('disp_')) {
                    /* дисплейні блоки ігноруємо для FRAM */
                    if (!this._warnedDisp) {
                        _log('ℹ️ Дисплейні блоки не зберігаються у FRAM (тільки для живого екрана).', 'info');
                        this._warnedDisp = true;
                    }
                } else if (block.type.startsWith('game_') || block.type.startsWith('sprite_')) {
                    this.compileExpr(block);
                } else {
                    _log('⚠️ Компілятор: невідомий блок "' + block.type + '" — пропущено', 'err');
                }
                break;
        }

        /* Продовжити ланцюжок */
        this.compileStmt(block.getNextBlock());
    }

    /* ================================================================
       Компіляція виразу (expression) → push на стек
       ================================================================ */
    compileExpr(block) {
        if (!block) {
            this.emit(OP.PUSH_CONST); this.emit16(0);
            return;
        }

        if (block.type.startsWith('disp_')) {
            /* дисплейні блоки ігноруємо для FRAM-байткоду */
            return;
        }

        switch (block.type) {

            case 'math_number':
            case 'math_number_limited': {
                const v = parseFloat(block.getFieldValue('NUM') || '0');
                this.emit(OP.PUSH_CONST);
                this.emit16(Math.round(v));
                break;
            }

            case 'logic_boolean': {
                const v = block.getFieldValue('BOOL') === 'TRUE' ? 1 : 0;
                this.emit(OP.PUSH_BOOL); this.emit(v);
                break;
            }

            case 'logic_compare': {
                const op = block.getFieldValue('OP') || 'EQ';
                this.compileExpr(block.getInputTargetBlock('A'));
                this.compileExpr(block.getInputTargetBlock('B'));
                this.emitCmp(op);
                break;
            }

            case 'logic_operation': {
                const op = block.getFieldValue('OP') || 'AND';
                this.compileExpr(block.getInputTargetBlock('A'));
                this.compileExpr(block.getInputTargetBlock('B'));
                this.emit(op === 'AND' ? OP.AND : OP.OR);
                break;
            }

            case 'logic_negate': {
                this.compileExpr(block.getInputTargetBlock('BOOL'));
                this.emit(OP.NOT);
                break;
            }

            case 'sensor_get': {
                /* ВИПРАВЛЕНО: блок показує "1..4", STM очікує 0-індекс */
                const id = parseInt(block.getFieldValue('SENS') || '1') - 1;
                this.emit(OP.PUSH_SENSOR); this.emit(id & 3);
                break;
            }

            case 'math_arithmetic': {
                const op = block.getFieldValue('OP') || 'ADD';
                this.compileExpr(block.getInputTargetBlock('A'));
                this.compileExpr(block.getInputTargetBlock('B'));
                const opmap = { ADD: OP.ADD, MINUS: OP.SUB, MULTIPLY: OP.MUL, DIVIDE: OP.DIV };
                this.emit(opmap[op] || OP.ADD);
                break;
            }

            /* ---- ДИСПЛЕЙ ---- */
            case 'disp_clear':
                this.emit(OP.DISP_CLEAR);
                break;

            case 'disp_update':
            case 'disp_send':  /* ВИПРАВЛЕНО: disp_send = той же OP_DISP_UPDATE */
                this.emit(OP.DISP_UPDATE);
                break;

            case 'disp_text': {
                const txt  = block.getFieldValue('TXT') || '';
                const big  = block.getFieldValue('SIZE') === 'big' ? 1 : 0;
                const x    = this.compileValue(block, 'X');
                const y    = this.compileValue(block, 'Y');
                const bytes = [];
                for (let i = 0; i < txt.length && i < 32; i++) {
                    const code = txt.charCodeAt(i);
                    // STM font table is ASCII-only, replace non-printable/non-ASCII with space.
                    bytes.push((code >= 32 && code <= 126) ? code : 0x20);
                }
                // DISP_TEXT x y big len chars...
                this.emit(OP.DISP_TEXT);
                this.emit(x); this.emit(y); this.emit(big); this.emit(bytes.length);
                for (const b of bytes) this.emit(b);
                break;
            }

            case 'disp_number': {
                const x = this.compileValue(block, 'X');
                const y = this.compileValue(block, 'Y');
                this.compileExpression(block, 'VAL');
                this.emit(OP.DISP_NUMBER); this.emit(x); this.emit(y);
                break;
            }

            case 'disp_pixel':    /* статичний піксель (static X,Y у bytecode) */
                this.emit(OP.DISP_PIXEL); this.emit(this.compileValue(block,'X')); this.emit(this.compileValue(block,'Y'));
                break;

            case 'disp_pixel_on':  /* ВИПРАВЛЕНО: динамічний піксель — x,y зі стеку */
                this.compileExpression(block, 'X');
                this.compileExpression(block, 'Y');
                this.emit(OP.DISP_PIXEL_DYN);
                break;

            case 'disp_pixel_off': /* ВИПРАВЛЕНО: стерти піксель — x,y зі стеку */
                this.compileExpression(block, 'X');
                this.compileExpression(block, 'Y');
                this.emit(OP.DISP_PIXEL_CLR);
                break;

            case 'disp_pixel_get': /* ВИПРАВЛЕНО: прочитати піксель — x,y зі стеку, push 0/1 */
                this.compileExpression(block, 'X');
                this.compileExpression(block, 'Y');
                this.emit(OP.DISP_PIXEL_GET);
                break;

            case 'disp_line': {
                const x1 = this.compileValue(block, 'X1');
                const y1 = this.compileValue(block, 'Y1');
                const x2 = this.compileValue(block, 'X2');
                const y2 = this.compileValue(block, 'Y2');
                this.emit(OP.DISP_LINE); this.emit(x1); this.emit(y1); this.emit(x2); this.emit(y2);
                break;
            }

            case 'disp_fill':  /* ВИПРАВЛЕНО: блок існував але не компілювався */
                this.emit(OP.DISP_FILL);
                break;

            case 'disp_smile': {
                const faces = { happy:0, sad:1, bolt:2, question:3, check:4 };
                const idx   = faces[block.getFieldValue('FACE')] || 0;
                this.emit(OP.DISP_SMILE); this.emit(idx);
                break;
            }

            case 'disp_paint': {
                /* ВИПРАВЛЕНО: переходимо на OP_DISP_RLE (0x58) — STM реалізований,
                   DISP_BITMAP (0x55) був порожній (return 0).
                   Формат поля: "scale|010101..." (scale=пікселів на клітинку) */
                const val = block.getFieldValue('GRID') || '';
                if (!val.includes('|')) break;
                const [sc, pixStr] = val.split('|');
                const scale = parseInt(sc) || 4;
                const cols  = Math.floor(128 / scale);
                const rows  = Math.floor(64  / scale);
                const total = cols * rows;

                /* Розгортаємо пікселі у 128×64 bitmap з масштабуванням */
                const fb = new Uint8Array(128 * 64).fill(0);
                for (let i = 0; i < total; i++) {
                    if (pixStr[i] !== '1') continue;
                    const cx = (i % cols) * scale;
                    const cy = Math.floor(i / cols) * scale;
                    for (let dy = 0; dy < scale && cy+dy < 64; dy++)
                        for (let dx = 0; dx < scale && cx+dx < 128; dx++)
                            fb[(cy+dy)*128 + (cx+dx)] = 1;
                }

                /* RLE кодування: кожен байт = bit7|count(0..127)
                   bit7=1 → білих count пікселів, bit7=0 → чорних count */
                const rle = [];
                let cur = fb[0], cnt = 1;
                for (let i = 1; i < 128*64; i++) {
                    if (fb[i] === cur && cnt < 127) { cnt++; }
                    else {
                        rle.push((cur ? 0x80 : 0x00) | cnt);
                        cur = fb[i]; cnt = 1;
                    }
                }
                rle.push((cur ? 0x80 : 0x00) | cnt);

                /* Емітуємо: OP_DISP_RLE rleLen_hi rleLen_lo rle... */
                this.emit(OP.DISP_RLE);
                this.emit((rle.length >> 8) & 0xFF);
                this.emit(rle.length & 0xFF);
                for (const b of rle) this.emit(b);
                break;
            }

            /* ── АНІМАЦІЯ ── */
            case 'disp_anim_frame': {
                /* Малює кадр і зберігає його в таблицю кадрів у байткоді.
                   Формат поля: "scale|010101..."
                   Компілюємо як: OP_DISP_FRAME_STORE idx rleLen_hi rleLen_lo rle... */
                const idx  = parseInt(block.getFieldValue('IDX') || '0');
                const val  = block.getFieldValue('GRID') || '';
                if (!val.includes('|')) break;
                const [sc, pixStr] = val.split('|');
                const scale = parseInt(sc) || 4;
                const cols  = Math.floor(128 / scale);
                const rows  = Math.floor(64  / scale);
                const total = cols * rows;

                /* Розгортаємо в 128×64 з масштабом */
                const fb = new Uint8Array(128 * 64).fill(0);
                for (let i = 0; i < total; i++) {
                    if (pixStr[i] !== '1') continue;
                    const cx = (i % cols) * scale;
                    const cy = Math.floor(i / cols) * scale;
                    for (let dy = 0; dy < scale && cy+dy < 64; dy++)
                        for (let dx = 0; dx < scale && cx+dx < 128; dx++)
                            fb[(cy+dy)*128+(cx+dx)] = 1;
                }

                /* RLE encode */
                const rle = [];
                let cur = fb[0], cnt = 1;
                for (let i = 1; i < 128*64; i++) {
                    if (fb[i] === cur && cnt < 127) { cnt++; }
                    else { rle.push((cur ? 0x80 : 0x00) | cnt); cur = fb[i]; cnt = 1; }
                }
                rle.push((cur ? 0x80 : 0x00) | cnt);

                this.emit(OP.DISP_FRAME_STORE);
                this.emit(idx);
                this.emit((rle.length >> 8) & 0xFF);
                this.emit(rle.length & 0xFF);
                for (const b of rle) this.emit(b);
                break;
            }

            case 'disp_anim_save': {
                /* Зберегти поточний буфер дисплея як кадр idx.
                   На STM компілюємо як no-op — кадри задаються тільки через disp_anim_frame.
                   На JS-симуляторі saveFrame() вже є. */
                /* no-op для STM: кадр не задано статично */
                break;
            }

            case 'disp_anim_load': {
                /* Завантажити кадр idx → OP_DISP_FRAME_LOAD idx */
                const idx = parseInt(block.getFieldValue('IDX') || '0');
                this.emit(OP.DISP_FRAME_LOAD);
                this.emit(idx);
                break;
            }

            case 'disp_anim_play': {
                /* Програти кадри від..до кожні ms мілісекунд.
                   Компілюємо як безкінечний цикл:
                     load from; send; pause ms;
                     load from+1; send; pause ms; ...
                   Це простіше і не потребує змінних на стеку. */
                const from = parseInt(block.getFieldValue('FROM') || '0');
                const to   = parseInt(block.getFieldValue('TO')   || '3');
                const ms   = this.staticNum(block.getInputTargetBlock('MS'), 200);
                const loopStart = this.pc();
                for (let f = from; f <= to; f++) {
                    this.emit(OP.DISP_FRAME_LOAD); this.emit(f);
                    this.emit(OP.DISP_UPDATE);
                    this.emit(OP.PAUSE); this.emitMs(ms);
                }
                this.emit(OP.LOOP_END); this.emit16(loopStart);
                break;
            }

            case 'disp_anim_stop':
                /* Зупинити анімацію = зупинити нескінченний цикл.
                   На STM немає асинхронності — блок anim_stop не має сенсу в bytecode,
                   але залишаємо як no-op щоб не падало. */
                break;

            case 'disp_hud': /* повернути стандартний HUD */
                this.emit(OP.DISP_HUD);
                break;

            case 'timer_get': {
                /* таймер_get повертає секунди → конвертуємо в мс для стека */
                this.emit(OP.PUSH_TIMER);
                /* Ділимо на 1000 щоб отримати секунди (VM таймер у мс) */
                this.emit(OP.PUSH_CONST); this.emit16(1000);
                this.emit(OP.DIV);
                break;
            }

            default:
                this.emit(OP.PUSH_CONST); this.emit16(0);
                break;
        }
    }

    /* ================================================================
       Допоміжники
       ================================================================ */

    /* Повернути статичне числове значення з input (0-255) */
    compileValue(block, name) {
        const inp = block.getInputTargetBlock(name);
        return Math.round(this.staticNum(inp, 0)) & 0xFF;
    }

    /* Скомпілювати вираз з input на стек VM */
    compileExpression(block, name) {
        this.compileExpr(block.getInputTargetBlock(name));
    }

    /* Статично обчислити числовий блок (тільки math_number) */
    staticNum(block, def) {
        if (!block) return def;
        if (block.type === 'math_number' || block.type === 'math_number_limited')
            return parseFloat(block.getFieldValue('NUM') || String(def));
        /* ВИПРАВЛЕНО bug #7: попередження якщо блок не числовий */
        if (typeof _log === 'function')
            _log('⚠️ staticNum: блок "' + block.type + '" не числовий — дефолт ' + def, 'err');
        return def;
    }

    /* Емітувати опкод порівняння */
    emitCmp(opStr) {
        const m = {
            LT: OP.CMP_LT, GT: OP.CMP_GT,
            EQ: OP.CMP_EQ, NEQ: OP.CMP_NEQ,
            LTE: OP.CMP_LTE, GTE: OP.CMP_GTE,
        };
        this.emit(m[opStr] || OP.CMP_LT);
    }
}

/* ================================================================
   SLIP encode (для відправки пакетів на STM32)
   ================================================================ */
function slipEncode(bytes) {
    const END = 0xC0, ESC = 0xDB, ESC_END = 0xDC, ESC_ESC = 0xDD;
    const out = [END];
    for (const b of bytes) {
        if      (b === END) out.push(ESC, ESC_END);
        else if (b === ESC) out.push(ESC, ESC_ESC);
        else                out.push(b);
    }
    out.push(END);
    return new Uint8Array(out);
}

/* Відправити один пакет через BLE characteristic */
async function sendPkt(bytes) {
    /* characteristic може бути в window або треба шукати через sendRawPacket */
    const chr = window.characteristic;
    if (chr) {
        try {
            await chr.writeValue(slipEncode(bytes));
        } catch (e) {
            console.error('BLE write:', e);
        }
        return;
    }
    /* Fallback: використати sendRawPacket якщо characteristic не в window */
    /* ВИПРАВЛЕНО: слати SLIP-кадр, а не raw байти */
    if (typeof window.sendRawPacket === 'function') {
        try { await window.sendRawPacket(slipEncode(bytes)); } catch(e) {
            /* якщо SLIP не пройшов — спробувати raw як останній варіант */
            try { await window.sendRawPacket(new Uint8Array(bytes)); } catch(e2) {}
        }
    }
}

/* ВИПРАВЛЕНО: адаптивний розмір чанку. BLE MTU зазвичай 20 байт.
   SLIP overhead: +2 (0xC0 на початку і кінці) + до 2 за кожен escape.
   Найгірший випадок: всі байти потребують escape → payload * 2 + 2.
   Безпечний ліміт payload: floor((MTU - 2) / 2) = 9, але на практиці
   беремо window._stmMaxTxBytes (default 18) як максимум payload. */
function getChunkSize() {
    const mtu = (window._stmMaxTxBytes || 20);
    /* -1 для PCMD.CHUNK байту, -2 для SLIP кінців */
    return Math.max(4, Math.min(18, mtu - 3));
}

/* Завантажити байткод на STM32 */
async function uploadBytecode(code, onProgress) {
    const CHUNK_SIZE = getChunkSize();
    await sendPkt([PCMD.BEGIN]);
    await new Promise(r => setTimeout(r, 60));

    const total = code.length;
    for (let i = 0; i < total; i += CHUNK_SIZE) {
        let chunk = Array.from(code.slice(i, i + CHUNK_SIZE));

        /* ВИПРАВЛЕНО bug #2: якщо payload = 3 байти → пакет [PCMD.CHUNK, b0, b1, b2] = 4 байти
           STM32 плутає з real-time моторами. Доповнюємо 0x00 (після END — ніколи не виконається) */
        if (chunk.length === 3) chunk.push(0x00);

        await sendPkt([PCMD.CHUNK, ...chunk]);
        if (onProgress) onProgress(Math.min(i + CHUNK_SIZE, total), total);
        await new Promise(r => setTimeout(r, 30));
    }

    await sendPkt([PCMD.END]);
    await new Promise(r => setTimeout(r, 60));
}

/* ================================================================
   Кнопка "Завантажити в робота"
   ================================================================ */
/* Логувати через window.log якщо доступний */
function _log(msg, type) {
    if (typeof window.log === 'function') window.log(msg, type || 'info');
    else console.log('[STM]', msg);
}

window.uploadToRobot = async function () {
    /* isConnected може бути локальна змінна (в тому ж scope що і characteristic)
       або window.isConnected якщо експортована */
    const _connected = window.isConnected || 
                       (window.characteristic != null) || 
                       window.isSimulating;
    if (!_connected) {
        const dbg = 'window.isConnected=' + window.isConnected +
                    ', characteristic=' + (window.characteristic ? 'ok' : 'null') +
                    ', isSimulating=' + window.isSimulating;
        alert('Спочатку підключіться до Bluetooth!\n(' + dbg + ')');
        return;
    }
    if (!window.workspace) {
        alert('Немає Blockly workspace!');
        return;
    }

    const btn  = document.getElementById('uploadProgBtn');
    const icon = document.getElementById('uploadProgIcon');

    btn.classList.add('uploading');
    btn.classList.remove('done');
    icon.className = 'fa-solid fa-spinner fa-spin';
    btn.disabled   = true;

    /* Блокуємо _send() display-кадрів поки йде завантаження програми
       (інакше disp_send може вставити свій PCMD_BEGIN між PCMD_END і PCMD_SAVE
        і PCMD_SAVE збереже display-дані замість програми) */
    window._uploadBusy = true;
    try {
        /* --- Компіляція --- */
        _log('🔄 Компілюю програму...', 'info');
        const compiler = new Compiler();
        const code     = compiler.compile(window.workspace);

        if (compiler.errors.length > 0) {
            for (const e of compiler.errors) _log('⚠️ ' + e, 'err');
        }

        if (!code || code.length === 0) {
            _log('❌ Немає блоків для компіляції!', 'err');
            alert('Немає блоків для компіляції!');
            btn.classList.remove('uploading');
            icon.className = 'fa-solid fa-upload';
            btn.disabled = false;
            window._uploadBusy = false; /* ВИПРАВЛЕНО bug #3: скидати прапор і тут */
            return;
        }

        /* ВИПРАВЛЕНО bug #3: перевірка ліміту FRAM перед відправкою */
        if (code.length > 509) {
            const msg = `Програма завелика: ${code.length} байт (максимум 509 байт). Зменши кількість блоків.`;
            _log('❌ ' + msg, 'err');
            alert(msg);
            btn.classList.remove('uploading');
            icon.className = 'fa-solid fa-upload';
            btn.disabled = false;
            window._uploadBusy = false;
            return;
        }

        const _cs = getChunkSize();
        _log(`📦 Скомпільовано: ${code.length} байт (${Math.ceil(code.length / _cs)} пакетів, chunk=${_cs})`, 'info');

        /* --- Відправка: ВИПРАВЛЕНО bug #6 — один шлях через uploadBytecode --- */
        _log('📤 Відправляю на STM32...', 'info');
        await uploadBytecode(code, (done, total) => {
            if (done === total || Math.floor((done - 1) / _cs) % 5 === 0)
                _log(`  → ${done}/${total} байт`, 'tx');
        });

        /* --- Авто-збереження в FRAM --- */
        await sendPkt([PCMD.SAVE]);
        _log('  → CMD_SAVE: збережено в FRAM', 'tx');
        await new Promise(r => setTimeout(r, 60));
        window._uploadBusy = false; /* дозволяємо display надсилання */

        /* --- Успіх --- */
        btn.classList.remove('uploading');
        btn.classList.add('done');
        icon.className = 'fa-solid fa-check';
        _log(`✅ Готово! ${code.length} байт завантажено. Натисни OK на платі щоб запустити.`, 'info');

        setTimeout(() => {
            btn.classList.remove('done');
            icon.className = 'fa-solid fa-upload';
            btn.disabled   = false;
        }, 2500);

    } catch (e) {
        window._uploadBusy = false;
        _log('❌ Помилка завантаження: ' + (e.message || String(e)), 'err');
        console.error('Upload error:', e);
        btn.classList.remove('uploading');
        icon.className = 'fa-solid fa-upload';
        btn.disabled   = false;
    }
};

/* Також зупинити виконання на STM32 */
window.progStopSTM  = async () => sendPkt([PCMD.STOP]);
window.progRunSTM   = async () => sendPkt([PCMD.RUN]);
window.progClearSTM = async () => sendPkt([PCMD.CLEAR]);

/* Expose компілятор для відладки */
window.STMCompiler = Compiler;

})();
