(function () {
  'use strict';

  function init() {
    const builder = document.getElementById('view-builder');
    const Blockly = window.Blockly;
    if (!builder || !Blockly) return;

    function editorState() {
      const visible = !builder.classList.contains('hidden') &&
        !builder.hidden && getComputedStyle(builder).display !== 'none';
      const kids = builder.classList.contains('kids-canvas-mode');
      return {visible, kids, key:visible + ':' + kids};
    }

    function dismiss() {
      // Blockly's widgets live under <body>, outside the section being hidden.
      Blockly.hideChaff?.();
      Blockly.ContextMenu?.hide?.();
      Blockly.DropDownDiv?.hideWithoutAnimation?.();
      Blockly.WidgetDiv?.hide?.();
    }

    let state = editorState();
    new MutationObserver(() => {
      const next = editorState();
      if (next.key !== state.key) dismiss();
      state = next;
    }).observe(builder, {attributes:true, attributeFilter:['class', 'style', 'hidden']});

    const contextMenu = Blockly.ContextMenu;
    if (typeof contextMenu?.show === 'function') {
      const show = contextMenu.show;
      contextMenu.show = function (...args) {
        const current = editorState();
        if (!current.visible || current.kids) { dismiss(); return; }
        return show.apply(this, args);
      };
    }

    if (!state.visible || state.kids) dismiss();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
