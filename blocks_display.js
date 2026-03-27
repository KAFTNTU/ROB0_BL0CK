// @ts-nocheck
/* ================================================================
   blocks_display.js  v3
   PixelEngine + ігрові блоки + ігровий цикл + спрайти
   Тільки браузер. STM32 отримує лише RLE-bitmap.
   353 рядок міянти висоту блоків малювалки
   ================================================================ */
/* ================================================================
   PIXEL ENGINE
   ================================================================ */
(function () {
const W = 128, H = 64;
const _buf    = new Uint8Array(W * H);
const _frames = Array.from({length:10}, () => new Uint8Array(W * H));
let   _tickCb = null;
let   _tickMs = 100;
let   _tickId = null;
let   _gs     = 0;          /* game score */
let   _sprites = {};        /* id → {x,y,w,h,pixels} */
let   _sendBusy = false;
let   _lastFrameSig = null; /* анти-мерехтіння: не шлемо однаковий кадр */
let   _lastChr = null;

/* --- Joystick: читаємо з браузерного ноба --- */
function _joyDir() {
    const x = window.lastJoyX||0, y = window.lastJoyY||0, t=40;
    if(Math.abs(x)<t && Math.abs(y)<t) return 'center';
    if(Math.abs(x)>Math.abs(y)) return x>0?'right':'left';
    return y>0?'down':'up';
}
function _joyAxis(axis){ return axis==='x'?(window.lastJoyX||0):(window.lastJoyY||0); }

/* --- Алгоритм Брезенхема --- */
function _line(x0,y0,x1,y1,v){
    x0=x0|0;y0=y0|0;x1=x1|0;y1=y1|0;
    const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;
    let err=dx-dy;
    for(;;){
        _set(x0,y0,v);
        if(x0===x1&&y0===y1)break;
        const e2=2*err;
        if(e2>-dy){err-=dy;x0+=sx;}
        if(e2<dx) {err+=dx;y0+=sy;}
    }
}

/* --- Коло (Мідпойнт) --- */
function _circle(cx,cy,r,v,fill){
    cx=cx|0;cy=cy|0;r=r|0;
    let x=r,y=0,d=1-r;
    while(x>=y){
        if(fill){ for(let i=-x;i<=x;i++){_set(cx+i,cy+y,v);_set(cx+i,cy-y,v);} for(let i=-y;i<=y;i++){_set(cx+i,cy+x,v);_set(cx+i,cy-x,v);} }
        else { _set(cx+x,cy+y,v);_set(cx-x,cy+y,v);_set(cx+x,cy-y,v);_set(cx-x,cy-y,v);_set(cx+y,cy+x,v);_set(cx-y,cy+x,v);_set(cx+y,cy-x,v);_set(cx-y,cy-x,v); }
        if(d<0) d+=2*y+3; else {d+=2*(y-x)+5;x--;}
        y++;
    }
}

/* --- Прямокутник --- */
function _rect(x,y,w,h,v,fill){
    if(fill){ for(let r=0;r<h;r++) for(let c=0;c<w;c++) _set(x+c,y+r,v); }
    else { for(let i=0;i<w;i++){_set(x+i,y,v);_set(x+i,y+h-1,v);} for(let i=0;i<h;i++){_set(x,y+i,v);_set(x+w-1,y+i,v);} }
}

function _set(x,y,v){ x=x|0;y=y|0; if(x>=0&&x<W&&y>=0&&y<H) _buf[y*W+x]=v?1:0; }
function _get(x,y){ x=x|0;y=y|0; return(x>=0&&x<W&&y>=0&&y<H)?_buf[y*W+x]:0; }

/* --- RLE кодування --- */
function _rle(buf){
    const out=[];let i=0;
    while(i<W*H){
        const bit=buf[i]?1:0;let cnt=1;
        while(i+cnt<W*H&&buf[i+cnt]===bit&&cnt<127)cnt++;
        out.push((bit<<7)|cnt);i+=cnt;
    }
    return out;
}

function _frameSig(rle){
    let h = 2166136261 >>> 0; /* FNV-1a 32-bit */
    for(let i=0;i<rle.length;i++){
        h ^= rle[i];
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16) + ':' + rle.length;
}

/* --- Повернути HUD --- */
async function _sendHUD(){
    if(!window.characteristic) return;
    _lastFrameSig = null; /* після HUD наступний кадр треба надіслати заново */
    const SEND=0xC0,ESC=0xDB,TEND=0xDC,TESC=0xDD;
    function slip(d){const o=[];for(const b of d){if(b===SEND)o.push(ESC,TEND);else if(b===ESC)o.push(ESC,TESC);else o.push(b);}o.push(SEND);return new Uint8Array(o);}
    async function wr(b){try{await window.characteristic.writeValue(slip(b));}catch(e){console.warn(e);}await new Promise(r=>setTimeout(r,12));}
    await wr([0xA0]);
    await wr([0xB0,0x5E]); /* OP_DISP_HUD */
    await wr([0xA1]);
    await wr([0xA2]);
}


/* --- Попередження про великий RLE --- */
let _rleSizeWarnTimer=null;
function _showRleSizeWarning(sz){
    if(_rleSizeWarnTimer) return;
    const d=document.createElement('div');
    d.textContent='\u26a0\ufe0f Зображення занадто складне ('+sz+' б RLE). Спростіть або зменште кількість деталей.';
    d.style.cssText='position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    document.body.appendChild(d);
    _rleSizeWarnTimer=setTimeout(()=>{d.remove();_rleSizeWarnTimer=null;},4000);
}
/* --- Надіслати на STM32 --- */
async function _send(){
    if(!window.characteristic||_sendBusy) return;
    if(window.characteristic!==_lastChr){ _lastFrameSig=null; _lastChr=window.characteristic; }
    _sendBusy=true;
    try{
        /* Спочатку намалювати всі спрайти */
        const snap=_buf.slice();
        Object.values(_sprites).forEach(sp=>{
            for(let r=0;r<sp.h;r++) for(let c=0;c<sp.w;c++)
                if(sp.pixels[r*sp.w+c]) _set(sp.x+c,sp.y+r,1);
        });

        const rle=_rle(_buf);
        _buf.set(snap); /* відновити буфер без спрайтів */
        if(rle.length>2045){
            console.warn('RLE занадто великий: '+rle.length+' байт (макс 2045). Зображення буде обрізане!');
            _showRleSizeWarning(rle.length);
        }
        const sig=_frameSig(rle);
        if(sig===_lastFrameSig) return; /* те саме зображення — пропускаємо */

        const SEND=0xC0,ESC=0xDB,TEND=0xDC,TESC=0xDD;
        function slip(d){const o=[];for(const b of d){if(b===SEND)o.push(ESC,TEND);else if(b===ESC)o.push(ESC,TESC);else o.push(b);}o.push(SEND);return new Uint8Array(o);}
        async function wr(b){try{await window.characteristic.writeValue(slip(b));}catch(e){console.warn(e);}await new Promise(r=>setTimeout(r,12));}

        await wr([0xA0]);
        const pay=[0x58,(rle.length>>8)&0xFF,rle.length&0xFF,...rle];
        for(let i=0;i<pay.length;i+=16) await wr([0xB0,...pay.slice(i,i+16)]);
        await wr([0xA1]);
        await wr([0xA2]); /* PCMD_RUN — запустити програму */
        _lastFrameSig=sig;
    } finally { _sendBusy=false; }
}

/* --- Ігровий цикл --- */
function _startTick(ms,cb){
    _stopTick();
    _tickMs=ms||100;
    _tickCb=cb;
    const run=async()=>{
        if(!_tickCb)return;
        try{await _tickCb();}catch(e){console.error('tick',e);}
        _tickId=setTimeout(run,_tickMs);
    };
    _tickId=setTimeout(run,0);
}
function _stopTick(){ clearTimeout(_tickId);_tickId=null;_tickCb=null; }

/* --- Спрайти --- */
function _spriteSet(id,x,y,w,h,data){
    _sprites[id]={x:x|0,y:y|0,w:w|0,h:h|0,pixels:data||new Uint8Array(w*h)};
}
function _spriteMove(id,dx,dy){
    const s=_sprites[id];if(!s)return;s.x+=dx|0;s.y+=dy|0;
    /* стіни */
    if(s.x<0)s.x=0;if(s.x+s.w>W)s.x=W-s.w;
    if(s.y<0)s.y=0;if(s.y+s.h>H)s.y=H-s.h;
}
function _spriteCollide(id1,id2){
    const a=_sprites[id1],b=_sprites[id2];if(!a||!b)return false;
    return !(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y);
}
function _spriteEdge(id){
    const s=_sprites[id];if(!s)return false;
    return s.x<=0||s.x+s.w>=W||s.y<=0||s.y+s.h>=H;
}

/* ── 5x7 bitmap font ── */
const _FONT5=[[0x00,0x00,0x00,0x00,0x00],[0x00,0x00,0x5F,0x00,0x00],[0x00,0x07,0x00,0x07,0x00],[0x14,0x7F,0x14,0x7F,0x14],[0x24,0x2A,0x7F,0x2A,0x12],[0x23,0x13,0x08,0x64,0x62],[0x36,0x49,0x55,0x22,0x50],[0x00,0x05,0x03,0x00,0x00],[0x00,0x1C,0x22,0x41,0x00],[0x00,0x41,0x22,0x1C,0x00],[0x14,0x08,0x3E,0x08,0x14],[0x08,0x08,0x3E,0x08,0x08],[0x00,0x50,0x30,0x00,0x00],[0x08,0x08,0x08,0x08,0x08],[0x00,0x60,0x60,0x00,0x00],[0x20,0x10,0x08,0x04,0x02],[0x3E,0x51,0x49,0x45,0x3E],[0x00,0x42,0x7F,0x40,0x00],[0x42,0x61,0x51,0x49,0x46],[0x21,0x41,0x45,0x4B,0x31],[0x18,0x14,0x12,0x7F,0x10],[0x27,0x45,0x45,0x45,0x39],[0x3C,0x4A,0x49,0x49,0x30],[0x01,0x71,0x09,0x05,0x03],[0x36,0x49,0x49,0x49,0x36],[0x06,0x49,0x49,0x29,0x1E],[0x00,0x36,0x36,0x00,0x00],[0x00,0x56,0x36,0x00,0x00],[0x08,0x14,0x22,0x41,0x00],[0x14,0x14,0x14,0x14,0x14],[0x00,0x41,0x22,0x14,0x08],[0x02,0x01,0x51,0x09,0x06],[0x32,0x49,0x79,0x41,0x3E],[0x7E,0x11,0x11,0x11,0x7E],[0x7F,0x49,0x49,0x49,0x36],[0x3E,0x41,0x41,0x41,0x22],[0x7F,0x41,0x41,0x22,0x1C],[0x7F,0x49,0x49,0x49,0x41],[0x7F,0x09,0x09,0x09,0x01],[0x3E,0x41,0x49,0x49,0x7A],[0x7F,0x08,0x08,0x08,0x7F],[0x00,0x41,0x7F,0x41,0x00],[0x20,0x40,0x41,0x3F,0x01],[0x7F,0x08,0x14,0x22,0x41],[0x7F,0x40,0x40,0x40,0x40],[0x7F,0x02,0x0C,0x02,0x7F],[0x7F,0x04,0x08,0x10,0x7F],[0x3E,0x41,0x41,0x41,0x3E],[0x7F,0x09,0x09,0x09,0x06],[0x3E,0x41,0x51,0x21,0x5E],[0x7F,0x09,0x19,0x29,0x46],[0x46,0x49,0x49,0x49,0x31],[0x01,0x01,0x7F,0x01,0x01],[0x3F,0x40,0x40,0x40,0x3F],[0x1F,0x20,0x40,0x20,0x1F],[0x3F,0x40,0x38,0x40,0x3F],[0x63,0x14,0x08,0x14,0x63],[0x07,0x08,0x70,0x08,0x07],[0x61,0x51,0x49,0x45,0x43]];
const _CYR_G={'А':[0x7E,0x11,0x11,0x11,0x7E],'Б':[0x7F,0x45,0x45,0x45,0x38],'В':[0x7F,0x49,0x49,0x49,0x36],'Г':[0x7F,0x01,0x01,0x01,0x01],'Д':[0x7E,0x09,0x09,0x09,0x7E],'Е':[0x7F,0x49,0x49,0x49,0x41],'Є':[0x3E,0x41,0x49,0x49,0x2A],'Ж':[0x67,0x18,0x7F,0x18,0x67],'З':[0x41,0x49,0x49,0x49,0x36],'И':[0x7F,0x10,0x08,0x04,0x7F],'І':[0x00,0x41,0x7F,0x41,0x00],'Ї':[0x48,0x41,0x7F,0x41,0x48],'Й':[0x7F,0x12,0x0A,0x04,0x7F],'К':[0x7F,0x08,0x14,0x22,0x41],'Л':[0x7E,0x01,0x01,0x01,0x7F],'М':[0x7F,0x02,0x04,0x02,0x7F],'Н':[0x7F,0x08,0x08,0x08,0x7F],'О':[0x3E,0x41,0x41,0x41,0x3E],'П':[0x7F,0x01,0x01,0x01,0x7F],'Р':[0x7F,0x09,0x09,0x09,0x06],'С':[0x3E,0x41,0x41,0x41,0x22],'Т':[0x01,0x01,0x7F,0x01,0x01],'У':[0x07,0x08,0x70,0x08,0x07],'Ф':[0x0A,0x3E,0x49,0x3E,0x0A],'Х':[0x41,0x22,0x1C,0x22,0x41],'Ц':[0x7F,0x40,0x40,0x40,0x7F],'Ч':[0x0F,0x08,0x08,0x08,0x7F],'Ш':[0x7F,0x40,0x7F,0x40,0x7F],'Щ':[0x7F,0x40,0x7F,0x42,0x7F],'Ь':[0x7F,0x48,0x48,0x48,0x30],'Ю':[0x7F,0x08,0x36,0x41,0x3E],'Я':[0x46,0x29,0x19,0x09,0x7F]};
const _CYR_L={'а':'А','б':'Б','в':'В','г':'Г','д':'Д','е':'Е','є':'Є','ж':'Ж','з':'З','и':'И','і':'І','ї':'Ї','й':'Й','к':'К','л':'Л','м':'М','н':'Н','о':'О','п':'П','р':'Р','с':'С','т':'Т','у':'У','ф':'Ф','х':'Х','ц':'Ц','ч':'Ч','ш':'Ш','щ':'Щ','ь':'Ь','ю':'Ю','я':'Я'};
function _drawText(str,x,y,scale){scale=scale||1;const cw=6*scale;for(let i=0;i<str.length;i++){let ch=str[i];if(_CYR_L[ch])ch=_CYR_L[ch];let gl=_CYR_G[ch];if(!gl){const uc=ch.toUpperCase(),cd=uc.charCodeAt(0);gl=(cd>=32&&cd<=90)?_FONT5[cd-32]:_FONT5[0];}for(let col=0;col<5;col++){const bits=gl[col];for(let row=0;row<7;row++){if(bits&(1<<row)){const px=x+i*cw+col*scale,py=y+row*scale;for(let sy=0;sy<scale;sy++)for(let sx=0;sx<scale;sx++)_set(px+sx,py+sy,1);}}}}}

window.PixelEngine = {
    W,H,buf:_buf,frames:_frames,
    clear(){ _buf.fill(0); Object.keys(_sprites).forEach(k=>delete _sprites[k]); },
    set:_set, get:_get,
    line:_line, circle:_circle, rect:_rect,
    randomPixels(n){ for(let i=0;i<n;i++) _buf[Math.floor(Math.random()*W*H)]=1; },
    fill(v){ _buf.fill(v?1:0); },
    saveFrame(i){ if(i>=0&&i<10)_frames[i].set(_buf); },
    loadFrame(i){ if(i>=0&&i<10)_buf.set(_frames[i]); },
    joyDir:_joyDir, joyAxis:_joyAxis,
    sendFrame:_send,
    showHUD(){ _sendHUD(); },
    startTick:_startTick, stopTick:_stopTick,
    score(v){ _gs+=v|0; }, getScore(){ return _gs; }, resetScore(){ _gs=0; },
    spriteSet:_spriteSet, spriteMove:_spriteMove,
    spriteCollide:_spriteCollide, spriteEdge:_spriteEdge,
    getSprite(id){ return _sprites[id]||null; },
    drawText:_drawText,
    invalidateTxCache(){ _lastFrameSig=null; },
    applyBitmap(val){
        if(!val||!val.includes('|'))return;
        const[sc,hex]=val.split('|');const s=parseInt(sc)||4;
        const cols=Math.floor(W/s),rows=Math.floor(H/s);
        for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
            const v=hex[r*cols+c]==='1'?1:0;
            for(let sy=0;sy<s;sy++)for(let sx=0;sx<s;sx++){
                const px=c*s+sx,py=r*s+sy;if(px<W&&py<H)_buf[py*W+px]=v;
            }
        }
    },
};
})();

/* ================================================================
   CUSTOM FIELD: field_paint_grid
   ================================================================ */
class FieldPaintGrid extends Blockly.Field {
    constructor(v){ super(v||''); this.SERIALIZABLE=true; this.scale=4; this._load(v); this._p=false; this._e=false; }
    static fromJson(o){ return new FieldPaintGrid(o['value']); }
    _load(v){
        this.scale=(v&&v.includes('|'))?parseInt(v.split('|')[0])||4:4;
        this.cols=Math.floor(128/this.scale); this.rows=Math.floor(64/this.scale);
        this.pixels=new Uint8Array(this.cols*this.rows);
        if(v&&v.includes('|')){ const h=v.split('|')[1]||''; for(let i=0;i<Math.min(h.length,this.pixels.length);i++) this.pixels[i]=h[i]==='1'?1:0; }
    }
    get CELL(){ return this.scale===1?3:this.scale===2?5:this.scale===4?8:13; }
    get cW(){ return this.cols*this.CELL; }
    get cH(){ return this.rows*this.CELL; }
    initView(){
        super.initView();
        /* Blockly малює білий borderRect_ — ховаємо його */
        if (this.borderRect_) {
            this.borderRect_.setAttribute('fill', 'none');
            this.borderRect_.setAttribute('stroke', 'none');
        }
        this._build();
    }
    _svg(t,a,p){ const e=document.createElementNS('http://www.w3.org/2000/svg',t); Object.entries(a).forEach(([k,v])=>e.setAttribute(k,v)); p.appendChild(e); return e; }
    _build(){
        if(this._isTouch===undefined)
            this._isTouch=('ontouchstart' in window)||navigator.maxTouchPoints>0;
        if(this._isTouch) this._buildCanvas();
        else              this._buildSVG();
    }

    _buildSVG(){
        if(this._onDocMove) document.removeEventListener('touchmove',this._onDocMove,{capture:true,passive:false});
        if(this._onDocEnd)  document.removeEventListener('touchend', this._onDocEnd, false);
        this._p=false; this._docListening=false;

        const g=this.fieldGroup_; while(g.firstChild)g.removeChild(g.firstChild);
        /* Зупиняємо BUBBLE фазу на fieldGroup_ — після того як клітинки вже обробили подію.
           Це блокує Blockly drag, але НЕ блокує доставку події до клітинок. */
        ['mousedown','pointerdown','touchstart'].forEach(ev=>{
            g.addEventListener(ev, e=>{ e.stopPropagation(); }, ev==='touchstart'?{passive:false}:false);
        });
        const W=this.cW,H=this.cH,PW=36,C=this.CELL;
        this._svg('rect',{x:0,y:0,width:W+PW,height:H,fill:'#0a0f1a',rx:4},g);
        this._rects=[];
        const cg=this._svg('g',{},g);

        const _onDocMove = e => {
            if(!this._p) return;
            if(e.cancelable) e.preventDefault();
            const t = e.touches[0];
            const el = document.elementFromPoint(t.clientX, t.clientY);
            if(el && el._paintIdx !== undefined) this._dot(el._paintIdx, el);
        };
        const _onDocEnd = (e) => {
            this._p = false;
            this._docListening = false;
            document.removeEventListener('touchmove', _onDocMove, {capture:true, passive:false});
            document.removeEventListener('touchend',  _onDocEnd,  false);
            /* Скидаємо gesture Blockly тільки якщо він завис (немає активного drag блоку) */
            try {
                const ws = window.workspace || Blockly.getMainWorkspace();
                const g = ws && ws.currentGesture_;
                if(g && !g.isDraggingBlock_) g.cancel();
            } catch(_) {}
        };

        for(let r=0;r<this.rows;r++) for(let c=0;c<this.cols;c++){
            const idx=r*this.cols+c;
            const rc=this._svg('rect',{
                x:c*C+.5, y:r*C+.5, width:C-1, height:C-1,
                fill:this._cellColor(idx),
                rx:C>8?2:1,
                style:'cursor:crosshair;touch-action:none'
            }, cg);
            /* Зберігаємо індекс на елементі для touchmove */
            rc._paintIdx = idx;
            const startDraw = e => {
                if(e.cancelable) e.preventDefault();
                this._p = true;
                this._e = this.pixels[idx] === 1;
                this._dot(idx, rc);
            };
            /* Тільки ЛКМ (button===0) */
            rc.addEventListener('mousedown', e => {
                if (e.button !== 0) return;
                e.preventDefault(); e.stopPropagation();
                this._p = true;
                this._e = this.pixels[idx] === 1;
                this._dot(idx, rc);
            });
            /* mouseenter: малюємо лише якщо LMB справді затиснута */
            rc.addEventListener('mouseenter', e => {
                if (!(e.buttons & 1)) { this._p = false; return; }
                if (this._p) this._dot(idx, rc);
            });
            rc.addEventListener('touchstart', e => {
                if(e.cancelable) e.preventDefault();
                try{const ws=window.workspace||Blockly.getMainWorkspace();const gg=ws&&ws.currentGesture_;if(gg)gg.cancel();}catch(_){}
                this._p=true; this._e=this.pixels[idx]===1; this._dot(idx,rc);
                if(!this._docListening){
                    this._docListening=true;
                    document.addEventListener('touchmove',this._onDocMove,{capture:true,passive:false});
                    document.addEventListener('touchend', this._onDocEnd, false);
                }
            },{passive:false});
            this._rects.push(rc);
        }
        document.addEventListener('mouseup', () => { this._p = false; });
        document.addEventListener('visibilitychange', () => { this._p = false; });
        /* Сітка */
        for(let r=0;r<=this.rows;r++) this._svg('line',{x1:0,y1:r*C,x2:W,y2:r*C,stroke:'#1e3a5f','stroke-width':'0.4'},g);
        for(let c=0;c<=this.cols;c++) this._svg('line',{x1:c*C,y1:0,x2:c*C,y2:H,stroke:'#1e3a5f','stroke-width':'0.4'},g);

        document.addEventListener('mouseup',()=>{ this._p=false; });
        document.addEventListener('visibilitychange',()=>{ this._p=false; });
        this._buildUI(g);
    }

    _buildCanvas(){
        const g=this.fieldGroup_; while(g.firstChild)g.removeChild(g.firstChild);
        const W=this.cW,H=this.cH,C=this.CELL;
        this._svg('rect',{x:0,y:0,width:W+36,height:H,fill:'#0a0f1a',rx:4},g);
        this._rects=[];
        const fo=document.createElementNS('http://www.w3.org/2000/svg','foreignObject');
        fo.setAttribute('x','0');fo.setAttribute('y','0');fo.setAttribute('width',String(W));fo.setAttribute('height',String(H));
        g.appendChild(fo);
        const cv=document.createElement('canvas');
        cv.width=W;cv.height=H;
        cv.style.cssText='display:block;width:'+W+'px;height:'+H+'px;touch-action:none;cursor:crosshair;';
        fo.appendChild(cv);
        this._cv=cv;this._ctx=cv.getContext('2d');this._redrawAll();
        const _idx=(cx,cy)=>{
            const r=cv.getBoundingClientRect();
            if(!r.width||!r.height) return -1;
            const col=Math.floor((cx-r.left)*(W/r.width)/C);
            const row=Math.floor((cy-r.top)*(H/r.height)/C);
            if(col<0||col>=this.cols||row<0||row>=this.rows) return -1;
            return row*this.cols+col;
        };
        const _dot=(idx)=>{
            if(idx<0)return;
            const v=this._e?0:1;
            if(this.pixels[idx]===v)return;
            this.pixels[idx]=v;this._redrawCell(idx);this.value_=this._ser();
        };
        let _td=false;
        cv.addEventListener('touchstart',e=>{
            if(e.cancelable)e.preventDefault();
            try{const ws=window.workspace||Blockly.getMainWorkspace();const gg=ws&&ws.currentGesture_;if(gg)gg.cancel();}catch(_){}
            _td=true;const t=e.touches[0],i=_idx(t.clientX,t.clientY);
            this._e=i>=0?this.pixels[i]===1:false;_dot(i);
        },{passive:false});
        cv.addEventListener('touchmove',e=>{
            if(!_td)return;if(e.cancelable)e.preventDefault();
            const t=e.touches[0];_dot(_idx(t.clientX,t.clientY));
        },{passive:false});
        cv.addEventListener('touchend',()=>{_td=false;});
        cv.addEventListener('touchcancel',()=>{_td=false;});
        /* Сітка тільки на телефоні */
        for(let r=0;r<=this.rows;r++) this._svg('line',{x1:0,y1:r*C,x2:W,y2:r*C,stroke:'#1e3a5f','stroke-width':'0.4','pointer-events':'none'},g);
        for(let c=0;c<=this.cols;c++) this._svg('line',{x1:c*C,y1:0,x2:c*C,y2:H,stroke:'#1e3a5f','stroke-width':'0.4','pointer-events':'none'},g);
        this._buildUI(g);
    }

    _buildUI(g){
        const W=this.cW,H=this.cH,PW=36,C=this.CELL;
        /* Шкала */
        this._svg('rect',{x:W,y:0,width:PW,height:H,fill:'#060c17'},g);
        [1,2,4,8].forEach((s,i)=>{
            const bH=H/4,act=s===this.scale;
            const bg=this._svg('rect',{x:W+2,y:i*bH+2,width:PW-4,height:bH-4,fill:act?'#4f46e5':'#1e2d45',rx:3},g);
            const lb=this._svg('text',{x:W+PW/2,y:i*bH+bH/2+4,'text-anchor':'middle',fill:act?'#fff':'#4b5563','font-size':'8.5','font-family':'monospace','font-weight':act?'bold':'normal'},g);
            lb.textContent=s+':1';
            const sz=this._svg('text',{x:W+PW/2,y:i*bH+bH/2+12,'text-anchor':'middle',fill:'#374151','font-size':'6','font-family':'monospace'},g);
            sz.textContent=Math.floor(128/s)+'\u00d7'+Math.floor(64/s);
            const fn=()=>this._scale(s);
            bg.addEventListener('click',fn);lb.addEventListener('click',fn);sz.addEventListener('click',fn);
        });
        /* Кнопки */
        const btnR=(x,w,lbl,fn)=>{
            const b=this._svg('rect',{x,y:H+2,width:w,height:16,fill:'#1e2d45',rx:3},g);
            const t=this._svg('text',{x:x+w/2,y:H+12,'text-anchor':'middle',fill:'#94a3b8','font-size':'8','font-family':'sans-serif'},g);
            t.textContent=lbl; b.addEventListener('click',fn); t.addEventListener('click',fn);
        };
        btnR(0,56,'🗑 очистити',()=>{this.pixels.fill(0);this._refreshAll();this.value_=this._ser();});
        btnR(59,38,'█ залити',()=>{this.pixels.fill(1);this._refreshAll();this.value_=this._ser();});
        btnR(100,W-100+PW,'↺ інверт',()=>{for(let i=0;i<this.pixels.length;i++)this.pixels[i]=this.pixels[i]?0:1;this._refreshAll();this.value_=this._ser();});

        /* ── Рядок 2: фото-трасування ── */
        const self=this;
        if(this._imgOpacity===undefined) this._imgOpacity=0.4;
        const R2Y=H+21,totW=W+PW;
        const B2=(x,w,lbl,fn,bg)=>{
            const b=this._svg('rect',{x,y:R2Y,width:w,height:16,fill:bg||'#1e2d45',rx:3},g);
            const t=this._svg('text',{x:x+w/2,y:R2Y+10,'text-anchor':'middle',fill:'#94a3b8','font-size':'8','font-family':'sans-serif'},g);
            t.textContent=lbl;
            [b,t].forEach(el=>{el.addEventListener('click',fn);el.addEventListener('touchend',e=>{e.preventDefault();fn();});});
        };
        const overlayImg=this._svg('image',{x:0,y:0,width:W,height:H,preserveAspectRatio:'none',opacity:this._imgOpacity,style:'pointer-events:none;display:none'},g);
        this._overlayImg=overlayImg;
        if(this._imgDataUrl){overlayImg.setAttribute('href',this._imgDataUrl);overlayImg.style.display='';}
        const p1=Math.floor(totW*.30),xW=Math.floor(totW*.09),mW=Math.floor(totW*.07),oW=Math.floor(totW*.17),p2=Math.floor(totW*.07),cW2=totW-p1-xW-mW-oW-p2-4;
        const opTxt=this._svg('text',{x:p1+xW+2+mW+oW/2,y:R2Y+11,'text-anchor':'middle',fill:'#a5b4fc','font-size':'7','font-family':'monospace'},g);
        opTxt.textContent=Math.round(this._imgOpacity*100)+'%';
        B2(0,p1,'📷 фото',()=>self._openCropModal(),'#162236');
        B2(p1+1,xW,'✕',()=>{self._imgDataUrl=null;self._imgCropData=null;overlayImg.removeAttribute('href');overlayImg.style.display='none';},'#2e1216');
        B2(p1+xW+2,mW,'-',()=>{self._imgOpacity=Math.max(0.05,+(self._imgOpacity-.1).toFixed(2));overlayImg.setAttribute('opacity',self._imgOpacity);opTxt.textContent=Math.round(self._imgOpacity*100)+'%';});
        B2(p1+xW+2+mW+oW,p2,'+',()=>{self._imgOpacity=Math.min(1,+(self._imgOpacity+.1).toFixed(2));overlayImg.setAttribute('opacity',self._imgOpacity);opTxt.textContent=Math.round(self._imgOpacity*100)+'%';});
        B2(p1+xW+2+mW+oW+p2+1,cW2-1,'✓ у пікселі',()=>{
            if(!self._imgCropData)return;
            const {data,cw,ch}=self._imgCropData;
            for(let r=0;r<self.rows;r++)for(let c2=0;c2<self.cols;c2++){
                const sx=Math.floor(c2*cw/self.cols),sy=Math.floor(r*ch/self.rows);
                const i4=(sy*cw+sx)*4,br=data[i4]*.299+data[i4+1]*.587+data[i4+2]*.114;
                self.pixels[r*self.cols+c2]=br<128?1:0;
            }
            self._rects.forEach((_,i)=>self._rects[i].setAttribute('fill',self._cellColor(i)));
            self.value_=self._ser();
        },'#162e1e');

        this.size_.width=W+PW+2; this.size_.height=H+50;
    }

    _refreshAll(){
        if(this._isTouch) this._redrawAll();
        else if(this._rects) this._rects.forEach((r,i)=>r.setAttribute('fill',this._cellColor(i)));
    }

    _cellColor(idx){
        if(this.pixels[idx]) return '#c7d2fe';
        if(this._onion&&this._onion[idx]) return '#2d3f6e';
        return '#1e2d45';
    }
    _redrawCell(idx){
        const ctx=this._ctx;if(!ctx)return;
        const C=this.CELL,col=idx%this.cols,row=Math.floor(idx/this.cols);
        const x=col*C,y=row*C,rr=C>8?2:1;
        ctx.fillStyle=this._cellColor(idx);
        if(rr>1){ctx.beginPath();ctx.moveTo(x+rr,y);ctx.lineTo(x+C-rr,y);ctx.arcTo(x+C,y,x+C,y+rr,rr);ctx.lineTo(x+C,y+C-rr);ctx.arcTo(x+C,y+C,x+C-rr,y+C,rr);ctx.lineTo(x+rr,y+C);ctx.arcTo(x,y+C,x,y+C-rr,rr);ctx.lineTo(x,y+rr);ctx.arcTo(x,y,x+rr,y,rr);ctx.closePath();ctx.fill();}
        else{ctx.fillRect(x,y,C,C);}
    }
    _redrawAll(){
        const ctx=this._ctx;if(!ctx)return;
        ctx.fillStyle='#0a0f1a';ctx.fillRect(0,0,this._cv.width,this._cv.height);
        for(let i=0;i<this.pixels.length;i++)this._redrawCell(i);
    }

    _dot(idx,rc){
        const v=this._e?0:1;
        this.pixels[idx]=v;
        rc.setAttribute('fill',this._cellColor(idx));
        this.value_=this._ser();
    }



    setOnionSkin(pixels){
        this._onion=pixels?new Uint8Array(pixels):null;
        this._refreshAll();
    }
    _scale(s){
        const op=this.pixels.slice(),oC=this.cols,oR=this.rows;
        this.scale=s;this.cols=Math.floor(128/s);this.rows=Math.floor(64/s);
        this.pixels=new Uint8Array(this.cols*this.rows);
        for(let r=0;r<this.rows;r++) for(let c=0;c<this.cols;c++){
            const or=Math.floor(r*oR/this.rows),oc=Math.floor(c*oC/this.cols);
            if(or<oR&&oc<oC)this.pixels[r*this.cols+c]=op[or*oC+oc];
        }
        this._build();this.value_=this._ser();
        if(this.sourceBlock_&&this.sourceBlock_.rendered)this.sourceBlock_.render();
    }
    _ser(){ return this.scale+'|'+Array.from(this.pixels).join(''); }
    getValue(){ return this.value_||this._ser(); }
    setValue(v){ this.value_=v||'';this._load(v); }
    getDisplayText_(){ return ''; }
    updateSize_(){ this.size_.width=this.cW+38;this.size_.height=this.cH+30; }
    _openCropModal(){
        const self=this;
        let inp=document.getElementById('_pgFileInput');
        if(!inp){inp=document.createElement('input');inp.type='file';inp.accept='image/*';inp.id='_pgFileInput';inp.style.cssText='position:fixed;opacity:0;pointer-events:none;top:0;left:0';document.body.appendChild(inp);}
        inp.value='';
        inp.onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>self._showCropper(ev.target.result);r.readAsDataURL(f);};
        inp.click();
    }
    _showCropper(dataUrl){
        const self=this;const aW=this.cols,aH=this.rows;
        let modal=document.getElementById('_pgCropModal');if(modal)modal.remove();
        modal=document.createElement('div');modal.id='_pgCropModal';
        modal.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;box-sizing:border-box';
        const h=document.createElement('div');h.style.cssText='color:#a5b4fc;font-size:14px;font-weight:600;font-family:sans-serif';h.textContent='Виберіть частину зображення';modal.appendChild(h);
        const sub=document.createElement('div');sub.style.cssText='color:#64748b;font-size:11px;font-family:sans-serif;margin-top:-8px';sub.textContent='Тягніть рамку — кут щоб змінити розмір';modal.appendChild(sub);
        const cWrap=document.createElement('div');cWrap.style.cssText='position:relative;flex-shrink:0;touch-action:none';
        const canvas=document.createElement('canvas');canvas.style.cssText='display:block;max-width:min(90vw,600px);max-height:50vh;border-radius:4px';cWrap.appendChild(canvas);modal.appendChild(cWrap);
        const slRow=document.createElement('div');slRow.style.cssText='display:flex;align-items:center;gap:10px;width:min(90vw,600px)';
        const slLbl=document.createElement('span');slLbl.style.cssText='color:#94a3b8;font-size:11px;font-family:sans-serif;white-space:nowrap';slLbl.textContent='Поріг B&W:';
        const slider=document.createElement('input');slider.type='range';slider.min=0;slider.max=255;slider.value=128;slider.style.cssText='flex:1;accent-color:#6366f1';
        const slVal=document.createElement('span');slVal.style.cssText='color:#a5b4fc;font-size:11px;font-family:monospace;min-width:28px';slVal.textContent='128';
        slider.oninput=()=>slVal.textContent=slider.value;
        slRow.appendChild(slLbl);slRow.appendChild(slider);slRow.appendChild(slVal);modal.appendChild(slRow);
        const bRow=document.createElement('div');bRow.style.cssText='display:flex;gap:10px';
        const mkB=(lbl,bg,fn)=>{const b=document.createElement('button');b.textContent=lbl;b.style.cssText='padding:8px 18px;background:'+bg+';color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-family:sans-serif';b.onclick=fn;return b;};
        bRow.appendChild(mkB('Скасувати','#374151',()=>modal.remove()));
        const btnOvl=mkB('👁 Накласти','#4f46e5',()=>{});
        const btnCnv=mkB('✓ Конвертувати','#059669',()=>{});
        bRow.appendChild(btnOvl);bRow.appendChild(btnCnv);modal.appendChild(bRow);
        document.body.appendChild(modal);
        const img=new Image();
        img.onload=()=>{
            const maxW=Math.min(600,window.innerWidth*.9),maxH=Math.min(window.innerHeight*.5,400);
            let cW=img.width,cH=img.height;
            if(cW>maxW){cH=cH*maxW/cW;cW=maxW;}if(cH>maxH){cW=cW*maxH/cH;cH=maxH;}
            cW=Math.round(cW);cH=Math.round(cH);canvas.width=cW;canvas.height=cH;canvas.style.width=cW+'px';canvas.style.height=cH+'px';
            const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,cW,cH);
            const asp=aW/aH;let rW,rH;
            if(cW/cH>asp){rH=cH*.8;rW=rH*asp;}else{rW=cW*.8;rH=rW/asp;}
            rW=Math.round(rW);rH=Math.round(rH);let rX=Math.round((cW-rW)/2),rY=Math.round((cH-rH)/2);
            let drag=false,rsz=false,dSX=0,dSY=0,dRX=0,dRY=0;const HND=14;
            const draw=()=>{
                ctx.drawImage(img,0,0,cW,cH);
                ctx.fillStyle='rgba(0,0,0,0.55)';
                ctx.fillRect(0,0,cW,rY);ctx.fillRect(0,rY+rH,cW,cH-rY-rH);ctx.fillRect(0,rY,rX,rH);ctx.fillRect(rX+rW,rY,cW-rX-rW,rH);
                ctx.strokeStyle='#6366f1';ctx.lineWidth=2;ctx.strokeRect(rX+1,rY+1,rW-2,rH-2);
                ctx.strokeStyle='rgba(99,102,241,0.4)';ctx.lineWidth=1;
                [1,2].forEach(i=>{ctx.beginPath();ctx.moveTo(rX+rW*i/3,rY);ctx.lineTo(rX+rW*i/3,rY+rH);ctx.stroke();ctx.beginPath();ctx.moveTo(rX,rY+rH*i/3);ctx.lineTo(rX+rW,rY+rH*i/3);ctx.stroke();});
                ctx.fillStyle='rgba(99,102,241,0.85)';ctx.fillRect(rX,rY,70,16);ctx.fillStyle='#fff';ctx.font='10px monospace';ctx.fillText(aW+'x'+aH,rX+3,rY+11);
                ctx.fillStyle='#6366f1';ctx.fillRect(rX+rW-HND,rY+rH-HND,HND,HND);
            };draw();
            const pos=e=>{const r=canvas.getBoundingClientRect(),s=e.touches?e.touches[0]:e;return{x:s.clientX-r.left,y:s.clientY-r.top};};
            const isH=p=>p.x>=rX+rW-HND&&p.x<=rX+rW&&p.y>=rY+rH-HND&&p.y<=rY+rH;
            const onD=e=>{e.preventDefault();const p=pos(e);if(isH(p)){rsz=true;}else if(p.x>=rX&&p.x<=rX+rW&&p.y>=rY&&p.y<=rY+rH){drag=true;dSX=p.x;dSY=p.y;dRX=rX;dRY=rY;}};
            const onM=e=>{e.preventDefault();if(!drag&&!rsz)return;const p=pos(e);if(drag){rX=Math.max(0,Math.min(cW-rW,dRX+(p.x-dSX)));rY=Math.max(0,Math.min(cH-rH,dRY+(p.y-dSY)));}else{let nW=Math.max(20,p.x-rX),nH=Math.max(10,p.y-rY);if(nW/nH>asp)nH=nW/asp;else nW=nH*asp;rW=Math.min(Math.round(nW),cW-rX);rH=Math.min(Math.round(rW/asp),cH-rY);rW=Math.round(rH*asp);}draw();};
            const onU=()=>{drag=false;rsz=false;};
            canvas.addEventListener('mousedown',onD);canvas.addEventListener('mousemove',onM);canvas.addEventListener('mouseup',onU);
            canvas.addEventListener('touchstart',onD,{passive:false});canvas.addEventListener('touchmove',onM,{passive:false});canvas.addEventListener('touchend',onU);
            const crop=()=>{const off=document.createElement('canvas');off.width=self.cols;off.height=self.rows;const oc=off.getContext('2d');const sx=img.width/cW,sy=img.height/cH;oc.drawImage(img,rX*sx,rY*sy,rW*sx,rH*sy,0,0,self.cols,self.rows);return oc.getImageData(0,0,self.cols,self.rows);};
            btnOvl.onclick=()=>{const off=document.createElement('canvas');off.width=self.cols;off.height=self.rows;const oc=off.getContext('2d');const sx=img.width/cW,sy=img.height/cH;oc.drawImage(img,rX*sx,rY*sy,rW*sx,rH*sy,0,0,self.cols,self.rows);self._imgDataUrl=off.toDataURL();self._imgCropData=crop();if(self._overlayImg){self._overlayImg.setAttribute('href',self._imgDataUrl);self._overlayImg.setAttribute('opacity',self._imgOpacity);self._overlayImg.style.display='';}modal.remove();};
            btnCnv.onclick=()=>{const id=crop();const thr=parseInt(slider.value)||128;for(let r=0;r<self.rows;r++)for(let c2=0;c2<self.cols;c2++){const i4=(r*self.cols+c2)*4,br=id.data[i4]*.299+id.data[i4+1]*.587+id.data[i4+2]*.114;self.pixels[r*self.cols+c2]=br<thr?1:0;}self._imgCropData={data:id.data,cw:self.cols,ch:self.rows};self._refreshAll();self.value_=self._ser();modal.remove();};
        };img.src=dataUrl;
    }
}

/* ================================================================
   disp_anim_frame: onion-skin — при зміні IDX показує попередній кадр
   ================================================================ */
(function(){
    /* Знайти блок disp_anim_frame з IDX=targetIdx в workspace */
    function findFrameBlock(workspace, targetIdx){
        return workspace.getAllBlocks(false).find(b =>
            b.type === 'disp_anim_frame' &&
            parseInt(b.getFieldValue('IDX')) === targetIdx
        );
    }

    /* Отримати пікселі з GRID поля блоку */
    function getBlockPixels(block){
        if(!block) return null;
        const val = block.getFieldValue('GRID') || '';
        if(!val.includes('|')) return null;
        const [sc, hex] = val.split('|');
        const scale = parseInt(sc)||4;
        const cols = Math.floor(128/scale);
        const rows = Math.floor(64/scale);
        const px = new Uint8Array(cols*rows);
        for(let i=0;i<Math.min(hex.length,px.length);i++) px[i]=hex[i]==='1'?1:0;
        return px;
    }

    /* Зареєструвати onchange після того як Blockly визначить блок */
    const _orig = Blockly.Blocks['disp_anim_frame'];
    if(_orig){
        const origInit = _orig.init;
        Blockly.Blocks['disp_anim_frame'].init = function(){
            if(origInit) origInit.call(this);
            this.setOnChange(function(event){
                if(!this.workspace) return;
                /* Реагуємо на зміну IDX dropdown або на переміщення блоку */
                if(event.type !== Blockly.Events.BLOCK_CHANGE &&
                   event.type !== Blockly.Events.BLOCK_MOVE &&
                   event.type !== Blockly.Events.BLOCK_CREATE) return;
                if(event.blockId && event.blockId !== this.id) return;

                const curIdx  = parseInt(this.getFieldValue('IDX'));
                const prevIdx = curIdx - 1; /* попередній кадр */

                const gridField = this.getField('GRID');
                if(!gridField) return;

                if(prevIdx < 0){
                    /* Перший кадр — прибрати onion */
                    gridField.setOnionSkin(null);
                    return;
                }

                const prevBlock = findFrameBlock(this.workspace, prevIdx);
                const prevPixels = getBlockPixels(prevBlock);
                gridField.setOnionSkin(prevPixels);
            });
        };
    }
})();

FieldPaintGrid.prototype.DEFAULT_VALUE='4|'+'0'.repeat(32*16);
Blockly.fieldRegistry.register('field_paint_grid',FieldPaintGrid);

/* ================================================================
   TOOLBOX XML
   ================================================================ */
window.DISPLAY_CATEGORY=`
<category name="\uD83D\uDDA5\uFE0F Дисплей" colour="#4f46e5">
  <label text="\u2014 Основне \u2014"></label>
  <block type="disp_clear"></block>
  <block type="disp_send"></block>
  <block type="disp_hud"></block>
  <block type="disp_text">
    <field name="TXT">Привіт</field><field name="SIZE">small</field>
    <value name="X"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
    <value name="Y"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
  </block>
  <block type="disp_number">
    <value name="VAL"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
    <value name="X"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
    <value name="Y"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
  </block>
  <block type="disp_smile"><field name="FACE">happy</field></block>
  <label text="\u2014 Малювання \u2014"></label>
  <block type="disp_pixel_on">
    <value name="X"><shadow type="math_number"><field name="NUM">64</field></shadow></value>
    <value name="Y"><shadow type="math_number"><field name="NUM">32</field></shadow></value>
  </block>
  <block type="disp_pixel_off">
    <value name="X"><shadow type="math_number"><field name="NUM">64</field></shadow></value>
    <value name="Y"><shadow type="math_number"><field name="NUM">32</field></shadow></value>
  </block>
  <block type="disp_pixel_get">
    <value name="X"><shadow type="math_number"><field name="NUM">64</field></shadow></value>
    <value name="Y"><shadow type="math_number"><field name="NUM">32</field></shadow></value>
  </block>
  <block type="disp_line">
    <value name="X1"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
    <value name="Y1"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
    <value name="X2"><shadow type="math_number"><field name="NUM">127</field></shadow></value>
    <value name="Y2"><shadow type="math_number"><field name="NUM">63</field></shadow></value>
  </block>
  <block type="disp_rect">
    <value name="X"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
    <value name="Y"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
    <value name="W"><shadow type="math_number"><field name="NUM">30</field></shadow></value>
    <value name="H"><shadow type="math_number"><field name="NUM">20</field></shadow></value>
  </block>
  <block type="disp_circle">
    <value name="CX"><shadow type="math_number"><field name="NUM">64</field></shadow></value>
    <value name="CY"><shadow type="math_number"><field name="NUM">32</field></shadow></value>
    <value name="R"><shadow type="math_number"><field name="NUM">15</field></shadow></value>
  </block>
  <block type="disp_fill"></block>
  <block type="disp_random_pixels">
    <value name="N"><shadow type="math_number"><field name="NUM">50</field></shadow></value>
  </block>
  <label text="\u2014 Малювалка \u2014"></label>
  <block type="disp_paint"></block>
  <label text="\u2014 Анімація \u2014"></label>
  <block type="disp_anim_frame"><field name="IDX">0</field></block>
  <block type="disp_anim_save"><field name="IDX">0</field></block>
  <block type="disp_anim_load"><field name="IDX">0</field></block>
  <block type="disp_anim_play">
    <value name="MS"><shadow type="math_number"><field name="NUM">200</field></shadow></value>
  </block>
  <block type="disp_anim_stop"></block>
  <label text="\u2014 Ігровий цикл \u2014"></label>
  <block type="game_loop">
    <value name="MS"><shadow type="math_number"><field name="NUM">100</field></shadow></value>
  </block>
  <block type="game_stop"></block>
  <label text="\u2014 Спрайти \u2014"></label>
  <block type="sprite_create">
    <value name="ID"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
    <value name="X"><shadow type="math_number"><field name="NUM">60</field></shadow></value>
    <value name="Y"><shadow type="math_number"><field name="NUM">28</field></shadow></value>
    <value name="W"><shadow type="math_number"><field name="NUM">8</field></shadow></value>
    <value name="H"><shadow type="math_number"><field name="NUM">8</field></shadow></value>
  </block>
  <block type="sprite_move">
    <value name="ID"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
    <value name="DX"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
    <value name="DY"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
  </block>
  <block type="sprite_setpos">
    <value name="ID"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
    <value name="X"><shadow type="math_number"><field name="NUM">64</field></shadow></value>
    <value name="Y"><shadow type="math_number"><field name="NUM">32</field></shadow></value>
  </block>
  <block type="sprite_getx">
    <value name="ID"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
  </block>
  <block type="sprite_gety">
    <value name="ID"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
  </block>
  <block type="sprite_collide">
    <value name="A"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
    <value name="B"><shadow type="math_number"><field name="NUM">2</field></shadow></value>
  </block>
  <block type="sprite_edge">
    <value name="ID"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
  </block>
  <block type="sprite_draw">
    <value name="ID"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
  </block>
  <block type="sprite_erase">
    <value name="ID"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
  </block>
  <label text="\u2014 Джойстик \u2014"></label>
  <block type="game_joy_is"><field name="DIR">up</field></block>
  <block type="game_joy_dir"></block>
  <block type="game_joy_axis"><field name="AXIS">x</field></block>
  <label text="\u2014 Рахунок \u2014"></label>
  <block type="game_score_add">
    <value name="VAL"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
  </block>
  <block type="game_score_get"></block>
  <block type="game_score_reset"></block>
  <label text="\u2014 Утиліти \u2014"></label>
  <block type="game_random">
    <value name="MIN"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
    <value name="MAX"><shadow type="math_number"><field name="NUM">127</field></shadow></value>
  </block>
  <block type="game_clamp">
    <value name="VAL"><shadow type="math_number"><field name="NUM">64</field></shadow></value>
    <value name="MIN"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
    <value name="MAX"><shadow type="math_number"><field name="NUM">127</field></shadow></value>
  </block>
</category>
`;

/* ================================================================
   BLOCK DEFINITIONS
   ================================================================ */
Blockly.defineBlocksWithJsonArray([
  /* Основне */
  {"type":"disp_clear","message0":"\uD83D\uDDA5\uFE0F очистити екран","previousStatement":null,"nextStatement":null,"colour":"#4f46e5","tooltip":"\u0421\u0442\u0438\u0440\u0430\u0454 \u0432\u0435\u0441\u044c \u0435\u043a\u0440\u0430\u043d \u2014 \u0432\u0441\u0456 \u043f\u0456\u043a\u0441\u0435\u043b\u0456 \u0433\u0430\u0441\u044f\u0442\u044c\u0441\u044f"},
  {"type":"disp_hud","message0":"\uD83D\uDCF1 стандартний екран","previousStatement":null,"nextStatement":null,"colour":"#4f46e5","tooltip":"Повертає стандартний HUD екран"},
  {"type":"disp_send","message0":"\uD83D\uDCE4 відправити на екран","previousStatement":null,"nextStatement":null,"colour":"#4f46e5","tooltip":"RLE-стиснення + BT відправка на STM32"},
  {"type":"disp_fill","message0":"\u2588 заповнити екран","previousStatement":null,"nextStatement":null,"colour":"#4f46e5","tooltip":"\u0417\u0430\u043f\u043e\u0432\u043d\u044e\u0454 \u0432\u0435\u0441\u044c \u0435\u043a\u0440\u0430\u043d \u2014 \u0432\u0441\u0456 8192 \u043f\u0456\u043a\u0441\u0435\u043b\u0456 \u0432\u043c\u0438\u043a\u0430\u044e\u0442\u044c\u0441\u044f"},
  {"type":"disp_text","message0":"\uD83D\uDDA5\uFE0F текст %1 %2 X %3 Y %4",
   "args0":[{"type":"field_input","name":"TXT","text":"Привіт"},{"type":"field_dropdown","name":"SIZE","options":[["малий","small"],["великий","big"]]},
            {"type":"input_value","name":"X","check":"Number"},{"type":"input_value","name":"Y","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#4f46e5","tooltip":"\u0412\u0438\u0432\u043e\u0434\u0438\u0442\u044c \u0442\u0435\u043a\u0441\u0442. X,Y \u2014 \u043f\u043e\u0437\u0438\u0446\u0456\u044f \u043b\u0456\u0432\u043e\u0433\u043e \u0432\u0435\u0440\u0445\u043d\u044c\u043e\u0433\u043e \u043a\u0443\u0442\u0430"},
  {"type":"disp_number","message0":"\uD83D\uDDA5\uFE0F число %1 X %2 Y %3",
   "args0":[{"type":"input_value","name":"VAL","check":"Number"},{"type":"input_value","name":"X","check":"Number"},{"type":"input_value","name":"Y","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#4f46e5","tooltip":"\u0412\u0438\u0432\u043e\u0434\u0438\u0442\u044c \u0447\u0438\u0441\u043b\u043e \u0446\u0438\u0444\u0440\u0430\u043c\u0438 \u043d\u0430 \u0435\u043a\u0440\u0430\u043d\u0456"},
  {"type":"disp_smile","message0":"\uD83D\uDDA5\uFE0F смайл %1",
   "args0":[{"type":"field_dropdown","name":"FACE","options":[["😊","happy"],["😢","sad"],["⚡","bolt"],["❓","question"],["✓","check"]]}],
   "previousStatement":null,"nextStatement":null,"colour":"#4f46e5","tooltip":"\u041c\u0430\u043b\u044e\u0454 \u0441\u043c\u0430\u0439\u043b\u0438\u043a \u043f\u043e \u0446\u0435\u043d\u0442\u0440\u0443: \u0443\u0441\u043c\u0456\u0445\u043d\u0435\u043d\u0438\u0439, \u0441\u0443\u043c\u043d\u0438\u0439 \u0430\u0431\u043e \u043d\u0435\u0439\u0442\u0440\u0430\u043b\u044c\u043d\u0438\u0439"},

  /* Малювання */
  {"type":"disp_pixel_on","message0":"\u25A0 піксель X %1 Y %2",
   "args0":[{"type":"input_value","name":"X","check":"Number"},{"type":"input_value","name":"Y","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#6d28d9","tooltip":"\u0412\u043c\u0438\u043a\u0430\u0454 \u043f\u0456\u043a\u0441\u0435\u043b\u044c X,Y (0-127 x, 0-63 y)"},
  {"type":"disp_pixel_off","message0":"\u25A1 стерти X %1 Y %2",
   "args0":[{"type":"input_value","name":"X","check":"Number"},{"type":"input_value","name":"Y","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#6d28d9","tooltip":"\u0412\u0438\u043c\u0438\u043a\u0430\u0454 \u043f\u0456\u043a\u0441\u0435\u043b\u044c X,Y"},
  {"type":"disp_pixel_get","message0":"піксель є X %1 Y %2",
   "args0":[{"type":"input_value","name":"X","check":"Number"},{"type":"input_value","name":"Y","check":"Number"}],
   "inputsInline":true,"output":"Boolean","colour":"#6d28d9","tooltip":"true \u044f\u043a\u0449\u043e \u043f\u0456\u043a\u0441\u0435\u043b\u044c X,Y \u0443\u0432\u0456\u043c\u043a\u043d\u0435\u043d\u0438\u0439"},
  {"type":"disp_line","message0":"\uD83D\uDCCF лінія X1 %1 Y1 %2 X2 %3 Y2 %4",
   "args0":[{"type":"input_value","name":"X1","check":"Number"},{"type":"input_value","name":"Y1","check":"Number"},
            {"type":"input_value","name":"X2","check":"Number"},{"type":"input_value","name":"Y2","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#6d28d9","tooltip":"\u041f\u0440\u044f\u043c\u0430 \u043b\u0456\u043d\u0456\u044f \u0432\u0456\u0434 (X1,Y1) \u0434\u043e (X2,Y2)"},
  {"type":"disp_rect","message0":"%1 прямокутник X %2 Y %3 W %4 H %5",
   "args0":[{"type":"field_dropdown","name":"FILL","options":[["контур","0"],["залитий","1"]]},
            {"type":"input_value","name":"X","check":"Number"},{"type":"input_value","name":"Y","check":"Number"},
            {"type":"input_value","name":"W","check":"Number"},{"type":"input_value","name":"H","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#6d28d9","tooltip":"\u041f\u0440\u044f\u043c\u043e\u043a\u0443\u0442\u043d\u0438\u043a \u2014 \u043a\u043e\u043d\u0442\u0443\u0440 \u0430\u0431\u043e \u0437\u0430\u043b\u0438\u0442\u0438\u0439"},
  {"type":"disp_circle","message0":"%1 коло X %2 Y %3 R %4",
   "args0":[{"type":"field_dropdown","name":"FILL","options":[["контур","0"],["залитий","1"]]},
            {"type":"input_value","name":"CX","check":"Number"},{"type":"input_value","name":"CY","check":"Number"},
            {"type":"input_value","name":"R","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#6d28d9","tooltip":"\u041a\u043e\u043b\u043e \u0430\u0431\u043e \u0437\u0430\u043b\u0438\u0442\u0435 \u043a\u043e\u043b\u043e"},
  {"type":"disp_random_pixels","message0":"\uD83C\uDFB2 рандомні пікселі %1",
   "args0":[{"type":"input_value","name":"N","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#6d28d9","tooltip":"\u0412\u043c\u0438\u043a\u0430\u0454 N \u0432\u0438\u043f\u0430\u0434\u043a\u043e\u0432\u0438\u0445 \u043f\u0456\u043a\u0441\u0435\u043b\u0456\u0432"},

  /* Малювалка */
  {"type":"disp_paint","message0":"\uD83C\uDFA8 намалювати %1",
   "args0":[{"type":"field_paint_grid","name":"GRID"}],
   "previousStatement":null,"nextStatement":null,"colour":"#4f46e5","tooltip":"\u0412\u0438\u0432\u043e\u0434\u0438\u0442\u044c \u043d\u0430\u043c\u0430\u043b\u044c\u043e\u0432\u0430\u043d\u0435 \u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u043d\u044f \u043f\u0456\u043a\u0441\u0435\u043b\u044f\u043c\u0438 \u043d\u0430 \u0435\u043a\u0440\u0430\u043d\u0456"},

  /* Анімація */
  {"type":"disp_anim_frame","message0":"\uD83C\uDFAC кадр %1 %2",
   "args0":[{"type":"field_dropdown","name":"IDX","options":[["1","0"],["2","1"],["3","2"],["4","3"],["5","4"],["6","5"],["7","6"],["8","7"],["9","8"],["10","9"]]},{"type":"field_paint_grid","name":"GRID"}],
   "previousStatement":null,"nextStatement":null,"colour":"#059669","tooltip":"\u0417\u0431\u0435\u0440\u0456\u0433\u0430\u0454 \u043c\u0430\u043b\u044e\u043d\u043e\u043a \u044f\u043a \u043a\u0430\u0434\u0440 \u0430\u043d\u0456\u043c\u0430\u0446\u0456\u0457 (1-10)"},
  {"type":"disp_anim_save","message0":"\uD83D\uDCBE зберегти екран → кадр %1",
   "args0":[{"type":"field_dropdown","name":"IDX","options":[["1","0"],["2","1"],["3","2"],["4","3"],["5","4"],["6","5"],["7","6"],["8","7"],["9","8"],["10","9"]]}],
   "previousStatement":null,"nextStatement":null,"colour":"#059669","tooltip":"\u0417\u0431\u0435\u0440\u0456\u0433\u0430\u0454 \u043f\u043e\u0442\u043e\u0447\u043d\u0438\u0439 \u0431\u0443\u0444\u0435\u0440 \u0432 \u043f\u0440\u043e\u043d\u0443\u043c\u0435\u0440\u043e\u0432\u0430\u043d\u0438\u0439 \u043a\u0430\u0434\u0440"},
  {"type":"disp_anim_load","message0":"\uD83D\uDCC2 кадр %1 → екран",
   "args0":[{"type":"field_dropdown","name":"IDX","options":[["1","0"],["2","1"],["3","2"],["4","3"],["5","4"],["6","5"],["7","6"],["8","7"],["9","8"],["10","9"]]}],
   "previousStatement":null,"nextStatement":null,"colour":"#059669","tooltip":"\u0417\u0430\u0432\u0430\u043d\u0442\u0430\u0436\u0443\u0454 \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043d\u0438\u0439 \u043a\u0430\u0434\u0440 \u043d\u0430 \u0435\u043a\u0440\u0430\u043d"},
  {"type":"disp_anim_play","message0":"▶️ анімація кадри %1\u2013%2 кожні %3 мс",
   "args0":[{"type":"field_dropdown","name":"FROM","options":[["1","0"],["2","1"],["3","2"]]},
            {"type":"field_dropdown","name":"TO","options":[["2","1"],["3","2"],["4","3"]]},
            {"type":"input_value","name":"MS","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#059669","tooltip":"\u041f\u0440\u043e\u0433\u0440\u0430\u0454 \u043a\u0430\u0434\u0440\u0438 FROM-TO \u0437 \u043f\u0430\u0443\u0437\u043e\u044e N \u043c\u0441"},
  {"type":"disp_anim_stop","message0":"\u23F9 зупинити анімацію","previousStatement":null,"nextStatement":null,"colour":"#059669","tooltip":"\u0417\u0443\u043f\u0438\u043d\u044f\u0454 \u0430\u043d\u0456\u043c\u0430\u0446\u0456\u044e"},

  /* Ігровий цикл */
  {"type":"game_loop","message0":"\uD83C\uDFAE кожні %1 мс \u2192 %2",
   "args0":[{"type":"input_value","name":"MS","check":"Number"},{"type":"input_statement","name":"DO"}],
   "previousStatement":null,"nextStatement":null,"colour":"#dc2626",
   "tooltip":"Асинхронний ігровий цикл. Виконує блоки всередині кожні N мс."},
  {"type":"game_stop","message0":"\u23F9 зупинити гру","previousStatement":null,"nextStatement":null,"colour":"#dc2626","tooltip":"\u0417\u0443\u043f\u0438\u043d\u044f\u0454 \u0456\u0433\u0440\u043e\u0432\u0438\u0439 \u0446\u0438\u043a\u043b"},

  /* Спрайти */
  {"type":"sprite_create","message0":"\uD83D\uDC7E спрайт #%1 X %2 Y %3 розмір %4\u00d7%5",
   "args0":[{"type":"input_value","name":"ID","check":"Number"},{"type":"input_value","name":"X","check":"Number"},
            {"type":"input_value","name":"Y","check":"Number"},{"type":"input_value","name":"W","check":"Number"},{"type":"input_value","name":"H","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#b45309","tooltip":"\u0421\u0442\u0432\u043e\u0440\u044e\u0454 \u0441\u043f\u0440\u0430\u0439\u0442 ID \u0437 \u043f\u043e\u0437\u0438\u0446\u0456\u0454\u044e X,Y \u0456 \u0440\u043e\u0437\u043c\u0456\u0440\u043e\u043c WxH"},
  {"type":"sprite_move","message0":"\uD83D\uDC7E #%1 рухати dX %2 dY %3",
   "args0":[{"type":"input_value","name":"ID","check":"Number"},{"type":"input_value","name":"DX","check":"Number"},{"type":"input_value","name":"DY","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#b45309","tooltip":"\u041f\u0435\u0440\u0435\u043c\u0456\u0449\u0443\u0454 \u0441\u043f\u0440\u0430\u0439\u0442 \u043d\u0430 dX, dY \u043f\u0456\u043a\u0441\u0435\u043b\u0456\u0432"},
  {"type":"sprite_setpos","message0":"\uD83D\uDC7E #%1 поставити X %2 Y %3",
   "args0":[{"type":"input_value","name":"ID","check":"Number"},{"type":"input_value","name":"X","check":"Number"},{"type":"input_value","name":"Y","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#b45309","tooltip":"\u0412\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u044e\u0454 \u0442\u043e\u0447\u043d\u0443 \u043f\u043e\u0437\u0438\u0446\u0456\u044e X,Y \u0441\u043f\u0440\u0430\u0439\u0442\u0443"},
  {"type":"sprite_getx","message0":"\uD83D\uDC7E #%1 X","args0":[{"type":"input_value","name":"ID","check":"Number"}],"output":"Number","colour":"#b45309","tooltip":"X-\u043a\u043e\u043e\u0440\u0434\u0438\u043d\u0430\u0442\u0430 \u0441\u043f\u0440\u0430\u0439\u0442\u0430 (0-127)"},
  {"type":"sprite_gety","message0":"\uD83D\uDC7E #%1 Y","args0":[{"type":"input_value","name":"ID","check":"Number"}],"output":"Number","colour":"#b45309","tooltip":"Y-\u043a\u043e\u043e\u0440\u0434\u0438\u043d\u0430\u0442\u0430 \u0441\u043f\u0440\u0430\u0439\u0442\u0430 (0-63)"},
  {"type":"sprite_collide","message0":"\uD83D\uDCA5 спрайт #%1 торкається #%2",
   "args0":[{"type":"input_value","name":"A","check":"Number"},{"type":"input_value","name":"B","check":"Number"}],
   "inputsInline":true,"output":"Boolean","colour":"#b45309","tooltip":"true \u044f\u043a\u0449\u043e \u0434\u0432\u0430 \u0441\u043f\u0440\u0430\u0439\u0442\u0438 \u043f\u0435\u0440\u0435\u0442\u0438\u043d\u0430\u044e\u0442\u044c\u0441\u044f"},
  {"type":"sprite_edge","message0":"\uD83D\uDC7E #%1 торкається краю","args0":[{"type":"input_value","name":"ID","check":"Number"}],"output":"Boolean","colour":"#b45309","tooltip":"true \u044f\u043a\u0449\u043e \u0441\u043f\u0440\u0430\u0439\u0442 \u0442\u043e\u0440\u043a\u043d\u0443\u0432\u0441\u044f \u043a\u0440\u0430\u044e"},
  {"type":"sprite_draw","message0":"\uD83D\uDC7E намалювати #%1","args0":[{"type":"input_value","name":"ID","check":"Number"}],"inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#b45309","tooltip":"\u041c\u0430\u043b\u044e\u0454 \u0441\u043f\u0440\u0430\u0439\u0442 \u0443 \u043f\u043e\u0442\u043e\u0447\u043d\u0456\u0439 \u043f\u043e\u0437\u0438\u0446\u0456\u0457"},
  {"type":"sprite_erase","message0":"\uD83D\uDC7E стерти #%1","args0":[{"type":"input_value","name":"ID","check":"Number"}],"inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#b45309","tooltip":"\u0421\u0442\u0438\u0440\u0430\u0454 \u0441\u043f\u0440\u0430\u0439\u0442 \u0437 \u0431\u0443\u0444\u0435\u0440\u0430"},

  /* Джойстик */
  {"type":"game_joy_is","message0":"\uD83D\uDD79\uFE0F %1",
   "args0":[{"type":"field_dropdown","name":"DIR","options":[["↑ вгору","up"],["↓ вниз","down"],["← ліво","left"],["→ право","right"],["● центр","center"]]}],
   "output":"Boolean","colour":"#dc2626","tooltip":"true \u044f\u043a\u0449\u043e \u0434\u0436\u043e\u0439\u0441\u0442\u0438\u043a \u0443 \u0432\u043a\u0430\u0437\u0430\u043d\u043e\u043c\u0443 \u043d\u0430\u043f\u0440\u044f\u043c\u043a\u0443"},
  {"type":"game_joy_dir","message0":"\uD83D\uDD79\uFE0F напрямок","output":"String","colour":"#dc2626","tooltip":"\u041d\u0430\u043f\u0440\u044f\u043c\u043e\u043a \u0434\u0436\u043e\u0439\u0441\u0442\u0438\u043a\u0430: up/down/left/right/center"},
  {"type":"game_joy_axis","message0":"\uD83D\uDD79\uFE0F вісь %1 (-100..100)",
   "args0":[{"type":"field_dropdown","name":"AXIS","options":[["X (ліво/право)","x"],["Y (вгору/вниз)","y"]]}],
   "output":"Number","colour":"#dc2626","tooltip":"\u0412\u0456\u0441\u044c \u0434\u0436\u043e\u0439\u0441\u0442\u0438\u043a\u0430 -100..100"},

  /* Рахунок */
  {"type":"game_score_add","message0":"\uD83C\uDFC6 рахунок +%1","args0":[{"type":"input_value","name":"VAL","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#dc2626","tooltip":"\u0414\u043e\u0434\u0430\u0454 N \u043e\u0447\u043e\u043a \u0434\u043e \u0440\u0430\u0445\u0443\u043d\u043a\u0443"},
  {"type":"game_score_get","message0":"\uD83C\uDFC6 рахунок","output":"Number","colour":"#dc2626","tooltip":"\u041f\u043e\u0442\u043e\u0447\u043d\u0438\u0439 \u0440\u0430\u0445\u0443\u043d\u043e\u043a \u0433\u0440\u0438"},
  {"type":"game_score_reset","message0":"\uD83C\uDFC6 скинути рахунок","previousStatement":null,"nextStatement":null,"colour":"#dc2626","tooltip":"\u0421\u043a\u0438\u0434\u0430\u0454 \u0440\u0430\u0445\u0443\u043d\u043e\u043a \u0434\u043e 0"},

  /* Утиліти */
  {"type":"game_random","message0":"\uD83C\uDFB2 рандом від %1 до %2",
   "args0":[{"type":"input_value","name":"MIN","check":"Number"},{"type":"input_value","name":"MAX","check":"Number"}],
   "inputsInline":true,"output":"Number","colour":"#0891b2","tooltip":"\u0412\u0438\u043f\u0430\u0434\u043a\u043e\u0432\u0435 \u0446\u0456\u043b\u0435 \u0447\u0438\u0441\u043b\u043e \u0432\u0456\u0434 MIN \u0434\u043e MAX"},
  {"type":"game_clamp","message0":"обмежити %1 мін %2 макс %3",
   "args0":[{"type":"input_value","name":"VAL","check":"Number"},{"type":"input_value","name":"MIN","check":"Number"},{"type":"input_value","name":"MAX","check":"Number"}],
   "inputsInline":true,"output":"Number","colour":"#0891b2","tooltip":"\u041e\u0431\u043c\u0435\u0436\u0443\u0454 VAL \u0432 \u0434\u0456\u0430\u043f\u0430\u0437\u043e\u043d\u0456 MIN..MAX"}
]);

/* ================================================================
   JS GENERATORS
   ================================================================ */
const J = (window.javascript && window.javascript.javascriptGenerator) || 
          (window.Blockly && window.Blockly.JavaScript);
if (!J) { console.error('blocks_display: no JS generator'); }
if (J && !J.forBlock) J.forBlock = {};
const v=(b,n,d)=>J.valueToCode(b,n,J.ORDER_ATOMIC)||d;
const PE='window.PixelEngine';

J['disp_clear'] = ()=>`${PE}.clear();\n`;
J['disp_hud']   = ()=>`await ${PE}.showHUD();\n`;
J['disp_send'] = ()=>`${PE}.sendFrame();\n`;
J['disp_fill'] = ()=>`${PE}.fill(1);\n`;

J['disp_text'] = (b)=>{
  const t=JSON.stringify(b.getFieldValue('TXT'));
  const scale=b.getFieldValue('SIZE')==='big'?2:1;
  return `${PE}.drawText(${t},+${v(b,'X','0')},+${v(b,'Y','0')},${scale});\n`;
};
J['disp_number'] = (b)=>`${PE}.drawText(String(Math.round(${v(b,'VAL','0')})),+${v(b,'X','0')},+${v(b,'Y','0')},1);\n`;
J['disp_smile'] = (b)=>{
  const f=b.getFieldValue('FACE');
  const m=f==='happy'?`for(let i=-5;i<=5;i++)${PE}.set(cx+i,cy+5+Math.round(3*Math.sin((i+5)*Math.PI/10)),1);`
          :f==='sad'?`for(let i=-5;i<=5;i++)${PE}.set(cx+i,cy+8-Math.round(3*Math.sin((i+5)*Math.PI/10)),1);`
          :`for(let i=-5;i<=5;i++)${PE}.set(cx+i,cy+6,1);`;
  return `(()=>{const cx=64,cy=32;${PE}.circle(cx,cy,13,1,false);${PE}.set(cx-4,cy-3,1);${PE}.set(cx-3,cy-3,1);${PE}.set(cx+3,cy-3,1);${PE}.set(cx+4,cy-3,1);${m}})();\n`;
};

J['disp_pixel_on'] = (b)=>`${PE}.set(${v(b,'X','0')},${v(b,'Y','0')},1);\n`;
J['disp_pixel_off'] = (b)=>`${PE}.set(${v(b,'X','0')},${v(b,'Y','0')},0);\n`;
J['disp_pixel_get'] = (b)=>[`!!${PE}.get(${v(b,'X','0')},${v(b,'Y','0')})`,J.ORDER_FUNCTION_CALL];
J['disp_line'] = (b)=>`${PE}.line(${v(b,'X1','0')},${v(b,'Y1','0')},${v(b,'X2','127')},${v(b,'Y2','63')},1);\n`;
J['disp_rect'] = (b)=>`${PE}.rect(${v(b,'X','0')},${v(b,'Y','0')},${v(b,'W','10')},${v(b,'H','10')},1,${b.getFieldValue('FILL')==='1'?'true':'false'});\n`;
J['disp_circle'] = (b)=>`${PE}.circle(${v(b,'CX','64')},${v(b,'CY','32')},${v(b,'R','10')},1,${b.getFieldValue('FILL')==='1'?'true':'false'});\n`;
J['disp_random_pixels'] = (b)=>`${PE}.randomPixels(${v(b,'N','10')});\n`;
J['disp_paint'] = (b)=>`${PE}.applyBitmap(${JSON.stringify(b.getFieldValue('GRID'))});\n`;

J['disp_anim_frame'] = (b)=>`(()=>{${PE}.applyBitmap(${JSON.stringify(b.getFieldValue('GRID'))});${PE}.saveFrame(${b.getFieldValue('IDX')});})();\n`;
J['disp_anim_save'] = (b)=>`${PE}.saveFrame(${b.getFieldValue('IDX')});\n`;
J['disp_anim_load'] = (b)=>`${PE}.loadFrame(${b.getFieldValue('IDX')});\n`;

// Копіюємо всі генератори в forBlock для нового Blockly API
Object.keys(J).forEach(k => { if(typeof J[k]==='function' && !J.forBlock[k]) J.forBlock[k]=J[k]; });
J['disp_anim_play'] = (b)=>{
  const f=b.getFieldValue('FROM'),t=b.getFieldValue('TO'),ms=v(b,'MS','200');
  return `(()=>{const PE=${PE},f=${f},t=${t};let cur=f;PE.startTick(${ms},async()=>{PE.loadFrame(cur);await PE.sendFrame();cur=f+((cur-f+1)%(t-f+1));});})();\n`;
};
J['disp_anim_stop'] = ()=>`${PE}.stopTick();\n`;

/* Ігровий цикл — ГОЛОВНЕ ВИПРАВЛЕННЯ */
J['game_loop'] = (b)=>{
  const ms=v(b,'MS','100');
  const body=J.statementToCode(b,'DO');
  return `${PE}.startTick(${ms},async()=>{\n${body}});\n`;
};
J['game_stop'] = ()=>`${PE}.stopTick();\n`;

/* Спрайти */
J['sprite_create'] = (b)=>`${PE}.spriteSet(${v(b,'ID','1')},${v(b,'X','0')},${v(b,'Y','0')},${v(b,'W','8')},${v(b,'H','8')});\n`;
J['sprite_move'] = (b)=>`${PE}.spriteMove(${v(b,'ID','1')},${v(b,'DX','0')},${v(b,'DY','0')});\n`;
J['sprite_setpos'] = (b)=>{const id=v(b,'ID','1');return `(()=>{const s=${PE}.getSprite(${id});if(s){s.x=${v(b,'X','0')}|0;s.y=${v(b,'Y','0')}|0;}})();\n`;};
J['sprite_getx'] = (b)=>[`((${PE}.getSprite(${v(b,'ID','1')})||{x:0}).x)`,J.ORDER_FUNCTION_CALL];
J['sprite_gety'] = (b)=>[`((${PE}.getSprite(${v(b,'ID','1')})||{y:0}).y)`,J.ORDER_FUNCTION_CALL];
J['sprite_collide'] = (b)=>[`${PE}.spriteCollide(${v(b,'A','1')},${v(b,'B','2')})`,J.ORDER_FUNCTION_CALL];
J['sprite_edge'] = (b)=>[`${PE}.spriteEdge(${v(b,'ID','1')})`,J.ORDER_FUNCTION_CALL];
J['sprite_draw'] = (b)=>`(()=>{const s=${PE}.getSprite(${v(b,'ID','1')});if(s)for(let r=0;r<s.h;r++)for(let c=0;c<s.w;c++)${PE}.set(s.x+c,s.y+r,1);})();\n`;
J['sprite_erase'] = (b)=>`(()=>{const s=${PE}.getSprite(${v(b,'ID','1')});if(s)for(let r=0;r<s.h;r++)for(let c=0;c<s.w;c++)${PE}.set(s.x+c,s.y+r,0);})();\n`;

/* Джойстик */
J['game_joy_is'] = (b)=>[`(${PE}.joyDir()==='${b.getFieldValue('DIR')}')`,J.ORDER_EQUALITY];
J['game_joy_dir'] = ()=>[`${PE}.joyDir()`,J.ORDER_FUNCTION_CALL];
J['game_joy_axis'] = (b)=>[`${PE}.joyAxis('${b.getFieldValue('AXIS')}')`,J.ORDER_FUNCTION_CALL];

/* Рахунок */
J['game_score_add'] = (b)=>`${PE}.score(${v(b,'VAL','1')});\n`;
J['game_score_get'] = ()=>[`${PE}.getScore()`,J.ORDER_FUNCTION_CALL];
J['game_score_reset'] = ()=>`${PE}.resetScore();\n`;

/* Утиліти */
J['game_random'] = (b)=>[`(Math.floor(Math.random()*(${v(b,'MAX','127')}-${v(b,'MIN','0')}+1))+(${v(b,'MIN','0')}))`,J.ORDER_ADDITION];
J['game_clamp'] = (b)=>[`Math.max(${v(b,'MIN','0')},Math.min(${v(b,'MAX','127')},${v(b,'VAL','0')}))`,J.ORDER_FUNCTION_CALL];


/* ================================================================
   БЛОКИ КОНВЕРТАЦІЇ СИСТЕМ ЧИСЛЕННЯ
   Логіка: один блок "конвертувати" з вибором системи
   + окремі прості блоки читання
   ================================================================ */

Blockly.defineBlocksWithJsonArray([

  /* ── Головний блок: конвертувати число ──
     Вводиш текст (напр. "1010"), вибираєш "з BIN" і "в DEC"
     Повертає рядок результату */
  { "type":"num_convert",
    "message0":"конвертувати %1 з %2 в %3",
    "args0":[
      {"type":"field_input","name":"VAL","text":"1010"},
      {"type":"field_dropdown","name":"FROM","options":[
        ["BIN (двійк.)","BIN"],
        ["DEC (десятк.)","DEC"],
        ["HEX (шістн.)","HEX"]
      ]},
      {"type":"field_dropdown","name":"TO","options":[
        ["DEC (десятк.)","DEC"],
        ["BIN (двійк.)","BIN"],
        ["HEX (шістн.)","HEX"]
      ]}
    ],
    "output":null,"colour":"#0891b2","inputsInline":true,
    "tooltip":"Вводиш число в одній системі — отримуєш в іншій. Напр: 1010 BIN→DEC = 10" },

  /* ── Читання числа у різних системах (для підстановки) ── */
  { "type":"num_from_bin",
    "message0":"BIN → DEC  %1",
    "args0":[{"type":"field_input","name":"VAL","text":"1010"}],
    "output":"Number","colour":"#0891b2",
    "tooltip":"Двійкове число → десяткове. Напр: 1010 → 10" },

  { "type":"num_from_hex",
    "message0":"HEX → DEC  %1",
    "args0":[{"type":"field_input","name":"VAL","text":"FF"}],
    "output":"Number","colour":"#0891b2",
    "tooltip":"Шістнадцяткове → десяткове. Напр: FF → 255" },

  { "type":"num_to_bin",
    "message0":"DEC %1 → BIN",
    "args0":[{"type":"input_value","name":"VAL","check":"Number"}],
    "output":"String","colour":"#0891b2","inputsInline":true,
    "tooltip":"Десяткове число → двійковий рядок. Напр: 10 → \"1010\"" },

  { "type":"num_to_hex",
    "message0":"DEC %1 → HEX",
    "args0":[{"type":"input_value","name":"VAL","check":"Number"}],
    "output":"String","colour":"#0891b2","inputsInline":true,
    "tooltip":"Десяткове число → шістн. рядок. Напр: 255 → \"FF\"" },

  /* ── Показати на OLED ── */
  { "type":"num_show_convert",
    "message0":"📟 показати на екрані: %1 з %2 в %3",
    "args0":[
      {"type":"field_input","name":"VAL","text":"1010"},
      {"type":"field_dropdown","name":"FROM","options":[["BIN","BIN"],["DEC","DEC"],["HEX","HEX"]]},
      {"type":"field_dropdown","name":"TO",  "options":[["DEC","DEC"],["BIN","BIN"],["HEX","HEX"]]}
    ],
    "previousStatement":null,"nextStatement":null,"colour":"#0891b2","inputsInline":true,
    "tooltip":"Виводить на OLED: вхідне значення зверху і результат конвертації знизу" },

  { "type":"num_show_big",
    "message0":"📟 показати число %1",
    "args0":[{"type":"input_value","name":"VAL","check":"Number"}],
    "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#0891b2" ,"tooltip":"\u0412\u0435\u043b\u0438\u043a\u0435 \u0447\u0438\u0441\u043b\u043e \u043f\u043e \u0446\u0435\u043d\u0442\u0440\u0443 OLED"}
]);

/* JS Generators */
const _J = Blockly.JavaScript;
const _vC = (b,n,d) => _J.valueToCode(b,n,_J.ORDER_ATOMIC)||d;
const _bases = {BIN:2, DEC:10, HEX:16};

_J['num_convert'] = b => {
  const raw = JSON.stringify(b.getFieldValue('VAL')||'0');
  const from = b.getFieldValue('FROM'), to = b.getFieldValue('TO');
  const bf = _bases[from], bt = _bases[to];
  const toStr = bt===2?'.toString(2)': bt===16?'.toString(16).toUpperCase()':'String';
  if(bt===10) return [`String(parseInt(${raw},${bf}))`, _J.ORDER_FUNCTION_CALL];
  return [`parseInt(${raw},${bf}).${toStr==='String'?'toString()':toStr.slice(1)}`, _J.ORDER_FUNCTION_CALL];
};

_J['num_from_bin'] = b => {
  const s = JSON.stringify(b.getFieldValue('VAL')||'0');
  return [`parseInt(${s},2)`, _J.ORDER_FUNCTION_CALL];
};
_J['num_from_hex'] = b => {
  const s = JSON.stringify(b.getFieldValue('VAL')||'0');
  return [`parseInt(${s},16)`, _J.ORDER_FUNCTION_CALL];
};
_J['num_to_bin'] = b => [`(${_vC(b,'VAL','0')}>>>0).toString(2)`, _J.ORDER_FUNCTION_CALL];
_J['num_to_hex'] = b => [`(${_vC(b,'VAL','0')}>>>0).toString(16).toUpperCase()`, _J.ORDER_FUNCTION_CALL];

_J['num_show_convert'] = b => {
  const raw  = JSON.stringify(b.getFieldValue('VAL')||'0');
  const from = b.getFieldValue('FROM'), to = b.getFieldValue('TO');
  const bf = _bases[from], bt = _bases[to];
  const toStr = bt===2?'.toString(2)': bt===16?'.toString(16).toUpperCase()':'.toString()';
  return `(()=>{
  const PE=window.PixelEngine, raw=${raw};
  const dec=parseInt(raw,${bf}), result=dec${toStr};
  PE.clear();
  PE.drawText('${from}:'+raw, 0, 0, 1);
  PE.drawText('->', 0, 12, 1);
  PE.drawText('${to}:'+result, 0, 24, 1);
  await PE.sendFrame();
})();
`;
};

_J['num_show_big'] = b => {
  const val = _vC(b,'VAL','0');
  return `(()=>{\nconst PE=window.PixelEngine;\nPE.clear();\nPE.drawText(String(Math.round(${val})),0,20,1);\nawait PE.sendFrame();\n})();\n`;
};

/* ================================================================
   БЛОК БАТАРЕЇ — дисплейний (аналогічно sensor_display)
   ================================================================ */
Blockly.Blocks['sensor_bat_display'] = {
    init: function() {
        this.appendDummyInput()
            .appendField('🔋 Батарея')
            .appendField('  %:')
            .appendField('--', 'PCT');
        this.setColour('#0f766e');
        this.setDeletable(true);
        this.setMovable(true);
        this.setTooltip('Показує поточний заряд акумулятора у відсотках.');
    }
};
Blockly.JavaScript['sensor_bat_display'] = () => '';

/* Оновлення поля блока при отриманні даних */
window._updateBatDisplayBlocks = function() {
    try {
        if (!window.workspace) return;
        const pct = window._batPct != null ? window._batPct + '%' : '--%';
        const blocks = workspace.getBlocksByType
            ? workspace.getBlocksByType('sensor_bat_display', false)
            : (workspace.getAllBlocks(false)||[]).filter(b=>b&&b.type==='sensor_bat_display');
        for (const b of blocks) {
            try { b.setFieldValue(pct, 'PCT'); } catch(e) {}
        }
    } catch(e) {}
};
