(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(globalThis, function () { return { dom: require('./c4-editor-dom.js') }; });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.overlay = factory(root, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (root, editorParts) {
  'use strict';

  // The canvas's interactive overlay (spec §9.1 Canvas, Ruling 12). The normal renderer draws a C4-notation view;
  // `attach` lays an accessible listbox of the view's elements over that drawing, from the drawing's hooks
  // (`data-layout-id` on element boxes, `data-c4-boundary` on boundaries) and their measured boxes, and `destroy`
  // gives the drawing back exactly as it was. The renderer is never asked to draw differently, so the static
  // figure, its export, and its print are the same with or without the overlay. A UML-notation view gets the same
  // listbox from `attachUml`, with the option sets its view module gives (UML-view editing spec §7.2).
  //
  // Focus and selection belong to the canvas: it moves the roving tab stop between the options and marks them with
  // the `is-focused` and `is-selected` classes, which c4-editor.css draws.

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LISTBOX_NAME = 'Elements in this view';
  // Space between an element's drawn outline and its hit target, so the focus and selection strokes sit around it.
  const TARGET_PAD = 3;
  // WCAG 2.5.8: every pointer target at least 24 × 24 CSS px (one drawing unit is one CSS px at 100%). Below 100%
  // the canvas passes a larger minimum in drawing units (`options.minimumTarget`), so targets keep their CSS size.
  const MINIMUM_TARGET = 24;
  // The zoom badge's glyph, drawn in a 24-unit square: a magnifying glass with a plus (spec §9.2 "zoom badge").
  const BADGE_GLYPH = 'M10 6.5v7M6.5 10h7M14.2 14.2l4.8 4.8';
  const BADGE_LENS_RADIUS = 5.5;
  const BADGE_INSET = 4;
  // Boundaries that are not elements: they make option sets (groups) or nothing (the enterprise).
  const NON_ELEMENT_BOUNDARIES = new Set(['group', 'enterprise']);
  const CHILD_NOUNS = {
    container: ['container', 'containers'],
    component: ['component', 'components'],
    code: ['code element', 'code elements'],
  };
  const MIXED_CHILD_NOUNS = ['element', 'elements'];
  // What an id may not hold (c4-editor-dom.js idFactory takes letters, digits, - and _).
  const UNSAFE_ID_CHARACTERS = /[^A-Za-z0-9_-]/g;
  // The drawing's own naming, which the overlay replaces while it is attached and restores on destroy.
  const NAMING_ATTRIBUTES = ['role', 'aria-label'];

  /**
   * Lays the listbox of the elements of `viewModel` (a C4-notation view model from `ArchUMLC4.project`) over `svg`,
   * the rendered drawing of that view model in the document: rendered, so its boxes can be measured, and named as
   * the renderer's caller names it in the canvas (`UMLShared.applySvgAccessibility` on a container without
   * `role="img"`), so neither the drawing nor an ancestor is `aria-hidden`.
   * `options.instanceId` prefixes every id (several editors share a page); `options.design` is the loaded design the
   * view comes from (child counts, pinned positions); `options.problems` maps element ids to their problem counts.
   * While attached, the drawing is `role="group"` named by the view's title, and it ends with
   * `<g role="listbox">` holding `role="group"` sets ("Inside <scope>", one per C4 group, "Outside the system")
   * of `<rect role="option" data-c4-option="<id>">` hit targets, then the connect handles (`data-c4-handle="<id>"`)
   * with each element's "⋯" button (`data-c4-more="<id>"`, its context menu), and the zoom badges of elements with a
   * view inside them (`data-c4-zoom="<id>"`), all hidden from assistive technology: the toolbar's Add relationship
   * and key C, Shift+F10 on the option, and the Enter key are their equivalents. `options.minimumTarget` is
   * the smallest hit target in drawing units (default 24, one CSS px per unit at 100%). Returns
   * `{ targets, destroy }`: the option elements in set order, and the function that removes the overlay and
   * restores the drawing's naming.
   */
  function attach(svg, viewModel, options) {
    const id = editorParts().dom.idFactory(options.instanceId);
    const minimum = options.minimumTarget || MINIMUM_TARGET;
    const restoreNaming = renameDrawing(svg, viewModel.title);
    const listbox = svgElement('g', { class: 'c4-editor__options', role: 'listbox', 'aria-label': LISTBOX_NAME });
    const handles = svgElement('g', { class: 'c4-editor__handles', 'aria-hidden': 'true' });
    const badges = svgElement('g', { class: 'c4-editor__badges', 'aria-hidden': 'true' });
    svg.append(listbox, handles, badges);

    const describe = describer(viewModel, options.design, options.problems || {});
    const targets = [];
    optionSets(svg, viewModel, options.design).forEach((set) => {
      const holder = set.name === null ? listbox
        : listbox.appendChild(svgElement('g', { class: 'c4-editor__option-set', role: 'group', 'aria-label': set.name }));
      set.items.forEach((item) => {
        const box = boxInside(listbox, item.measured);
        const option = optionTarget(item, describe(item), box, id, minimum);
        holder.append(option);
        targets.push(option);
        if (item.kind !== 'box') return;
        handles.append(connectHandle(item.id, box, minimum), moreButton(item, box, minimum));
        if (item.drill) badges.append(zoomBadge(item, box, minimum));
      });
    });

    return {
      targets,
      destroy() {
        listbox.remove();
        handles.remove();
        badges.remove();
        restoreNaming();
      },
    };
  }

  // ---- UML-notation views: the listbox over a delegated drawing ------------------------------------------------

  /**
   * Lays the listbox of `sets` over `svg`, the delegated UML drawing of a code, dynamic, deployment, or interfaces view
   * (UML-view editing spec §7.2, §7.3). `viewModel` is that view's model; `sets` are the option sets its view module
   * gives, `[{ id, label, options: [{ ref, name, description }] }]`, in reading order. Each option whose box
   * `options.boxOf(svg, ref)` finds becomes `<rect role="option" data-c4-option="<ref>">`, named by `name` and described
   * by `description`, in a `role="group"` named by its set's label. An option whose box is not drawn is left out, and
   * so is a set left without options. `boxOf` returns a box in the drawing's coordinates, or null; it defaults to the
   * bundle's lookup, `UMLShared.renderedLayoutBox`, which measures a box by its `data-layout-bounds-id` (a class box
   * has no other hook) and otherwise by its `data-layout-id`.
   *
   * The listbox group carries `data-layout-ignore`, so the bundle's route and obstacle collectors never read an option
   * as part of the drawing, and the ordinal numbering of unnamed lines stays as it is. With `options.readOnly` (the
   * default) the options are the pointer targets, as on a C4-notation view, at least `options.minimumTarget` drawing
   * units (default 24) in each direction. Otherwise they are the listbox of the keyboard and of assistive technology
   * only, and every press goes through them to the drawing, where an editing session's hit targets lie (spec §7.3).
   * It adds no connect handles, "⋯" buttons, or zoom badges. While attached, the drawing is `role="group"` named by
   * the view's title, and no ancestor up to `options.within` (the canvas's drawing container) hides it as an image.
   * `options.instanceId` prefixes every id. Returns `{ targets, destroy }`: the options in set order, and the function
   * that removes the listbox and restores the drawing's naming and its ancestors.
   */
  function attachUml(svg, viewModel, sets, options) {
    const id = editorParts().dom.idFactory(options.instanceId);
    const minimum = options.minimumTarget || MINIMUM_TARGET;
    const boxOf = options.boxOf || ((drawing, ref) => root.UMLShared.renderedLayoutBox(drawing, ref));
    const drawnSets = sets.map((set) => ({
      label: set.label,
      options: set.options.map((option) => ({ option, box: boxOf(svg, option.ref) })).filter(({ box }) => box !== null),
    })).filter((set) => set.options.length > 0);

    const restoreAncestors = unhideAncestors(svg, options.within);
    const restoreNaming = renameDrawing(svg, viewModel.title);
    const listbox = svgElement('g', {
      class: options.readOnly === false ? 'c4-editor__options c4-editor__options--pointer-through' : 'c4-editor__options',
      role: 'listbox', 'aria-label': LISTBOX_NAME, 'data-layout-ignore': '',
    });
    svg.append(listbox);
    const targets = [];
    drawnSets.forEach((set) => {
      const holder = listbox.appendChild(svgElement('g', { class: 'c4-editor__option-set', role: 'group', 'aria-label': set.label }));
      set.options.forEach(({ option, box }) => {
        // A ref may hold characters an id may not (a line's `rel:<n>`); its ids take a safe form, numbered in set order.
        const idPart = `${targets.length}-${option.ref.replace(UNSAFE_ID_CHARACTERS, '-')}`;
        const target = optionTarget({ id: option.ref, idPart, kind: 'box', name: option.name }, option.description, box, id, minimum);
        holder.append(target);
        targets.push(target);
      });
    });
    return {
      targets,
      destroy() {
        listbox.remove();
        restoreNaming();
        restoreAncestors();
      },
    };
  }

  /**
   * A drawing an ancestor names as one image cannot hold a listbox: assistive technology flattens the image. Removes
   * `role="img"` (with its name) and `aria-hidden` from the ancestors of `svg` up to and including `within`, and
   * returns the function that puts them back.
   */
  function unhideAncestors(svg, within) {
    const saved = [];
    for (let node = svg.parentElement; node && within && within.contains(node); node = node.parentElement) {
      const attributes = ['role', 'aria-label', 'aria-hidden'].map((name) => [name, node.getAttribute(name)]);
      if (node.getAttribute('role') !== 'img' && node.getAttribute('aria-hidden') === null) continue;
      saved.push([node, attributes]);
      node.removeAttribute('aria-hidden');
      if (node.getAttribute('role') === 'img') {
        node.removeAttribute('role');
        node.removeAttribute('aria-label');
      }
    }
    return function restore() {
      saved.forEach(([node, attributes]) => attributes.forEach(([name, value]) => {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }));
    };
  }

  // ---- The drawing's naming --------------------------------------------------------------------------------

  /**
   * Names the drawing as a group (spec §9.1: `role="group"`, not `role="img"`, while editing) and returns the
   * function that restores the naming it had. Attributes are changed and restored in place, so the markup comes
   * back byte for byte.
   */
  function renameDrawing(svg, title) {
    const saved = NAMING_ATTRIBUTES.map((name) => [name, svg.getAttribute(name)]);
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', title);
    return function restore() {
      saved.forEach(([name, value]) => {
        if (value === null) svg.removeAttribute(name);
        else svg.setAttribute(name, value);
      });
    };
  }

  // ---- Option sets -------------------------------------------------------------------------------------------

  /**
   * The elements of `viewModel`, drawn in `svg`, as option sets in reading order: inside the scope, each C4 group,
   * then outside the scope. A set's `name` is null when its options sit directly in the listbox (a view without a
   * scope). Each item is
   * `{ id, kind: 'boundary' | 'box', name, typeLabel, drill, measured }`, where `measured` is the drawn element to
   * measure: a boundary's label (a boundary is selected by its label, so its inside stays free for its members),
   * or an element's box. Empty sets are left out.
   */
  function optionSets(svg, viewModel, design) {
    const boundaries = new Map(viewModel.boundaries.map((boundary) => [boundary.id, boundary]));
    const scope = viewModel.scopeId ? design.model.elements.get(viewModel.scopeId) : null;
    const inside = { name: scope && `Inside ${scope.name}`, items: [] };
    const outsideName = scope && (scope.type === 'system' ? 'Outside the system' : `Outside ${scope.name}`);
    const outside = { name: outsideName, items: [] };
    const groups = new Map(viewModel.boundaries.filter((boundary) => boundary.kind === 'group')
      .map((boundary) => [boundary.id, { name: `Group: ${boundary.label}`, items: [] }]));

    function setOf(elementId, enclosingId) {
      if (elementId === viewModel.scopeId) return inside;
      for (let boundary = boundaries.get(enclosingId); boundary; boundary = boundaries.get(boundary.parentBoundaryId)) {
        if (groups.has(boundary.id)) return groups.get(boundary.id);
        if (boundary.id === viewModel.scopeId) return inside;
      }
      return outside;
    }

    viewModel.boundaries.filter((boundary) => !NON_ELEMENT_BOUNDARIES.has(boundary.kind)).forEach((boundary) => {
      setOf(boundary.id, boundary.parentBoundaryId).items.push({
        id: boundary.id, kind: 'boundary', name: boundary.label, typeLabel: boundary.typeLabel, drill: null,
        measured: svg.querySelector(`[data-c4-boundary="${boundary.id}"] text`),
      });
    });
    viewModel.nodes.forEach((node) => {
      setOf(node.id, node.boundaryId).items.push({
        id: node.id, kind: 'box', name: node.name, typeLabel: node.typeLabel, drill: node.drill,
        measured: svg.querySelector(`[data-layout-id="${node.id}"]`),
      });
    });
    return [inside].concat([...groups.values()], outside).filter((set) => set.items.length > 0);
  }

  // ---- Options and handles ---------------------------------------------------------------------------------

  /**
   * The description of an option (spec §9.1): its type line (with technology and "external"), "contains N … —
   * Enter shows inside" when it has a lower view, "position pinned", and its problem count.
   */
  function describer(viewModel, design, problems) {
    const pins = design.model.layout.get(viewModel.key);
    return function describe(item) {
      const parts = [item.typeLabel];
      if (item.drill) parts.push(`contains ${childCount(design.model, item.id)} — Enter shows inside`);
      if (pins && pins.has(item.id)) parts.push('position pinned');
      const count = problems[item.id] || 0;
      if (count > 0) parts.push(`${count} ${count === 1 ? 'problem' : 'problems'}`);
      return parts.join('; ');
    };
  }

  /** "4 components", "1 container", or "3 elements" when the children are of different types. */
  function childCount(model, parentId) {
    const children = [...model.elements.values()].filter((element) => element.parentId === parentId);
    const types = new Set(children.map((child) => child.type));
    const nouns = types.size === 1 ? CHILD_NOUNS[[...types][0]] || MIXED_CHILD_NOUNS : MIXED_CHILD_NOUNS;
    return `${children.length} ${children.length === 1 ? nouns[0] : nouns[1]}`;
  }

  /**
   * One `role="option"` hit target over `box`, named by its `<title>` and described by its `<desc>`. `item.id` is its
   * `data-c4-option`; its ids are made from `item.idPart` when given, else from `item.id`.
   */
  function optionTarget(item, description, box, id, minimum) {
    const idPart = item.idPart || item.id;
    const nameId = id(`option-${idPart}-name`);
    const descriptionId = id(`option-${idPart}-description`);
    const target = targetBox(box, minimum);
    return svgElement('rect', {
      class: `c4-editor__option c4-editor__option--${item.kind}`, 'data-c4-option': item.id,
      role: 'option', tabindex: '-1', 'aria-selected': 'false', 'aria-labelledby': nameId, 'aria-describedby': descriptionId,
      x: target.x, y: target.y, width: target.width, height: target.height,
    }, [
      svgElement('title', { id: nameId }, item.name),
      svgElement('desc', { id: descriptionId }, description),
    ]);
  }

  /** A connect handle on the right edge of an element's box (spec §9.2); the canvas shows it when needed. */
  function connectHandle(elementId, box, minimum) {
    return svgElement('circle', {
      class: 'c4-editor__handle', 'data-c4-handle': elementId,
      cx: box.x + box.width, cy: box.y + box.height / 2, r: minimum / 2,
    });
  }

  /**
   * The "⋯" button in the top-left corner of an element's box (spec §9.2: the context menu's pointer opener). The
   * canvas shows it, like the connect handle, on the selected and the hovered element.
   */
  function moreButton(item, box, minimum) {
    const scale = minimum / MINIMUM_TARGET;
    const x = box.x + BADGE_INSET * scale;
    const y = box.y + BADGE_INSET * scale;
    const dots = [6, 12, 18].map((cx) => svgElement('circle', { class: 'c4-editor__more-button-dot', cx, cy: 12, r: 2 }));
    return svgElement('g', { class: 'c4-editor__more-button', 'data-c4-more': item.id, transform: `translate(${x} ${y}) scale(${scale})` }, [
      svgElement('title', {}, `Actions for ${item.name}`),
      svgElement('rect', { class: 'c4-editor__more-button-face', width: MINIMUM_TARGET, height: MINIMUM_TARGET, rx: 4 }),
    ].concat(dots));
  }

  /**
   * The zoom badge in the top-right corner of an element with a view inside it (spec §9.2): a click shows the
   * inside, as Enter does. Its `<title>` is the pointer's tooltip; the badge's layer is hidden from assistive
   * technology, where the option's description says "Enter shows inside".
   */
  function zoomBadge(item, box, minimum) {
    const scale = minimum / MINIMUM_TARGET;
    const x = box.x + box.width - minimum - BADGE_INSET * scale;
    const y = box.y + BADGE_INSET * scale;
    return svgElement('g', { class: 'c4-editor__zoom-badge', 'data-c4-zoom': item.id, transform: `translate(${x} ${y}) scale(${scale})` }, [
      svgElement('title', {}, `Show inside ${item.name}`),
      svgElement('rect', { class: 'c4-editor__zoom-badge-face', width: MINIMUM_TARGET, height: MINIMUM_TARGET, rx: 4 }),
      svgElement('circle', { class: 'c4-editor__zoom-badge-glyph', cx: 10, cy: 10, r: BADGE_LENS_RADIUS }),
      svgElement('path', { class: 'c4-editor__zoom-badge-glyph', d: BADGE_GLYPH }),
    ]);
  }

  /** `box` grown by the pad, then to the minimum target size around its centre. */
  function targetBox(box, minimum) {
    const width = Math.max(box.width + 2 * TARGET_PAD, minimum);
    const height = Math.max(box.height + 2 * TARGET_PAD, minimum);
    return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
  }

  // ---- Geometry ----------------------------------------------------------------------------------------------

  /**
   * The bounding box of the drawn `element`, in the coordinates of `layer` (an element of the same drawing): both
   * transforms lead to the same viewport, so the renderer's nesting of groups never matters.
   */
  function boxInside(layer, element) {
    const box = element.getBBox();
    const toLayer = layer.getCTM().inverse().multiply(element.getCTM());
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    const corners = [[box.x, box.y], [right, box.y], [box.x, bottom], [right, bottom]]
      .map(([x, y]) => new DOMPoint(x, y).matrixTransform(toLayer));
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
  }

  // ---- SVG elements ------------------------------------------------------------------------------------------

  /** An SVG element with `attributes` and `children` (nodes, or one string set as its text). */
  function svgElement(tag, attributes, children) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    if (typeof children === 'string') node.textContent = children;
    else if (children) node.append(...children);
    return node;
  }

  return { attach: attach, attachUml: attachUml };
});
