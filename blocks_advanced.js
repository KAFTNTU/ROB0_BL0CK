/* Advanced actions: shared motor control, cancellation and per-run event state. */
(function(){
 'use strict';
 const B=window.Blockly,G=window.javascript?.javascriptGenerator||B?.JavaScript;
 if(!B||!G)return;
 let generation=0,once=new Set(),edges=new Map();const owners=[0,0,0,0];
 const clamp=n=>Math.max(-100,Math.min(100,Number(n)||0));
 const seconds=n=>Math.max(0,Number.isFinite(Number(n))?Number(n):0);
 function check(token){if(window._shouldStop||token!==generation)throw 'STOPPED';}
 window.rbAdvancedReset=()=>{generation++;once.clear();edges.clear();owners.forEach((_,i)=>owners[i]++);};
 window.rbAdvancedPause=async function(sec,token=generation){
  check(token);const end=Date.now()+seconds(sec)*1000;
  while(Date.now()<end){await new Promise(r=>setTimeout(r,Math.min(25,end-Date.now())));check(token);}
  check(token);
 };
 function index(ch){const n=Number(ch);if(!Number.isInteger(n)||n<1||n>4)throw Error('Обери мотор A, B, C або D.');return n-1;}
 function current(i){return clamp(window.motorState?.['m'+(i+1)]);}
 async function send(i,speed,token){
  check(token);if(typeof window.sendDrivePacket!=='function')throw Error('Керування моторами недоступне.');
  const values=[0,1,2,3].map(current);values[i]=Math.round(clamp(speed));
  const result=await window.sendDrivePacket(...values);check(token);
  if(result===false)throw Error('Не вдалося передати команду мотору.');
  window.motorState=Object.assign(window.motorState||{},Object.fromEntries(values.map((v,j)=>['m'+(j+1),v])));
 }
 window.rbMotorRamp=async function(ch,target,sec,fromZero=false){
  const token=generation,i=index(ch),owner=++owners[i],from=fromZero?0:current(i),to=clamp(target),duration=seconds(sec)*1000;
  if(fromZero)await send(i,0,token);
  if(duration===0){await send(i,to,token);return;}
  const steps=Math.max(1,Math.min(1200,Math.ceil(duration/50))),start=Date.now();
  for(let step=1;step<=steps;step++){
   await window.rbAdvancedPause(Math.max(0,(start+duration*step/steps-Date.now())/1000),token);
   if(owners[i]!==owner)return;
   await send(i,from+(to-from)*step/steps,token);
  }
 };
 window.rbMotorTimed=async function(ch,speed,sec){
  const token=generation,i=index(ch),owner=++owners[i];
  await send(i,speed,token);
  try{await window.rbAdvancedPause(sec,token);}
  finally{if(token===generation&&!window._shouldStop&&owners[i]===owner)await send(i,0,token);}
 };
 window.rbDoOnce=async function(key,body){check(generation);if(once.has(key))return;once.add(key);await body();};
 window.rbWhenRises=async function(key,value,body){check(generation);const active=!!value,previous=edges.get(key)||false;edges.set(key,active);if(active&&!previous)await body();};
 window.rbAfterDelay=async function(sec,body){const token=generation;await window.rbAdvancedPause(sec,token);await body();};
 window.rbRepeatEvery=async function(sec,body){const token=generation,period=Math.max(.025,seconds(sec));for(;;){check(token);const began=Date.now();try{await body();}catch(error){if(error&&error.__rbBreak)return;throw error;}await window.rbAdvancedPause(Math.max(.025,period-(Date.now()-began)/1000),token);}};
 window.rbWaitTimeout=async function(sec,condition,yes,no){
  const token=generation,end=Date.now()+seconds(sec)*1000;
  for(;;){check(token);if(condition()){await yes();return true;}if(Date.now()>=end){await no();return false;}await window.rbAdvancedPause(Math.min(.025,(end-Date.now())/1000),token);}
 };
 const motor={type:'field_dropdown',name:'MOTOR',options:[['A','1'],['B','2'],['C','3'],['D','4']]};
 const value=name=>({type:'input_value',name,check:'Number'}),statement=name=>({type:'input_statement',name});
 function definition(type,message,args,colour,tooltip){return {type,message0:message,args0:args,previousStatement:null,nextStatement:null,inputsInline:true,colour,tooltip};}
 const definitions=[
  definition('run_once','☝ Виконати 1 раз %1',[statement('DO')],'#5BA55B','Вкладені команди виконуються лише один раз за запуск програми, навіть у циклі. Новий запуск скидає стан.'),
  definition('motor_soft_start','↗ Плавний старт мотора %1 до %2 % за %3 с',[motor,value('SPEED'),value('SEC')],'#244fa8','Розгін вибраного мотора від нуля. Інші мотори не змінюються. Від’ємна швидкість — зворотний напрямок.'),
  definition('motor_soft_stop','↘ Плавно зупинити мотор %1 за %2 с',[motor,value('SEC')],'#244fa8','Поступове зменшення останньої заданої швидкості вибраного мотора до нуля. Це не механічне гальмо.'),
  definition('motor_soft_change','∿ Плавно змінити мотор %1 до %2 % за %3 с',[motor,value('SPEED'),value('SEC')],'#244fa8','Перехід від останньої заданої швидкості, не від виміряної. Інші мотори зберігають свої команди.'),
  definition('motor_on_time','⚙ Мотор %1 швидкість %2 % на %3 с',[motor,value('SPEED'),value('SEC')],'#244fa8','Увімкнути тільки вибраний мотор на заданий час, потім зупинити його.'),
  definition('do_after_delay','⏳ Через %1 с виконати %2',[value('SEC'),statement('DO')],'#5BA55B','Зачекати, виконати вкладені команди й продовжити програму. Очікування саме не зупиняє мотори.'),
  definition('when_signal_rises','⚡ Коли умова стала істинною %1 виконати %2',[{type:'input_value',name:'COND',check:'Boolean'},statement('DO')],'#5b80a5','Перевіряй у циклі. Виконує команди тільки на переході ні → так; повторно спрацює після ні. Усередину умови можна вставити порівняння датчика.'),
  definition('wait_condition_timeout','⌛ Чекати умову %1 максимум %2 с %3 умова виконалась %4 час вийшов %5',[{type:'input_value',name:'COND',check:'Boolean'},value('SEC'),{type:'input_dummy'},statement('THEN'),statement('ELSE')],'#5b80a5','Виконує тільки одну з двох гілок. Умова перевіряється відразу; очікування можна зупинити кнопкою Стоп.')
 ];
 for(const def of definitions)if(!['motor_on_time','motor_soft_start','do_after_delay'].includes(def.type))def.tooltip+=' Запуск із браузера; запис у FRAM поки не підтримується.';
 B.defineBlocksWithJsonArray(definitions);
 const v=(b,n,d)=>G.valueToCode(b,n,G.ORDER_ATOMIC)||d,body=(b,n='DO')=>G.statementToCode(b,n),key=b=>JSON.stringify(b.id);
 function set(type,fn){G[type]=fn;G.forBlock[type]=fn;}
 set('run_once',b=>`await window.rbDoOnce(${key(b)},async()=>{${body(b)}});\n`);
 for(const type of ['motor_soft_start','motor_soft_stop','motor_soft_change'])set(type,b=>`await window.rbMotorRamp(${b.getFieldValue('MOTOR')},${type==='motor_soft_stop'?'0':v(b,'SPEED','50')},${v(b,'SEC','1')},${type==='motor_soft_start'});\n`);
 set('motor_on_time',b=>`await window.rbMotorTimed(${b.getFieldValue('MOTOR')},${v(b,'SPEED','50')},${v(b,'SEC','1')});\n`);
 set('do_after_delay',b=>`await window.rbAfterDelay(${v(b,'SEC','1')},async()=>{${body(b)}});\n`);
 set('when_signal_rises',b=>`await window.rbWhenRises(${key(b)},!!(${v(b,'COND','false')}),async()=>{${body(b)}});\n`);
 set('wait_condition_timeout',b=>`await window.rbWaitTimeout(${v(b,'SEC','5')},()=>!!(${v(b,'COND','false')}),async()=>{${body(b,'THEN')}},async()=>{${body(b,'ELSE')}});\n`);
 // Reuse the existing periodic block instead of introducing an identical block.
 if(B.Blocks.loop_every_seconds)set('loop_every_seconds',b=>`await window.rbRepeatEvery(${v(b,'SEC','1')},async()=>{${body(b)}});\n`);
 function addToolbox(){const tool=document.getElementById('toolbox');if(!tool||tool.querySelector('block[type="run_once"]'))return;
  const motorAnchor=tool.querySelector('block[type="motor_single"]')?.nextSibling;
  const loopTypes=new Set(['run_once','do_after_delay']);
  const logicTypes=new Set(['when_signal_rises','wait_condition_timeout']);
  let logicAnchor;
  for(const def of definitions){const categoryName=loopTypes.has(def.type)?'Цикли':logicTypes.has(def.type)?'Логіка':def.type.startsWith('motor_')?'Рух':'Контроль';const category=tool.querySelector(`category[name="${categoryName}"]`);if(!category)continue;const el=document.createElement('block');el.setAttribute('type',def.type);for(const arg of def.args0.filter(a=>a.type==='input_value')){const input=document.createElement('value');input.setAttribute('name',arg.name);const shadow=document.createElement('shadow'),field=document.createElement('field');shadow.setAttribute('type',arg.check==='Boolean'?'logic_boolean':'math_number');field.setAttribute('name',arg.check==='Boolean'?'BOOL':'NUM');field.textContent=arg.check==='Boolean'?'FALSE':arg.name==='SPEED'?'50':def.type==='wait_condition_timeout'?'5':'1';shadow.append(field);input.append(shadow);el.append(input);}if(def.type.startsWith('motor_')&&motorAnchor?.parentNode===category)category.insertBefore(el,motorAnchor);else if(logicTypes.has(def.type)){if(!logicAnchor)logicAnchor=[...category.children].find(node=>node.getAttribute('type')==='logic_negate');if(logicAnchor){logicAnchor.after(el);logicAnchor=el;}else category.append(el);}else category.append(el);}
  const control=tool.querySelector('category[name="Контроль"]');
  if(control){
    const tailTypes=new Set(['calibrate_speed_line','latch_set','latch_get','latch_reset']);
    [...control.children].filter(el=>tailTypes.has(el.getAttribute('type'))).forEach(el=>control.append(el));
  }
  const ws=window.workspace||B.getMainWorkspace();ws?.updateToolbox?.(tool);
 }
 addToolbox();window.addEventListener('load',addToolbox);
 // Only lower actions supported by the existing robot bytecode. Never silently skip stateful actions.
 if(window.STMCompiler){const original=STMCompiler.prototype.compileStmt;STMCompiler.prototype.compileStmt=function(b,...args){
  if(!b||!definitions.some(d=>d.type===b.type)||(b.isEnabled&&!b.isEnabled()))return original.call(this,b,...args);
  const number=(name,fallback)=>this.staticNum(b.getInputTargetBlock(name),fallback),ch=Number(b.getFieldValue('MOTOR'))||1;
  if(b.type==='motor_on_time'){this.emit(5);this.emit(ch);this.emitI8(number('SPEED',50));this.emit(9);this.emitMs(number('SEC',1));this.emit(5);this.emit(ch);this.emitI8(0);}
  else if(b.type==='do_after_delay'){this.emit(9);this.emitMs(number('SEC',1));this.compileStmt(b.getInputTargetBlock('DO'));}
  else if(b.type==='motor_soft_start'){const duration=Math.max(0,number('SEC',1)),speed=number('SPEED',50),steps=Math.max(1,Math.min(40,Math.ceil(duration*20)));this.emit(5);this.emit(ch);this.emitI8(0);for(let i=1;i<=steps;i++){if(duration){this.emit(9);this.emitMs(duration/steps);}this.emit(5);this.emit(ch);this.emitI8(speed*i/steps);}}
  else{this.errors.push('«'+definitions.find(d=>d.type===b.type).message0.replace(/%\d/g,'').trim()+'»: потрібен запуск з браузера; поточна прошивка FRAM не підтримує цей стан або подію.');}
  this.compileStmt(b.getNextBlock());
 };}
})();
