(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () { return { interfaces: require('./c4-editor-interfaces.js') }; });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.toolbar = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The editor toolbar (spec §9.1, §9.2). It shows where the reader is (view level, scope, breadcrumbs) and offers
  // the editor's commands: the palette and Add relationship (handed to the actions part), Undo/Redo, magnification,
  // Reset layout, the host's file actions, Full screen, and Help. It reads the model through the `ArchUMLC4` facade,
  // changes it only through the state controller, and redraws its controls on every state event. At narrow widths
  // the stylesheet swaps the palette for an Add menu and the layout and file buttons for a More menu; both menus
  // offer the same commands as the buttons they replace, through the editor's one menu helper (c4-editor-dom.js).
  // Interface views are views of an element, not levels (spec §5.1, J14): the Interfaces button and the Show interfaces
  // toggle sit beside the level group, never in it.
  //
  // On a UML-notation view that the canvas edits (UML-view editing spec §5.6, §7.6), the palette offers the view
  // module's own tools (`actions.umlEditing().palette()`), followed by the disclosure "More UML tools (not available
  // here)" with the notation's other tools, each aria-disabled with its short reason; Reset layout removes the view's
  // layout entry. A model without scenarios or environments offers "New scenario…" or "New environment…" beside the
  // levels, so its Dynamic and Deployment views can be reached without typing YAML.

  // The view types in their toolbar order: the zoom levels from the context view down to code, then the supporting
  // views. The editor has no landscape level (ED-10): the context view is its top view.
  const LEVELS = [
    { type: 'context', label: 'Context' },
    { type: 'containers', label: 'Containers' },
    { type: 'components', label: 'Components' },
    { type: 'code', label: 'Code' },
    { type: 'dynamic', label: 'Dynamic' },
    { type: 'deployment', label: 'Deployment' },
    { type: 'custom', label: 'Custom' },
  ];
  const ELEMENT_SCOPED_VIEWS = new Set(['context', 'containers', 'components', 'code']);
  // Palette tiles (spec §9.2 Add details): the types valid at each view; the expert profile adds every element type.
  const TILES = {
    person: { kind: 'element', elementType: 'person', label: 'Person' },
    system: { kind: 'element', elementType: 'system', label: 'Software system' },
    container: { kind: 'element', elementType: 'container', label: 'Container' },
    component: { kind: 'element', elementType: 'component', label: 'Component' },
    code: { kind: 'element', elementType: 'code', label: 'Code element' },
    step: { kind: 'step', label: 'Step' },
    fragment: { kind: 'fragment', label: 'Fragment' },
    node: { kind: 'node', label: 'Node' },
    infrastructure: { kind: 'infrastructure-node', label: 'Infrastructure node' },
    host: { kind: 'host', label: 'Host a container or system' },
  };
  const TILES_BY_VIEW = {
    // The whole-model drawing is no level, only the starting canvas of a model without a system of its own (ED-10),
    // where the first person or system is added: it offers the Context view's tiles.
    landscape: ['person', 'system'],
    context: ['person', 'system'],
    containers: ['container'],
    components: ['component'],
    code: ['code'],
    dynamic: ['step', 'fragment'],
    deployment: ['node', 'infrastructure', 'host'],
  };
  const ELEMENT_TILES = ['person', 'system', 'container', 'component', 'code'];
  // Undo and Redo (ED-11): the state's command, its availability, the label of its step, the glyph of the site's UML
  // editor, and the keys listenForCanvasKeys (c4-editor-mount.js) routes to it, as aria-keyshortcuts and in words.
  const HISTORY_COMMANDS = [
    { label: 'Undo', run: 'undo', can: 'canUndo', stepLabel: 'undoLabel', glyph: '↶', nothing: 'Nothing to undo.',
      unnamed: 'Undo the last change.', keyshortcuts: 'Control+Z Meta+Z', keys: 'Ctrl+Z (Cmd+Z on a Mac)' },
    { label: 'Redo', run: 'redo', can: 'canRedo', stepLabel: 'redoLabel', glyph: '↷', nothing: 'Nothing to redo.',
      unnamed: 'Redo the last undone change.', keyshortcuts: 'Control+Y Control+Shift+Z Meta+Shift+Z Meta+Y',
      keys: 'Ctrl+Y or Ctrl+Shift+Z (Cmd+Shift+Z on a Mac)' },
  ];
  // The element types an `interfaces of` view can show (spec §5.1).
  const INTERFACE_SCOPES = new Set(['system', 'container', 'component']);
  const INTERFACES_ANNOTATION = 'interfaces';
  const READ_ONLY_REASONS = {
    'read-only': 'This model is read-only.',
    'yaml-errors': 'Visual editing is paused until the YAML errors are fixed.',
  };
  const EDITING_RESUMED = 'Visual editing is back on.';
  const MORE_UML_TOOLS = 'More UML tools (not available here)';
  // "New scenario…" and "New environment…" (spec §7.6): the command each runs, the field it asks for, and the view
  // the new section opens in.
  const NEW_SECTIONS = [
    { id: 'scenario', label: 'New scenario…', title: 'New scenario', field: 'Title', section: 'scenarios', noun: 'scenario',
      command: (text) => ({ op: 'addScenario', title: text }), selector: (selection) => `dynamic ${selection.scenarioId}` },
    { id: 'environment', label: 'New environment…', title: 'New environment', field: 'Name', section: 'environments', noun: 'environment',
      command: (text) => ({ op: 'addEnvironment', name: text }), selector: (selection) => `deployment ${selection.environmentId}` },
  ];

  /**
   * Fills `region` with the toolbar. `context` is the mount's part context: `state`, `dom`, `ids`, `host`,
   * `announce`, `escape`, `options.profile`, `magnification`, `fullScreen`, `help`, `canvas` (`svgText()`), and
   * `actions` (or null). The palette appears when `actions.activatePaletteTile(tile, { source, event })` exists (a
   * press on a tile calls `actions.startPaletteDrag(tile, event)` when that exists), and Add relationship when
   * `actions.startAddRelationship({ source, event })` exists. Returns `{ openAddMenu(placement), destroy }`.
   */
  function createToolbar(region, context) {
    // One menu instance for the toolbar's menu buttons (Add, More) and key A's Add menu (c4-editor-dom.js).
    const menuContext = Object.assign({}, context, {
      menus: context.dom.createMenus(region.closest('.c4-editor') || region,
        { ids: context.ids, announce: context.announce, name: 'toolbar-menu' }),
    });
    const note = createReasonNote(menuContext);
    const addControls = createAddControls(menuContext, note.element.id);
    const sections = [
      createViewSwitcher(menuContext),
      createInterfaceControls(menuContext),
      createBreadcrumbs(menuContext),
      addControls,
      createHistory(menuContext),
      createMagnification(menuContext),
      createLayoutAndFileCommands(menuContext, note.element.id),
      createWindowControls(menuContext),
      note,
    ].filter(Boolean);
    region.append(...sections.map((section) => section.element));

    function refresh() {
      const snapshot = takeSnapshot(context.state);
      sections.forEach((section) => section.update && section.update(snapshot));
    }
    // The selection decides which element the Interfaces button opens.
    const stops = ['text', 'view', 'mode', 'selection'].map((event) => context.state.on(event, refresh));
    refresh();

    return {
      /**
       * Key A (spec §9.2): opens the Add menu of the current view's tiles at `placement` (`anchor`, `returnFocus`),
       * at every width. Returns false when the view offers nothing to add.
       */
      openAddMenu(placement) {
        if (addControls === null || !addControls.openMenu(placement)) {
          context.announce('Nothing can be added in this view.');
          return false;
        }
        return true;
      },
      destroy() {
        stops.forEach((stop) => stop());
        sections.forEach((section) => section.destroy && section.destroy());
        menuContext.menus.dispose();
        region.replaceChildren();
      },
    };
  }

  /** What every section draws from: the design, the open view, its view model (null when it cannot be shown), the mode. */
  function takeSnapshot(state) {
    const design = state.getDesign();
    const selector = state.getView();
    const viewModel = selector === null ? null : C4.project(design, selector);
    return {
      design,
      selector,
      views: C4.listViews(design),
      viewModel: viewModel && viewModel.type !== null ? viewModel : null,
      mode: state.getMode(),
    };
  }

  // ---- View switcher (level toggle group and scope list) ---------------------------------------------

  function createViewSwitcher(context) {
    const { dom, ids, state } = context;
    const labelId = ids('view-label');
    const levels = dom.el('div', { role: 'group', class: 'c4-editor__levels', 'aria-labelledby': labelId });
    const scope = dom.el('select', { id: ids('scope'), class: 'c4-editor__select' });
    const newSections = NEW_SECTIONS.map((spec) => createNewSectionButton(context, spec));
    const element = dom.el('div', { class: 'c4-editor__group c4-editor__group--view' }, [
      dom.el('span', { id: labelId, class: 'c4-editor__group-label', text: 'View' }),
      levels,
      ...newSections.map((section) => section.element),
      dom.el('label', { for: scope.id, class: 'c4-editor__group-label', text: 'Scope' }),
      scope,
    ]);
    let snapshot = null;
    scope.addEventListener('change', () => state.openView(scope.value));

    function update(next) {
      snapshot = next;
      const current = currentType(next);
      const available = LEVELS.filter((level) => next.views.some((view) => view.type === level.type));
      element.hidden = available.length === 0;
      replaceKeepingFocus(levels, available.map((level) => dom.el('button', {
        type: 'button',
        class: 'c4-editor__button c4-editor__level',
        'aria-pressed': String(level.type === current),
        'data-c4-key': `level:${level.type}`,
        on: { click: () => openLevel(level.type) },
      }, level.label)));
      newSections.forEach((section) => section.update(next));
      fillScope(next, current);
    }

    function openLevel(type) {
      const target = viewForLevel(snapshot, type, state.getSelection());
      if (target !== null) state.openView(target.selector);
    }

    function fillScope(next, type) {
      const views = next.views.filter((view) => view.type === type);
      const options = views.map((view) => dom.el('option', { value: view.selector, text: scopeName(next.design.model, view) }));
      // A view outside the catalog (an annotated selector, for one) is still named in the list while it is open.
      if (next.viewModel && !views.some((view) => view.selector === next.selector)) {
        options.push(dom.el('option', { value: next.selector, text: next.viewModel.title }));
      }
      scope.replaceChildren(...options);
      scope.value = next.selector;
    }

    return { element, update };
  }

  /**
   * "New scenario…" or "New environment…" (`spec`, one of NEW_SECTIONS), shown while the model has none and the editor
   * edits: a dialog asks for the title or name, the section is added as one change, and its view opens. Escape or
   * Cancel adds nothing; a refused title is said in the message region.
   */
  function createNewSectionButton({ dom, ids, state, announce }, spec) {
    const element = dom.el('button', {
      type: 'button', class: 'c4-editor__button', 'data-c4-key': `new-${spec.id}`, on: { click: () => ask(element) },
    }, spec.label);

    function ask(trigger) {
      const fieldId = ids(`new-${spec.id}-field`);
      const field = dom.el('input', { id: fieldId, type: 'text', class: 'c4-editor__input', autocomplete: 'off' });
      const body = dom.el('div', { class: 'c4-editor__field' }, [dom.el('label', { for: fieldId, class: 'c4-editor__field-label', text: spec.field }), field]);
      const root = trigger.closest('.c4-editor') || trigger.parentElement;
      dom.openDialog(root, {
        ids, title: spec.title, body, returnFocus: trigger, initialFocus: field,
        actions: [{ label: 'Cancel', value: false }, { label: 'Add', value: true, isDefault: true }],
      }).then((confirmed) => {
        if (confirmed) add(field.value.trim());
      });
    }

    function add(text) {
      const result = state.dispatch(spec.command(text), { label: `Add ${spec.noun} ${text}` });
      if (!result.ok) {
        announce(state.refusalText(result), { kind: 'refusal' });
        return;
      }
      announce(`Added the ${spec.noun} ${text}.`, { kind: 'result' });
      state.openView(spec.selector(result.selection));
    }

    return {
      element,
      update(snapshot) {
        const model = snapshot.design.model;
        element.hidden = snapshot.mode.readOnly || model === null || model[spec.section].size > 0;
      },
    };
  }

  function currentType(snapshot) {
    const listed = snapshot.views.find((view) => view.selector === snapshot.selector);
    if (listed) return listed.type;
    return snapshot.viewModel ? snapshot.viewModel.type : null;
  }

  /**
   * The view a level button opens: the one on the current breadcrumb trail (going up), else the selected element's
   * own view of that level, else the first one inside the current scope (going down), else the level's first view.
   */
  function viewForLevel(snapshot, type, selection) {
    const candidates = snapshot.views.filter((view) => view.type === type);
    const viewModel = snapshot.viewModel;
    const trail = viewModel ? viewModel.breadcrumbs.map((crumb) => crumb.selector) : [];
    const scopeId = viewModel ? viewModel.scopeId : null;
    const selectedId = selection ? selection.elementId : undefined;
    const model = snapshot.design.model;
    return candidates.find((view) => trail.includes(view.selector))
      || candidates.find((view) => selectedId !== undefined && view.scopeId === selectedId)
      || candidates.find((view) => scopeId !== null && view.scopeId !== null && isInside(model, view.scopeId, scopeId))
      || candidates[0]
      || null;
  }

  function isInside(model, id, ancestorId) {
    for (let element = model.elements.get(id); element && element.parentId !== null; element = model.elements.get(element.parentId)) {
      if (element.parentId === ancestorId) return true;
    }
    return false;
  }

  /** The name the scope list shows for a view: its element, scenario, or environment, or the view's own title. */
  function scopeName(model, view) {
    if (ELEMENT_SCOPED_VIEWS.has(view.type)) return model.elements.get(view.scopeId).name;
    if (view.type === 'dynamic') return model.scenarios.get(view.scopeId).title || view.scopeId;
    if (view.type === 'deployment') return model.environments.get(view.scopeId).name || view.scopeId;
    if (view.type === 'landscape') return 'All people and systems';
    return view.title;
  }

  // ---- Interface views (spec §9.1 Toolbar, J14) -------------------------------------------------------------

  /**
   * The Interfaces button, which opens `interfaces of` the selected system, container, or component (else the open
   * view's own element), and the Show interfaces toggle (`aria-pressed`), which adds or removes the `with interfaces`
   * suffix of the open view where that view can carry it (C4-notation and dynamic views). Both are shown in the
   * expert profile and in any model with interfaces (Ruling 28). The buttons are made once and updated in place, so
   * focus stays on them across the redraw a press causes.
   */
  function createInterfaceControls({ dom, ids, state, announce, options }) {
    const reason = dom.el('span', { id: ids('interfaces-reason'), class: 'c4-editor__sr-only',
      text: 'Select a software system, container, or component to see its interfaces.' });
    let snapshot = null;
    const open = dom.el('button', {
      type: 'button', class: 'c4-editor__button',
      on: { click: (event) => (isDisabled(event.currentTarget) ? announce(reason.textContent) : openInterfaces()) },
    }, 'Interfaces');
    const toggle = dom.el('button', {
      type: 'button', class: 'c4-editor__button', 'aria-pressed': 'false', on: { click: toggleAnnotation },
    }, 'Show interfaces');
    const element = dom.el('div', { role: 'group', class: 'c4-editor__group c4-editor__group--interfaces', 'aria-label': 'Interfaces' },
      [open, toggle, reason]);

    function openInterfaces() {
      const target = interfacesTarget(snapshot, state.getSelection());
      if (target !== null) state.openView(`interfaces of ${target.id}`);
    }

    function toggleAnnotation() {
      const showing = !isAnnotated(snapshot.viewModel);
      const selector = withAnnotation(snapshot.selector, showing);
      const result = state.openView(selector);
      if (!result.ok) return;
      const brief = C4.describe(C4.project(state.getDesign(), result.selector)).brief;
      announce(`${showing ? 'Showing' : 'Hiding'} interfaces. ${brief}`);
    }

    function update(next) {
      snapshot = next;
      const model = next.design.model;
      element.hidden = model === null || !(options.profile === 'expert' || model.interfaces.size > 0);
      if (element.hidden) return;
      setDisabled(open, interfacesTarget(next, state.getSelection()) === null, reason.id);
      const annotated = isAnnotated(next.viewModel);
      toggle.hidden = !canToggleAnnotation(next, annotated);
      toggle.setAttribute('aria-pressed', String(annotated));
    }

    return { element, update };
  }

  /** The element whose interfaces view the Interfaces button opens: the selected one, else the open view's own. */
  function interfacesTarget(snapshot, selection) {
    const model = snapshot.design.model;
    if (model === null) return null;
    const candidates = [selection && selection.elementId, snapshot.viewModel && snapshot.viewModel.scopeId];
    for (const id of candidates) {
      const element = id ? model.elements.get(id) : null;
      if (element && INTERFACE_SCOPES.has(element.type)) return element;
    }
    return null;
  }

  function isAnnotated(viewModel) {
    return Boolean(viewModel && (viewModel.annotations || []).includes(INTERFACES_ANNOTATION));
  }

  /** Whether the open view can show and hide interfaces: the toggled selector is a view whose annotation differs. */
  function canToggleAnnotation(snapshot, annotated) {
    if (!snapshot.viewModel) return false;
    const toggled = C4.project(snapshot.design, withAnnotation(snapshot.selector, !annotated));
    return toggled.type !== null && isAnnotated(toggled) !== annotated;
  }

  /**
   * `selector` (canonical, spec §5.1: `base [with a, b]`) with the interfaces annotation added (`on`) or removed; the
   * annotations stay sorted, as in the canonical form. Ids contain no spaces, so " with " only ever starts the suffix.
   */
  function withAnnotation(selector, on) {
    const [base, suffix] = selector.split(' with ');
    const annotations = (suffix ? suffix.split(', ') : []).filter((annotation) => annotation !== INTERFACES_ANNOTATION);
    if (on) annotations.push(INTERFACES_ANNOTATION);
    annotations.sort();
    return annotations.length > 0 ? `${base} with ${annotations.join(', ')}` : base;
  }

  // ---- Breadcrumbs --------------------------------------------------------------------------------------

  /**
   * The trail of the open view as links, from the context view down (ED-10: the editor's trail, `state.breadcrumbs`);
   * the current view is the last, marked aria-current="page".
   */
  function createBreadcrumbs({ dom, ids, state }) {
    const list = dom.el('ol', { class: 'c4-editor__crumbs' });
    const element = dom.el('nav', { class: 'c4-editor__breadcrumbs', 'aria-label': 'Breadcrumbs' }, list);

    function update(snapshot) {
      const crumbs = state.breadcrumbs(snapshot.viewModel);
      element.hidden = crumbs.length === 0;
      // Focus stays on the crumb just followed: it becomes the current one, with the same key.
      replaceKeepingFocus(list, crumbs.map((crumb, index) => dom.el('li', {}, dom.el('a', {
        href: `#${ids('canvas')}`,
        class: 'c4-editor__crumb',
        'aria-current': index === crumbs.length - 1 ? 'page' : null,
        'data-c4-key': `crumb:${crumb.selector}`,
        on: {
          click(event) {
            event.preventDefault();
            state.openView(crumb.selector);
          },
        },
      }, crumb.label))));
    }

    return { element, update };
  }

  // ---- Palette and Add relationship (Ruling 3) ---------------------------------------------------------

  function createAddControls(context, reasonId) {
    const { dom, actions } = context;
    const palette = actions && typeof actions.activatePaletteTile === 'function' ? createPalette(context, reasonId) : null;
    const moreTools = palette ? createUnavailableTools(context) : null;
    const connect = actions && typeof actions.startAddRelationship === 'function'
      ? dom.el('button', {
        type: 'button',
        class: 'c4-editor__button',
        'aria-keyshortcuts': 'C',
        on: { click: (event) => isDisabled(event.currentTarget) || actions.startAddRelationship({ source: 'toolbar', event }) },
      }, 'Add relationship')
      : null;
    if (palette === null && connect === null) return null;
    return {
      element: dom.el('div', { class: 'c4-editor__group c4-editor__group--add' }, [palette && palette.elements, moreTools && moreTools.element, connect]),
      update(snapshot) {
        if (palette) palette.update(snapshot);
        if (moreTools) moreTools.update(palette.unavailable());
        if (connect) setDisabled(connect, snapshot.mode.readOnly, reasonId);
      },
      openMenu: (placement) => palette !== null && palette.openMenu(placement),
    };
  }

  /**
   * The level-aware tiles, plus the Add menu that replaces them at narrow widths (and that key A opens at every
   * width). A tile is used through the actions' hooks (Ruling 3): `activatePaletteTile(tile, { source, event })` when
   * it is chosen, source 'tile' (a click or key) or 'menu' (the Add menu); `startPaletteDrag(tile, event)` when a
   * primary press may begin a drag to the canvas. A press alone never adds anything (WCAG 2.5.2).
   */
  function createPalette(context, reasonId) {
    const { dom, actions, options } = context;
    const group = dom.el('div', { role: 'group', class: 'c4-editor__palette', 'aria-label': 'Add to the diagram' });
    let tiles = [];
    // The tools of the open UML-notation view that this design model cannot record (spec §5.6), else none.
    let unavailable = [];
    let readOnly = false;
    let readOnlyReason = null;
    let showAllTypes = false;
    let snapshot = null;

    const allTypes = options.profile === 'expert'
      ? dom.el('button', {
        type: 'button',
        class: 'c4-editor__button c4-editor__all-types',
        'aria-pressed': 'false',
        on: { click: toggleAllTypes },
      }, 'All types')
      : null;
    const menuItems = () => tiles.map((tile) => ({ label: tile.label, disabled: readOnly, run: () => use(tile, 'menu', null) }))
      .concat(unavailable.map((tool) => ({ label: tool.label, note: tool.summary, unavailable: tool.message, run() {} })));
    const addMenu = createMenuButton(context, { name: 'add-menu', label: 'Add', className: 'c4-editor__add-menu', items: menuItems,
      reason: () => readOnlyReason });

    function use(tile, source, event) {
      if (!readOnly) actions.activatePaletteTile(tile, { source, event });
    }

    function press(tile, event) {
      if (readOnly || !event.isPrimary || event.button !== 0 || typeof actions.startPaletteDrag !== 'function') return;
      actions.startPaletteDrag(tile, event);
    }

    function tileButton(tile) {
      const button = dom.el('button', {
        type: 'button',
        class: 'c4-editor__button c4-editor__tile',
        'data-c4-key': `tile:${tile.id}`,
        on: {
          click: (event) => use(tile, 'tile', event),
          pointerdown: (event) => press(tile, event),
        },
      }, tile.label);
      setDisabled(button, readOnly, reasonId);
      return button;
    }

    function toggleAllTypes() {
      showAllTypes = !showAllTypes;
      allTypes.setAttribute('aria-pressed', String(showAllTypes));
      update(snapshot);
    }

    function update(next) {
      snapshot = next;
      readOnly = next.mode.readOnly;
      readOnlyReason = readOnly ? READ_ONLY_REASONS[next.mode.reason] : null;
      const umlTools = umlPaletteOf(actions, next.viewModel);
      tiles = umlTools ? umlTiles(umlTools, next.viewModel) : tilesFor(next.viewModel, showAllTypes);
      unavailable = umlTools ? umlTools.unavailable : [];
      replaceKeepingFocus(group, tiles.map(tileButton));
      group.hidden = tiles.length === 0;
      addMenu.element.hidden = tiles.length === 0;
      if (allTypes) allTypes.hidden = Boolean(umlTools) || !next.viewModel || !ELEMENT_TILES.includes((TILES_BY_VIEW[next.viewModel.type] || [])[0]);
    }

    /** The Add menu at `placement` (key A, at every width); false when the view has no tiles. */
    function openMenu(placement) {
      if (tiles.length === 0) return false;
      context.menus.open({ label: 'Add', groups: [{ label: null, items: menuEntries(menuItems(), () => readOnlyReason) }], placement });
      return true;
    }

    return { elements: [group, allTypes, addMenu.element], update, openMenu, unavailable: () => (readOnly ? [] : unavailable) };
  }

  /**
   * The palette of the open UML-notation view that the canvas edits (`actions.umlEditing().palette()`: `{ elements,
   * relations, unavailable }`), or null on any other view.
   */
  function umlPaletteOf(actions, viewModel) {
    if (!viewModel || viewModel.notation === 'c4' || typeof actions.umlEditing !== 'function') return null;
    const editing = actions.umlEditing();
    return editing ? editing.palette() : null;
  }

  /**
   * The tiles of a UML view's tools (spec §7.4, §7.6): each names its tool (`tile.tool`), which the view's editing part
   * uses. The element tools come first, each with its `operators` when it has a choice of them (a fragment's); then
   * the line tools that are not also element tools, marked `line` (they draw between two boxes, so they are not dragged
   * onto the drawing: "click the tool, then the source, then the target").
   */
  function umlTiles(tools, viewModel) {
    const tile = (tool, line) => Object.assign({
      id: `uml:${tool.id}`, kind: 'uml-tool', tool: tool.id, label: tool.label, view: viewModel.selector, scopeId: viewModel.scopeId, native: true,
    }, Array.isArray(tool.operators) ? { operators: tool.operators.slice() } : {}, line ? { line: true } : {});
    const elementIds = new Set(tools.elements.map((tool) => tool.id));
    return tools.elements.map((tool) => tile(tool, false))
      .concat((tools.relations || []).filter((tool) => !elementIds.has(tool.id)).map((tool) => tile(tool, true)));
  }

  /**
   * The disclosure "More UML tools (not available here)" after the palette (spec §5.6): a button that shows and hides
   * the notation's other tools, each an aria-disabled button with its short reason on one line ("Composition: not
   * recorded in this design model"); activating one changes nothing and says its sentence in the message region.
   * Hidden when the open view has no such tools. Returns `{ element, update(tools) }`.
   */
  function createUnavailableTools({ dom, ids, announce }) {
    const listId = ids('more-uml-tools');
    const list = dom.el('ul', { id: listId, class: 'c4-editor__more-tools-list', hidden: true });
    const toggle = dom.el('button', {
      type: 'button', class: 'c4-editor__button c4-editor__more-tools-toggle', 'aria-expanded': 'false', 'aria-controls': listId,
      'data-c4-key': 'more-uml-tools', on: { click: () => setOpen(toggle.getAttribute('aria-expanded') !== 'true') },
    }, MORE_UML_TOOLS);
    const element = dom.el('div', { class: 'c4-editor__more-tools', hidden: true }, [toggle, list]);

    function setOpen(open) {
      toggle.setAttribute('aria-expanded', String(open));
      list.hidden = !open;
    }

    function item(tool) {
      const reason = tool.summary ? `: ${tool.summary.charAt(0).toLowerCase()}${tool.summary.slice(1)}` : '';
      return dom.el('li', {}, dom.el('button', {
        type: 'button', class: 'c4-editor__button', 'aria-disabled': 'true', 'data-c4-key': `unavailable:${tool.id}`,
        on: { click: () => announce(tool.message, { kind: 'refusal' }) },
      }, `${tool.label}${reason}`));
    }

    return {
      element,
      update(tools) {
        element.hidden = tools.length === 0;
        if (tools.length === 0) setOpen(false);
        replaceKeepingFocus(list, tools.map(item));
      },
    };
  }

  /** The tiles for a view: its own types, then (with "All types") every other element type. Each says where it adds. */
  function tilesFor(viewModel, showAllTypes) {
    if (!viewModel) return [];
    const own = TILES_BY_VIEW[viewModel.type] || [];
    const addsElements = own.length > 0 && ELEMENT_TILES.includes(own[0]);
    const others = showAllTypes && addsElements ? ELEMENT_TILES.filter((id) => !own.includes(id)) : [];
    const tile = (id, native) => Object.assign({ id, view: viewModel.selector, scopeId: viewModel.scopeId, native }, TILES[id]);
    return own.map((id) => tile(id, true)).concat(others.map((id) => tile(id, false)));
  }

  // ---- History ------------------------------------------------------------------------------------------

  /**
   * Undo and Redo, made easy to find (ED-11), as in the site's UML editor: a glyph (hidden from assistive technology)
   * before the word, a tooltip that is also the accessible description, naming the step the button would take back or
   * repeat and its keys, and `aria-keyshortcuts` with exactly the keys the mount routes (listenForCanvasKeys).
   */
  function createHistory({ dom, state }) {
    const buttons = HISTORY_COMMANDS.map((command) => {
      const button = dom.el('button', {
        type: 'button',
        class: 'c4-editor__button c4-editor__history-button',
        'aria-keyshortcuts': command.keyshortcuts,
        on: { click: (event) => isDisabled(event.currentTarget) || state[command.run]() },
      }, [dom.el('span', { class: 'c4-editor__history-glyph', 'aria-hidden': 'true', text: command.glyph }), command.label]);
      return { command, button };
    });
    return {
      element: dom.el('div', { role: 'group', class: 'c4-editor__group c4-editor__group--history', 'aria-label': 'History' },
        buttons.map(({ button }) => button)),
      update() {
        buttons.forEach(({ command, button }) => {
          const available = state[command.can]();
          setDisabled(button, !available);
          button.title = historyDescription(command, available ? state[command.stepLabel]() : null, available);
        });
      },
    };
  }

  /** "Undo: Rename Student. Ctrl+Z (Cmd+Z on a Mac)"; "Nothing to undo. …" when there is no step. */
  function historyDescription(command, stepLabel, available) {
    const what = !available ? command.nothing : stepLabel ? `${command.label}: ${stepLabel}.` : command.unnamed;
    return `${what} ${command.keys}`;
  }

  // ---- Magnification ------------------------------------------------------------------------------------

  function createMagnification({ dom, magnification }) {
    const readout = dom.el('output', { class: 'c4-editor__zoom-readout' }, percent(magnification.level()));
    const symbolButton = (symbol, name, run) => dom.el('button', {
      type: 'button',
      class: 'c4-editor__button c4-editor__zoom-button',
      on: { click: (event) => isDisabled(event.currentTarget) || run() },
    }, [dom.el('span', { 'aria-hidden': 'true', text: symbol }), dom.el('span', { class: 'c4-editor__sr-only', text: name })]);
    const zoomOut = symbolButton('−', 'Zoom out', magnification.zoomOut);
    const zoomIn = symbolButton('+', 'Zoom in', magnification.zoomIn);
    const reset = dom.el('button', { type: 'button', class: 'c4-editor__button', on: { click: magnification.reset } }, 'Reset zoom');
    const fit = dom.el('button', { type: 'button', class: 'c4-editor__button', on: { click: magnification.fit } }, 'Fit');

    function show(level) {
      readout.textContent = percent(level);
      setDisabled(zoomOut, !magnification.canZoomOut());
      setDisabled(zoomIn, !magnification.canZoomIn());
    }
    const stop = magnification.onChange(show);
    show(magnification.level());

    return {
      element: dom.el('div', { role: 'group', class: 'c4-editor__group', 'aria-label': 'Magnification' }, [zoomOut, readout, zoomIn, reset, fit]),
      destroy: stop,
    };
  }

  function percent(level) {
    return `${Math.round(level * 100)}%`;
  }

  // ---- Reset layout, file actions, and the More menu -----------------------------------------------------

  /**
   * Reset layout and the host's file actions (spec §3.4, §9.1), each a button at wide widths and an item of the More
   * menu at narrow ones. A file action appears only when the host offers it.
   */
  function createLayoutAndFileCommands(context, reasonId) {
    const { dom } = context;
    const commands = layoutAndFileCommands(context, reasonId);
    let snapshot = null;
    const buttons = new Map(commands.map((command) => [command, dom.el('button', {
      type: 'button',
      class: 'c4-editor__button',
      on: { click: (event) => isDisabled(event.currentTarget) || command.run(takeSnapshot(context.state)) },
    }, command.label)]));
    const more = createMenuButton(context, {
      name: 'more',
      label: 'More',
      className: 'c4-editor__more',
      items: () => commands.filter((command) => command.isAvailable(snapshot)).map((command) => ({
        label: command.label,
        disabled: command.isDisabled(snapshot),
        run: () => command.run(takeSnapshot(context.state)),
      })),
      // Only Reset layout is disabled outside the read-only mode: nothing in the view is pinned.
      reason: () => (snapshot && snapshot.mode.readOnly ? READ_ONLY_REASONS[snapshot.mode.reason]
        : 'No element in this view has a pinned position, so the layout is already automatic.'),
    });
    const group = (name, members) => dom.el('div', {
      role: 'group', class: 'c4-editor__group c4-editor__overflow', 'aria-label': name,
    }, members.map((command) => buttons.get(command)));
    const layoutCommands = commands.filter((command) => command.group === 'layout');
    const fileCommands = commands.filter((command) => command.group === 'file');

    return {
      element: dom.el('div', { class: 'c4-editor__group c4-editor__group--commands' }, [
        group('Layout', layoutCommands),
        fileCommands.length > 0 ? group('File', fileCommands) : null,
        more.element,
      ]),
      update(next) {
        snapshot = next;
        buttons.forEach((button, command) => {
          button.hidden = !command.isAvailable(next);
          setDisabled(button, command.isDisabled(next), reasonId, next.mode.readOnly);
        });
      },
    };
  }

  function layoutAndFileCommands({ state, host, announce, canvas, actions }) {
    const view = (snapshot) => snapshot.viewModel;
    // The editing part of the open UML-notation view, when the canvas edits it (UML-view editing spec §6 rule 3).
    const umlEdited = (snapshot) => Boolean(view(snapshot) && view(snapshot).notation !== 'c4' && actions
      && typeof actions.umlEditing === 'function' && actions.umlEditing());
    const callHost = (method, args, done) => new Promise((resolve) => resolve(host[method](...args)))
      .then(done)
      .catch((error) => announce(`That did not work: ${error && error.message ? error.message : error}`));
    const commands = [
      {
        group: 'layout',
        label: 'Reset layout',
        isAvailable: (snapshot) => view(snapshot) !== null && (view(snapshot).notation === 'c4' || umlEdited(snapshot)),
        isDisabled: (snapshot) => snapshot.mode.readOnly || view(snapshot) === null
          || (view(snapshot).notation === 'c4' ? pinnedInView(snapshot).length === 0 : !keepsUmlLayout(view(snapshot))),
        run(snapshot) {
          if (view(snapshot).notation !== 'c4') {
            if (umlEdited(snapshot)) actions.resetUmlLayout();
            return;
          }
          const pinned = pinnedInView(snapshot);
          const commandsToRun = pinned.map((elementId) => ({ op: 'unpinPosition', viewKey: snapshot.viewModel.key, elementId }));
          const result = state.dispatch({ op: 'batch', commands: commandsToRun }, { label: 'Reset layout' });
          announce(result.ok ? `Layout reset: ${countOf(pinned.length, 'element')} back to automatic positions` : result.message);
        },
      },
      {
        group: 'file',
        label: 'Open…',
        method: 'openFile',
        isAvailable: () => true,
        isDisabled: (snapshot) => snapshot.mode.reason === 'read-only',
        run: () => callHost('openFile', [], (file) => {
          if (!file) return;
          const name = file.name || 'the file';
          if (state.applySourceText(String(file.text), { label: `Open ${name}` })) announce(`Opened ${name}`);
        }),
      },
      {
        group: 'file',
        label: 'Download YAML',
        method: 'saveFile',
        isAvailable: () => true,
        isDisabled: () => false,
        run: (snapshot) => callHost('saveFile', [state.getText(), { format: 'yaml', view: snapshot.selector }]),
      },
      {
        group: 'file',
        label: 'Download SVG',
        method: 'exportSvg',
        // An interface card is text, not a drawing: Copy description takes this place (spec §9.1).
        isAvailable: (snapshot) => view(snapshot) !== null && !isCard(view(snapshot)),
        isDisabled: () => false,
        run(snapshot) {
          const svgText = canvas.svgText();
          if (svgText === null) {
            announce('This view has no drawing to download.');
            return;
          }
          callHost('exportSvg', [svgText, { format: 'svg', view: snapshot.selector, title: snapshot.viewModel.title }]);
        },
      },
      {
        group: 'file',
        label: 'Copy description',
        method: 'copyText',
        isAvailable: (snapshot) => view(snapshot) !== null && isCard(view(snapshot)),
        isDisabled: () => false,
        run(snapshot) {
          const name = snapshot.viewModel.card.name;
          const markdown = editorParts().interfaces.cardMarkdown(C4.describe(snapshot.viewModel), { title: snapshot.viewModel.title });
          callHost('copyText', [markdown, { format: 'markdown', view: snapshot.selector }],
            () => announce(`Copied the description of ${name}.`));
        },
      },
      {
        group: 'file',
        label: 'Copy ArchUML source',
        method: 'copyText',
        isAvailable: (snapshot) => view(snapshot) !== null && view(snapshot).notation !== 'c4' && !isCard(view(snapshot)),
        isDisabled: () => false,
        run: (snapshot) => callHost('copyText', [C4.toUml(snapshot.viewModel).text, { format: 'archuml', view: snapshot.selector }],
          () => announce('Copied the ArchUML source.')),
      },
    ];
    return commands.filter((command) => !command.method || typeof host[command.method] === 'function');
  }

  function isCard(viewModel) {
    return viewModel.notation === 'interface-card';
  }

  /**
   * The ids of the elements of the open C4-notation view that have a pinned position in it. A UML-notation view keeps
   * no pin map: its layout entry has named parts (UML-view editing spec §4.2), so it has no pinned elements here.
   */
  function pinnedInView(snapshot) {
    if (!snapshot.viewModel || snapshot.viewModel.notation !== 'c4' || snapshot.design.model === null) return [];
    const pins = snapshot.design.model.layout.get(snapshot.viewModel.key);
    if (!pins) return [];
    const shown = new Set(snapshot.viewModel.nodes.map((node) => node.id));
    return [...pins.keys()].filter((id) => shown.has(id));
  }

  /** Whether a UML-notation view keeps a layout: positions, bends, or a lifeline order (UML-view editing spec §4.2). */
  function keepsUmlLayout(viewModel) {
    const layout = viewModel.layout;
    return Boolean(layout && (layout.positions.size > 0 || layout.routes.length > 0 || (layout.lifelines || []).length > 0));
  }

  function countOf(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }

  // ---- Full screen and Help ------------------------------------------------------------------------------

  function createWindowControls({ dom, fullScreen, help }) {
    const fullScreenButton = dom.el('button', {
      type: 'button', class: 'c4-editor__button', 'aria-pressed': String(fullScreen.isActive()), 'aria-keyshortcuts': 'F',
      on: { click: fullScreen.toggle },
    }, 'Full screen');
    const helpButton = dom.el('button', {
      type: 'button', class: 'c4-editor__button', 'aria-keyshortcuts': 'Shift+?', on: { click: help.show },
    }, 'Help');
    const stop = fullScreen.onChange((active) => fullScreenButton.setAttribute('aria-pressed', String(active)));
    return {
      element: dom.el('div', { class: 'c4-editor__group' }, [fullScreenButton, helpButton]),
      destroy: stop,
    };
  }

  // ---- The reason visual editing is unavailable ----------------------------------------------------------

  /**
   * A visible sentence that controls disabled by the read-only mode reference through aria-describedby. It appears
   * without moving focus, so a change of mode after mount is also announced (WCAG 4.1.3): the reason when visual
   * editing pauses, and EDITING_RESUMED when it returns. The mode the editor opens in is not announced.
   */
  function createReasonNote({ dom, ids, announce }) {
    const element = dom.el('p', { id: ids('toolbar-reason'), class: 'c4-editor__toolbar-note', hidden: true });
    let shownReason;
    return {
      element,
      update(snapshot) {
        const reason = snapshot.mode.readOnly ? READ_ONLY_REASONS[snapshot.mode.reason] : null;
        if (reason === shownReason) return;
        const opened = shownReason === undefined;
        shownReason = reason;
        element.textContent = reason || '';
        element.hidden = !reason;
        if (!opened) announce(reason || EDITING_RESUMED);
      },
    };
  }

  // ---- Menu button (APG menu button pattern) -------------------------------------------------------------

  /**
   * A button that opens a menu of `items()` (each `{ label, disabled, run(event) }`), built when the menu opens so it
   * always reflects the current state, through the editor's one menu helper (`context.menus`, c4-editor-dom.js): it
   * opens below the button; arrow keys, Home, End, and a letter move through it; Escape, Tab, and choosing an item
   * close it and return focus to the button; a press outside closes it. ArrowDown or ArrowUp on the button opens it
   * on the first or last item. A disabled item explains itself with `reason()` when chosen. Returns `{ element }`.
   */
  function createMenuButton({ dom, ids, menus }, { name, label, className, items, reason = () => null }) {
    const button = dom.el('button', {
      type: 'button', id: ids(`${name}-button`), class: 'c4-editor__button c4-editor__menu-button',
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
    }, label);
    const element = dom.el('div', { class: `c4-editor__menu-wrap ${className}` }, button);
    let open = false;

    function show(focusLast) {
      const entries = items();
      if (entries.length === 0) return;
      menus.open({
        label,
        groups: [{ label: null, items: menuEntries(entries, reason) }],
        placement: { anchor: button, returnFocus: button },
        focusLast,
        onClose() {
          open = false;
          button.setAttribute('aria-expanded', 'false');
        },
      });
      open = true;
      button.setAttribute('aria-expanded', 'true');
    }

    button.addEventListener('click', () => (open ? menus.close() : show(false)));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      show(event.key === 'ArrowUp');
    });

    return { element };
  }

  /**
   * Toolbar entries `{ label, disabled, run }` as items of the menu helper; a disabled one gives `reason()`. An entry
   * with its own `unavailable` sentence (and its short reason as `note`) is listed disabled with them.
   */
  function menuEntries(entries, reason) {
    return entries.map((entry) => ({
      label: entry.label,
      note: entry.note || null,
      unavailable: entry.unavailable || (entry.disabled ? reason() || 'This is not available right now.' : null),
      run: entry.run,
    }));
  }

  // ---- Helpers -------------------------------------------------------------------------------------------

  /**
   * Replaces the children of `container` with `nodes` and, when focus was on a child with a `data-c4-key`, moves it to
   * the new child with the same key, so a redraw never drops keyboard focus.
   */
  function replaceKeepingFocus(container, nodes) {
    const active = container.ownerDocument.activeElement;
    const key = active && container.contains(active) ? active.getAttribute('data-c4-key') : null;
    container.replaceChildren(...nodes);
    if (key === null) return;
    const match = [...container.querySelectorAll('[data-c4-key]')].find((node) => node.getAttribute('data-c4-key') === key);
    if (match) match.focus();
  }

  /**
   * Marks a control unavailable with aria-disabled, which keeps it focusable (a disabled button that has focus would
   * drop it). When `reasonId` is given, the control is described by that reason exactly while `showReason` holds
   * (by default, while it is disabled).
   */
  function setDisabled(control, disabled, reasonId = null, showReason = disabled) {
    control.setAttribute('aria-disabled', String(disabled));
    if (reasonId === null) return;
    const others = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== reasonId);
    const describedBy = disabled && showReason ? others.concat(reasonId) : others;
    if (describedBy.length > 0) control.setAttribute('aria-describedby', describedBy.join(' '));
    else control.removeAttribute('aria-describedby');
  }

  function isDisabled(control) {
    return control.getAttribute('aria-disabled') === 'true';
  }

  return { createToolbar: createToolbar };
});
