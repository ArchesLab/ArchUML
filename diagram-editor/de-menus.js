(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.menus) parts.menus = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The menus and choosers of a session (UML-view editing spec §2.2, §3.3; plan Task 23): the context menus of a
  // drawn box, a line, a sequence detail, and the canvas, and the choosers of a new box's kind and of a relation's
  // kind. A menu or a chooser takes Escape through the host's Escape order (host.registerEscape), and a press outside
  // it closes it. One of each is open at a time; this part owns which.

  /**
   * The menus and choosers. `openMenu(clientX, clientY, items)` and `openChooser(clientX, clientY, sourceId, onPick)`
   * are the menu and the element chooser as a host or a surface opens them (showContextMenu, showElementChooser).
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
   * values and the session's functions it uses when it is made, and what it uses of the other parts when the session
   * calls its link(), once every part and the pointer driver exist. Its members join the kit.
   * Changed statements: the applies go through `kit.commands`.
   */
  function createMenus(kit) {
    // What the session made this part with.
    var commands = kit.commands;
    var diagramSupportsAnchoredNotes = kit.diagramSupportsAnchoredNotes;
    var elementSchemasFor = kit.elementSchemasFor;
    var env = kit.env;
    var host = kit.host;
    var joiningPreviousStep = kit.joiningPreviousStep;
    var output = kit.output;
    var relationSchemasFor = kit.relationSchemasFor;
    var setSelectedLayoutId = kit.setSelectedLayoutId;
    var wrap = kit.wrap;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var addBendFromMenu, announce, bendableRoute, bends, buildOperation, deleteSelected, documentType, duplicateElement,
      editorCanvasPoint, invertRelationDirection, moveBendFromMenu, moveFromMenu, placeElementAt, relationAddFacts,
      removeBendFromMenu, selectAll, setActiveTool, startInlineRename, straightenFromMenu, zoomToFit;

    // The unregister functions of the Escape layers of an open menu and an open chooser.
    var contextMenuEscape = null;
    var chooserEscape = null;
    // ─── Hover-to-extend "+" handle + relation chooser popup ───
    var relationChooser = null;
    var relationChooserReturnFocus = null;
    function closeRelationChooser(restoreFocus) {
      if (relationChooser && relationChooser.parentNode) relationChooser.parentNode.removeChild(relationChooser);
      relationChooser = null;
      if (restoreFocus && relationChooserReturnFocus && relationChooserReturnFocus.focus) {
        try { relationChooserReturnFocus.focus(); } catch (e) {}
      }
      relationChooserReturnFocus = null;
    }
    // ─── Right-click context menu ───
    var contextMenu = null;
    var contextMenuReturnFocus = null;
    function closeContextMenu(restoreFocus) {
      if (contextMenu && contextMenu.parentNode) contextMenu.parentNode.removeChild(contextMenu);
      contextMenu = null;
      env.document.removeEventListener('pointerdown', dismissContextMenuOnOutside, true);
      env.document.removeEventListener('contextmenu', cancelContextMenuAtOpenMenu, true);
      if (contextMenuEscape) { contextMenuEscape(); contextMenuEscape = null; }
      if (restoreFocus && contextMenuReturnFocus && contextMenuReturnFocus.focus) {
        try { contextMenuReturnFocus.focus(); } catch (e) {}
      }
      contextMenuReturnFocus = null;
    }
    function dismissContextMenuOnOutside(ev) {
      if (!contextMenu) return closeContextMenu();
      if (!contextMenu.contains(ev.target)) closeContextMenu();
    }
    // Whether `target` is the diagram item an open menu belongs to: the element focused when it opened, or a hit
    // target of the same item.
    function isOpenMenusItem(target) {
      var item = contextMenuReturnFocus;
      if (!item || !target) return false;
      if (target === item) return true;
      var id = item.getAttribute && item.getAttribute('data-layout-id');
      return !!id && !!target.closest && !!target.closest('.uml-pg-edit-layer') &&
        target.getAttribute('data-layout-id') === id;
    }
    // While a menu is open, a contextmenu event aimed at its item or at the menu (the one Windows and Linux browsers
    // send for Shift+F10 or the Menu key after the surface has opened the menu) opens nothing (spec §3.11).
    function cancelContextMenuAtOpenMenu(ev) {
      if (!contextMenu) return;
      if (contextMenu.contains(ev.target) || isOpenMenusItem(ev.target)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }
    function dismissContextMenuOnEsc(ev) {
      if (!contextMenu) return closeContextMenu();
      if (ev.key === 'Escape') { ev.preventDefault(); closeContextMenu(true); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        var btns = Array.prototype.slice.call(contextMenu.querySelectorAll('button'));
        var i = btns.indexOf(env.document.activeElement);
        var next = ev.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
        if (btns[next]) btns[next].focus();
      }
    }
    /**
     * Show a context menu at (clientX, clientY) with the given items.
     * @param {number} clientX, clientY
     * @param {Array<{label, kbd, onClick, danger, separator}>} items
     */
    function showContextMenu(clientX, clientY, items) {
      closeContextMenu();
      contextMenuReturnFocus = env.document.activeElement;
      var box = env.document.createElement('div');
      box.className = 'uml-pg-context-menu';
      box.setAttribute('role', 'menu');
      items.filter(Boolean).forEach(function (item) {
        if (item.separator) {
          box.appendChild(env.document.createElement('hr'));
          return;
        }
        var btn = env.document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'menuitem');
        if (item.danger) btn.classList.add('is-danger');
        btn.appendChild(env.document.createTextNode(item.label));
        if (item.kbd) {
          var kbd = env.document.createElement('span');
          kbd.className = 'uml-pg-context-key';
          kbd.textContent = item.kbd;
          btn.appendChild(kbd);
        }
        btn.addEventListener('click', function () {
          closeContextMenu();
          item.onClick();
        });
        box.appendChild(btn);
      });
      wrap.appendChild(box);
      var W = env.document.defaultView.innerWidth, H = env.document.defaultView.innerHeight;
      var rect = box.getBoundingClientRect();
      var x = Math.min(Math.max(clientX, 8), W - rect.width - 8);
      var y = Math.min(Math.max(clientY, 8), H - rect.height - 8);
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      var firstBtn = box.querySelector('button');
      if (firstBtn) firstBtn.focus();
      env.document.addEventListener('contextmenu', cancelContextMenuAtOpenMenu, true);
      // The menu takes its keys at once (Task 25c), so Escape right after a key or a click opened it closes it: the
      // event that opened it has passed the document already. A press outside closes it from the next task on.
      contextMenuEscape = host.registerEscape({ onKey: dismissContextMenuOnEsc });
      env.schedule(function () {
        env.document.addEventListener('pointerdown', dismissContextMenuOnOutside, true);
      }, 0);
      contextMenu = box;
    }
    function calloutContextAction(id, kind) {
      if (!host.offersForm('callout')) return null;
      return { label: 'Add callout', onClick: function () {
        setSelectedLayoutId(id, kind);
        host.openForm('callout');
      } };
    }
    function buildSequenceDetailContextMenu(id, kind, clientX, clientY) {
      showContextMenu(clientX, clientY, [
        { label: 'Edit properties', onClick: function () { setSelectedLayoutId(id, kind); } },
        calloutContextAction(id, kind),
        { separator: true },
        { label: 'Delete', danger: true, onClick: function () { setSelectedLayoutId(id, kind); deleteSelected(); } }
      ]);
    }
    function buildElementContextMenu(item, clientX, clientY) {
      var items = [
        { label: 'Rename label', kbd: 'F2 / dbl-click', onClick: function () { startInlineRename(item); } },
        { label: 'Edit properties', kbd: 'click', onClick: function () { setSelectedLayoutId(item.id, 'node'); /* props pane is already shown */ } },
        // A move without a drag (spec §3.11): the item, and the rest of the selection, as its drag moves them.
        { label: 'Move…', onClick: function () { moveFromMenu(item); } },
        calloutContextAction(item.id, 'node'),
        { label: 'Duplicate', onClick: function () { duplicateElement(item.id); } },
        { separator: true },
        { label: 'Delete', kbd: 'Del', danger: true, onClick: function () { setSelectedLayoutId(item.id, 'node'); deleteSelected(); } }
      ];
      if (host.offersForm('members')) {
        const memberActions = ['attribute', 'method'].map(function (kind) {
          return { label: 'Add ' + kind, onClick: function () {
            setActiveTool(null);
            setSelectedLayoutId(item.id, 'node');
            host.openForm(kind);
          } };
        });
        items.splice(1, 0, ...memberActions);
      }
      showContextMenu(clientX, clientY, items);
    }
    function buildRouteContextMenu(routeId, clientX, clientY) {
      var items = [
        { label: 'Edit relation', onClick: function () { setSelectedLayoutId(routeId, 'route'); } }
      ].concat(bendItems(routeId), [
        calloutContextAction(routeId, 'route'),
        { label: 'Invert direction', onClick: function () { setSelectedLayoutId(routeId, 'route'); invertRelationDirection(routeId); } },
        { separator: true },
        { label: 'Delete', kbd: 'Del', danger: true, onClick: function () { setSelectedLayoutId(routeId, 'route'); deleteSelected(); } }
      ]);
      showContextMenu(clientX, clientY, items);
    }
    // The bend items of a line's menu (spec §3.11), only on a line whose segment drag bends it today (not a sequence
    // message): "Add a bend"; "Move bend n…" and "Remove bend n" for each bend; "Straighten" when it has a bend.
    function bendItems(routeId) {
      if (!bendableRoute(output.querySelector('svg'), routeId)) return [];
      var ref = { id: routeId, kind: 'route' };
      var items = [{ label: 'Add a bend', onClick: function () { addBendFromMenu(routeId); } }];
      bends(ref).forEach(function (bend) {
        items.push({ label: 'Move bend ' + bend.n + '…', onClick: function () { moveBendFromMenu(routeId, bend.n); } });
        items.push({ label: 'Remove bend ' + bend.n, onClick: function () { removeBendFromMenu(routeId, bend.n); } });
      });
      if (items.length > 1) items.push({ label: 'Straighten', onClick: function () { straightenFromMenu(routeId); } });
      return items;
    }
    function buildCanvasContextMenu(clientX, clientY) {
      var items = [];
      var els = elementSchemasFor(documentType()).filter(function (spec) {
        if (documentType() === 'sequence') return !spec.sequenceControl && !spec.sequenceNote;
        if (diagramSupportsAnchoredNotes(documentType()) && spec.isNote) return false;
        return true;
      }).slice(0, 4);
      els.forEach(function (spec) {
        items.push({
          label: 'New ' + spec.label + ' here',
          onClick: function () {
            var svg = output.querySelector('svg');
            var pt = editorCanvasPoint(svg, clientX, clientY);
            placeElementAt(spec, pt);
          }
        });
      });
      if (items.length) items.push({ separator: true });
      items.push({ label: 'Select all', kbd: 'Cmd/Ctrl+A', onClick: selectAll });
      items.push({ label: 'Reset zoom + pan', kbd: 'Cmd/Ctrl+0', onClick: zoomToFit });
      showContextMenu(clientX, clientY, items);
    }
    /**
     * Floating chooser of element types for the current diagram. Used when a
     * "+" handle drag lands on empty canvas — the user picks an element type
     * and we then chain through to the relation-type chooser. The signature is
     * intentionally similar to showRelationChooser.
     */
    function showElementChooser(clientX, clientY, sourceId, onPick) {
      closeRelationChooser();
      relationChooserReturnFocus = env.document.activeElement;
      var type = documentType();
      var els = elementSchemasFor(type).filter(function (spec) {
        if (type === 'sequence') return !spec.sequenceControl && !spec.sequenceNote;
        return true;
      });
      if (!els.length) { onPick(null); return; }
      var box = env.document.createElement('div');
      box.className = 'uml-pg-relation-chooser';
      box.setAttribute('role', 'menu');
      box.setAttribute('aria-label', 'Pick an element type to create');
      var title = env.document.createElement('div');
      title.className = 'uml-pg-relation-chooser-title';
      title.textContent = 'Create new element from "' + sourceId + '"';
      box.appendChild(title);
      els.forEach(function (spec) {
        var btn = env.document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'menuitem');
        var glyph = env.document.createElement('span');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.className = 'uml-pg-chooser-glyph';
        glyph.textContent = spec.glyph || '▢';
        btn.appendChild(glyph);
        btn.appendChild(env.document.createTextNode(spec.label));
        btn.addEventListener('click', function () {
          closeRelationChooser();
          cleanupChooserListeners();
          onPick(spec);
        });
        box.appendChild(btn);
      });
      wrap.appendChild(box);
      var W = env.document.defaultView.innerWidth, H = env.document.defaultView.innerHeight;
      var rect = box.getBoundingClientRect();
      var x = Math.min(Math.max(clientX, 8), W - rect.width - 8);
      var y = Math.min(Math.max(clientY, 8), H - rect.height - 8);
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      var firstBtn = box.querySelector('button');
      if (firstBtn) firstBtn.focus();
      env.schedule(function () {
        env.document.addEventListener('pointerdown', dismissOnOutside, true);
        chooserEscape = host.registerEscape({ onKey: dismissOnEsc });
      }, 0);
      relationChooser = box; // re-use the same global so dismissOnOutside / Esc works
    }
    function showRelationChooser(clientX, clientY, sourceId, targetId) {
      closeRelationChooser();
      relationChooserReturnFocus = env.document.activeElement;
      var type = documentType();
      var rels = relationSchemasFor(type);
      if (!rels.length) return;
      var box = env.document.createElement('div');
      box.className = 'uml-pg-relation-chooser';
      box.setAttribute('role', 'menu');
      box.setAttribute('aria-label', 'Pick a relation type');
      var title = env.document.createElement('div');
      title.className = 'uml-pg-relation-chooser-title';
      title.textContent = 'Connect "' + sourceId + '" → "' + targetId + '"';
      box.appendChild(title);
      rels.forEach(function (spec, idx) {
        var btn = env.document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'menuitem');
        var glyph = env.document.createElement('span');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.className = 'uml-pg-chooser-glyph';
        glyph.textContent = spec.glyph || '→';
        btn.appendChild(glyph);
        btn.appendChild(env.document.createTextNode(spec.label));
        btn.addEventListener('click', function () {
          closeRelationChooser();
          setActiveTool(null);
          // As today, the chosen relation takes no undo step of its own.
          commands.apply(joiningPreviousStep(buildOperation('relation.add',
            { tool: spec.id, from: sourceId, to: targetId, label: null }, relationAddFacts(null), null)));
          announce('Added ' + spec.label + ' from "' + sourceId + '" to "' + targetId + '".', false);
        });
        box.appendChild(btn);
      });
      wrap.appendChild(box);
      // Position near the cursor, kept inside the viewport.
      var W = env.document.defaultView.innerWidth, H = env.document.defaultView.innerHeight;
      var rect = box.getBoundingClientRect();
      var x = Math.min(Math.max(clientX, 8), W - rect.width - 8);
      var y = Math.min(Math.max(clientY, 8), H - rect.height - 8);
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      // Focus first item for keyboard nav.
      var firstBtn = box.querySelector('button');
      if (firstBtn) firstBtn.focus();
      // Close on outside click / Escape.
      env.schedule(function () {
        env.document.addEventListener('pointerdown', dismissOnOutside, true);
        chooserEscape = host.registerEscape({ onKey: dismissOnEsc });
      }, 0);
      relationChooser = box;
    }
    function dismissOnOutside(ev) {
      if (!relationChooser) return cleanupChooserListeners();
      if (!relationChooser.contains(ev.target)) {
        closeRelationChooser();
        cleanupChooserListeners();
      }
    }
    function dismissOnEsc(ev) {
      if (!relationChooser) return cleanupChooserListeners();
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeRelationChooser(true);
        cleanupChooserListeners();
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        var btns = Array.prototype.slice.call(relationChooser.querySelectorAll('button'));
        var i = btns.indexOf(env.document.activeElement);
        var next = ev.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
        if (btns[next]) btns[next].focus();
      }
    }
    function cleanupChooserListeners() {
      env.document.removeEventListener('pointerdown', dismissOnOutside, true);
      if (chooserEscape) { chooserEscape(); chooserEscape = null; }
    }

    return {
      link: function () {
        addBendFromMenu = kit.addBendFromMenu;
        announce = kit.announce;
        bendableRoute = kit.bendableRoute;
        bends = kit.bends;
        moveBendFromMenu = kit.moveBendFromMenu;
        moveFromMenu = kit.moveFromMenu;
        removeBendFromMenu = kit.removeBendFromMenu;
        straightenFromMenu = kit.straightenFromMenu;
        buildOperation = kit.buildOperation;
        deleteSelected = kit.deleteSelected;
        documentType = kit.documentType;
        duplicateElement = kit.duplicateElement;
        editorCanvasPoint = kit.editorCanvasPoint;
        invertRelationDirection = kit.invertRelationDirection;
        placeElementAt = kit.placeElementAt;
        relationAddFacts = kit.relationAddFacts;
        selectAll = kit.selectAll;
        setActiveTool = kit.setActiveTool;
        startInlineRename = kit.startInlineRename;
        zoomToFit = kit.zoomToFit;
      },
      members: {
        buildCanvasContextMenu: buildCanvasContextMenu,
        buildElementContextMenu: buildElementContextMenu,
        buildRouteContextMenu: buildRouteContextMenu,
        buildSequenceDetailContextMenu: buildSequenceDetailContextMenu,
        cleanupChooserListeners: cleanupChooserListeners,
        closeContextMenu: closeContextMenu,
        closeRelationChooser: closeRelationChooser,
        openChooser: showElementChooser,
        openMenu: showContextMenu,
        showElementChooser: showElementChooser,
        showRelationChooser: showRelationChooser
      }
    };
  }

  return { createMenus: createMenus };
});
