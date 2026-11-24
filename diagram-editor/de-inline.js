(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./de-scene.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.inline) parts.inline = factory(parts.scene);
  }
})(typeof self !== 'undefined' ? self : this, function (scene) {
  'use strict';

  // The in-place text editors of a session (UML-view editing spec §2.2, §3.3; plan Task 23): renaming a drawn box,
  // editing a relation's label, a fragment's guard or its kind and guard, and a class member, in an input over the
  // drawing. One is open at a time; this part owns which (`currentInlineInput()`).
  //
  // startInlineEditor is the in-place editor a host or a surface opens over any anchor: an input with its label, its
  // instruction, its ids, and its commit and cancel, which takes Escape through the host's Escape order when asked.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var cssAttrEscape = scene.cssAttrEscape;
  var layoutBoundsElementsForId = scene.layoutBoundsElementsForId;

  /**
   * The classic in-place editors.
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
   * values and the session's functions it uses when it is made, and what it uses of the other parts when the session
   * calls its link(), once every part and the pointer driver exist. Its members join the kit.
   * Changed statements: the reads of the document and the applies go through `kit.commands`, and the class
   * declaration parser is `kit.serializers` (the text adapter's), since an editor holds no adapter (spec §2.1).
   */
  function createInlineEditors(kit) {
    // What the session made this part with.
    var commands = kit.commands;
    var env = kit.env;
    var focusLayoutTarget = kit.focusLayoutTarget;
    var host = kit.host;
    var output = kit.output;
    var parseMemberLine = kit.parseMemberLine;
    var selectedLayoutPrimaryId = kit.selectedLayoutPrimaryId;
    var serializers = kit.serializers;
    var wrap = kit.wrap;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var announce, buildOperation, changeFragmentBranchCondition, changeFragmentCondition, documentType,
      fragmentGuardLineEdit, relationInfoForRouteId, replaceRelationLine, setElementLabel, showVerdict;

    function startInlineRelationEdit(routeId, routeEl, clientX, clientY) {
      cancelInlineRename();
      var meta = relationInfoForRouteId(routeId);
      if (!meta || meta.lineIdx === -1 || !meta.info.kind) {
        announce('Select the relation to edit it in the properties panel.', false);
        return;
      }
      var input = env.document.createElement('input');
      input.type = 'text';
      input.className = 'uml-pg-inline-input is-relation-label';
      input.value = meta.info.label || '';
      input.placeholder = 'message label';
      input.setAttribute('aria-label', 'Edit relation label');
      var rect = routeEl && routeEl.getBoundingClientRect ? routeEl.getBoundingClientRect() : null;
      var left = clientX != null ? clientX : (rect ? rect.left + rect.width / 2 : env.document.defaultView.innerWidth / 2);
      var top = clientY != null ? clientY : (rect ? rect.top + rect.height / 2 : env.document.defaultView.innerHeight / 2);
      input.style.left = Math.max(8, Math.min(left - 90, env.document.defaultView.innerWidth - 220)) + 'px';
      input.style.top = Math.max(8, Math.min(top - 18, env.document.defaultView.innerHeight - 42)) + 'px';
      wrap.appendChild(input);
      input.focus();
      input.select();
      inlineRenameInput = input;
      inlineRenameCancel = cancel;

      function commit() {
        var next = input.value.trim();
        cleanup();
        if (next === meta.info.label) return;
        meta.info.label = next;
        replaceRelationLine(meta.ref, meta.info);
      }
      function cancel() {
        cleanup();
      }
      function cleanup() {
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', commit);
        if (input.parentNode) input.parentNode.removeChild(input);
        inlineRenameInput = null;
        inlineRenameCancel = null;
      }
      function onKey(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      }
      input.addEventListener('keydown', onKey);
      input.addEventListener('blur', commit);
    }
    // ─── In-canvas inline rename (updates references for named classifiers) ───
    var inlineRenameInput = null;
    var inlineRenameCancel = null;
    // The in-place input that is open, or null.
    function currentInlineInput() { return inlineRenameInput; }
    function startInlineRename(item) {
      cancelInlineRename();
      var svg = output.querySelector('svg');
      if (!svg) return;
      // The hitbox might have moved since the item was found — re-locate it.
      var hitbox = svg.querySelector('.uml-pg-edit-hitbox[data-layout-id="' + cssAttrEscape(item.id) + '"]');
      if (!hitbox) return;
      var labelTextNode = findElementLabelTextNode(svg, item);
      var rect = (labelTextNode || hitbox).getBoundingClientRect();
      var input = env.document.createElement('input');
      input.type = 'text';
      input.className = 'uml-pg-inline-input';
      input.value = item.label || item.id;
      input.setAttribute('aria-label', 'Rename ' + (item.label || item.id));
      input.style.left = rect.left + 'px';
      input.style.top = rect.top + 'px';
      input.style.width = Math.max(rect.width, 100) + 'px';
      input.style.minHeight = Math.max(rect.height, 28) + 'px';
      wrap.appendChild(input);
      input.focus();
      input.select();
      inlineRenameInput = input;
      inlineRenameCancel = cancel;

      var originalText = labelTextNode ? labelTextNode.textContent : null;
      function preview() {
        if (labelTextNode) labelTextNode.textContent = input.value;
      }
      function commit() {
        var newLabel = input.value.trim();
        // Restore the preview if the name is empty, unchanged, or rejected
        // (for example because another class already has that identifier).
        if (labelTextNode && originalText !== null) labelTextNode.textContent = originalText;
        cleanup();
        if (!newLabel || newLabel === item.label) return;
        host.startUndoStep();
        setElementLabel(item.id, newLabel);
      }
      function cancel() {
        if (labelTextNode && originalText !== null) labelTextNode.textContent = originalText;
        cleanup();
      }
      function cleanup() {
        input.removeEventListener('input', preview);
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', commit);
        if (input.parentNode) input.parentNode.removeChild(input);
        inlineRenameInput = null;
        inlineRenameCancel = null;
      }
      function onKey(ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commit();
          focusLayoutTarget(selectedLayoutPrimaryId() || item.id);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          cancel();
          focusLayoutTarget(item.id);
        }
      }
      input.addEventListener('input', preview);
      input.addEventListener('keydown', onKey);
      input.addEventListener('blur', commit);
    }
    function cancelInlineRename() {
      if (inlineRenameCancel) inlineRenameCancel();
    }
    function findElementLabelTextNode(svg, item) {
      // Find the SVG <text> element rendering the visible label so we can do
      // live preview during inline rename without re-rendering the diagram.
      var labels = [item.label, item.id].filter(Boolean).map(function (s) {
        return String(s).replace(/\s+/g, ' ').trim();
      });
      var texts = svg.querySelectorAll('text');
      for (var i = 0; i < texts.length; i++) {
        var t = texts[i];
        if (t.closest('.uml-pg-edit-layer') || t.closest('defs')) continue;
        var content = (t.textContent || '').replace(/\s+/g, ' ').trim();
        if (labels.indexOf(content) !== -1) return t;
      }
      return null;
    }
    function startInlineFragmentEdit(textEl, kind, currentCond) {
      cancelInlineRename();
      var rect = textEl.getBoundingClientRect();
      var input = env.document.createElement('input');
      input.type = 'text';
      input.className = 'uml-pg-inline-input';
      input.value = currentCond;
      input.placeholder = ({
        alt: 'condition',
        opt: 'if condition',
        loop: 'while condition',
        break: 'if condition',
        else: 'otherwise',
        par: ''
      })[kind] || 'condition';
      input.setAttribute('aria-label', kind + ' fragment condition');
      input.style.left = rect.left + 'px';
      input.style.top = rect.top + 'px';
      input.style.width = Math.max(rect.width + 80, 160) + 'px';
      input.style.minHeight = Math.max(rect.height + 4, 24) + 'px';
      wrap.appendChild(input);
      input.focus();
      input.select();
      inlineRenameInput = input;
      inlineRenameCancel = cancel;

      var originalText = textEl.textContent;
      function preview() {
        var v = input.value.trim();
        textEl.textContent = v ? kind + ' [' + v + ']' : kind;
      }
      function commit() {
        var newCond = input.value.trim();
        cleanup();
        // Find the matching source line and rewrite it.
        var lines = commands.contents().lines.slice();
        var pattern = new RegExp('^\\s*' + kind + '\\b(?:\\s*\\[.*?\\])?\\s*$', 'i');
        // Look for the *closest* matching line by content — start with one that
        // already has the same condition (preferred).
        var idx = -1;
        for (var i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i].trim()) &&
              (currentCond ? lines[i].indexOf(currentCond) !== -1 : !/\[/.test(lines[i]))) {
            idx = i; break;
          }
        }
        if (idx === -1) {
          // Fall back: any line of this kind.
          for (var j = 0; j < lines.length; j++) {
            if (pattern.test(lines[j].trim())) { idx = j; break; }
          }
        }
        if (idx === -1) return;
        // The line is a fragment's opener, or an else line of one: its guard becomes the typed text.
        commands.apply(buildOperation('fragment.update', fragmentGuardLineEdit(idx, kind, newCond), {}, null));
      }
      function cancel() {
        textEl.textContent = originalText;
        cleanup();
      }
      function cleanup() {
        input.removeEventListener('input', preview);
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', commit);
        if (input.parentNode) input.parentNode.removeChild(input);
        inlineRenameInput = null;
        inlineRenameCancel = null;
      }
      function onKey(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      }
      input.addEventListener('input', preview);
      input.addEventListener('keydown', onKey);
      input.addEventListener('blur', commit);
    }
    /**
     * Inline-edit a fragment guard text (`[condition]` on the opener, or
     * `[otherwise]` on a branch). Routed through changeFragmentCondition /
     * changeFragmentBranchCondition so the source rewrite is unambiguous.
     */
    function startInlineFragmentConditionEdit(textEl, fragId, branchLineIdx) {
      cancelInlineRename();
      var info = commands.contents().fragment(fragId);
      if (!info) return;
      var currentCond = '';
      if (branchLineIdx == null) {
        currentCond = info.condition || '';
      } else {
        var br = info.branches.find(function (b) { return b.lineIdx === branchLineIdx; });
        currentCond = br ? br.condition || '' : '';
      }
      var rect = textEl.getBoundingClientRect();
      var input = env.document.createElement('input');
      input.type = 'text';
      input.className = 'uml-pg-inline-input';
      input.value = currentCond;
      input.placeholder = branchLineIdx == null ? 'condition' : 'otherwise';
      input.setAttribute('aria-label', branchLineIdx == null
        ? info.kind + ' fragment condition'
        : 'fragment branch condition');
      input.style.left = rect.left + 'px';
      input.style.top = rect.top + 'px';
      input.style.width = Math.max(rect.width + 80, 160) + 'px';
      input.style.minHeight = Math.max(rect.height + 4, 24) + 'px';
      wrap.appendChild(input);
      input.focus();
      input.select();
      inlineRenameInput = input;
      inlineRenameCancel = cancel;

      var originalText = textEl.textContent;
      function preview() {
        var v = input.value.trim();
        textEl.textContent = v ? '[' + v + ']' : '';
      }
      function commit() {
        var newCond = input.value.trim();
        cleanup();
        if (branchLineIdx == null) {
          changeFragmentCondition(fragId, newCond);
        } else {
          changeFragmentBranchCondition(fragId, branchLineIdx, newCond);
        }
      }
      function cancel() {
        textEl.textContent = originalText;
        cleanup();
      }
      function cleanup() {
        input.removeEventListener('input', preview);
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', commit);
        if (input.parentNode) input.parentNode.removeChild(input);
        inlineRenameInput = null;
        inlineRenameCancel = null;
      }
      function onKey(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      }
      input.addEventListener('input', preview);
      input.addEventListener('keydown', onKey);
      input.addEventListener('blur', commit);
    }
    // ─── Class-member inline edit (double-click an attribute / method) ───
    function classMemberDisplayKey(member) {
      return ((member.visibility || '') + ' ' + member.text).replace(/\s+/g, ' ').trim();
    }
    function findClassMemberTextAt(svg, classId, clientX, clientY) {
      const line = commands.contents().declarationLine(classId, 'class');
      if (!line) return null;
      const info = serializers.parseClassDeclaration(line);
      if (!info.members.length) return null;
      const border = layoutBoundsElementsForId(svg, classId)[0];
      const divider = border && border.parentNode.querySelector('line');
      if (!divider) return null;
      const bounds = border.getBoundingClientRect();
      const bodyTop = divider.getBoundingClientRect().top;
      const occurrences = new Map();
      // ArchUML emits a class's labels immediately after its box group, with
      // attributes before methods. Keep ownership even when classes overlap,
      // and preserve occurrence order for duplicate signatures.
      for (let el = border.parentNode.nextElementSibling; el && el.tagName.toLowerCase() === 'text'; el = el.nextElementSibling) {
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        if (centerX < bounds.left || centerX > bounds.right || centerY <= bodyTop || centerY > bounds.bottom) continue;
        const key = classMemberDisplayKey(parseMemberLine(el.textContent || ''));
        const occurrence = occurrences.get(key) || 0;
        occurrences.set(key, occurrence + 1);
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
        const matches = info.members.map(function (member, index) {
          return classMemberDisplayKey(member) === key ? index : -1;
        }).filter(function (index) { return index !== -1; });
        if (matches[occurrence] !== undefined) return { index: matches[occurrence], textEl: el };
      }
      return null;
    }
    function startInlineMemberEdit(classId, memberIdx, textEl) {
      cancelInlineRename();
      var line = commands.contents().declarationLine(classId, 'class');
      if (!line) return;
      var info = serializers.parseClassDeclaration(line);
      var member = info.members[memberIdx];
      if (!member) return;
      // The revision of the document the edit starts on: a commit after another change does nothing.
      const revisionAtStart = commands.contents().revision;
      var rect = textEl.getBoundingClientRect();
      var input = env.document.createElement('input');
      input.type = 'text';
      input.className = 'uml-pg-inline-input';
      input.value = (member.visibility || '') +
                    (member.isAbstract ? ' {abstract}' : '') +
                    (member.isStatic ? ' {static}' : '') +
                    ' ' + (member.text || '');
      input.setAttribute('aria-label', 'Edit class member');
      input.style.left = rect.left + 'px';
      input.style.top = rect.top + 'px';
      input.style.width = Math.max(rect.width + 60, 160) + 'px';
      input.style.minHeight = Math.max(rect.height + 4, 24) + 'px';
      wrap.appendChild(input);
      input.focus();
      input.select();
      inlineRenameInput = input;
      inlineRenameCancel = cancel;

      var originalText = textEl.textContent;
      function preview() {
        textEl.textContent = input.value;
      }
      function commit() {
        var raw = input.value.trim();
        textEl.textContent = originalText;
        cleanup();
        if (!raw || documentType() !== 'class' || commands.contents().revision !== revisionAtStart) return;
        var parsed = parseMemberLine(raw);
        if (parsed.visibility === member.visibility && parsed.text === member.text &&
            parsed.isAbstract === member.isAbstract && parsed.isStatic === member.isStatic) return;
        // An omitted visibility stays omitted when editing inline as well.
        showVerdict(commands.apply(buildOperation('member.update',
          { owner: classId, list: 'members', index: memberIdx, text: raw }, {}, null)));
      }
      function cancel() {
        textEl.textContent = originalText;
        cleanup();
      }
      function cleanup() {
        input.removeEventListener('input', preview);
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', commit);
        if (input.parentNode) input.parentNode.removeChild(input);
        inlineRenameInput = null;
        inlineRenameCancel = null;
      }
      function onKey(ev) {
        if (ev.key !== 'Enter' && ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'Enter') commit();
        else cancel();
        focusLayoutTarget(classId);
      }
      input.addEventListener('input', preview);
      input.addEventListener('keydown', onKey);
      input.addEventListener('blur', commit);
    }

    return {
      link: function () {
        announce = kit.announce;
        buildOperation = kit.buildOperation;
        changeFragmentBranchCondition = kit.changeFragmentBranchCondition;
        changeFragmentCondition = kit.changeFragmentCondition;
        documentType = kit.documentType;
        fragmentGuardLineEdit = kit.fragmentGuardLineEdit;
        relationInfoForRouteId = kit.relationInfoForRouteId;
        replaceRelationLine = kit.replaceRelationLine;
        setElementLabel = kit.setElementLabel;
        showVerdict = kit.showVerdict;
      },
      members: {
        cancelInlineRename: cancelInlineRename,
        currentInlineInput: currentInlineInput,
        findClassMemberTextAt: findClassMemberTextAt,
        startInlineFragmentConditionEdit: startInlineFragmentConditionEdit,
        startInlineFragmentEdit: startInlineFragmentEdit,
        startInlineMemberEdit: startInlineMemberEdit,
        startInlineRelationEdit: startInlineRelationEdit,
        startInlineRename: startInlineRename
      }
    };
  }

  /**
   * An in-place text editor over `anchor` (a drawn element, or a client point `{ x, y }`), inside `root`: an input
   * labelled `label` that holds `value`, described by the sentence `instruction` when there is one, with ids that start
   * with `idPrefix`. Enter, or leaving the field, commits the trimmed text through `onCommit(text)`; Escape cancels
   * through `onCancel()`, by the host's Escape order when `registerEscape` (host.registerEscape) is given and by the
   * input's own key handler otherwise. Either ends the editor and removes what it added. Returns `{ input, cancel }`.
   */
  function startInlineEditor(options) {
    var root = options.root;
    var doc = root.ownerDocument;
    var anchor = options.anchor;
    var rect = anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : { left: anchor.x, top: anchor.y, width: 0, height: 0 };
    var input = doc.createElement('input');
    input.type = 'text';
    input.className = 'uml-pg-inline-input';
    input.id = options.idPrefix + 'inline-input';
    input.value = options.value || '';
    input.setAttribute('aria-label', options.label);
    var description = null;
    if (options.instruction) {
      description = doc.createElement('p');
      description.id = options.idPrefix + 'inline-instruction';
      description.className = 'uml-pg-inline-instruction';
      description.textContent = options.instruction;
      input.setAttribute('aria-describedby', description.id);
      root.appendChild(description);
    }
    input.style.left = rect.left + 'px';
    input.style.top = rect.top + 'px';
    input.style.width = Math.max(rect.width, 100) + 'px';
    root.appendChild(input);
    var unregisterEscape = options.registerEscape ? options.registerEscape({ onKey: onEscapeKey }) : null;
    var ended = false;

    function end() {
      if (ended) return false;
      ended = true;
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', commit);
      if (unregisterEscape) unregisterEscape();
      if (input.parentNode) input.parentNode.removeChild(input);
      if (description && description.parentNode) description.parentNode.removeChild(description);
      return true;
    }
    function commit() {
      var text = input.value.trim();
      if (end()) options.onCommit(text);
    }
    function cancel() {
      if (end() && options.onCancel) options.onCancel();
    }
    function onEscapeKey(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancel();
    }
    function onKey(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (!unregisterEscape) {
        onEscapeKey(event);
      }
    }
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', commit);
    input.focus();
    input.select();
    return { input: input, cancel: cancel };
  }

  return { createInlineEditors: createInlineEditors, startInlineEditor: startInlineEditor };
});
