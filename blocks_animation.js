/* One animation block, ten independent drawing fields. Legacy frame blocks stay compatible. */
(function(){
  'use strict';
  const B=window.Blockly,G=window.javascript?.javascriptGenerator||B?.JavaScript;
  if(!B||!G)return;
  const Grid=FieldPaintGrid;
  const icon=(text,active=false)=>'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="1" y="1" width="30" height="30" rx="7" fill="${active?'#fff':'#d1fae5'}" stroke="#047857"/><text x="16" y="22" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="16" fill="#064e3b">${text}</text></svg>`);
  function show(block){
    if(!block.workspace)return;
    const count=Number(block.getFieldValue('COUNT'))||2;
    const selected=Math.min(count-1,Math.max(0,Number(block.getFieldValue('FRAME'))||0));
    if(String(selected)!==block.getFieldValue('FRAME'))block.setFieldValue(String(selected),'FRAME');
    for(let i=0;i<10;i++){
      block.getInput('DRAW'+i).setVisible(i===selected);
      block.getField('TAB'+i)?.setValue(icon(i+1,i===selected));
    }
    if(block.rendered)block.render();
    const field=block.getField('GRID'+selected);
    if(field?._rbInlineRedraw)requestAnimationFrame(()=>field._rbInlineRedraw());
  }
  function later(block){setTimeout(()=>show(block),0);}
  function preview(block){
    document.getElementById('rb-animation-preview')?.close();
    const frames=Array.from({length:Number(block.getFieldValue('COUNT'))||2},(_,i)=>block.getFieldValue('GRID'+i));
    const delay=Math.max(50,Number(block.getFieldValue('SEC'))*1000||100);
    const dialog=document.createElement('dialog');dialog.id='rb-animation-preview';
    dialog.style.cssText='background:#0f172a;color:white;border:1px solid #64748b;border-radius:16px;padding:20px;max-width:90vw';
    const title=document.createElement('h3');title.textContent='Перегляд анімації';dialog.append(title);
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=64;canvas.style.cssText='width:min(512px,75vw);image-rendering:pixelated;display:block;border:1px solid #475569;border-radius:6px';dialog.append(canvas);
    const label=document.createElement('p');dialog.append(label);
    const close=document.createElement('button');close.textContent='Закрити';close.style.cssText='padding:10px 20px;border-radius:8px;border:0;cursor:pointer';dialog.append(close);
    let current=0,timer;const ctx=canvas.getContext('2d');
    const draw=()=>{const value=frames[current]||'4|',parts=value.split('|'),s=Number(parts[0])||4,cols=128/s,bits=parts[1]||'';ctx.fillStyle='#080e1c';ctx.fillRect(0,0,128,64);ctx.fillStyle='#c7d2fe';for(let i=0;i<bits.length;i++)if(bits[i]==='1')ctx.fillRect(i%cols*s,Math.floor(i/cols)*s,s,s);label.textContent=`Кадр ${current+1} із ${frames.length} · ${delay/1000} с`;current=(current+1)%frames.length;};
    close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{clearInterval(timer);dialog.remove();});
    document.body.append(dialog);dialog.showModal();draw();timer=setInterval(draw,delay);
  }
  B.Blocks.disp_animation={
    init(){
      const block=this;
      this.appendDummyInput('HEADER').appendField('🎞 Анімація · кадрів').appendField(new B.FieldNumber(2,1,10,1,function(v){later(block);return v;}),'COUNT')
        .appendField('кожні').appendField(new B.FieldNumber(.1,.05,60,.01),'SEC').appendField('с');
      this.appendDummyInput('SELECT').appendField('✏ Кадр').appendField(new B.FieldDropdown(Array.from({length:10},(_,i)=>[String(i+1),String(i)]),function(v){later(block);return v;}),'FRAME')
        .appendField(new B.FieldImage(icon('▶'),32,32,'Переглянути анімацію',()=>preview(block)),'PREVIEW');
      const tabs=this.appendDummyInput('TABS');
      for(let i=0;i<10;i++)tabs.appendField(new B.FieldImage(icon(i+1),32,32,'Кадр '+(i+1),()=>{
        if(i>=Number(block.getFieldValue('COUNT')))block.setFieldValue(String(i+1),'COUNT');
        block.setFieldValue(String(i),'FRAME');show(block);
      }),'TAB'+i);
      for(let i=0;i<10;i++)this.appendDummyInput('DRAW'+i).appendField('🎬 Кадр '+(i+1)).appendField(new Grid('4|'+'0'.repeat(512)),'GRID'+i);
      this.setPreviousStatement(true);this.setNextStatement(true);this.setColour('#059669');this.setInputsInline(false);
      this.setTooltip('Одна анімація з окремими малюнками. Обери номер, намалюй кадр і натисни ▶ для перегляду.');
      show(this);
    }
  };
  const generator=block=>{
    const count=Number(block.getFieldValue('COUNT'))||2;
    const frames=Array.from({length:count},(_,i)=>block.getFieldValue('GRID'+i));
    const ms=Math.max(50,Number(block.getFieldValue('SEC'))*1000||100);
    return `{ const frames=${JSON.stringify(frames)}; let frame=0; window.PixelEngine.startTick(${ms},async()=>{
      if(window._shouldStop)return;
      window.PixelEngine.applyBitmap(frames[frame]);await window.PixelEngine.sendFrame();frame=(frame+1)%frames.length;
    }); }\n`;
  };
  G.disp_animation=generator;G.forBlock.disp_animation=generator;
  // Explicitly refuse autonomous upload rather than silently omitting animation.
  if(window.STMCompiler){const old=STMCompiler.prototype.compileStmt;STMCompiler.prototype.compileStmt=function(block,...args){if(block?.type==='disp_animation'){if(!block.isEnabled||block.isEnabled())this.errors.push('Анімація працює при запуску з браузера. Завантаження у FRAM не підтримується.');return;}return old.call(this,block,...args);};}
  function toolbox(){
    const tool=document.getElementById('toolbox');if(!tool||tool.querySelector('block[type="disp_animation"]'))return;
    const frame=tool.querySelector('block[type="disp_anim_frame"]');if(!frame)return;
    const item=document.createElement('block');item.setAttribute('type','disp_animation');frame.parentNode.insertBefore(item,frame);
    const ws=window.workspace||B.getMainWorkspace();if(ws?.updateToolbox)ws.updateToolbox(tool);
  }
  toolbox();window.addEventListener('load',toolbox);
})();
