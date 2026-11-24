(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'));
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.scaffolds = factory(root.ArchUMLC4);
  }
})(typeof self !== 'undefined' ? self : this, function (C4) {
  'use strict';

  // The novice scaffolds (spec §9.3): the empty-state guide, inline definitions (element types, interface terms, and
  // the interface styles), the interface sentence frames, the carry-down tray with "Refine into…", and the
  // responsibility trace. Each one is switched by `options.scaffolds` and works from the state
  // controller's events; the DOM-free functions (definitions, carry-down counts, the trace) are shared with the parts
  // that show the same facts elsewhere (the inspector's trace lists, the canvas's trace highlight).

  // Student-facing texts, worded as the chapter's decision rules (spec §9.3); keep them in step with the chapter.
  const DEFINITIONS = Object.freeze({
    person: 'A human who uses a software system, named by role, such as Student.',
    system: 'Software that delivers value to its users, usually built and run by one team. External means built and run by another team, even inside your organization.',
    container: 'An application or data store that must be running for the system to work, such as a web app, an API, or a database schema. Not a Docker container, which is only one way to run it.',
    component: 'A group of related functionality behind one interface, inside one container. It is deployed with its container, never on its own.',
    code: 'A class, interface, function, or module that implements a component.',
    browser_app: 'runs in the user\'s browser — separate from the server that delivers it',
    // Interface descriptions (spec §9.3 "Definitions popovers").
    'interface-description': 'what a client needs to use an element without reading its code: the syntax (operations, inputs, '
      + 'outputs, types) and the semantics (purpose, side effects, restrictions, errors, examples, meanings, units). Not a C4 '
      + 'abstraction: you describe one wherever a client crosses the boundary of a system, a container, or a component. Not to '
      + 'be confused with a UML «interface» in the code view, which lists operations only.',
    'syntactic-view': 'how to call it: operations, parameters, outputs, types, allowed values, constraints.',
    'semantic-view': 'what it means: purpose, effects, who may call it, what can go wrong, examples, units and formats.',
    'shared-vocabulary': 'terms both sides agree on, so the same word means the same thing.',
  });
  // The visible name of each defined term, as the definition term button shows it.
  const TERM_NAMES = Object.freeze({
    'interface-description': 'Interface description',
    'syntactic-view': 'Syntactic view',
    'semantic-view': 'Semantic view',
    'shared-vocabulary': 'Shared vocabulary',
  });
  // Spec §9.3 "Style": one line per option of the style select; unset means "Not sure yet", the novice default.
  const STYLE_DEFINITIONS = Object.freeze([
    { value: 'rest', name: 'REST', definition: 'requests to resources over HTTP' },
    { value: 'rpc', name: 'RPC', definition: 'calls a function on a remote server' },
    { value: 'graphql', name: 'GraphQL', definition: 'queries a typed schema over HTTP' },
    { value: 'soap', name: 'SOAP', definition: 'XML messages with a formal contract' },
    { value: 'message', name: 'Message', definition: 'commands sent through a queue to one receiver' },
    { value: 'event', name: 'Event', definition: 'announcements a publisher sends to any subscriber' },
    { value: 'stream', name: 'Stream', definition: 'a continuous sequence of records' },
    { value: 'library', name: 'Library', definition: 'calls inside one running program' },
    { value: 'file', name: 'File', definition: 'a document two systems exchange' },
  ]);
  const STYLE_NOT_CHOSEN = 'Not sure yet';
  // Interface sentence frames (spec §9.3): visible hint text beside each field, never its value. `provider` is the
  // providing element's name. An emitted event or stream has subscribers rather than callers, so its restrictions
  // carry the Delivery frame (what a subscriber may rely on).
  const PUBLISHED_STYLES = ['event', 'stream'];
  const INTERFACE_FRAMES = {
    purpose: ({ provider, style }) => {
      if (style === 'message') return `When a sender sends …, ${provider} ….`;
      if (PUBLISHED_STYLES.includes(style)) return `When ${provider} publishes …, subscribers can ….`;
      return `When a client …, ${provider} … and returns ….`;
    },
    side_effect: () => 'After a successful call, … has changed: ….',
    restriction: ({ style }) => (PUBLISHED_STYLES.includes(style) ? INTERFACE_FRAMES.delivery()
      : 'Only … may call this, and only when ….'),
    error: () => 'Happens when …; the client should then ….',
    delivery: () => 'A subscriber may receive this … (once, or more than once) and … (in order, or in any order).',
    meaning: () => 'The … that this field identifies or measures, for ….',
    unit: () => 'A value of 1 in this field means one … (second, cent, kilogram, item).',
    format: () => 'Written as …: which comes first, day or month? Which time zone?',
  };
  const EMPTY_STATE_STEPS = Object.freeze([
    'Add the system you are designing',
    'Who uses it, and which systems does it depend on?',
    'What must it know, do, or decide? Trace each to a requirement.',
    'Zoom in: add containers and give each responsibility one owner (Refine into…)',
  ]);
  const TEXT = {
    guide: 'Start your design',
    tray: 'Responsibilities to refine',
    refineInto: 'Refine into…',
    trayHint: 'Drag a responsibility onto the part that helps realize it, or use its Refine into… menu.',
    notRefined: 'Not refined yet',
    linked: 'Linked to the selected responsibility',
  };
  const KIND_WORDS = { know: 'KNOW', do: 'DO', decide: 'DECIDE' };
  // The carry-down tray sits at the top of a boundary with parts inside it (spec §9.3).
  const TRAY_VIEW_TYPES = ['containers', 'components'];

  /** Whether scaffold `name` is on: every scaffold is on unless `options.scaffolds[name]` is `false` (spec §3.4). */
  function isScaffoldOn(options, name) {
    return !(options && options.scaffolds && options.scaffolds[name] === false);
  }

  /** The inline definition of an element type or kind ('person', 'system', 'container', 'component', 'code', 'browser_app'), or null. */
  function definitionFor(term) {
    return Object.prototype.hasOwnProperty.call(DEFINITIONS, term) ? DEFINITIONS[term] : null;
  }

  /**
   * The sentence frame of an interface field `kind` ('purpose', 'side_effect', 'restriction', 'error', 'delivery',
   * 'meaning', 'unit', 'format'), or null for another kind. `context`: `provider` (the providing element's name) and
   * `style` (the interface's style, or null).
   */
  function frameFor(kind, context = {}) {
    const frame = Object.prototype.hasOwnProperty.call(INTERFACE_FRAMES, kind) ? INTERFACE_FRAMES[kind] : null;
    return frame === null ? null : frame({ provider: context.provider || 'the provider', style: context.style || null });
  }

  /** The style select's options: "Not sure yet", then "REST: requests to resources over HTTP" and the rest. */
  function styleChoices() {
    return [{ value: '', label: STYLE_NOT_CHOSEN, name: null }].concat(STYLE_DEFINITIONS.map((style) =>
      ({ value: style.value, label: `${style.name}: ${style.definition}`, name: style.name })));
  }

  /** "DECIDE whether a student may enroll in a section": a responsibility as the editor shows it. */
  function responsibilityLabel(responsibility) {
    const kind = KIND_WORDS[responsibility.kind];
    return kind ? `${kind} ${responsibility.text}` : responsibility.text;
  }

  // ---- Responsibilities across the model (DOM-free) ---------------------------------------------------------------

  function allResponsibilities(model) {
    return [...model.elements.values()].flatMap((element) => element.responsibilities || []);
  }

  function isDescendant(model, id, ancestorId) {
    for (let current = model.elements.get(id); current && current.parentId; current = model.elements.get(current.parentId)) {
      if (current.parentId === ancestorId) return true;
    }
    return false;
  }

  /** The responsibility a selection or id names: `'api-holds'`, `{ responsibilityId }`, or `{ elementId, responsibilityIndex }`. */
  function responsibilityAt(model, target) {
    if (!target) return null;
    const id = typeof target === 'string' ? target : target.responsibilityId;
    if (id) return allResponsibilities(model).find((responsibility) => responsibility.id === id) || null;
    const element = typeof target.responsibilityIndex === 'number' ? model.elements.get(target.elementId) : null;
    return element ? (element.responsibilities || [])[target.responsibilityIndex] || null : null;
  }

  // ---- Carry-down (DOM-free) ---------------------------------------------------------------------------------------

  /** The element whose responsibilities the tray carries down in view `selector`, or null for other views. */
  function trayScopeOf(design, selector) {
    if (design.model === null || !selector) return null;
    const projected = C4.project(design, selector);
    return TRAY_VIEW_TYPES.includes(projected.type) ? design.model.elements.get(projected.scopeId) || null : null;
  }

  /**
   * The scope's responsibilities, each with `refinedBy`: how many responsibilities of the scope's descendants name it
   * in their `refines` (a responsibility without an id cannot be named yet, so it counts none).
   */
  function carryDownItems(design, scopeId) {
    const model = design.model;
    const below = allResponsibilities(model).filter((responsibility) => isDescendant(model, responsibility.ownerId, scopeId));
    return (model.elements.get(scopeId).responsibilities || []).map((responsibility) => ({
      index: responsibility.index,
      id: responsibility.id,
      kind: responsibility.kind,
      text: responsibility.text,
      refinedBy: responsibility.id === null ? 0 : below.filter((other) => other.refines.includes(responsibility.id)).length,
    }));
  }

  /** The parts a scope's responsibility can be refined into: the scope's children in model order. */
  function refineTargets(design, scopeId) {
    const model = design.model;
    return model.elements.get(scopeId).childIds.map((id) => model.elements.get(id));
  }

  /**
   * The one command that refines responsibility `index` of `elementId` into `childId`: gives the parent responsibility
   * an id when it has none, adds a copy of it to the child (to reword for the child's part), and links the copy with
   * `refines`. The id is learned from a dry run of the core (Ruling 14), so the batch is one change and one undo
   * step. Returns the command, or the core's `{ error, message }`.
   */
  function refineCommand(design, { elementId, index, childId }) {
    const ensureId = { op: 'ensureResponsibilityId', elementId, index };
    const named = C4.edit(design, ensureId);
    if (named.error) return named;
    const parent = design.model.elements.get(elementId).responsibilities[index];
    const child = design.model.elements.get(childId);
    return {
      op: 'batch',
      commands: [
        ensureId,
        { op: 'addResponsibility', elementId: childId, kind: parent.kind, text: parent.text },
        { op: 'updateResponsibility', elementId: childId, index: (child.responsibilities || []).length, refines: [named.selection.responsibilityId] },
      ],
    };
  }

  // ---- Responsibility trace (DOM-free) -----------------------------------------------------------------------------

  /**
   * The refinement trace of a responsibility (`target` as in `responsibilityAt`), or null when it does not exist:
   * `refines` and `refinedBy` are its direct links (the inspector lists them), `chain` every responsibility above
   * and below it through `refines`, and `elementIds` the owners of the chain, ancestors first: the elements a canvas
   * highlights. Each link is `{ id, kind, text, elementId, elementName }`.
   */
  function traceOf(design, target) {
    const model = design.model;
    const selected = model === null ? null : responsibilityAt(model, target);
    if (!selected) return null;
    const all = allResponsibilities(model);
    const byId = new Map(all.filter((responsibility) => responsibility.id !== null).map((responsibility) => [responsibility.id, responsibility]));
    const parentsOf = (responsibility) => responsibility.refines.map((id) => byId.get(id)).filter(Boolean);
    const childrenOf = (responsibility) => (responsibility.id === null ? [] : all.filter((other) => other.refines.includes(responsibility.id)));
    const chain = reachable(selected, parentsOf).concat(reachable(selected, childrenOf));
    const link = (responsibility) => ({
      id: responsibility.id,
      kind: responsibility.kind,
      text: responsibility.text,
      elementId: responsibility.ownerId,
      elementName: model.elements.get(responsibility.ownerId).name,
    });
    return {
      responsibility: link(selected),
      refines: parentsOf(selected).map(link),
      refinedBy: childrenOf(selected).map(link),
      chain: chain.map(link),
      elementIds: [...new Set(chain.map((responsibility) => responsibility.ownerId))],
    };
  }

  /** Every responsibility reachable from `start` through `next`, nearest first, without `start` itself. */
  function reachable(start, next) {
    const found = [];
    const seen = new Set([start]);
    for (let frontier = next(start); frontier.length > 0;) {
      const fresh = frontier.filter((responsibility) => !seen.has(responsibility));
      fresh.forEach((responsibility) => { seen.add(responsibility); found.push(responsibility); });
      frontier = fresh.flatMap(next);
    }
    return found;
  }

  /** "DECIDE whether prerequisites … (Enrollment Policy)": one trace link as the inspector lists it. */
  function traceLinkLabel(link) {
    return `${responsibilityLabel(link)} (${link.elementName})`;
  }

  /** "Refined by 1 responsibility, refines 1": the trace's direct links, as the live region announces them. */
  function traceSummary(trace) {
    const count = trace.refinedBy.length;
    return `Refined by ${count} ${count === 1 ? 'responsibility' : 'responsibilities'}, refines ${trace.refines.length}`;
  }

  // ---- Empty-state guide -------------------------------------------------------------------------------------------

  /**
   * Shows the four subgoals in the chapter's order in `region` while the model has no people and no systems
   * (spec §7.3, §9.3) and the `emptyStateGuide` scaffold is on. Returns `{ element, destroy() }`.
   */
  function createEmptyStateGuide(region, { state, dom, ids, options }) {
    const labelId = ids('guide-label');
    const element = dom.el('div', { class: 'c4-editor__guide', hidden: true }, [
      dom.el('p', { id: labelId, class: 'c4-editor__guide-label', text: TEXT.guide }),
      dom.el('ol', { class: 'c4-editor__guide-steps', 'aria-labelledby': labelId }, EMPTY_STATE_STEPS.map((step) => dom.el('li', { text: step }))),
    ]);
    region.appendChild(element);

    function render() {
      const design = state.getDesign();
      element.hidden = !(isScaffoldOn(options, 'emptyStateGuide') && design.model !== null && design.model.elements.size === 0);
    }

    const unsubscribe = state.on('text', render);
    render();
    return {
      element,
      destroy() {
        unsubscribe();
        element.remove();
      },
    };
  }

  // ---- Definitions -----------------------------------------------------------------------------------------------------

  /**
   * Attaches the definition of `term` to `anchor` (a palette tile, a type label; it needs an instance-prefixed id) as a
   * dismissible popover that stays open on hover and focus. Returns the popover handle, or null when the
   * `definitions` scaffold is off or the term has no definition.
   */
  function attachDefinition(anchor, term, { dom, options }) {
    const text = definitionFor(term);
    return text === null || !isScaffoldOn(options, 'definitions') ? null : dom.createPopover(anchor, text);
  }

  /**
   * A defined term as a button ("Interface description") whose definition is a popover: it opens on hover, focus,
   * and click, stays open while the pointer is over it or the term has focus, and closes on Escape without moving
   * focus (WCAG 1.4.13). `key` makes the id and the focus key unique in the form. Returns `{ element, dispose() }`,
   * or null when the `definitions` scaffold is off or the term has no definition. The owner disposes it before
   * removing it, so no document listener outlives it.
   */
  function createDefinitionTerm(term, { dom, ids, options, key }) {
    if (!Object.prototype.hasOwnProperty.call(TERM_NAMES, term) || !isScaffoldOn(options, 'definitions')) return null;
    const button = dom.el('button', {
      type: 'button', id: ids(`term-${key}`), class: 'c4-editor__term', 'data-c4-focus-key': `term-${key}`, text: TERM_NAMES[term],
    });
    // The popover mounts right after its anchor, so the anchor needs a parent first.
    const element = dom.el('span', { class: 'c4-editor__term-wrap' }, button);
    const popover = dom.createPopover(button, definitionFor(term));
    const onClick = () => popover.show();
    button.addEventListener('click', onClick);
    return {
      element,
      dispose() {
        button.removeEventListener('click', onClick);
        popover.dispose();
      },
    };
  }

  // ---- Carry-down tray --------------------------------------------------------------------------------------------------

  /**
   * In container and component views, the "Responsibilities to refine" toggle (`aria-expanded`) and the tray it
   * opens: the scope's responsibilities, how many descendants refine each, the ones linked to the selected
   * responsibility (a text badge and a dashed outline), and for each a "Refine into…" menu of the scope's parts.
   * The mount puts `region` in the canvas's scope header, on the top edge of the boundary (spec §9.3). There the open
   * panel lies over the first parts of the scope, so it closes when focus moves into the drawing (a part focused by
   * arrows, a click, or a drop is never hidden under it, WCAG 2.4.11), and Escape in the tray closes it and returns
   * focus to the toggle (after an open menu, which takes Escape first).
   * Dragging an item (spec §9.2 "Refine a parent responsibility") starts through `actions.startRefineDrag`, which the
   * canvas follows; a drop on a part calls the same `refineInto` as the menu. With `gate` (the editor's command gate
   * from c4-editor-panels.js), each "Refine into…" button is a gated visual command: `aria-disabled` with the reason
   * while the YAML cannot be read, and its item does not drag then. Returns `{ element, refineInto(index, childId,
   * { lead }) → result, destroy() }`.
   */
  function createCarryDownTray(region, { state, dom, ids, announce, options, gate, actions, canvas }) {
    let ungates = [];
    const toggleId = ids('tray-toggle');
    const panelId = ids('tray-panel');
    const element = dom.el('div', { class: 'c4-editor__tray', on: { keydown: onTrayKey } });
    // The drawing the open panel can lie over: the canvas's stage, which holds the scope header.
    const drawing = canvas && canvas.scopeHeader === region ? region.parentElement : null;
    const doc = region.ownerDocument;
    const toggle = dom.el('button', {
      type: 'button', id: toggleId, class: 'c4-editor__button c4-editor__tray-toggle', 'aria-expanded': 'false',
      'aria-controls': panelId, 'data-c4-focus-key': 'toggle', text: TEXT.tray, on: { click: () => setOpen(!open) },
    });
    const list = dom.el('ul', { class: 'c4-editor__tray-list', 'aria-labelledby': toggleId });
    const hint = dom.el('p', { class: 'c4-editor__tray-hint', text: TEXT.trayHint });
    const panel = dom.el('div', { id: panelId, class: 'c4-editor__tray-panel', hidden: true }, [hint, list]);
    region.appendChild(element);
    let open = false;
    let menu = null;

    function setOpen(next) {
      open = next;
      toggle.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
    }

    /** Focus moving onto the drawing outside the tray closes the panel, so the focused part is never under it. */
    function onFocusIntoDrawing(event) {
      if (open && drawing.contains(event.target) && !element.contains(event.target)) setOpen(false);
    }

    function onTrayKey(event) {
      if (event.key !== 'Escape' || event.defaultPrevented || !open) return;
      event.preventDefault();
      setOpen(false);
      toggle.focus();
    }

    function render() {
      const restore = focusKeyWithin(element);
      closeMenu({ returnFocus: false });
      releaseGates();
      const design = state.getDesign();
      const scope = isScaffoldOn(options, 'carryDown') ? trayScopeOf(design, state.getView()) : null;
      if (scope === null || (scope.responsibilities || []).length === 0) {
        element.replaceChildren();
        return;
      }
      const trace = isScaffoldOn(options, 'trace') ? traceOf(design, state.getSelection()) : null;
      const linked = new Set(trace ? trace.chain.map((responsibility) => responsibility.id).filter((id) => id !== null) : []);
      list.replaceChildren(...carryDownItems(design, scope.id).map((item) => itemOf(item, scope, linked.has(item.id))));
      hint.hidden = !canDrag();
      element.replaceChildren(toggle, panel);
      if (gate) ungates = [...list.querySelectorAll('[aria-haspopup="menu"]')].map((button) => gate.gate(button));
      restoreFocus(element, restore);
    }

    function releaseGates() {
      ungates.forEach((release) => release());
      ungates = [];
    }

    function itemOf(item, scope, isLinked) {
      const label = responsibilityLabel(item);
      const count = item.refinedBy === 0 ? TEXT.notRefined
        : `Refined by ${item.refinedBy} ${item.refinedBy === 1 ? 'responsibility' : 'responsibilities'}`;
      const button = dom.el('button', {
        type: 'button', id: ids(`tray-refine-${item.index}`), class: 'c4-editor__button', 'aria-haspopup': 'menu',
        'aria-expanded': 'false', 'data-c4-focus-key': `refine-${item.index}`,
        on: { click: () => toggleMenu(button, scope, item), keydown: (event) => onButtonKey(event, button, scope, item) },
      }, [TEXT.refineInto, dom.el('span', { class: 'c4-editor__sr-only', text: ` ${label}` })]);
      return dom.el('li', {
        class: `c4-editor__tray-item${isLinked ? ' c4-editor__tray-item--linked' : ''}`,
        on: { pointerdown: (event) => onItemPress(event, button, scope, item) },
      }, [
        dom.el('p', { class: 'c4-editor__tray-text', text: label }),
        dom.el('p', { class: 'c4-editor__tray-count', text: count }),
        isLinked ? dom.el('p', { class: 'c4-editor__badge', text: TEXT.linked }) : null,
        dom.el('div', { class: 'c4-editor__menu-anchor' }, button),
      ]);
    }

    function canDrag() {
      return Boolean(actions && typeof actions.startRefineDrag === 'function');
    }

    /**
     * A primary press on an item, outside its button and menu, may become a drag onto one of the scope's parts; the
     * canvas follows it (valid targets, ghost, Escape) and a drop calls `refineInto`.
     */
    function onItemPress(event, button, scope, item) {
      if (!event.isPrimary || event.button !== 0 || event.target.closest('button, [role="menu"]')) return;
      if (!canDrag() || button.getAttribute('aria-disabled') === 'true') return;
      closeMenu({ returnFocus: false });
      actions.startRefineDrag({
        label: responsibilityLabel(item),
        scopeName: scope.name,
        childIds: refineTargets(state.getDesign(), scope.id).map((child) => child.id),
        refine: (childId, { lead } = {}) => refineInto(item.index, childId, { lead }),
      }, event);
    }

    function onButtonKey(event, button, scope, item) {
      if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || button.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      openMenu(button, scope, item, event.key === 'ArrowUp' ? 'last' : 'first');
    }

    // ---- The "Refine into…" menu (WAI-ARIA menu button) ----
    // A small menu of its own while c4-editor-actions.js's shared menus are being built in parallel; the integration
    // step can move it onto `actions.openMenu` (one menu model per editor).

    function toggleMenu(button, scope, item) {
      if (menu !== null && menu.button === button) closeMenu({ returnFocus: true });
      else openMenu(button, scope, item, 'first');
    }

    function openMenu(button, scope, item, focusAt) {
      closeMenu({ returnFocus: false });
      const targets = refineTargets(state.getDesign(), scope.id);
      const items = targets.map((target) => dom.el('li', {
        role: 'menuitem', tabindex: '-1', class: 'c4-editor__tray-menu-item', text: target.name,
        on: { click: () => choose(item, target) },
      }));
      const element = dom.el('ul', { role: 'menu', id: ids('tray-menu'), class: 'c4-editor__tray-menu', 'aria-labelledby': button.id }, items);
      element.addEventListener('keydown', (event) => onMenuKey(event, items, item, targets));
      button.parentNode.appendChild(element);
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-controls', element.id);
      menu = { element, button };
      doc.addEventListener('pointerdown', onOutsidePointer, true);
      const first = focusAt === 'last' ? items[items.length - 1] : items[0];
      if (first) first.focus();
    }

    function onMenuKey(event, items, item, targets) {
      const index = items.indexOf(event.target);
      const moves = { ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1 };
      if (event.key in moves) {
        event.preventDefault();
        items[moves[event.key]].focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose(item, targets[index]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu({ returnFocus: true });
      } else if (event.key === 'Tab') {
        closeMenu({ returnFocus: false });
      } else if (dom.isTypeAhead(event)) {
        // A letter moves to the next part whose name starts with it, and never reaches the canvas's letter keys.
        event.preventDefault();
        dom.focusByLetter(items, index, event.key);
      }
    }

    function onOutsidePointer(event) {
      if (menu && !menu.element.contains(event.target) && !menu.button.contains(event.target)) closeMenu({ returnFocus: false });
    }

    function closeMenu({ returnFocus }) {
      if (menu === null) return;
      const { element, button } = menu;
      menu = null;
      doc.removeEventListener('pointerdown', onOutsidePointer, true);
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-controls');
      element.remove();
      if (returnFocus) button.focus();
    }

    function choose(item, target) {
      closeMenu({ returnFocus: true });
      refineInto(item.index, target.id);
    }

    /**
     * Refines the scope's responsibility `index` into `childId` as one undo step and announces the result, after
     * `lead` when given (a drag that ended a canvas mode says so first).
     */
    function refineInto(index, childId, { lead = '' } = {}) {
      const design = state.getDesign();
      const scope = trayScopeOf(design, state.getView());
      const command = refineCommand(design, { elementId: scope.id, index, childId });
      const result = command.error ? { ok: false, message: command.message } : state.dispatch(command, { label: 'Refine responsibility' });
      const childName = design.model.elements.get(childId).name;
      const text = design.model.elements.get(scope.id).responsibilities[index].text;
      const message = result.ok
        ? `${childName} now refines '${text}'. Reword the copy for ${childName}'s part.`
        : `${childName} cannot refine '${text}': ${result.message}`;
      announce(lead ? `${lead} ${message}` : message);
      return result;
    }

    const unsubscribes = ['text', 'view', 'selection'].map((event) => state.on(event, render));
    if (drawing) doc.addEventListener('focusin', onFocusIntoDrawing);
    render();
    return {
      element,
      refineInto,
      destroy() {
        unsubscribes.forEach((unsubscribe) => unsubscribe());
        if (drawing) doc.removeEventListener('focusin', onFocusIntoDrawing);
        closeMenu({ returnFocus: false });
        releaseGates();
        element.remove();
      },
    };
  }

  // ---- Trace announcements -----------------------------------------------------------------------------------------------

  /**
   * Announces the trace of each newly selected responsibility in the polite live region ("Refined by 1
   * responsibility, refines 1"), while the `trace` scaffold is on. Returns `{ destroy() }`.
   */
  function createTraceAnnouncer({ state, announce, options }) {
    let announced = null;
    const unsubscribe = state.on('selection', (selection) => {
      const trace = isScaffoldOn(options, 'trace') ? traceOf(state.getDesign(), selection) : null;
      const key = trace ? `${trace.responsibility.elementId}|${trace.responsibility.id}|${trace.responsibility.text}` : null;
      if (key !== null && key !== announced) announce(traceSummary(trace));
      announced = key;
    });
    return { destroy: unsubscribe };
  }

  // ---- Focus across re-renders ----------------------------------------------------------------------------------------

  function focusKeyWithin(container) {
    const active = container.ownerDocument.activeElement;
    return active && container.contains(active) ? active.getAttribute('data-c4-focus-key') : null;
  }

  function restoreFocus(container, key) {
    if (!key) return;
    const target = container.querySelector(`[data-c4-focus-key="${key}"]`);
    if (target) target.focus();
  }

  return {
    TEXT: TEXT,
    EMPTY_STATE_STEPS: EMPTY_STATE_STEPS,
    isScaffoldOn: isScaffoldOn,
    definitionFor: definitionFor,
    frameFor: frameFor,
    styleChoices: styleChoices,
    createDefinitionTerm: createDefinitionTerm,
    responsibilityLabel: responsibilityLabel,
    trayScopeOf: trayScopeOf,
    carryDownItems: carryDownItems,
    refineTargets: refineTargets,
    refineCommand: refineCommand,
    traceOf: traceOf,
    traceLinkLabel: traceLinkLabel,
    traceSummary: traceSummary,
    createEmptyStateGuide: createEmptyStateGuide,
    attachDefinition: attachDefinition,
    createCarryDownTray: createCarryDownTray,
    createTraceAnnouncer: createTraceAnnouncer,
  };
});
