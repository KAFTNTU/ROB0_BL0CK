(function () {
  'use strict';

  const STORAGE_KEY = 'rb_kids_scratchjr_program_v1';
  const FLOATING_KEY = 'rb_kids_scratchjr_floating_v1';
  const POSITION_KEY = 'rb_kids_scratchjr_position_v1';
  const ZOOM_KEY = 'rb_kids_scratchjr_zoom_v1';
  const PAN_KEY = 'rb_kids_scratchjr_pan_v1';
  const IS_DEMO = new URLSearchParams(location.search).has('kids-demo');
  const IS_EMPTY_DEMO = IS_DEMO && new URLSearchParams(location.search).has('kids-empty');
  const defs = {
    start:       {category:'start', shape:'start', ico:'flag', title:'Почати програму'},
    forward:     {category:'move', shape:'blue', ico:'forward', title:'Їхати вперед', param:2, suffix:'с'},
    back:        {category:'move', shape:'blue', ico:'back', title:'Їхати назад', param:2, suffix:'с'},
    left:        {category:'move', shape:'blue', ico:'left', title:'Повернути ліворуч', param:90, suffix:'°'},
    right:       {category:'move', shape:'blue', ico:'right', title:'Повернути праворуч', param:90, suffix:'°'},
    uturn_left:  {category:'move', shape:'blue', ico:'uturn-left', title:'Розвернутися ліворуч на 180°', badge:'180°'},
    uturn_right: {category:'move', shape:'blue', ico:'uturn', title:'Розвернутися праворуч на 180°', badge:'180°'},
    slow:        {category:'move', shape:'blue', ico:'slow', title:'Повільна швидкість'},
    fast:        {category:'move', shape:'blue', ico:'fast', title:'Швидка швидкість'},
    drive_time:  {category:'move', shape:'blue', ico:'drivetime', title:'Їхати протягом часу', param:2, suffix:'с'},
    motor_stop:  {category:'move', shape:'blue', ico:'stopb', title:'Зупинити мотори'},
    wall_distance:{category:'sensor', shape:'orange', ico:'senseobst', title:'Стіна: чекати, поки відстань стане меншою', param:20, sensorPort:1, suffix:''},
    line_color:  {category:'sensor', shape:'orange', ico:'senseline', title:'Лінія: чекати чорну або білу поверхню', param:'black', sensorPort:2, suffix:''},
    wait:        {category:'actions', shape:'green', ico:'wait', title:'Почекати', param:1, suffix:'с'},
    smile:       {category:'actions', shape:'green', ico:'smile', title:'Показати смайлик'},
    say:         {category:'actions', shape:'green', ico:'say', title:'Показати текст по центру екрана', param:'HI', suffix:''},
    clear:       {category:'actions', shape:'green', ico:'clear', title:'Очистити екран'},
    repeat:      {category:'repeat', shape:'purple', ico:'repeat', title:'Повторити вкладені блоки', param:3, suffix:'', container:true},
    forever:     {category:'repeat', shape:'purple', ico:'forever', title:'Повторювати завжди', badge:'∞', container:true},
    end:         {category:'end', shape:'end', ico:'stop', title:'Кінець програми'}
  };
  const categories = [
    {id:'start', icon:'🏁', label:'Старт', color:'#f7c600', blocks:['start']},
    {id:'move', icon:'➡️', label:'Рух', color:'#298cee', blocks:['forward','back','left','right','uturn_left','uturn_right','slow','fast','drive_time','motor_stop']},
    {id:'sensor', icon:'👀', label:'Датчик', color:'#f38d1b', blocks:['wall_distance','line_color']},
    {id:'actions', icon:'🙂', label:'Дії', color:'#46bb42', blocks:['wait','smile','say','clear']},
    {id:'repeat', icon:'🔁', label:'Цикл', color:'#9d4edd', blocks:['repeat','forever']},
    {id:'end', icon:'🛑', label:'Кінець', color:'#e83a3a', blocks:['end']}
  ];

  const sample = [
    {id:'sample-start', type:'start'},
    {id:'sample-repeat', type:'repeat', param:3, children:[
      {id:'sample-forward', type:'forward', param:2},
      {id:'sample-right', type:'right', param:90},
      {id:'sample-smile', type:'smile'}
    ]},
    {id:'sample-say', type:'say', param:'HI'},
    {id:'sample-end', type:'end'}
  ];
  let program = IS_EMPTY_DEMO ? [] : sample;
  let floatingBlocks = [];
  let programPosition = {x:40, y:Math.max(100, Math.round(innerHeight / 2 - 40))};
  let kidsZoom = 1;
  let viewPan = {x:0, y:0};
  if (!IS_DEMO) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(saved)) program = saved;
      const floating = JSON.parse(localStorage.getItem(FLOATING_KEY));
      if (Array.isArray(floating)) floatingBlocks = floating;
      const position = JSON.parse(localStorage.getItem(POSITION_KEY));
      if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) programPosition = position;
      const zoom = Number(localStorage.getItem(ZOOM_KEY));
      if (Number.isFinite(zoom) && zoom >= .55 && zoom <= 1.5) kidsZoom = zoom;
      const pan = JSON.parse(localStorage.getItem(PAN_KEY));
      if (Number.isFinite(pan?.x) && Number.isFinite(pan?.y)) viewPan = pan;
      else viewPan = {x:(1 - kidsZoom) * programPosition.x, y:(1 - kidsZoom) * programPosition.y};
    } catch (_) {}
  }
  function normalizeNodes(nodes) {
    nodes.forEach(node => {
      if (node.type === 'uturn') node.type = 'uturn_left';
      if (node.type === 'sensor_wait') node.type = 'wall_distance';
      if (Array.isArray(node.children)) normalizeNodes(node.children);
    });
  }
  normalizeNodes(program);
  normalizeNodes(floatingBlocks);
  let activeLoopId = null;
  let activeCategory = 'move';
  let kidsMode = false;
  let nextId = 0;
  let completedDrag = false;
  let normalWorkspaceBackup = null;
  let zoomCommitTimer = null;
  let cancelTouchDrag = null;
  let cancelProgramMove = null;
  let cancelCanvasGesture = null;
  const undoStack = [];
  const redoStack = [];

  const byId = id => document.getElementById(id);
  const newId = () => 'kids-' + Date.now() + '-' + (++nextId);
  const snapshot = () => JSON.stringify({program, floatingBlocks, programPosition, activeLoopId, kidsZoom, viewPan});
  let lastSnapshot = snapshot();

  function updateHistoryButtons() {
    const undo = byId('kidsUndoBtn');
    const redo = byId('kidsRedoBtn');
    if (undo) undo.disabled = undoStack.length === 0;
    if (redo) redo.disabled = redoStack.length === 0;
  }

  function persist() { if (IS_DEMO) return; try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(program));
    localStorage.setItem(FLOATING_KEY, JSON.stringify(floatingBlocks));
    localStorage.setItem(POSITION_KEY, JSON.stringify(programPosition));
    localStorage.setItem(ZOOM_KEY, String(kidsZoom));
    localStorage.setItem(PAN_KEY, JSON.stringify(viewPan));
  } catch (_) {} };

  function save() {
    const current = snapshot();
    if (current === lastSnapshot) return;
    undoStack.push(lastSnapshot);
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    lastSnapshot = current;
    persist();
    updateHistoryButtons();
  }

  function restoreSnapshot(value) {
    const state = JSON.parse(value);
    program = state.program;
    floatingBlocks = state.floatingBlocks;
    programPosition = state.programPosition;
    activeLoopId = state.activeLoopId;
    kidsZoom = state.kidsZoom ?? 1;
    viewPan = state.viewPan ?? {x:0, y:0};
    lastSnapshot = value;
    persist();
    renderSequence();
    updateHistoryButtons();
  }

  window.kidsUndo = function () {
    if (!undoStack.length) return;
    redoStack.push(lastSnapshot);
    restoreSnapshot(undoStack.pop());
  };

  window.kidsRedo = function () {
    if (!redoStack.length) return;
    undoStack.push(lastSnapshot);
    restoreSnapshot(redoStack.pop());
  };

  function newNode(type) {
    const def = defs[type];
    const node = {id:newId(), type};
    if (def.param !== undefined) node.param = def.param;
    if (def.sensorPort) node.sensorPort = def.sensorPort;
    if (def.container) node.children = [];
    return node;
  }

  function getWorkspace() {
    try { if (window.workspace) return window.workspace; } catch (_) {}
    try { return window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace(); } catch (_) {}
    return null;
  }

  function findLocation(id, list = program, parentId = null) {
    for (let index = 0; index < list.length; index++) {
      const node = list[index];
      if (node.id === id) return {node, list, index, parentId};
      if (Array.isArray(node.children)) {
        const child = findLocation(id, node.children, node.id);
        if (child) return child;
      }
    }
    if (list === program) return findLocation(id, floatingBlocks, null);
    return null;
  }

  function containsId(node, id) {
    if (node.id === id) return true;
    return Array.isArray(node.children) && node.children.some(child => containsId(child, id));
  }

  function editParam(node, event) {
    event.stopPropagation();
    const def = defs[node.type];
    if (!def || def.param === undefined) return;
    if (def.sensorPort) { editSensor(node); return; }
    const input = prompt(def.title + '\nНове значення:', node.param ?? def.param);
    if (input === null) return;
    const value = input.trim();
    if (!value) return;
    if (node.type === 'say') node.param = value.slice(0, 24);
    else {
      const number = Number(value.replace(',', '.'));
      if (!Number.isFinite(number)) return;
      node.param = Math.max(0, Math.min(node.type === 'repeat' ? 99 : 999, number));
    }
    save();
    renderSequence();
  }

  function editSensor(node) {
    const def = defs[node.type];
    const dialog = document.createElement('dialog');
    dialog.className = 'kids-sensor-dialog';
    const form = document.createElement('form');
    const heading = document.createElement('h3');
    heading.textContent = node.type === 'wall_distance' ? '🧱 Стіна' : '〰 Лінія';
    function field(caption, input) {
      const label = document.createElement('label');
      const text = document.createElement('span');
      text.textContent = caption;
      label.append(text, input);
      return label;
    }
    const port = document.createElement('select');
    for (let number = 1; number <= 4; number++) port.add(new Option('Датчик ' + number, String(number)));
    port.value = String(node.sensorPort ?? def.sensorPort);
    let value;
    if (node.type === 'line_color') {
      value = document.createElement('select');
      value.add(new Option('⚫ Чорна', 'black'));
      value.add(new Option('⚪ Біла', 'white'));
      value.value = node.param ?? def.param;
    } else {
      value = document.createElement('input');
      Object.assign(value, {type:'number', min:'0', max:'999', step:'any', required:true, inputMode:'decimal', value:String(node.param ?? def.param)});
    }
    const hint = document.createElement('p');
    hint.textContent = node.type === 'wall_distance' ? 'Продовжити програму, коли стіна ближче за цю відстань.' : 'Продовжити програму, коли датчик побачить цей колір.';
    const actions = document.createElement('div');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Скасувати';
    cancel.addEventListener('click', () => dialog.close());
    const apply = document.createElement('button');
    apply.type = 'submit';
    apply.textContent = 'Готово';
    actions.append(cancel, apply);
    form.append(heading, field(node.type === 'wall_distance' ? 'Відстань до стіни' : 'Колір лінії', value), field('Порт датчика', port), hint, actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      node.sensorPort = Number(port.value);
      node.param = node.type === 'line_color' ? value.value : Number(value.value);
      save();
      renderSequence();
      dialog.close();
    });
    dialog.appendChild(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  function makeChip(node) {
    const def = defs[node.type];
    if (def.param === undefined && !def.badge) return null;
    const chip = document.createElement(def.badge ? 'span' : 'button');
    chip.className = 'kids-jr-param';
    if (def.badge) {
      chip.classList.add('kids-jr-badge');
      chip.textContent = def.badge;
      return chip;
    }
    chip.type = 'button';
    if (node.type === 'line_color') {
      chip.classList.add('kids-line-color-param');
      chip.textContent = (node.param ?? def.param) === 'white' ? 'Біла' : 'Чорна';
    } else chip.textContent = String(node.param ?? def.param) + (def.suffix || '');
    chip.title = 'Натисни, щоб змінити значення';
    if (node.id) chip.addEventListener('click', event => editParam(node, event));
    else chip.addEventListener('click', event => event.stopPropagation());
    return chip;
  }

  function makeIcon(name) {
    const icon = document.createElement('div');
    icon.className = 'kids-jr-icon ico-' + name + (name === 'uturn-left' ? ' ico-uturn' : '');
    return icon;
  }

  function makeRemove(node) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'kids-jr-remove';
    button.title = 'Прибрати блок';
    button.textContent = '×';
    button.addEventListener('click', event => {
      event.stopPropagation();
      const location = findLocation(node.id);
      if (!location) return;
      location.list.splice(location.index, 1);
      if (activeLoopId && containsId(node, activeLoopId)) activeLoopId = location.parentId;
      save();
      renderSequence();
    });
    return button;
  }

  function dragInfo(element, node, palette, event) {
    const floatingChain = palette ? null : element.closest('.kids-floating-chain');
    const dragWholeChain = element.parentElement === floatingChain && floatingChain?.querySelectorAll(':scope > .kids-sequence-block').length > 1;
    const source = dragWholeChain ? floatingChain : element;
    const rect = source.getBoundingClientRect();
    return {source, payload:{
      ...(palette ? {kind:'palette', type:node.type} : dragWholeChain ? {kind:'floating-chain', chainId:floatingChain.dataset.kidsChainId} : {kind:'sequence', id:node.id}),
      grabX:rect.width ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : .5,
      grabY:rect.height ? Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) : .5,
      width:palette ? (node.type === 'start' ? 85 : 76) : rect.width,
      height:palette ? 66 : rect.height
    }};
  }

  function attachTouchDrag(element, node, palette) {
    let suppressClick = false;
    element.addEventListener('click', event => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    element.addEventListener('pointerdown', event => {
      if (!kidsMode || event.pointerType === 'mouse' || event.target.closest('button:not(.kids-jr-param)')) return;
      event.stopPropagation();
      cancelTouchDrag?.();
      const {source, payload} = dragInfo(element, node, palette, event);
      const startX = event.clientX;
      const startY = event.clientY;
      const pointerId = event.pointerId;
      const tray = palette ? byId('kidsPalette') : null;
      const initialScroll = tray?.scrollLeft || 0;
      let ghost = null;
      let moving = false;
      let scrolling = false;
      function cleanup() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', cancel);
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
        source.classList.remove('kids-touch-dragging');
        ghost?.remove();
        cancelTouchDrag = null;
      }
      function cancel(next) {
        if (next?.pointerId !== undefined && next.pointerId !== pointerId) return;
        suppressClick = moving || scrolling;
        cleanup();
      }
      function move(next) {
        if (next.pointerId !== pointerId) return;
        const dx = next.clientX - startX;
        const dy = next.clientY - startY;
        if (!moving && Math.hypot(dx, dy) < 6) return;
        if (!moving && tray && Math.abs(dy) < 12 && (scrolling || Math.abs(dx) > Math.max(10, Math.abs(dy) * 1.4))) {
          scrolling = true;
          next.preventDefault();
          element.setPointerCapture(pointerId);
          tray.scrollLeft = initialScroll - dx;
          return;
        }
        if (!moving && tray && Math.abs(dy) < 12) return;
        if (!moving) {
          moving = true;
          element.setPointerCapture(pointerId);
          ghost = source.cloneNode(true);
          ghost.classList.add('kids-touch-ghost');
          ghost.querySelectorAll('.kids-jr-remove').forEach(button => button.remove());
          Object.assign(ghost.style, {position:'fixed', margin:'0', zIndex:'10000', pointerEvents:'none', transformOrigin:'0 0', transition:'none'});
          if (payload.kind === 'floating-chain') {
            Object.assign(ghost.style, {display:'flex', alignItems:'center', width:'max-content', height:'max-content'});
            ghost.lastElementChild.style.marginRight = '0';
          }
          document.body.appendChild(ghost);
          source.classList.add('kids-touch-dragging');
        }
        next.preventDefault();
        const scale = payload.kind === 'palette' ? kidsZoom : 1;
        const width = payload.width * scale;
        const height = payload.height * scale;
        ghost.style.transform = `scale(${kidsZoom})`;
        ghost.style.left = next.clientX - width * payload.grabX + 'px';
        ghost.style.top = next.clientY - height * payload.grabY + 'px';
      }
      function finish(next) {
        if (next.pointerId !== pointerId) return;
        suppressClick = moving || scrolling;
        cleanup();
        if (!moving) return;
        next.preventDefault();
        const target = document.elementFromPoint(next.clientX, next.clientY);
        const builder = byId('view-builder');
        if (target && builder?.contains(target) && !target.closest('#kidsPaletteDock, .sensor-row'))
          dropNearChainOrCanvas(payload, next);
      }
      cancelTouchDrag = cancel;
      window.addEventListener('pointermove', move, {passive:false});
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', cancel);
    });
  }

  function attachDrag(element, node, palette) {
    element.draggable = true;
    attachTouchDrag(element, node, palette);
    let dragPayload;
    element.addEventListener('dragstart', event => {
      if (cancelTouchDrag) { event.preventDefault(); return; }
      event.stopPropagation();
      completedDrag = false;
      dragPayload = dragInfo(element, node, palette, event).payload;
      event.dataTransfer.setData('text/plain', JSON.stringify(dragPayload));
      event.dataTransfer.effectAllowed = palette ? 'copyMove' : 'move';
    });
    element.addEventListener('dragend', event => {
      if (completedDrag || !kidsMode) return;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const sequence = byId('kidsSequence');
      const builder = byId('view-builder');
      if (!target || !builder?.contains(target) || target.closest('#kidsPaletteDock')) return;
      if (sequence?.contains(target)) {
        const nest = target.closest('.kids-jr-loop-nest');
        const container = nest || sequence;
        const loopId = nest?.closest('.kids-jr-loop')?.dataset.kidsId || null;
        insertPayloadIntoList(dragPayload, container, loopId, target, event.clientX);
      } else dropNearChainOrCanvas(dragPayload || (palette ? {kind:'palette', type:node.type} : {kind:'sequence', id:node.id}), event);
    });
  }

  function makeSimple(node, palette) {
    const def = defs[node.type];
    const block = document.createElement('div');
    block.className = 'kids-jr-block shape-' + def.shape + (def.shape === 'start' ? ' wide' : '') + (palette ? ' in-tray' : ' kids-sequence-block');
    block.dataset.kidsType = node.type;
    if (node.id) block.dataset.kidsId = node.id;
    block.title = def.title;
    block.appendChild(makeIcon(def.ico));
    const chip = makeChip(node);
    if (chip) block.appendChild(chip);
    if (!palette) block.appendChild(makeRemove(node));
    if (!palette && node.type === 'start' && program.some(item => item.id === node.id)) {
      block.classList.add('kids-chain-anchor');
      block.title = 'Перетягни старт, щоб пересунути весь ланцюжок';
      block.addEventListener('pointerdown', beginProgramMove);
    } else attachDrag(block, node, palette);
    return block;
  }

  function makeLoop(node) {
    const wrap = document.createElement('div');
    wrap.className = 'kids-jr-loop kids-sequence-block' + (node.type === 'forever' ? ' kids-forever' : '') + (activeLoopId === node.id ? ' active-loop' : '');
    wrap.dataset.kidsId = node.id;
    wrap.title = defs[node.type].title + '. Натисни, щоб додавати блоки в цикл або вийти з нього';
    wrap.addEventListener('click', event => {
      event.stopPropagation();
      activeLoopId = activeLoopId === node.id ? findLocation(node.id)?.parentId || null : node.id;
      renderSequence();
    });
    const tab = document.createElement('div');
    tab.className = 'kids-jr-loop-tab shape-purple';
    const body = document.createElement('div');
    body.className = 'kids-jr-loop-body';
    const nest = document.createElement('div');
    nest.className = 'kids-jr-loop-nest';
    attachDrop(nest, node.id);
    if (!node.children?.length) {
      const empty = document.createElement('div');
      empty.className = 'kids-jr-loop-empty';
      empty.textContent = activeLoopId === node.id ? '+' : '';
      nest.appendChild(empty);
    } else node.children.forEach((child, index) => {
      const block = makeProgramBlock(child);
      block.style.setProperty('--chain-layer', String(node.children.length - index + 1));
      nest.appendChild(block);
    });
    const cap = document.createElement('div');
    cap.className = 'kids-jr-block kids-jr-loop-cap shape-cap';
    cap.appendChild(makeIcon(defs[node.type].ico));
    const chip = makeChip(node);
    if (chip) cap.appendChild(chip);
    body.append(nest, cap);
    wrap.append(tab, body, makeRemove(node));
    attachDrag(wrap, node, false);
    return wrap;
  }

  function makeProgramBlock(node) {
    return defs[node.type]?.container ? makeLoop(node) : makeSimple(node, false);
  }

  function renderPalette() {
    const tabs = byId('kidsCategoryTabs');
    const palette = byId('kidsPalette');
    if (!tabs || !palette) return;
    tabs.replaceChildren();
    palette.replaceChildren();
    categories.forEach(category => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'kids-category-tab' + (activeCategory === category.id ? ' active' : '');
      tab.style.background = category.color;
      tab.textContent = category.icon;
      tab.title = category.label;
      tab.setAttribute('aria-label', category.label);
      tab.addEventListener('click', () => { activeCategory = category.id; renderPalette(); });
      tabs.appendChild(tab);
    });
    const category = categories.find(item => item.id === activeCategory);
    category.blocks.forEach(type => palette.appendChild(makeSimple({type}, true)));
  }

  function renderSequence() {
    const sequence = byId('kidsSequence');
    if (!sequence) return;
    sequence.replaceChildren();
    sequence.classList.toggle('kids-empty', !program.length);
    program.forEach((node, index) => {
      const block = makeProgramBlock(node);
      block.style.setProperty('--chain-layer', String(program.length - index + 1));
      sequence.appendChild(block);
    });
    renderFloating();
    if (kidsMode) applyKidsZoom();
    const hint = byId('kidsActiveLoopHint');
    if (hint) hint.hidden = !activeLoopId;
  }

  function listForLoop(id) {
    const location = id && findLocation(id);
    return location && Array.isArray(location.node.children) ? location.node.children : program;
  }

  function addBlock(type, index) {
    const def = defs[type];
    if (!def) return;
    if (type === 'start' && program.some(node => node.type === 'start')) return;
    if (type === 'end' && program.some(node => node.type === 'end')) return;
    const node = newNode(type);
    const list = type === 'start' || type === 'end' ? program : listForLoop(activeLoopId);
    if (type === 'start') list.unshift(node);
    else if (type === 'end') list.push(node);
    else if (Number.isInteger(index)) list.splice(index, 0, node);
    else list.push(node);
    if (def.container) activeLoopId = node.id;
    save();
    renderSequence();
  }

  function constrainedIndex(list, index, type) {
    if (list !== program) return Math.max(0, Math.min(list.length, index));
    if (type !== 'start' && list[0]?.type === 'start') index = Math.max(1, index);
    if (type !== 'end' && list[list.length - 1]?.type === 'end') index = Math.min(list.length - 1, index);
    return Math.max(0, Math.min(list.length, index));
  }

  const floatingChainId = node => node.chainId || node.id;
  const floatingMembers = chainId => floatingBlocks.filter(node => floatingChainId(node) === chainId);

  function targetIndex(list, container, target, clientX) {
    const block = target?.closest('.kids-sequence-block');
    if (!block || block.parentElement !== container) return list.length;
    const index = list.findIndex(node => node.id === block.dataset.kidsId);
    if (index < 0) return list.length;
    const rect = block.getBoundingClientRect();
    return index + (clientX > rect.left + rect.width / 2 ? 1 : 0);
  }

  function clearFloatingPosition(node) {
    delete node.chainId;
    delete node.x;
    delete node.y;
  }

  function insertPayloadIntoList(payload, container, loopId, target, clientX, snapIndex) {
    if (payload.kind === 'palette' && defs[payload.type]) {
      insertPaletteBlock(payload.type, container, loopId, target, clientX, snapIndex);
    } else if (payload.kind === 'sequence') {
      moveNodeIntoList(payload.id, container, loopId, target, clientX, snapIndex);
    } else if (payload.kind === 'floating-chain') {
      const nodes = floatingMembers(payload.chainId);
      if (!nodes.length || (loopId && nodes.some(node => containsId(node, loopId)))) return;
      const list = listForLoop(loopId);
      const index = Number.isInteger(snapIndex) ? snapIndex : targetIndex(list, container, target, clientX);
      floatingBlocks = floatingBlocks.filter(node => floatingChainId(node) !== payload.chainId);
      nodes.forEach(clearFloatingPosition);
      list.splice(constrainedIndex(list, index, nodes[0].type), 0, ...nodes);
      save();
      renderSequence();
    }
  }

  function insertPayloadIntoFloating(payload, container, target, clientX, snapIndex) {
    const chainId = container.dataset.kidsChainId;
    let members = floatingMembers(chainId);
    if (!members.length || (payload.kind === 'floating-chain' && payload.chainId === chainId)) return;
    let index = Number.isInteger(snapIndex) ? snapIndex : targetIndex(members, container, target, clientX);
    let nodes;
    if (payload.kind === 'palette' && defs[payload.type]) nodes = [newNode(payload.type)];
    else if (payload.kind === 'floating-chain') {
      nodes = floatingMembers(payload.chainId);
      if (!nodes.length) return;
      floatingBlocks = floatingBlocks.filter(node => floatingChainId(node) !== payload.chainId);
    } else if (payload.kind === 'sequence') {
      const location = findLocation(payload.id);
      if (!location || members.some(member => member.id !== location.node.id && containsId(location.node, member.id))) return;
      if (!Number.isInteger(snapIndex) && location.list === floatingBlocks &&
          floatingChainId(location.node) === chainId && members.indexOf(location.node) < index) index--;
      nodes = [location.list.splice(location.index, 1)[0]];
      if (activeLoopId && containsId(nodes[0], activeLoopId)) activeLoopId = location.parentId;
    } else return;
    members = floatingMembers(chainId);
    if (!members.length) {
      const anchor = nodes[0];
      nodes.forEach(node => { node.chainId = chainId; node.x = anchor.x; node.y = anchor.y; });
      floatingBlocks.push(...nodes);
    } else {
      const anchor = members[0];
      index = Math.max(0, Math.min(members.length, index));
      if (members[0].type === 'start' && nodes[0].type !== 'start') index = Math.max(1, index);
      if (members[members.length - 1].type === 'end' && nodes[0].type !== 'end') index = Math.min(members.length - 1, index);
      const before = members[index];
      const at = before ? floatingBlocks.indexOf(before) : floatingBlocks.indexOf(members[members.length - 1]) + 1;
      nodes.forEach(node => { node.chainId = chainId; node.x = anchor.x; node.y = anchor.y; });
      floatingBlocks.splice(at, 0, ...nodes);
    }
    save();
    renderSequence();
  }

  function insertPaletteBlock(type, container, loopId, target, clientX, snapIndex) {
    if (!defs[type]) return;
    if (type === 'start' || type === 'end') { addBlock(type); return; }
    const list = listForLoop(loopId);
    const index = Number.isInteger(snapIndex) ? snapIndex : targetIndex(list, container, target, clientX);
    const node = newNode(type);
    list.splice(constrainedIndex(list, index, type), 0, node);
    if (defs[type].container) activeLoopId = node.id;
    save();
    renderSequence();
  }

  function moveNodeIntoList(id, container, loopId, target, clientX, snapIndex) {
    const list = listForLoop(loopId);
    let index = Number.isInteger(snapIndex) ? snapIndex : targetIndex(list, container, target, clientX);
    const location = findLocation(id);
    if (!location || (loopId && containsId(location.node, loopId))) return;
    const moved = location.list.splice(location.index, 1)[0];
    if (!Number.isInteger(snapIndex) && location.list === list && location.index < index) index--;
    clearFloatingPosition(moved);
    list.splice(constrainedIndex(list, index, moved.type), 0, moved);
    save();
    renderSequence();
  }

  function findSnapTarget(payload, event) {
    const sequence = byId('kidsSequence');
    if (!sequence) return null;
    const draggedNodes = payload.kind === 'floating-chain' ? floatingMembers(payload.chainId) :
      payload.kind === 'sequence' ? [findLocation(payload.id)?.node].filter(Boolean) : [];
    const scale = payload.kind === 'palette' ? kidsZoom : 1;
    const width = Number(payload.width) > 0 ? payload.width * scale : 76 * kidsZoom;
    const height = Number(payload.height) > 0 ? payload.height * scale : 66 * kidsZoom;
    const left = event.clientX - width * (Number.isFinite(payload.grabX) ? payload.grabX : .5);
    const top = event.clientY - height * (Number.isFinite(payload.grabY) ? payload.grabY : .5);
    const right = left + width;
    const bottom = top + height;
    const containers = [
      ...byId('kidsWorkspaceLayer').querySelectorAll('.kids-jr-loop-nest'),
      ...(program.length ? [sequence] : []),
      ...byId('kidsWorkspaceLayer').querySelectorAll(':scope > .kids-floating-chain')
    ];
    for (const container of containers) {
      const parentLoopId = container.classList.contains('kids-jr-loop-nest') ? container.closest('.kids-jr-loop')?.dataset.kidsId : null;
      if (parentLoopId && draggedNodes.some(node => containsId(node, parentLoopId))) continue;
      if (container.classList.contains('kids-floating-chain') &&
          (payload.chainId === container.dataset.kidsChainId ||
           (container.children.length === 1 && container.firstElementChild?.dataset.kidsId === payload.id))) continue;
      const blocks = [...container.children].filter(child => child.classList.contains('kids-sequence-block') && child.dataset.kidsId !== payload.id);
      if (container === sequence && !blocks.length) continue;
      const rects = blocks.map(block => block.getBoundingClientRect());
      const area = rects.length ? {
        left:Math.min(...rects.map(rect => rect.left)),
        right:Math.max(...rects.map(rect => rect.right)),
        top:Math.min(...rects.map(rect => rect.top)),
        bottom:Math.max(...rects.map(rect => rect.bottom))
      } : container.getBoundingClientRect();
      const tolerance = 22 * kidsZoom;
      if (right < area.left - tolerance || left > area.right + tolerance ||
          bottom < area.top - tolerance || top > area.bottom + tolerance) continue;
      const index = blocks.findIndex((block, i) => left + 11 * kidsZoom < rects[i].left + rects[i].width / 2);
      return {
        container,
        loopId:container.classList.contains('kids-floating-chain') || container === sequence ? null : container.closest('.kids-jr-loop')?.dataset.kidsId || null,
        index:index < 0 ? blocks.length : index
      };
    }
    return null;
  }

  function dropNearChainOrCanvas(payload, event) {
    const snap = findSnapTarget(payload, event);
    if (snap) {
      if (snap.container.classList.contains('kids-floating-chain'))
        insertPayloadIntoFloating(payload, snap.container, null, event.clientX, snap.index);
      else insertPayloadIntoList(payload, snap.container, snap.loopId, null, event.clientX, snap.index);
      return;
    }
    placeBlockOnCanvas(payload, event);
  }

  function attachDrop(container, loopId) {
    container.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; });
    container.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
      let payload;
      try { payload = JSON.parse(event.dataTransfer.getData('text/plain')); } catch (_) { return; }
      completedDrag = true;
      if (container.classList.contains('kids-floating-chain'))
        insertPayloadIntoFloating(payload, container, event.target, event.clientX);
      else insertPayloadIntoList(payload, container, loopId, event.target, event.clientX);
    });
  }

  function getDropPosition(event, width = 76, height = 66, grabX = .5, grabY = .5) {
    const builder = byId('view-builder');
    const dock = byId('kidsPaletteDock');
    const bounds = builder.getBoundingClientRect();
    const dockTop = dock?.getBoundingClientRect().top ?? bounds.bottom;
    const left = (8 - viewPan.x) / kidsZoom;
    const right = (bounds.width - 8 - viewPan.x) / kidsZoom - width;
    const top = (70 - viewPan.y) / kidsZoom;
    const bottom = (dockTop - bounds.top - 10 - viewPan.y) / kidsZoom - height;
    return {
      x:Math.round(Math.max(left, Math.min(Math.max(left, right), (event.clientX - bounds.left - viewPan.x) / kidsZoom - width * grabX))),
      y:Math.round(Math.max(top, Math.min(Math.max(top, bottom), (event.clientY - bounds.top - viewPan.y) / kidsZoom - height * grabY)))
    };
  }

  function placeBlockOnCanvas(payload, event) {
    const width = payload.kind === 'palette' ? Number(payload.width) || 76 : (Number(payload.width) || 76 * kidsZoom) / kidsZoom;
    const height = payload.kind === 'palette' ? Number(payload.height) || 66 : (Number(payload.height) || 66 * kidsZoom) / kidsZoom;
    const point = getDropPosition(event, width, height,
      Number.isFinite(payload.grabX) ? payload.grabX : .5,
      Number.isFinite(payload.grabY) ? payload.grabY : .5);
    if (!program.length) {
      let nodes;
      if (payload.kind === 'palette' && defs[payload.type]) nodes = [newNode(payload.type)];
      else if (payload.kind === 'floating-chain') {
        nodes = floatingMembers(payload.chainId);
        floatingBlocks = floatingBlocks.filter(node => floatingChainId(node) !== payload.chainId);
      } else if (payload.kind === 'sequence') {
        const location = findLocation(payload.id);
        if (!location) return;
        nodes = [location.list.splice(location.index, 1)[0]];
      }
      if (!nodes?.length) return;
      nodes.forEach(clearFloatingPosition);
      program.push(...nodes);
      programPosition = {x:point.x - 16, y:point.y - 14};
      renderSequence();
      const first = byId('kidsSequence')?.querySelector(':scope > .kids-sequence-block');
      if (first) {
        const bounds = byId('view-builder').getBoundingClientRect();
        const rect = first.getBoundingClientRect();
        programPosition.x += (bounds.left + viewPan.x + point.x * kidsZoom - rect.left) / kidsZoom;
        programPosition.y += (bounds.top + viewPan.y + point.y * kidsZoom - rect.top) / kidsZoom;
        applyProgramPosition();
      }
      save();
      return;
    }
    if (payload.kind === 'palette' && defs[payload.type]) {
      const node = newNode(payload.type);
      floatingBlocks.push({...node, chainId:node.id, ...point});
    } else if (payload.kind === 'floating-chain') {
      const nodes = floatingMembers(payload.chainId);
      if (!nodes.length) return;
      nodes.forEach(node => { node.x = point.x; node.y = point.y; });
    } else if (payload.kind === 'sequence') {
      const location = findLocation(payload.id);
      if (!location) return;
      const node = location.list.splice(location.index, 1)[0];
      if (activeLoopId && containsId(node, activeLoopId)) activeLoopId = location.parentId;
      node.x = point.x;
      node.y = point.y;
      node.chainId = node.id;
      floatingBlocks.push(node);
    } else return;
    save();
    renderSequence();
  }

  function renderFloating() {
    const layer = byId('kidsWorkspaceLayer');
    if (!layer) return;
    layer.querySelectorAll(':scope > .kids-floating-block').forEach(element => element.remove());
    if (!kidsMode) return;
    const chains = new Map();
    floatingBlocks.forEach(node => {
      const chainId = floatingChainId(node);
      if (!chains.has(chainId)) chains.set(chainId, []);
      chains.get(chainId).push(node);
    });
    chains.forEach((nodes, chainId) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'kids-floating-block kids-floating-chain';
      wrapper.style.left = nodes[0].x + 'px';
      wrapper.style.top = nodes[0].y + 'px';
      wrapper.dataset.kidsChainId = chainId;
      wrapper.title = 'З’єднуй блоки тут або приєднай ряд до програми';
      nodes.forEach((node, index) => {
        const block = makeProgramBlock(node);
        block.style.setProperty('--chain-layer', String(nodes.length - index + 1));
        wrapper.appendChild(block);
      });
      attachDrop(wrapper, null);
      layer.appendChild(wrapper);
    });
  }

  function applyProgramPosition() {
    const sequence = byId('kidsSequence');
    if (!sequence) return;
    sequence.style.left = programPosition.x + 'px';
    sequence.style.top = programPosition.y + 'px';
  }

  function applyKidsZoom() {
    applyProgramPosition();
    const layer = byId('kidsWorkspaceLayer');
    const grid = byId('kidsGridLayer');
    if (layer) layer.style.transform = `translate(${viewPan.x}px, ${viewPan.y}px) scale(${kidsZoom})`;
    if (grid) {
      const spacing = 30 * kidsZoom;
      grid.style.backgroundSize = `${spacing}px ${spacing}px`;
      grid.style.backgroundPosition = `${viewPan.x}px ${viewPan.y}px`;
    }
  }

  function beginProgramMove(event) {
    if (!kidsMode || event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = {...programPosition};
    function move(next) {
      programPosition = {x:initial.x + (next.clientX - startX) / kidsZoom, y:initial.y + (next.clientY - startY) / kidsZoom};
      applyProgramPosition();
    }
    function finish() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      cancelProgramMove = null;
      save();
    }
    cancelProgramMove = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  function updateKidsViewport() {
    const builder = byId('view-builder');
    if (!builder) return;
    builder.style.setProperty('--kids-viewport-height', (window.visualViewport?.height || innerHeight) + 'px');
    builder.style.setProperty('--kids-viewport-top', (window.visualViewport?.offsetTop || 0) + 'px');
    if (!kidsMode) return;
    const first = byId('kidsSequence')?.querySelector(':scope > .kids-sequence-block');
    if (!first) return;
    const wasGesturing = builder.classList.contains('kids-gesturing');
    builder.classList.add('kids-gesturing');
    applyKidsZoom();
    const rect = first.getBoundingClientRect();
    const bounds = builder.getBoundingClientRect();
    const dockTop = byId('kidsPaletteDock').getBoundingClientRect().top;
    if (rect.right < bounds.left + 8 || rect.left > bounds.right - 8)
      viewPan.x += bounds.left + 24 - rect.left;
    if (rect.bottom < bounds.top + 70 || rect.top > dockTop - 16)
      viewPan.y += bounds.top + 70 + Math.max(0, (dockTop - bounds.top - 86 - rect.height) / 2) - rect.top;
    applyKidsZoom();
    first.getBoundingClientRect();
    if (!wasGesturing) builder.classList.remove('kids-gesturing');
  }

  function attachCanvasGestures(builder) {
    const pointers = new Map();
    let gesture = null;
    function begin() {
      const points = [...pointers.values()];
      const center = points.length > 1 ? {x:(points[0].x + points[1].x) / 2, y:(points[0].y + points[1].y) / 2} : points[0];
      const bounds = builder.getBoundingClientRect();
      gesture = {pan:{...viewPan}, zoom:kidsZoom, center,
        distance:points.length > 1 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0,
        world:{x:(center.x - bounds.left - viewPan.x) / kidsZoom, y:(center.y - bounds.top - viewPan.y) / kidsZoom}};
      builder.classList.add('kids-gesturing');
    }
    function cleanup() {
      for (const id of pointers.keys()) if (builder.hasPointerCapture(id)) builder.releasePointerCapture(id);
      pointers.clear();
      gesture = null;
      builder.classList.remove('kids-gesturing');
    }
    cancelCanvasGesture = cleanup;
    builder.addEventListener('pointerdown', event => {
      if (!kidsMode || event.button !== 0 || event.target.closest('#kidsPaletteDock, .sensor-row, button, input')) return;
      pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
      if (pointers.size === 1 && event.target.closest('.kids-sequence-block')) return;
      cancelTouchDrag?.();
      cancelProgramMove?.();
      event.preventDefault();
      event.stopPropagation();
      for (const id of pointers.keys()) builder.setPointerCapture(id);
      begin();
    }, true);
    window.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
      if (!gesture) return;
      event.preventDefault();
      event.stopPropagation();
      const points = [...pointers.values()];
      const center = points.length > 1 ? {x:(points[0].x + points[1].x) / 2, y:(points[0].y + points[1].y) / 2} : points[0];
      if (points.length > 1 && gesture.distance > 0) {
        const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        kidsZoom = Math.round(Math.max(.55, Math.min(1.5, gesture.zoom * distance / gesture.distance)) * 1000) / 1000;
        const bounds = builder.getBoundingClientRect();
        viewPan = {x:center.x - bounds.left - gesture.world.x * kidsZoom, y:center.y - bounds.top - gesture.world.y * kidsZoom};
      } else viewPan = {x:gesture.pan.x + center.x - gesture.center.x, y:gesture.pan.y + center.y - gesture.center.y};
      applyKidsZoom();
    }, {capture:true, passive:false});
    function finish(event) {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      if (builder.hasPointerCapture(event.pointerId)) builder.releasePointerCapture(event.pointerId);
      if (!gesture) return;
      event.stopPropagation();
      if (pointers.size) begin();
      else { cleanup(); save(); }
    }
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
  }

  function attachCanvasDrop(builder) {
    attachCanvasGestures(builder);
    builder.addEventListener('wheel', event => {
      if (!kidsMode || event.target.closest('#kidsPaletteDock, .sensor-row, input')) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = Math.max(-120, Math.min(120, event.deltaY * (event.deltaMode === 1 ? 16 : 1)));
      const next = Math.max(.55, Math.min(1.5, kidsZoom * Math.exp(-delta * .00045)));
      if (Math.abs(next - kidsZoom) < .001) return;
      const bounds = builder.getBoundingClientRect();
      const cursorX = event.clientX - bounds.left;
      const cursorY = event.clientY - bounds.top;
      const worldX = (cursorX - viewPan.x) / kidsZoom;
      const worldY = (cursorY - viewPan.y) / kidsZoom;
      kidsZoom = Math.round(next * 1000) / 1000;
      viewPan = {x:cursorX - worldX * kidsZoom, y:cursorY - worldY * kidsZoom};
      applyKidsZoom();
      clearTimeout(zoomCommitTimer);
      zoomCommitTimer = setTimeout(() => { zoomCommitTimer = null; save(); }, 180);
    }, {capture:true, passive:false});
    builder.addEventListener('dragover', event => {
      if (!kidsMode || event.target.closest('#kidsPaletteDock')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    builder.addEventListener('drop', event => {
      if (!kidsMode || event.target.closest('#kidsPaletteDock, #kidsSequence')) return;
      event.preventDefault();
      let payload;
      try { payload = JSON.parse(event.dataTransfer.getData('text/plain')); } catch (_) { return; }
      completedDrag = true;
      dropNearChainOrCanvas(payload, event);
    });
  }

  function attachPaletteScroll(palette) {
    palette.addEventListener('pointerdown', event => {
      if (!kidsMode || event.pointerType === 'mouse' || event.target.closest('.kids-jr-block, button')) return;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const initialScroll = palette.scrollLeft;
      palette.setPointerCapture(pointerId);
      function move(next) {
        if (next.pointerId !== pointerId) return;
        next.preventDefault();
        palette.scrollLeft = initialScroll - next.clientX + startX;
      }
      function finish(next) {
        if (next.pointerId !== pointerId) return;
        palette.removeEventListener('pointermove', move);
        palette.removeEventListener('pointerup', finish);
        palette.removeEventListener('pointercancel', finish);
        if (palette.hasPointerCapture(pointerId)) palette.releasePointerCapture(pointerId);
      }
      palette.addEventListener('pointermove', move, {passive:false});
      palette.addEventListener('pointerup', finish);
      palette.addEventListener('pointercancel', finish);
    });
  }

  function xmlNumber(name, value) {
    const wrapper = document.createElement('value');
    wrapper.setAttribute('name', name);
    const shadow = document.createElement('shadow');
    shadow.setAttribute('type', 'math_number');
    const field = document.createElement('field');
    field.setAttribute('name', 'NUM');
    field.textContent = String(value);
    shadow.appendChild(field);
    wrapper.appendChild(shadow);
    return wrapper;
  }

  function xmlField(name, value) {
    const field = document.createElement('field');
    field.setAttribute('name', name);
    field.textContent = String(value);
    return field;
  }

  function xmlBlock(type) {
    const block = document.createElement('block');
    block.setAttribute('type', type);
    return block;
  }

  function xmlForNode(node) {
    const value = node.param ?? defs[node.type]?.param;
    let block;
    switch (node.type) {
      case 'forward': case 'back': case 'drive_time':
        block = xmlBlock('robot_move_soft');
        block.append(xmlNumber('TARGET', node.type === 'back' ? -60 : 60), xmlNumber('SEC', Number(value) || 1));
        break;
      case 'left': case 'right': case 'uturn_left': case 'uturn_right':
        block = xmlBlock('robot_turn_timed');
        block.append(xmlField('DIR', node.type === 'right' || node.type === 'uturn_right' ? 'RIGHT' : 'LEFT'), xmlNumber('SEC', node.type.startsWith('uturn_') ? 1 : Math.max(.1, Number(value) / 180)));
        break;
      case 'slow': case 'fast':
        block = xmlBlock('robot_set_speed'); block.append(xmlNumber('SPEED', node.type === 'slow' ? 30 : 80)); break;
      case 'motor_stop': case 'end': block = xmlBlock('robot_stop'); break;
      case 'wall_distance': case 'line_color':
        block = xmlBlock('wait_until_sensor');
        block.append(xmlField('SENS', (node.sensorPort ?? defs[node.type].sensorPort) - 1),
          xmlField('OP', node.type === 'line_color' && value !== 'white' ? 'GT' : 'LT'),
          xmlNumber('VAL', node.type === 'line_color' ? 50 : Number(value)));
        break;
      case 'wait': block = xmlBlock('wait_seconds'); block.append(xmlNumber('SECONDS', Number(value) || 1)); break;
      case 'smile': block = xmlBlock('disp_smile'); block.append(xmlField('FACE', 'happy')); break;
      case 'say':
        return centeredTextBlocks(String(value ?? 'HI'));
      case 'clear': block = xmlBlock('disp_clear'); break;
      case 'repeat': case 'forever':
        block = xmlBlock(node.type === 'forever' ? 'loop_forever' : 'controls_repeat_ext');
        if (node.type === 'repeat') block.append(xmlNumber('TIMES', Number(value) || 3));
        if (node.children?.length) {
          const statement = document.createElement('statement');
          statement.setAttribute('name', 'DO');
          statement.appendChild(xmlChain(node.children));
          block.appendChild(statement);
        }
        break;
      default: return [];
    }
    return node.type === 'smile' || node.type === 'say' || node.type === 'clear' ? [block, xmlBlock('disp_send')] : [block];
  }

  function centeredTextBlocks(text) {
    const lines = [];
    for (const paragraph of text.split(/\r?\n/)) {
      let remaining = paragraph.trim();
      while (remaining.length > 21) {
        const space = remaining.lastIndexOf(' ', 21);
        const split = space > 0 ? space : 21;
        lines.push(remaining.slice(0, split));
        remaining = remaining.slice(split).trimStart();
      }
      lines.push(remaining);
    }
    const visible = lines.slice(0, 8);
    const top = Math.floor((64 - (visible.length * 8 - 1)) / 2);
    return [xmlBlock('disp_clear'), ...visible.map((line, index) => {
      const block = xmlBlock('disp_text');
      block.append(xmlField('TXT', line), xmlField('SIZE', 'small'),
        xmlNumber('X', Math.floor((128 - Math.max(0, line.length * 6 - 1)) / 2)), xmlNumber('Y', top + index * 8));
      return block;
    }), xmlBlock('disp_send')];
  }

  function xmlChain(nodes) {
    let first = null;
    let previous = null;
    for (const node of nodes) {
      if (node.type === 'start') continue;
      xmlForNode(node).forEach(block => {
        if (!first) first = block;
        if (previous) {
          const next = document.createElement('next');
          next.appendChild(block);
          previous.appendChild(next);
        }
        previous = block;
      });
      if (node.type === 'forever') break;
    }
    return first;
  }

  function restoreNormalWorkspace() {
    if (!normalWorkspaceBackup) return;
    const backup = normalWorkspaceBackup;
    normalWorkspaceBackup = null;
    Promise.resolve(typeof window.stopCode === 'function' ? window.stopCode() : null).catch(() => {}).then(() => {
      const workspace = getWorkspace();
      if (!workspace || !window.Blockly?.Xml) return;
      workspace.clear();
      Blockly.Xml.domToWorkspace(backup, workspace);
    });
  }

  window.kidsRunProgram = function () {
    const workspace = getWorkspace();
    if (!workspace || !window.Blockly?.Xml) { alert('Редактор ще завантажується.'); return; }
    const xml = document.createElement('xml');
    const start = xmlBlock('start_hat');
    xml.appendChild(start);
    const first = xmlChain(program);
    if (first) { const next = document.createElement('next'); next.appendChild(first); start.appendChild(next); }
    try {
      if (!normalWorkspaceBackup) normalWorkspaceBackup = Blockly.Xml.workspaceToDom(workspace);
      workspace.clear();
      Blockly.Xml.domToWorkspace(xml, workspace);
      if (typeof window.toggleRunState === 'function') window.toggleRunState();
      else if (typeof window.runCode === 'function') window.runCode();
    } catch (error) { console.warn('[ROB0] Не вдалося запустити дитячу програму', error); }
  };

  window.kidsClearProgram = function () { program = []; floatingBlocks = []; activeLoopId = null; save(); renderSequence(); };
  window.kidsExitLoop = function () {
    activeLoopId = activeLoopId ? findLocation(activeLoopId)?.parentId || null : null;
    renderSequence();
  };

  function showView(viewId, button) {
    try { if (typeof window.switchView === 'function') window.switchView(viewId, button); } catch (_) {}
    document.querySelectorAll('section[id^="view-"]').forEach(section => {
      const active = section.id === viewId;
      section.classList.toggle('hidden', !active);
      section.classList.toggle('opacity-0', !active);
    });
    document.querySelectorAll('#rcTopNav .nav-btn').forEach(nav => nav.classList.toggle('active', nav === button));
  }

  function updateButton() {
    const button = byId('kidsModeNavBtn');
    if (!button) return;
    button.classList.toggle('kids-active', kidsMode);
    button.setAttribute('aria-pressed', String(kidsMode));
    button.title = kidsMode ? 'Дитячі блоки увімкнено' : 'Для дітей';
  }

  function restoreDock() {
    cancelTouchDrag?.();
    cancelProgramMove?.();
    cancelCanvasGesture?.();
    document.body.classList.remove('rb-kids-editor');
    const dock = byId('kidsPaletteDock');
    const sequence = byId('kidsSequence');
    const home = byId('view-kids');
    const stage = byId('kidsStage');
    const builder = byId('view-builder');
    if (zoomCommitTimer) { clearTimeout(zoomCommitTimer); zoomCommitTimer = null; save(); }
    if (dock && home && dock.parentElement !== home) home.appendChild(dock);
    if (sequence && stage && sequence.parentElement !== stage) stage.appendChild(sequence);
    if (sequence) sequence.style.transform = '';
    builder?.classList.remove('kids-canvas-mode');
    byId('kidsWorkspaceLayer')?.remove();
    byId('kidsGridLayer')?.remove();
  }

  window.rbSetKidsMode = function (enabled) {
    kidsMode = Boolean(enabled);
    updateButton();
    const workspace = getWorkspace();
    const toolbox = byId(kidsMode ? 'kidsToolbox' : 'toolbox');
    try { if (workspace && toolbox) workspace.updateToolbox(toolbox); } catch (_) {}
    return Boolean(workspace);
  };

  window.openKidsMode = function (button) {
    kidsMode = true;
    document.body.classList.add('rb-kids-editor');
    updateButton();
    const builder = byId('view-builder');
    if (builder) {
      let grid = byId('kidsGridLayer');
      if (!grid) {
        grid = document.createElement('div');
        grid.id = 'kidsGridLayer';
        grid.setAttribute('aria-hidden', 'true');
      }
      let layer = byId('kidsWorkspaceLayer');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'kidsWorkspaceLayer';
      }
      layer.appendChild(byId('kidsSequence'));
      builder.append(grid, layer, byId('kidsPaletteDock'));
      builder.classList.add('kids-canvas-mode');
      grid.style.backgroundColor = getComputedStyle(byId('blocklyDiv')).backgroundColor;
    }
    showView('view-builder', button);
    renderPalette();
    renderSequence();
    updateKidsViewport();
  };

  window.closeKidsMode = function () {
    restoreDock();
    window.rbSetKidsMode(false);
    restoreNormalWorkspace();
    showView('view-joystick', document.querySelector('#rcTopNav button[title="Пульт"]'));
  };

  window.openBlockMode = function (button) {
    restoreDock();
    window.rbSetKidsMode(false);
    restoreNormalWorkspace();
    showView('view-builder', button);
  };

  window.addEventListener('load', () => {
    const sequence = byId('kidsSequence');
    if (sequence) attachDrop(sequence, null);
    const builder = byId('view-builder');
    if (builder) attachCanvasDrop(builder);
    if (byId('kidsPalette')) attachPaletteScroll(byId('kidsPalette'));
    window.addEventListener('resize', updateKidsViewport);
    window.visualViewport?.addEventListener('resize', updateKidsViewport);
    window.visualViewport?.addEventListener('scroll', updateKidsViewport);
    updateKidsViewport();
    const runButton = byId('globalRunBtn');
    if (runButton) runButton.addEventListener('click', event => {
      if (!kidsMode) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.kidsRunProgram();
    }, true);
    renderPalette();
    renderSequence();
    updateHistoryButtons();
    updateButton();
  });
})();
