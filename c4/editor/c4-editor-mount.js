(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(globalThis);
  } else {
    root.ArchUMLC4Editor = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  // The editor shell (spec §3.4, §9.1, §9.2, §9.4). `mount` builds the regions in their fixed DOM order (toolbar →
  // outline → canvas → inspector → panels), owns the editor-wide services every part shares (instance ids, the live
  // region and the visible message region, the Escape stack, magnification, full screen, help, the canvas keys), and
  // fills each region with the part of the same name when that part is loaded. Parts are read from
  // `ArchUMLC4EditorParts` at mount time (Ruling 13), and a region whose part is absent stays hidden, so a later part
  // plugs in without changing this structure. An editable editor with the messages part puts its message region
  // directly before the canvas, in one column with it, drawn over the canvas's top edge (UML-view editing spec §7.5).
  // The parts never call each other: they share the state controller and the actions, and the mount hands each one
  // the services it needs (the command gate, the banner slot, the scaffolds' places in the canvas).

  const SIZES = ['compact', 'regular', 'tall', 'fill'];
  const OUTLINE_STATES = ['open', 'collapsed'];
  const ZOOM = Object.freeze({ min: 0.25, max: 4, step: 0.1 });
  const FULL_SCREEN_CLASS = 'c4-editor--full-screen';
  // The regions a part fills, each with the part's name on ArchUMLC4EditorParts and its factory (spec §9.1).
  const REGIONS = [
    { name: 'outline', label: 'Outline', factory: 'createOutline' },
    { name: 'inspector', label: 'Inspector', factory: 'createInspector' },
    { name: 'panels', label: 'Panels', factory: 'createPanels' },
  ];
  const TYPING_TARGETS = 'input, select, textarea, [contenteditable=""], [contenteditable="true"]';
  // A menu inside the canvas (the carry-down tray's Refine into…) owns its keys: letters there are type-ahead.
  const MENUS = '[role="menu"]';

  let mountedCount = 0;

  /**
   * Mounts an editor in `rootElement` (spec §3.4). `options`: `text`, `view`, `profile`, `scaffolds`, `checks`,
   * `lockedFields`, `reveal`, `sourceEditor`, `readOnly`, `palette`, `links`, `host` as in the host contract, plus `size`
   * ('compact' | 'regular' | 'tall' | 'fill', default 'regular'; with 'fill' the host gives the editor its height and
   * the canvas takes what the toolbar and the rows above it leave) and `outline` ('open' | 'collapsed', default 'open':
   * whether the outline region starts expanded). Throws a TypeError for an option outside the contract.
   * Returns `{ setText, getText, openView, select, getDiagnostics, submitForReview, destroy }`.
   */
  function mount(rootElement, options) {
    const parts = root.ArchUMLC4EditorParts || {};
    if (!parts.dom || !parts.state || !parts.canvas) {
      throw new Error('ArchUMLC4Editor.mount needs c4-editor-dom.js, c4-editor-state.js, and c4-editor-canvas.js loaded first');
    }
    const settings = Object.assign({ size: 'regular', outline: 'open' }, options);
    if (!SIZES.includes(settings.size)) throw new TypeError(`size must be one of ${SIZES.join(', ')}`);
    if (!OUTLINE_STATES.includes(settings.outline)) throw new TypeError(`outline must be one of ${OUTLINE_STATES.join(', ')}`);

    const dom = parts.dom;
    const state = parts.state.createEditorState({
      text: settings.text, host: settings.host, view: settings.view, profile: settings.profile,
      checks: settings.checks, readOnly: settings.readOnly, lockedFields: settings.lockedFields,
    });
    const ids = dom.idFactory(freeInstanceId(rootElement.ownerDocument));
    // The editor marks the host's element with classes only, and puts them back on destroy.
    const restoreRoot = rememberAttributes(rootElement, ['class']);
    rootElement.classList.add('c4-editor', `c4-editor--${settings.size}`);

    const layout = createLayout(rootElement, dom, ids);
    if (settings.outline === 'collapsed') layout.regions.get('outline').setExpanded(false);
    const announceLive = liveAnnouncer(rootElement, dom, settings.host);
    const messages = createMessageRegion(parts.messages, rootElement, layout, { dom, ids, announceLive, readOnly: Boolean(settings.readOnly) });
    const announce = routeAnnouncements(parts.messages, messages, announceLive);
    // Before any part listens to the state, so a message a part shows in answer to a change outlives that change.
    const stopClearingMessages = clearMessagesOnChange(state, messages);
    const stopFilling = settings.size === 'fill' ? fillHeight(rootElement, layout) : () => {};
    const escape = dom.createEscapeStack(rootElement);
    // After the Escape stack's own listener on the root, so it is the last layer of spec §9.2's Escape order.
    const selectionScopes = [layout.canvas, layout.regions.get('outline').body];
    const stopClearingSelection = listenForEscapeToClearSelection(rootElement, selectionScopes, state, announce);
    const stopAnnouncingHistory = announceHistorySteps(state, announce);
    const magnifier = createMagnifier(layout.canvas);
    const fullScreen = createFullScreen(rootElement, escape);
    // Help opens over whatever had focus and gives it back on close. It lists only the keys some part answers: the
    // canvas's and its editing part's, then the mount's own (A only with a toolbar, whose Add menu A opens). With the
    // refusal table loaded it then lists every refusal with its sentence (UML-view editing spec §5.6).
    const help = { show: () => showHelp(rootElement, dom, ids, helpKeys(context.canvas, toolbar), helpRefusals(parts.umlRefusals)) };

    let toolbar = null;
    const context = {
      state, dom, ids, announce, escape,
      host: settings.host,
      // The scaffold switches as the actions read them (the description's sentence frame).
      scaffolds: settings.scaffolds || {},
      options: {
        profile: settings.profile || 'expert', scaffolds: settings.scaffolds || {}, checks: settings.checks || {},
        lockedFields: settings.lockedFields || [], reveal: settings.reveal || 'all',
        sourceEditor: settings.sourceEditor !== false, readOnly: Boolean(settings.readOnly), links: settings.links || {},
        palette: settings.palette,
      },
      layout: { revealRegion: layout.revealRegion, onCanvasCoverChange: layout.onCanvasCoverChange },
      // Where the panels put the YAML-error banner: above the regions, so it stays in view when the panels collapse.
      bannerRegion: layout.banner,
      magnification: magnifier.api,
      fullScreen: fullScreen.api,
      help,
      actions: null,
      // The panels' command gate (visual commands `aria-disabled` with the reason while the YAML cannot be read).
      gate: null,
      canvas: null,
    };
    const { created, named } = createParts(parts, rootElement, layout, context);
    toolbar = named.toolbar;
    const stopShortcuts = listenForCanvasKeys(layout.canvas, {
      openAddMenu(event) {
        if (toolbar) toolbar.openAddMenu({ anchor: event.target, returnFocus: event.target });
      },
      zoomIn: magnifier.api.zoomIn,
      zoomOut: magnifier.api.zoomOut,
      resetZoom: magnifier.api.reset,
      toggleFullScreen: fullScreen.api.toggle,
      showHelp: help.show,
      undo: state.undo,
      redo: state.redo,
    });
    const stopHostKeys = listenForHostKeys(rootElement, settings.host);

    let destroyed = false;
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      stopShortcuts();
      stopHostKeys();
      stopClearingSelection();
      stopAnnouncingHistory();
      stopFilling();
      // The parts first: a part that ends a mode withdraws its instruction from the region as it goes.
      created.reverse().forEach((part) => part.destroy());
      stopClearingMessages();
      layout.dispose();
      if (messages) messages.destroy();
      fullScreen.dispose();
      escape.dispose();
      rootElement.replaceChildren();
      restoreRoot();
    }

    return {
      setText: (text, info) => state.setText(text, info),
      getText: state.getText,
      openView: state.openView,
      select: state.select,
      getDiagnostics: state.getDiagnostics,
      submitForReview: state.submitForReview,
      destroy,
    };
  }

  /**
   * Size 'fill' (spec §9.4): the stylesheet makes the root a size container and the canvas as tall as the root less
   * `--c4-canvas-top`, the canvas's distance from the root's top (`layout.canvasTop()`), which only the layout knows:
   * the toolbar wraps with the width, the outline row opens and closes, and the YAML-error banner comes and goes.
   * Observers keep that distance (a measured value, set through the CSSOM) current. Returns a function that stops
   * them and removes it.
   */
  function fillHeight(rootElement, layout) {
    const measure = () => rootElement.style.setProperty('--c4-canvas-top', `${layout.canvasTop()}px`);
    const win = rootElement.ownerDocument.defaultView;
    const resizing = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(measure) : null;
    const banners = new win.MutationObserver(measure);
    measure();
    if (resizing) [rootElement, layout.toolbar, layout.regions.get('outline').section].forEach((element) => resizing.observe(element));
    banners.observe(layout.banner, { childList: true });
    return () => {
      if (resizing) resizing.disconnect();
      banners.disconnect();
      rootElement.style.removeProperty('--c4-canvas-top');
    };
  }

  /** An instance id no element of `doc` uses yet, so ARIA ids never collide between editors on one page. */
  function freeInstanceId(doc) {
    let candidate;
    do {
      mountedCount += 1;
      candidate = `c4-editor-${mountedCount}`;
    } while (doc.getElementById(`${candidate}-canvas`));
    return candidate;
  }

  /** A function that puts the named attributes of `element` back as they are now (absent ones are removed). */
  function rememberAttributes(element, names) {
    const saved = names.map((name) => [name, element.getAttribute(name)]);
    return () => saved.forEach(([name, value]) => (value === null ? element.removeAttribute(name) : element.setAttribute(name, value)));
  }

  // ---- Announcements and the message region (UML-view editing spec §7.5) -------------------------------------

  /** `announceLive(text)`: one polite announcement, in the editor's live region and to `host.announce` when given. */
  function liveAnnouncer(rootElement, dom, host) {
    const announceInRegion = dom.createAnnouncer(rootElement);
    return (text) => {
      announceInRegion(text);
      if (typeof host.announce === 'function') host.announce(text);
    };
  }

  /**
   * The visible message region of an editable editor, placed directly before the canvas region and drawn over its top
   * edge; null when the editor is read-only or the messages part is not loaded (then every message goes to the live
   * region only).
   */
  function createMessageRegion(messagesPart, rootElement, layout, { dom, ids, announceLive, readOnly }) {
    if (!messagesPart || readOnly) return null;
    const region = messagesPart.createMessageRegion(rootElement, { dom, ids, announceLive });
    layout.placeOverCanvas(region.element);
    return region;
  }

  /**
   * The editor's `announce(message, { kind, offer })`, which every part receives. A message with a `kind`
   * ('instruction' | 'refusal' | 'result' | 'notice') is shown in the message region, which announces it once, and
   * `announce` returns the region's handle (`{ withdraw() }`). A message without a kind (a view change, problem
   * counts, a result of a C4-notation view) goes to the live region only, as does every message when there is no
   * region; `announce` then returns null. The words spoken for a message with a kind are the message part's either way.
   */
  function routeAnnouncements(messagesPart, region, announceLive) {
    return function announce(message, { kind = null, offer = null } = {}) {
      if (kind !== null && region !== null) return region.show({ text: String(message), kind, offer });
      announceLive(kind !== null && messagesPart ? messagesPart.spokenText({ text: String(message), kind, offer }) : message);
      return null;
    };
  }

  /**
   * A message describes the document and the view as they were when it was shown, so it leaves the region when the
   * document changes (an edit succeeds, Undo, Redo, the YAML, the host's text) or another view opens. Returns the
   * function that stops listening.
   */
  function clearMessagesOnChange(state, region) {
    if (region === null) return () => {};
    const stops = [state.on('text', () => region.dismiss()), state.on('view', () => region.dismiss())];
    return () => stops.forEach((stop) => stop());
  }

  /**
   * Creates the loaded parts in dependency order and returns their handles, each with `destroy()`: the actions
   * (which the toolbar and other parts call), the panels' command gate, the canvas with the scaffolds placed in it,
   * the toolbar, then the parts of the outline, inspector, and panels regions. A region without a part stays
   * hidden. Sets `context.actions` and `context.gate` (each null when its part is absent) and `context.canvas` as
   * they are created, so every later part receives them. Then connects the parts that answer each other's events
   * (connectParts). Returns `{ created, named }`: every handle in creation order, and the toolbar's and each
   * region's handle by name (null when absent).
   */
  function createParts(parts, rootElement, layout, context) {
    const created = [];
    const create = (part, factory, element) => {
      if (!part || typeof part[factory] !== 'function') return null;
      const handle = part[factory](element, context);
      created.push(handle);
      return handle;
    };
    context.actions = create(parts.actions, 'createActions', rootElement);
    context.gate = create(parts.panels, 'createCommandGate', rootElement);
    context.canvas = create(parts.canvas, 'createCanvas', layout.canvas);
    // The scaffolds of spec §9.3 that sit with the drawing: the empty-state guide above it, the carry-down tray in the
    // canvas's scope header (on the top edge of the scope boundary), and the trace announcements.
    create(parts.scaffolds, 'createEmptyStateGuide', layout.canvasGuides);
    create(parts.scaffolds, 'createCarryDownTray', (context.canvas && context.canvas.scopeHeader) || layout.canvasGuides);
    if (parts.scaffolds && typeof parts.scaffolds.createTraceAnnouncer === 'function') {
      created.push(parts.scaffolds.createTraceAnnouncer(context));
    }
    const named = { toolbar: create(parts.toolbar, 'createToolbar', layout.toolbar) };
    for (const region of REGIONS) {
      const { section, body } = layout.regions.get(region.name);
      named[region.name] = create(parts[region.name], region.factory, body);
      section.hidden = named[region.name] === null;
    }
    created.push(...connectParts(Object.assign({ canvas: context.canvas, layout: context.layout }, named)));
    return { created, named };
  }

  /**
   * The mount relays one part's event to another, so the parts never call each other: "Show inside" in Explain
   * (`reveal: 'on-request'`, spec §9.3) also opens the outline below the scope, and the interface card's "Edit
   * <operation>" (spec §9.5) opens that operation in the inspector's interface form, with focus on its syntax field
   * and Back returning to the button (the inspector region is expanded first, Ruling 17). Returns handles with
   * `destroy()`.
   */
  function connectParts({ outline, panels, canvas, inspector, layout }) {
    const connections = [];
    if (outline && panels && typeof panels.onReveal === 'function') {
      connections.push({ destroy: panels.onReveal(() => outline.showInside()) });
    }
    if (canvas && inspector && typeof canvas.onEditOperation === 'function' && typeof inspector.openInterfaceForm === 'function') {
      connections.push({
        destroy: canvas.onEditOperation(({ interfaceId, operationId, returnFocus }) => {
          layout.revealRegion('inspector');
          inspector.openInterfaceForm(interfaceId, { operationId, focus: 'syntax', returnFocus });
        }),
      });
    }
    return connections;
  }

  // ---- Layout (spec §9.1, Ruling 17) -----------------------------------------------------------------

  /**
   * The regions in DOM order. The outline, inspector, and panels are labelled collapsible regions, hidden until a
   * part fills them. `revealRegion(name)` expands one and scrolls it into view (F2, Add, and Problems › Show use it
   * in the stacked layout); it returns false for a region no part fills. `placeOverCanvas(element)` puts the message
   * region directly before the canvas region, the two in one column that takes the canvas's place in the editor's
   * rows; the stylesheet draws it over the canvas's top edge, so the canvas keeps its box and the drawing never moves
   * for it (followCover). `onCanvasCoverChange(listener)` hears each change of what is drawn there and returns the
   * function that stops listening. `canvasTop()` is the canvas's distance from the root's top edge. `dispose()` stops
   * the layout's observers.
   */
  function createLayout(rootElement, dom, ids) {
    const toolbar = dom.el('div', { id: ids('toolbar'), class: 'c4-editor__toolbar', role: 'group', 'aria-label': 'Toolbar' });
    // The YAML-error banner's slot: it concerns the whole editor, so it follows the toolbar, before every region.
    const banner = dom.el('div', { class: 'c4-editor__banner-region' });
    const canvas = dom.el('div', {
      id: ids('canvas'), class: 'c4-editor__canvas', role: 'region', tabindex: '0', 'aria-label': 'Canvas',
    });
    // Scaffolds shown with the drawing (the empty-state guide, the carry-down tray), above it inside the canvas.
    const canvasGuides = dom.el('div', { class: 'c4-editor__canvas-guides' });
    canvas.append(canvasGuides);
    const regions = new Map(REGIONS.map((region) => [region.name, collapsibleRegion(dom, ids, region)]));
    rootElement.append(toolbar, banner, regions.get('outline').section, canvas, regions.get('inspector').section, regions.get('panels').section);

    function revealRegion(name) {
      const region = regions.get(name);
      if (!region || region.section.hidden) return false;
      region.setExpanded(true);
      region.section.scrollIntoView({ block: 'nearest' });
      return true;
    }

    const win = rootElement.ownerDocument.defaultView;
    const coverListeners = new Set();
    const observers = [];

    function placeOverCanvas(element) {
      if (canvas.parentElement === rootElement) {
        const column = dom.el('div', { class: 'c4-editor__canvas-column' });
        canvas.replaceWith(column);
        column.append(canvas);
      }
      canvas.before(element);
      followCover(element);
    }

    /**
     * Keeps the canvas's room for the message region `element` as tall as the region is drawn. The stylesheet keeps one
     * row for it; while a longer message makes the region taller, the measured extra height (`--c4-messages-extra` on
     * the column, set through the CSSOM, with the state class `is-message-tall`) is added to the canvas's top padding and
     * scroll padding, and the stage grows so the canvas can always scroll past that extra room. The canvas scrolls by
     * as much as its padding changes, so the drawing stays where it is, yet it can be scrolled out from under the
     * message, and a reveal inside the canvas stops below the whole region (WCAG 2.4.11). After each change of the
     * region (a message shown, replaced, or cleared) or of its height, the onCanvasCoverChange listeners hear it.
     */
    function followCover(element) {
      const column = canvas.parentElement;
      const paddingTop = () => parseFloat(win.getComputedStyle(canvas).paddingTop) || 0;
      function update() {
        const height = element.getBoundingClientRect().height;
        // A region that is not drawn (print hides it) leaves the room as it was.
        if (height === 0) return;
        const beyondRow = height - (parseFloat(win.getComputedStyle(element).minHeight) || 0);
        const extra = beyondRow >= 1 ? beyondRow : 0;
        const [padding, scrolled] = [paddingTop(), canvas.scrollTop];
        column.style.setProperty('--c4-messages-extra', `${extra}px`);
        column.classList.toggle('is-message-tall', extra > 0);
        const grown = paddingTop() - padding;
        if (grown !== 0) canvas.scrollTop = scrolled + grown;
        coverListeners.forEach((listener) => listener());
      }
      const changes = new win.MutationObserver(update);
      changes.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
      observers.push(changes);
      if (typeof win.ResizeObserver === 'function') {
        const resizes = new win.ResizeObserver(update);
        resizes.observe(element);
        observers.push(resizes);
      }
    }

    function onCanvasCoverChange(listener) {
      coverListeners.add(listener);
      return () => coverListeners.delete(listener);
    }

    /** What holds the canvas's place in the editor's rows is the canvas, or the column it shares with the region. */
    function canvasTop() {
      return (canvas.parentElement === rootElement ? canvas : canvas.parentElement).offsetTop;
    }

    function dispose() {
      observers.forEach((observer) => observer.disconnect());
      coverListeners.clear();
    }

    return {
      toolbar, banner, canvas, canvasGuides, regions, revealRegion, placeOverCanvas, onCanvasCoverChange, canvasTop, dispose,
    };
  }

  function collapsibleRegion(dom, ids, { name, label }) {
    const bodyId = ids(`${name}-body`);
    const toggle = dom.el('button', {
      type: 'button', id: ids(`${name}-toggle`), class: 'c4-editor__region-toggle', 'aria-expanded': 'true', 'aria-controls': bodyId,
    }, label);
    const body = dom.el('div', { id: bodyId, class: 'c4-editor__region-body' });
    const section = dom.el('section', {
      id: ids(name), class: `c4-editor__region c4-editor__region--${name}`, 'aria-labelledby': toggle.id, hidden: true,
    }, [toggle, body]);

    function setExpanded(expanded) {
      toggle.setAttribute('aria-expanded', String(expanded));
      body.hidden = !expanded;
      section.classList.toggle('c4-editor__region--collapsed', !expanded);
    }
    toggle.addEventListener('click', () => setExpanded(toggle.getAttribute('aria-expanded') !== 'true'));
    return { section, body, setExpanded };
  }

  // ---- Magnification (spec §9.1, §9.2, §9.4) ---------------------------------------------------------

  /**
   * The canvas magnification, written to the canvas region's `--c4-zoom` custom property (a computed value, set
   * through the CSSOM), which the stylesheet turns into the drawing's width. The editor opens at 100%; `fit` is only
   * on request.
   */
  function createMagnifier(canvas) {
    let level = 1;
    const listeners = new Set();
    canvas.style.setProperty('--c4-zoom', '1');

    function set(next) {
      const bounded = Math.min(ZOOM.max, Math.max(ZOOM.min, next));
      const rounded = Math.round(bounded * 100) / 100;
      if (rounded === level) return level;
      level = rounded;
      canvas.style.setProperty('--c4-zoom', String(level));
      listeners.forEach((listener) => listener(level));
      return level;
    }

    /**
     * The largest magnification that shows the whole drawing inside the canvas, rounded down to a whole percent. The
     * room is the canvas's inside less its own padding (the strip it keeps for the message region) and the stage's.
     */
    function fit() {
      const drawing = canvas.querySelector('svg');
      const stage = drawing && drawing.closest('.c4-editor__stage');
      if (!drawing || !stage) return level;
      const box = drawing.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return level;
      const [frame, style] = [getComputedStyle(canvas), getComputedStyle(stage)];
      const padding = (side) => parseFloat(frame[`padding${side}`]) + parseFloat(style[`padding${side}`]);
      const width = canvas.clientWidth - padding('Left') - padding('Right');
      const height = canvas.clientHeight - padding('Top') - padding('Bottom');
      const scale = Math.min(width / box.width, height / box.height);
      return set(Math.floor(level * scale * 100) / 100);
    }

    return {
      api: {
        level: () => level,
        canZoomIn: () => level < ZOOM.max,
        canZoomOut: () => level > ZOOM.min,
        // Any level, bounded and rounded to a whole percent (Ctrl/Cmd+wheel and pinch in the canvas).
        set,
        zoomIn: () => set(level + ZOOM.step),
        zoomOut: () => set(level - ZOOM.step),
        reset: () => set(1),
        fit,
        onChange(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
  }

  // ---- Full screen (spec §9.1, §9.2 Escape order) ----------------------------------------------------

  /**
   * Marks every element outside `element` inert (the siblings of the element and of each of its ancestors up to the
   * body) and returns a function that gives back each one's own inert state.
   */
  function makeOutsideInert(element) {
    const changed = [];
    for (let node = element; node && node.parentElement && node !== node.ownerDocument.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || sibling.inert) continue;
        sibling.inert = true;
        changed.push(sibling);
      }
    }
    return () => changed.forEach((sibling) => { sibling.inert = false; });
  }

  /**
   * Full screen for the editor root. While on, a layer on the Escape stack turns it off, after any popover, menu,
   * dialog, or Move (spec §9.2 Escape order). In the browser's own full screen the browser takes the Escape key and
   * leaves full screen before the page sees it, which would skip the open layers, so the editor uses it only where the
   * Keyboard Lock API keeps Escape for the page (a long press still leaves, as the browser tells the reader); everywhere
   * else, and when the browser refuses either API, it uses a fixed overlay class.
   * The overlay covers the page, so while it is on the rest of the page is inert (WCAG 2.4.11): Tab cannot reach a
   * control hidden behind it, and an Escape pressed with focus outside the editor (on the body) still leaves it.
   */
  function createFullScreen(rootElement, escape) {
    const doc = rootElement.ownerDocument;
    const keyboard = doc.defaultView && doc.defaultView.navigator && doc.defaultView.navigator.keyboard;
    const canKeepEscape = Boolean(keyboard && typeof keyboard.lock === 'function' && typeof keyboard.unlock === 'function');
    const listeners = new Set();
    let layer = null;
    let restorePage = null;
    let escapeKept = false;

    function onDocumentKeydown(event) {
      if (event.key !== 'Escape' || event.defaultPrevented || rootElement.contains(event.target)) return;
      event.preventDefault();
      exit();
    }

    function coverPage() {
      if (restorePage) return;
      const restoreInert = makeOutsideInert(rootElement);
      doc.addEventListener('keydown', onDocumentKeydown);
      restorePage = () => {
        doc.removeEventListener('keydown', onDocumentKeydown);
        restoreInert();
        restorePage = null;
      };
    }

    function uncoverPage() {
      if (restorePage) restorePage();
    }

    const isActive = () => doc.fullscreenElement === rootElement || rootElement.classList.contains(FULL_SCREEN_CLASS);

    function releaseEscape() {
      if (!escapeKept) return;
      escapeKept = false;
      keyboard.unlock();
    }

    function sync() {
      const active = isActive();
      if (active && layer === null) layer = escape.push({ close: exit });
      if (!active && layer !== null) {
        layer.remove();
        layer = null;
      }
      // The reader may leave the browser's full screen with its own controls (a long press on Escape).
      if (doc.fullscreenElement !== rootElement) releaseEscape();
      listeners.forEach((listener) => listener(active));
    }

    function enterOverlay() {
      rootElement.classList.add(FULL_SCREEN_CLASS);
      coverPage();
      sync();
    }

    /** The browser's full screen with Escape kept for the editor's layers; the overlay when either is refused. */
    function enterBrowserFullScreen() {
      rootElement.requestFullscreen()
        .then(() => keyboard.lock(['Escape']))
        .then(() => { escapeKept = doc.fullscreenElement === rootElement; if (!escapeKept) keyboard.unlock(); })
        .catch(() => {
          if (doc.fullscreenElement !== rootElement) return enterOverlay();
          // In full screen, but Escape would skip the open layers: the overlay instead.
          return doc.exitFullscreen().catch(() => {}).then(enterOverlay);
        });
    }

    function enter() {
      if (canKeepEscape && typeof rootElement.requestFullscreen === 'function' && doc.fullscreenEnabled) {
        enterBrowserFullScreen();
      } else {
        enterOverlay();
      }
    }

    function exit() {
      if (doc.fullscreenElement === rootElement) {
        doc.exitFullscreen().catch(sync);
      } else {
        rootElement.classList.remove(FULL_SCREEN_CLASS);
        uncoverPage();
        sync();
      }
    }

    doc.addEventListener('fullscreenchange', sync);
    return {
      api: {
        isActive,
        toggle: () => (isActive() ? exit() : enter()),
        onChange(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose() {
        doc.removeEventListener('fullscreenchange', sync);
        releaseEscape();
        if (doc.fullscreenElement === rootElement) doc.exitFullscreen().catch(() => {});
        rootElement.classList.remove(FULL_SCREEN_CLASS);
        uncoverPage();
        listeners.clear();
      },
    };
  }

  // ---- Canvas keys (spec §9.2 shortcut scope) ---------------------------------------------------------

  /**
   * The keys that work while focus is in the canvas: A (the Add menu, at every width), F (full screen), Shift+? (help),
   * Ctrl/Cmd with =, −, 0 (magnification), and Ctrl/Cmd+Z, Ctrl+Y, Cmd+Shift+Z (undo, redo). No key fires in a form
   * control or a menu, and an event a deeper handler already took (a Move or a drag ignores F and A) is left alone.
   * Each command receives the key event. Returns the function that stops listening.
   */
  function listenForCanvasKeys(canvas, commands) {
    function commandFor(event) {
      const modified = event.ctrlKey || event.metaKey;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (modified && !event.altKey) {
        if (key === '=' || key === '+') return commands.zoomIn;
        if (key === '-' || key === '_') return commands.zoomOut;
        if (key === '0') return commands.resetZoom;
        if (key === 'z') return event.shiftKey ? commands.redo : commands.undo;
        if (key === 'y') return commands.redo;
        return null;
      }
      if (modified || event.altKey) return null;
      if (key === 'f' && !event.shiftKey) return commands.toggleFullScreen;
      if (key === 'a' && !event.shiftKey) return commands.openAddMenu;
      if (key === '?') return commands.showHelp;
      return null;
    }

    function onKeydown(event) {
      if (event.defaultPrevented || event.target.closest(TYPING_TARGETS) || event.target.closest(MENUS)) return;
      const command = commandFor(event);
      if (command === null) return;
      event.preventDefault();
      command(event);
    }

    canvas.addEventListener('keydown', onKeydown);
    return () => canvas.removeEventListener('keydown', onKeydown);
  }

  // ---- Keys routed to the host (spec §3.4, §9.2) -----------------------------------------------------------

  /**
   * Ctrl/Cmd+Enter calls `host.onRequestCheck()` (a tutorial runs Test My Work) and Ctrl/Cmd+S calls
   * `host.onRequestSave()`, wherever focus is in the editor: the chords are not typing, so form fields and the YAML tab
   * pass them on too. A key whose callback the host lacks stays the page's, and an event something inside already
   * took is left alone. Returns the function that stops listening.
   */
  function listenForHostKeys(rootElement, host) {
    function callbackFor(event) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return null;
      if (event.key === 'Enter' && !event.shiftKey) return host.onRequestCheck;
      if ((event.key === 's' || event.key === 'S') && !event.shiftKey) return host.onRequestSave;
      return null;
    }

    function onKeydown(event) {
      if (event.defaultPrevented) return;
      const callback = callbackFor(event);
      if (typeof callback !== 'function') return;
      event.preventDefault();
      callback.call(host);
    }

    rootElement.addEventListener('keydown', onKeydown);
    return () => rootElement.removeEventListener('keydown', onKeydown);
  }

  // ---- Escape: the last layer clears the selection (spec §9.2 Escape order) ---------------------------------

  /**
   * An Escape that no popover, menu, dialog, Move, or full screen took clears the selection, when it is pressed in
   * one of `scopes` (the canvas and the outline, where elements are selected) outside a form control. Escape in a
   * field or in the inspector's own controls never empties the form under the learner. Returns the function that
   * stops listening.
   */
  function listenForEscapeToClearSelection(rootElement, scopes, state, announce) {
    function onKeydown(event) {
      if (event.key !== 'Escape' || event.defaultPrevented || state.getSelection() === null) return;
      if (event.target.closest(TYPING_TARGETS) || !scopes.some((scope) => scope.contains(event.target))) return;
      event.preventDefault();
      state.select(null);
      announce('Selection cleared.');
    }
    rootElement.addEventListener('keydown', onKeydown);
    return () => rootElement.removeEventListener('keydown', onKeydown);
  }

  /**
   * Announces every Undo and Redo with the label of the step it takes back or repeats ("Undone: Move Student."),
   * whichever control sent it: the toolbar, the keys, or the YAML editor. A step from the host has no label. With
   * `undo: 'host'` the host owns the history and the editor changes no text itself, so nothing is announced here.
   * Returns the function that stops listening.
   */
  function announceHistorySteps(state, announce) {
    return state.on('text', (text, info) => {
      if (info.reason !== 'undo' && info.reason !== 'redo') return;
      const done = info.reason === 'undo' ? 'Undone' : 'Redone';
      announce(info.label ? `${done}: ${info.label}.` : `${done}: a change made outside the editor.`);
    });
  }

  // ---- Help (spec §9.2) --------------------------------------------------------------------------------

  // The rows for the keys listenForCanvasKeys and the Escape layers answer. Magnification is "zoom" in the toolbar's
  // names; the canvas's rows call the C4 levels "show the inside" and "go up", so the two meanings of zoom stay apart.
  const ADD_MENU_KEY = ['A', 'Open the Add menu'];
  const MOUNT_HELP_KEYS = [
    ['F', 'Turn full screen on or off'],
    ['Ctrl+= and Ctrl+− (Cmd on a Mac)', 'Zoom the drawing in and out'],
    ['Ctrl+0 (Cmd+0 on a Mac)', 'Reset zoom to 100%'],
    ['Ctrl+Z and Ctrl+Y (Cmd+Z and Cmd+Shift+Z on a Mac)', 'Undo and redo'],
    ['Escape', 'Close the innermost menu, tray, or dialog, then clear the selection'],
    ['Shift+?', 'Show this help'],
  ];

  /** Help's `[key, effect]` rows: the keys the canvas (with its editing part) and the mount answer, nothing else. */
  function helpKeys(canvas, toolbar) {
    const canvasKeys = canvas && typeof canvas.helpKeys === 'function' ? canvas.helpKeys() : [];
    const addMenuKeys = toolbar && typeof toolbar.openAddMenu === 'function' ? [ADD_MENU_KEY] : [];
    return canvasKeys.concat(addMenuKeys, MOUNT_HELP_KEYS);
  }

  /** Help's refusal rows (`[{ code, summary, message }]`): the refusal table's, or none when that part is not loaded. */
  function helpRefusals(refusalsPart) {
    return refusalsPart ? refusalsPart.helpRows() : [];
  }

  function showHelp(rootElement, dom, ids, rows, refusals) {
    // Focus starts on the first paragraph, not on Close: Close follows the long list of refusals, and focusing it
    // would open Help scrolled to its end (WAI-ARIA dialog pattern: a static element at the top takes first focus).
    const introduction = dom.el('p', { tabindex: '-1', text: 'Choose a view with the View buttons and the Scope list; '
      + 'the breadcrumbs take you back up. Add an element by clicking a palette tile or dragging it onto the canvas.' });
    const keys = dom.el('dl', { class: 'c4-editor__help-keys' }, rows.map(([key, effect]) => [
      dom.el('dt', { text: key }),
      dom.el('dd', { text: effect }),
    ]));
    return dom.openDialog(rootElement, {
      ids,
      title: 'C4 editor help',
      body: [
        introduction,
        dom.el('p', { text: 'These keys work while the canvas has focus. Letter keys never act while you type in a field, '
          + 'the outline, or a menu.' }),
        keys,
        refusalHelp(dom, ids, refusals),
      ],
      actions: [{ label: 'Close', value: 'close', isDefault: true }],
      initialFocus: introduction,
    });
  }

  /**
   * Help's section "Not available in this design model" (UML-view editing spec §5.6): every refusal of the UML views,
   * its short reason first, then its sentence. A list, not terms, so Help's terms stay its keys. Empty without rows.
   */
  function refusalHelp(dom, ids, refusals) {
    if (refusals.length === 0) return null;
    const headingId = ids('help-refusals');
    return [
      dom.el('h3', { id: headingId, class: 'c4-editor__help-heading', text: 'Not available in this design model' }),
      dom.el('p', { text: 'When a change cannot be made here, the message line above the drawing says why and what to do instead. '
        + 'These are the reasons.' }),
      dom.el('ul', { class: 'c4-editor__help-refusals', 'aria-labelledby': headingId }, refusals.map((row) => dom.el('li', {}, [
        row.summary === null ? null : dom.el('span', { class: 'c4-editor__help-reason', text: `${row.summary}: ` }),
        row.message,
      ]))),
    ];
  }

  return { mount: mount };
});
