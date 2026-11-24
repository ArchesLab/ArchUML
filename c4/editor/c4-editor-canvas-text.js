(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.canvasText = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Text edited in place on a C4-notation drawing (spec §9.2 rename in place; ED-12). F2 renames the focused element;
  // a double-click edits the text under the pointer: an element's name, description, technology, or one of its
  // responsibility lines, and a relationship's description (its label) or technology. A double-click on a box but on
  // none of its text lines, or on a line that is no editable text (the type line of an element without a technology,
  // an annotation, "+2 more"), renames the element. A double-click never zooms; Enter and the zoom badge do.
  //
  // Each edit is one field laid over the text it edits, named for it ("Description of Registration API"). Enter keeps
  // the new text, Escape keeps the old, and leaving the field keeps what was typed. A refusal (read-only, a lock, YAML
  // errors, an invalid value) stays in the field with its reason after Enter, and is only announced after leaving it.
  // A description is edited in a wrapping field as many lines high as the drawing shows it; Enter keeps it, and line
  // breaks are not kept, since the drawing wraps the text itself. Every change is one shared command of the actions
  // (Ruling 5): one undo step with its announcement. The renderer marks each line with the part it shows
  // (`data-c4-text`, `data-c4-index`; c4-render.js `textLine`), so the part under the pointer is read, not guessed.

  // The field is at least this wide (CSS px), so a short text still leaves room to type.
  const FIELD_MIN_WIDTH_PX = 160;
  // A description field is at least this many lines high.
  const DESCRIPTION_MIN_ROWS = 2;
  // A line counts as under the pointer within this many CSS px of its drawn text, above and below.
  const LINE_SLACK_PX = 2;
  // HTML over the drawing whose own double-click is not the drawing's.
  const CONTROLS_OVER_DRAWING = 'button, a, input, textarea, select, summary, [role="menu"], [data-c4-scope-header], '
    + '.c4-editor__canvas-rename-holder';
  // The element types that record a technology (spec §4.4; the inspector's TYPE_FIELDS).
  const TECHNOLOGY_TYPES = new Set(['container', 'component']);

  /**
   * In-place text editing over the canvas `surface` (the editing part's: `region`, `stage`, `svg()`, `viewModel()`,
   * `optionFor(id)`, `reveal(area)`). `context` is the mount's part context (`state`, `dom`, `ids`, `announce`,
   * `actions`, `layout`); `focusElement(id)` returns focus to an element's option. Returns `{ beginRename(elementId),
   * editAt(event), onDraw(), isEditing(), end() }`.
   */
  function createCanvasText(surface, context, { focusElement }) {
    const { state, dom, actions, announce } = context;
    const { region, stage } = surface;
    let editing = null;

    function model() {
      return state.getDesign().model;
    }

    function nameOf(elementId) {
      const element = model().elements.get(elementId);
      return element ? element.name || elementId : elementId;
    }

    /** The element group the renderer drew for `elementId`, or null. */
    function nodeOf(elementId) {
      const svg = surface.svg();
      if (!svg) return null;
      return [...svg.querySelectorAll('[data-layout-id]')].find((node) => node.getAttribute('data-layout-id') === elementId) || null;
    }

    function routeOf(routeId) {
      const svg = surface.svg();
      if (!svg) return null;
      return [...svg.querySelectorAll('[data-layout-route-id]')].find((route) => route.getAttribute('data-layout-route-id') === routeId) || null;
    }

    // ---- What a double-click points at ------------------------------------------------------------------------

    /**
     * A double-click on the drawing (ED-12): opens the field for the text under the pointer. Returns true when it
     * handled the event (it was on an element or a relationship of the drawing).
     */
    function editAt(event) {
      // What lies under the pointer, not the event's target: a press that began a pan captured the pointer, so its
      // double-click is aimed at the canvas region.
      const under = region.ownerDocument.elementsFromPoint(event.clientX, event.clientY);
      // A control laid over the drawing (the scope header's tray, a field, a menu) keeps its own double-click.
      if (under.length > 0 && under[0].closest(CONTROLS_OVER_DRAWING)) return false;
      const svg = surface.svg();
      const option = under.find((node) => node.matches('[role="option"][data-c4-option]')
        && surface.optionFor(node.getAttribute('data-c4-option')) === node);
      if (option) {
        const elementId = option.getAttribute('data-c4-option');
        open(elementTarget(elementId, lineUnder(nodeOf(elementId), event, option.getBoundingClientRect())));
        return true;
      }
      const hit = under.find((node) => svg && svg.contains(node) && node.closest('[data-layout-route-id]'));
      const route = hit ? hit.closest('[data-layout-route-id]') : null;
      if (route) {
        const backdrop = route.querySelector('[data-c4-label-backdrop]');
        const across = backdrop ? backdrop.getBoundingClientRect() : route.getBoundingClientRect();
        open(relationshipTarget(route.getAttribute('data-layout-route-id'), lineUnder(route, event, across)));
        return true;
      }
      return false;
    }

    /**
     * The marked text line of `group` under the pointer: `{ part, index, lines }` (every line of that part, for the
     * field's place and height), or null. A line spans `across` (its box or label) horizontally, so a double-click
     * beside centred text still finds it.
     */
    function lineUnder(group, event, across) {
      if (!group) return null;
      const lines = [...group.querySelectorAll('text[data-c4-text]')];
      const hit = lines.find((line) => {
        const box = line.getBoundingClientRect();
        return event.clientY >= box.top - LINE_SLACK_PX && event.clientY <= box.bottom + LINE_SLACK_PX
          && event.clientX >= across.left && event.clientX <= across.right;
      });
      if (!hit) return null;
      const part = hit.getAttribute('data-c4-text');
      const index = hit.hasAttribute('data-c4-index') ? Number(hit.getAttribute('data-c4-index')) : null;
      const same = lines.filter((line) => line.getAttribute('data-c4-text') === part
        && (index === null || Number(line.getAttribute('data-c4-index')) === index));
      return { part, index, lines: same };
    }

    // ---- Targets: what a field edits ----------------------------------------------------------------------------

    /**
     * The edit for a line of an element's box (`line` from lineUnder, or null for the box itself). A target says what
     * the field shows and how it commits: `{ name, value, multiline, rows, place(), commit(value), unchanged(value),
     * keptMessage, focusAfter(result), drawn() }`.
     */
    function elementTarget(elementId, line) {
      const element = model().elements.get(elementId);
      const name = nameOf(elementId);
      const part = line ? line.part : 'name';
      const shared = {
        drawn: () => surface.optionFor(elementId) !== null,
        focusAfter: (result) => focusElement((result && result.ok && result.elementId) || elementId),
      };
      if (part === 'description') {
        return Object.assign({}, shared, {
          name: `Description of ${name}`, value: element.description || '', multiline: true,
          rows: Math.max(DESCRIPTION_MIN_ROWS, line.lines.length), place: () => linePlace(elementId, line),
          commit: (value) => actions.editElementText(elementId, 'description', value),
          unchanged: (value) => value.trim() === (element.description || ''),
          keptMessage: `Kept the description of ${name}.`,
        });
      }
      if (part === 'type' && TECHNOLOGY_TYPES.has(element.type)) {
        return Object.assign({}, shared, {
          name: `Technology of ${name}`, value: element.technology || '', place: () => linePlace(elementId, line),
          commit: (value) => actions.editElementText(elementId, 'technology', value),
          unchanged: (value) => value.trim() === (element.technology || ''),
          keptMessage: `Kept the technology of ${name}.`,
        });
      }
      if (part === 'responsibility' && element.responsibilities[line.index]) {
        const number = line.index + 1;
        const current = element.responsibilities[line.index].text;
        return Object.assign({}, shared, {
          name: `Responsibility ${number} of ${name}`, value: current, place: () => linePlace(elementId, line),
          commit: (value) => actions.editElementText(elementId, { responsibility: line.index }, value),
          unchanged: (value) => value.trim() === current,
          keptMessage: `Kept responsibility ${number} of ${name}.`,
        });
      }
      return renameTarget(elementId);
    }

    /** The element's name, over the top of its box (F2, a box double-clicked outside its text lines). */
    function renameTarget(elementId) {
      const name = nameOf(elementId);
      return {
        name: `Name of ${name}`, value: name, drawn: () => surface.optionFor(elementId) !== null,
        place: () => boxPlace(surface.optionFor(elementId).getBoundingClientRect()),
        commit: (value) => actions.renameElement(elementId, value),
        unchanged: (value) => value.trim() === name,
        keptMessage: `Kept the name ${name}.`,
        // A first name can also give the element its id (actions.renameElement), so focus follows the id it has now.
        focusAfter: (result) => focusElement((result && result.ok && result.elementId) || elementId),
      };
    }

    /**
     * The edit for a relationship's label: its technology line edits the technology, anything else on the line its
     * description. A line that merges several relationships (a derived line, "(+2 more)") cannot be edited here: each
     * is edited where it is drawn, or in the inspector.
     */
    function relationshipTarget(routeId, line) {
      const edge = (surface.viewModel().edges || []).find((candidate) => candidate.id === routeId);
      if (!edge) return null;
      if (edge.sources.length !== 1) {
        return refusal(`Error: This line stands for ${edge.sources.length} relationships between the parts of `
          + `${nameOf(edge.sourceId)} and ${nameOf(edge.targetId)}; edit each in the view that draws it, or in the inspector.`);
      }
      const relationshipId = edge.sources[0];
      const relationship = model().relationships.find((candidate) => candidate.id === relationshipId);
      if (!relationship) return null;
      const field = line && line.part === 'technology' ? 'technology' : 'description';
      const ends = `the relationship from ${nameOf(relationship.sourceId)} to ${nameOf(relationship.targetId)}`;
      // The technology drawn may come from the interfaces the relationship uses; the field starts from what is drawn.
      const current = relationship[field] || (field === 'technology' ? edge.technology || '' : '');
      const labelLines = line ? line : { lines: [...routeOf(routeId).querySelectorAll('text[data-c4-text]')] };
      return {
        name: `${field === 'technology' ? 'Technology' : 'Description'} of ${ends}`, value: current,
        drawn: () => routeOf(routeId) !== null,
        place: () => labelPlace(routeId, labelLines),
        commit: (value) => actions.updateRelationship(relationshipId, { [field]: value.trim() }),
        unchanged: (value) => value.trim() === current,
        keptMessage: `Kept the ${field} of ${ends}.`,
        focusAfter: () => region.focus({ preventScroll: true }),
      };
    }

    function refusal(message) {
      return { refusal: message };
    }

    // ---- Where the field goes (measured, so set through the CSSOM as custom properties) ---------------------------

    /** `{ x, y, width }` in the stage's frame for a client rectangle. */
    function inStage(left, top, width) {
      const frame = stage.getBoundingClientRect();
      return { x: left - frame.left - stage.clientLeft, y: top - frame.top - stage.clientTop, width: Math.max(width, FIELD_MIN_WIDTH_PX) };
    }

    function boxPlace(box) {
      return inStage(box.left, box.top, box.width);
    }

    /** Over the element's line(s) of `line.part`, as wide as its box. */
    function linePlace(elementId, line) {
      const box = surface.optionFor(elementId).getBoundingClientRect();
      const again = lineUnderAgain(nodeOf(elementId), line);
      const top = again.length > 0 ? again[0].getBoundingClientRect().top : box.top;
      return inStage(box.left, top, box.width);
    }

    /** Over the relationship's label, as wide as its backdrop. */
    function labelPlace(routeId, line) {
      const route = routeOf(routeId);
      const backdrop = route.querySelector('[data-c4-label-backdrop]');
      const area = (backdrop || route).getBoundingClientRect();
      const again = lineUnderAgain(route, line);
      const top = again.length > 0 ? again[0].getBoundingClientRect().top : area.top;
      return inStage(area.left, top, area.width);
    }

    /** The lines of the same part in the current drawing: a redraw replaces the text elements. */
    function lineUnderAgain(group, line) {
      if (!group || !line || !line.part) return line && line.lines ? line.lines.filter((node) => node.isConnected) : [];
      return [...group.querySelectorAll('text[data-c4-text]')].filter((node) => node.getAttribute('data-c4-text') === line.part
        && (line.index === null || line.index === undefined || Number(node.getAttribute('data-c4-index')) === line.index));
    }

    // ---- The field ------------------------------------------------------------------------------------------------

    function beginRename(elementId) {
      if (!surface.optionFor(elementId)) {
        if (context.layout && typeof context.layout.revealRegion === 'function') context.layout.revealRegion('inspector');
        announce(`Rename ${nameOf(elementId)} in the inspector's Name field.`);
        return;
      }
      open(renameTarget(elementId));
    }

    function open(target) {
      if (target === null) return;
      if (target.refusal) {
        announce(target.refusal, { kind: 'refusal' });
        return;
      }
      end();
      const problemId = context.ids('canvas-rename-problem');
      const attributes = {
        class: `c4-editor__canvas-rename${target.multiline ? ' c4-editor__canvas-rename--multiline' : ''}`,
        autocomplete: 'off', spellcheck: target.multiline ? 'true' : 'false',
        'aria-label': target.name, 'aria-describedby': problemId,
        on: { keydown: onKeydown, blur: onBlur },
      };
      const field = target.multiline
        ? dom.el('textarea', Object.assign(attributes, { rows: String(target.rows) }))
        : dom.el('input', Object.assign(attributes, { type: 'text' }));
      field.value = target.value;
      const problem = dom.el('p', { id: problemId, class: 'c4-editor__canvas-rename-problem', hidden: true });
      const holder = dom.el('div', { class: 'c4-editor__canvas-rename-holder' }, [field, problem]);
      editing = { target, holder, field, problem, committing: false };
      place();
      field.focus({ preventScroll: true });
      field.select();
      surface.reveal(holder);
    }

    function place() {
      if (!editing.holder.isConnected) stage.appendChild(editing.holder);
      const { x, y, width } = editing.target.place();
      editing.holder.style.setProperty('--c4-rename-x', `${x}px`);
      editing.holder.style.setProperty('--c4-rename-y', `${y}px`);
      editing.holder.style.setProperty('--c4-rename-width', `${width}px`);
    }

    function onKeydown(event) {
      if (event.key === 'Enter') {
        // Enter keeps the text, in a description's field too: the drawing wraps the text, so no line break is kept.
        event.preventDefault();
        commit({ keepOpenOnRefusal: true });
      } else if (event.key === 'Escape') {
        // Taken here, so neither a mode nor the selection is closed by the same press.
        event.preventDefault();
        const { target } = editing;
        end();
        announce(target.keptMessage);
        target.focusAfter(null);
      }
    }

    function onBlur() {
      if (editing && !editing.committing) commit({ keepOpenOnRefusal: false });
    }

    /** Commits through the actions; a refusal stays in the field (Enter) or is only announced (focus left). */
    function commit({ keepOpenOnRefusal }) {
      const { target, field, problem } = editing;
      const value = field.value.replace(/\s*\n\s*/g, ' ');
      if (target.unchanged(value)) {
        end();
        if (keepOpenOnRefusal) target.focusAfter(null);
        return;
      }
      editing.committing = true;
      const result = target.commit(value);
      if (editing === null) return;
      editing.committing = false;
      if (result.ok || !keepOpenOnRefusal) {
        end();
        if (keepOpenOnRefusal) target.focusAfter(result);
        return;
      }
      problem.textContent = result.message;
      problem.hidden = false;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }

    /** After a redraw the field is laid over its text again, or closed when the drawing no longer shows it. */
    function onDraw() {
      if (editing === null || editing.committing) return;
      if (!editing.target.drawn()) {
        end();
        return;
      }
      const focused = editing.field.ownerDocument.activeElement === editing.field;
      place();
      if (!focused) editing.field.focus({ preventScroll: true });
    }

    function end() {
      if (editing === null) return;
      const { holder } = editing;
      editing = null;
      holder.remove();
    }

    return { beginRename, editAt, onDraw, isEditing: () => editing !== null, end };
  }

  return { createCanvasText };
});
