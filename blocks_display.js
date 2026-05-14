// @ts-nocheck
/* ================================================================
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
            this._isTouch=navigator.maxTouchPoints>0&&window.matchMedia('(pointer:coarse)').matches;
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
                ctx.strokeStyle='#ef4444';ctx.lineWidth=3;ctx.strokeRect(rX+1,rY+1,rW-2,rH-2);
                ctx.strokeStyle='rgba(239,68,68,0.45)';ctx.lineWidth=1;
                [1,2].forEach(i=>{ctx.beginPath();ctx.moveTo(rX+rW*i/3,rY);ctx.lineTo(rX+rW*i/3,rY+rH);ctx.stroke();ctx.beginPath();ctx.moveTo(rX,rY+rH*i/3);ctx.lineTo(rX+rW,rY+rH*i/3);ctx.stroke();});
                ctx.fillStyle='rgba(239,68,68,0.9)';ctx.fillRect(rX,rY,70,16);ctx.fillStyle='#fff';ctx.font='10px monospace';ctx.fillText(aW+'x'+aH,rX+3,rY+11);
                ctx.fillStyle='#ef4444';ctx.fillRect(rX+rW-HND,rY+rH-HND,HND,HND);
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
   INLINE OLED PAINTER — compact one-block UI patch
   Перенесено поверх базового FieldPaintGrid.
   - малювання тільки при затиснутій мишці/пальці
   - менші рамки/поля
   - палітра як частина Blockly-блока зліва
   - компактний toolbox preview
   ================================================================ */
(function(){
  if (window.__rbInlineOledPainterCompactPatch) return;
  window.__rbInlineOledPainterCompactPatch = true;
  if (typeof FieldPaintGrid === 'undefined') return;

  const CSS_ID = 'rb-inline-oled-compact-css';
  const BLUE = '#2563eb';

  const ICON = {
    bucket:'<svg viewBox="0 0 24 24"><path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 2-3.5 2-3.5s2 1.9 2 3.5Z"/></svg>',
    shapes:'<svg viewBox="0 0 24 24"><path d="M8.3 10.3a4 4 0 1 1 5.4-5.9 4 4 0 0 1-5.4 5.9Z"/><path d="M7 14h7v7H7z"/><path d="m17.5 13 4.5 8h-9z"/></svg>',
    circle:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>',
    heart:'<svg viewBox="0 0 24 24"><path d="M19.5 12.6 12 20l-7.5-7.4a5 5 0 0 1 7.1-7.1l.4.4.4-.4a5 5 0 1 1 7.1 7.1Z"/></svg>',
    square:'<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>',
    flip:'<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M12 3v18"/></svg>',
    right:'<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
    left:'<svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m11 6-6 6 6 6"/></svg>',
    down:'<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="m18 13-6 6-6-6"/></svg>',
    up:'<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
    moon:'<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 7.4A9 9 0 1 1 12 3Z"/></svg>',
    trash:'<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    undo:'<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-1"/></svg>',
    redo:'<svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h1"/></svg>',
    camera:'<svg viewBox="0 0 24 24"><path d="M14.5 4 16 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-3z"/><circle cx="12" cy="13" r="3"/></svg>',
    check:'<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'
  };

  function injectCss(){
    if(document.getElementById(CSS_ID)) return;
    const st=document.createElement('style');
    st.id=CSS_ID;
    st.textContent = `
.rb-oled-editor{width:936px;height:438px;background:#1e293b;border:1px solid #334155;border-radius:10px;display:flex;flex-direction:column;gap:6px;padding:6px;box-sizing:border-box;color:#e2e8f0;font-family:Arial,system-ui,sans-serif;touch-action:none;user-select:none;overflow:visible}
.rb-oled-top{height:344px;display:flex;gap:8px;min-height:0}
.rb-oled-canvasBox{flex:1;min-width:0;position:relative;background:#0b1326;border:1px solid #334155;border-radius:8px;overflow:hidden}
.rb-oled-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair}
.rb-oled-resPanel{width:62px;flex:0 0 auto;background:#1b2638;border:1px solid #334155;border-radius:10px;padding:6px;display:flex;flex-direction:column;gap:7px}
.rb-oled-resBtn{flex:1;border:0;border-radius:7px;background:#0f172a;color:#9ca3af;font-weight:800;cursor:pointer}
.rb-oled-resBtn b{display:block;font-size:12px;line-height:1.1}
.rb-oled-resBtn span{display:block;font-size:8px;opacity:.8;margin-top:3px}
.rb-oled-resBtn.active{background:#2563eb;color:white}
.rb-oled-tools{height:64px;background:#08101e;border:1px solid #334155;border-radius:9px;padding:8px;display:flex;align-items:center;gap:8px;overflow:visible;position:relative}
.rb-oled-group{height:42px;background:#1e293b;border-radius:8px;padding:5px;display:flex;align-items:center;gap:4px;position:relative;flex:0 0 auto}
.rb-oled-group.push{margin-left:auto}
.rb-oled-btn{height:32px;min-width:32px;border:0;border-radius:7px;background:transparent;color:#cbd5e1;display:flex;align-items:center;justify-content:center;gap:6px;font-size:12px;font-weight:800;padding:0 8px;cursor:pointer;white-space:nowrap}
.rb-oled-btn:hover{background:#334155;color:#fff}
.rb-oled-btn.active{background:#373f78;color:#c7d2fe}
.rb-oled-btn.primary{background:#2563eb;color:#fff;padding:0 13px}
.rb-oled-btn.photo{border:1px solid #334155;background:rgba(15,23,42,.42);padding:0 12px}
.rb-oled-btn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.rb-oled-sep{height:22px;width:1px;background:#334155;margin:0 4px}
.rb-oled-drop{position:relative}
.rb-oled-menu{position:absolute;left:0;bottom:calc(100% + 8px);background:#1e293b;border:1px solid #334155;border-radius:10px;padding:6px;display:none;gap:5px;box-shadow:0 18px 40px rgba(0,0,0,.35);z-index:10}
.rb-oled-drop.open .rb-oled-menu{display:flex}
.rb-oled-toolboxMini{width:210px;height:46px;display:flex;align-items:center;gap:10px;color:white;font:bold 16px Arial,system-ui,sans-serif}
.rb-oled-toolboxMini .ico{font-size:20px}
`;
    document.head.appendChild(st);
  }

  function isFlyoutField(field){
    const sb=field&&field.sourceBlock_;
    try{
      if(!sb) return false;
      if(typeof sb.isInFlyout==='function') return !!sb.isInFlyout();
      if(typeof sb.isInFlyout==='boolean') return !!sb.isInFlyout;
      if(sb.workspace && sb.workspace.isFlyout) return true;
      if(sb.workspace && sb.workspace.targetWorkspace) return true;
    }catch(_){}
    return false;
  }

  function dims(scale){
    const s=scale||4;
    return {cols:Math.max(1,Math.floor(128/s)), rows:Math.max(1,Math.floor(64/s))};
  }

  function ser(field){
    const bits=Array.prototype.map.call(field.pixels||[], v=>v?'1':'0').join('');
    return (field.scale||4)+'|'+bits;
  }

  function setPixels(field, next, scale){
    const d=dims(scale||field.scale||4);
    field.scale=scale||field.scale||4;
    field.cols=d.cols; field.rows=d.rows;
    field.pixels=new Uint8Array(d.cols*d.rows);
    for(let i=0;i<field.pixels.length;i++) field.pixels[i]=next[i]?1:0;
    field.value_=field._ser ? field._ser() : ser(field);
    try{ if(field.sourceBlock_ && field.sourceBlock_.type==='disp_anim_frame') field.sourceBlock_._rbFrameCacheDirty=true; }catch(_){}
  }

  function mapPixels(px, oldScale, newScale){
    const od=dims(oldScale), nd=dims(newScale);
    const out=new Array(nd.cols*nd.rows).fill(0);
    px=Array.prototype.slice.call(px||[]);
    for(let r=0;r<nd.rows;r++) for(let c=0;c<nd.cols;c++){
      const or=Math.floor(r*od.rows/nd.rows), oc=Math.floor(c*od.cols/nd.cols);
      out[r*nd.cols+c]=px[or*od.cols+oc]?1:0;
    }
    return out;
  }

  function template(px, scale, type){
    const d=dims(scale), out=px.slice(), C=d.cols, R=d.rows, cx=C/2, cy=R/2;
    let inside=()=>false;
    if(type==='circle'){
      const rr=Math.max(1,Math.min(cx,cy)-2);
      inside=(x,y)=>Math.pow(x-cx+.5,2)+Math.pow(y-cy+.5,2)<=rr*rr;
    }else if(type==='square'){
      const rr=Math.max(1,Math.min(cx,cy)-2);
      inside=(x,y)=>Math.abs(x-cx+.5)<=rr && Math.abs(y-cy+.5)<=rr;
    }else if(type==='heart'){
      const rr=Math.max(1,Math.min(cx,cy)*.82);
      inside=(x,y)=>{const nx=(x-cx+.5)/rr, ny=-(y-cy+.5)/rr+.22; return Math.pow(nx*nx+ny*ny-1,3)-nx*nx*Math.pow(ny,3)<=0;};
    }
    for(let y=0;y<R;y++) for(let x=0;x<C;x++){
      if(!inside(x,y)) continue;
      if(!inside(x+1,y)||!inside(x-1,y)||!inside(x,y+1)||!inside(x,y-1)) out[y*C+x]=1;
    }
    return out;
  }

  function mirror(px, scale, dir){
    const d=dims(scale), C=d.cols, R=d.rows, out=px.slice(), hC=Math.floor(C/2), hR=Math.floor(R/2);
    const get=(x,y)=>px[y*C+x], set=(x,y,v)=>{out[y*C+x]=v?1:0;};
    if(dir==='L2R') for(let y=0;y<R;y++) for(let x=0;x<hC;x++) set(C-1-x,y,get(x,y));
    if(dir==='R2L') for(let y=0;y<R;y++) for(let x=0;x<hC;x++) set(x,y,get(C-1-x,y));
    if(dir==='T2B') for(let y=0;y<hR;y++) for(let x=0;x<C;x++) set(x,R-1-y,get(x,y));
    if(dir==='B2T') for(let y=0;y<hR;y++) for(let x=0;x<C;x++) set(x,y,get(x,R-1-y));
    return out;
  }

  function buildEditor(field){
    const root=document.createElement('div');
    root.className='rb-oled-editor';
    root.innerHTML=`
      <div class="rb-oled-top">
        <div class="rb-oled-canvasBox"><canvas class="rb-oled-canvas"></canvas></div>
        <div class="rb-oled-resPanel">
          <button class="rb-oled-resBtn" data-scale="1"><b>1:1</b><span>128×64</span></button>
          <button class="rb-oled-resBtn" data-scale="2"><b>2:1</b><span>64×32</span></button>
          <button class="rb-oled-resBtn" data-scale="4"><b>4:1</b><span>32×16</span></button>
          <button class="rb-oled-resBtn" data-scale="8"><b>8:1</b><span>16×8</span></button>
        </div>
      </div>
      <div class="rb-oled-tools">
        <div class="rb-oled-group">
          <button class="rb-oled-btn active" data-act="brush">1</button>
          <button class="rb-oled-btn" data-act="fill" title="Заливка">${ICON.bucket}</button>
          <div class="rb-oled-sep"></div>
          <div class="rb-oled-drop" data-drop="shapes">
            <button class="rb-oled-btn" data-act="shapes" title="Макети">${ICON.shapes}</button>
            <div class="rb-oled-menu">
              <button class="rb-oled-btn" data-act="circle" title="Коло">${ICON.circle}</button>
              <button class="rb-oled-btn" data-act="heart" title="Серце">${ICON.heart}</button>
              <button class="rb-oled-btn" data-act="square" title="Квадрат">${ICON.square}</button>
            </div>
          </div>
          <div class="rb-oled-drop" data-drop="mirror">
            <button class="rb-oled-btn" data-act="mirror" title="Віддзеркалити">${ICON.flip}</button>
            <div class="rb-oled-menu">
              <button class="rb-oled-btn" data-act="L2R" title="Ліву → Праву">${ICON.right}</button>
              <button class="rb-oled-btn" data-act="R2L" title="Праву → Ліву">${ICON.left}</button>
              <button class="rb-oled-btn" data-act="T2B" title="Верх → Низ">${ICON.down}</button>
              <button class="rb-oled-btn" data-act="B2T" title="Низ → Верх">${ICON.up}</button>
            </div>
          </div>
          <button class="rb-oled-btn" data-act="invert" title="Інверсія">${ICON.moon}</button>
          <button class="rb-oled-btn" data-act="clear" title="Очистити">${ICON.trash}</button>
        </div>
        <div class="rb-oled-group">
          <button class="rb-oled-btn" data-act="undo" title="Скасувати">${ICON.undo}</button>
          <button class="rb-oled-btn" data-act="redo" title="Повторити">${ICON.redo}</button>
        </div>
        <div class="rb-oled-group push">
          <button class="rb-oled-btn photo" data-act="photo" title="Фото">${ICON.camera}<span>Фото</span></button>
          <button class="rb-oled-btn primary" data-act="pixels" title="У пікселі">${ICON.check}<span>У пікселі</span></button>
        </div>
      </div>`;
    return root;
  }

  function bindEditor(root, field){
    const cv=root.querySelector('.rb-oled-canvas');
    const ctx=cv.getContext('2d');
    const brushBtn=root.querySelector('[data-act="brush"]');
    let scale=field.scale||4;
    let brush=field.brush||1;
    let drawing=false;
    let erase=false;
    let history=[], future=[];
    let lastIdx=-1;

    function pixels(){ return Array.prototype.slice.call(field.pixels||[]); }
    function remember(){ history.push(pixels()); if(history.length>50) history.shift(); future=[]; }
    function commit(next, sc){ setPixels(field,next,sc||scale); scale=field.scale; draw(); }
    function closeMenus(){ root.querySelectorAll('.rb-oled-drop').forEach(d=>d.classList.remove('open')); }

    function resizeCanvas(){
      const r=cv.getBoundingClientRect();
      const w=Math.max(100,Math.round(r.width));
      const h=Math.max(80,Math.round(r.height));
      if(cv.width!==w || cv.height!==h){ cv.width=w; cv.height=h; }
    }

    function draw(){
      resizeCanvas();
      const d=dims(scale);
      const W=cv.width, H=cv.height, pw=W/d.cols, ph=H/d.rows;
      ctx.fillStyle='#0b1326';
      ctx.fillRect(0,0,W,H);

      const onion=field._onion || null;
      if(onion){
        ctx.fillStyle='#263a68';
        for(let i=0;i<Math.min(onion.length,d.cols*d.rows);i++){
          if(!onion[i] || field.pixels[i]) continue;
          const x=(i%d.cols)*pw, y=Math.floor(i/d.cols)*ph;
          ctx.fillRect(x,y,pw,ph);
        }
      }

      ctx.fillStyle='#9aa5ff';
      for(let i=0;i<d.cols*d.rows;i++){
        if(!field.pixels[i]) continue;
        const x=(i%d.cols)*pw, y=Math.floor(i/d.cols)*ph;
        ctx.fillRect(x,y,pw,ph);
      }

      ctx.strokeStyle='rgba(99,102,241,.18)';
      ctx.lineWidth=1;
      ctx.beginPath();
      for(let c=0;c<=d.cols;c++){ const x=Math.round(c*pw)+0.5; ctx.moveTo(x,0); ctx.lineTo(x,H); }
      for(let r=0;r<=d.rows;r++){ const y=Math.round(r*ph)+0.5; ctx.moveTo(0,y); ctx.lineTo(W,y); }
      ctx.stroke();

      root.querySelectorAll('.rb-oled-resBtn').forEach(b=>b.classList.toggle('active', Number(b.dataset.scale)===scale));
      brushBtn.textContent=String(brush);
    }

    function eventIndex(e){
      const d=dims(scale);
      const r=cv.getBoundingClientRect();
      const p=e.touches ? e.touches[0] : e;
      const x=p.clientX-r.left, y=p.clientY-r.top;
      if(x<0||y<0||x>=r.width||y>=r.height) return -1;
      const col=Math.floor(x/r.width*d.cols);
      const row=Math.floor(y/r.height*d.rows);
      return row*d.cols+col;
    }

    function paint(idx){
      if(idx<0 || idx===lastIdx) return;
      lastIdx=idx;
      const d=dims(scale), next=pixels();
      const c0=idx%d.cols, r0=Math.floor(idx/d.cols);
      const val=erase?0:1;
      for(let dy=0;dy<brush;dy++) for(let dx=0;dx<brush;dx++){
        const c=c0+dx, r=r0+dy;
        if(c>=0&&c<d.cols&&r>=0&&r<d.rows) next[r*d.cols+c]=val;
      }
      commit(next,scale);
    }

    function startDraw(e){
      if(e.button!==undefined && e.button!==0) return;
      e.preventDefault(); e.stopPropagation();
      try{ const ws=window.workspace||Blockly.getMainWorkspace(); const gg=ws&&ws.currentGesture_; if(gg)gg.cancel(); }catch(_){}
      const idx=eventIndex(e);
      if(idx<0) return;
      remember();
      drawing=true;
      lastIdx=-1;
      erase=!!field.pixels[idx];
      paint(idx);
      try{ cv.setPointerCapture && e.pointerId!==undefined && cv.setPointerCapture(e.pointerId); }catch(_){}
    }

    function moveDraw(e){
      if(!drawing) return;
      if(e.buttons!==undefined && e.buttons===0 && !e.touches){ drawing=false; return; }
      e.preventDefault(); e.stopPropagation();
      paint(eventIndex(e));
    }

    function stopDraw(){ drawing=false; lastIdx=-1; }

    cv.addEventListener('pointerdown', startDraw);
    cv.addEventListener('pointermove', moveDraw);
    cv.addEventListener('pointerup', stopDraw);
    cv.addEventListener('pointercancel', stopDraw);
    cv.addEventListener('pointerleave', e=>{ if(e.buttons===0) stopDraw(); });
    cv.addEventListener('mousedown', startDraw);
    cv.addEventListener('mousemove', moveDraw);
    window.addEventListener('mouseup', stopDraw);
    cv.addEventListener('touchstart', startDraw, {passive:false});
    cv.addEventListener('touchmove', moveDraw, {passive:false});
    cv.addEventListener('touchend', stopDraw, {passive:false});
    cv.addEventListener('touchcancel', stopDraw, {passive:false});

    root.querySelectorAll('.rb-oled-resBtn').forEach(b=>b.addEventListener('click',e=>{
      e.preventDefault(); e.stopPropagation();
      const ns=Number(b.dataset.scale);
      if(ns===scale) return;
      remember();
      commit(mapPixels(pixels(),scale,ns),ns);
      closeMenus();
    }));

    root.addEventListener('click', e=>{
      const btn=e.target.closest('[data-act]');
      if(!btn) { closeMenus(); return; }
      e.preventDefault(); e.stopPropagation();
      const act=btn.dataset.act;
      if(act==='brush'){
        const arr=[1,2,4,8]; brush=arr[(arr.indexOf(brush)+1)%arr.length]; field.brush=brush; draw();
      }else if(act==='fill'){
        remember(); commit(new Array(dims(scale).cols*dims(scale).rows).fill(1),scale); closeMenus();
      }else if(act==='shapes' || act==='mirror'){
        const drop=btn.closest('.rb-oled-drop');
        root.querySelectorAll('.rb-oled-drop').forEach(d=>{ if(d!==drop)d.classList.remove('open'); });
        drop.classList.toggle('open');
      }else if(['circle','heart','square'].includes(act)){
        remember(); commit(template(pixels(),scale,act),scale); closeMenus();
      }else if(['L2R','R2L','T2B','B2T'].includes(act)){
        remember(); commit(mirror(pixels(),scale,act),scale); closeMenus();
      }else if(act==='invert'){
        remember(); commit(pixels().map(v=>v?0:1),scale); closeMenus();
      }else if(act==='clear'){
        remember(); commit(new Array(dims(scale).cols*dims(scale).rows).fill(0),scale); closeMenus();
      }else if(act==='undo'){
        const prev=history.pop(); if(prev){ future.push(pixels()); commit(prev,scale); }
      }else if(act==='redo'){
        const nx=future.pop(); if(nx){ history.push(pixels()); commit(nx,scale); }
      }else if(act==='photo'){
        if(field._openCropModal) field._openCropModal();
        setTimeout(()=>{ try{ draw(); }catch(_){} },300);
      }else if(act==='pixels'){
        if(field._imgCropData && field._imgCropData.data){
          const d=dims(scale);
          const data=field._imgCropData.data, cw=field._imgCropData.cw||d.cols, ch=field._imgCropData.ch||d.rows;
          let next=null;
          if(window.rbConvertImageToOledPixels){
            const imgData={data:data};
            next=Array.from(window.rbConvertImageToOledPixels(imgData,cw,ch,field._imgCropData.options||{mode:'floyd',threshold:128,contrast:1.25,gamma:1}));
            if(cw!==d.cols || ch!==d.rows){
              const scaled=new Array(d.cols*d.rows).fill(0);
              for(let r=0;r<d.rows;r++)for(let c=0;c<d.cols;c++){
                const sx=Math.floor(c*cw/d.cols), sy=Math.floor(r*ch/d.rows);
                scaled[r*d.cols+c]=next[sy*cw+sx]?1:0;
              }
              next=scaled;
            }
          }else{
            next=new Array(d.cols*d.rows).fill(0);
            for(let r=0;r<d.rows;r++)for(let c=0;c<d.cols;c++){
              const sx=Math.floor(c*cw/d.cols), sy=Math.floor(r*ch/d.rows);
              const i4=(sy*cw+sx)*4;
              const br=data[i4]*.299+data[i4+1]*.587+data[i4+2]*.114;
              next[r*d.cols+c]=br<128?1:0;
            }
          }
          remember(); commit(next,scale);
        } else if(field._openCropModal) {
          field._openCropModal();
          setTimeout(()=>{ try{ draw(); }catch(_){} },300);
        }
      }
    });

    field._rbInlineRedraw = draw;
    setTimeout(draw,0);
    window.addEventListener('resize', draw);
  }

  const oldSetOnion = FieldPaintGrid.prototype.setOnionSkin;
  FieldPaintGrid.prototype.setOnionSkin = function(pixels){
    this._onion=pixels?new Uint8Array(pixels):null;
    if(this._rbInlineRedraw) this._rbInlineRedraw();
    else if(oldSetOnion) oldSetOnion.call(this,pixels);
  };

  const oldScale = FieldPaintGrid.prototype._scale;
  FieldPaintGrid.prototype._scale = function(s){
    const next=mapPixels(Array.prototype.slice.call(this.pixels||[]),this.scale||4,s);
    setPixels(this,next,s);
    if(this._rbInlineRedraw) this._rbInlineRedraw();
    else if(oldScale) oldScale.call(this,s);
  };

  FieldPaintGrid.prototype.getSize = function(){
    if(isFlyoutField(this)){ this.size_.width=220; this.size_.height=54; }
    else { this.size_.width=1000; this.size_.height=452; }
    return this.size_;
  };

  FieldPaintGrid.prototype._build = function(){
    injectCss();
    const g=this.fieldGroup_;
    while(g.firstChild) g.removeChild(g.firstChild);

    if(this.borderRect_){
      this.borderRect_.setAttribute('fill','none');
      this.borderRect_.setAttribute('stroke','none');
    }

    if(isFlyoutField(this)){
      this.size_.width=220; this.size_.height=54;
      const fo=document.createElementNS('http://www.w3.org/2000/svg','foreignObject');
      fo.setAttribute('x','0'); fo.setAttribute('y','0'); fo.setAttribute('width','220'); fo.setAttribute('height','54');
      const mini=document.createElement('div');
      mini.className='rb-oled-toolboxMini';
      mini.innerHTML='<span class="ico">🎨</span><span>Малювалка</span>';
      fo.appendChild(mini); g.appendChild(fo);
      return;
    }

    const W=936, H=438, X=56, Y=6;
    this.size_.width=1000;
    this.size_.height=452;

    const pal=document.createElementNS('http://www.w3.org/2000/svg','text');
    pal.setAttribute('x','28'); pal.setAttribute('y',String(Y+H/2));
    pal.setAttribute('font-size','27');
    pal.setAttribute('text-anchor','middle');
    pal.setAttribute('dominant-baseline','middle');
    pal.textContent='🎨';
    g.appendChild(pal);

    const fo=document.createElementNS('http://www.w3.org/2000/svg','foreignObject');
    fo.setAttribute('x',String(X)); fo.setAttribute('y',String(Y));
    fo.setAttribute('width',String(W)); fo.setAttribute('height',String(H+2));
    g.appendChild(fo);

    const root=buildEditor(this);
    fo.appendChild(root);

    ['mousedown','pointerdown','touchstart','mousemove','pointermove','dblclick','click'].forEach(ev=>{
      g.addEventListener(ev, e=>{ e.stopPropagation(); }, ev==='touchstart'?{passive:false}:false);
      root.addEventListener(ev, e=>{ e.stopPropagation(); }, ev==='touchstart'?{passive:false}:false);
    });

    bindEditor(root,this);
  };
})();




/* ================================================================
   PHOTO/VIDEO/ANIMATION FIXES for inline OLED painter
   ================================================================ */
(function(){
  if (window.__rbOledMediaAnimFix) return;
  window.__rbOledMediaAnimFix = true;
  if (typeof FieldPaintGrid === 'undefined') return;

  function dims(scale){
    const s=scale||4;
    return {cols:Math.max(1,Math.floor(128/s)), rows:Math.max(1,Math.floor(64/s))};
  }
  function parseVal(v){
    const scale=(v&&v.includes('|'))?parseInt(v.split('|')[0])||4:4;
    const d=dims(scale);
    const bits=(v&&v.includes('|'))?(v.split('|')[1]||''):'';
    const px=new Uint8Array(d.cols*d.rows);
    for(let i=0;i<Math.min(bits.length,px.length);i++) px[i]=bits[i]==='1'?1:0;
    return {scale, cols:d.cols, rows:d.rows, pixels:px};
  }
  function ser(scale,pixels){ return scale+'|'+Array.prototype.map.call(pixels||[],v=>v?'1':'0').join(''); }
  function setField(field, scale, pixels){
    const d=dims(scale);
    field.scale=scale; field.cols=d.cols; field.rows=d.rows;
    field.pixels=new Uint8Array(d.cols*d.rows);
    for(let i=0;i<field.pixels.length;i++) field.pixels[i]=pixels[i]?1:0;
    field.value_=field._ser ? field._ser() : ser(scale,field.pixels);
    if(field._rbInlineRedraw) field._rbInlineRedraw();
    else if(field._refreshAll) field._refreshAll();
  }
  function getWorkspace(){ try{return window.workspace || (window.Blockly&&Blockly.getMainWorkspace&&Blockly.getMainWorkspace());}catch(_){return null;} }
  function getFrameMap(ws){
    const map={};
    if(!ws||!ws.getAllBlocks) return map;
    ws.getAllBlocks(false).forEach(b=>{
      if(b.type==='disp_anim_frame'){
        const idx=parseInt(b.getFieldValue('IDX'));
        const f=b.getField('GRID');
        if(Number.isFinite(idx)&&f) map[idx]=f.getValue?f.getValue():b.getFieldValue('GRID');
      }
    });
    return map;
  }
  function setFrameVal(ws, idx, val){
    if(!ws||!ws.getAllBlocks) return false;
    let ok=false;
    ws.getAllBlocks(false).forEach(b=>{
      if(b.type==='disp_anim_frame' && parseInt(b.getFieldValue('IDX'))===idx){
        const f=b.getField('GRID'); if(f){ f.setValue(val); if(f._rbInlineRedraw) f._rbInlineRedraw(); ok=true; }
      }
    });
    return ok;
  }
  window.rbOledFrameStore = window.rbOledFrameStore || {};

  function updateOnionAndFrame(field){
    try{
      const b=field.sourceBlock_;
      if(!b || b.type!=='disp_anim_frame') return;
      const ws=b.workspace || getWorkspace();
      const cur=parseInt(b.getFieldValue('IDX'))||0;
      const map=getFrameMap(ws);
      Object.assign(window.rbOledFrameStore,map);

      const ownVal = map[cur] || window.rbOledFrameStore[cur];
      if(ownVal){
        const p=parseVal(ownVal);
        if(field.getValue && field.getValue() !== ownVal) setField(field,p.scale,p.pixels);
      } else {
        const d=dims(field.scale||4);
        const empty=(field.scale||4)+'|'+'0'.repeat(d.cols*d.rows);
        if(field.getValue && field.getValue() !== empty) setField(field,field.scale||4,new Uint8Array(d.cols*d.rows));
      }

      if(cur>0){
        const prevVal=map[cur-1] || window.rbOledFrameStore[cur-1];
        field.setOnionSkin(prevVal ? parseVal(prevVal).pixels : null);
      } else {
        field.setOnionSkin(null);
      }
    }catch(e){ console.warn('anim sync',e); }
  }

  const oldSetValue = FieldPaintGrid.prototype.setValue;
  FieldPaintGrid.prototype.setValue = function(v){
    if(oldSetValue) oldSetValue.call(this,v);
    else { this.value_=v||''; const p=parseVal(v); this.scale=p.scale; this.cols=p.cols; this.rows=p.rows; this.pixels=p.pixels; }
    if(this._rbInlineRedraw) setTimeout(()=>this._rbInlineRedraw(),0);
  };

  function installFrameDropdownSync(){
    if(!window.Blockly || !Blockly.FieldDropdown || Blockly.FieldDropdown.prototype.__rbOledFrameSync) return;
    Blockly.FieldDropdown.prototype.__rbOledFrameSync=true;
    const old=Blockly.FieldDropdown.prototype.setValue;
    Blockly.FieldDropdown.prototype.setValue=function(v){
      const block=this.sourceBlock_;
      if(block && block.type==='disp_anim_frame'){
        try{
          const oldIdx=parseInt(block.getFieldValue('IDX'));
          const gf=block.getField('GRID');
          if(Number.isFinite(oldIdx)&&gf) window.rbOledFrameStore[oldIdx]=gf.getValue ? gf.getValue() : block.getFieldValue('GRID');
        }catch(_){}
      }
      const r=old.call(this,v);
      if(block && block.type==='disp_anim_frame'){
        setTimeout(()=>{
          try{
            const gf=block.getField('GRID');
            if(gf) updateOnionAndFrame(gf);
          }catch(_){}
        },0);
      }
      return r;
    };
  }
  installFrameDropdownSync();
  setTimeout(installFrameDropdownSync,500);

  // Better cropper: red frame, crop data is applied directly to inline editor.
  FieldPaintGrid.prototype._openCropModal = function(){
    const self=this;
    let inp=document.getElementById('_pgFileInput');
    if(!inp){
      inp=document.createElement('input');
      inp.type='file'; inp.accept='image/*'; inp.id='_pgFileInput';
      inp.style.cssText='position:fixed;opacity:0;pointer-events:none;top:0;left:0';
      document.body.appendChild(inp);
    }
    inp.value='';
    inp.onchange=e=>{
      const f=e.target.files && e.target.files[0];
      if(!f) return;
      const r=new FileReader();
      r.onload=ev=>self._showCropper(ev.target.result);
      r.readAsDataURL(f);
    };
    inp.click();
  };

  FieldPaintGrid.prototype._showCropper = function(dataUrl){
    const self=this;
    const aW=this.cols||32, aH=this.rows||16;
    let modal=document.getElementById('_pgCropModal'); if(modal) modal.remove();
    modal=document.createElement('div'); modal.id='_pgCropModal';
    modal.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.86);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;box-sizing:border-box';
    modal.innerHTML='<div style="color:#fecaca;font:700 14px Arial">Вибери область фото</div><div style="color:#94a3b8;font:11px Arial;margin-top:-8px">Червона рамка = межі OLED '+aW+'×'+aH+'</div>';
    const wrap=document.createElement('div'); wrap.style.cssText='position:relative;touch-action:none';
    const canvas=document.createElement('canvas'); canvas.style.cssText='display:block;max-width:min(92vw,720px);max-height:56vh;border-radius:8px;background:#0f172a';
    wrap.appendChild(canvas); modal.appendChild(wrap);

    const row=document.createElement('div'); row.style.cssText='display:flex;align-items:center;gap:10px;width:min(92vw,720px)';
    row.innerHTML='<span style="color:#94a3b8;font:11px Arial;white-space:nowrap">Поріг:</span>';
    const slider=document.createElement('input'); slider.type='range'; slider.min=0; slider.max=255; slider.value=128; slider.style.cssText='flex:1;accent-color:#ef4444';
    const val=document.createElement('span'); val.textContent='128'; val.style.cssText='color:#fecaca;font:11px monospace;min-width:30px';
    slider.oninput=()=>val.textContent=slider.value;
    row.appendChild(slider); row.appendChild(val); modal.appendChild(row);

    const btns=document.createElement('div'); btns.style.cssText='display:flex;gap:10px';
    function btn(t,bg,fn){ const x=document.createElement('button'); x.textContent=t; x.style.cssText='padding:9px 18px;background:'+bg+';color:white;border:0;border-radius:8px;font:700 13px Arial;cursor:pointer'; x.onclick=fn; return x; }
    const cancel=btn('Скасувати','#374151',()=>modal.remove());
    const overlay=btn('👁 Накласти','#2563eb',()=>{});
    const convert=btn('✓ У пікселі','#059669',()=>{});
    btns.append(cancel,overlay,convert); modal.appendChild(btns); document.body.appendChild(modal);

    const img=new Image();
    img.onload=()=>{
      const maxW=Math.min(720,window.innerWidth*.92), maxH=Math.min(460,window.innerHeight*.56);
      let cW=img.width,cH=img.height;
      if(cW>maxW){cH=cH*maxW/cW;cW=maxW;}
      if(cH>maxH){cW=cW*maxH/cH;cH=maxH;}
      cW=Math.round(cW); cH=Math.round(cH);
      canvas.width=cW; canvas.height=cH; canvas.style.width=cW+'px'; canvas.style.height=cH+'px';
      const ctx=canvas.getContext('2d');
      const asp=aW/aH;
      let rW,rH;
      if(cW/cH>asp){ rH=cH*.82; rW=rH*asp; } else { rW=cW*.82; rH=rW/asp; }
      rW=Math.round(rW); rH=Math.round(rH);
      let rX=Math.round((cW-rW)/2), rY=Math.round((cH-rH)/2);
      let drag=false, resize=false, sx=0, sy=0, ox=0, oy=0;
      const HND=18;
      function draw(){
        ctx.clearRect(0,0,cW,cH); ctx.drawImage(img,0,0,cW,cH);
        ctx.fillStyle='rgba(0,0,0,.55)';
        ctx.fillRect(0,0,cW,rY); ctx.fillRect(0,rY+rH,cW,cH-rY-rH); ctx.fillRect(0,rY,rX,rH); ctx.fillRect(rX+rW,rY,cW-rX-rW,rH);
        ctx.strokeStyle='#ef4444'; ctx.lineWidth=3; ctx.strokeRect(rX+1.5,rY+1.5,rW-3,rH-3);
        ctx.strokeStyle='rgba(239,68,68,.45)'; ctx.lineWidth=1;
        [1,2].forEach(i=>{ ctx.beginPath(); ctx.moveTo(rX+rW*i/3,rY); ctx.lineTo(rX+rW*i/3,rY+rH); ctx.stroke(); ctx.beginPath(); ctx.moveTo(rX,rY+rH*i/3); ctx.lineTo(rX+rW,rY+rH*i/3); ctx.stroke(); });
        ctx.fillStyle='#ef4444'; ctx.fillRect(rX+rW-HND,rY+rH-HND,HND,HND);
        ctx.fillStyle='rgba(239,68,68,.92)'; ctx.fillRect(rX,rY,74,18); ctx.fillStyle='white'; ctx.font='11px monospace'; ctx.fillText(aW+'×'+aH,rX+5,rY+13);
      }
      function pos(e){ const rr=canvas.getBoundingClientRect(), p=e.touches?e.touches[0]:e; return {x:p.clientX-rr.left,y:p.clientY-rr.top}; }
      function onD(e){ e.preventDefault(); const p=pos(e); if(p.x>=rX+rW-HND&&p.x<=rX+rW&&p.y>=rY+rH-HND&&p.y<=rY+rH){resize=true;} else if(p.x>=rX&&p.x<=rX+rW&&p.y>=rY&&p.y<=rY+rH){drag=true;sx=p.x;sy=p.y;ox=rX;oy=rY;} }
      function onM(e){ if(!drag&&!resize) return; e.preventDefault(); const p=pos(e); if(drag){rX=Math.max(0,Math.min(cW-rW,ox+p.x-sx));rY=Math.max(0,Math.min(cH-rH,oy+p.y-sy));} else {let nW=Math.max(24,p.x-rX),nH=Math.max(12,p.y-rY); if(nW/nH>asp)nH=nW/asp;else nW=nH*asp; rW=Math.min(Math.round(nW),cW-rX); rH=Math.min(Math.round(rW/asp),cH-rY); rW=Math.round(rH*asp);} draw(); }
      function onU(){drag=false;resize=false;}
      canvas.addEventListener('mousedown',onD); window.addEventListener('mousemove',onM); window.addEventListener('mouseup',onU);
      canvas.addEventListener('touchstart',onD,{passive:false}); canvas.addEventListener('touchmove',onM,{passive:false}); canvas.addEventListener('touchend',onU,{passive:false});

      function cropImageData(){
        const off=document.createElement('canvas'); off.width=aW; off.height=aH;
        const oc=off.getContext('2d'); const sx=img.width/cW, sy=img.height/cH;
        oc.drawImage(img,rX*sx,rY*sy,rW*sx,rH*sy,0,0,aW,aH);
        return {data:oc.getImageData(0,0,aW,aH), url:off.toDataURL()};
      }
      overlay.onclick=()=>{ const c=cropImageData(); self._imgDataUrl=c.url; self._imgCropData={data:c.data.data,cw:aW,ch:aH}; if(self._rbInlineRedraw) self._rbInlineRedraw(); modal.remove(); };
      convert.onclick=()=>{ const c=cropImageData(), thr=parseInt(slider.value)||128, px=new Uint8Array(aW*aH); for(let y=0;y<aH;y++)for(let x=0;x<aW;x++){const i=(y*aW+x)*4, br=c.data.data[i]*.299+c.data.data[i+1]*.587+c.data.data[i+2]*.114; px[y*aW+x]=br<thr?1:0;} setField(self,self.scale||4,px); modal.remove(); };
      draw();
    };
    img.src=dataUrl;
  };

  // Video import: 1 frame per second into consecutive disp_anim_frame blocks / store.
  FieldPaintGrid.prototype._openVideoImportModal = function(){
    const self=this;
    let inp=document.getElementById('_pgVideoInput');
    if(!inp){ inp=document.createElement('input'); inp.type='file'; inp.accept='video/*'; inp.id='_pgVideoInput'; inp.style.cssText='position:fixed;opacity:0;pointer-events:none;top:0;left:0'; document.body.appendChild(inp); }
    inp.value='';
    inp.onchange=e=>{ const f=e.target.files&&e.target.files[0]; if(f) importVideo(f,self); };
    inp.click();
  };

  async function importVideo(file, field){
    const url=URL.createObjectURL(file), video=document.createElement('video');
    video.src=url; video.muted=true; video.playsInline=true; video.preload='metadata';
    const modal=document.createElement('div');
    modal.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;color:white;font:700 14px Arial';
    modal.textContent='Імпорт відео: 1 кадр/сек...';
    document.body.appendChild(modal);
    await new Promise((res,rej)=>{ video.onloadedmetadata=res; video.onerror=rej; });
    const startBlock=field.sourceBlock_, startIdx=startBlock&&startBlock.type==='disp_anim_frame'?parseInt(startBlock.getFieldValue('IDX'))||0:0;
    const maxFrames=Math.min(10-startIdx, Math.max(1, Math.floor(video.duration||1)+1));
    const ws=startBlock&&startBlock.workspace || getWorkspace();
    const canvas=document.createElement('canvas'), d=dims(field.scale||4); canvas.width=d.cols; canvas.height=d.rows; const ctx=canvas.getContext('2d');
    for(let k=0;k<maxFrames;k++){
      video.currentTime=Math.min(k, Math.max(0,(video.duration||1)-0.05));
      await new Promise(res=>{ video.onseeked=res; });
      ctx.drawImage(video,0,0,d.cols,d.rows);
      const id=ctx.getImageData(0,0,d.cols,d.rows).data, px=new Uint8Array(d.cols*d.rows);
      for(let i=0;i<px.length;i++){ const j=i*4, br=id[j]*.299+id[j+1]*.587+id[j+2]*.114; px[i]=br<128?1:0; }
      const val=ser(field.scale||4,px);
      window.rbOledFrameStore[startIdx+k]=val;
      setFrameVal(ws,startIdx+k,val);
      if(k===0) setField(field,field.scale||4,px);
    }
    URL.revokeObjectURL(url); modal.remove();
    updateOnionAndFrame(field);
  }

  // Add video button into inline editor for animation frame fields.
  const oldBuild = FieldPaintGrid.prototype._build;
  FieldPaintGrid.prototype._build = function(){
    oldBuild.call(this);
    try{
      if(this.sourceBlock_ && this.sourceBlock_.type==='disp_anim_frame'){
        const fo=this.fieldGroup_ && this.fieldGroup_.querySelector && this.fieldGroup_.querySelector('foreignObject');
        const root=fo && fo.querySelector('.rb-oled-tools');
        if(root && !root.querySelector('[data-act="video"]')){
          const group=document.createElement('div'); group.className='rb-oled-group';
          const btn=document.createElement('button'); btn.className='rb-oled-btn photo'; btn.setAttribute('data-act','video'); btn.innerHTML='🎞'; btn.title='Відео 1 кадр/сек';
          btn.onclick=(e)=>{e.preventDefault();e.stopPropagation();this._openVideoImportModal();};
          group.appendChild(btn); root.insertBefore(group, root.lastElementChild);
        }
      }
      updateOnionAndFrame(this);
    }catch(e){console.warn('video btn',e);}
  };

  window.rbOledSyncCurrentFrame=function(){
    try{
      const ws=getWorkspace(); if(!ws)return;
      ws.getAllBlocks(false).forEach(b=>{ if(b.type==='disp_anim_frame'){ const f=b.getField('GRID'); if(f) updateOnionAndFrame(f); }});
    }catch(_){}
  };
  window.addEventListener('load',()=>[0,300,1000,2000].forEach(t=>setTimeout(window.rbOledSyncCurrentFrame,t)));
})();



/* ================================================================
   PHOTO -> PIXELS QUALITY PATCH
   Покращує саме перетворення фото в OLED-пікселі.
   Додає режими: поріг / Floyd dithering / ordered dithering / adaptive.
   Кнопку відео не змінює.
   ================================================================ */
(function(){
  if (window.__rbPhotoPixelQualityPatch) return;
  window.__rbPhotoPixelQualityPatch = true;
  if (typeof FieldPaintGrid === 'undefined') return;

  function dims(scale){
    const s = scale || 4;
    return { cols: Math.max(1, Math.floor(128 / s)), rows: Math.max(1, Math.floor(64 / s)) };
  }

  function ser(scale, pixels){
    return scale + '|' + Array.prototype.map.call(pixels || [], v => v ? '1' : '0').join('');
  }

  function setField(field, scale, pixels){
    const d = dims(scale);
    field.scale = scale;
    field.cols = d.cols;
    field.rows = d.rows;
    field.pixels = new Uint8Array(d.cols * d.rows);
    for (let i = 0; i < field.pixels.length; i++) field.pixels[i] = pixels[i] ? 1 : 0;
    field.value_ = field._ser ? field._ser() : ser(scale, field.pixels);
    if (field._rbInlineRedraw) field._rbInlineRedraw();
    else if (field._refreshAll) field._refreshAll();
  }

  function grayArray(imageData, w, h, contrast, gamma){
    const data = imageData.data || imageData;
    const out = new Float32Array(w * h);
    contrast = Number.isFinite(contrast) ? contrast : 1.25;
    gamma = Number.isFinite(gamma) ? gamma : 1.0;

    for (let i = 0; i < w * h; i++) {
      const j = i * 4;
      let v = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
      v = v / 255;
      if (gamma !== 1) v = Math.pow(v, gamma);
      v = (v - 0.5) * contrast + 0.5;
      out[i] = Math.max(0, Math.min(255, v * 255));
    }
    return out;
  }

  function convertImageToPixels(imageData, w, h, opts){
    opts = opts || {};
    const mode = opts.mode || 'floyd';
    const threshold = Math.max(0, Math.min(255, parseInt(opts.threshold ?? 128) || 128));
    const contrast = parseFloat(opts.contrast ?? 1.25);
    const gamma = parseFloat(opts.gamma ?? 1.0);
    const g = grayArray(imageData, w, h, contrast, gamma);
    const out = new Uint8Array(w * h);

    if (mode === 'floyd') {
      const e = new Float32Array(g);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const old = e[i];
          const nv = old < threshold ? 0 : 255;
          out[i] = nv === 0 ? 1 : 0;
          const err = old - nv;
          if (x + 1 < w) e[i + 1] += err * 7 / 16;
          if (y + 1 < h) {
            if (x > 0) e[i + w - 1] += err * 3 / 16;
            e[i + w] += err * 5 / 16;
            if (x + 1 < w) e[i + w + 1] += err * 1 / 16;
          }
        }
      }
      return out;
    }

    if (mode === 'ordered') {
      const b = [
        0,  8,  2, 10,
        12, 4, 14,  6,
        3, 11,  1,  9,
        15, 7, 13,  5
      ];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const t = threshold + (b[(y & 3) * 4 + (x & 3)] - 7.5) * 10;
          out[i] = g[i] < t ? 1 : 0;
        }
      }
      return out;
    }

    if (mode === 'adaptive') {
      const r = 2;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0, cnt = 0;
          for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
            for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
              sum += g[yy * w + xx];
              cnt++;
            }
          }
          out[y * w + x] = g[y * w + x] < (sum / cnt - 7) ? 1 : 0;
        }
      }
      return out;
    }

    for (let i = 0; i < w * h; i++) out[i] = g[i] < threshold ? 1 : 0;
    return out;
  }

  window.rbConvertImageToOledPixels = convertImageToPixels;

  FieldPaintGrid.prototype._showCropper = function(dataUrl){
    const self = this;
    const aW = this.cols || 32;
    const aH = this.rows || 16;

    let modal = document.getElementById('_pgCropModal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = '_pgCropModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.88);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:14px;box-sizing:border-box';

    const title = document.createElement('div');
    title.style.cssText = 'color:#fecaca;font:700 14px Arial';
    title.textContent = 'Фото → OLED пікселі';
    modal.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#94a3b8;font:11px Arial;margin-top:-6px;text-align:center';
    hint.textContent = 'Зліва вибір області, справа попередній перегляд як це стане пікселями.';
    modal.appendChild(hint);

    const layout = document.createElement('div');
    layout.style.cssText = 'display:flex;gap:14px;align-items:flex-start;justify-content:center;max-width:96vw;max-height:62vh';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;touch-action:none;flex:0 1 auto';

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;max-width:min(68vw,760px);max-height:60vh;border-radius:8px;background:#0f172a';
    wrap.appendChild(canvas);

    const previewBox = document.createElement('div');
    previewBox.style.cssText = 'width:220px;min-width:180px;background:#020617;border:1px solid #334155;border-radius:12px;padding:10px;box-shadow:0 18px 40px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:8px;align-items:center';

    const previewTitle = document.createElement('div');
    previewTitle.style.cssText = 'color:#cbd5e1;font:700 12px Arial;text-align:center';
    previewTitle.textContent = 'Попередній перегляд';
    previewBox.appendChild(previewTitle);

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = aW;
    previewCanvas.height = aH;
    previewCanvas.style.cssText = 'width:100%;max-width:200px;image-rendering:pixelated;background:#0b1326;border:1px solid #334155;border-radius:6px';
    previewBox.appendChild(previewCanvas);

    const previewInfo = document.createElement('div');
    previewInfo.style.cssText = 'color:#94a3b8;font:11px monospace;text-align:center';
    previewInfo.textContent = aW + '×' + aH;
    previewBox.appendChild(previewInfo);

    layout.appendChild(wrap);
    layout.appendChild(previewBox);
    modal.appendChild(layout);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:grid;grid-template-columns:auto 155px auto 1fr auto 1fr auto 1fr;gap:8px;align-items:center;width:min(96vw,1000px);color:#94a3b8;font:11px Arial';

    const modeLbl = document.createElement('span');
    modeLbl.textContent = 'Метод:';
    controls.appendChild(modeLbl);

    const mode = document.createElement('select');
    mode.style.cssText = 'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:6px';
    mode.innerHTML = '<option value="threshold">Поріг</option><option value="floyd" selected>Floyd dithering</option><option value="ordered">Ordered dithering</option><option value="adaptive">Adaptive</option>';
    controls.appendChild(mode);

    function addRange(label, min, max, val, step){
      const l = document.createElement('span');
      l.textContent = label;
      controls.appendChild(l);

      const r = document.createElement('input');
      r.type = 'range';
      r.min = min;
      r.max = max;
      r.step = step || 1;
      r.value = val;
      r.style.cssText = 'accent-color:#ef4444';

      const v = document.createElement('span');
      v.textContent = String(val);
      v.style.cssText = 'color:#fecaca;font:11px monospace;min-width:30px';

      r.oninput = () => {
        v.textContent = r.value;
        preview();
      };

      controls.appendChild(r);
      controls.appendChild(v);
      return r;
    }

    const threshold = addRange('Поріг', 0, 255, 128, 1);
    const contrast = addRange('Контраст', 0.5, 2.5, 1.25, 0.05);
    const gamma = addRange('Гамма', 0.5, 2.2, 1.0, 0.05);
    mode.onchange = () => preview();

    modal.appendChild(controls);

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center';

    function btn(text, bg, fn){
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'padding:9px 18px;background:' + bg + ';color:white;border:0;border-radius:8px;font:700 13px Arial;cursor:pointer';
      b.onclick = fn;
      return b;
    }

    const cancel = btn('Скасувати', '#374151', () => modal.remove());
    const overlay = btn('👁 Накласти', '#2563eb', () => {});
    const convert = btn('✓ У пікселі', '#059669', () => {});
    btns.append(cancel, overlay, convert);
    modal.appendChild(btns);

    const mobileCss = document.createElement('style');
    mobileCss.textContent = '@media(max-width:850px){#_pgCropModalPreviewFix{display:none}.pg-preview-layout{flex-direction:column;max-height:none!important}.pg-preview-side{width:min(92vw,420px)!important}}';
    modal.appendChild(mobileCss);
    layout.className = 'pg-preview-layout';
    previewBox.className = 'pg-preview-side';

    document.body.appendChild(modal);

    const img = new Image();
    let cW = 0, cH = 0, rX = 0, rY = 0, rW = 0, rH = 0;
    let drag = false, resize = false, sx0 = 0, sy0 = 0, ox = 0, oy = 0;
    const HND = 18;
    let lastPixels = null;

    function options(){
      return {
        mode: mode.value,
        threshold: threshold.value,
        contrast: contrast.value,
        gamma: gamma.value
      };
    }

    function cropImageData(){
      const off = document.createElement('canvas');
      off.width = aW;
      off.height = aH;
      const oc = off.getContext('2d');
      const sx = img.width / cW;
      const sy = img.height / cH;
      oc.imageSmoothingEnabled = true;
      oc.imageSmoothingQuality = 'high';
      oc.drawImage(img, rX * sx, rY * sy, rW * sx, rH * sy, 0, 0, aW, aH);
      return { imageData: oc.getImageData(0, 0, aW, aH), url: off.toDataURL() };
    }

    function drawPixelPreview(px){
      lastPixels = px;
      const pctx = previewCanvas.getContext('2d');
      pctx.imageSmoothingEnabled = false;
      pctx.fillStyle = '#0b1326';
      pctx.fillRect(0, 0, aW, aH);
      pctx.fillStyle = '#9aa5ff';
      for (let y = 0; y < aH; y++) {
        for (let x = 0; x < aW; x++) {
          if (px[y * aW + x]) pctx.fillRect(x, y, 1, 1);
        }
      }
      let count = 0;
      for (let i = 0; i < px.length; i++) if (px[i]) count++;
      previewInfo.textContent = aW + '×' + aH + ' · ' + count + ' пікс.';
    }

    function drawBase(){
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, cW, cH);
      ctx.drawImage(img, 0, 0, cW, cH);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, cW, rY);
      ctx.fillRect(0, rY + rH, cW, cH - rY - rH);
      ctx.fillRect(0, rY, rX, rH);
      ctx.fillRect(rX + rW, rY, cW - rX - rW, rH);

      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3;
      ctx.strokeRect(rX + 1.5, rY + 1.5, rW - 3, rH - 3);

      ctx.strokeStyle = 'rgba(239,68,68,.45)';
      ctx.lineWidth = 1;
      [1, 2].forEach(i => {
        ctx.beginPath();
        ctx.moveTo(rX + rW * i / 3, rY);
        ctx.lineTo(rX + rW * i / 3, rY + rH);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(rX, rY + rH * i / 3);
        ctx.lineTo(rX + rW, rY + rH * i / 3);
        ctx.stroke();
      });

      ctx.fillStyle = '#ef4444';
      ctx.fillRect(rX + rW - HND, rY + rH - HND, HND, HND);

      ctx.fillStyle = 'rgba(239,68,68,.92)';
      ctx.fillRect(rX, rY, 86, 18);
      ctx.fillStyle = 'white';
      ctx.font = '11px monospace';
      ctx.fillText(aW + '×' + aH, rX + 5, rY + 13);
    }

    function preview(){
      if (!cW) return;
      drawBase();

      const cropped = cropImageData();
      const px = convertImageToPixels(cropped.imageData, aW, aH, options());
      drawPixelPreview(px);

      // дублюємо маленький preview поверх картинки, щоб на вузькому екрані теж було видно
      const ctx = canvas.getContext('2d');
      const pScale = Math.max(2, Math.floor(Math.min(150 / aW, 72 / aH)));
      const pw = aW * pScale;
      const ph = aH * pScale;
      let px0 = rX + rW + 8;
      let py0 = rY;
      if (px0 + pw + 8 > cW) px0 = Math.max(8, cW - pw - 12);
      if (py0 + ph + 8 > cH) py0 = Math.max(8, cH - ph - 12);

      ctx.fillStyle = 'rgba(2,6,23,.88)';
      ctx.fillRect(px0 - 4, py0 - 4, pw + 8, ph + 8);

      ctx.fillStyle = '#9aa5ff';
      for (let y = 0; y < aH; y++) {
        for (let x = 0; x < aW; x++) {
          if (px[y * aW + x]) ctx.fillRect(px0 + x * pScale, py0 + y * pScale, pScale, pScale);
        }
      }

      ctx.strokeStyle = 'rgba(239,68,68,.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px0 - 4, py0 - 4, pw + 8, ph + 8);
    }

    function pos(e){
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    }

    function onDown(e){
      e.preventDefault();
      const p = pos(e);
      if (p.x >= rX + rW - HND && p.x <= rX + rW && p.y >= rY + rH - HND && p.y <= rY + rH) {
        resize = true;
      } else if (p.x >= rX && p.x <= rX + rW && p.y >= rY && p.y <= rY + rH) {
        drag = true;
        sx0 = p.x;
        sy0 = p.y;
        ox = rX;
        oy = rY;
      }
    }

    function onMove(e){
      if (!drag && !resize) return;
      e.preventDefault();

      const p = pos(e);
      const asp = aW / aH;

      if (drag) {
        rX = Math.max(0, Math.min(cW - rW, ox + p.x - sx0));
        rY = Math.max(0, Math.min(cH - rH, oy + p.y - sy0));
      } else {
        let nW = Math.max(24, p.x - rX);
        let nH = Math.max(12, p.y - rY);
        if (nW / nH > asp) nH = nW / asp;
        else nW = nH * asp;

        rW = Math.min(Math.round(nW), cW - rX);
        rH = Math.min(Math.round(rW / asp), cH - rY);
        rW = Math.round(rH * asp);
      }

      preview();
    }

    function onUp(){
      drag = false;
      resize = false;
    }

    img.onload = () => {
      const maxW = Math.min(720, window.innerWidth * 0.68);
      const maxH = Math.min(470, window.innerHeight * 0.55);

      cW = img.width;
      cH = img.height;

      if (cW > maxW) {
        cH = cH * maxW / cW;
        cW = maxW;
      }
      if (cH > maxH) {
        cW = cW * maxH / cH;
        cH = maxH;
      }

      cW = Math.round(cW);
      cH = Math.round(cH);

      canvas.width = cW;
      canvas.height = cH;
      canvas.style.width = cW + 'px';
      canvas.style.height = cH + 'px';

      const asp = aW / aH;
      if (cW / cH > asp) {
        rH = cH * 0.82;
        rW = rH * asp;
      } else {
        rW = cW * 0.82;
        rH = rW / asp;
      }

      rW = Math.round(rW);
      rH = Math.round(rH);
      rX = Math.round((cW - rW) / 2);
      rY = Math.round((cH - rH) / 2);

      canvas.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      canvas.addEventListener('touchstart', onDown, { passive:false });
      canvas.addEventListener('touchmove', onMove, { passive:false });
      canvas.addEventListener('touchend', onUp, { passive:false });

      preview();
    };

    overlay.onclick = () => {
      const cropped = cropImageData();
      const px = lastPixels || convertImageToPixels(cropped.imageData, aW, aH, options());
      self._imgDataUrl = cropped.url;
      self._imgCropData = { data: cropped.imageData.data, cw: aW, ch: aH, options: options(), previewPixels: px };
      if (self._rbInlineRedraw) self._rbInlineRedraw();
      modal.remove();
    };

    convert.onclick = () => {
      const cropped = cropImageData();
      const px = lastPixels || convertImageToPixels(cropped.imageData, aW, aH, options());
      self._imgCropData = { data: cropped.imageData.data, cw: aW, ch: aH, options: options(), previewPixels: px };
      setField(self, self.scale || 4, px);
      modal.remove();
    };

    img.src = dataUrl;
  };
})();



/* ================================================================
   RESTORE SMALL VIDEO BUTTON IN OLED ANIMATION FRAME
   Маленька кнопка 🎞 біля Фото. Не збільшує панель.
   ================================================================ */
(function(){
  if (window.__rbRestoreSmallVideoButton) return;
  window.__rbRestoreSmallVideoButton = true;
  if (typeof FieldPaintGrid === 'undefined') return;

  function dims(scale){
    const s = scale || 4;
    return { cols: Math.max(1, Math.floor(128 / s)), rows: Math.max(1, Math.floor(64 / s)) };
  }

  function ser(scale, pixels){
    return scale + '|' + Array.prototype.map.call(pixels || [], v => v ? '1' : '0').join('');
  }

  function setField(field, scale, pixels){
    const d = dims(scale);
    field.scale = scale;
    field.cols = d.cols;
    field.rows = d.rows;
    field.pixels = new Uint8Array(d.cols * d.rows);
    for (let i = 0; i < field.pixels.length; i++) field.pixels[i] = pixels[i] ? 1 : 0;
    field.value_ = field._ser ? field._ser() : ser(scale, field.pixels);
    if (field._rbInlineRedraw) field._rbInlineRedraw();
    else if (field._refreshAll) field._refreshAll();
  }

  function getWorkspace(){
    try { return window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace()); }
    catch(_) { return null; }
  }

  function setFrameVal(ws, idx, val){
    if (!ws || !ws.getAllBlocks) return false;
    let ok = false;
    ws.getAllBlocks(false).forEach(b => {
      if (b.type === 'disp_anim_frame' && parseInt(b.getFieldValue('IDX')) === idx) {
        const f = b.getField('GRID');
        if (f) {
          f.setValue(val);
          if (f._rbInlineRedraw) f._rbInlineRedraw();
          ok = true;
        }
      }
    });
    return ok;
  }

  async function importVideo(file, field){
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;color:white;font:700 14px Arial';
    modal.textContent = 'Імпорт відео: 1 кадр/сек...';
    document.body.appendChild(modal);

    try {
      await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = rej; });

      const block = field.sourceBlock_;
      const startIdx = block && block.type === 'disp_anim_frame' ? (parseInt(block.getFieldValue('IDX')) || 0) : 0;
      const ws = block && block.workspace || getWorkspace();
      const d = dims(field.scale || 4);

      const canvas = document.createElement('canvas');
      canvas.width = d.cols;
      canvas.height = d.rows;
      const ctx = canvas.getContext('2d');

      const maxFrames = Math.min(10 - startIdx, Math.max(1, Math.floor(video.duration || 1) + 1));

      window.rbOledFrameStore = window.rbOledFrameStore || {};

      for (let k = 0; k < maxFrames; k++) {
        video.currentTime = Math.min(k, Math.max(0, (video.duration || 1) - 0.05));
        await new Promise(res => { video.onseeked = res; });

        ctx.drawImage(video, 0, 0, d.cols, d.rows);
        const data = ctx.getImageData(0, 0, d.cols, d.rows);
        let px;

        if (window.rbConvertImageToOledPixels) {
          px = window.rbConvertImageToOledPixels(data, d.cols, d.rows, {
            mode: 'floyd',
            threshold: 128,
            contrast: 1.25,
            gamma: 1
          });
        } else {
          px = new Uint8Array(d.cols * d.rows);
          const id = data.data;
          for (let i = 0; i < px.length; i++) {
            const j = i * 4;
            const br = id[j] * .299 + id[j + 1] * .587 + id[j + 2] * .114;
            px[i] = br < 128 ? 1 : 0;
          }
        }

        const val = ser(field.scale || 4, px);
        window.rbOledFrameStore[startIdx + k] = val;
        setFrameVal(ws, startIdx + k, val);

        if (k === 0) setField(field, field.scale || 4, px);
      }
    } catch(e) {
      console.warn('video import failed', e);
    } finally {
      URL.revokeObjectURL(url);
      modal.remove();
    }
  }

  FieldPaintGrid.prototype._openVideoImportModal = function(){
    const field = this;
    let inp = document.getElementById('_pgVideoInput');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'video/*';
      inp.id = '_pgVideoInput';
      inp.style.cssText = 'position:fixed;opacity:0;pointer-events:none;top:0;left:0';
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.onchange = e => {
      const f = e.target.files && e.target.files[0];
      if (f) importVideo(f, field);
    };
    inp.click();
  };

  function addSmallVideoButton(field){
    try {
      if (!field || !field.sourceBlock_ || field.sourceBlock_.type !== 'disp_anim_frame') return;

      const group = field.fieldGroup_;
      if (!group || !group.querySelector) return;

      const tools = group.querySelector('.rb-oled-tools');
      if (!tools || tools.querySelector('[data-act="video"]')) return;

      // Шукаємо праву групу з Фото / У пікселі.
      const rightGroup = tools.querySelector('.rb-oled-group.push') || tools.lastElementChild || tools;

      const btn = document.createElement('button');
      btn.className = 'rb-oled-btn photo';
      btn.setAttribute('data-act', 'video');
      btn.title = 'Відео: 1 кадр/сек';
      btn.innerHTML = '🎞';
      btn.style.minWidth = '32px';
      btn.style.width = '32px';
      btn.style.padding = '0';

      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        field._openVideoImportModal();
      });

      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
      });

      // Ставимо перед кнопкою Фото, щоб була маленька збоку.
      const photo = rightGroup.querySelector('[data-act="photo"]');
      if (photo) rightGroup.insertBefore(btn, photo);
      else rightGroup.insertBefore(btn, rightGroup.firstChild);
    } catch(e) {
      console.warn('small video button', e);
    }
  }

  const prevBuild = FieldPaintGrid.prototype._build;
  FieldPaintGrid.prototype._build = function(){
    prevBuild.call(this);
    setTimeout(() => addSmallVideoButton(this), 0);
  };

  window.rbRestoreVideoButtonsNow = function(){
    try {
      const ws = getWorkspace();
      if (!ws || !ws.getAllBlocks) return;
      ws.getAllBlocks(false).forEach(b => {
        if (b.type === 'disp_anim_frame') {
          const f = b.getField('GRID');
          if (f) addSmallVideoButton(f);
        }
      });
    } catch(_) {}
  };

  window.addEventListener('load', () => [0, 300, 1000, 2000].forEach(t => setTimeout(window.rbRestoreVideoButtonsNow, t)));
})();



/* ================================================================
   PHOTO OVERLAY + CLEAN PREVIEW + NOISE CLEANUP FIX
   - preview only on right side, not over the crop frame
   - "Накласти" shows photo as background inside inline editor
   - "У пікселі" uses better dithering + noise cleanup
   ================================================================ */
(function(){
  if (window.__rbPhotoOverlayPreviewNoiseFix) return;
  window.__rbPhotoOverlayPreviewNoiseFix = true;
  if (typeof FieldPaintGrid === 'undefined') return;

  function dims(scale){
    const s = scale || 4;
    return { cols: Math.max(1, Math.floor(128 / s)), rows: Math.max(1, Math.floor(64 / s)) };
  }

  function ser(scale, pixels){
    return scale + '|' + Array.prototype.map.call(pixels || [], v => v ? '1' : '0').join('');
  }

  function setField(field, scale, pixels){
    const d = dims(scale);
    field.scale = scale;
    field.cols = d.cols;
    field.rows = d.rows;
    field.pixels = new Uint8Array(d.cols * d.rows);
    for (let i = 0; i < field.pixels.length; i++) field.pixels[i] = pixels[i] ? 1 : 0;
    field.value_ = field._ser ? field._ser() : ser(scale, field.pixels);
    if (field._rbInlineRedraw) field._rbInlineRedraw();
    else if (field._refreshAll) field._refreshAll();
  }

  function grayArray(imageData, w, h, contrast, gamma){
    const data = imageData.data || imageData;
    const out = new Float32Array(w * h);
    contrast = Number.isFinite(contrast) ? contrast : 1.25;
    gamma = Number.isFinite(gamma) ? gamma : 1;

    for (let i = 0; i < w * h; i++) {
      const j = i * 4;
      let v = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
      v = v / 255;
      if (gamma !== 1) v = Math.pow(v, gamma);
      v = (v - 0.5) * contrast + 0.5;
      out[i] = Math.max(0, Math.min(255, v * 255));
    }
    return out;
  }

  function cleanupNoise(px, w, h, level){
    level = parseInt(level);
    if (!Number.isFinite(level) || level <= 0) return px;

    const src = new Uint8Array(px);
    const dst = new Uint8Array(px);
    const minNeighbors = Math.min(5, Math.max(1, level + 1));

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!src[i]) continue;

        let n = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
            if (xx === x && yy === y) continue;
            if (src[yy * w + xx]) n++;
          }
        }

        if (n < minNeighbors) dst[i] = 0;
      }
    }
    return dst;
  }

  function convertImageToPixels(imageData, w, h, opts){
    opts = opts || {};
    const mode = opts.mode || 'floyd';
    const threshold = Math.max(0, Math.min(255, parseInt(opts.threshold ?? 128) || 128));
    const contrast = parseFloat(opts.contrast ?? 1.25);
    const gamma = parseFloat(opts.gamma ?? 1.0);
    const clean = parseInt(opts.clean ?? 2);
    const g = grayArray(imageData, w, h, contrast, gamma);
    const out = new Uint8Array(w * h);

    if (mode === 'floyd') {
      const e = new Float32Array(g);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const old = e[i];
          const nv = old < threshold ? 0 : 255;
          out[i] = nv === 0 ? 1 : 0;
          const err = old - nv;
          if (x + 1 < w) e[i + 1] += err * 7 / 16;
          if (y + 1 < h) {
            if (x > 0) e[i + w - 1] += err * 3 / 16;
            e[i + w] += err * 5 / 16;
            if (x + 1 < w) e[i + w + 1] += err * 1 / 16;
          }
        }
      }
      return cleanupNoise(out, w, h, clean);
    }

    if (mode === 'ordered') {
      const b = [
        0, 8, 2, 10,
        12, 4, 14, 6,
        3, 11, 1, 9,
        15, 7, 13, 5
      ];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const t = threshold + (b[(y & 3) * 4 + (x & 3)] - 7.5) * 10;
          out[i] = g[i] < t ? 1 : 0;
        }
      }
      return cleanupNoise(out, w, h, clean);
    }

    if (mode === 'adaptive') {
      const r = 2;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0, cnt = 0;
          for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
            for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
              sum += g[yy * w + xx];
              cnt++;
            }
          }
          out[y * w + x] = g[y * w + x] < (sum / cnt - 7) ? 1 : 0;
        }
      }
      return cleanupNoise(out, w, h, clean);
    }

    for (let i = 0; i < w * h; i++) out[i] = g[i] < threshold ? 1 : 0;
    return cleanupNoise(out, w, h, clean);
  }

  window.rbConvertImageToOledPixels = convertImageToPixels;

  function addOverlayToInlineEditor(field){
    try {
      if (!field || !field._imgDataUrl || !field.fieldGroup_) return;
      const fo = field.fieldGroup_.querySelector && field.fieldGroup_.querySelector('foreignObject');
      const editor = fo && fo.querySelector('.rb-oled-editor');
      const box = editor && editor.querySelector('.rb-oled-canvasBox');
      if (!box) return;

      let img = box.querySelector('.rb-oled-photo-bg');
      if (!img) {
        img = document.createElement('img');
        img.className = 'rb-oled-photo-bg';
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;opacity:.34;pointer-events:none;image-rendering:auto;z-index:0';
        box.insertBefore(img, box.firstChild);
      }
      img.src = field._imgDataUrl;
      img.style.display = '';
      const canvas = box.querySelector('canvas');
      if (canvas) {
        canvas.style.position = 'relative';
        canvas.style.zIndex = '1';
        canvas.style.background = 'transparent';
      }
    } catch(e) {
      console.warn('photo overlay', e);
    }
  }

  const oldBuild = FieldPaintGrid.prototype._build;
  FieldPaintGrid.prototype._build = function(){
    oldBuild.call(this);
    setTimeout(() => addOverlayToInlineEditor(this), 0);
  };

  const oldRedrawHook = FieldPaintGrid.prototype.setValue;
  FieldPaintGrid.prototype.setValue = function(v){
    if (oldRedrawHook) oldRedrawHook.call(this, v);
    else {
      this.value_ = v || '';
      if (this._load) this._load(v);
    }
    setTimeout(() => {
      if (this._rbInlineRedraw) this._rbInlineRedraw();
      addOverlayToInlineEditor(this);
    }, 0);
  };

  FieldPaintGrid.prototype._showCropper = function(dataUrl){
    const self = this;
    const aW = this.cols || 32;
    const aH = this.rows || 16;

    let modal = document.getElementById('_pgCropModal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = '_pgCropModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.88);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:14px;box-sizing:border-box';

    const title = document.createElement('div');
    title.style.cssText = 'color:#fecaca;font:700 14px Arial';
    title.textContent = 'Фото → OLED пікселі';
    modal.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#94a3b8;font:11px Arial;margin-top:-6px;text-align:center';
    hint.textContent = 'Зліва рамка фото, справа preview. Якщо фон зернистий — підніми «Шум» або вибери Adaptive/Поріг.';
    modal.appendChild(hint);

    const layout = document.createElement('div');
    layout.style.cssText = 'display:flex;gap:14px;align-items:flex-start;justify-content:center;max-width:96vw;max-height:62vh';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;touch-action:none;flex:0 1 auto';

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;max-width:min(70vw,760px);max-height:60vh;border-radius:8px;background:#0f172a';
    wrap.appendChild(canvas);

    const previewBox = document.createElement('div');
    previewBox.style.cssText = 'width:220px;min-width:180px;background:#020617;border:1px solid #334155;border-radius:12px;padding:10px;box-shadow:0 18px 40px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:8px;align-items:center';

    const previewTitle = document.createElement('div');
    previewTitle.style.cssText = 'color:#cbd5e1;font:700 12px Arial;text-align:center';
    previewTitle.textContent = 'Попередній перегляд';
    previewBox.appendChild(previewTitle);

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = aW;
    previewCanvas.height = aH;
    previewCanvas.style.cssText = 'width:100%;max-width:200px;image-rendering:pixelated;background:#0b1326;border:1px solid #334155;border-radius:6px';
    previewBox.appendChild(previewCanvas);

    const previewInfo = document.createElement('div');
    previewInfo.style.cssText = 'color:#94a3b8;font:11px monospace;text-align:center';
    previewInfo.textContent = aW + '×' + aH;
    previewBox.appendChild(previewInfo);

    layout.appendChild(wrap);
    layout.appendChild(previewBox);
    modal.appendChild(layout);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:grid;grid-template-columns:auto 155px auto 1fr auto 1fr auto 1fr auto 1fr;gap:8px;align-items:center;width:min(96vw,1000px);color:#94a3b8;font:11px Arial';

    const modeLbl = document.createElement('span');
    modeLbl.textContent = 'Метод:';
    controls.appendChild(modeLbl);

    const mode = document.createElement('select');
    mode.style.cssText = 'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:6px';
    mode.innerHTML = '<option value="threshold">Поріг</option><option value="floyd" selected>Floyd dithering</option><option value="ordered">Ordered dithering</option><option value="adaptive">Adaptive</option>';
    controls.appendChild(mode);

    function addRange(label, min, max, val, step){
      const l = document.createElement('span');
      l.textContent = label;
      controls.appendChild(l);

      const r = document.createElement('input');
      r.type = 'range';
      r.min = min;
      r.max = max;
      r.step = step || 1;
      r.value = val;
      r.style.cssText = 'accent-color:#ef4444';

      const v = document.createElement('span');
      v.textContent = String(val);
      v.style.cssText = 'color:#fecaca;font:11px monospace;min-width:30px';

      r.oninput = () => {
        v.textContent = r.value;
        preview();
      };

      controls.appendChild(r);
      controls.appendChild(v);
      return r;
    }

    const threshold = addRange('Поріг', 0, 255, 128, 1);
    const contrast = addRange('Контраст', 0.5, 2.5, 1.25, 0.05);
    const gamma = addRange('Гамма', 0.5, 2.2, 1.0, 0.05);
    const clean = addRange('Шум', 0, 4, 2, 1);
    mode.onchange = () => preview();

    modal.appendChild(controls);

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center';

    function btn(text, bg, fn){
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'padding:9px 18px;background:' + bg + ';color:white;border:0;border-radius:8px;font:700 13px Arial;cursor:pointer';
      b.onclick = fn;
      return b;
    }

    const cancel = btn('Скасувати', '#374151', () => modal.remove());
    const overlay = btn('👁 Накласти', '#2563eb', () => {});
    const convert = btn('✓ У пікселі', '#059669', () => {});
    btns.append(cancel, overlay, convert);
    modal.appendChild(btns);

    const style = document.createElement('style');
    style.textContent = '@media(max-width:850px){#_pgCropModal .pg-preview-layout{flex-direction:column;max-height:none!important}#_pgCropModal .pg-preview-side{width:min(92vw,420px)!important}}';
    modal.appendChild(style);
    layout.className = 'pg-preview-layout';
    previewBox.className = 'pg-preview-side';

    document.body.appendChild(modal);

    const img = new Image();
    let cW = 0, cH = 0, rX = 0, rY = 0, rW = 0, rH = 0;
    let drag = false, resize = false, sx0 = 0, sy0 = 0, ox = 0, oy = 0;
    const HND = 18;
    let lastPixels = null;

    function options(){
      return {
        mode: mode.value,
        threshold: threshold.value,
        contrast: contrast.value,
        gamma: gamma.value,
        clean: clean.value
      };
    }

    function cropImageData(){
      const off = document.createElement('canvas');
      off.width = aW;
      off.height = aH;
      const oc = off.getContext('2d');
      const sx = img.width / cW;
      const sy = img.height / cH;
      oc.imageSmoothingEnabled = true;
      oc.imageSmoothingQuality = 'high';
      oc.drawImage(img, rX * sx, rY * sy, rW * sx, rH * sy, 0, 0, aW, aH);
      return { imageData: oc.getImageData(0, 0, aW, aH), url: off.toDataURL() };
    }

    function drawPixelPreview(px){
      lastPixels = px;
      const pctx = previewCanvas.getContext('2d');
      pctx.imageSmoothingEnabled = false;
      pctx.fillStyle = '#0b1326';
      pctx.fillRect(0, 0, aW, aH);
      pctx.fillStyle = '#9aa5ff';
      for (let y = 0; y < aH; y++) {
        for (let x = 0; x < aW; x++) {
          if (px[y * aW + x]) pctx.fillRect(x, y, 1, 1);
        }
      }
      let count = 0;
      for (let i = 0; i < px.length; i++) if (px[i]) count++;
      previewInfo.textContent = aW + '×' + aH + ' · ' + count + ' пікс.';
    }

    function drawBase(){
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, cW, cH);
      ctx.drawImage(img, 0, 0, cW, cH);

      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, cW, rY);
      ctx.fillRect(0, rY + rH, cW, cH - rY - rH);
      ctx.fillRect(0, rY, rX, rH);
      ctx.fillRect(rX + rW, rY, cW - rX - rW, rH);

      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3;
      ctx.strokeRect(rX + 1.5, rY + 1.5, rW - 3, rH - 3);

      ctx.strokeStyle = 'rgba(239,68,68,.45)';
      ctx.lineWidth = 1;
      [1, 2].forEach(i => {
        ctx.beginPath();
        ctx.moveTo(rX + rW * i / 3, rY);
        ctx.lineTo(rX + rW * i / 3, rY + rH);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(rX, rY + rH * i / 3);
        ctx.lineTo(rX + rW, rY + rH * i / 3);
        ctx.stroke();
      });

      ctx.fillStyle = '#ef4444';
      ctx.fillRect(rX + rW - HND, rY + rH - HND, HND, HND);

      ctx.fillStyle = 'rgba(239,68,68,.92)';
      ctx.fillRect(rX, rY, 86, 18);
      ctx.fillStyle = 'white';
      ctx.font = '11px monospace';
      ctx.fillText(aW + '×' + aH, rX + 5, rY + 13);
    }

    function preview(){
      if (!cW) return;
      drawBase();
      const cropped = cropImageData();
      const px = convertImageToPixels(cropped.imageData, aW, aH, options());
      drawPixelPreview(px);
    }

    function pos(e){
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    }

    function onDown(e){
      e.preventDefault();
      const p = pos(e);
      if (p.x >= rX + rW - HND && p.x <= rX + rW && p.y >= rY + rH - HND && p.y <= rY + rH) {
        resize = true;
      } else if (p.x >= rX && p.x <= rX + rW && p.y >= rY && p.y <= rY + rH) {
        drag = true;
        sx0 = p.x;
        sy0 = p.y;
        ox = rX;
        oy = rY;
      }
    }

    function onMove(e){
      if (!drag && !resize) return;
      e.preventDefault();
      const p = pos(e);
      const asp = aW / aH;

      if (drag) {
        rX = Math.max(0, Math.min(cW - rW, ox + p.x - sx0));
        rY = Math.max(0, Math.min(cH - rH, oy + p.y - sy0));
      } else {
        let nW = Math.max(24, p.x - rX);
        let nH = Math.max(12, p.y - rY);
        if (nW / nH > asp) nH = nW / asp;
        else nW = nH * asp;
        rW = Math.min(Math.round(nW), cW - rX);
        rH = Math.min(Math.round(rW / asp), cH - rY);
        rW = Math.round(rH * asp);
      }

      preview();
    }

    function onUp(){
      drag = false;
      resize = false;
    }

    img.onload = () => {
      const maxW = Math.min(720, window.innerWidth * 0.70);
      const maxH = Math.min(470, window.innerHeight * 0.55);

      cW = img.width;
      cH = img.height;

      if (cW > maxW) {
        cH = cH * maxW / cW;
        cW = maxW;
      }
      if (cH > maxH) {
        cW = cW * maxH / cH;
        cH = maxH;
      }

      cW = Math.round(cW);
      cH = Math.round(cH);
      canvas.width = cW;
      canvas.height = cH;
      canvas.style.width = cW + 'px';
      canvas.style.height = cH + 'px';

      const asp = aW / aH;
      if (cW / cH > asp) {
        rH = cH * 0.82;
        rW = rH * asp;
      } else {
        rW = cW * 0.82;
        rH = rW / asp;
      }

      rW = Math.round(rW);
      rH = Math.round(rH);
      rX = Math.round((cW - rW) / 2);
      rY = Math.round((cH - rH) / 2);

      canvas.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      canvas.addEventListener('touchstart', onDown, { passive:false });
      canvas.addEventListener('touchmove', onMove, { passive:false });
      canvas.addEventListener('touchend', onUp, { passive:false });

      preview();
    };

    overlay.onclick = () => {
      const cropped = cropImageData();
      const px = lastPixels || convertImageToPixels(cropped.imageData, aW, aH, options());
      self._imgDataUrl = cropped.url;
      self._imgCropData = { data: cropped.imageData.data, cw: aW, ch: aH, options: options(), previewPixels: px };
      addOverlayToInlineEditor(self);
      if (self._rbInlineRedraw) self._rbInlineRedraw();
      setTimeout(() => addOverlayToInlineEditor(self), 0);
      modal.remove();
    };

    convert.onclick = () => {
      const cropped = cropImageData();
      const px = lastPixels || convertImageToPixels(cropped.imageData, aW, aH, options());
      self._imgCropData = { data: cropped.imageData.data, cw: aW, ch: aH, options: options(), previewPixels: px };
      setField(self, self.scale || 4, px);
      modal.remove();
    };

    img.src = dataUrl;
  };

  // Inline "У пікселі" button: use stored preview/options if photo was overlaid.
  document.addEventListener('click', function(e){
    const btn = e.target.closest && e.target.closest('[data-act="pixels"]');
    if (!btn) return;

    const editor = btn.closest('.rb-oled-editor');
    if (!editor) return;

    try {
      const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
      if (!ws || !ws.getAllBlocks) return;

      // Find the field whose editor contains this button.
      let targetField = null;
      ws.getAllBlocks(false).some(block => {
        const f = block.getField && block.getField('GRID');
        if (f && f.fieldGroup_ && f.fieldGroup_.contains && f.fieldGroup_.querySelector) {
          const fo = f.fieldGroup_.querySelector('foreignObject');
          if (fo && fo.contains(editor)) {
            targetField = f;
            return true;
          }
        }
        return false;
      });

      if (!targetField || !targetField._imgCropData) return;

      e.preventDefault();
      e.stopPropagation();

      const d = dims(targetField.scale || 4);
      let px = targetField._imgCropData.previewPixels;

      if (!px && targetField._imgCropData.data) {
        px = convertImageToPixels(
          { data: targetField._imgCropData.data },
          targetField._imgCropData.cw || d.cols,
          targetField._imgCropData.ch || d.rows,
          targetField._imgCropData.options || { mode:'floyd', threshold:128, contrast:1.25, gamma:1, clean:2 }
        );
      }

      if (px) setField(targetField, targetField.scale || 4, px);
    } catch(err) {
      console.warn('inline pixels convert', err);
    }
  }, true);
})();



/* ================================================================
   FINAL PHOTO UI + TEXT MODE + VIDEO BUTTON FIX
   - removes "Накласти"
   - clean compact photo menu
   - default mode for text/logos
   - restores small 🎞 video button in animation frame
   ================================================================ */
(function(){
  if (window.__rbFinalPhotoTextUiVideoFix) return;
  window.__rbFinalPhotoTextUiVideoFix = true;
  if (typeof FieldPaintGrid === 'undefined') return;

  function dims(scale){
    const s = scale || 4;
    return { cols: Math.max(1, Math.floor(128 / s)), rows: Math.max(1, Math.floor(64 / s)) };
  }

  function ser(scale, pixels){
    return scale + '|' + Array.prototype.map.call(pixels || [], v => v ? '1' : '0').join('');
  }

  function setField(field, scale, pixels){
    const d = dims(scale);
    field.scale = scale;
    field.cols = d.cols;
    field.rows = d.rows;
    field.pixels = new Uint8Array(d.cols * d.rows);
    for (let i = 0; i < field.pixels.length; i++) field.pixels[i] = pixels[i] ? 1 : 0;
    field.value_ = field._ser ? field._ser() : ser(scale, field.pixels);
    if (field._rbInlineRedraw) field._rbInlineRedraw();
    else if (field._refreshAll) field._refreshAll();
  }

  function grayArray(imageData, w, h, contrast, gamma){
    const data = imageData.data || imageData;
    const out = new Float32Array(w * h);
    contrast = Number.isFinite(contrast) ? contrast : 1.15;
    gamma = Number.isFinite(gamma) ? gamma : 1.0;

    for (let i = 0; i < w * h; i++) {
      const j = i * 4;
      let v = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
      v = v / 255;
      if (gamma !== 1) v = Math.pow(v, gamma);
      v = (v - 0.5) * contrast + 0.5;
      out[i] = Math.max(0, Math.min(255, v * 255));
    }
    return out;
  }

  function cleanupNoise(px, w, h, level){
    level = parseInt(level);
    if (!Number.isFinite(level) || level <= 0) return px;
    const src = new Uint8Array(px);
    const dst = new Uint8Array(px);
    const minNeighbors = Math.min(5, Math.max(1, level + 1));

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!src[i]) continue;
        let n = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
            if (xx === x && yy === y) continue;
            if (src[yy * w + xx]) n++;
          }
        }
        if (n < minNeighbors) dst[i] = 0;
      }
    }
    return dst;
  }

  function majoritySmooth(px, w, h){
    const src = new Uint8Array(px);
    const dst = new Uint8Array(px);
    for(let y=1;y<h-1;y++){
      for(let x=1;x<w-1;x++){
        let n=0;
        for(let yy=y-1;yy<=y+1;yy++) for(let xx=x-1;xx<=x+1;xx++) if(src[yy*w+xx]) n++;
        const i=y*w+x;
        if(src[i] && n <= 2) dst[i]=0;
        else if(!src[i] && n >= 7) dst[i]=1;
      }
    }
    return dst;
  }

  function textThreshold(g, w, h, threshold, clean){
    const out = new Uint8Array(w*h);
    const r = Math.max(1, Math.min(4, Math.floor(Math.min(w,h)/8) || 2));

    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        let sum=0, cnt=0, mn=255, mx=0;
        for(let yy=Math.max(0,y-r); yy<=Math.min(h-1,y+r); yy++){
          for(let xx=Math.max(0,x-r); xx<=Math.min(w-1,x+r); xx++){
            const v=g[yy*w+xx];
            sum+=v; cnt++;
            if(v<mn) mn=v;
            if(v>mx) mx=v;
          }
        }
        const local=sum/cnt;
        const contrast=mx-mn;
        const t = contrast > 28 ? (local - 10) : threshold;
        out[y*w+x] = g[y*w+x] < t ? 1 : 0;
      }
    }

    return majoritySmooth(cleanupNoise(out,w,h,clean),w,h);
  }

  function convertImageToPixels(imageData, w, h, opts){
    opts = opts || {};
    const mode = opts.mode || 'text';
    const threshold = Math.max(0, Math.min(255, parseInt(opts.threshold ?? 128) || 128));
    const contrast = parseFloat(opts.contrast ?? 1.15);
    const gamma = parseFloat(opts.gamma ?? 1.0);
    const clean = parseInt(opts.clean ?? 2);
    const g = grayArray(imageData, w, h, contrast, gamma);
    const out = new Uint8Array(w * h);

    if (mode === 'text' || mode === 'auto') {
      return textThreshold(g, w, h, threshold, clean);
    }

    if (mode === 'floyd') {
      const e = new Float32Array(g);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const old = e[i];
          const nv = old < threshold ? 0 : 255;
          out[i] = nv === 0 ? 1 : 0;
          const err = old - nv;
          if (x + 1 < w) e[i + 1] += err * 7 / 16;
          if (y + 1 < h) {
            if (x > 0) e[i + w - 1] += err * 3 / 16;
            e[i + w] += err * 5 / 16;
            if (x + 1 < w) e[i + w + 1] += err * 1 / 16;
          }
        }
      }
      return cleanupNoise(out, w, h, clean);
    }

    if (mode === 'ordered') {
      const b = [0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const t = threshold + (b[(y & 3) * 4 + (x & 3)] - 7.5) * 10;
          out[i] = g[i] < t ? 1 : 0;
        }
      }
      return cleanupNoise(out, w, h, clean);
    }

    if (mode === 'adaptive') {
      return textThreshold(g, w, h, threshold, clean);
    }

    for (let i = 0; i < w * h; i++) out[i] = g[i] < threshold ? 1 : 0;
    return cleanupNoise(out, w, h, clean);
  }

  window.rbConvertImageToOledPixels = convertImageToPixels;

  function getWorkspace(){
    try { return window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace()); }
    catch(_) { return null; }
  }

  function drawPreviewCanvas(canvas, px, w, h){
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    canvas.width = w;
    canvas.height = h;
    ctx.fillStyle = '#0b1326';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9aa5ff';
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) if(px[y*w+x]) ctx.fillRect(x,y,1,1);
  }

  FieldPaintGrid.prototype._showCropper = function(dataUrl){
    const self = this;
    const aW = this.cols || 32;
    const aH = this.rows || 16;

    let modal = document.getElementById('_pgCropModal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = '_pgCropModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(2,6,23,.92);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;color:#e2e8f0;font-family:Arial,sans-serif';

    const card = document.createElement('div');
    card.style.cssText = 'width:min(1100px,96vw);max-height:92vh;background:#0f172a;border:1px solid #334155;border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.55);padding:14px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box';
    modal.appendChild(card);

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
    top.innerHTML = '<div><div style="font:800 15px Arial;color:#fecaca">Фото → OLED пікселі</div><div style="font:11px Arial;color:#94a3b8;margin-top:2px">Для букв і логотипів використовуй режим «Текст/лого». Floyd лишений для фото, але може давати зерно.</div></div>';
    const xbtn = document.createElement('button');
    xbtn.textContent = '×';
    xbtn.style.cssText = 'width:34px;height:34px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font:800 20px Arial;cursor:pointer';
    xbtn.onclick = () => modal.remove();
    top.appendChild(xbtn);
    card.appendChild(top);

    const body = document.createElement('div');
    body.style.cssText = 'display:grid;grid-template-columns:minmax(360px,1fr) 260px;gap:12px;min-height:0';
    card.appendChild(body);

    const left = document.createElement('div');
    left.style.cssText = 'background:#020617;border:1px solid #1e293b;border-radius:12px;padding:10px;display:flex;align-items:center;justify-content:center;min-height:260px;overflow:hidden';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;max-width:100%;max-height:56vh;border-radius:8px;background:#0b1326';
    left.appendChild(canvas);
    body.appendChild(left);

    const side = document.createElement('div');
    side.style.cssText = 'background:#020617;border:1px solid #334155;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px';
    body.appendChild(side);

    const pvTitle = document.createElement('div');
    pvTitle.style.cssText = 'font:800 13px Arial;color:#cbd5e1;text-align:center';
    pvTitle.textContent = 'Попередній перегляд';
    side.appendChild(pvTitle);

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = aW;
    previewCanvas.height = aH;
    previewCanvas.style.cssText = 'width:100%;image-rendering:pixelated;background:#0b1326;border:1px solid #334155;border-radius:8px';
    side.appendChild(previewCanvas);

    const previewInfo = document.createElement('div');
    previewInfo.style.cssText = 'font:11px monospace;color:#94a3b8;text-align:center';
    previewInfo.textContent = aW + '×' + aH;
    side.appendChild(previewInfo);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;background:#020617;border:1px solid #1e293b;border-radius:12px;padding:12px';
    card.appendChild(controls);

    function makeLabel(text){
      const l = document.createElement('label');
      l.style.cssText = 'display:flex;flex-direction:column;gap:5px;font:11px Arial;color:#94a3b8';
      const s = document.createElement('span');
      s.textContent = text;
      l.appendChild(s);
      return l;
    }

    const methodLabel = makeLabel('Метод');
    const mode = document.createElement('select');
    mode.style.cssText = 'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:9px;padding:8px;outline:none';
    mode.innerHTML = '<option value="text" selected>Текст/лого</option><option value="threshold">Чіткий поріг</option><option value="adaptive">Adaptive</option><option value="floyd">Фото Floyd</option><option value="ordered">Ordered</option>';
    methodLabel.appendChild(mode);
    controls.appendChild(methodLabel);

    function addRange(label, min, max, val, step){
      const l = makeLabel(label);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px';
      const r = document.createElement('input');
      r.type = 'range'; r.min = min; r.max = max; r.step = step || 1; r.value = val;
      r.style.cssText = 'flex:1;accent-color:#ef4444';
      const v = document.createElement('span');
      v.style.cssText = 'font:11px monospace;color:#fecaca;width:38px;text-align:right';
      v.textContent = String(val);
      r.oninput = () => { v.textContent = r.value; preview(); };
      row.appendChild(r); row.appendChild(v); l.appendChild(row); controls.appendChild(l);
      return r;
    }

    const threshold = addRange('Поріг', 0, 255, 128, 1);
    const contrast = addRange('Контраст', 0.5, 2.5, 1.15, 0.05);
    const gamma = addRange('Гамма', 0.5, 2.2, 1.0, 0.05);
    const clean = addRange('Прибрати шум', 0, 5, 2, 1);
    mode.onchange = () => {
      if(mode.value === 'floyd'){ clean.value = 2; contrast.value = 1.15; }
      if(mode.value === 'text'){ clean.value = 2; contrast.value = 1.15; gamma.value = 1.0; }
      preview();
    };

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:center;gap:10px';
    card.appendChild(btns);

    function btn(text, bg, fn){
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'min-width:130px;padding:10px 18px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:'+bg+';color:white;font:800 13px Arial;cursor:pointer';
      b.onclick = fn;
      return b;
    }

    btns.appendChild(btn('Скасувати', '#374151', () => modal.remove()));
    const convertBtn = btn('✓ У пікселі', '#059669', () => {});
    btns.appendChild(convertBtn);

    const responsive = document.createElement('style');
    responsive.textContent = '@media(max-width:820px){#_pgCropModal .rb-photo-body{grid-template-columns:1fr!important}.rb-photo-controls{grid-template-columns:1fr!important}}';
    body.className = 'rb-photo-body';
    controls.className = 'rb-photo-controls';
    modal.appendChild(responsive);

    document.body.appendChild(modal);

    const img = new Image();
    let cW=0,cH=0,rX=0,rY=0,rW=0,rH=0;
    let drag=false, resize=false, sx0=0, sy0=0, ox=0, oy=0;
    let lastPixels=null;
    const HND=18;

    function options(){
      return {
        mode: mode.value,
        threshold: threshold.value,
        contrast: contrast.value,
        gamma: gamma.value,
        clean: clean.value
      };
    }

    function cropImageData(){
      const off = document.createElement('canvas');
      off.width = aW;
      off.height = aH;
      const oc = off.getContext('2d');
      const sx = img.width / cW;
      const sy = img.height / cH;
      oc.imageSmoothingEnabled = true;
      oc.imageSmoothingQuality = 'high';
      oc.drawImage(img, rX*sx, rY*sy, rW*sx, rH*sy, 0, 0, aW, aH);
      return oc.getImageData(0,0,aW,aH);
    }

    function drawBase(){
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,cW,cH);
      ctx.drawImage(img,0,0,cW,cH);
      ctx.fillStyle='rgba(0,0,0,.55)';
      ctx.fillRect(0,0,cW,rY);
      ctx.fillRect(0,rY+rH,cW,cH-rY-rH);
      ctx.fillRect(0,rY,rX,rH);
      ctx.fillRect(rX+rW,rY,cW-rX-rW,rH);

      ctx.strokeStyle='#ef4444';
      ctx.lineWidth=3;
      ctx.strokeRect(rX+1.5,rY+1.5,rW-3,rH-3);
      ctx.fillStyle='#ef4444';
      ctx.fillRect(rX+rW-HND,rY+rH-HND,HND,HND);
      ctx.fillStyle='rgba(239,68,68,.92)';
      ctx.fillRect(rX,rY,86,18);
      ctx.fillStyle='white';
      ctx.font='11px monospace';
      ctx.fillText(aW+'×'+aH,rX+5,rY+13);
    }

    function preview(){
      if(!cW) return;
      drawBase();
      const data = cropImageData();
      const px = convertImageToPixels(data,aW,aH,options());
      lastPixels = px;
      drawPreviewCanvas(previewCanvas,px,aW,aH);
      let count=0;
      for(let i=0;i<px.length;i++) if(px[i]) count++;
      previewInfo.textContent = aW+'×'+aH+' · '+count+' пікс.';
    }

    function pos(e){
      const r=canvas.getBoundingClientRect();
      const p=e.touches?e.touches[0]:e;
      return {x:p.clientX-r.left,y:p.clientY-r.top};
    }

    function down(e){
      e.preventDefault();
      const p=pos(e);
      if(p.x>=rX+rW-HND&&p.x<=rX+rW&&p.y>=rY+rH-HND&&p.y<=rY+rH) resize=true;
      else if(p.x>=rX&&p.x<=rX+rW&&p.y>=rY&&p.y<=rY+rH){drag=true;sx0=p.x;sy0=p.y;ox=rX;oy=rY;}
    }

    function move(e){
      if(!drag&&!resize) return;
      e.preventDefault();
      const p=pos(e), asp=aW/aH;
      if(drag){
        rX=Math.max(0,Math.min(cW-rW,ox+p.x-sx0));
        rY=Math.max(0,Math.min(cH-rH,oy+p.y-sy0));
      }else{
        let nW=Math.max(24,p.x-rX), nH=Math.max(12,p.y-rY);
        if(nW/nH>asp)nH=nW/asp;else nW=nH*asp;
        rW=Math.min(Math.round(nW),cW-rX);
        rH=Math.min(Math.round(rW/asp),cH-rY);
        rW=Math.round(rH*asp);
      }
      preview();
    }

    function up(){ drag=false; resize=false; }

    img.onload = () => {
      const maxW=Math.min(720,window.innerWidth*.62);
      const maxH=Math.min(470,window.innerHeight*.55);
      cW=img.width; cH=img.height;
      if(cW>maxW){cH=cH*maxW/cW;cW=maxW;}
      if(cH>maxH){cW=cW*maxH/cH;cH=maxH;}
      cW=Math.round(cW); cH=Math.round(cH);
      canvas.width=cW; canvas.height=cH;
      canvas.style.width=cW+'px'; canvas.style.height=cH+'px';

      const asp=aW/aH;
      if(cW/cH>asp){rH=cH*.82;rW=rH*asp;}else{rW=cW*.82;rH=rW/asp;}
      rW=Math.round(rW); rH=Math.round(rH);
      rX=Math.round((cW-rW)/2); rY=Math.round((cH-rH)/2);

      canvas.addEventListener('mousedown',down);
      window.addEventListener('mousemove',move);
      window.addEventListener('mouseup',up);
      canvas.addEventListener('touchstart',down,{passive:false});
      canvas.addEventListener('touchmove',move,{passive:false});
      canvas.addEventListener('touchend',up,{passive:false});
      preview();
    };

    convertBtn.onclick = () => {
      const px = lastPixels || convertImageToPixels(cropImageData(),aW,aH,options());
      self._imgCropData = { previewPixels:px, options:options(), cw:aW, ch:aH };
      setField(self,self.scale||4,px);
      modal.remove();
    };

    img.src=dataUrl;
  };

  function setFrameVal(ws, idx, val){
    if(!ws||!ws.getAllBlocks) return false;
    let ok=false;
    ws.getAllBlocks(false).forEach(b=>{
      if(b.type==='disp_anim_frame' && parseInt(b.getFieldValue('IDX'))===idx){
        const f=b.getField('GRID');
        if(f){f.setValue(val); if(f._rbInlineRedraw) f._rbInlineRedraw(); ok=true;}
      }
    });
    return ok;
  }

  async function importVideo(file, field){
    const url=URL.createObjectURL(file);
    const video=document.createElement('video');
    video.src=url; video.muted=true; video.playsInline=true; video.preload='metadata';
    const note=document.createElement('div');
    note.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;color:white;font:700 14px Arial';
    note.textContent='Імпорт відео: 1 кадр/сек...';
    document.body.appendChild(note);
    try{
      await new Promise((res,rej)=>{video.onloadedmetadata=res;video.onerror=rej;});
      const block=field.sourceBlock_;
      const startIdx=block&&block.type==='disp_anim_frame'?(parseInt(block.getFieldValue('IDX'))||0):0;
      const ws=block&&block.workspace||getWorkspace();
      const d=dims(field.scale||4);
      const c=document.createElement('canvas'); c.width=d.cols; c.height=d.rows;
      const ctx=c.getContext('2d');
      const maxFrames=Math.min(10-startIdx,Math.max(1,Math.floor(video.duration||1)+1));
      window.rbOledFrameStore=window.rbOledFrameStore||{};
      for(let k=0;k<maxFrames;k++){
        video.currentTime=Math.min(k,Math.max(0,(video.duration||1)-0.05));
        await new Promise(res=>{video.onseeked=res;});
        ctx.drawImage(video,0,0,d.cols,d.rows);
        const px=convertImageToPixels(ctx.getImageData(0,0,d.cols,d.rows),d.cols,d.rows,{mode:'text',threshold:128,contrast:1.15,gamma:1,clean:2});
        const val=ser(field.scale||4,px);
        window.rbOledFrameStore[startIdx+k]=val;
        setFrameVal(ws,startIdx+k,val);
        if(k===0) setField(field,field.scale||4,px);
      }
    }catch(e){console.warn('video import failed',e);}
    finally{URL.revokeObjectURL(url);note.remove();}
  }

  FieldPaintGrid.prototype._openVideoImportModal = function(){
    const field=this;
    let inp=document.getElementById('_pgVideoInput');
    if(!inp){
      inp=document.createElement('input');
      inp.type='file';
      inp.accept='video/*';
      inp.id='_pgVideoInput';
      inp.style.cssText='position:fixed;opacity:0;pointer-events:none;top:0;left:0';
      document.body.appendChild(inp);
    }
    inp.value='';
    inp.onchange=e=>{const f=e.target.files&&e.target.files[0]; if(f) importVideo(f,field);};
    inp.click();
  };

  function addSmallVideoButton(field){
    try{
      if(!field||!field.sourceBlock_||field.sourceBlock_.type!=='disp_anim_frame') return;
      const group=field.fieldGroup_;
      if(!group||!group.querySelector) return;
      const tools=group.querySelector('.rb-oled-tools');
      if(!tools||tools.querySelector('[data-act="video"]')) return;
      const right=tools.querySelector('.rb-oled-group.push')||tools.lastElementChild||tools;
      const btn=document.createElement('button');
      btn.className='rb-oled-btn photo';
      btn.setAttribute('data-act','video');
      btn.title='Відео: 1 кадр/сек';
      btn.innerHTML='🎞';
      btn.style.minWidth='32px';
      btn.style.width='32px';
      btn.style.padding='0';
      btn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();field._openVideoImportModal();});
      btn.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();});
      const photo=right.querySelector('[data-act="photo"]');
      if(photo) right.insertBefore(btn,photo);
      else right.insertBefore(btn,right.firstChild);
    }catch(e){console.warn('small video button',e);}
  }

  const oldBuild=FieldPaintGrid.prototype._build;
  FieldPaintGrid.prototype._build=function(){
    oldBuild.call(this);
    setTimeout(()=>addSmallVideoButton(this),0);
  };

  window.rbRestoreVideoButtonsNow=function(){
    try{
      const ws=getWorkspace();
      if(!ws||!ws.getAllBlocks) return;
      ws.getAllBlocks(false).forEach(b=>{
        if(b.type==='disp_anim_frame'){
          const f=b.getField('GRID');
          if(f) addSmallVideoButton(f);
        }
      });
    }catch(_){}
  };
  window.addEventListener('load',()=>[0,300,1000,2000].forEach(t=>setTimeout(window.rbRestoreVideoButtonsNow,t)));
})();



/* ================================================================
   VIDEO BUTTON ALSO IN SIMPLE PAINTER
   Додає маленьку 🎞 кнопку і в disp_paint, не тільки в disp_anim_frame.
   ================================================================ */
(function(){
  if (window.__rbVideoButtonInSimplePainter) return;
  window.__rbVideoButtonInSimplePainter = true;
  if (typeof FieldPaintGrid === 'undefined') return;

  function dims(scale){
    const s = scale || 4;
    return { cols: Math.max(1, Math.floor(128 / s)), rows: Math.max(1, Math.floor(64 / s)) };
  }

  function ser(scale, pixels){
    return scale + '|' + Array.prototype.map.call(pixels || [], v => v ? '1' : '0').join('');
  }

  function setField(field, scale, pixels){
    const d = dims(scale);
    field.scale = scale;
    field.cols = d.cols;
    field.rows = d.rows;
    field.pixels = new Uint8Array(d.cols * d.rows);
    for (let i = 0; i < field.pixels.length; i++) field.pixels[i] = pixels[i] ? 1 : 0;
    field.value_ = field._ser ? field._ser() : ser(scale, field.pixels);
    if (field._rbInlineRedraw) field._rbInlineRedraw();
    else if (field._refreshAll) field._refreshAll();
  }

  function getWorkspace(){
    try { return window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace()); }
    catch(_) { return null; }
  }

  function convertFrame(imageData, w, h){
    if (window.rbConvertImageToOledPixels) {
      return window.rbConvertImageToOledPixels(imageData, w, h, {
        mode: 'text',
        threshold: 128,
        contrast: 1.15,
        gamma: 1,
        clean: 2
      });
    }

    const out = new Uint8Array(w * h);
    const data = imageData.data;
    for (let i = 0; i < out.length; i++) {
      const j = i * 4;
      const br = data[j] * .299 + data[j + 1] * .587 + data[j + 2] * .114;
      out[i] = br < 128 ? 1 : 0;
    }
    return out;
  }

  function setFrameVal(ws, idx, val){
    if (!ws || !ws.getAllBlocks) return false;
    let ok = false;
    ws.getAllBlocks(false).forEach(b => {
      if (b.type === 'disp_anim_frame' && parseInt(b.getFieldValue('IDX')) === idx) {
        const f = b.getField('GRID');
        if (f) {
          f.setValue(val);
          if (f._rbInlineRedraw) f._rbInlineRedraw();
          ok = true;
        }
      }
    });
    return ok;
  }

  async function importVideo(file, field){
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';

    const note = document.createElement('div');
    note.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;color:white;font:700 14px Arial';
    note.textContent = 'Імпорт відео: 1 кадр/сек...';
    document.body.appendChild(note);

    try {
      await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = rej; });

      const block = field.sourceBlock_;
      const isAnim = block && block.type === 'disp_anim_frame';
      const startIdx = isAnim ? (parseInt(block.getFieldValue('IDX')) || 0) : 0;
      const ws = block && block.workspace || getWorkspace();

      const d = dims(field.scale || 4);
      const canvas = document.createElement('canvas');
      canvas.width = d.cols;
      canvas.height = d.rows;
      const ctx = canvas.getContext('2d');

      const maxFrames = Math.min(10 - startIdx, Math.max(1, Math.floor(video.duration || 1) + 1));
      window.rbOledFrameStore = window.rbOledFrameStore || {};

      for (let k = 0; k < maxFrames; k++) {
        video.currentTime = Math.min(k, Math.max(0, (video.duration || 1) - 0.05));
        await new Promise(res => { video.onseeked = res; });

        ctx.drawImage(video, 0, 0, d.cols, d.rows);
        const px = convertFrame(ctx.getImageData(0, 0, d.cols, d.rows), d.cols, d.rows);
        const val = ser(field.scale || 4, px);

        // У простій малювалці завжди вставляємо перший кадр у сам блок.
        // Якщо це кадр анімації — теж перший кадр показується в поточному блоці.
        if (k === 0) setField(field, field.scale || 4, px);

        // Якщо у workspace є блоки кадрів анімації — додатково розкладаємо туди.
        window.rbOledFrameStore[startIdx + k] = val;
        setFrameVal(ws, startIdx + k, val);
      }
    } catch(e) {
      console.warn('video import failed', e);
    } finally {
      URL.revokeObjectURL(url);
      note.remove();
    }
  }

  FieldPaintGrid.prototype._openVideoImportModal = function(){
    const field = this;
    let inp = document.getElementById('_pgVideoInput');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'video/*';
      inp.id = '_pgVideoInput';
      inp.style.cssText = 'position:fixed;opacity:0;pointer-events:none;top:0;left:0';
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.onchange = e => {
      const f = e.target.files && e.target.files[0];
      if (f) importVideo(f, field);
    };
    inp.click();
  };

  function addVideoButton(field){
    try {
      if (!field || !field.sourceBlock_) return;
      const type = field.sourceBlock_.type;
      if (type !== 'disp_anim_frame' && type !== 'disp_paint') return;

      const group = field.fieldGroup_;
      if (!group || !group.querySelector) return;

      const tools = group.querySelector('.rb-oled-tools');
      if (!tools || tools.querySelector('[data-act="video"]')) return;

      const right = tools.querySelector('.rb-oled-group.push') || tools.lastElementChild || tools;

      const btn = document.createElement('button');
      btn.className = 'rb-oled-btn photo';
      btn.setAttribute('data-act', 'video');
      btn.title = type === 'disp_paint'
        ? 'Відео: вставити перший кадр у малювалку'
        : 'Відео: 1 кадр/сек';
      btn.innerHTML = '🎞';
      btn.style.minWidth = '32px';
      btn.style.width = '32px';
      btn.style.padding = '0';

      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        field._openVideoImportModal();
      });

      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
      });

      const photo = right.querySelector('[data-act="photo"]');
      if (photo) right.insertBefore(btn, photo);
      else right.insertBefore(btn, right.firstChild);
    } catch(e) {
      console.warn('video button simple painter', e);
    }
  }

  const oldBuild = FieldPaintGrid.prototype._build;
  FieldPaintGrid.prototype._build = function(){
    oldBuild.call(this);
    setTimeout(() => addVideoButton(this), 0);
  };

  window.rbRestoreAllVideoButtonsNow = function(){
    try {
      const ws = getWorkspace();
      if (!ws || !ws.getAllBlocks) return;
      ws.getAllBlocks(false).forEach(b => {
        if (b.type === 'disp_paint' || b.type === 'disp_anim_frame') {
          const f = b.getField('GRID');
          if (f) addVideoButton(f);
        }
      });
    } catch(_) {}
  };

  window.addEventListener('load', () => [0, 300, 1000, 2000].forEach(t => setTimeout(window.rbRestoreAllVideoButtonsNow, t)));
})();



/* ================================================================
   RELOAD FIX FOR OLED PAINTER
   Після localStorage/reload прибирає "залиплу" фото-підкладку/прозорий canvas.
   ================================================================ */
(function(){
  if (window.__rbOledPainterReloadOverlayFix) return;
  window.__rbOledPainterReloadOverlayFix = true;
  if (typeof FieldPaintGrid === 'undefined') return;

  function isPainterField(field){
    try{
      const t = field && field.sourceBlock_ && field.sourceBlock_.type;
      return t === 'disp_paint' || t === 'disp_anim_frame';
    }catch(_){ return false; }
  }

  function normalizeCanvas(field){
    try{
      if(!field || !field.fieldGroup_ || !field.fieldGroup_.querySelector) return;
      if(!isPainterField(field)) return;

      const fo = field.fieldGroup_.querySelector('foreignObject');
      const editor = fo && fo.querySelector('.rb-oled-editor');
      const box = editor && editor.querySelector('.rb-oled-canvasBox');
      if(!box) return;

      const img = box.querySelector('.rb-oled-photo-bg');
      const canvas = box.querySelector('canvas');

      // Якщо фото не було накладене в цій сесії — прибрати стару/порожню підкладку.
      if(!field._imgDataUrl){
        if(img) img.remove();
        if(canvas){
          canvas.style.position = '';
          canvas.style.zIndex = '';
          canvas.style.background = '#0b1326';
          canvas.style.opacity = '1';
          canvas.style.mixBlendMode = '';
        }
        box.style.background = '#0b1326';
      }else{
        // Якщо фото є, показати як підкладку, але не ламати canvas.
        let bg = img;
        if(!bg){
          bg = document.createElement('img');
          bg.className = 'rb-oled-photo-bg';
          bg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;opacity:.34;pointer-events:none;image-rendering:auto;z-index:0';
          box.insertBefore(bg, box.firstChild);
        }
        bg.src = field._imgDataUrl;
        bg.style.display = '';
        if(canvas){
          canvas.style.position = 'relative';
          canvas.style.zIndex = '1';
          canvas.style.background = 'transparent';
        }
      }

      if(field._rbInlineRedraw) field._rbInlineRedraw();
    }catch(e){
      console.warn('reload overlay fix', e);
    }
  }

  const oldBuild = FieldPaintGrid.prototype._build;
  FieldPaintGrid.prototype._build = function(){
    oldBuild.call(this);
    setTimeout(() => normalizeCanvas(this), 0);
    setTimeout(() => normalizeCanvas(this), 200);
  };

  const oldSetValue = FieldPaintGrid.prototype.setValue;
  FieldPaintGrid.prototype.setValue = function(v){
    if(oldSetValue) oldSetValue.call(this, v);
    else{
      this.value_ = v || '';
      if(this._load) this._load(v);
    }

    // Важливо: serialized GRID містить тільки 0/1 пікселі, не фото.
    // Тому після reload не переносимо _imgDataUrl.
    if(!this._imgDataUrl) this._imgCropData = null;

    setTimeout(() => normalizeCanvas(this), 0);
  };

  function normalizeAll(){
    try{
      const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
      if(!ws || !ws.getAllBlocks) return;
      ws.getAllBlocks(false).forEach(b=>{
        const f = b.getField && b.getField('GRID');
        if(f) normalizeCanvas(f);
      });
    }catch(_){}
  }

  window.rbNormalizeOledPainters = normalizeAll;
  window.addEventListener('load', () => [0,100,500,1200,2500].forEach(t => setTimeout(normalizeAll, t)));
})();



/* ================================================================
   OLED PAINTER SAVE FIX
   Змушує Blockly/autosave бачити зміни field_paint_grid.
   Інакше намальоване могло бути в полі візуально, але не потрапляти в localStorage.
   ================================================================ */
(function(){
  if (window.__rbOledPainterSaveFix) return;
  window.__rbOledPainterSaveFix = true;
  if (typeof FieldPaintGrid === 'undefined') return;

  function isPaintField(field){
    try {
      const t = field && field.sourceBlock_ && field.sourceBlock_.type;
      return t === 'disp_paint' || t === 'disp_anim_frame';
    } catch(_) {
      return false;
    }
  }

  function fieldValue(field){
    try {
      if (!field) return '';
      if (typeof field._ser === 'function') return field._ser();
      if (typeof field.getValue === 'function') return field.getValue();
      return field.value_ || '';
    } catch(_) {
      return field && field.value_ || '';
    }
  }

  function fireFieldChange(field, oldValue, newValue){
    try {
      if (!field || !field.sourceBlock_ || !field.name) return;
      if (oldValue === newValue) return;

      field.value_ = newValue;

      if (window.Blockly && Blockly.Events && Blockly.Events.isEnabled && Blockly.Events.isEnabled()) {
        const ev = new Blockly.Events.BlockChange(
          field.sourceBlock_,
          'field',
          field.name,
          oldValue,
          newValue
        );
        Blockly.Events.fire(ev);
      }

      // Підстраховка для самописного автосейву, якщо він слухає не Blockly.Events.
      const ws = field.sourceBlock_.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
      if (ws && typeof ws.fireChangeListener === 'function') {
        try { ws.fireChangeListener({ type:'change', blockId:field.sourceBlock_.id }); } catch(_) {}
      }

      window.dispatchEvent(new CustomEvent('rb-oled-painter-change', {
        detail: {
          blockId: field.sourceBlock_.id,
          field: field.name,
          value: newValue
        }
      }));
    } catch(e) {
      console.warn('OLED save event failed', e);
    }
  }

  function commitField(field){
    if (!isPaintField(field)) return;
    const newValue = fieldValue(field);
    const oldValue = field.__rbLastCommittedValue;
    if (oldValue === undefined) {
      field.__rbLastCommittedValue = newValue;
      return;
    }
    if (oldValue !== newValue) {
      fireFieldChange(field, oldValue, newValue);
      field.__rbLastCommittedValue = newValue;
    }
  }

  function scanAll(){
    try {
      const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
      if (!ws || !ws.getAllBlocks) return;
      ws.getAllBlocks(false).forEach(block => {
        const f = block.getField && block.getField('GRID');
        if (f) commitField(f);
      });
    } catch(_) {}
  }

  // Ініціалізація останнього збереженого значення після побудови поля.
  const oldBuild = FieldPaintGrid.prototype._build;
  FieldPaintGrid.prototype._build = function(){
    oldBuild.call(this);
    setTimeout(() => {
      if (isPaintField(this)) this.__rbLastCommittedValue = fieldValue(this);
    }, 0);
  };

  // Якщо хтось викликає setValue — оновити tracking.
  const oldSetValue = FieldPaintGrid.prototype.setValue;
  FieldPaintGrid.prototype.setValue = function(v){
    const before = fieldValue(this);
    if (oldSetValue) oldSetValue.call(this, v);
    else {
      this.value_ = v || '';
      if (this._load) this._load(v);
    }
    const after = fieldValue(this);
    this.__rbLastCommittedValue = after;
    if (before !== after && this._rbInlineRedraw) setTimeout(() => this._rbInlineRedraw(), 0);
  };

  // На завершення дії користувача примусово commit.
  ['pointerup','mouseup','touchend','click','change','input'].forEach(ev => {
    document.addEventListener(ev, () => setTimeout(scanAll, 0), true);
  });

  // Підстраховка: якщо малював довго і автосейв по таймеру — теж не загубиться.
  setInterval(scanAll, 800);

  window.rbCommitOledPainters = scanAll;
})();


/* ================================================================
   TOOLBOX XML
   ================================================================ */
window.DISPLAY_CATEGORY=`
<category name="\uD83D\uDDA5\uFE0F Дисплей" colour="#2563eb">
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
  {"type":"disp_clear","message0":"\uD83D\uDDA5\uFE0F очистити екран","previousStatement":null,"nextStatement":null,"colour":"#2563eb","tooltip":"\u0421\u0442\u0438\u0440\u0430\u0454 \u0432\u0435\u0441\u044c \u0435\u043a\u0440\u0430\u043d \u2014 \u0432\u0441\u0456 \u043f\u0456\u043a\u0441\u0435\u043b\u0456 \u0433\u0430\u0441\u044f\u0442\u044c\u0441\u044f"},
  {"type":"disp_hud","message0":"\uD83D\uDCF1 стандартний екран","previousStatement":null,"nextStatement":null,"colour":"#2563eb","tooltip":"Повертає стандартний HUD екран"},
  {"type":"disp_send","message0":"\uD83D\uDCE4 відправити на екран","previousStatement":null,"nextStatement":null,"colour":"#2563eb","tooltip":"RLE-стиснення + BT відправка на STM32"},
  {"type":"disp_fill","message0":"\u2588 заповнити екран","previousStatement":null,"nextStatement":null,"colour":"#2563eb","tooltip":"\u0417\u0430\u043f\u043e\u0432\u043d\u044e\u0454 \u0432\u0435\u0441\u044c \u0435\u043a\u0440\u0430\u043d \u2014 \u0432\u0441\u0456 8192 \u043f\u0456\u043a\u0441\u0435\u043b\u0456 \u0432\u043c\u0438\u043a\u0430\u044e\u0442\u044c\u0441\u044f"},
  {"type":"disp_text","message0":"\uD83D\uDDA5\uFE0F текст %1 %2 X %3 Y %4",
   "args0":[{"type":"field_input","name":"TXT","text":"Привіт"},{"type":"field_dropdown","name":"SIZE","options":[["малий","small"],["великий","big"]]},
            {"type":"input_value","name":"X","check":"Number"},{"type":"input_value","name":"Y","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#2563eb","tooltip":"\u0412\u0438\u0432\u043e\u0434\u0438\u0442\u044c \u0442\u0435\u043a\u0441\u0442. X,Y \u2014 \u043f\u043e\u0437\u0438\u0446\u0456\u044f \u043b\u0456\u0432\u043e\u0433\u043e \u0432\u0435\u0440\u0445\u043d\u044c\u043e\u0433\u043e \u043a\u0443\u0442\u0430"},
  {"type":"disp_number","message0":"\uD83D\uDDA5\uFE0F число %1 X %2 Y %3",
   "args0":[{"type":"input_value","name":"VAL","check":"Number"},{"type":"input_value","name":"X","check":"Number"},{"type":"input_value","name":"Y","check":"Number"}],
   "inputsInline":true,"previousStatement":null,"nextStatement":null,"colour":"#2563eb","tooltip":"\u0412\u0438\u0432\u043e\u0434\u0438\u0442\u044c \u0447\u0438\u0441\u043b\u043e \u0446\u0438\u0444\u0440\u0430\u043c\u0438 \u043d\u0430 \u0435\u043a\u0440\u0430\u043d\u0456"},
  {"type":"disp_smile","message0":"\uD83D\uDDA5\uFE0F смайл %1",
   "args0":[{"type":"field_dropdown","name":"FACE","options":[["😊","happy"],["😢","sad"],["⚡","bolt"],["❓","question"],["✓","check"]]}],
   "previousStatement":null,"nextStatement":null,"colour":"#2563eb","tooltip":"\u041c\u0430\u043b\u044e\u0454 \u0441\u043c\u0430\u0439\u043b\u0438\u043a \u043f\u043e \u0446\u0435\u043d\u0442\u0440\u0443: \u0443\u0441\u043c\u0456\u0445\u043d\u0435\u043d\u0438\u0439, \u0441\u0443\u043c\u043d\u0438\u0439 \u0430\u0431\u043e \u043d\u0435\u0439\u0442\u0440\u0430\u043b\u044c\u043d\u0438\u0439"},

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
  {"type":"disp_paint","message0":"%1",
   "args0":[{"type":"field_paint_grid","name":"GRID"}],
   "previousStatement":null,"nextStatement":null,"colour":"#2563eb","tooltip":"\u0412\u0438\u0432\u043e\u0434\u0438\u0442\u044c \u043d\u0430\u043c\u0430\u043b\u044c\u043e\u0432\u0430\u043d\u0435 \u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u043d\u044f \u043f\u0456\u043a\u0441\u0435\u043b\u044f\u043c\u0438 \u043d\u0430 \u0435\u043a\u0440\u0430\u043d\u0456"},

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


/* RB OLED PAINTER FORCE VALUE FIX */
(function(){
  if (window.__rbOledPainterForceValueFix) return;
  window.__rbOledPainterForceValueFix = true;
  function isPaintField(f){
    try{ return f && f.sourceBlock_ && (f.sourceBlock_.type === 'disp_paint' || f.sourceBlock_.type === 'disp_anim_frame'); }
    catch(e){ return false; }
  }
  function currentValue(f){
    try{
      if(f && typeof f._ser === 'function') return f._ser();
      if(f && typeof f.getValue === 'function') return f.getValue();
      return f && f.value_ || '';
    }catch(e){ return f && f.value_ || ''; }
  }
  const oldGetValue = FieldPaintGrid.prototype.getValue;
  FieldPaintGrid.prototype.getValue = function(){
    if(isPaintField(this)){
      this.value_ = currentValue(this);
      return this.value_;
    }
    return oldGetValue ? oldGetValue.call(this) : (this.value_ || '');
  };
  window.rbCommitOledFields = function(){
    try{
      const w = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
      if(!w || !w.getAllBlocks) return;
      w.getAllBlocks(false).forEach(block => {
        const f = block.getField && block.getField('GRID');
        if(f) f.value_ = currentValue(f);
      });
    }catch(e){}
  };
})();
