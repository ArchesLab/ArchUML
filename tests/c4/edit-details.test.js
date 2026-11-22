'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const model = require('../../c4/c4-model.js');
const edit = require('../../c4/c4-edit.js');
const { fixture } = require('./helpers.js');

/** `rows` as a text with a line break after each row. */
function lines(...rows) {
  return rows.map((row) => `${row}\n`).join('');
}

/** The `{ text, parsed, model }` design that edit commands take. */
function design(text) {
  const parsed = y.parse(text);
  return { text, parsed, model: model.normalize(parsed, { source: 'file' }).model };
}

/** Applies `command` to `text`; fails unless the command succeeds and its edits produce its text. */
function applied(text, command) {
  const result = edit.apply(design(text), command);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(y.applyEdits(text, result.edits), result.text, 'the edits turn the input into the returned text');
  return result;
}

/** The refusal code `command` gets on `text`. */
function refusalOf(text, command) {
  return edit.apply(design(text), command).error;
}

/** The data at `path` of the YAML `text`. */
function dataAt(text, path) {
  return path.reduce((value, segment) => (value == null ? undefined : value[segment]), y.toData(y.parse(text)));
}

// ---- Responsibilities ------------------------------------------------------------------------

test('addResponsibility writes the shorthand map form', () => {
  const shop = lines(
    'people:',
    '  buyer: {name: Buyer}',
    'systems:',
    '  shop:',
    '    name: Shop',
    '    tags: [retail]',
  );
  const first = applied(shop, { op: 'addResponsibility', elementId: 'shop', kind: 'do', text: 'sell books' });
  assert.equal(first.text, shop.replace('    tags:', '    responsibilities:\n      - do: sell books\n    tags:'));
  assert.deepEqual(first.selection, { elementId: 'shop', responsibilityIndex: 0 });

  const second = applied(first.text, { op: 'addResponsibility', elementId: 'shop', kind: 'know', text: 'which books are in stock' });
  assert.equal(second.text, first.text.replace('      - do: sell books\n', '      - do: sell books\n      - know: which books are in stock\n'));
  assert.deepEqual(second.selection, { elementId: 'shop', responsibilityIndex: 1 });

  assert.equal(refusalOf(shop, { op: 'addResponsibility', elementId: 'buyer', kind: 'do', text: 'buy' }), 'invalid-field');
  assert.equal(refusalOf(shop, { op: 'addResponsibility', elementId: 'shop', kind: 'maybe', text: 'sell' }), 'invalid-kind');
  assert.equal(refusalOf(shop, { op: 'addResponsibility', elementId: 'shop', kind: 'do', text: '  ' }), 'invalid-text');
  assert.equal(refusalOf(shop, { op: 'addResponsibility', elementId: 'nowhere', kind: 'do', text: 'x' }), 'unknown-element');
});

const ORDERS = lines(
  'systems:',
  '  shop:',
  '    responsibilities:',
  '      - do: sell books',
  '        id: shop-sell',
  '    containers:',
  '      api:',
  '        responsibilities:',
  '          - do: take orders   # main job',
  '          - KNOW prices',
);

test('updateResponsibility edits the kind, text, and links of a map item in place', () => {
  const text = applied(ORDERS, { op: 'updateResponsibility', elementId: 'api', index: 0, text: 'accept orders' });
  assert.equal(text.text, ORDERS.replace('take orders', 'accept orders'));
  assert.deepEqual(text.selection, { elementId: 'api', responsibilityIndex: 0 });

  const kind = applied(ORDERS, { op: 'updateResponsibility', elementId: 'api', index: 0, kind: 'decide' });
  assert.equal(kind.text, ORDERS.replace('- do: take orders', '- decide: take orders'));

  const linked = applied(ORDERS, { op: 'updateResponsibility', elementId: 'api', index: 0, refines: 'shop-sell', requirements: ['FR-1'] });
  assert.equal(linked.text, ORDERS.replace('# main job\n', lines(
    '# main job',
    '            refines: shop-sell',
    '            requirements:',
    '              - FR-1',
  )));

  const unlinked = applied(linked.text, { op: 'updateResponsibility', elementId: 'api', index: 0, refines: null, requirements: [] });
  assert.equal(unlinked.text, ORDERS);
});

test('updateResponsibility writes a responsibility string in the map form', () => {
  const result = applied(ORDERS, { op: 'updateResponsibility', elementId: 'api', index: 1, text: 'current prices' });
  assert.equal(result.text, ORDERS.replace('- KNOW prices', '- know: current prices'));
  assert.equal(refusalOf(ORDERS, { op: 'updateResponsibility', elementId: 'api', index: 2, text: 'x' }), 'invalid-index');
  assert.equal(refusalOf(ORDERS, { op: 'updateResponsibility', elementId: 'api', index: 0, owner: 'x' }), 'invalid-field');
});

test('removeResponsibility removes the item and every reference to its id', () => {
  const text = lines(
    'systems:',
    '  shop:',
    '    responsibilities:',
    '      - do: sell books',
    '        id: shop-sell',
    '      - know: the catalogue',
    '    containers:',
    '      api:',
    '        responsibilities:',
    '          - do: take orders',
    '            refines: shop-sell',
    '        collaborators:',
    '          db: {description: reads the catalogue from, responsibility: db-store}',
    '      db:',
    '        responsibilities:',
    '          - do: store the catalogue',
    '            id: db-store',
    'scenarios:',
    '  browse:',
    '    steps:',
    '      - {from: api, to: db, description: reads the catalogue from, responsibility: db-store}',
  );
  const refined = applied(text, { op: 'removeResponsibility', elementId: 'shop', index: 0 });
  assert.equal(refined.text, text
    .replace('      - do: sell books\n        id: shop-sell\n', '')
    .replace('            refines: shop-sell\n', ''));
  assert.deepEqual(refined.selection, { elementId: 'shop' });

  const stored = applied(text, { op: 'removeResponsibility', elementId: 'db', index: 0 });
  assert.equal(stored.text, text
    .replace('        responsibilities:\n          - do: store the catalogue\n            id: db-store\n', '')
    .replace(', responsibility: db-store}', '}')
    .replace(', responsibility: db-store}', '}'));
});

test('moveResponsibility reorders the items with their comments', () => {
  const text = lines(
    'systems:',
    '  shop:',
    '    responsibilities:',
    '      # the main job',
    '      - do: take orders',
    '      - know: prices',
  );
  const result = applied(text, { op: 'moveResponsibility', elementId: 'shop', from: 0, to: 1 });
  assert.equal(result.text, lines(
    'systems:',
    '  shop:',
    '    responsibilities:',
    '      - know: prices',
    '      # the main job',
    '      - do: take orders',
  ));
  assert.deepEqual(result.selection, { elementId: 'shop', responsibilityIndex: 1 });
  assert.equal(refusalOf(text, { op: 'moveResponsibility', elementId: 'shop', from: 0, to: 2 }), 'invalid-index');
});

test('ensureResponsibilityId writes <element>-<kind>-<n> once', () => {
  const text = lines(
    'systems:',
    '  shop:',
    '    containers:',
    '      api:',
    '        responsibilities:',
    '          - do: take orders',
    '          - do: ship orders',
    '            id: api-do-1',
    '          - KNOW prices',
    '          - remember everything',
  );
  const first = applied(text, { op: 'ensureResponsibilityId', elementId: 'api', index: 0 });
  assert.equal(first.text, text.replace('- do: take orders\n', '- do: take orders\n            id: api-do-2\n'));
  assert.deepEqual(first.selection, { elementId: 'api', responsibilityIndex: 0, responsibilityId: 'api-do-2' });

  const again = applied(first.text, { op: 'ensureResponsibilityId', elementId: 'api', index: 0 });
  assert.deepEqual(again.edits, []);
  assert.equal(again.selection.responsibilityId, 'api-do-2');

  const shorthand = applied(text, { op: 'ensureResponsibilityId', elementId: 'api', index: 2 });
  assert.equal(shorthand.text, text.replace('- KNOW prices\n', '- know: prices\n            id: api-know-1\n'));

  assert.equal(refusalOf(text, { op: 'ensureResponsibilityId', elementId: 'api', index: 3 }), 'untyped-responsibility');
});

// ---- Relationships ---------------------------------------------------------------------------

const PARTS = lines(
  'systems:',
  '  shop:',
  '    containers:',
  '      web:',
  '        name: Web',
  '      api:',
  '        name: API',
  '      db:',
  '        name: DB',
);

test('addRelationship writes a string, a map when technology is given, and a list for a second relationship to the same target', () => {
  const plain = applied(PARTS, { op: 'addRelationship', sourceId: 'api', targetId: 'db', description: 'reads orders from' });
  assert.equal(plain.text, PARTS.replace('        name: API\n', lines(
    '        name: API',
    '        collaborators:',
    '          db: reads orders from',
  )));
  assert.deepEqual(plain.selection, { relationshipId: 'api->db' });

  const mapped = applied(plain.text, { op: 'addRelationship', sourceId: 'api', targetId: 'web', description: 'notifies', technology: 'WebSocket' });
  assert.equal(mapped.text, plain.text.replace('          db: reads orders from\n', lines(
    '          db: reads orders from',
    '          web:',
    '            description: notifies',
    '            technology: WebSocket',
  )));
  assert.deepEqual(mapped.selection, { relationshipId: 'api->web' });

  const listed = applied(mapped.text, { op: 'addRelationship', sourceId: 'api', targetId: 'db', description: 'writes orders to', connector: 'message' });
  assert.equal(listed.text, mapped.text.replace('          db: reads orders from\n', lines(
    '          db:',
    '            - reads orders from',
    '            - description: writes orders to',
    '              connector: message',
  )));
  assert.deepEqual(listed.selection, { relationshipId: 'api->db#2' });

  const third = applied(listed.text, { op: 'addRelationship', sourceId: 'api', targetId: 'db', description: 'deletes orders from' });
  assert.equal(dataAt(third.text, ['systems', 'shop', 'containers', 'api', 'collaborators', 'db', 2]), 'deletes orders from');
  assert.deepEqual(third.selection, { relationshipId: 'api->db#3' });
});

test('addRelationship refuses links between nested elements, unknown connectors, and empty descriptions', () => {
  const add = (fields) => refusalOf(PARTS, Object.assign({ op: 'addRelationship', description: 'uses' }, fields));
  assert.equal(add({ sourceId: 'api', targetId: 'shop' }), 'invalid-relationship');
  assert.equal(add({ sourceId: 'api', targetId: 'api' }), 'invalid-relationship');
  assert.equal(add({ sourceId: 'api', targetId: 'nowhere' }), 'unknown-element');
  assert.equal(add({ sourceId: 'api', targetId: 'db', connector: 'smoke' }), 'invalid-connector');
  assert.equal(add({ sourceId: 'api', targetId: 'db', description: '' }), 'invalid-description');
});

const LINKED = lines(
  'systems:',
  '  shop:',
  '    containers:',
  '      api:',
  '        collaborators:',
  '          db: reads orders from   # main path',
  '          web:',
  '            - notifies',
  '            - pushes prices to',
  '      web: {name: Web}',
  '      db: {name: DB}',
);

test('updateRelationship switches a string to the map form only when needed', () => {
  const reworded = applied(LINKED, { op: 'updateRelationship', relationshipId: 'api->db', description: 'reads all orders from' });
  assert.equal(reworded.text, LINKED.replace('reads orders from', 'reads all orders from'));
  assert.deepEqual(reworded.selection, { relationshipId: 'api->db' });

  const defaultConnector = applied(LINKED, { op: 'updateRelationship', relationshipId: 'api->db', connector: 'call' });
  assert.deepEqual(defaultConnector.edits, [], 'call is the default connector, so the string form stays');

  const mapped = applied(LINKED, { op: 'updateRelationship', relationshipId: 'api->db', technology: 'SQL' });
  assert.deepEqual(dataAt(mapped.text, ['systems', 'shop', 'containers', 'api', 'collaborators', 'db']),
    { description: 'reads orders from', technology: 'SQL' });
  assert.match(mapped.text, /# main path/);

  const stillMapped = applied(mapped.text, { op: 'updateRelationship', relationshipId: 'api->db', technology: null });
  assert.deepEqual(dataAt(stillMapped.text, ['systems', 'shop', 'containers', 'api', 'collaborators', 'db']),
    { description: 'reads orders from' }, 'a map stays a map');

  const second = applied(LINKED, { op: 'updateRelationship', relationshipId: 'api->web#2', connector: 'event' });
  assert.equal(second.text, LINKED.replace('            - pushes prices to\n', lines(
    '            - description: pushes prices to',
    '              connector: event',
  )));

  assert.equal(refusalOf(LINKED, { op: 'updateRelationship', relationshipId: 'api->nowhere', description: 'x' }), 'unknown-relationship');
  assert.equal(refusalOf(LINKED, { op: 'updateRelationship', relationshipId: 'api->db', colour: 'red' }), 'invalid-field');
});

test('removeRelationship removes one relationship and the collections it empties', () => {
  const secondGone = applied(LINKED, { op: 'removeRelationship', relationshipId: 'api->web#2' });
  assert.equal(secondGone.text, LINKED.replace('            - pushes prices to\n', ''));
  assert.equal(secondGone.selection, null);

  const webGone = applied(secondGone.text, { op: 'removeRelationship', relationshipId: 'api->web' });
  assert.equal(webGone.text, secondGone.text.replace('          web:\n            - notifies\n', ''));

  const allGone = applied(webGone.text, { op: 'removeRelationship', relationshipId: 'api->db' });
  assert.equal(allGone.text, lines(
    'systems:',
    '  shop:',
    '    containers:',
    '      api:',
    '      web: {name: Web}',
    '      db: {name: DB}',
  ));
});

// ---- Lists and choices -----------------------------------------------------------------------

test('setList rewrites a list field and removes it when empty', () => {
  const text = lines(
    'people:',
    '  buyer: {name: Buyer}',
    'systems:',
    '  shop:',
    '    name: Shop',
    '    owns: [orders]   # authority',
  );
  const owns = applied(text, { op: 'setList', elementId: 'shop', field: 'owns', items: ['orders', 'refunds'] });
  assert.equal(owns.text, text.replace('[orders]', '[orders, refunds]'));
  assert.deepEqual(owns.selection, { elementId: 'shop' });

  const invariants = applied(text, { op: 'setList', elementId: 'shop', field: 'invariants', items: ['never sells a book twice'] });
  assert.equal(invariants.text, text + lines('    invariants:', '      - never sells a book twice'));

  const none = applied(text, { op: 'setList', elementId: 'shop', field: 'owns', items: [] });
  assert.equal(none.text, text.replace('    owns: [orders]   # authority\n', ''));

  assert.equal(refusalOf(text, { op: 'setList', elementId: 'shop', field: 'name', items: ['x'] }), 'invalid-field');
  assert.equal(refusalOf(text, { op: 'setList', elementId: 'buyer', field: 'owns', items: ['x'] }), 'invalid-field');
  assert.equal(refusalOf(text, { op: 'setList', elementId: 'shop', field: 'owns', items: [3] }), 'invalid-value');
});

test('setChoices writes the choices of an element and of a relationship', () => {
  const onElement = applied(LINKED, { op: 'setChoices', elementId: 'api', choices: { styles: ['layers'] } });
  assert.equal(onElement.text, LINKED.replace('      web: {name: Web}\n', lines(
    '        choices:',
    '          styles:',
    '            - layers',
    '      web: {name: Web}',
  )));
  assert.deepEqual(onElement.selection, { elementId: 'api' });

  const onRelationship = applied(LINKED, { op: 'setChoices', relationshipId: 'api->db', choices: { tactics: ['retry'] } });
  assert.deepEqual(dataAt(onRelationship.text, ['systems', 'shop', 'containers', 'api', 'collaborators', 'db']),
    { description: 'reads orders from', choices: { tactics: ['retry'] } });
  assert.deepEqual(onRelationship.selection, { relationshipId: 'api->db' });

  const cleared = applied(onElement.text, { op: 'setChoices', elementId: 'api', choices: null });
  assert.equal(cleared.text, LINKED);
});

// ---- Scenarios -------------------------------------------------------------------------------

const STORE = lines(
  'people:',
  '  buyer: {name: Buyer}',
  'systems:',
  '  shop:',
  '    containers:',
  '      web: {name: Web}',
  '      api: {name: API}',
);

test('scenario commands add steps in shorthand, insert fragments, and reorder steps', () => {
  const scenario = applied(STORE, { op: 'addScenario', title: 'Place an order' });
  assert.equal(scenario.text, STORE + lines('scenarios:', '  place-an-order:', '    title: Place an order'));
  assert.deepEqual(scenario.selection, { scenarioId: 'place-an-order' });

  const at = (containerPath, index) => ({ scenarioId: 'place-an-order', containerPath, index });
  const first = applied(scenario.text, Object.assign({ op: 'addStep', step: { from: 'buyer', to: 'web', description: 'orders a book with' } }, at([], 0)));
  assert.deepEqual(first.selection, at([], 0));
  const second = applied(first.text, Object.assign({ op: 'addStep', step: { from: 'web', to: 'api', description: 'submits the order to', technology: 'HTTPS' } }, at([], 1)));
  const fragment = applied(second.text, Object.assign({ op: 'addFragment', operator: 'alt' }, at([], 2)));
  assert.deepEqual(fragment.selection, at([], 2));
  const inBranch = applied(fragment.text, Object.assign({ op: 'addStep', step: { from: 'api', to: 'web', description: 'confirms the order to' } }, at([2, 'alt', 0], 0)));
  assert.equal(inBranch.text, STORE + lines(
    'scenarios:',
    '  place-an-order:',
    '    title: Place an order',
    '    steps:',
    '      - buyer -> web: orders a book with',
    '      - from: web',
    '        to: api',
    '        description: submits the order to',
    '        technology: HTTPS',
    '      - alt:',
    '          - when: ""',
    '            steps:',
    '              - api -> web: confirms the order to',
  ));

  const moved = applied(inBranch.text, { op: 'moveStep', scenarioId: 'place-an-order', containerPath: [], from: 0, to: 1 });
  assert.deepEqual(dataAt(moved.text, ['scenarios', 'place-an-order', 'steps']).map((step) => Object.keys(step)[0]),
    ['from', 'buyer -> web', 'alt']);
  assert.deepEqual(moved.selection, at([], 1));

  const opt = applied(STORE + lines('scenarios:', '  s:', '    steps:'), { op: 'addFragment', scenarioId: 's', containerPath: [], index: 0, operator: 'opt' });
  assert.deepEqual(dataAt(opt.text, ['scenarios', 's', 'steps']), [{ opt: { when: '' } }]);

  assert.equal(refusalOf(inBranch.text, Object.assign({ op: 'addFragment', operator: 'maybe' }, at([], 0))), 'invalid-operator');
  assert.equal(refusalOf(inBranch.text, Object.assign({ op: 'addStep', step: { from: 'buyer', to: 'nowhere', description: 'x' } }, at([], 0))), 'unknown-element');
  assert.equal(refusalOf(inBranch.text, Object.assign({ op: 'addStep', step: { from: 'buyer', to: 'web', description: 'x' } }, at([5, 'alt', 0], 0))), 'unknown-step-container');
  assert.equal(refusalOf(inBranch.text, Object.assign({ op: 'addStep', step: { from: 'buyer', to: 'web', description: 'x' } }, at([], 9))), 'invalid-index');
  assert.equal(refusalOf(STORE, { op: 'addStep', scenarioId: 'nowhere', containerPath: [], index: 0, step: { from: 'buyer', to: 'web' } }), 'unknown-scenario');
});

test('updateStep keeps a shorthand step short until a field needs the map form, and removeStep removes emptied lists', () => {
  const text = STORE + lines(
    'scenarios:',
    '  order:',
    '    steps:',
    '      - buyer -> web: orders a book with   # first',
    '      - opt:',
    '          when: logged in',
    '          steps:',
    '            - {from: web, to: api, description: loads the cart from}',
  );
  const at = (containerPath, index) => ({ scenarioId: 'order', containerPath, index });
  const reworded = applied(text, Object.assign({ op: 'updateStep', step: { description: 'orders books with' } }, at([], 0)));
  assert.equal(reworded.text, text.replace('orders a book with', 'orders books with'));
  assert.deepEqual(reworded.selection, at([], 0));

  const retargeted = applied(text, Object.assign({ op: 'updateStep', step: { to: 'api' } }, at([], 0)));
  assert.equal(retargeted.text, text.replace('buyer -> web:', 'buyer -> api:'));

  const mapped = applied(text, Object.assign({ op: 'updateStep', step: { technology: 'HTTPS' } }, at([], 0)));
  assert.deepEqual(dataAt(mapped.text, ['scenarios', 'order', 'steps', 0]),
    { from: 'buyer', to: 'web', description: 'orders a book with', technology: 'HTTPS' });

  const inMap = applied(text, Object.assign({ op: 'updateStep', step: { description: null, connector: 'message' } }, at([1, 'opt'], 0)));
  assert.equal(inMap.text, text.replace('{from: web, to: api, description: loads the cart from}', '{from: web, to: api, connector: message}'));

  assert.equal(refusalOf(text, Object.assign({ op: 'updateStep', step: { description: 'x' } }, at([], 1))), 'not-a-message-step');

  const branchEmptied = applied(text, Object.assign({ op: 'removeStep' }, at([1, 'opt'], 0)));
  assert.equal(branchEmptied.text, text.replace('          steps:\n            - {from: web, to: api, description: loads the cart from}\n', ''));
  assert.deepEqual(branchEmptied.selection, { scenarioId: 'order' });
});

// ---- Deployment ------------------------------------------------------------------------------

test('deployment commands add nested nodes and infrastructure nodes and set hosts', () => {
  const text = lines(
    'people:',
    '  buyer: {name: Buyer}',
    'systems:',
    '  shop:',
    '    containers:',
    '      api: {name: API}',
  );
  const environment = applied(text, { op: 'addEnvironment', name: 'Production' });
  assert.deepEqual(environment.selection, { environmentId: 'production' });
  const cloud = applied(environment.text, { op: 'addNode', environmentId: 'production', parentNodeId: null, kind: 'environment', name: 'Cloud' });
  assert.deepEqual(cloud.selection, { environmentId: 'production', nodeId: 'cloud' });
  const pod = applied(cloud.text, { op: 'addNode', environmentId: 'production', parentNodeId: 'cloud', kind: 'environment', name: 'API pod' });
  const balancer = applied(pod.text, { op: 'addNode', environmentId: 'production', parentNodeId: 'cloud', kind: 'infrastructure', name: 'Load balancer' });
  const hosted = applied(balancer.text, { op: 'setHosts', environmentId: 'production', nodeId: 'api-pod', hosts: ['api'] });
  assert.deepEqual(hosted.selection, { environmentId: 'production', nodeId: 'api-pod' });
  const scaled = applied(hosted.text, { op: 'updateNode', environmentId: 'production', nodeId: 'api-pod', field: 'instances', value: 3 });
  assert.equal(scaled.text, text + lines(
    'deployment:',
    '  production:',
    '    name: Production',
    '    nodes:',
    '      cloud:',
    '        name: Cloud',
    '        kind: environment',
    '        nodes:',
    '          api-pod:',
    '            name: API pod',
    '            kind: environment',
    '            instances: 3',
    '            hosts:',
    '              - api',
    '          load-balancer:',
    '            name: Load balancer',
    '            kind: infrastructure',
  ));

  const node = (fields) => Object.assign({ environmentId: 'production' }, fields);
  assert.equal(refusalOf(scaled.text, node({ op: 'addNode', parentNodeId: 'load-balancer', kind: 'environment', name: 'X' })), 'infrastructure-leaf');
  assert.equal(refusalOf(scaled.text, node({ op: 'addNode', parentNodeId: null, kind: 'cupboard', name: 'X' })), 'invalid-kind');
  assert.equal(refusalOf(scaled.text, node({ op: 'setHosts', nodeId: 'load-balancer', hosts: ['api'] })), 'infrastructure-leaf');
  assert.equal(refusalOf(scaled.text, node({ op: 'setHosts', nodeId: 'api-pod', hosts: ['buyer'] })), 'invalid-host');
  assert.equal(refusalOf(scaled.text, node({ op: 'setHosts', nodeId: 'api-pod', hosts: ['nowhere'] })), 'unknown-element');
  assert.equal(refusalOf(scaled.text, node({ op: 'updateNode', nodeId: 'api-pod', field: 'kind', value: 'infrastructure' })), 'infrastructure-leaf');
  assert.equal(refusalOf(scaled.text, node({ op: 'updateNode', nodeId: 'api-pod', field: 'instances', value: 0 })), 'invalid-value');
  assert.equal(refusalOf(scaled.text, node({ op: 'updateNode', nodeId: 'api-pod', field: 'hosts', value: ['api'] })), 'invalid-field');
  assert.equal(refusalOf(scaled.text, node({ op: 'updateNode', nodeId: 'nowhere', field: 'name', value: 'X' })), 'unknown-node');

  const unhosted = applied(scaled.text, { op: 'setHosts', environmentId: 'production', nodeId: 'api-pod', hosts: [] });
  assert.equal(unhosted.text, scaled.text.replace('            hosts:\n              - api\n', ''));
});

test('removeNode removes the node, its nested nodes, and the node collaborators that pointed at them', () => {
  const text = lines(
    'deployment:',
    '  production:',
    '    nodes:',
    '      balancer:',
    '        kind: infrastructure',
    '        collaborators:',
    '          cloud: forwards requests to',
    '          pod: forwards requests to',
    '      cloud:',
    '        nodes:',
    '          pod: {name: Pod}',
  );
  const result = applied(text, { op: 'removeNode', environmentId: 'production', nodeId: 'cloud' });
  assert.equal(result.text, lines(
    'deployment:',
    '  production:',
    '    nodes:',
    '      balancer:',
    '        kind: infrastructure',
  ));
  assert.deepEqual(result.selection, { environmentId: 'production' });
});

// ---- Top-level entries -----------------------------------------------------------------------

test('setTopLevelEntry places a new section in canonical order and removeTopLevelEntry removes it again', () => {
  const text = lines(
    'name: Shop',
    'systems:',
    '  shop: {name: Shop}',
  );
  const requirement = applied(text, { op: 'setTopLevelEntry', section: 'requirements', id: 'FR-1', value: 'A buyer can order a book.' });
  assert.equal(requirement.text, lines('name: Shop', 'requirements:', '  FR-1: A buyer can order a book.', 'systems:', '  shop: {name: Shop}'));
  assert.deepEqual(requirement.selection, { section: 'requirements', id: 'FR-1' });

  const decision = applied(requirement.text, { op: 'setTopLevelEntry', section: 'decisions', id: 'one-db', value: { title: 'One database', status: 'accepted' } });
  assert.equal(decision.text, requirement.text + lines('decisions:', '  one-db:', '    title: One database', '    status: accepted'));

  const retitled = applied(decision.text, { op: 'setTopLevelEntry', section: 'decisions', id: 'one-db', value: { title: 'A single database', status: 'accepted' } });
  assert.equal(retitled.text, decision.text.replace('One database', 'A single database'));

  const withoutDecision = applied(decision.text, { op: 'removeTopLevelEntry', section: 'decisions', id: 'one-db' });
  assert.equal(withoutDecision.text, requirement.text);
  assert.equal(withoutDecision.selection, null);
  assert.equal(applied(withoutDecision.text, { op: 'removeTopLevelEntry', section: 'requirements', id: 'FR-1' }).text, text);

  assert.equal(refusalOf(text, { op: 'setTopLevelEntry', section: 'views', id: 'containers', value: { view: 'landscape' } }), 'reserved-id');
  assert.equal(refusalOf(text, { op: 'setTopLevelEntry', section: 'people', id: 'x', value: { name: 'X' } }), 'invalid-section');
  assert.equal(refusalOf(text, { op: 'setTopLevelEntry', section: 'decisions', id: '1st', value: { title: 'X' } }), 'invalid-id');
  assert.equal(refusalOf(text, { op: 'removeTopLevelEntry', section: 'decisions', id: 'one-db' }), 'unknown-entry');
});

// ---- Layout and schema header ----------------------------------------------------------------

const PINNABLE = lines(
  'systems:',
  '  shop:',
  '    containers:',
  '      web: {name: Web}',
  '      api: {name: API}',
  'decisions:',
  '  one-db: {title: One database}',
);

test('pinPosition creates the layout section at the end with a canonical key; unpinPosition removes the entry and an empty section', () => {
  const api = applied(PINNABLE, { op: 'pinPosition', viewKey: 'Container  of shop', elementId: 'api', x: 40, y: 120 });
  assert.equal(api.text, PINNABLE + lines('layout:', '  containers of shop:', '    api: [40, 120]'));
  assert.deepEqual(api.selection, { elementId: 'api' });

  const web = applied(api.text, { op: 'pinPosition', viewKey: 'containers of shop', elementId: 'web', x: 10, y: 20.5 });
  assert.equal(web.text, api.text + lines('    web: [10, 20.5]'));

  const moved = applied(web.text, { op: 'pinPosition', viewKey: 'containers of shop', elementId: 'api', x: 50, y: 60 });
  assert.equal(moved.text, web.text.replace('[40, 120]', '[50, 60]'));

  const apiFree = applied(moved.text, { op: 'unpinPosition', viewKey: 'containers of shop', elementId: 'api' });
  assert.equal(apiFree.text, moved.text.replace('    api: [50, 60]\n', ''));
  assert.deepEqual(apiFree.selection, { elementId: 'api' });
  assert.equal(applied(apiFree.text, { op: 'unpinPosition', viewKey: 'containers of shop', elementId: 'web' }).text, PINNABLE);
  assert.deepEqual(applied(PINNABLE, { op: 'unpinPosition', viewKey: 'containers of shop', elementId: 'web' }).edits, []);

  assert.equal(refusalOf(PINNABLE, { op: 'pinPosition', viewKey: 'containers of', elementId: 'api', x: 1, y: 2 }), 'invalid-view');
  assert.equal(refusalOf(PINNABLE, { op: 'pinPosition', viewKey: 'containers of shop', elementId: 'api', x: Number.NaN, y: 2 }), 'invalid-position');
  assert.equal(refusalOf(PINNABLE, { op: 'pinPosition', viewKey: 'containers of shop', elementId: 'nowhere', x: 1, y: 2 }), 'unknown-element');
});

test('pinPosition writes into a layout entry whose key is not in canonical form', () => {
  const text = PINNABLE + lines('layout:', '  Containers of shop:', '    web: [1, 2]');
  const result = applied(text, { op: 'pinPosition', viewKey: 'containers of shop', elementId: 'api', x: 3, y: 4 });
  assert.equal(result.text, text + lines('    api: [3, 4]'));
});

test('pinPosition keys the layout by the id as declared, and changeElementId carries the pinned positions over', () => {
  const text = lines('systems:', '  Reg:', '    containers:', '      web: {name: Web}');
  const pinned = applied(text, { op: 'pinPosition', viewKey: 'Containers of Reg', elementId: 'web', x: 5, y: 6 });
  assert.equal(pinned.text, text + lines('layout:', '  containers of Reg:', '    web: [5, 6]'));

  const renamed = applied(pinned.text, { op: 'changeElementId', elementId: 'Reg', newId: 'Main' });
  assert.deepEqual(dataAt(renamed.text, ['layout']), { 'containers of Main': { web: ['5', '6'] } });
  assert.deepEqual(design(renamed.text).model.layout.get('containers of Main').get('web'), [5, 6]);
});

test('ensureSchemaHeader inserts schema: c4-design/1 after leading comments', () => {
  const text = lines('# caption: The shop', '# drawn for week 3', 'x-note: draft', 'systems:', '  shop: {name: Shop}');
  const result = applied(text, { op: 'ensureSchemaHeader' });
  assert.equal(result.text, lines('# caption: The shop', '# drawn for week 3', 'schema: c4-design/1', 'x-note: draft', 'systems:', '  shop: {name: Shop}'));
  assert.equal(result.selection, null);

  assert.deepEqual(applied(result.text, { op: 'ensureSchemaHeader' }).edits, []);
  assert.equal(applied('', { op: 'ensureSchemaHeader' }).text, 'schema: c4-design/1\n');
  assert.equal(refusalOf('- a\n- b\n', { op: 'ensureSchemaHeader' }), 'invalid-document');
});

// ---- Batches ---------------------------------------------------------------------------------

test('a batch of addElement and pinPosition returns exactly one splice whose application equals applying both commands in order', () => {
  const add = { op: 'addElement', parentId: 'shop', type: 'container', kind: 'database', name: 'Order Store' };
  const pin = { op: 'pinPosition', viewKey: 'containers of shop', elementId: 'order-store', x: 200, y: 80 };
  const result = applied(PINNABLE, { op: 'batch', commands: [add, pin] });
  assert.equal(result.edits.length, 1);
  assert.equal(result.text, applied(applied(PINNABLE, add).text, pin).text);
  assert.deepEqual(result.selection, { elementId: 'order-store' });

  const [splice] = result.edits;
  assert.notEqual(PINNABLE.charAt(splice.offset), result.text.charAt(splice.offset), 'the splice starts at the first difference');
  assert.equal(PINNABLE.slice(splice.offset + splice.length), result.text.slice(result.text.length - (PINNABLE.length - splice.offset - splice.length)));

  assert.deepEqual(applied(PINNABLE, { op: 'batch', commands: [] }), { text: PINNABLE, edits: [], selection: null });
});

test('a batch that fails midway returns an error and no edits', () => {
  const result = edit.apply(design(PINNABLE), { op: 'batch', commands: [
    { op: 'addElement', parentId: 'shop', type: 'container', name: 'Order Store' },
    { op: 'pinPosition', viewKey: 'containers of shop', elementId: 'nowhere', x: 1, y: 2 },
  ] });
  assert.equal(result.error, 'unknown-element');
  assert.equal(result.edits, undefined);
  assert.equal(result.text, undefined);
});

// ---- Every command ---------------------------------------------------------------------------

test('detail commands are refused while YAML errors exist', () => {
  const broken = design('systems:\n  shop: {name: Shop\n');
  for (const command of [
    { op: 'addResponsibility', elementId: 'shop', kind: 'do', text: 'x' },
    { op: 'addRelationship', sourceId: 'shop', targetId: 'x', description: 'uses' },
    { op: 'addScenario', title: 'X' },
    { op: 'addEnvironment', name: 'X' },
    { op: 'pinPosition', viewKey: 'landscape', elementId: 'shop', x: 1, y: 2 },
    { op: 'ensureSchemaHeader' },
    { op: 'batch', commands: [{ op: 'ensureSchemaHeader' }] },
  ]) {
    assert.deepEqual(edit.apply(broken, command), { error: 'yaml-errors' }, command.op);
  }
});

/** Every detail command that applies to the reference model, with the shape its edits must have. */
const FIXTURE_COMMANDS = [
  [{ op: 'addResponsibility', elementId: 'api', kind: 'do', text: 'log every attempt' }, 'insertion'],
  [{ op: 'updateResponsibility', elementId: 'api', index: 0, text: 'decide eligibility' }],
  [{ op: 'updateResponsibility', elementId: 'seats', index: 0, kind: 'do', refines: 'api-holds' }],
  [{ op: 'removeResponsibility', elementId: 'api', index: 1 }, 'deletion'],
  [{ op: 'moveResponsibility', elementId: 'coordinator', from: 0, to: 1 }],
  [{ op: 'ensureResponsibilityId', elementId: 'coordinator', index: 0 }, 'insertion'],
  [{ op: 'addRelationship', sourceId: 'web', targetId: 'api', description: 'loads course data from' }, 'insertion'],
  [{ op: 'addRelationship', sourceId: 'coordinator', targetId: 'policy', description: 'asks for a waiver decision from', technology: 'Python call' }],
  [{ op: 'updateRelationship', relationshipId: 'web->coordinator', description: 'submits finished plans to' }],
  [{ op: 'updateRelationship', relationshipId: 'coordinator->policy', technology: 'Python call' }],
  [{ op: 'removeRelationship', relationshipId: 'billing-gateway->billing' }, 'deletion'],
  [{ op: 'setList', elementId: 'seats', field: 'owns', items: ['seat holds', 'waitlists'] }],
  [{ op: 'setChoices', elementId: 'api', choices: { styles: ['layers', 'client-server'] } }],
  [{ op: 'setChoices', relationshipId: 'coordinator->seats', choices: { tactics: ['retry'] } }],
  [{ op: 'addScenario', title: 'Drop a section' }, 'insertion'],
  [{ op: 'addStep', scenarioId: 'enroll', containerPath: [], index: 0, step: { from: 'student', to: 'web', description: 'opens the planner in' } }, 'insertion'],
  [{ op: 'addStep', scenarioId: 'enroll', containerPath: [2, 'alt', 1], index: 1, step: { from: 'web', to: 'coordinator', description: 'asks again', connector: 'message' } }, 'insertion'],
  [{ op: 'updateStep', scenarioId: 'enroll', containerPath: [], index: 0, step: { description: 'submits a plan to' } }],
  [{ op: 'removeStep', scenarioId: 'enroll', containerPath: [2, 'alt', 0], index: 0 }, 'deletion'],
  [{ op: 'moveStep', scenarioId: 'enroll', containerPath: [], from: 0, to: 1 }],
  [{ op: 'addFragment', scenarioId: 'enroll', containerPath: [], index: 3, operator: 'loop' }, 'insertion'],
  [{ op: 'addEnvironment', name: 'Staging' }, 'insertion'],
  [{ op: 'addNode', environmentId: 'production', parentNodeId: 'campus-cloud', kind: 'infrastructure', name: 'Firewall' }, 'insertion'],
  [{ op: 'updateNode', environmentId: 'production', nodeId: 'api-pod', field: 'instances', value: 5 }],
  [{ op: 'removeNode', environmentId: 'production', nodeId: 'api-pod' }, 'deletion'],
  [{ op: 'setHosts', environmentId: 'production', nodeId: 'postgres', hosts: ['db', 'api'] }],
  [{ op: 'setTopLevelEntry', section: 'requirements', id: 'FR-10', value: 'A student can drop a section.' }, 'insertion'],
  [{ op: 'setTopLevelEntry', section: 'views', id: 'storage', value: { view: 'containers of registration', include: ['db'] } }, 'insertion'],
  [{ op: 'removeTopLevelEntry', section: 'decisions', id: 'one-database' }, 'deletion'],
  [{ op: 'pinPosition', viewKey: 'containers of registration', elementId: 'api', x: 120, y: 40 }],
  [{ op: 'unpinPosition', viewKey: 'containers of registration', elementId: 'api' }, 'deletion'],
  [{ op: 'ensureSchemaHeader' }, 'insertion'],
  [{ op: 'batch', commands: [
    { op: 'addElement', parentId: 'registration', type: 'container', name: 'Search Index' },
    { op: 'pinPosition', viewKey: 'containers of registration', elementId: 'search-index', x: 0, y: 0 },
  ] }, 'one splice'],
];

test('every detail command leaves text outside its edits unchanged', () => {
  const text = fixture('course-registration.yml');
  const reference = design(text);
  for (const [command, shape] of FIXTURE_COMMANDS) {
    const where = JSON.stringify(command);
    const result = edit.apply(reference, command);
    assert.equal(result.error, undefined, `${where}: ${result.message}`);
    assert.equal(y.applyEdits(text, result.edits), result.text, where);
    assert.deepEqual(y.parse(result.text).errors, [], where);
    if (shape === 'insertion') assert.ok(result.edits.every((e) => e.length === 0), `${where} only inserts`);
    if (shape === 'deletion') assert.ok(result.edits.every((e) => e.text === ''), `${where} only deletes`);
    if (shape === 'one splice') assert.equal(result.edits.length, 1, where);
  }
});

test('every detail command keeps Windows line breaks', () => {
  const text = fixture('course-registration.yml').replace(/\n/g, '\r\n');
  const reference = design(text);
  for (const [command] of FIXTURE_COMMANDS) {
    const result = edit.apply(reference, command);
    assert.equal(result.error, undefined, JSON.stringify(command));
    assert.doesNotMatch(result.text, /(^|[^\r])\n/, `${JSON.stringify(command)} writes only \\r\\n`);
  }
});
