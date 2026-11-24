'use strict';

// The deployment view planner (UML-view editing spec §5.4, §7.3; plan Task 43): what each gesture on a deployment
// view, `deployment ‹environment›` drawn as a UML deployment diagram, changes in design.yml, and when it is refused.
// Each row runs through the C4 model adapter (plan Task 36) on a real editor state, the real C4 core, and the real
// shared actions, so the oracle is the model the editor holds afterwards, or the refusal's code with the text
// unchanged. Dialogs are fakes: the link form answers with the fields a learner would type, the editor's menu (the
// `choose` form) chooses the item a learner would, and the relationship form records how it was opened.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCore, fixture } = require('./helpers.js');

const C4 = loadCore();
const EDITOR = path.join(__dirname, '..', '..', 'c4', 'editor');
const { createEditorState } = require(path.join(EDITOR, 'c4-editor-state.js'));
const { createActions } = require(path.join(EDITOR, 'c4-editor-actions.js'));
const refusals = require(path.join(EDITOR, 'c4-editor-uml-refusals.js'));
const layout = require(path.join(EDITOR, 'c4-editor-uml-layout.js'));
const { createUmlAdapter } = require(path.join(EDITOR, 'c4-editor-uml-adapter.js'));
const { modelWideWording, placeholderName } = require(path.join(EDITOR, 'c4-editor-actions-shared.js'));
const deploymentView = require(path.join(EDITOR, 'c4-editor-uml-deployment.js'));
const { revisionOf } = require(path.join(__dirname, '..', '..', 'diagram-editor', 'de-operations.js'));

// uml-editing.yml hosts the Registration API twice (API pod and Canary pod); course-registration-interfaces.yml links
// the Web browser to the API pod through the ingress, so a relationship between their elements draws no line.
const DESIGN = fixture('uml-editing.yml');
const LINKED = fixture('course-registration-interfaces.yml');
const VIEW = 'deployment production';
const ENVIRONMENT = 'production';
// The drawn places of the top-level nodes, as a move's scene facts give them (drawing units).
const DRAWN = { laptop: { x: 20, y: 20 }, campus_cloud: { x: 400, y: 20 }, data_centre: { x: 1200, y: 20 },
  browser: { x: 40, y: 60 }, api_pod: { x: 640, y: 80 } };
// Every top-level node kept at a place: a view that holds positions.
const PINNED = `${DESIGN}layout:\n  ${VIEW}:\n    positions:\n      laptop: [20, 20]\n      campus-cloud: [400, 20]\n      data-centre: [1200, 20]\n`;

// ---- The harness ----------------------------------------------------------------------------------------------

/**
 * An editor on `text` with the deployment view open: its state, the real shared actions (confirmations answer yes,
 * and `confirms` records each question), and the adapter serving the deployment module. `menuChoice(spec)` picks the
 * label the fake menu chooses; `linkForm(initial)` gives the fields the fake link form answers with.
 */
function harness({ text = DESIGN, menuChoice = () => null, linkForm = () => null, lockedFields } = {}) {
  const changes = [];
  const confirms = [];
  const menus = [];
  const links = [];
  const relationshipForms = [];
  const calls = [];
  let clock = 0;
  const state = createEditorState({ text, view: VIEW, profile: 'expert', lockedFields, now: () => (clock += 1000),
    host: { onTextChange: (changed, info) => changes.push(info) } });
  const dom = { createMenus: () => ({}), createAnnouncer: () => () => {} };
  const actions = createActions({}, { state, dom, ids: { next: (prefix) => prefix }, announce: () => {}, host: { confirm: async () => true } });
  ['renameNode', 'renameElement'].forEach((name) => {
    const real = actions[name];
    actions[name] = (...args) => { calls.push({ name, args }); return real(...args); };
  });
  actions.openRelationshipForm = (target, placement) => {
    relationshipForms.push({ target, placement });
    return Promise.resolve({ ok: false, cancelled: true });
  };
  const dialogs = {
    openMenu(spec) {
      menus.push(spec);
      const wanted = menuChoice(spec);
      const item = spec.groups[0].items.find((candidate) => candidate.label === wanted);
      if (item && !item.unavailable) item.run();
      spec.onClose();
    },
  };
  const forms = { link: (initial) => { links.push(initial); const typed = linkForm(initial); return Promise.resolve(typed ? Object.assign({ link: initial.link }, typed) : null); } };
  const adapter = createUmlAdapter({ state, actions, views: { 'uml-deployment': deploymentView }, refusals, layout, profile: 'expert',
    confirm: (request) => { confirms.push(request); return Promise.resolve(true); }, dialogs, forms });
  return { state, adapter, changes, confirms, menus, links, relationshipForms, calls, model: () => state.getDesign().model };
}

/** The module's context for the deployment view of `text`, as the adapter builds it (plan Task 34). */
function contextOf(text = DESIGN) {
  const design = C4.load(text);
  const viewModel = C4.project(design, VIEW);
  const uml = C4.toUml(viewModel);
  return { design, viewModel, uml, profile: 'expert', checksReleased: true, revision: revisionOf(uml.text), layout: viewModel.layout, droppedRoutes: [] };
}

/** An operation built against the adapter's current reading. */
function operation(h, op, fields = {}) {
  return Object.assign({ op, revision: h.adapter.contents().revision }, fields);
}

/** The `rel:<n>` ref of the drawn line from the box `from` to the box `to` (aliases, as drawn). */
function lineRef(h, from, to) {
  const relation = h.adapter.contents().relations.find((candidate) => candidate.from === from && candidate.to === to);
  assert.ok(relation, `the drawing has a line from ${from} to ${to}`);
  return `rel:${relation.line}`;
}

async function assertRefused(h, op, code) {
  const before = h.state.getText();
  const verdict = await h.adapter.apply(op);
  assert.equal(verdict.ok, false, `${op.op} is refused`);
  assert.equal(verdict.code, code, `${op.op} is refused with ${code} (${verdict.message})`);
  assert.equal(h.state.getText(), before, 'no text changed');
  return verdict;
}

async function assertApplied(h, op) {
  const verdict = await h.adapter.apply(op);
  assert.equal(verdict.ok, true, `${op.op} is accepted (${verdict.code}: ${verdict.message})`);
  assert.equal(h.changes.length, 1, 'one change, so one undo step');
  return verdict;
}

const node = (h, id) => h.model().environments.get(ENVIRONMENT).nodes.get(id);
const positions = (h) => {
  const entry = h.model().layout.get(VIEW);
  return entry ? Object.fromEntries(entry.positions) : {};
};
const add = (h, fields) => operation(h, 'element.add', Object.assign({ name: null, into: null, anchor: null, placed: 'click', facts: { positions: DRAWN } }, fields));

// ---- Adding nodes and hosting (spec §5.4) ------------------------------------------------------------------------

test('Add Node on empty canvas writes addNode { environmentId: production, parentNodeId: null, name: "New node" } with its position', async () => {
  const h = harness();
  const at = { x: 1600, y: 300 };

  await assertApplied(h, add(h, { tool: 'node', placed: 'dropped', facts: { at, positions: DRAWN } }));

  const added = node(h, 'new-node');
  assert.equal(added.name, placeholderName('node'));
  assert.equal(added.name, 'New node');
  assert.equal(added.parentId, null);
  assert.deepEqual(positions(h), { 'new-node': [1600, 300], laptop: [20, 20], 'campus-cloud': [400, 20], 'data-centre': [1200, 20] },
    'the new node is kept where it was dropped, and the first move pins every top-level node where it is drawn');
});

test('with campus-cloud focused, Add asks "Inside Campus cloud" (the default) or "At the top level"', async () => {
  const h = harness({ menuChoice: (spec) => spec.groups[0].items[0].label });

  await assertApplied(h, add(h, { tool: 'node', into: 'campus_cloud' }));

  assert.deepEqual(h.menus[0].groups[0].items.map((item) => item.label), ['Inside Campus cloud', 'At the top level']);
  assert.equal(node(h, 'new-node').parentId, 'campus-cloud', 'the first answer, the default, puts it inside');
});

test('"At the top level" in the Add question adds the node at the top level', async () => {
  const h = harness({ menuChoice: () => 'At the top level' });

  await assertApplied(h, add(h, { tool: 'node', into: 'campus_cloud' }));

  assert.equal(node(h, 'new-node').parentId, null);
});

test('adding into ingress is infrastructure-leaf', async () => {
  const h = harness();
  await assertRefused(h, add(h, { tool: 'node', into: 'ingress', placed: 'dropped' }), 'infrastructure-leaf');
  await assertRefused(h, add(h, { tool: 'host', into: 'ingress', placed: 'inside' }), 'infrastructure-leaf');
});

test('Add Infrastructure node names it "New infrastructure node" and gives it the kind infrastructure', async () => {
  const h = harness();

  await assertApplied(h, add(h, { tool: 'infrastructure', into: 'campus_cloud', placed: 'inside' }));

  const added = node(h, 'new-infrastructure-node');
  assert.equal(added.name, 'New infrastructure node');
  assert.equal(added.kind, 'infrastructure');
  assert.equal(added.parentId, 'campus-cloud');
});

test('Host a container on data-centre offers the containers and systems it does not host and writes setHosts', async () => {
  const h = harness({ menuChoice: () => 'Registration Database' });
  const model = C4.load(DESIGN).model;
  const expected = [...model.elements.values()].filter((element) => ['system', 'container'].includes(element.type) && element.id !== 'billing')
    .map((element) => element.name);

  await assertApplied(h, add(h, { tool: 'host', into: 'data_centre', placed: 'inside' }));

  assert.deepEqual(h.menus[0].groups[0].items.map((item) => item.label), expected);
  assert.deepEqual(node(h, 'data-centre').hosts, ['billing', 'db']);
});

test('hosting billing again is already-hosted', async () => {
  const h = harness();
  const verdict = await assertRefused(h, add(h, { tool: 'host', name: 'billing', into: 'data_centre', placed: 'inside' }), 'already-hosted');
  assert.equal(verdict.message, refusals.verdict('already-hosted', { Node: 'University data centre', Element: 'Billing System' }).message);
});

test('a component, an artifact, or a note is refused', async () => {
  const h = harness();
  await assertRefused(h, add(h, { tool: 'component' }), 'not-in-model/artifact');
  await assertRefused(h, add(h, { tool: 'artifact' }), 'not-in-model/artifact');
  await assertRefused(h, add(h, { tool: 'note' }), 'not-in-model/note');
  assert.deepEqual(h.adapter.tools().unavailable.map((tool) => `${tool.label}: ${tool.summary}`),
    ['Component: Host a container or system instead', 'Artifact: Host a container or system instead', 'Note: No notes in this design model']);
});

// ---- Nesting (spec §5.4) -------------------------------------------------------------------------------------------

test('Move to… At the top level moves api-pod with moveNode and gives it a free place', async () => {
  const h = harness({ text: PINNED, menuChoice: () => 'At the top level (not inside a node)' });

  await assertApplied(h, operation(h, 'element.reparent', { ref: 'api_pod', parent: null, choose: true }));

  assert.equal(node(h, 'api-pod').parentId, null);
  const free = layout.freePlace({ boxes: null });
  assert.deepEqual(positions(h)['api-pod'], [free.x, free.y], 'it arrives at the free place right of the drawn boxes');
  assert.equal(h.changes[0].label, 'Moved API pod out of Campus cloud to the top level');
});

test('Move to… lists the nodes that can take api-pod, the others disabled with their short reason', async () => {
  const h = harness();

  await h.adapter.apply(operation(h, 'element.reparent', { ref: 'api_pod', parent: null, choose: true }));

  const items = h.menus[0].groups[0].items.map((item) => [item.label, item.note || null]);
  assert.deepEqual(items, [
    ['At the top level (not inside a node)', null],
    ["Student's computer", null],
    ['Web browser', null],
    ['Ingress load balancer', 'Infrastructure hosts nothing'],
    ['Canary pod', null],
    ['Managed database', null],
    ['University data centre', null],
  ]);
  assert.equal(h.changes.length, 0, 'closing the menu changes nothing');
});

test('element.reparent of api-pod onto data-centre writes moveNode', async () => {
  const h = harness();

  await assertApplied(h, operation(h, 'element.reparent', { ref: 'api_pod', parent: 'data_centre' }));

  assert.equal(node(h, 'api-pod').parentId, 'data-centre');
  assert.equal(h.changes[0].label, 'Moved API pod into University data centre');
});

test('campus-cloud into api-pod is node-into-itself', async () => {
  const h = harness();
  await assertRefused(h, operation(h, 'element.reparent', { ref: 'campus_cloud', parent: 'api_pod' }), 'node-into-itself');
  await assertRefused(h, operation(h, 'element.reparent', { ref: 'campus_cloud', parent: 'campus_cloud' }), 'node-into-itself');
});

test('the hosted instance api moved to postgres is two setHosts in one batch', async () => {
  const h = harness();

  await assertApplied(h, operation(h, 'element.reparent', { ref: 'api_api_pod', parent: 'postgres' }));

  assert.deepEqual(node(h, 'api-pod').hosts, []);
  assert.deepEqual(node(h, 'postgres').hosts, ['db', 'api']);
  assert.deepEqual(node(h, 'canary').hosts, ['api'], 'the other copy stays');
});

test('a hosted instance onto a node that hosts its element already is already-hosted', async () => {
  const h = harness();
  await assertRefused(h, operation(h, 'element.reparent', { ref: 'api_canary', parent: 'api_pod' }), 'already-hosted');
});

test('the targets of a moved api-pod mark the nodes that can take it and refuse the others with their codes', () => {
  const advice = deploymentView.targets({ op: 'element.reparent', ref: 'api_pod', open: 'parent' }, contextOf());
  // A hosted element stands for the node it runs on: a drop on it lands on that node.
  assert.deepEqual(Object.fromEntries(advice.map((candidate) => [candidate.ref, candidate.ok ? 'ok' : candidate.code])), {
    laptop: 'ok', browser: 'ok', web: 'ok', campus_cloud: 'layout/inside-node', ingress: 'infrastructure-leaf', api_api_pod: 'node-into-itself',
    canary: 'ok', api_canary: 'ok', postgres: 'ok', db: 'ok', data_centre: 'ok', billing: 'ok',
  });
});

// ---- Renaming and deleting (spec §5.4) -----------------------------------------------------------------------------

test('renaming a node runs actions.renameNode; renaming a hosted instance runs the shared rename with model-wide wording', async () => {
  const nodes = harness();
  await assertApplied(nodes, operation(nodes, 'element.rename', { ref: 'api_pod', text: 'Worker pod' }));
  assert.deepEqual(nodes.calls, [{ name: 'renameNode', args: [ENVIRONMENT, 'api-pod', 'Worker pod'] }]);
  assert.equal(node(nodes, 'api-pod').name, 'Worker pod');

  const instances = harness();
  await assertApplied(instances, operation(instances, 'element.rename', { ref: 'web', text: 'Planner App' }));
  assert.deepEqual(instances.calls, [{ name: 'renameElement', args: ['web', 'Planner App', { wording: 'model-wide' }] }]);
  assert.equal(instances.changes[0].label, modelWideWording.rename('Planner Web App', 'Planner App', null).label);
});

test('a node added on the canvas takes the id of its first name, and a second rename keeps that id', async () => {
  const h = harness();
  await h.adapter.apply(add(h, { tool: 'node' }));
  const alias = Object.keys(h.adapter.contents().elements.reduce((found, element) => Object.assign(found,
    element.ref.nodeId === 'new-node' ? { [element.id]: true } : {}), {}))[0];

  const first = await h.adapter.apply(operation(h, 'element.rename', { ref: alias, text: 'Edge proxy' }));
  assert.equal(first.ok, true);
  assert.equal(node(h, 'edge-proxy').name, 'Edge proxy', 'the first rename gives it the id of its name');

  const second = await h.adapter.apply(operation(h, 'element.rename', { ref: 'edge_proxy', text: 'Front proxy' }));
  assert.equal(second.ok, true);
  assert.equal(node(h, 'edge-proxy').name, 'Front proxy', 'a second rename keeps the id');
});

test('F2 on api-pod starts from "API pod" without "×3"', () => {
  const h = harness();
  const drawn = h.adapter.contents().elements.find((element) => element.id === 'api_pod');
  assert.match(C4.toUml(C4.project(C4.load(DESIGN), VIEW)).text, /"API pod ×3"/, 'the drawing composes the name with its instances');
  assert.equal(drawn.name, 'API pod', 'the in-place editor starts from the name alone');
});

test('deleting a node lists its nested nodes, hosted instances, and links before removeNode', async () => {
  const h = harness();

  await assertApplied(h, operation(h, 'element.remove', { ref: 'campus_cloud' }));

  assert.equal(h.confirms.length, 1, 'one confirmation');
  assert.deepEqual(h.confirms[0].details, [
    'The nested node Ingress load balancer', 'The nested node API pod', 'The nested node Canary pod', 'The nested node Managed database',
    'Registration API on API pod', 'Registration API on Canary pod', 'Registration Database on Managed database',
    'The link from Ingress load balancer to API pod',
  ]);
  assert.equal(node(h, 'campus-cloud'), undefined);
});

test('deleting a hosted instance writes setHosts and says the element stays', async () => {
  const h = harness();

  const verdict = await assertApplied(h, operation(h, 'element.remove', { ref: 'api_canary' }));

  assert.deepEqual(node(h, 'canary').hosts, []);
  assert.ok(h.model().elements.has('api'), 'the element stays in the model');
  assert.match(verdict.message, /Registration API stays in the model\.$/);
});

// ---- Lines (spec §5.4) ---------------------------------------------------------------------------------------------

test('laptop to campus-cloud opens the link form and writes setNodeLink', async () => {
  const h = harness({ linkForm: () => ({ description: 'reaches over the internet', technology: 'HTTPS' }) });

  await assertApplied(h, operation(h, 'relation.add', { tool: 'link', from: 'laptop', to: 'campus_cloud', label: null }));

  assert.deepEqual([h.links[0].sourceName, h.links[0].targetName], ["Student's computer", 'Campus cloud']);
  const link = node(h, 'laptop').relationships.find((candidate) => candidate.targetId === 'campus-cloud');
  assert.deepEqual([link.description, link.technology], ['reaches over the internet', 'HTTPS']);
});

test('Escape in the link form adds nothing', async () => {
  const h = harness();
  const verdict = await h.adapter.apply(operation(h, 'relation.add', { tool: 'link', from: 'laptop', to: 'campus_cloud', label: null }));
  assert.equal(verdict.code, 'cancelled');
  assert.equal(h.changes.length, 0);
});

test('editing a declared link opens the link form with its fields and writes setNodeLink in its place', async () => {
  const h = harness({ linkForm: (initial) => ({ description: `${initial.description} quickly`, technology: 'HTTPS' }) });

  await assertApplied(h, operation(h, 'relation.update', { ref: lineRef(h, 'ingress', 'api_pod'), changes: { label: 'x' } }));

  assert.equal(h.links[0].description, 'forwards HTTPS requests to', 'the form starts from the model\'s description, not the drawn label');
  const link = node(h, 'ingress').relationships.find((candidate) => candidate.targetId === 'api-pod');
  assert.deepEqual([link.description, link.technology], ['forwards HTTPS requests to quickly', 'HTTPS']);
});

test('ingress to api-pod again is link-exists, with the offer to show the declared link\'s source node', async () => {
  const h = harness();
  const verdict = await assertRefused(h, operation(h, 'relation.add', { tool: 'link', from: 'ingress', to: 'api_pod', label: null }), 'link-exists');
  assert.deepEqual(verdict.offer, { kind: 'show-link', label: 'Show the link', select: { environmentId: ENVIRONMENT, nodeId: 'ingress' } });
});

test('laptop to laptop is link-self', async () => {
  const h = harness();
  await assertRefused(h, operation(h, 'relation.add', { tool: 'link', from: 'laptop', to: 'laptop', label: null }), 'link-self');
});

test('a relationship between two hosted instances that node links already carry is added and the message names the link', async () => {
  const h = harness({ text: LINKED });

  const verdict = await h.adapter.apply(operation(h, 'relation.add', { tool: 'relationship', from: 'web', to: 'api', label: null }));

  assert.equal(verdict.code, 'cancelled', 'the fake relationship form was cancelled');
  assert.equal(h.relationshipForms.length, 1);
  assert.deepEqual(h.relationshipForms[0].target, { sourceId: 'web', targetId: 'api' });
  assert.equal(h.relationshipForms[0].placement.lead, 'This adds a relationship to the model: it appears in the C4 views of both elements. '
    + 'No line appears here for it: the links from Web browser to Ingress load balancer and from Ingress load balancer to API pod already lead from Web browser to API pod.');
});

test('a duplicate of such a relationship is refused with the core\'s message, which also names the link', async () => {
  const text = C4.edit(C4.load(LINKED), { op: 'addRelationship', sourceId: 'web', targetId: 'api', description: 'asks for seats from', technology: null }).text;
  const h = harness({ text });

  const verdict = await assertRefused(h, operation(h, 'relation.add', { tool: 'relationship', from: 'web', to: 'api', label: null }), 'duplicate');

  assert.match(verdict.message, /^Error: Planner Web App already has a relationship to Registration API: 'asks for seats from'\./);
  assert.match(verdict.message, /the links from Web browser to Ingress load balancer and from Ingress load balancer to API pod already lead/);
});

test('two instances of one element are same-element-instances with the offer to add a link', async () => {
  const h = harness();
  const verdict = await assertRefused(h, operation(h, 'relation.add', { tool: 'relationship', from: 'api_api_pod', to: 'api_canary', label: null }),
    'same-element-instances');
  assert.deepEqual(verdict.offer, { kind: 'add-link', label: 'Add a link from API pod to Canary pod…',
    operation: { op: 'relation.add', tool: 'link', from: 'api_pod', to: 'canary', label: null } });
});

test('accepting the offer of same-element-instances opens the link form from API pod to Canary pod', async () => {
  const h = harness({ linkForm: () => ({ description: 'mirrors traffic to', technology: null }) });
  const verdict = await assertRefused(h, operation(h, 'relation.add', { tool: 'relationship', from: 'api_api_pod', to: 'api_canary', label: null }),
    'same-element-instances');

  await assertApplied(h, operation(h, verdict.offer.operation.op, verdict.offer.operation));

  assert.deepEqual(h.links.map((initial) => [initial.sourceName, initial.targetName]), [['API pod', 'Canary pod']]);
  assert.deepEqual(node(h, 'api-pod').relationships.filter((link) => link.targetId === 'canary').map((link) => link.description), ['mirrors traffic to']);
});

test('a node and an instance are link-ends', async () => {
  const h = harness();
  await assertRefused(h, operation(h, 'relation.add', { tool: 'link', from: 'laptop', to: 'web', label: null }), 'link-ends');
  await assertRefused(h, operation(h, 'relation.add', { tool: 'relationship', from: 'web', to: 'campus_cloud', label: null }), 'link-ends');
});

test('editing the derived path web to api is derived/path with the offer Show the relationship', async () => {
  const h = harness();
  const verdict = await assertRefused(h, operation(h, 'relation.update', { ref: lineRef(h, 'web', 'api_api_pod'), changes: { label: 'x' } }), 'derived/path');
  assert.deepEqual(verdict.offer, { kind: 'show-relationship', label: 'Show the relationship', select: { relationshipId: 'web->coordinator' } });
  const model = C4.load(DESIGN).model;
  const relationship = model.relationships.find((candidate) => candidate.id === 'web->coordinator');
  assert.equal(verdict.message, refusals.verdict('derived/path', { Source: model.elements.get('web').name,
    Target: model.elements.get('coordinator').name, description: relationship.description }).message);
});

test('moving or deleting a declared link writes batch[removeNodeLink, setNodeLink] or removeNodeLink', async () => {
  const moved = harness();
  await assertApplied(moved, operation(moved, 'relation.rewire', { ref: lineRef(moved, 'ingress', 'api_pod'), end: 'target', to: 'canary' }));
  assert.deepEqual(node(moved, 'ingress').relationships.map((link) => [link.targetId, link.description]), [['canary', 'forwards HTTPS requests to']]);

  const removed = harness();
  await assertApplied(removed, operation(removed, 'selection.remove',
    { elements: [], relations: [lineRef(removed, 'ingress', 'api_pod')], fragments: [], activations: [] }));
  assert.deepEqual(node(removed, 'ingress').relationships, []);
});

test('the targets of a link\'s target end mark the nodes and refuse the hosted elements with link-ends', () => {
  const context = contextOf();
  const ref = `rel:${context.uml.source.lines.findIndex((entry) => entry && entry.kind === 'link' && !entry.derived)}`;
  const advice = deploymentView.targets({ op: 'relation.rewire', ref, end: 'target', to: null, open: 'to' }, context);
  const verdicts = Object.fromEntries(advice.map((candidate) => [candidate.ref, candidate.ok ? 'ok' : candidate.code]));
  assert.equal(verdicts.canary, 'ok');
  assert.equal(verdicts.web, 'link-ends');
  assert.equal(verdicts.ingress, 'link-self');
});

// ---- Layout (spec §5.4, §6) ----------------------------------------------------------------------------------------

test('moving browser without a drop target is layout/inside-node', async () => {
  const h = harness();
  const verdict = await assertRefused(h, operation(h, 'layout.set',
    { positions: { browser: { x: 300, y: 500 } }, routes: [], facts: { positions: DRAWN } }), 'layout/inside-node');
  assert.equal(verdict.message, refusals.verdict('layout/inside-node', { Name: 'Web browser', Parent: "Student's computer" }).message);
});

test('a drag of a nested node may start, while its menu\'s Move… says it is laid out inside its node', () => {
  const h = harness();
  assert.equal(h.adapter.can(operation(h, 'layout.set', { positions: { browser: DRAWN.browser }, routes: [], facts: {} })).ok, true,
    'the drag starts, so it can be dropped on a node');
  assert.equal(h.adapter.can(operation(h, 'layout.set', { positions: { browser: DRAWN.browser }, routes: [] })).code, 'layout/inside-node');
});

test('the first move of laptop pins laptop, campus-cloud, and data-centre', async () => {
  const h = harness();

  await assertApplied(h, operation(h, 'layout.set', { positions: { laptop: { x: 60, y: 30 } }, routes: [], facts: { positions: DRAWN } }));

  assert.deepEqual(positions(h), { laptop: [60, 30], 'campus-cloud': [400, 20], 'data-centre': [1200, 20] });
});

test('only top-level nodes hold positions', () => {
  assert.deepEqual([...deploymentView.holders(contextOf())].sort(), ['campus_cloud', 'data_centre', 'laptop']);
});

// ---- What the view offers (spec §7.3) ------------------------------------------------------------------------------

test('options say kind, technology, and inside <parent> or at the top level; links say declared or derived', () => {
  const sets = deploymentView.optionSets(contextOf());
  assert.deepEqual(sets.map((set) => set.label), ['Nodes', 'Hosted', 'Links']);
  const byName = (set, name) => sets.find((each) => each.label === set).options.find((option) => option.name === name);
  assert.equal(byName('Nodes', 'API pod').description, 'execution environment; Docker; 3 instances; inside Campus cloud');
  assert.equal(byName('Nodes', "Student's computer").description, 'device; at the top level');
  assert.equal(byName('Nodes', 'Ingress load balancer').description, 'infrastructure node; NGINX; inside Campus cloud');
  assert.ok(byName('Hosted', 'Registration API on Canary pod'), 'a hosted element is named with its node');
  assert.equal(byName('Links', 'Ingress load balancer forwards HTTPS requests to API pod').description, 'declared link');
  assert.equal(byName('Links', 'Registration API on API pod writes seat holds to Registration Database').description,
    'derived from the relationship from Seat Gateway to Registration Database; follows the model');
});

test('a node\'s menu adds Move to…, adding inside it, hosting on it, and its kind; an infrastructure node only Move to… and its kind', () => {
  const context = contextOf();
  assert.deepEqual(deploymentView.menu('campus_cloud', context).map((item) => item.label),
    ['Move to…', 'Add a node inside Campus cloud', 'Host a container or system on Campus cloud…', 'Change kind…']);
  assert.deepEqual(deploymentView.menu('ingress', context).map((item) => item.label), ['Move to…', 'Change kind…']);
  assert.deepEqual(deploymentView.menu('web', context).map((item) => item.label), ['Move to…']);
});

test('an option and its selection map to each other', () => {
  const context = contextOf();
  assert.deepEqual(deploymentView.selectionOf('api_pod', context), { environmentId: ENVIRONMENT, nodeId: 'api-pod' });
  assert.equal(deploymentView.refOf({ nodeId: 'api-pod' }, context), 'api_pod');
  assert.deepEqual(deploymentView.selectionOf('api_canary', context), { elementId: 'api' });
  assert.equal(deploymentView.refOf({ environmentId: ENVIRONMENT, nodeId: 'canary' }, context), 'canary');
});

test('a locked layout refuses a move with locked', async () => {
  const h = harness({ lockedFields: ['layout'], text: PINNED });
  await assertRefused(h, operation(h, 'layout.set', { positions: { laptop: { x: 60, y: 30 } }, routes: [], facts: { positions: DRAWN } }), 'locked');
});

test('"Change kind…" on a node asks for one of the other kinds and writes updateNode', async () => {
  const h = harness({ menuChoice: () => 'Device' });

  const verdict = await assertApplied(h, operation(h, 'element.update', { ref: 'api_pod', changes: { choose: 'kind' } }));

  assert.deepEqual(h.menus[0].groups[0].items.map((item) => item.label), ['Device', 'Infrastructure']);
  assert.equal(node(h, 'api-pod').kind, 'device');
  assert.equal(verdict.message, 'API pod is now a device.');
});
