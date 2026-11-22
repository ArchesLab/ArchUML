(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(globalThis, function () {
      return { drag: require('./c4-editor-drag.js'), umlLayout: require('./c4-editor-uml-layout.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.umlInteraction = factory(root, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (root, editorParts) {
  'use strict';

  // The C4 surface's ways into a diagram-editor session without a drag (UML-view editing spec §7.4, §7.5, §7.7; plan
  // Task 40), on an edited UML-notation view. The C4 editor's grammar stays the same in every view: keys on the focused
  // option of the listbox (c4-editor-canvas-editing.js routes them here), menus from Shift+F10 or a line's "⋯" button,
  // and two modes, each a layer of the editor's Escape order:
  //
  // | Way in                        | What it steers                                                                  |
  // |-------------------------------|---------------------------------------------------------------------------------|
  // | M, "Move…"                    | the module's placing (`session.startPlacing`): arrows nudge it by the C4        |
  // |                               | editor's key steps, a hovering pointer follows, a click or Enter commits it     |
  // | M on a step or a fragment     | the view module's places (`places(ref)`): Up and Down go through them in        |
  // |                               | reading order, each announced; Enter moves it there (`message.move`,            |
  // |                               | `fragment.move`)                                                                |
  // | M on a lifeline               | the view module's "Move left" and "Move right" (`menu(ref)`): Left and Right     |
  // |                               | choose one, Enter applies it (`lifeline.reorder`)                               |
  // | Shift+F10, a right-click,     | the host's items for a box or a line, then the view module's (`menu(ref)`)      |
  // | the "⋯" button                |                                                                                 |
  // | "Add a bend", "Move bend N…"  | the same placing of one bend (`commands.addBend`, `startPlacing({ ref, bend })`) |
  // | "Remove bend N", "Straighten" | the module's bend commands (none on a sequence message)                         |
  // | C, "Draw a line", a line tool | the module's target marks (`session.markTargets`); a chooser of the kinds that  |
  // | of the palette, Add relation- | fit the pair, or the tool's kind. A tool or Add relationship first waits for    |
  // | ship                          | the source; in a sequence drawing the last click's height is the step's place  |
  // | C on a step or a fragment     | the view module's message with open ends after it: its step form (spec §7.4)    |
  // | A fragment tool's operator    | a click at a height places that fragment there                                  |
  // | "Move the … end to…"          | a chooser of the module's advice (`adapter.targets`), the others disabled       |
  // | F2, a double-click            | an in-place editor of a name, a member line, a step's description, or a         |
  // |                               | fragment's first guard: "Enter saves, Escape cancels."                          |
  // | Delete, Backspace             | the operation's own confirmations; then focus to the next option (§7.7)         |
  //
  // It writes no move or bend geometry of its own (spec §7.4, ED-4): the preview, the snapping, and the commit are the
  // drag's. Every change is an operation the adapter applies (one dispatch, one undo step); a refusal is said with the
  // adapter's verdict, so its offer reaches the message region. Menus and choosers are the editor's menus
  // (`actions.openMenu`), which close on Escape before any mode does.
  //
  // One factory per concern: the reading of the drawn document (documentReader), the in-place editors
  // (createInlineEditors), the menus (createUmlMenus), the "⋯" button of the selected box or line
  // (createActionButton), and the modes with their keys and presses (createUmlInteraction). They reach each other's
  // ways in through `ways`, bound once all exist.
  //
  // A palette tile is the pointer's or the keyboard's way in (spec §7.4): chosen with the pointer, a line tool waits
  // for the two boxes it is drawn between and a fragment tool for its operator and a height; chosen with the keyboard
  // or from the Add menu, an addition goes where the focus is (inside the selected box, after the selected step).

  // The C4 editor's arrow steps in a move, in drawing units: one grid step, or five with Shift (spec §7.4).
  const KEY_STEP_UNITS = 10;
  const KEY_STEP_LARGE_UNITS = 50;
  const ARROWS = Object.freeze({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] });
  const FORWARD_KEYS = new Set(['ArrowRight', 'ArrowDown']);
  // The "⋯" button of a selected line: 24 × 24 CSS px at every magnification (WCAG 2.5.8; spec §7.4).
  const ACTION_BUTTON_PX = 24;
  // A tile dropped on the drawing puts the new box's top-left corner this far above and left of the pointer, in drawing
  // units, so the pointer lies on the new box whatever size it is drawn at (spec §6 rule 2: placed where dropped).
  const DROP_GRIP_UNITS = 12;
  // The in-place field is at least this wide (CSS px), so a short name still leaves room to type.
  const FIELD_MIN_WIDTH_PX = 160;
  const HOST_LAYER = '.uml-pg-edit-layer.is-host';
  const HIT_BOX = `${HOST_LAYER} .uml-pg-edit-hitbox`;
  // Spec §7.4 In-place editors: the instruction under every field, and what a code element's name adds.
  const SAVE_HINT = 'Enter saves, Escape cancels.';
  const CLASS_NAME_HINT = 'Class names have no spaces; a space is drawn as _.';
  // The words for a box's type in an editor's accessible name ("Name of ‹type› ‹name›").
  const CODE_KINDS = Object.freeze({
    class: 'class', abstract_class: 'abstract class', interface: 'interface', enum: 'enum', function: 'function', module: 'module',
  });
  const TYPE_WORDS = Object.freeze({
    person: 'person', system: 'software system', container: 'container', component: 'component', participant: 'lifeline',
    node: 'node', instance: 'instance', 'provided-interface': 'interface', 'required-interface': 'interface',
  });
  const MEMBER_NOUNS = Object.freeze({ attributes: 'Attribute', operations: 'Operation' });
  // What a move of a step or fragment says when a new drawing ends it (the module's words for a placing it ends).
  const DRAWING_CHANGED = 'The drawing changed, so the move was cancelled.';
  // The view module's menu items that a lifeline's Left and Right choose in Move (spec §7.4 "Reorder lifelines").
  const ORDER_KEYS = Object.freeze({ ArrowLeft: 'Move left', ArrowRight: 'Move right' });
  const EDGE_HIT = `${HOST_LAYER} .uml-pg-edge-hitbox`;
  const STEP_NUMBER = /^Step (\d+):/;

  /**
   * The ways in of one editor's session. `kit`: `session()` and `drawing()` (the current ones), `adapter` (the
   * session's), `state`, `announce`, `escape`, `dom`, `ids`, `actions` (`openMenu`), `canvas` (as attachUmlEditing
   * describes it), `say(verdict)` (says a verdict with its offer), `nameOf(ref)` (an option's name), `selectionOf(ref)`
   * (the editor selection an option stands for), `sceneFacts()` (`{ positions, boxes }` of the drawn boxes),
   * `viewContext()` (what the drawn view's module reads, plan Task 34's context), `selectedRef()` (the option of the
   * editor's selection, or null), `dragging()` (whether a drag of the drawing runs), and for a sequence drawing `lifelineAt(event)` (the lifeline whose dashed line is
   * under a pointer event) and `anchorAt(event)` (the insertion anchor at its height; both null elsewhere).
   * Returns `{ onKey(event), pressInMode(event), addTile(tile, use), dropTile(tile, event), startDrawing(tool),
   * contextMenu(event), unavailableReason(ref), positions, afterSync(), afterSelection(), destroy() }`; `positions` is
   * the Position section's (see createPositionCommands).
   */
  function createUmlInteraction(kit) {
    const { adapter, announce, escape, actions, canvas } = kit;
    const { region } = canvas;
    const doc = region.ownerDocument;
    const read = documentReader(kit);
    const ways = {};
    const inline = createInlineEditors(kit, read, ways);
    const menus = createUmlMenus(kit, read, ways);
    const button = createActionButton(kit, menus, () => mode !== null);
    let mode = null;

    // ---- Modes: Move and C (one at a time; each a layer of the Escape order) ---------------------------------

    function enterMode(next, instruction) {
      endModeQuietly();
      inline.end();
      const drawing = kit.drawing();
      mode = Object.assign({ layer: escape.push({ close: cancelMode }), instruction: null, viewKey: drawing.viewModel.key }, next);
      region.classList.add(next.kind === 'move' ? 'is-moving' : 'is-connecting');
      mode.instruction = announce(instruction, { kind: 'instruction' }) || null;
      button.remove();
    }

    /**
     * Ends the mode without a word and returns it (null when none was on); a running placing is left to the caller.
     * C mode's marks go, and the listbox is laid again without its targets' reasons, unless a new drawing lays it.
     */
    function leaveMode({ relay = true } = {}) {
      if (mode === null) return null;
      const ended = mode;
      mode = null;
      ended.layer.remove();
      if (ended.instruction) ended.instruction.withdraw();
      region.classList.remove('is-moving', 'is-connecting');
      if (ended.kind === 'connect' && kit.session()) {
        kit.session().clearTargets();
        if (relay) canvas.refreshOptions();
      }
      if (relay) button.place();
      return ended;
    }

    /**
     * Ends the mode as when another one replaces it: a move's preview is put back, and nothing is said. During a
     * drawing (`relay: false`) the listbox is left for the drawing to lay.
     */
    function endModeQuietly({ relay = true } = {}) {
      const ended = leaveMode({ relay });
      if (ended && ended.kind === 'move' && ended.placing) ended.placing.cancel();
    }

    /** Escape in a mode: nothing is written, and the learner hears what stays as it was. */
    function cancelMode() {
      const ended = leaveMode();
      if (!ended) return;
      if (ended.kind === 'move') {
        if (ended.placing) ended.placing.cancel();
        announce(ended.cancelled, { kind: 'result' });
      } else if (ended.kind === 'place') {
        announce(`No ${ended.operator} added.`, { kind: 'result' });
      } else {
        announce(ended.from === null ? 'No line drawn.' : `No line drawn from ${ended.name}.`, { kind: 'result' });
      }
      if (ended.focusRef !== null) read.focusOption(ended.focusRef);
    }

    /**
     * M or "Move…" on a box: the module's placing of it (spec §7.4); its refusal is the module's to say. On a step or a
     * fragment: the places the view module lists for it (see startStepMove).
     */
    function startMove(ref) {
      const element = read.elementOf(ref);
      if (!element) return startStepMove(ref);
      if (element.axis === 'order') return startOrderMove(ref);
      endModeQuietly();
      const placing = kit.session().startPlacing({ ref: { id: ref, kind: 'node' } });
      if (!placing) return true;
      const name = kit.nameOf(ref);
      enterMode({ kind: 'move', placing, box: ref, focusRef: ref, cancelled: `Move canceled; ${name} stays where it was.` },
        `Moving ${name}: arrow keys move it (Shift moves farther), or click where it should go; Enter places it; Escape cancels.`);
      read.focusOption(ref);
      return true;
    }

    /**
     * M on a step or a fragment (spec §7.4 "Move a message or fragment"): Up and Down go through the insertion places
     * the view module lists (`places(ref, context) → [{ at, label, current }]`, in reading order, `current` marking where
     * it is now), each announced with its label; Enter moves it to the chosen one, Escape leaves it where it is. False
     * when the module lists no place, so the key does nothing else.
     */
    function startStepMove(ref) {
      const drawing = kit.drawing();
      const module = drawing ? drawing.module : null;
      const places = module && typeof module.places === 'function' ? module.places(ref, kit.viewContext()) : null;
      if (!places || places.length === 0) return false;
      endModeQuietly();
      const name = kit.nameOf(ref);
      enterMode({
        kind: 'move', placing: null, places, at: places.findIndex((place) => place.current), box: null, focusRef: ref,
        cancelled: `Move canceled; ${name} stays where it was.`,
      }, `Moving ${name}: Up and Down go through the places it can go; Enter moves it there; Escape cancels.`);
      read.focusOption(ref);
      return true;
    }

    /**
     * M on a lifeline (spec §7.4 "Reorder lifelines"): Left and Right choose the view module's "Move left" or "Move
     * right" (its `menu(ref)` items, which swap the lifeline with its neighbour inside its box and move the whole box at
     * the box's edge), the other key back to where it is; Enter applies the chosen one. False when the module offers
     * neither, so the key does nothing else.
     */
    function startOrderMove(ref) {
      const items = menus.moduleMenu(ref);
      const choices = {};
      Object.keys(ORDER_KEYS).forEach((key) => {
        const item = items.find((candidate) => candidate.label === ORDER_KEYS[key]);
        if (item) choices[key] = item;
      });
      if (Object.keys(choices).length === 0) return false;
      endModeQuietly();
      const name = kit.nameOf(ref);
      enterMode({ kind: 'move', placing: null, order: { choices, chosen: null }, box: null, focusRef: ref,
        cancelled: `Move canceled; ${name} stays where it was.` },
      `Moving ${name} in the lifeline order: Left and Right choose where it goes; Enter moves it there; Escape cancels.`);
      read.focusOption(ref);
      return true;
    }

    /** Left or Right while a lifeline is moved: its move that way, or back to where it is from the other side. */
    function chooseOrder(key) {
      const { order } = mode;
      const opposite = order.chosen !== null && order.chosen !== key;
      order.chosen = opposite ? null : (order.choices[key] ? key : order.chosen);
      if (mode.instruction) mode.instruction.withdraw();
      const item = order.chosen === null ? null : order.choices[order.chosen];
      const name = kit.nameOf(mode.focusRef);
      let words = `${name} stays where it is. Left and Right choose where it goes; Escape cancels.`;
      if (item && item.refusal) words = `${item.label}: ${item.refusal.message || item.refusal.summary} Escape cancels.`;
      else if (item) words = `${item.label}: Enter moves ${name} there; Escape cancels.`;
      mode.instruction = announce(words, { kind: 'instruction' }) || null;
    }

    /** Enter while a lifeline is moved: the chosen move, applied as the view module built it; focus stays on it. */
    function commitOrderMove() {
      const ended = leaveMode();
      const item = ended.order.chosen === null ? null : ended.order.choices[ended.order.chosen];
      if (!item || !item.operation) {
        if (item && item.refusal) kit.say(Object.assign({ ok: false }, item.refusal));
        else announce(ended.cancelled, { kind: 'result' });
        read.focusOption(ended.focusRef);
        return Promise.resolve(null);
      }
      const selection = kit.selectionOf(ended.focusRef);
      const { op, ...fields } = item.operation;
      return read.run(read.operation(op, fields)).then((verdict) => {
        read.focusOption(ended.focusRef, selection);
        return verdict;
      });
    }

    /** Up or Down while a step or fragment is moved: the next or previous place, said with its label (no wrap). */
    function stepPlace(step) {
      const last = mode.places.length - 1;
      const next = Math.min(Math.max(mode.at + step, 0), last);
      const edge = next === mode.at ? (step > 0 ? ' This is the last place.' : ' This is the first place.') : '';
      mode.at = next;
      if (mode.instruction) mode.instruction.withdraw();
      mode.instruction = announce(`${mode.places[next].label}.${edge} Enter moves it here; Escape cancels.`, { kind: 'instruction' }) || null;
    }

    /** Enter while a step or fragment is moved: the module's move to the chosen place; focus stays on its option. */
    function commitStepMove() {
      const ended = leaveMode();
      const place = ended.places[ended.at];
      if (!place || place.current) {
        announce(ended.cancelled, { kind: 'result' });
        read.focusOption(ended.focusRef);
        return Promise.resolve(null);
      }
      const selection = kit.selectionOf(ended.focusRef);
      const op = read.fragmentOf(ended.focusRef) ? 'fragment.move' : 'message.move';
      return read.run(read.operation(op, { ref: ended.focusRef, at: place.at })).then((verdict) => {
        read.focusOption(ended.focusRef, verdict.ok && verdict.select ? verdict.select : selection);
        return verdict;
      });
    }

    /**
     * "Add a bend" or "Move bend N…" on line `ref`: the placing `start()` gives (null after the module said why it
     * refuses), steered like a box's. Escape takes an added bend away again.
     */
    function startBendMove(ref, start, { added = false } = {}) {
      endModeQuietly();
      const placing = start();
      if (!placing) return;
      const line = kit.nameOf(ref);
      const bend = `bend ${placing.target.bend} of ${line}`;
      enterMode({ kind: 'move', placing, box: null, focusRef: ref,
        cancelled: added ? `No bend added to ${line}.` : `Move canceled; ${bend} stays where it was.` },
      `Moving ${bend}: arrow keys move it (Shift moves farther), or click where it should go; Enter places it; Escape cancels.`);
      read.focusOption(ref);
    }

    /** A click (`event`) or Enter (none) in Move: the placing is committed; focus goes to the moved option (§7.7). */
    function commitMove(event) {
      const ended = leaveMode();
      const selection = kit.selectionOf(ended.focusRef);
      return ended.placing.commit(event || undefined).then((verdict) => {
        if (verdict && verdict.ok) read.focusOption(ended.focusRef, selection);
        return verdict;
      });
    }

    /**
     * C or "Draw a line" on a box (spec §7.4), or the box a line tool or Add relationship was given first: every
     * candidate end is marked, possible ones first in the arrow keys' order; the others are described "not available:
     * ‹short reason›". Enter or a click on a target chooses it. `tool` is the palette's line tool, or null for the kinds
     * that fit the pair. C on a step or a fragment opens its view's message after it instead (openMessageAfter).
     */
    function startConnect(ref, { tool = null } = {}) {
      if (!read.elementOf(ref)) return openMessageAfter(ref);
      endModeQuietly();
      const request = { op: 'relation.add', tool: tool ? tool.id : null, from: ref, to: null, label: null, open: 'to' };
      const candidates = kit.session().markTargets(request);
      const name = kit.nameOf(ref);
      if (!candidates || candidates.length === 0) {
        announce(`No line can be drawn from ${name} in this view.`, { kind: 'refusal' });
        return true;
      }
      enterMode({ kind: 'connect', from: ref, tool, request, candidates, at: -1, name, focusRef: ref },
        `Drawing a line from ${name}: move to its target with the arrow keys and press Enter, or click it; Escape cancels.`);
      canvas.refreshOptions();
      read.focusOption(ref);
      return true;
    }

    /**
     * A line tool of the palette (`tool`), or Add relationship (null): the line is drawn from the selected box when
     * Add relationship finds one, else from the box clicked or chosen with Enter first, then to its target (spec §7.4
     * "Click the tool or handle, then the source, then the target"). In a sequence drawing the boxes are the lifelines.
     * Always true: a view without boxes says that no line can be drawn.
     */
    function startDrawing(tool) {
      const selected = tool === null ? kit.selectedRef() : null;
      if (selected !== null && read.elementOf(selected)) return startConnect(selected);
      endModeQuietly();
      if (!read.contents().elements.some((element) => element.axis !== 'port')) {
        announce('No line can be drawn in this view: it has no boxes yet.', { kind: 'refusal' });
        return true;
      }
      const sequence = read.contents().type === 'sequence';
      const label = tool ? tool.label : 'Drawing a line';
      const words = sequence ? 'click the sender\'s lifeline, then the receiver\'s at the height of the step.'
        : 'click the box it starts at, then the box it ends at, or choose each with the arrow keys and Enter.';
      enterMode({ kind: 'connect', from: null, tool, request: null, candidates: [], at: -1, name: null, focusRef: null },
        `${label}: ${words} Escape cancels.`);
      return true;
    }

    /**
     * C on a step or a fragment (spec §7.4 "Draw a message", keyboard): the view's message with open ends after it, in
     * its list: its step form. The message is the view's first line tool. False for any other option.
     */
    function openMessageAfter(ref) {
      const selection = kit.selectionOf(ref);
      const message = adapter.tools().relations[0];
      if (!selection || !selection.step || !message) return false;
      endModeQuietly();
      read.run(read.operation('relation.add', { tool: message.id, from: null, to: null, label: null, at: placeAfter(selection.step) }));
      return true;
    }

    /** The arrow keys in C mode: the next or previous candidate, possible ones first (no wrap). */
    function stepTarget(step) {
      const order = mode.candidates.map((candidate) => targetId(candidate.ref));
      const focused = canvas.refAt(doc.activeElement);
      let at = mode.at;
      if (at === -1 || order[at] !== focused) at = focused === mode.from ? -1 : order.indexOf(focused);
      const next = at === -1 ? (step > 0 ? 0 : order.length - 1) : Math.min(Math.max(at + step, 0), order.length - 1);
      mode.at = next;
      canvas.focusRef(order[next]);
    }

    /**
     * Enter or a click on `ref` in C mode: the source when none is chosen yet; then a possible target draws the line
     * (the tool's kind, or the chooser of kinds), and another says why not. `at` is the insertion anchor a click in a
     * sequence drawing gives the step (null: the end of the scenario).
     */
    function pick(ref, { at = null } = {}) {
      if (mode.from === null) {
        startConnect(ref, { tool: mode.tool });
        return;
      }
      const candidate = mode.candidates.find((each) => targetId(each.ref) === ref);
      if (!candidate) {
        announce(`${kit.nameOf(ref)} cannot be the end of a line.`, { kind: 'refusal' });
        return;
      }
      if (!candidate.ok) {
        kit.say(lineRefusal(mode.from, ref, candidate.code));
        return;
      }
      const { from, tool } = mode;
      leaveMode();
      chooseLineKind(from, ref, { tool, at });
    }

    /** Why no line can be drawn from `from` to `to`: the refusal of the kind whose code the advice gave. */
    function lineRefusal(from, to, code) {
      const verdicts = adapter.tools().relations
        .map((tool) => adapter.can(read.operation('relation.add', { tool: tool.id, from, to, label: null })))
        .filter((verdict) => !verdict.ok);
      return verdicts.find((verdict) => verdict.code === code) || verdicts[0];
    }

    /**
     * The kinds of line for the pair (spec §7.4 "A chooser offers the kinds that fit the pair", §5.6): the view's kinds
     * in the palette's order, each disabled with its short reason where it does not fit, then the kinds of line this
     * design model cannot record, disabled. When exactly one kind fits, it is drawn without asking; a line tool of the
     * palette (`tool`) draws its own kind. `at` is a message's insertion anchor (the operation's `at`, also given as
     * its scene fact, spec §3.4).
     */
    function chooseLineKind(from, to, { tool: chosen = null, at = null } = {}) {
      const tools = adapter.tools();
      const lineOf = (tool) => read.operation('relation.add', Object.assign({ tool: tool.id, from, to, label: null }, at ? { at, facts: { at } } : {}));
      const draw = (tool) => read.run(lineOf(tool));
      if (chosen) return draw(chosen);
      const choices = tools.relations.map((tool) => ({ tool, verdict: adapter.can(lineOf(tool)) }));
      const fitting = choices.filter((choice) => choice.verdict.ok);
      if (fitting.length === 1) return draw(fitting[0].tool);
      const unrecorded = tools.unavailable.filter((tool) => tool.line)
        .map((tool) => menuItem(tool.label, { ok: false, summary: tool.summary, message: tool.message }, () => {}));
      return actions.openMenu({
        label: `Draw a line from ${kit.nameOf(from)} to ${kit.nameOf(to)}`,
        groups: [{ label: null, items: choices.map((choice) => menuItem(choice.tool.label, choice.verdict, () => draw(choice.tool))).concat(unrecorded) }],
        placement: { anchor: canvas.optionElement(to), returnFocus: canvas.optionElement(from) },
      });
    }

    /** What C mode says of an option that is not a possible target: its short reason, or null. */
    function unavailableReason(ref) {
      if (!mode || mode.kind !== 'connect') return null;
      const candidate = mode.candidates.find((each) => targetId(each.ref) === ref);
      return candidate && !candidate.ok ? candidate.summary || 'it cannot be the end of this line' : null;
    }

    // ---- Delete (spec §7.7: focus to the next option in reading order, else the previous, else the canvas) -----

    function removeOption(ref) {
      const refs = canvas.refs();
      const at = refs.indexOf(ref);
      const neighbours = refs.slice(at + 1).concat(refs.slice(0, Math.max(at, 0)).reverse())
        .map((other) => ({ ref: other, selection: kit.selectionOf(other) }));
      const built = read.elementOf(ref) ? read.operation('element.remove', { ref })
        : read.operation('selection.remove', read.fragmentOf(ref)
          ? { elements: [], relations: [], fragments: [ref], activations: [] }
          : { elements: [], relations: [ref], fragments: [], activations: [] });
      return read.run(built).then((verdict) => {
        if (!verdict.ok) return verdict;
        const focused = neighbours.some((neighbour) => read.focusOption(neighbour.ref, neighbour.selection));
        if (!focused) region.focus({ preventScroll: true });
        return verdict;
      });
    }

    // ---- Keys and presses -------------------------------------------------------------------------------------

    /** A key on the canvas (capture phase, outside fields and menus); true when it was taken. */
    function onKey(event) {
      if (mode) return modeKey(event);
      const ref = canvas.refAt(event.target);
      if (ref === null || event.target !== canvas.optionElement(ref)) return false;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (event.key === 'F2' && plain && !event.shiftKey) return inline.beginEdit(ref);
      if ((event.key === 'Delete' || event.key === 'Backspace') && plain) {
        removeOption(ref);
        return true;
      }
      if (isLetter(event, 'm') && !event.shiftKey) return startMove(ref);
      if (isLetter(event, 'c') && !event.shiftKey) return startConnect(ref);
      if (opensMenu(event)) {
        menus.openMenu(ref, { anchor: event.target, returnFocus: event.target });
        return true;
      }
      return false;
    }

    function modeKey(event) {
      // As in the C4 views' modes, F and A do nothing while a mode waits.
      if (isLetter(event, 'f') || isLetter(event, 'a')) return true;
      const plainArrow = event.key in ARROWS && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (mode.kind === 'move') return moveKey(event, plainArrow);
      if (mode.kind === 'place') return false;
      // Before the source is chosen, the arrow keys move through the listbox as they always do.
      if (plainArrow && !event.shiftKey && mode.from !== null) {
        stepTarget(FORWARD_KEYS.has(event.key) ? 1 : -1);
        return true;
      }
      if (event.key === 'Enter') {
        const ref = canvas.refAt(event.target);
        if (ref !== null) pick(ref);
        return true;
      }
      return false;
    }

    /** The keys of Move: the arrows nudge, Enter commits, Shift+F10 opens the moved box's menu. */
    function moveKey(event, plainArrow) {
      if (mode.places) return stepMoveKey(event, plainArrow);
      if (mode.order) return orderMoveKey(event, plainArrow);
      if (opensMenu(event)) {
        const option = mode.box ? canvas.optionElement(mode.box) : null;
        if (option) menus.openMenu(mode.box, { anchor: option, returnFocus: option });
        return true;
      }
      if (plainArrow) {
        const size = event.shiftKey ? KEY_STEP_LARGE_UNITS : KEY_STEP_UNITS;
        mode.placing.nudge(ARROWS[event.key][0] * size, ARROWS[event.key][1] * size);
        return true;
      }
      if (event.key === 'Enter') {
        commitMove(null);
        return true;
      }
      return false;
    }

    /** The keys while a lifeline is moved: Left and Right choose its move, Enter applies it; Up and Down do nothing. */
    function orderMoveKey(event, plainArrow) {
      if (plainArrow && !event.shiftKey && ORDER_KEYS[event.key]) {
        chooseOrder(event.key);
        return true;
      }
      if (plainArrow) return true;
      if (event.key === 'Enter') {
        commitOrderMove();
        return true;
      }
      return false;
    }

    /** The keys while a step or fragment is moved: Up and Down choose its place, Enter moves it there. */
    function stepMoveKey(event, plainArrow) {
      if (plainArrow && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        stepPlace(event.key === 'ArrowDown' ? 1 : -1);
        return true;
      }
      if (plainArrow) return true;
      if (event.key === 'Enter') {
        commitStepMove();
        return true;
      }
      return false;
    }

    /**
     * A press while a mode waits for a click (the canvas's pointer dispatcher asks first): in Move the release commits
     * where it is; in C mode the release on a box (in a sequence drawing, on a lifeline) picks it, elsewhere it cancels;
     * a fragment's operator is placed at the release's height. Null without a mode, and while a step or a lifeline is
     * moved by its keys.
     */
    function pressInMode(event) {
      if (!mode || mode.places || mode.order) return null;
      if (mode.kind === 'move') {
        return { move() {}, end: (released) => { if (mode && mode.kind === 'move') commitMove(released); }, cancel() {} };
      }
      if (mode.kind === 'place') {
        return { move() {}, end: (released) => { if (mode && mode.kind === 'place') placeFragment(released); }, cancel() {} };
      }
      const ref = boxRefAt(event);
      return {
        move() {},
        end(released) {
          if (!mode || mode.kind !== 'connect') return;
          if (ref === null) cancelMode();
          else pick(ref, { at: kit.anchorAt(released) });
        },
        cancel() {},
      };
    }

    /** The box under a pointer event: its hit target's layout id, or in a sequence drawing the lifeline there; or null. */
    function boxRefAt(event) {
      const hit = event.target.closest ? event.target.closest(HIT_BOX) : null;
      return hit ? hit.getAttribute('data-layout-id') : kit.lifelineAt(event);
    }

    /**
     * A right-click (spec §3.11): the menu of the box or line under the pointer, the one Shift+F10 and the "⋯" button
     * open, at the pressed point; on a line its "Add a bend" puts the bend there. False when no option's box or line is
     * there, or a mode is on.
     */
    function contextMenu(event) {
      if (mode || !kit.drawing() || !event.target.closest) return false;
      const edge = event.target.closest(EDGE_HIT);
      const ref = edge ? edge.getAttribute('data-route-id') || edge.getAttribute('data-layout-id') : boxRefAt(event);
      const option = ref === null ? null : canvas.optionElement(ref);
      if (!option) return false;
      const svg = kit.drawing().svg;
      const bendAt = edge ? drawingPoint(svg, event.clientX, event.clientY) : null;
      menus.openMenu(ref, { point: { x: event.clientX, y: event.clientY }, returnFocus: option }, { bendAt });
      return true;
    }

    /** In Move, the preview follows a hovering pointer, so the click's result shows before it happens. */
    function onPointerMove(event) {
      if (mode && mode.kind === 'move' && mode.placing && event.buttons === 0) mode.placing.follow(event);
    }

    /** A double-click edits the text under the pointer in place, a member line or a name; it never opens a view. */
    function onDoubleClick(event) {
      if (mode || !kit.drawing()) return;
      const ref = hitAt(event.clientX, event.clientY);
      if (ref === null) return;
      event.preventDefault();
      const member = memberAt(event.clientX, event.clientY, ref);
      if (member) inline.beginMemberEdit(ref, member);
      else inline.beginNameEdit(ref);
    }

    /** The box under a client point (its hit target's layout id), or null. */
    function hitAt(x, y) {
      const hit = doc.elementsFromPoint(x, y).find((element) => element.matches && element.matches(HIT_BOX));
      return hit && kit.drawing().svg.contains(hit) ? hit.getAttribute('data-layout-id') : null;
    }

    /**
     * The member line of box `ref` whose drawn text lies under a client point, or null. The renderer draws a member
     * without the spaces the model's text may have ("+ decide(…)" is drawn "+decide(…)"), so the two are compared
     * without white space.
     */
    function memberAt(x, y, ref) {
      const element = read.elementOf(ref);
      const svg = kit.drawing().svg;
      const text = doc.elementsFromPoint(x, y).find((candidate) => candidate.tagName && candidate.tagName.toLowerCase() === 'text'
        && svg.contains(candidate) && !candidate.closest(HOST_LAYER));
      const compact = (words) => words.replace(/\s+/g, '');
      const words = text ? compact(text.textContent) : '';
      return element && words ? element.members.find((member) => member.text !== null && compact(member.text) === words) || null : null;
    }

    // ---- Palette drops (spec §6 rule 2: a tile dropped at a point is placed there and pinned) -----------------

    /**
     * A tile dropped on the drawing (`tile.tool`, one of the view module's element tools): the module's addition at
     * the drop point, then its name in place (§7.7). Null for a tile that names no tool.
     */
    function dropTile(tile, event) {
      if (!tile.tool) return null;
      const facts = kit.sceneFacts();
      const point = drawingPoint(kit.drawing().svg, event.clientX, event.clientY);
      const at = { x: Math.round(point.x - DROP_GRIP_UNITS), y: Math.round(point.y - DROP_GRIP_UNITS) };
      // In a sequence drawing the drop's height is the place of the new fragment or step (spec §7.4).
      return addAndName(read.operation('element.add', {
        tool: tile.tool, name: null, into: null, anchor: kit.anchorAt(event), placed: 'dropped', facts: { at, positions: facts.positions },
      }));
    }

    /**
     * A tile chosen by a click or key on it (`use.source` 'tile', with its `event`), from the Add menu or key A
     * ('menu'), or from the empty scope's button (spec §7.4):
     * - a line tool chosen with the pointer, or one that is no element tool, waits for the line's two boxes
     *   (startDrawing); a view without boxes yet (an empty scenario's Message) adds instead, so no tool is dead;
     * - a tool with `operators` (a fragment) chosen on its tile asks for the operator first; with the pointer a click at
     *   a height then places it;
     * - every other choice is the module's addition at the focus (see placeOfFocus), without a drop point (spec §6
     *   rule 2: a free place right of the drawn boxes in a view that keeps positions), then its name in place.
     * A mode on ends first, without a word.
     */
    function addTile(tile, use = {}) {
      if (!tile.tool) return null;
      endModeQuietly();
      const tools = adapter.tools();
      const lineTool = tools.relations.find((tool) => tool.id === tile.tool) || null;
      const elementTool = tools.elements.find((tool) => tool.id === tile.tool) || null;
      const pointer = Boolean(use.event && use.event.detail > 0);
      const hasBoxes = read.contents().elements.some((element) => element.axis !== 'port');
      if (lineTool && (!elementTool || (pointer && hasBoxes))) return startDrawing(lineTool);
      if (elementTool && Array.isArray(elementTool.operators) && use.source === 'tile') {
        return chooseOperator(elementTool, use.event, pointer);
      }
      return addAt(tile.tool, placeOfFocus());
    }

    /**
     * Where an addition without a drop point goes (spec §7.4): after the selected step or fragment, in its list
     * (`at`); inside the selected box (`into`; the deployment view asks "Inside ‹node›" or "At the top level"); else
     * where the view puts it.
     */
    function placeOfFocus() {
      const ref = kit.selectedRef();
      if (ref === null) return {};
      const selection = kit.selectionOf(ref);
      if (selection && selection.step) return { at: placeAfter(selection.step) };
      const element = read.elementOf(ref);
      return element && element.axis !== 'port' ? { into: ref } : {};
    }

    /** The module's addition of `tool` at `place` (`{ into, at, anchor }`, each optional), named in place. */
    function addAt(tool, place) {
      const facts = kit.sceneFacts();
      return addAndName(read.operation('element.add', Object.assign({
        tool, name: null, into: place.into || null, anchor: place.anchor || null, placed: 'click', facts: { positions: facts.positions },
      }, place.at ? { at: place.at } : {})));
    }

    /**
     * The operators of a tool such as Fragment, as a menu at its tile (spec §7.4 "Fragment, the operator, then a click
     * at a height"): with the pointer the chosen operator waits for that click; with the keyboard it is added at the
     * focus at once.
     */
    function chooseOperator(tool, event, pointer) {
      const tile = event && event.target && event.target.closest ? event.target.closest('button') : null;
      const place = placeOfFocus();
      return actions.openMenu({
        label: tool.label,
        groups: [{ label: null, items: tool.operators.map((operator) => ({
          label: operator, run: () => (pointer ? startPlacingFragment(operator) : addAt(operator, place)),
        })) }],
        placement: { anchor: tile || region, returnFocus: tile || region },
      });
    }

    /** A fragment's operator chosen with the pointer: the next click on the drawing places it at that height. */
    function startPlacingFragment(operator) {
      enterMode({ kind: 'place', operator, focusRef: null },
        `${operator}: click at the height where the fragment goes. Escape cancels.`);
    }

    /** The click of a fragment's placing: the module's addition of that operator at the click's height. */
    function placeFragment(released) {
      const { operator } = leaveMode();
      return addAt(operator, { anchor: kit.anchorAt(released) });
    }

    /** Applies an addition and opens the in-place name editor of the box it added (spec §7.7). */
    function addAndName(operation) {
      return read.run(operation).then((verdict) => {
        const added = verdict.ok && verdict.select ? canvas.refs().find((ref) => sameSelection(kit.selectionOf(ref), verdict.select)) : null;
        if (added) inline.beginNameEdit(added);
        return verdict;
      });
    }

    // ---- What follows a drawing or a selection -----------------------------------------------------------------

    /**
     * A new drawing (or the same one synced again): a move still running has ended (the module said why), a mode of
     * another view ends quietly, and C mode's marks are drawn again on the new hit layer.
     */
    function afterSync() {
      const drawing = kit.drawing();
      if (mode && (!drawing || mode.viewKey !== drawing.viewModel.key)) endModeQuietly({ relay: false });
      if (mode && mode.kind === 'move' && mode.places) {
        leaveMode({ relay: false });
        announce(DRAWING_CHANGED, { kind: 'result' });
      }
      if (mode && mode.kind === 'move' && mode.order) {
        leaveMode({ relay: false });
        announce(DRAWING_CHANGED, { kind: 'result' });
      }
      if (mode && mode.kind === 'move') leaveMode({ relay: false });
      if (mode && mode.kind === 'connect' && mode.request) mode.candidates = kit.session().markTargets(mode.request) || [];
      if (!drawing) {
        inline.end();
        button.remove();
      }
    }

    /** After the listbox is laid again: the in-place field over its option again, and the "⋯" button. */
    function onDraw() {
      inline.place();
      button.place();
    }

    Object.assign(ways, { startMove, startBendMove, startConnect, removeOption, endModeQuietly });
    const controller = new AbortController();
    region.addEventListener('pointermove', onPointerMove, { signal: controller.signal });
    region.addEventListener('dblclick', onDoubleClick, { signal: controller.signal });
    const stopDraws = canvas.onDraw(onDraw);

    return {
      onKey,
      pressInMode,
      addTile,
      dropTile,
      startDrawing,
      contextMenu,
      unavailableReason,
      positions: createPositionCommands(kit, read, () => endModeQuietly()),
      afterSync,
      afterSelection: () => button.place(),
      destroy() {
        endModeQuietly();
        inline.end();
        button.destroy();
        stopDraws();
        controller.abort();
      },
    };
  }

  /**
   * The inspector's Position section on an edited UML-notation view (spec §6, §7.4 "Move a box", §7.6). A step, a
   * typed X or Y, and Return to automatic layout steer the module as M and the box's menu do: a move is the module's
   * placing (`session.startPlacing`, nudged by the difference, then committed), so it writes what the keys write, with
   * the bends the box's lines carry along. `endMode()` ends a mode of the canvas first. Places are in the view's layout
   * frame, the one design.yml keeps (see layoutFrame in c4-editor-uml-canvas.js). Returns `{ positionOf(ref),
   * moveBy(ref, dx, dy), moveTo(ref, x, y), returnToAutomatic(ref) }`; the moves return a promise of the verdict.
   */
  function createPositionCommands(kit, read, endMode) {
    /**
     * Box `ref` of the drawing: `{ kept, at: [x, y] | null, refusal }`, where `refusal` is the sentence of why the box
     * cannot be moved here (it keeps no position in this view, or a lock holds the view's positions), else null.
     * Null when the drawing has no such box.
     */
    function positionOf(ref) {
      const drawing = kit.drawing();
      if (!drawing || !read.elementOf(ref)) return null;
      const facts = kit.sceneFacts();
      const drawn = facts.positions[ref] || null;
      const verdict = drawn ? kit.adapter.can(read.operation('layout.set', { positions: { [ref]: drawn }, routes: [], facts }))
        : { ok: false, message: null };
      const keptPlaces = drawing.viewModel.layout ? drawing.viewModel.layout.positions : new Map();
      const kept = keptPlaces.get(drawing.uml.ids[ref]) || null;
      const at = kept || (drawn && editorParts().umlLayout.inLayoutFrame(drawn, drawing.frame).map(Math.round));
      return { kept: kept !== null, at, refusal: verdict.ok ? null : verdict.message };
    }

    function moveBy(ref, dx, dy) {
      endMode();
      const session = kit.session();
      const placing = session ? session.startPlacing({ ref: { id: ref, kind: 'node' } }) : null;
      if (!placing) return Promise.resolve(null);
      placing.nudge(dx, dy);
      return placing.commit();
    }

    function moveTo(ref, x, y) {
      const position = positionOf(ref);
      if (!position || !position.at) return Promise.resolve(null);
      return moveBy(ref, x - position.at[0], y - position.at[1]);
    }

    function returnToAutomatic(ref) {
      endMode();
      return read.run(read.operation('layout.reset', { target: { element: ref } }));
    }

    return { positionOf, moveBy, moveTo, returnToAutomatic };
  }

  /**
   * What every way in reads of the drawn document, through the session's adapter (`kit` as createUmlInteraction
   * takes it): `contents()`, `elementOf(ref)` (a drawn box), `relationOf(ref)` (the drawn relation a line's ref names),
   * `fragmentOf(ref)` (a drawn fragment),
   * `operation(op, fields)` (built against the document as it reads now), `run(operation)` (applies it and says a
   * refusal; an accepted result is said once it is drawn), `holdsPosition(ref)`, and `focusOption(ref, selection?)`.
   */
  function documentReader(kit) {
    const { adapter, canvas } = kit;
    const contents = () => adapter.contents();
    return {
      contents,
      elementOf: (ref) => contents().elements.find((element) => element.id === ref) || null,
      relationOf(ref) {
        const match = /:(\d+)$/.exec(String(ref));
        const line = match ? Number(match[1]) : -1;
        return contents().relations.find((relation) => relation.line === line) || null;
      },
      fragmentOf: (ref) => contents().fragments.find((fragment) => fragment.id === ref) || null,
      operation: (op, fields) => Object.assign({ op, revision: contents().revision }, fields),
      run(built) {
        return Promise.resolve(adapter.apply(built)).then((verdict) => {
          if (!verdict.ok && verdict.message) kit.say(verdict);
          return verdict;
        });
      },
      holdsPosition(ref) {
        const drawing = kit.drawing();
        const kept = drawing && drawing.viewModel.layout ? drawing.viewModel.layout.positions : null;
        return Boolean(kept && kept.has(drawing.uml.ids[ref]));
      },
      /** Focuses the option of `ref`, found by the selection it stands for (a line's ref changes when lines are added). */
      focusOption(ref, selection = kit.selectionOf(ref)) {
        return (selection ? canvas.focusFor(selection) : false) || canvas.focusRef(ref);
      },
    };
  }

  /** An item that runs, or one that is aria-disabled with its short reason and shows its sentence when activated. */
  function menuItem(label, verdict, run) {
    if (verdict.ok) return { label, run };
    return { label, note: verdict.summary || null, unavailable: verdict.message || verdict.summary || 'Not available here.', run() {} };
  }

  /**
   * The menus of a box and of a line (Shift+F10, the Menu key, a right-click, the "⋯" button), and the chooser of a
   * line's new end. Each menu ends with the view module's own items for the option (`menu(ref, context) → [{ label,
   * operation | action | refusal }]`, see moduleItems); an option that is neither a box nor a line (a fragment) has
   * those alone. `bendAt` (drawing units) is where a right-click on a line pressed: its "Add a bend" puts the bend
   * there. Returns `{ openMenu(ref, placement, { bendAt }), moduleMenu(ref) }`: `moduleMenu` gives the view module's
   * items as it gives them (Move of a lifeline chooses among them).
   */
  function createUmlMenus(kit, read, ways) {
    const { adapter, actions } = kit;

    function openMenu(ref, placement, { bendAt = null } = {}) {
      if (read.elementOf(ref)) return openBoxMenu(ref, placement);
      if (!read.fragmentOf(ref) && read.relationOf(ref)) return openLineMenu(ref, placement, bendAt);
      const items = moduleItems(ref);
      if (items.length === 0) {
        kit.announce(`${kit.nameOf(ref)} has no actions here.`, { kind: 'result' });
        return null;
      }
      return actions.openMenu({ label: `Actions for ${kit.nameOf(ref)}`, groups: [{ label: null, items }], placement });
    }

    /**
     * The view module's items for option `ref`, as menu items: an `operation` (its fields, without a revision) is
     * applied against the document as it reads now, and offered disabled with its short reason when the adapter would
     * refuse it; an `action` is a function the item runs; a `refusal` (`{ summary, message }`, or a `{ code, values }` of
     * the refusal table) is an item that only says why it cannot run.
     */
    function moduleItems(ref) {
      return moduleMenu(ref).map((item) => {
        if (item.refusal) return menuItem(item.label, refusalVerdict(item.refusal), () => {});
        if (typeof item.action === 'function') return { label: item.label, run: () => item.action() };
        const { op, ...fields } = item.operation;
        const built = () => read.operation(op, fields);
        return menuItem(item.label, adapter.can(built()), () => read.run(built()));
      });
    }

    /** The view module's own items of option `ref` as it gives them (`[{ label, operation | action | refusal }]`), or none. */
    function moduleMenu(ref) {
      const drawing = kit.drawing();
      const module = drawing ? drawing.module : null;
      return module && typeof module.menu === 'function' ? module.menu(ref, kit.viewContext()) || [] : [];
    }

    /** The verdict a module's `refusal` stands for: its own words, or the refusal table's for its code. */
    function refusalVerdict(refusal) {
      if (!refusal.code) return { ok: false, summary: refusal.summary || null, message: refusal.message || refusal.summary || null };
      const table = editorParts().umlRefusals;
      const context = kit.viewContext();
      return table.verdict(refusal.code, refusal.values || {}, { checksReleased: context.checksReleased, profile: context.profile });
    }

    /** A menu's items with the view module's after them, before Delete (which stays last). */
    function withModuleItems(ref, items) {
      const extra = moduleItems(ref);
      const last = items[items.length - 1];
      return last && last.label === 'Delete' ? items.slice(0, -1).concat(extra, [last]) : items.concat(extra);
    }

    function openBoxMenu(ref, placement) {
      const element = read.elementOf(ref);
      const place = kit.sceneFacts().positions[ref];
      const items = [
        menuItem('Rename…', adapter.can(read.operation('element.rename', { ref, text: element.name || element.label })),
          () => ways.beginNameEdit(ref)),
        menuItem('Move…', place ? adapter.can(read.operation('layout.set', { positions: { [ref]: place }, routes: [] }))
          : { ok: false, summary: null, message: `${kit.nameOf(ref)} moves with what contains it.` }, () => ways.startMove(ref)),
        { label: 'Draw a line', run: () => ways.startConnect(ref) },
      ];
      if (read.holdsPosition(ref)) {
        const reset = () => read.operation('layout.reset', { target: { element: ref } });
        items.push(menuItem('Return to automatic layout', adapter.can(reset()), () => read.run(reset())));
      }
      items.push(menuItem('Delete', adapter.can(read.operation('element.remove', { ref })), () => ways.removeOption(ref)));
      return actions.openMenu({ label: `Actions for ${kit.nameOf(ref)}`, groups: [{ label: null, items: withModuleItems(ref, items) }], placement });
    }

    /**
     * A line's menu: its bends (spec §7.4 "Move a bend"), then its ends and Delete. A sequence message has no bend
     * items: a drag moves or retargets it, it is never bent (spec §3.11).
     */
    function openLineMenu(ref, placement, bendAt = null) {
      const items = read.contents().type === 'sequence' ? [] : bendItems(ref, bendAt);
      ['source', 'target'].forEach((end) => items.push({ label: `Move the ${end} end to…`, run: () => openEndChooser(ref, end, placement) }));
      const removal = read.operation('selection.remove', { elements: [], relations: [ref], fragments: [], activations: [] });
      items.push(menuItem('Delete', adapter.can(removal), () => ways.removeOption(ref)));
      return actions.openMenu({ label: `Actions for ${kit.nameOf(ref)}`, groups: [{ label: null, items: withModuleItems(ref, items) }], placement });
    }

    /** "Add a bend" (at `bendAt`, or in the middle of the longest segment), and each bend's "Move bend N…" and "Remove bend N". */
    function bendItems(ref, bendAt) {
      const session = kit.session();
      const route = { id: ref, kind: 'route' };
      const bends = session.commands.bends(route);
      const drawn = session.scene().routes(kit.drawing().svg).find((candidate) => candidate.id === ref);
      const bendable = adapter.can(read.operation('layout.set', { positions: {}, routes: [{ id: ref, points: drawn ? drawn.points : [] }] }));
      const items = [menuItem('Add a bend', bendable,
        () => ways.startBendMove(ref, () => session.commands.addBend(route, bendAt || undefined), { added: true }))];
      bends.forEach((bend) => {
        items.push(menuItem(`Move bend ${bend.n}…`, bendable, () => ways.startBendMove(ref, () => session.startPlacing({ ref: route, bend: bend.n }))));
        items.push(menuItem(`Remove bend ${bend.n}`, bendable, () => session.commands.removeBend(route, bend.n)));
      });
      if (bends.length > 0) items.push(menuItem('Straighten', bendable, () => session.commands.straighten(route)));
      return items;
    }

    /**
     * "Move the ‹end› end to…" (spec §7.4 "Move an end of a line"): the boxes the end can move to, possible ones first,
     * the others disabled with their short reason. The box the end is at now is left out.
     */
    function openEndChooser(ref, end, placement) {
      const relation = read.relationOf(ref);
      const current = relation ? (end === 'source' ? relation.from : relation.to) : null;
      const advice = adapter.targets({ op: 'relation.rewire', ref, end, to: null, open: 'to', revision: read.contents().revision }) || [];
      const order = root.ArchUMLDiagramEditorParts.scene.targetOrder(advice.filter((candidate) => targetId(candidate.ref) !== current));
      if (order.length === 0) {
        kit.announce(`No other box can be the ${end} of ${kit.nameOf(ref)}.`, { kind: 'refusal' });
        return null;
      }
      const rewire = (to) => read.operation('relation.rewire', { ref, end, to });
      const items = order.map((candidate) => {
        const to = targetId(candidate.ref);
        const verdict = candidate.ok ? { ok: true } : Object.assign({}, adapter.can(rewire(to)), { summary: candidate.summary });
        return menuItem(kit.nameOf(to), verdict, () => read.run(rewire(to)));
      });
      return actions.openMenu({ label: `Move the ${end} end of ${kit.nameOf(ref)} to`, groups: [{ label: null, items }], placement });
    }

    return { openMenu, moduleMenu };
  }

  /**
   * The in-place editors (spec §7.4): an HTML field over the option of a box, outside the drawing (so the dark-mode
   * filter never reaches it), with its accessible name, the visible instruction tied to it with aria-describedby, and
   * the problem of a refused commit. The operation it commits is built against the drawing it was opened on: a
   * document changed meanwhile is refused as stale, and the typed text stays (spec Review Focus 2). It binds
   * `ways.beginNameEdit` for the menus. Returns `{ beginEdit(ref), beginNameEdit(ref), beginMemberEdit(ref, member),
   * place(), end() }`.
   */
  function createInlineEditors(kit, read, ways) {
    const { adapter, announce, dom, canvas } = kit;
    const { stage } = canvas;
    const doc = stage.ownerDocument;
    const ids = kit.ids || dom.idFactory('c4-uml-inline');
    let inline = null;

    /**
     * F2, "Rename…", a double-click on a box, or a box just added: its name in place, the current name selected; a box
     * the view cannot rename says why.
     */
    function beginNameEdit(ref) {
      const element = read.elementOf(ref);
      if (!element) return false;
      const name = element.name || element.label;
      const verdict = adapter.can(read.operation('element.rename', { ref, text: name }));
      if (!verdict.ok) {
        kit.say(verdict);
        return true;
      }
      const code = Object.prototype.hasOwnProperty.call(CODE_KINDS, element.kind);
      open({
        ref, name: `Name of ${typeWord(element)} ${name}`, value: name, hint: code ? `${SAVE_HINT} ${CLASS_NAME_HINT}` : SAVE_HINT,
        build: (text) => ({ op: 'element.rename', ref, text }), kept: `Kept the name ${name}.`,
      });
      return true;
    }

    /**
     * F2 on an option (spec §7.4 "F2 edits in place"): a box's name, a step's description, or a fragment's first
     * guard. False for an option with no text to edit here (a line of a class diagram).
     */
    function beginEdit(ref) {
      if (read.elementOf(ref)) return beginNameEdit(ref);
      const fragment = read.fragmentOf(ref);
      if (fragment) return beginGuardEdit(ref, fragment);
      if (read.contents().type === 'sequence' && read.relationOf(ref)) return beginStepEdit(ref);
      return false;
    }

    /**
     * "Description of step ‹n›" (spec §7.4 In-place editors), starting with the step's description: the one its step
     * form starts with (the view module's plan of an edit with no changes). It commits the message's label, which is
     * the step's description (`relation.update`). `n` is the step's number in its option's name ("Step 2: …").
     */
    function beginStepEdit(ref) {
      const drawing = kit.drawing();
      const planned = drawing.module.plan({ op: 'relation.update', ref, changes: {}, revision: read.contents().revision }, kit.viewContext());
      if (!planned || planned.kind !== 'form' || !planned.initial) return false;
      const value = planned.initial.description || '';
      const verdict = adapter.can(read.operation('relation.update', { ref, changes: { label: value } }));
      if (!verdict.ok) {
        kit.say(verdict);
        return true;
      }
      const number = STEP_NUMBER.exec(kit.nameOf(ref));
      const step = number ? `step ${number[1]}` : kit.nameOf(ref);
      open({ ref, name: `Description of ${step}`, value, hint: SAVE_HINT, build: (text) => ({ op: 'relation.update', ref, changes: { label: text } }),
        kept: `Kept the description of ${step}.` });
      return true;
    }

    /** "Guard of branch 1 of ‹operator›" (spec §7.4 In-place editors), starting with the guard as drawn. */
    function beginGuardEdit(ref, fragment) {
      const branch = fragment.branches[0];
      const value = branch.guard || '';
      const build = (text) => ({ op: 'fragment.update', ref, guard: { branch: branch.line, text } });
      const verdict = adapter.can(Object.assign({ revision: read.contents().revision }, build(value)));
      if (!verdict.ok) {
        kit.say(verdict);
        return true;
      }
      const name = `branch 1 of ${fragment.operator}`;
      open({ ref, name: `Guard of ${name}`, value, hint: SAVE_HINT, build, kept: `Kept the guard of ${name}.` });
      return true;
    }

    /** A double-click on a member line: "‹Attribute | Operation› ‹n› of ‹class›" with the model's text. */
    function beginMemberEdit(ref, member) {
      const name = read.elementOf(ref).name;
      const build = (text) => ({ op: 'member.update', owner: ref, list: member.list, index: member.index, text });
      const verdict = adapter.can(Object.assign({ revision: read.contents().revision }, build(member.text)));
      if (!verdict.ok) {
        kit.say(verdict);
        return;
      }
      const noun = MEMBER_NOUNS[member.list];
      open({ ref, name: `${noun} ${member.index + 1} of ${name}`, value: member.text, hint: SAVE_HINT, build,
        kept: `Kept the ${noun.toLowerCase()} of ${name}.` });
    }

    function open(spec) {
      ways.endModeQuietly();
      end();
      const hintId = ids('uml-inline-hint');
      const problemId = ids('uml-inline-problem');
      const field = dom.el('input', {
        type: 'text', class: 'c4-editor__canvas-rename', value: spec.value, autocomplete: 'off', spellcheck: 'false',
        'aria-label': spec.name, 'aria-describedby': `${hintId} ${problemId}`,
        on: { keydown: onKeydown, blur: onBlur },
      });
      const hint = dom.el('p', { id: hintId, class: 'c4-editor__canvas-rename-hint', text: spec.hint });
      const problem = dom.el('p', { id: problemId, class: 'c4-editor__canvas-rename-problem', hidden: true });
      const holder = dom.el('div', { class: 'c4-editor__canvas-rename-holder' }, [field, hint, problem]);
      inline = { spec, holder, field, problem, revision: read.contents().revision, viewKey: kit.drawing().viewModel.key, committing: false };
      place();
      if (inline) {
        field.focus({ preventScroll: true });
        field.select();
      }
    }

    /**
     * Lays the field over its option (measured, so set through the CSSOM), and gives it focus back when a redraw took
     * it; with its box gone, or another view drawn, the editor ends.
     */
    function place() {
      if (inline === null) return;
      const drawing = kit.drawing();
      const option = drawing && drawing.viewModel.key === inline.viewKey ? canvas.optionElement(inline.spec.ref) : null;
      if (!option) {
        end();
        return;
      }
      const hadFocus = doc.activeElement === inline.field;
      if (!inline.holder.isConnected) stage.appendChild(inline.holder);
      const box = option.getBoundingClientRect();
      const frame = stage.getBoundingClientRect();
      inline.holder.style.setProperty('--c4-rename-x', `${box.left - frame.left - stage.clientLeft}px`);
      inline.holder.style.setProperty('--c4-rename-y', `${box.top - frame.top - stage.clientTop}px`);
      inline.holder.style.setProperty('--c4-rename-width', `${Math.max(box.width, FIELD_MIN_WIDTH_PX)}px`);
      if (!hadFocus && !inline.committing) inline.field.focus({ preventScroll: true });
    }

    function onKeydown(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit({ keepOpenOnRefusal: true });
      } else if (event.key === 'Escape') {
        // Taken here, so neither a mode nor the selection is closed by the same press.
        event.preventDefault();
        const { spec } = inline;
        end();
        announce(spec.kept);
        read.focusOption(spec.ref);
      }
    }

    /**
     * Leaving the field keeps what was typed. A redraw takes the field out and puts it back (place), so the decision
     * waits for the end of the task, when focus is wherever it went.
     */
    function onBlur() {
      const left = inline;
      Promise.resolve().then(() => {
        if (inline === left && left && !left.committing && left.field.isConnected && doc.activeElement !== left.field) {
          commit({ keepOpenOnRefusal: false });
        }
      });
    }

    /** Commits the field: the adapter applies its operation, or refuses it; Enter keeps a refused field open. */
    function commit({ keepOpenOnRefusal }) {
      const current = inline;
      const text = current.field.value;
      if (text.trim() === current.spec.value.trim()) {
        end();
        if (keepOpenOnRefusal) read.focusOption(current.spec.ref);
        return Promise.resolve(null);
      }
      current.committing = true;
      const built = Object.assign({ revision: current.revision }, current.spec.build(text));
      return Promise.resolve(adapter.apply(built)).then((verdict) => {
        if (inline !== current) return verdict;
        current.committing = false;
        if (verdict.ok || !keepOpenOnRefusal) {
          end();
          if (!verdict.ok && verdict.message) kit.say(verdict);
          if (verdict.ok) read.focusOption(current.spec.ref, verdict.select || undefined);
          return verdict;
        }
        if (verdict.code === 'cancelled') return verdict;
        current.problem.textContent = verdict.message || '';
        current.problem.hidden = !verdict.message;
        current.field.setAttribute('aria-invalid', 'true');
        if (verdict.message) kit.say(verdict);
        current.field.focus({ preventScroll: true });
        return verdict;
      });
    }

    function end() {
      if (inline === null) return;
      const { holder } = inline;
      inline = null;
      holder.remove();
    }

    ways.beginNameEdit = beginNameEdit;
    return { beginEdit, beginNameEdit, beginMemberEdit, place, end };
  }

  /**
   * The "⋯" button of the one selected box or line (spec §3.11, §7.4): beside the box, or beside the middle of the
   * line's longest segment, where the module's rule (`geometry.actionButtonPlace`) finds room clear of every hit
   * target, so a press on the box still moves it and one on the segment still bends it. It opens the item's menu, the
   * one Shift+F10 opens. None while `inMode()`, during a drag, or without exactly one selected box or line. It follows
   * the drawing's size (another magnification). Returns `{ place(), remove(), destroy() }`.
   */
  function createActionButton(kit, menus, inMode) {
    const { dom, canvas } = kit;
    const { region, stage } = canvas;
    const view = region.ownerDocument.defaultView;
    const resizes = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => place()) : null;
    let button = null;
    let observed = null;

    function remove() {
      if (button) button.remove();
      button = null;
    }

    function place() {
      remove();
      const session = kit.session();
      const drawing = kit.drawing();
      if (!session || !drawing || inMode() || isDragging(session) || (kit.dragging && kit.dragging())) return;
      follow(drawing.svg);
      const selected = session.selection();
      if (selected.size !== 1 || (selected.kind !== 'route' && selected.kind !== 'node')) return;
      const svg = drawing.svg;
      const layer = svg.querySelector(HOST_LAYER);
      const ref = selected.id;
      if (!layer || !canvas.optionElement(ref)) return;
      const toClient = clientMapper(svg);
      const segments = [...layer.querySelectorAll('.uml-pg-edge-hitbox')];
      const own = segments.find((segment) => segment.getAttribute('data-route-id') === ref);
      const halfWidth = (own ? parseFloat(view.getComputedStyle(own).strokeWidth) || ACTION_BUTTON_PX : ACTION_BUTTON_PX) / 2;
      const hits = [...layer.querySelectorAll('.uml-pg-edit-hitbox, .uml-pg-bend-number')].map(clientBox)
        .concat(segments.map((segment) => ({
          a: toClient(Number(segment.getAttribute('x1')), Number(segment.getAttribute('y1'))),
          b: toClient(Number(segment.getAttribute('x2')), Number(segment.getAttribute('y2'))),
          halfWidth,
        })));
      const target = itemTarget(svg, layer, selected, toClient, halfWidth);
      if (!target) return;
      const spot = root.ArchUMLDiagramEditorParts.geometry.actionButtonPlace(target, hits, ACTION_BUTTON_PX);
      const shown = dom.el('button', {
        type: 'button', class: 'c4-editor__uml-more', tabindex: '-1', 'aria-label': `Actions for ${kit.nameOf(ref)}`, 'aria-haspopup': 'menu',
        on: { click: () => menus.openMenu(ref, { anchor: shown, returnFocus: canvas.optionElement(ref) || region }) },
      }, [dom.el('span', { 'aria-hidden': 'true', text: '⋯' })]);
      const frame = stage.getBoundingClientRect();
      shown.style.setProperty('--c4-more-x', `${spot.x - frame.left - stage.clientLeft}px`);
      shown.style.setProperty('--c4-more-y', `${spot.y - frame.top - stage.clientTop}px`);
      stage.appendChild(shown);
      button = shown;
    }

    /**
     * What the button is placed beside, in client points: a box's hit target (`{ box }`), or a line's drawn route
     * (`{ points, halfWidth }`); null when the drawing has neither.
     */
    function itemTarget(svg, layer, selected, toClient, halfWidth) {
      if (selected.kind === 'node') {
        const hit = [...layer.querySelectorAll('.uml-pg-edit-hitbox')].find((candidate) => candidate.getAttribute('data-layout-id') === selected.id);
        return hit ? { box: clientBox(hit) } : null;
      }
      const route = kit.session().scene().routes(svg).find((candidate) => candidate.id === selected.id);
      return route ? { points: route.points.map((point) => toClient(point.x, point.y)), halfWidth } : null;
    }

    /** Places the button again when the drawing changes size (another magnification). */
    function follow(svg) {
      if (!resizes || observed === svg) return;
      if (observed) resizes.unobserve(observed);
      observed = svg;
      resizes.observe(svg);
    }

    return {
      place,
      remove,
      destroy() {
        remove();
        if (resizes) resizes.disconnect();
      },
    };
  }

  // ---- Helpers ---------------------------------------------------------------------------------------------------

  /** Whether a drag of the session runs (the classic surface's question; a host surface's session may not ask it). */
  function isDragging(session) {
    return typeof session.commands.isDragging === 'function' && session.commands.isDragging();
  }

  /** The place after the step or fragment at `position` (`{ containerPath, index }`), in the same list. */
  function placeAfter(position) {
    return { containerPath: position.containerPath.slice(), index: position.index + 1 };
  }

  /** The id a target's `ref` names (an alias, or `{ id }`). */
  function targetId(ref) {
    return ref !== null && typeof ref === 'object' ? ref.id : ref;
  }

  function isLetter(event, letter) {
    const drag = editorParts().drag;
    return drag ? drag.isLetter(event, letter)
      : event.key.toLowerCase() === letter && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  /** Shift+F10 or the Menu key, without Ctrl, Cmd, or Alt. */
  function opensMenu(event) {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    return plain && ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu');
  }

  /** The word for a box's type: a code element's kind, else its C4 type or its drawn role. */
  function typeWord(element) {
    return CODE_KINDS[element.kind] || TYPE_WORDS[element.kind] || 'element';
  }

  /** Whether two editor selections name the same thing (the keys and values of `b`). */
  function sameSelection(a, b) {
    if (!a || !b) return false;
    const keys = Object.keys(b);
    return keys.length > 0 && keys.every((key) => a[key] === b[key]);
  }

  /** Maps drawing points of `svg` to client points. */
  function clientMapper(svg) {
    const matrix = svg.getScreenCTM();
    return (x, y) => {
      const point = new DOMPoint(x, y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    };
  }

  /** The drawing point of `svg` under a client point. */
  function drawingPoint(svg, x, y) {
    return new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
  }

  function clientBox(element) {
    const box = element.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  }

  return { createUmlInteraction, typeWord, sameSelection, menuItem };
});
