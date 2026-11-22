(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return {
        state: require('./c4-editor-state.js'),
        lists: require('./c4-editor-lists.js'),
        panels: require('./c4-editor-panels.js'),
        inspectorShared: require('./c4-editor-inspector-shared.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorKit = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // The inspector's form kit (c4-editor-inspector.js): every form of the inspector, and the interface forms of
  // c4-editor-interfaces.js, label, lock, lint, and commit a field the same way because they build it from here. The
  // kit holds commands as one undo step each, locks and the read-only mode, the problems shown under a field, labelled
  // fields, sections, disclosures, groups, and the list editors (spec §9.1, §9.3, §11).

  /**
   * The form kit of one inspector. `inspector` is the inspector's shared context: `state`, `dom`, `ids`, `announce`,
   * `options`, `actions`, `view` (`openDisclosures`), `localProblems`, and the render cycle's `live`,
   * `scheduleRender`, `requestFocus`, `byKey`, and `trackList`.
   */
  function createFormKit(inspector) {
    const { state, dom, ids, announce, options, actions, view, localProblems, live, scheduleRender, requestFocus, byKey,
      trackList } = inspector;
    const { TEXT, slug, capitalize, moved, onEnter } = editorParts().inspectorShared;

    // ---- Commands ------------------------------------------------------------------------------

    function readOnlyReason() {
      const panels = editorParts().panels;
      const reason = panels && typeof panels.disabledReason === 'function' ? panels.disabledReason(state) : null;
      return reason ? `Read-only: ${reason}` : TEXT.readOnly;
    }

    /** Why the YAML at `path` cannot be edited here (a lock or the read-only mode), or null. */
    function lockReason(path) {
      if (state.isReadOnly()) return readOnlyReason();
      const isLockedPath = editorParts().state.isLockedPath;
      return isLockedPath(path, options.lockedFields) ? TEXT.locked : null;
    }

    /** Whether a lock covers `path` or lies anywhere inside it (reordering would move a locked item). */
    function touchesLock(path) {
      return Boolean(lockReason(path)) || editorParts().state.touchesLockedPath(path, options.lockedFields);
    }

    /**
     * The add row `build()` makes for new entries under `holderPath`, or, when a lock covers the path a new entry
     * would take (`holderPath.newKey`; `*` stands for a key the learner has not chosen yet), a note saying why there
     * is none. A lock on the holder itself withholds the row silently, as its fields already show that lock.
     */
    function addRowUnlessLocked(holderPath, newKey, [many, one], build) {
      if (lockReason(holderPath)) return null;
      if (touchesLock(holderPath.concat(newKey))) return dom.el('p', { class: 'c4-editor__lock-note', text: TEXT.noNewEntry(many, one) });
      return build();
    }

    /** One core command as one undo step; a refusal is announced and returns false. */
    function run(command, label) {
      const result = state.dispatch(command, { label });
      if (!result.ok) announce(state.refusalText(result));
      return result.ok;
    }

    function problem(key, message) {
      localProblems.set(key, message);
      announce(message);
      scheduleRender();
      return false;
    }

    // ---- Fields --------------------------------------------------------------------------------

    function fieldDiagnostics(path) {
      const panels = editorParts().panels;
      if (!panels || typeof panels.fieldDiagnostics !== 'function') return [];
      return panels.fieldDiagnostics(state, path, options);
    }

    /** Problems shown under a field: the released diagnostics at `path` (inline lint) and a local refusal. */
    function problemsFor(key, path, { exact = false, rules = null } = {}) {
      const panels = editorParts().panels;
      const model = state.getDesign().model;
      const isExact = (diagnostic) => panels.locateDiagnostic(model, diagnostic).fieldPath.length === path.length;
      const diagnostics = path === null ? [] : fieldDiagnostics(path)
        .filter((diagnostic) => (!exact || isExact(diagnostic)) && (rules === null || rules.includes(diagnostic.rule)));
      const found = diagnostics.map((diagnostic) => ({ severity: diagnostic.severity, text: diagnostic.text }));
      if (localProblems.has(key)) found.unshift({ severity: 'error', text: localProblems.get(key) });
      return found;
    }

    function problemText(id, problems) {
      if (problems.length === 0) return null;
      const severity = ['error', 'warning', 'info'].find((level) => problems.some((found) => found.severity === level));
      return dom.el('p', { id, class: `c4-editor__field-problem c4-editor__field-problem--${severity}` },
        problems.map((found) => found.text).join(' '));
    }

    /**
     * A labelled control with its hint, lock note, and problems, linked by `aria-describedby`. `spec`: `key` (unique
     * in the form), `label`, `value`, `path` (the YAML path, for locks, lint, and focus requests), `control` ('input',
     * 'textarea', 'select', 'checkbox', or 'number'), `choices` ([{ value, label }] for a select), `hint`, `labelHidden`,
     * `lintPath` (default `path`; null for none), `lintRules` (only these rules' diagnostics at `lintPath`, for a rule
     * whose path names the whole operation or field), `problems` (more `{ severity, text }` to show, such as a draft's
     * parse error), `locked` (a lock reason that replaces the one of `path`, for a control that rewrites more than its
     * own path), `describedBy` (the id of a hint shared by several fields, such as a list's sentence frame), and
     * `onCommit(value)` (run when the value is committed).
     */
    function field(spec) {
      const id = ids(`insp-${slug(spec.key)}`);
      const reason = spec.locked === undefined ? lockReason(spec.path) : spec.locked;
      const lintPath = spec.lintPath === undefined ? spec.path : spec.lintPath;
      const problems = problemsFor(spec.key, lintPath, { exact: spec.exactLint, rules: spec.lintRules || null })
        .concat(spec.problems || []);
      const hint = spec.hint ? dom.el('p', { id: `${id}-hint`, class: 'c4-editor__field-hint', text: spec.hint }) : null;
      const lockNote = reason ? dom.el('p', { id: `${id}-lock`, class: spec.quietLock ? 'c4-editor__sr-only' : 'c4-editor__lock-note', text: reason }) : null;
      const problemNode = problemText(`${id}-problem`, problems);
      const describedBy = [spec.describedBy].concat([hint, lockNote, problemNode].filter(Boolean).map((node) => node.id))
        .filter(Boolean).join(' ') || null;
      const control = buildControl(spec, id, reason, describedBy);
      if (problems.some((found) => found.severity === 'error')) control.setAttribute('aria-invalid', 'true');
      const label = dom.el('label', { for: id, class: spec.labelHidden ? 'c4-editor__sr-only' : 'c4-editor__field-label', text: spec.label });
      const isCheckbox = spec.control === 'checkbox';
      return dom.el('div', { class: `c4-editor__field${isCheckbox ? ' c4-editor__field--checkbox' : ''}` },
        isCheckbox ? [dom.el('div', { class: 'c4-editor__checkbox-row' }, [control, label]), hint, lockNote, problemNode]
          : [label, hint, control, lockNote, problemNode]);
    }

    function buildControl(spec, id, reason, describedBy) {
      const common = { id, 'aria-describedby': describedBy, 'data-c4-focus-key': spec.key, 'data-c4-path': JSON.stringify(spec.path) };
      if (spec.control === 'checkbox') {
        const box = dom.el('input', Object.assign({ type: 'checkbox', class: 'c4-editor__checkbox', checked: spec.value ? true : null,
          disabled: reason ? true : null }, common));
        if (!reason) box.addEventListener('change', live(() => spec.onCommit(box.checked)));
        return box;
      }
      if (spec.control === 'select' && reason) {
        // A locked choice reads as text: a disabled select would hide its value from some readers.
        const chosen = (spec.choices.find((choice) => choice.value === spec.value) || { label: spec.value || '' }).label;
        return dom.el('input', Object.assign({ type: 'text', class: 'c4-editor__input', value: chosen, readonly: true }, common));
      }
      if (spec.control === 'select') {
        const select = dom.el('select', Object.assign({ class: 'c4-editor__select' }, common),
          spec.choices.map((choice) => dom.el('option', { value: choice.value, text: choice.label, selected: choice.value === spec.value ? true : null })));
        select.value = spec.value;
        select.addEventListener('change', live(() => spec.onCommit(select.value)));
        return select;
      }
      const attrs = Object.assign({ class: 'c4-editor__input', readonly: reason ? true : null, autocomplete: 'off' }, common);
      const control = spec.control === 'textarea'
        ? dom.el('textarea', Object.assign({ rows: '3' }, attrs), spec.value || '')
        : dom.el('input', Object.assign({ type: spec.control === 'number' ? 'number' : 'text', value: spec.value === null ? '' : String(spec.value) }, attrs));
      if (!reason) control.addEventListener('change', live(() => spec.onCommit(control.value)));
      return control;
    }

    /** A labelled section of a form, `<section>` with an h4. */
    function formSection(key, title, children) {
      const headingId = ids(`insp-${key}-heading`);
      return dom.el('section', { class: 'c4-editor__inspector-section', 'aria-labelledby': headingId }, [
        dom.el('h4', { id: headingId, class: 'c4-editor__inspector-section-title', text: title }),
        children,
      ]);
    }

    /** A collapsed disclosure (spec §9.1: Position, Design choices, More); its content is built only while open. */
    function disclosure(key, title, build) {
      const open = view.openDisclosures.has(key);
      const details = dom.el('details', { class: 'c4-editor__inspector-disclosure', open: open ? true : null, 'data-c4-disclosure': key }, [
        dom.el('summary', { class: 'c4-editor__inspector-summary', 'data-c4-focus-key': `${key}-summary`, text: title }),
        open ? dom.el('div', { class: 'c4-editor__inspector-disclosure-body' }, build()) : null,
      ]);
      details.addEventListener('toggle', () => {
        if (details.open === view.openDisclosures.has(key)) return;
        if (details.open) view.openDisclosures.add(key);
        else view.openDisclosures.delete(key);
        scheduleRender();
      });
      return details;
    }

    /** Opens the disclosure `key` at the next render (an interface operation opened from its card). */
    function openDisclosure(key) {
      view.openDisclosures.add(key);
    }

    function button(label, onClick, extra = {}) {
      return dom.el('button', Object.assign({ type: 'button', class: 'c4-editor__button', on: { click: onClick } }, extra), label);
    }

    function isScaffoldOn(name) {
      return !(options.scaffolds && options.scaffolds[name] === false);
    }

    // ---- Lists ---------------------------------------------------------------------------------

    function listEditor(spec) {
      const list = editorParts().lists.createListEditor(Object.assign({
        dom, ids, announce, requestFocus,
        openMenu: (menu) => actions.openMenu(menu),
      }, spec));
      trackList(list);
      return list.element;
    }

    /**
     * A list of texts (owns, invariants, quality, tags, provides, alternatives, styles, tactics): one text field per
     * item, the list editor's menu and handle, and an Add field. `write(items)` writes the whole list as one command.
     * `hint` (a sentence frame) shows under the list's label and describes every item field and the Add field.
     */
    function textList({ key, label, itemName, items, path, write, hint = null }) {
      const reason = lockReason(path);
      const headingId = ids(`insp-${slug(key)}-label`);
      const hintId = hint ? `${headingId}-hint` : null;
      const commitItem = (index, value) => {
        const text = value.trim();
        const next = items.slice();
        if (text === '') next.splice(index, 1);
        else next[index] = text;
        return write(next);
      };
      const addKey = `${key}-new`;
      const add = () => {
        const input = byKey(addKey);
        const text = input.value.trim();
        if (text === '') return problem(addKey, `Error: Type the ${itemName} first.`);
        if (write(items.concat(text))) {
          announce(`Added ${itemName} ${items.length + 1}.`);
          requestFocus(addKey);
        }
        return true;
      };
      const rows = listEditor({
        name: slug(key),
        label,
        itemName,
        items,
        // Every row is rewritten by `write`, so a lock on any item freezes the order and removal of all rows.
        locked: touchesLock(path) ? (reason || TEXT.locked) : null,
        rowLocked: (index) => lockReason(path.concat(index)),
        renderRow: (item, index) => field({ key: `${key}-${index}`, label: `${capitalize(itemName)} ${index + 1}`, labelHidden: true,
          value: item, path: path.concat(index), lintPath: null, quietLock: true, describedBy: hintId,
          onCommit: (value) => commitItem(index, value) }),
        onMove: (from, to) => write(moved(items, from, to)),
        onRemove: (index) => write(items.filter((unused, position) => position !== index)),
        emptyFocusKey: addKey,
      });
      // The new item takes the next index, which a wildcard lock (`…tags.*`) already covers.
      const addRow = addRowUnlessLocked(path, String(items.length), [`${itemName}s`, itemName], () => {
        const row = dom.el('div', { class: 'c4-editor__list-add' }, [
          field({ key: addKey, label: `New ${itemName}`, value: '', path, lintPath: null, describedBy: hintId, onCommit: () => {} }),
          button(`Add ${itemName}`, add),
        ]);
        row.querySelector('input').addEventListener('keydown', onEnter(add));
        return row;
      });
      return dom.el('div', { class: 'c4-editor__field c4-editor__text-list', role: 'group', 'aria-labelledby': headingId }, [
        dom.el('p', { id: headingId, class: 'c4-editor__field-label', text: label }),
        hint ? dom.el('p', { id: hintId, class: 'c4-editor__field-hint', text: hint }) : null,
        reason ? dom.el('p', { class: 'c4-editor__lock-note', text: reason }) : null,
        items.length > 0 ? rows : dom.el('p', { class: 'c4-editor__field-hint', text: `No ${itemName}s yet.` }),
        addRow,
      ]);
    }

    // ---- Forms of records (scenarios, deployment, decisions, requirements, groups, views) -------

    function form(title, subtitle, children) {
      return dom.el('div', { class: 'c4-editor__inspector-form' }, [
        dom.el('h3', { class: 'c4-editor__inspector-title', tabindex: '-1', 'data-c4-focus-key': 'title', text: title }),
        subtitle ? dom.el('p', { class: 'c4-editor__inspector-subtitle', text: subtitle }) : null,
        children,
      ]);
    }

    function gone(text) {
      return dom.el('p', { class: 'c4-editor__inspector-empty', tabindex: '-1', 'data-c4-focus-key': 'empty', text });
    }

    /** A labelled group of fields (`role="group"` named by its visible label). */
    function group(key, label, children, extraClass = '') {
      const labelId = ids(`insp-${slug(key)}-group`);
      return dom.el('div', { class: `c4-editor__field-group ${extraClass}`.trim(), role: 'group', 'aria-labelledby': labelId }, [
        dom.el('p', { id: labelId, class: 'c4-editor__field-label', text: label }),
        children,
      ]);
    }

    /**
     * One checkbox per choice, as a labelled group; `onToggle(value, checked)` writes the change. Each toggle rewrites
     * the whole list at `path`, so a lock on any of its entries freezes every box.
     */
    function checkboxGroup({ key, label, choices, checked, path, onToggle, empty }) {
      const locked = touchesLock(path) ? (lockReason(path) || TEXT.locked) : null;
      return group(key, label, [
        locked ? dom.el('p', { class: 'c4-editor__lock-note', text: locked }) : null,
        choices.length === 0 ? dom.el('p', { class: 'c4-editor__field-hint', text: empty })
          : choices.map((choice) => field({ key: `${key}-${choice.value}`, label: choice.label, control: 'checkbox', locked, quietLock: true,
            value: checked.includes(choice.value), path, lintPath: null, onCommit: (on) => onToggle(choice.value, on) })),
      ], 'c4-editor__checkbox-group');
    }

    return {
      readOnlyReason, lockReason, touchesLock, addRowUnlessLocked, run, problem, problemsFor, problemText, field, formSection,
      disclosure, openDisclosure, button, isScaffoldOn, listEditor, textList, form, gone, group, checkboxGroup,
    };
  }

  return { createFormKit };
});
