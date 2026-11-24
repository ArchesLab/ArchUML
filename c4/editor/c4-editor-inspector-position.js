(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () { return null; }, function () {
      return {
        inspectorShared: require('./c4-editor-inspector-shared.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorPosition = factory(root.ArchUMLC4, function () { return root.ArchUMLC4Render || null; }, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, renderer, editorParts) {
  'use strict';

  // The element form's Position (spec §9.1, §9.2; WCAG 2.5.7), built from the inspector's kit
  // (c4-editor-inspector-kit.js): the single-pointer fallback for dragging an element in the open view. On a
  // UML-notation view that the canvas edits (UML-view editing spec §6, §7.6) the same controls steer the canvas's
  // editing part (`actions.umlEditing().positionFor`), so a step or a typed X or Y moves the box as M and the arrow
  // keys do, and a box that keeps no position in the view shows why instead of controls. On a dynamic view a lifeline
  // has a place in the lifeline order instead of a position (UML-view editing spec §7.4, §7.6): Move left and Move right,
  // the same items as the lifeline's menu on the canvas, planned by the dynamic view module (lifelineOrderBody).

  const POSITION_STEPS = [10, 20, 50, 100];
  const DEFAULT_STEP = 20;
  const DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  /**
   * The Position disclosure's body. `inspector` is the inspector's shared context: the kit, `state`, `dom`, `announce`,
   * and `actions`. Returns `positionBody(model, current)`.
   */
  function createPositionSection(inspector) {
    const { state, dom, announce, actions, field, button, run, problem, lockReason, requestFocus } = inspector;
    const profile = (inspector.options && inspector.options.profile) || 'novice';
    // What the section keeps between renders: the step of Move up, down, left, and right.
    const view = { step: DEFAULT_STEP };

    /**
     * The single-pointer fallback for dragging (spec §9.1, §9.2; WCAG 2.5.7): the pinned state, Move up/down/left/
     * right by the chosen step, X and Y, and Return to automatic layout. Each command pins the element in the open
     * view's layout as one edit.
     */
    function positionBody(model, current) {
      const viewModel = C4.project(state.getDesign(), state.getView());
      if (viewModel.notation === 'uml-sequence') return lifelineOrderBody(viewModel, current);
      if (viewModel.notation !== 'c4') return umlPositionBody(current);
      if (!viewModel.nodes.some((node) => node.id === current.id)) {
        return dom.el('p', { class: 'c4-editor__field-hint', text: `${current.name} is not drawn as a box in the open view, so it has no position here.` });
      }
      const pins = model.layout.get(viewModel.key) || null;
      const pinned = pins ? pins.get(current.id) || null : null;
      const at = pinned || automaticPosition(viewModel, pins, current.id);
      if (!at) return dom.el('p', { class: 'c4-editor__field-hint', text: 'The position cannot be computed here.' });
      const [x, y] = at.map(Math.round);
      const reason = lockReason(['layout']);
      // The shared pin command announces where the element is drawn and what made room for it.
      const pin = (nextX, nextY, how) => actions.pinElement(current.id, { viewKey: state.getView(), x: nextX, y: nextY, how });
      const moveButton = (direction) => button(`Move ${direction}`, () => {
        const [dx, dy] = DIRECTIONS[direction];
        pin(x + dx * view.step, y + dy * view.step, `${direction} by ${view.step}`);
      }, { 'data-c4-focus-key': `position-${direction}` });
      const coordinate = (axis, value) => field({ key: `position-${axis}`, label: axis.toUpperCase(), control: 'number', value,
        path: ['layout'], lintPath: null, onCommit: (typed) => {
          const number = Number(typed);
          if (typed.trim() === '' || !Number.isFinite(number)) return problem(`position-${axis}`, `Error: ${axis.toUpperCase()} is a number.`);
          const next = axis === 'x' ? [Math.round(number), y] : [x, Math.round(number)];
          return pin(next[0], next[1]);
        } });
      return [
        dom.el('p', { class: 'c4-editor__position-state', text: pinned ? `Pinned at ${x}, ${y} in this view.` : 'Placed automatically.' }),
        reason ? dom.el('p', { class: 'c4-editor__lock-note', text: reason }) : [
          stepField(),
          dom.el('div', { class: 'c4-editor__position-moves', role: 'group', 'aria-label': 'Move by one step' },
            ['up', 'left', 'right', 'down'].map(moveButton)),
          dom.el('div', { class: 'c4-editor__position-coordinates' }, [coordinate('x', x), coordinate('y', y)]),
          pinned ? button('Return to automatic layout', () => {
            if (run({ op: 'unpinPosition', viewKey: state.getView(), elementId: current.id }, `Unpin ${current.name}`)) {
              announce(`${current.name} is placed automatically again.`);
              requestFocus('position-summary');
            }
          }, { 'data-c4-focus-key': 'position-unpin' }) : null,
        ],
      ];
    }

    /**
     * The Position section on a UML-notation view: the box's kept or drawn place, Move up/down/left/right by the chosen
     * step, X and Y, and Return to automatic layout while it keeps a position. Each is one change through the canvas's
     * editing part, which says its result. Without that part (a page without the diagram editor, a read-only editor)
     * the section says positions cannot be changed here.
     */
    function umlPositionBody(current) {
      const hint = (text) => dom.el('p', { class: 'c4-editor__field-hint', text });
      const editing = actions && typeof actions.umlEditing === 'function' ? actions.umlEditing() : null;
      if (!editing) return hint('Positions in this view cannot be changed here.');
      const position = editing.positionFor({ elementId: current.id });
      if (!position || !position.at) return hint(`${current.name} is not drawn as a box in the open view, so it has no position here.`);
      if (position.refusal) return hint(position.refusal);
      const [x, y] = position.at;
      const moveButton = (direction) => button(`Move ${direction}`, () => {
        const [dx, dy] = DIRECTIONS[direction];
        position.moveBy(dx * view.step, dy * view.step);
      }, { 'data-c4-focus-key': `position-${direction}` });
      const coordinate = (axis, value) => field({ key: `position-${axis}`, label: axis.toUpperCase(), control: 'number', value,
        path: ['layout'], lintPath: null, onCommit: (typed) => {
          const number = Number(typed);
          if (typed.trim() === '' || !Number.isFinite(number)) return problem(`position-${axis}`, `Error: ${axis.toUpperCase()} is a number.`);
          const next = axis === 'x' ? [Math.round(number), y] : [x, Math.round(number)];
          position.moveTo(next[0], next[1]);
          return true;
        } });
      return [
        dom.el('p', { class: 'c4-editor__position-state', text: position.kept ? `Pinned at ${x}, ${y} in this view.` : 'Placed automatically.' }),
        stepField(),
        dom.el('div', { class: 'c4-editor__position-moves', role: 'group', 'aria-label': 'Move by one step' },
          ['up', 'left', 'right', 'down'].map(moveButton)),
        dom.el('div', { class: 'c4-editor__position-coordinates' }, [coordinate('x', x), coordinate('y', y)]),
        position.kept ? button('Return to automatic layout', () => {
          position.returnToAutomatic().then((verdict) => { if (verdict && verdict.ok) requestFocus('position-summary'); });
        }, { 'data-c4-focus-key': 'position-unpin' }) : null,
      ];
    }

    /**
     * The Position section of a lifeline in a dynamic view: its place in the order ("lifeline 2 of 5; in Registration
     * API"), then Move left and Move right. Each swaps the lifeline with its neighbour inside its box and, at the box's
     * edge, moves the whole box, as one change with the dynamic view module's undo label and announcement (the same
     * items and plan as the lifeline's menu on the canvas). An item that cannot run is disabled with its reason as text.
     */
    function lifelineOrderBody(viewModel, current) {
      const hint = (text) => dom.el('p', { class: 'c4-editor__field-hint', text });
      const module = editorParts().umlViews ? editorParts().umlViews['uml-sequence'] : null;
      if (!module) return hint('The lifeline order cannot be changed here.');
      const context = { design: state.getDesign(), viewModel, uml: C4.toUml(viewModel), profile,
        checksReleased: state.checksReleased(), layout: viewModel.layout };
      const lifeline = module.optionSets(context)[0].options.find((each) => context.uml.ids[each.ref] === current.id);
      if (!lifeline) return hint(`${current.name} is not drawn as a lifeline in the open view, so it has no place in its order.`);
      const reason = lockReason(['layout']);
      const items = reason ? [] : module.menu(lifeline.ref, context).filter((item) => /^Move (left|right)$/.test(item.label));
      return [
        dom.el('p', { class: 'c4-editor__position-state', text: `${upperFirst(lifeline.description)}.` }),
        reason ? dom.el('p', { class: 'c4-editor__lock-note', text: reason })
          : dom.el('div', { class: 'c4-editor__position-moves', role: 'group', 'aria-label': 'Move in the lifeline order' },
            items.map((item) => lifelineMove(module, context, item))),
      ];
    }

    function lifelineMove(module, context, item) {
      const key = `position-${item.label.toLowerCase().replace(/\s+/g, '-')}`;
      if (item.refusal) {
        return dom.el('div', { class: 'c4-editor__field' }, [
          button(item.label, () => announce(item.refusal.message), { 'aria-disabled': 'true', 'data-c4-focus-key': key }),
          dom.el('p', { class: 'c4-editor__field-hint', text: item.refusal.summary }),
        ]);
      }
      return button(item.label, () => {
        const plan = module.plan(item.operation, context);
        if (plan.kind !== 'commands') {
          announce(plan.message || 'The lifeline order cannot be changed here.');
          return;
        }
        if (run({ op: 'batch', commands: plan.commands }, plan.label)) {
          if (plan.message) announce(plan.message);
          requestFocus(key);
        }
      }, { 'data-c4-focus-key': key });
    }

    /** The step of Move up, down, left, and right, kept between renders. */
    function stepField() {
      return field({ key: 'position-step', label: 'Step', control: 'select', value: String(view.step), path: ['layout'], lintPath: null,
        choices: POSITION_STEPS.map((step) => ({ value: String(step), label: String(step) })),
        onCommit: (value) => { view.step = Number(value); } });
    }

    /** Where the renderer's layout puts the element now (top-left corner of its box), or null without a renderer. */
    function automaticPosition(viewModel, pins, elementId) {
      const draw = renderer();
      if (!draw || typeof draw.layoutView !== 'function') return null;
      // The renderer measures text through the ArchUML bundle; on a page without it the form says it cannot place the
      // element instead of failing the whole inspector.
      let box;
      try {
        box = draw.layoutView(viewModel, undefined, { pins }).nodes[elementId];
      } catch (error) {
        return null;
      }
      return box ? [box.x, box.y] : null;
    }

    return { positionBody };
  }

  function upperFirst(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  return { createPositionSection };
});
