(function () {
  'use strict';
  const STOP = 'STOPPED';
  let running = false, runToken = 0, history = [], returning = false;
  const servoAngles = Object.create(null);
  const check = () => { if (window._shouldStop) throw STOP; };
  window.rbPause = async function (ms) {
    check();
    const end = Date.now() + Math.max(0, Number(ms) || 0);
    do { await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, end - Date.now())))); check(); } while (Date.now() < end);
  };
  window._rcEnsureStateSystem = function () {
    window._rcLatches ||= Object.create(null);
    window._rcCooldowns ||= Object.create(null);
  };

  const originalDrive = window.sendDrivePacket;
  if (typeof originalDrive === 'function') window.sendDrivePacket = async function (...args) {
    if (running && !returning) history.push({at:Date.now(), motors:args.slice(0,4).map(x=>Number(x)||0)});
    return originalDrive.apply(this,args);
  };
  window.goHomeSequence = async function () {
    const now = Date.now(), saved = history.slice();
    returning = true;
    try {
      for (let i=saved.length-1;i>=0;i--) {
        check();
        const duration = Math.max(0,(i+1<saved.length?saved[i+1].at:now)-saved[i].at);
        if (!duration || !saved[i].motors.some(x=>x!==0)) continue;
        await window.sendDrivePacket(...saved[i].motors.map(x=>-x));
        await window.rbPause(duration);
      }
      await window.sendDrivePacket(0,0,0,0); history=[];
    } finally { returning=false; }
  };

  async function moveServo(channel, from, to, seconds, sendStart) {
    const token=runToken;
    const ch=Math.max(1,Math.min(16,Number(channel)||1));
    from=Math.max(0,Math.min(180,Math.round(Number(from)||0)));
    to=Math.max(0,Math.min(180,Math.round(Number(to)||0)));
    const duration=Math.max(0,Number(seconds)||0)*1000;
    if(sendStart) { check();await window.sendServoPacket(ch,from);servoAngles[ch]=from; }
    const steps=Math.max(1,Math.min(Math.abs(to-from)||1,Math.ceil(duration/50)||1)), start=Date.now();
    for(let step=1;step<=steps;step++) {
      check();if(token!==runToken)throw STOP;
      const angle=Math.round(from+(to-from)*step/steps);
      await window.sendServoPacket(ch,angle);servoAngles[ch]=angle;
      const wait=start+Math.round(duration*step/steps)-Date.now();
      if(wait>0)await window.rbPause(wait);
    }
  }
  window.rbMoveServoTimed=(ch,to,sec)=>moveServo(ch,servoAngles[ch]??0,to,sec,false);
  window.rbMoveServoFromTo=(ch,from,to,sec)=>moveServo(ch,from,to,sec,true);
  const sendServo=window.sendServoPacket;
  window.sendServoPacket=async function(ch,angle){check();const result=await sendServo(ch,angle);if(result===false)throw new Error('Сервопривід: команда не була передана.');servoAngles[ch]=Number(angle);return result;};

  function installGenerators() {
    const B=window.Blockly,G=window.javascript?.javascriptGenerator||B?.JavaScript;
    if(!B||!G||G.__rbRuntimeFixed)return;
    G.__rbRuntimeFixed=true;
    const order=G.ORDER_ATOMIC ?? 0;
    const value=(b,name,fallback='0')=>G.valueToCode(b,name,order)||fallback;
    const body=(b,name='DO')=>G.statementToCode(b,name);
    function set(type,fn){G[type]=fn;G.forBlock[type]=fn;}
    set('math_path_vt',b=>[`((${value(b,'V')})*(${value(b,'T')}))`,order]);
    set('math_diameter_from_radius',b=>[`(2*(${value(b,'R')}))`,order]);
    set('math_rect_perimeter',b=>[`(2*((${value(b,'W')})+(${value(b,'H')})))`,order]);
    for(const type of ['count_laps','wait_until_true_for','timeout_do_until','cooldown_do']){
      const old=G.forBlock[type]||G[type];if(old)set(type,(b,g)=>'{\n'+old(b,g)+'\n}\n');
    }
    set('robot_move_soft',b=>`{
      const target=Number(${value(b,'TARGET')})||0, duration=Math.max(0,Number(${value(b,'SEC')}))*1000;
      const steps=Math.max(1,Math.ceil(duration/50)), started=Date.now();
      for(let step=1;step<=steps;step++) {
        if(window._shouldStop)throw "STOPPED";
        const speed=target*step/steps*(typeof _blocklySpeedMultiplier==='number'?_blocklySpeedMultiplier:1);
        await sendCarPacket(speed,speed);
        const wait=started+Math.round(duration*step/steps)-Date.now();
        if(wait>0)await window.rbPause(wait);
      }
    }\n`);
    set('if_true_for',b=>`{
      const duration=Math.max(0,Number(${value(b,'SEC')}))*1000;
      let since=null, passed=false;
      while(true){
        if(window._shouldStop)throw "STOPPED";
        if(!(${value(b,'COND','false')}))break;
        if(since===null)since=Date.now();
        const remaining=duration-(Date.now()-since);
        if(remaining<=0){passed=true;break;}
        await window.rbPause(Math.min(50,remaining));
      }
      if(passed){${body(b)}}else{${body(b,'ELSE')}}
    }\n`);
    set('controls_whileUntil',b=>`while(${b.getFieldValue('MODE')==='UNTIL'?'!':''}(${value(b,'BOOL','false')})){
      if(window._shouldStop)throw "STOPPED";${body(b)}await window.rbPause(0);
    }\n`);
    set('controls_for',b=>{
      const variable=G.nameDB_.getName(b.getFieldValue('VAR'),B.Names.NameType?.VARIABLE||'VARIABLE');
      return `{
        const begin=Number(${value(b,'FROM')}),end=Number(${value(b,'TO')}),stride=Math.abs(Number(${value(b,'BY','1')}));
        if(!Number.isFinite(stride)||stride===0)throw new Error('Крок циклу має бути ненульовим числом.');
        const increment=begin<=end?stride:-stride;
        for(${variable}=begin;increment>0?${variable}<=end:${variable}>=end;${variable}+=increment){
          if(window._shouldStop)throw "STOPPED";${body(b)}await window.rbPause(0);
        }
      }\n`;
    });
    set('loop_every_seconds',b=>`{
      const period=Math.max(1,Number(${value(b,'SEC')})*1000||1);
      while(true){if(window._shouldStop)throw "STOPPED";const started=Date.now();${body(b)}await window.rbPause(Math.max(1,period-(Date.now()-started)));}
    }\n`);
    set('disp_send',()=> 'await window.PixelEngine.sendFrame();\n');
    set('num_show_big',b=>`{
      const text=String(Math.round(${value(b,'VAL')})),PE=window.PixelEngine;
      PE.clear();PE.drawText(text,Math.max(0,Math.floor((128-(text.length*6-1))/2)),28,1);await PE.sendFrame();
    }\n`);
    set('num_show_convert',b=>{
      const from=b.getFieldValue('FROM'),to=b.getFieldValue('TO'),bases={BIN:2,DEC:10,HEX:16};
      return `{
        const raw=${JSON.stringify(b.getFieldValue('VAL'))},number=parseInt(raw,${bases[from]}),PE=window.PixelEngine;
        if(!Number.isFinite(number))throw new Error('Некоректне число для конвертації.');
        PE.clear();PE.drawText(${JSON.stringify(from+':')}+raw,0,0,1);PE.drawText(${JSON.stringify(to+':')}+number.toString(${bases[to]}).toUpperCase(),0,24,1);await PE.sendFrame();
      }\n`;
    });
    set('disp_anim_play',b=>{
      const a=Number(b.getFieldValue('FROM')),z=Number(b.getFieldValue('TO')),from=Math.min(a,z),to=Math.max(a,z);
      return `{
        let frame=${from};window.PixelEngine.startTick(Math.max(1,Number(${value(b,'MS','200')})||200),async()=>{
          if(window._shouldStop)return;window.PixelEngine.loadFrame(frame);await window.PixelEngine.sendFrame();frame=${from}+((frame-${from}+1)%${to-from+1});
        });
      }\n`;
    });
    const animation=B.Blocks.disp_anim_play,init=animation.init;
    animation.init=function(){init.call(this);for(const name of ['FROM','TO']){const field=this.getField(name);field.menuGenerator_=Array.from({length:10},(_,i)=>[String(i+1),String(i)]);field.generatedOptions_=null;}};
    for(const type of ['track_action','start_line_action'])set(type,()=>`throw new Error('Блок ${type} ще не має реалізації. Приберіть його з програми.');\n`);
    G.workspaceToCode=function(ws){
      const starts=ws.getBlocksByType('start_hat',false).filter(b=>b.isEnabled());
      if(!starts.length)throw new Error('Додайте ввімкнений блок Старт і приєднайте до нього програму.');
      this.init(ws);return this.finish(starts.map(b=>this.blockToCode(b)).join('\n'));
    };
  }
  installGenerators();

  async function stop() {
    window._shouldStop=true;running=false;runToken++;
    window.rbAdvancedReset?.();
    window.PixelEngine?.stopTick();
    try{if(typeof isCodeRunning!=='undefined')isCodeRunning=false;}catch(_){}
    try{await window.rbHardStopServo?.();}catch(_){}
    try{await window.progStopSTM?.();}catch(_){}
    try{await window.sendDrivePacket?.(0,0,0,0);}catch(_){}
    document.getElementById('globalRunBtn')?.classList.remove('running');
    const icon=document.getElementById('runIcon');if(icon){icon.classList.remove('fa-stop');icon.classList.add('fa-play');}
  }
  window.stopCode=stop;
  window.runCode=async function(){
    if(running)return;
    const ws=window.workspace||window.Blockly?.getMainWorkspace();
    const G=window.javascript?.javascriptGenerator||window.Blockly?.JavaScript;
    let code;
    try{installGenerators();code=G.workspaceToCode(ws);new Function('return async function(){'+code+'}');}
    catch(e){window.log?.('Помилка програми: '+e.message,'err');alert('Помилка програми: '+e.message);return;}
    if(!window.isConnected&&!window.characteristic&&!window.isSimulating&&!window.IoTBridge?.isRemoteReady?.()){alert('Підключіть робота або запустіть симулятор.');return;}
    await stop();window._shouldStop=false;running=true;const token=++runToken;history=[];window.blockStates={};window._rcLatches=Object.create(null);window._rcCooldowns=Object.create(null);
    try{if(typeof isCodeRunning!=='undefined')isCodeRunning=true;if(typeof _pidIntegral!=='undefined')_pidIntegral=0;if(typeof _pidLastError!=='undefined')_pidLastError=0;}catch(_){}
    document.getElementById('globalRunBtn')?.classList.add('running');
    const icon=document.getElementById('runIcon');if(icon){icon.classList.remove('fa-play');icon.classList.add('fa-stop');}
    try{await new Function('return (async()=>{var _startTime=Date.now(),_blocklySpeedMultiplier=1;'+code+'})()')();}
    catch(e){if(e!==STOP){window.log?.('Помилка виконання: '+e,'err');console.error(e);}}
    finally{if(token===runToken){
      // Animation/game callbacks remain stoppable after the synchronous script ends.
      if(window.PixelEngine?.isTicking?.())return;
      await stop();
    }}
  };
  window.toggleRunState=()=>running?stop():window.runCode();
  window.rbRunScratchServoLive=window.runCode;
  window.rbStopScratchServoLive=stop;
})();
