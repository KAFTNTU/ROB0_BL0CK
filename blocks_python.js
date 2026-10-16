/* Small Python-inspired building blocks for robot programs. */
(function(){
  'use strict';

  const B = window.Blockly;
  const G = window.javascript?.javascriptGenerator || B?.JavaScript;
  if(!B || !G) return;

  const numberInput = (name) => ({type:'input_value', name, check:'Number'});
  const definitions = [
    {
      type:'rb_map',
      message0:'🗺 Перетворити %1 з %2–%3 у %4–%5',
      args0:[numberInput('VALUE'),numberInput('IN_MIN'),numberInput('IN_MAX'),numberInput('OUT_MIN'),numberInput('OUT_MAX')],
      output:'Number', inputsInline:true, colour:'#5c81a6',
      tooltip:'Перетворює число з одного діапазону в інший. Наприклад, показник датчика у швидкість мотора.'
    },
    {
      type:'rb_modulo',
      message0:'Остача від ділення %1 на %2',
      args0:[numberInput('A'),numberInput('B')],
      output:'Number', inputsInline:true, colour:'#5c81a6',
      tooltip:'Повертає остачу від ділення. Зручно для чергування дій.'
    },
    {
      type:'rb_break',
      message0:'⏹ Перервати цикл',
      previousStatement:null, nextStatement:null, inputsInline:true, colour:'#5ba55b',
      tooltip:'Негайно зупиняє найближчий цикл. Використовуй цей блок усередині циклу.'
    },
    {
      type:'rb_break_if_stable',
      message0:'датчик %1 майже не змінюється %2 с (±%3)',
      args0:[
        {type:'field_dropdown',name:'PORT',options:[['P1','1'],['P2','2'],['P3','3'],['P4','4']]},
        numberInput('SEC'),
        numberInput('TOL')
      ],
      output:'Boolean', inputsInline:true, colour:'#5b80a5',
      tooltip:'Повертає істину, якщо датчик майже не змінюється заданий час. ± — допустиме невелике коливання показника. Працює під час запуску з браузера; для автономного FRAM потрібна підтримка прошивки.'
    }
  ];

  B.defineBlocksWithJsonArray(definitions);

  window.rbMapRange = function(value, inMin, inMax, outMin, outMax){
    const v=Number(value), a=Number(inMin), b=Number(inMax), c=Number(outMin), d=Number(outMax);
    if(![v,a,b,c,d].every(Number.isFinite)) return 0;
    if(a===b) return c;
    return (v-a)*(d-c)/(b-a)+c;
  };
  window.rbBreakSignal = function(){
    const error = new Error('RB_BREAK');
    error.__rbBreak = true;
    return error;
  };
  window.rbSensorStable = async function(port, seconds, tolerance){
    const index=Math.max(0,Math.min(3,Number(port)-1));
    const duration=Math.max(0,Number(seconds)||0)*1000;
    const allowed=Math.max(0,Number(tolerance)||0);
    const read=()=>Number(window.sensorData?.[index] ?? window.sensorValues?.[index] ?? 0);
    const motorsOn=()=>Object.values(window.motorState||{}).some(value=>Math.abs(Number(value)||0)>0);
    if(!motorsOn()) return false;
    let previous=read(), started=Date.now();
    while(Date.now()-started<duration){
      if(window._shouldStop) throw 'STOPPED';
      await new Promise(resolve=>setTimeout(resolve,100));
      if(!motorsOn()) return false;
      const current=read();
      if(!Number.isFinite(current) || Math.abs(current-previous)>allowed){
        previous=current;
        started=Date.now();
        continue;
      }
      previous=current;
    }
    return true;
  };

  const order = G.ORDER_ATOMIC ?? 0;
  const value = (block,name,fallback='0') => G.valueToCode(block,name,order) || fallback;
  function set(type, fn){ G[type]=fn; G.forBlock[type]=fn; }

  set('rb_map', block =>
    `window.rbMapRange(${value(block,'VALUE')},${value(block,'IN_MIN')},${value(block,'IN_MAX')},${value(block,'OUT_MIN')},${value(block,'OUT_MAX')})`
  );
  set('rb_modulo', block => `(${value(block,'A')} % ${value(block,'B','1')})`);

  const loopTypes = new Set([
    'loop_forever','controls_forever','controls_repeat_ext','controls_whileUntil',
    'controls_for','loop_repeat_pause','loop_every_seconds','controls_forEach'
  ]);
  function nearestLoop(block){
    let parent = block.getSurroundParent?.();
    while(parent){
      if(loopTypes.has(parent.type)) return parent.type;
      parent = parent.getSurroundParent?.();
    }
    return '';
  }
  set('rb_break', block => {
    const loop = nearestLoop(block);
    if(!loop) return `throw new Error('«Перервати цикл» потрібно розмістити всередині циклу.');\n`;
    if(loop === 'loop_every_seconds') return `throw window.rbBreakSignal();\n`;
    return 'break;\n';
  });
  set('rb_break_if_stable', block => {
    return `await window.rbSensorStable(${JSON.stringify(block.getFieldValue('PORT')||'1')},${value(block,'SEC','1')},${value(block,'TOL','2')})`;
  });

  function addToolboxBlock(category, type, values, afterType){
    if(!category || category.querySelector(`block[type="${type}"]`)) return;
    const block=document.createElement('block');
    block.setAttribute('type',type);
    for(const [name, defaultValue] of Object.entries(values||{})){
      const input=document.createElement('value'); input.setAttribute('name',name);
      const shadow=document.createElement('shadow'); shadow.setAttribute('type','math_number');
      const field=document.createElement('field'); field.setAttribute('name','NUM'); field.textContent=String(defaultValue);
      shadow.append(field); input.append(shadow); block.append(input);
    }
    const anchor=afterType && [...category.children].find(node=>node.getAttribute('type')===afterType);
    if(anchor) anchor.after(block); else category.append(block);
  }

  function addToolbox(){
    const toolbox=document.getElementById('toolbox');
    if(!toolbox || toolbox.querySelector('block[type="rb_map"]')) return;
    addToolboxBlock(toolbox.querySelector('category[name="Математика"]'),'rb_map',{VALUE:50,IN_MIN:0,IN_MAX:100,OUT_MIN:0,OUT_MAX:100});
    addToolboxBlock(toolbox.querySelector('category[name="Математика"]'),'rb_modulo',{A:5,B:2});
    addToolboxBlock(toolbox.querySelector('category[name="Цикли"]'),'rb_break');
    addToolboxBlock(toolbox.querySelector('category[name="Логіка"]'),'rb_break_if_stable',{SEC:1,TOL:10},'logic_negate');
    (window.workspace||B.getMainWorkspace?.())?.updateToolbox?.(toolbox);
  }

  addToolbox();
  window.addEventListener('load',addToolbox);
  [0,100,400,1000].forEach(delay=>setTimeout(addToolbox,delay));
})();
