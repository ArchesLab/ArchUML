(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.gesturesMarquee) parts.gesturesMarquee = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The marquee of a session (UML-view editing spec §2.2, §3.8; plan Task 23): the gesture factory `marquee`, a
  // Shift+drag from anywhere in the preview pane (no tool armed, not on a drawn item) that selects every item the box
  // it draws touches.

  /**
   * The marquee gesture.
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
   * values and the session's functions it uses when it is made, and what it uses of the other parts when the session
   * calls its link(), once every part and the pointer driver exist. Its members join the kit.
   */
  function createMarqueeGesture(kit) {
    // What the session made this part with.
    var env = kit.env;
    var output = kit.output;
    var previewPane = kit.previewPane;
    var setSelectedLayoutId = kit.setSelectedLayoutId;
    var wrap = kit.wrap;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var announce, toolState;

    // The marquee: Shift+drag from anywhere in the preview pane (no tool armed, not on a drawn item)
    // selects every item the box it draws touches.
    function startMarquee(ev, press) {
      if (press.site !== 'preview') return null;
      if (!ev.shiftKey || toolState.activeTool) return null;
      // Don't compete with hitbox/handle/edge listeners.
      var t = ev.target;
      while (t && t !== previewPane) {
        if (t.classList && (
            t.classList.contains('uml-pg-edit-a11y-target') ||
            t.classList.contains('uml-pg-edit-hitbox') ||
            t.classList.contains('uml-pg-edge-hitbox') ||
            t.classList.contains('uml-pg-extend-handle') ||
            t.classList.contains('uml-pg-extend-handle-group'))) {
          return null;
        }
        t = t.parentNode;
      }
      ev.preventDefault();
      var startX = ev.clientX, startY = ev.clientY;
      var lastX = startX, lastY = startY;
      var moved = false;
      var box = null;
      var extend = ev.metaKey || ev.ctrlKey;
      function ensureBox() {
        if (box) return box;
        box = env.document.createElement('div');
        box.className = 'uml-pg-marquee-box';
        wrap.appendChild(box);
        return box;
      }
      function update(x, y) {
        var b = ensureBox();
        b.style.left = Math.min(startX, x) + 'px';
        b.style.top = Math.min(startY, y) + 'px';
        b.style.width = Math.abs(x - startX) + 'px';
        b.style.height = Math.abs(y - startY) + 'px';
      }
      function commit() {
        var svg = output.querySelector('svg');
        if (!svg) return 0;
        var rectLeft = Math.min(startX, lastX);
        var rectTop = Math.min(startY, lastY);
        var rectRight = Math.max(startX, lastX);
        var rectBottom = Math.max(startY, lastY);
        // Tiny drags don't select — protects against accidental marquees.
        if (rectRight - rectLeft < 4 && rectBottom - rectTop < 4) return 0;
        if (!extend) setSelectedLayoutId(null);
        var picked = 0;
        var hits = Array.prototype.slice.call(svg.querySelectorAll('.uml-pg-edit-a11y-target'));
        hits.forEach(function (h) {
          var bb = h.getBoundingClientRect();
          if (bb.right < rectLeft || bb.left > rectRight) return;
          if (bb.bottom < rectTop || bb.top > rectBottom) return;
          var hid = h.getAttribute('data-layout-id');
          if (!hid) return;
          var hkind = h.getAttribute('data-layout-fragment-id') ? 'fragment' : 'node';
          setSelectedLayoutId(hid, hkind, { extend: true });
          picked += 1;
        });
        return picked;
      }
      return {
        move: function (mv) {
          var dx = mv.clientX - startX, dy = mv.clientY - startY;
          if (!moved && Math.abs(dx) <= 5 && Math.abs(dy) <= 5) return;
          moved = true;
          lastX = mv.clientX; lastY = mv.clientY;
          update(mv.clientX, mv.clientY);
        },
        end: function () {
          if (box) { box.remove(); box = null; }
          if (!moved) return;
          var picked = commit();
          announce(picked === 0
            ? 'No items in marquee.'
            : 'Selected ' + picked + ' item' + (picked === 1 ? '' : 's') + '.', false);
        },
        cancel: function () {
          if (box) { box.remove(); box = null; }
        }
      };
    }

    return {
      link: function () {
        announce = kit.announce;
        toolState = kit.toolState;
      },
      members: {
        startMarquee: startMarquee
      }
    };
  }

  return { createMarqueeGesture: createMarqueeGesture };
});
