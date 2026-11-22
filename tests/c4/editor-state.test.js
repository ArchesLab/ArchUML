'use strict';

// The C4 editor's DOM-free state controller (js/ArchUML/c4/editor/c4-editor-state.js): text, edits and the host
// contract of spec §3.4, undo (§9.2), the read-only mode for YAML errors (§7.3), and diagnostics display (§7.2, §9.3).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadCore, fixture, rulesOf } = require('./helpers.js');

const ARCHUML_ROOT = path.join(__dirname, '..', '..');
const STATE_MODULE = path.join(ARCHUML_ROOT, 'c4', 'editor', 'c4-editor-state.js');
const manifest = JSON.parse(fs.readFileSync(path.join(ARCHUML_ROOT, 'c4', 'manifest.json'), 'utf8'));
const { createEditorState } = require(STATE_MODULE);
const core = loadCore();

const REFERENCE = fixture('course-registration.yml');

// A small model whose checks give, on `store`, two incompleteness warnings (c4/no-description,
// rdd/no-responsibility) and an info (c4/no-technology); on `shop`, the infos xlevel/unreceived (the reader's
// relationship reaches no container), xlevel/unsent (the relationship to the mailer leaves from no container), and
// rdd/unrefined.
const BOOKSHOP = `schema: c4-design/1
people:
  reader:
    name: Reader
    description: Buys books for their own shelf.
    collaborators:
      shop: browses and orders books using
systems:
  shop:
    name: Bookshop
    description: Sells books to readers over the web.
    responsibilities:
      - do: take an order for a book and keep it until it ships
    collaborators:
      mailer: sends order confirmations through
    containers:
      web:
        name: Shop Web App
        technology: TypeScript
        description: Shows the catalogue and takes orders.
        responsibilities:
          - do: take an order for a book and keep it until it ships
        collaborators:
          store: {description: saves orders in, technology: SQL}
      store:
        name: Order Store
        kind: database
  mailer:
    name: Mail Service
    external: true
    description: Delivers email for online shops.
    responsibilities:
      - do: deliver an email to a reader
`;

/** A host that records every callback; `extra` adds or replaces members. */
function recordingHost(extra) {
  const calls = { text: [], view: [], selection: [] };
  const host = Object.assign({
    onTextChange(text, info) { calls.text.push({ text, info }); },
    onViewChange(selector) { calls.view.push(selector); },
    onSelectionChange(selection) { calls.selection.push(selection); },
  }, extra);
  return { host, calls };
}

/** A clock the test moves by hand. */
function fakeClock(start = 1000) {
  let now = start;
  return { now: () => now, advance(ms) { now += ms; } };
}

function applySplices(text, edits) {
  return edits.slice().sort((a, b) => b.offset - a.offset)
    .reduce((current, edit) => current.slice(0, edit.offset) + edit.text + current.slice(edit.offset + edit.length), text);
}

function setTechnology(elementId, value) {
  return { op: 'setElementField', elementId, field: 'technology', value };
}

function technologyOf(state, elementId) {
  return core.load(state.getText()).model.elements.get(elementId).technology;
}

const BROKEN_YAML = `${REFERENCE}\nextra: [unclosed\n`;

// ---- Loading ---------------------------------------------------------------------------------

test('the manifest loads the core, then the editor files, in a classic-script context and publishes the state part', () => {
  assert.ok(manifest.editor.includes('c4/editor/c4-editor-state.js'));
  assert.ok(manifest.editor.indexOf('c4/editor/c4-editor-dom.js') < manifest.editor.indexOf('c4/editor/c4-editor-state.js'));
  const context = vm.createContext({});
  context.self = context;
  manifest.core.concat(manifest.editor).forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(ARCHUML_ROOT, file), 'utf8'), context, { filename: file });
  });
  assert.equal(vm.runInContext('typeof ArchUMLC4EditorParts.state.createEditorState', context), 'function');
  assert.equal(vm.runInContext('typeof ArchUMLC4EditorParts.dom.el', context), 'function');
  const text = vm.runInContext(
    `ArchUMLC4EditorParts.state.createEditorState({ text: ${JSON.stringify(BOOKSHOP)}, host: { onTextChange() {} } }).getView()`,
    context);
  assert.equal(text, 'context of shop');
});

test('the host contract is checked when the state is created', () => {
  assert.throws(() => createEditorState({ text: BOOKSHOP, host: {} }), TypeError);
  assert.throws(() => createEditorState({ text: BOOKSHOP, host: { onTextChange() {}, undo: 'host', performUndo() {} } }), TypeError);
});

// ---- Edits and the host ----------------------------------------------------------------------

test('an edit emits the new text, the splice edits, and an incremented version', () => {
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host });

  const first = state.dispatch(setTechnology('api', 'Go, Gin'));
  const second = state.dispatch(setTechnology('web', 'Elm'), { label: 'Change technology' });

  assert.deepEqual([first.ok, second.ok], [true, true]);
  assert.equal(calls.text.length, 2);
  const [one, two] = calls.text;
  assert.equal(applySplices(REFERENCE, one.info.edits), one.text);
  assert.equal(applySplices(one.text, two.info.edits), two.text);
  assert.equal(one.info.reason, 'edit');
  assert.equal(two.info.version, one.info.version + 1);
  assert.equal(two.info.label, 'Change technology');
  assert.equal(typeof one.info.label, 'string');
  assert.equal(state.getText(), two.text);
  assert.equal(technologyOf(state, 'api'), 'Go, Gin');
  assert.equal(technologyOf(state, 'web'), 'Elm');
});

test('dispatch returns and selects the core selection, and a refused command emits nothing', () => {
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host });

  const added = state.dispatch({ op: 'addElement', parentId: 'api', type: 'component', name: 'Seat Ledger' });
  assert.deepEqual(added.selection, { elementId: 'seat-ledger' });
  assert.deepEqual(state.getSelection(), { elementId: 'seat-ledger' });
  assert.deepEqual(calls.selection.at(-1), { elementId: 'seat-ledger' });

  const before = state.getText();
  const refused = state.dispatch(setTechnology('no-such-element', 'Go'));
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'unknown-element');
  assert.match(refused.message, /no-such-element/);
  assert.equal(state.getText(), before);
  assert.equal(calls.text.length, 1);
});

test('setText never calls onTextChange and ignores the editor\'s own echo', () => {
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host });
  const seen = [];
  state.on('text', (text, info) => seen.push(info.reason));

  state.dispatch(setTechnology('api', 'Go'));
  const emitted = calls.text[0].text;
  state.setText(emitted, { reason: 'external' });
  assert.deepEqual(seen, ['edit'], 'the echo of the emitted text is a no-op');

  const external = emitted.replace('Planner Web App', 'Schedule Planner');
  state.setText(external, { reason: 'external' });
  assert.equal(state.getText(), external);
  assert.deepEqual(seen, ['edit', 'external']);
  assert.equal(calls.text.length, 1, 'setText never reaches the host');

  state.setText(emitted, { reason: 'external' });
  assert.equal(state.getText(), emitted, 'after other host text, the earlier text is a real change again');
  assert.equal(calls.text.length, 1);
});

test('external text keeps the current view and the selection when the element still exists', () => {
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host, view: 'components of api' });
  state.select('policy');

  state.setText(REFERENCE.replace('Registration Coordinator', 'Enrollment Coordinator'), { reason: 'external' });
  assert.equal(state.getView(), 'components of api');
  assert.deepEqual(state.getSelection(), { elementId: 'policy' });

  const withoutPolicy = core.edit(core.load(state.getText()), { op: 'deleteElement', elementId: 'policy' });
  state.setText(withoutPolicy.text, { reason: 'external' });
  assert.equal(state.getView(), 'components of api');
  assert.equal(state.getSelection(), null, 'a selection whose element is gone is cleared');
  assert.equal(calls.selection.at(-1), null);

  const withoutApi = core.edit(core.load(state.getText()), { op: 'deleteElement', elementId: 'api' });
  state.setText(withoutApi.text, { reason: 'external' });
  assert.equal(state.getView(), 'context of registration', 'a view whose scope is gone falls back to the default view');
  assert.equal(calls.view.at(-1), 'context of registration');
});

test('listeners of a text change already see the mode, view, and selection of the new text', () => {
  const state = createEditorState({ text: REFERENCE, host: recordingHost().host, view: 'components of api' });
  state.select('policy');
  const seen = [];
  state.on('text', () => seen.push({ readOnly: state.isReadOnly(), view: state.getView(), selection: state.getSelection() }));

  state.setText(core.edit(core.load(REFERENCE), { op: 'deleteElement', elementId: 'api' }).text, { reason: 'external' });
  state.setText(BROKEN_YAML, { reason: 'external' });
  assert.deepEqual(seen, [
    { readOnly: false, view: 'context of registration', selection: null },
    { readOnly: true, view: 'context of registration', selection: null },
  ]);
});

test('openView with an unknown selector opens the default view and reports the problem', () => {
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host, view: 'components of nowhere' });
  assert.equal(state.getView(), 'context of registration');
  assert.equal(state.getViewProblem().rule, 'view/unknown-selector');

  const opened = state.openView('containers of registration');
  assert.equal(opened.ok, true);
  assert.equal(state.getView(), 'containers of registration');
  assert.equal(state.getViewProblem(), null);
  assert.deepEqual(calls.view, ['containers of registration']);

  const unknown = state.openView('components of nowhere');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.problem.rule, 'view/unknown-selector');
  assert.equal(state.getView(), 'context of registration');
});

test('YAML errors switch to read-only mode and keep the last valid model', () => {
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host, view: 'containers of registration' });
  const modes = [];
  state.on('mode', (mode) => modes.push(mode.readOnly));
  assert.equal(state.isReadOnly(), false);

  state.setText(BROKEN_YAML, { reason: 'external' });
  assert.equal(state.isReadOnly(), true);
  assert.equal(state.getMode().reason, 'yaml-errors');
  assert.deepEqual(rulesOf(state.getMode().errors), ['yaml/syntax']);
  assert.equal(state.getText(), BROKEN_YAML, 'the YAML surface shows the text as typed');
  assert.ok(state.getDesign().model.elements.has('api'), 'the last valid model stays available');
  assert.equal(state.getView(), 'containers of registration');

  const refused = state.dispatch(setTechnology('api', 'Go'));
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'yaml-errors');
  assert.equal(typeof refused.message, 'string');
  assert.equal(calls.text.length, 0);

  state.setText(REFERENCE, { reason: 'external' });
  assert.equal(state.isReadOnly(), false);
  assert.deepEqual(modes, [true, false]);
});

test('the readOnly option refuses every edit', () => {
  const { host } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host, readOnly: true });
  assert.equal(state.isReadOnly(), true);
  assert.equal(state.getMode().reason, 'read-only');
  assert.equal(state.dispatch(setTechnology('api', 'Go')).ok, false);
  assert.equal(state.getText(), REFERENCE);
});

test('text typed in the YAML surface reaches the host as a source change', () => {
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host });
  const typed = REFERENCE.replace('Planner Web App', 'Planner App');
  state.applySourceText(typed);
  assert.equal(calls.text.length, 1);
  assert.equal(calls.text[0].info.reason, 'source');
  assert.equal(applySplices(REFERENCE, calls.text[0].info.edits), typed);

  state.applySourceText(BROKEN_YAML);
  assert.equal(calls.text.length, 2, 'text with YAML errors is still the learner\'s text');
  assert.equal(state.isReadOnly(), true);
});

// ---- Undo ------------------------------------------------------------------------------------

test('undo and redo restore text snapshots and coalesce edits within 600 ms', () => {
  const clock = fakeClock();
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host, now: clock.now });
  assert.equal(state.canUndo(), false);

  state.dispatch(setTechnology('api', 'Go'));
  clock.advance(600);
  state.dispatch(setTechnology('api', 'Go, Gin'));
  const coalesced = state.getText();
  clock.advance(601);
  state.dispatch(setTechnology('api', 'Rust'));

  assert.equal(state.undo(), true);
  assert.equal(state.getText(), coalesced);
  assert.equal(state.undo(), true, 'the two edits 600 ms apart form one step');
  assert.equal(state.getText(), REFERENCE);
  assert.equal(state.canUndo(), false);
  assert.equal(state.undo(), false);
  assert.equal(calls.text.at(-1).info.reason, 'undo');
  assert.equal(calls.text.at(-1).text, REFERENCE, 'undo reaches the host like any other change');

  assert.equal(state.redo(), true);
  assert.equal(state.getText(), coalesced);
  assert.equal(calls.text.at(-1).info.reason, 'redo');
  assert.equal(applySplices(REFERENCE, calls.text.at(-1).info.edits), coalesced);

  clock.advance(100);
  state.dispatch(setTechnology('web', 'Elm'));
  assert.equal(state.canRedo(), false, 'a new edit clears redo');
  assert.equal(state.undo(), true);
  assert.equal(state.getText(), coalesced, 'an edit right after redo is its own step');
});

test('undo keeps at most 100 steps', () => {
  const clock = fakeClock();
  const { host } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host, now: clock.now });
  for (let step = 0; step <= 100; step += 1) {
    clock.advance(1000);
    state.dispatch(setTechnology('api', `Go ${step}`));
  }
  let undone = 0;
  while (state.undo()) undone += 1;
  assert.equal(undone, 100);
  assert.equal(technologyOf(state, 'api'), 'Go 0', 'the oldest step is dropped');
});

test('host undo mode delegates to host methods', () => {
  const asked = [];
  const { host, calls } = recordingHost({
    undo: 'host',
    performUndo() { asked.push('undo'); },
    performRedo() { asked.push('redo'); },
    canUndo() { asked.push('canUndo'); return true; },
    canRedo() { asked.push('canRedo'); return false; },
  });
  const state = createEditorState({ text: REFERENCE, host });

  state.dispatch(setTechnology('api', 'Go'));
  assert.equal(state.canUndo(), true);
  assert.equal(state.canRedo(), false);
  state.undo();
  state.redo();
  assert.deepEqual(asked, ['canUndo', 'canRedo', 'undo', 'redo']);
  assert.equal(calls.text.length, 1, 'the editor changes no text itself in host mode');
  assert.equal(technologyOf(state, 'api'), 'Go');
});

// ---- Diagnostics -----------------------------------------------------------------------------

test('diagnostics honour checks.display live, on-request, and after-submit', () => {
  const expected = rulesOf(core.check(core.load(BOOKSHOP)));
  assert.ok(expected.includes('c4/no-description'));
  const stateWith = (display) => createEditorState({ text: BOOKSHOP, host: recordingHost().host, checks: { display } });

  assert.ok(expected.includes('c4/no-technology'));
  const live = stateWith('live');
  const liveChanges = [];
  live.on('diagnostics', (diagnostics) => liveChanges.push(rulesOf(diagnostics)));
  assert.deepEqual(rulesOf(live.getDiagnostics()), expected);
  live.dispatch(setTechnology('store', 'PostgreSQL'));
  const afterEdit = rulesOf(core.check(core.load(live.getText())));
  assert.equal(afterEdit.includes('c4/no-technology'), false);
  assert.deepEqual(rulesOf(live.getDiagnostics()), afterEdit, 'live diagnostics follow every edit');
  assert.deepEqual(liveChanges, [afterEdit], 'the diagnostics event carries the diagnostics of the new text');

  const onRequest = stateWith('on-request');
  const released = [];
  onRequest.on('diagnostics', (diagnostics) => released.push(rulesOf(diagnostics)));
  assert.deepEqual(onRequest.getDiagnostics(), []);
  onRequest.checkNow();
  assert.deepEqual(rulesOf(onRequest.getDiagnostics()), expected);
  assert.deepEqual(released, [expected]);

  const afterSubmit = stateWith('after-submit');
  assert.deepEqual(afterSubmit.getDiagnostics(), []);
  afterSubmit.checkNow();
  assert.deepEqual(afterSubmit.getDiagnostics(), [], 'Check now does not release after-submit diagnostics');
  afterSubmit.dispatch(setTechnology('store', 'PostgreSQL'));
  assert.deepEqual(afterSubmit.getDiagnostics(), [], 'edits before Submit for review show nothing');
  afterSubmit.submitForReview();
  assert.deepEqual(rulesOf(afterSubmit.getDiagnostics()), rulesOf(core.check(core.load(afterSubmit.getText()))));
  assert.equal(rulesOf(afterSubmit.getDiagnostics()).includes('c4/no-technology'), false, 'released diagnostics follow the text');
});

test('the checks configuration is applied to the diagnostics', () => {
  const state = createEditorState({
    text: BOOKSHOP, host: recordingHost().host,
    checks: { disable: ['rdd/unrefined'], severity: { 'c4/no-technology': 'warning' } },
  });
  const diagnostics = state.getDiagnostics();
  assert.equal(rulesOf(diagnostics).includes('rdd/unrefined'), false);
  assert.equal(diagnostics.find((found) => found.rule === 'c4/no-technology').severity, 'warning');
});

test('novice profile hides info diagnostics and incompleteness rules on untouched elements', () => {
  const state = createEditorState({ text: BOOKSHOP, host: recordingHost().host, profile: 'novice' });
  const changes = [];
  state.on('diagnostics', (diagnostics) => changes.push(rulesOf(diagnostics)));

  assert.deepEqual(rulesOf(state.getDiagnostics()).sort(), ['xlevel/unreceived', 'xlevel/unsent'],
    'info rules are hidden except xlevel/unreceived and xlevel/unsent; untouched store has no incompleteness findings');

  state.markTouched('store');
  assert.deepEqual(rulesOf(state.getDiagnostics()).sort(),
    ['c4/no-description', 'rdd/no-responsibility', 'xlevel/unreceived', 'xlevel/unsent']);
  assert.equal(changes.length, 1);
  state.markTouched('store');
  assert.equal(changes.length, 1, 'touching an element twice changes nothing');

  const raised = createEditorState({
    text: BOOKSHOP, host: recordingHost().host, profile: 'novice', checks: { severity: { 'rdd/unrefined': 'warning' } },
  });
  assert.ok(rulesOf(raised.getDiagnostics()).includes('rdd/unrefined'), 'a rule raised above info is shown');

  const expert = createEditorState({ text: BOOKSHOP, host: recordingHost().host, profile: 'expert' });
  assert.deepEqual(rulesOf(expert.getDiagnostics()), rulesOf(core.check(core.load(BOOKSHOP))));
});

// interfaces-shop.yml: the external `payments` system provides `card-payments`, whose `refund` operation has neither a
// purpose nor errors (interface/no-purpose and interface/no-errors, warnings that name `payments` as the element
// and `card-payments` as the interface); the `shop` system has no responsibilities (rdd/no-responsibility, a warning).
test('novice profile defers an interface\'s incompleteness until the interface itself is touched', () => {
  const SHOP = fixture('interfaces-shop.yml');
  const INTERFACE_RULES = ['interface/no-errors', 'interface/no-purpose'];
  const novice = () => createEditorState({ text: SHOP, host: recordingHost().host, profile: 'novice' });
  const interfaceFindings = (state) => state.getDiagnostics()
    .filter((diagnostic) => diagnostic.interface === 'card-payments').map((diagnostic) => diagnostic.rule).sort();
  assert.deepEqual(rulesOf(core.check(core.load(SHOP)).filter((found) => found.interface === 'card-payments'
    && found.severity === 'warning')).sort(), INTERFACE_RULES);

  const byInterface = novice();
  assert.deepEqual(byInterface.getDiagnostics(), [], 'nothing is touched yet');
  byInterface.markTouched('card-payments');
  assert.deepEqual(interfaceFindings(byInterface), INTERFACE_RULES, 'touching the interface shows its findings');
  assert.deepEqual(rulesOf(byInterface.getDiagnostics()).sort(), INTERFACE_RULES,
    'the untouched provider and the untouched shop keep their own incompleteness hidden');

  const byProvider = novice();
  byProvider.markTouched('payments');
  byProvider.markTouched('shop');
  assert.deepEqual(rulesOf(byProvider.getDiagnostics()), ['rdd/no-responsibility'],
    'touching elements shows their findings but not those of the untouched interface their provider offers');
});

test('listeners are removed by the function on returns', () => {
  const state = createEditorState({ text: REFERENCE, host: recordingHost().host });
  const seen = [];
  const unsubscribe = state.on('selection', (selection) => seen.push(selection));
  state.select('api');
  unsubscribe();
  state.select('web');
  assert.deepEqual(seen, [{ elementId: 'api' }]);
  assert.throws(() => state.on('no-such-event', () => {}), TypeError);
});

// ---- Locked fields (spec §11) ------------------------------------------------------------------
//
// One lock rule for every surface: `isLockedPath` says whether a lock covers a path; `touchesLockedPath` whether a
// write that replaces the node at a path would reach a lock (the lock covers it, or lies inside it). The state
// enforces locks itself, so a command from any part that would change a locked node is refused with the path named.

const { isLockedPath, touchesLockedPath, lockedNodeOf } = require(STATE_MODULE);
const API = 'systems.registration.containers.api';

test('lockedNodeOf names the node a write must restore to keep a lock: the locked node, or the path that holds one', () => {
  const locks = ['requirements', `${API}.collaborators.*.technology`];
  const at = (dotted) => dotted.split('.');

  assert.deepEqual(lockedNodeOf(at('requirements.FR-21'), locks), ['requirements'], 'the lock covering the change');
  assert.deepEqual(lockedNodeOf(at(`${API}.collaborators.db.technology`), locks), at(`${API}.collaborators.db.technology`),
    'a wildcard lock matched to the entry');
  assert.deepEqual(lockedNodeOf(at(`${API}.collaborators.db`), locks), at(`${API}.collaborators.db`), 'a node that holds a lock');
  assert.equal(lockedNodeOf(at(`${API}.collaborators.db.description`), locks), null, 'a free path');
  assert.deepEqual(lockedNodeOf(at('requirements.FR-21'), [`${API}`, 'requirements.FR-21', 'requirements']), ['requirements'],
    'the outermost of two locks');
});

test('touchesLockedPath is true for a path a lock covers and for a path that holds a lock', () => {
  const locks = [`${API}.responsibilities.0`, `${API}.collaborators.*.technology`];
  const at = (dotted) => dotted.split('.');

  assert.equal(touchesLockedPath(at(`${API}.responsibilities.0.decide`), locks), true, 'covered by a lock');
  assert.equal(touchesLockedPath(at(`${API}.responsibilities`), locks), true, 'holds a locked item');
  assert.equal(touchesLockedPath(at(API), locks), true, 'holds a lock deeper down');
  assert.equal(touchesLockedPath(at(`${API}.collaborators.db`), locks), true, 'a wildcard lock lies inside every collaborator');
  assert.equal(touchesLockedPath(at(`${API}.responsibilities.1`), locks), false, 'a sibling item is free');
  assert.equal(touchesLockedPath(at(`${API}.collaborators.db.description`), locks), false, 'a sibling field is free');
  assert.equal(touchesLockedPath(at('systems.registration.containers.web'), locks), false, 'another element is free');
  assert.equal(touchesLockedPath(at(API), []), false, 'no locks, nothing touched');
  assert.equal(isLockedPath(at(`${API}.responsibilities`), locks), false, 'holding a lock is not being covered by one');
});

test('dispatch refuses a command that would change a locked node, names it, and emits nothing', () => {
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host, lockedFields: [`${API}.technology`] });

  const refused = state.dispatch(setTechnology('api', 'Go, Gin'));

  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'locked');
  assert.equal(refused.message, `Locked: ${nameOf('api')} or a part of it is given by the task, so it cannot be changed here.`,
    'the learner hears the element, not the YAML path');
  assert.equal(refused.lockedPath, `${API}.technology`, 'the path stays available to the host and diagnostics');
  assert.equal(state.getText(), REFERENCE);
  assert.equal(calls.text.length, 0, 'the host hears no change');
  assert.equal(state.canUndo(), false, 'a refusal leaves no undo step');
});

test('dispatch with locks still applies a command that changes only unlocked nodes', () => {
  const state = createEditorState({ text: REFERENCE, host: recordingHost().host, lockedFields: [`${API}.technology`] });

  const changed = state.dispatch({ op: 'setElementField', elementId: 'api', field: 'description', value: 'Enrolls students.' });

  assert.equal(changed.ok, true);
  assert.equal(core.load(state.getText()).model.elements.get('api').description, 'Enrolls students.');
  assert.equal(technologyOf(state, 'api'), 'Python, FastAPI');
});

test('dispatch refuses a reorder that moves a locked list item, and an entry a wildcard lock would cover', () => {
  const state = createEditorState({
    text: REFERENCE, host: recordingHost().host,
    lockedFields: [`${API}.responsibilities.0`, 'systems.registration.containers.web.collaborators.*'],
  });

  const moved = state.dispatch({ op: 'moveResponsibility', elementId: 'api', from: 1, to: 0 });
  const added = state.dispatch({ op: 'addRelationship', sourceId: 'web', targetId: 'db', description: 'reads courses from' });

  assert.deepEqual([moved.ok, moved.error], [false, 'locked'], 'the locked first item would move');
  assert.deepEqual([added.ok, added.error], [false, 'locked'], 'a new collaborator falls under collaborators.*');
  assert.equal(state.getText(), REFERENCE);
});

test('lockRefusal gives the refusal a command would get, naming the element and the deletion, without changing anything', () => {
  const { host, calls } = recordingHost();
  const state = createEditorState({ text: REFERENCE, host, lockedFields: [`${API}.components.seats.name`] });

  const refusal = state.lockRefusal({ op: 'deleteElement', elementId: 'seats' });

  assert.equal(refusal.message, `Locked: ${nameOf('seats')} or a part of it is given by the task, so it cannot be deleted here.`);
  assert.equal(refusal.lockedPath, `${API}.components.seats.name`);
  assert.equal(state.lockRefusal({ op: 'deleteElement', elementId: 'web' }), null);
  assert.equal(state.getText(), REFERENCE);
  assert.equal(calls.text.length, 0);
});

test('a refused rename says the element cannot be renamed', () => {
  const state = createEditorState({ text: REFERENCE, host: recordingHost().host, lockedFields: [`${API}.name`] });

  const refused = state.dispatch({ op: 'setElementField', elementId: 'api', field: 'name', value: 'Enrollment API' });

  assert.equal(refused.message, `Locked: ${nameOf('api')} or a part of it is given by the task, so it cannot be renamed here.`);
});

test('refusalText shows a lock refusal as it is and prefixes any other refusal with Error', () => {
  const state = createEditorState({ text: REFERENCE, host: recordingHost().host, lockedFields: [`${API}.name`] });
  const locked = state.dispatch({ op: 'setElementField', elementId: 'api', field: 'name', value: 'Enrollment API' });

  assert.equal(state.refusalText(locked), locked.message);
  assert.equal(state.refusalText({ ok: false, error: 'duplicate-id', message: 'The id web is taken' }), 'Error: The id web is taken.');
});

test('refusalText finishes a sentence that already ends in a question or exclamation mark without adding a full stop', () => {
  const state = createEditorState({ text: REFERENCE, host: recordingHost().host });

  assert.equal(state.refusalText({ ok: false, error: 'invalid', message: 'Which branch is meant?' }), 'Error: Which branch is meant?');
  assert.equal(state.refusalText({ ok: false, error: 'invalid', message: 'Name it first!' }), 'Error: Name it first!');
  assert.equal(state.refusalText({ ok: false, error: 'invalid', message: 'A guard is text' }), 'Error: A guard is text.');
});

function nameOf(elementId) {
  return core.load(REFERENCE).model.elements.get(elementId).name;
}
