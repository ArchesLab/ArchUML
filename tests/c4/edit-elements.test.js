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

/** The diagnostics of `text` (read as an embed, which needs no schema line) as `rule path` strings. */
function problemsOf(text) {
  return model.normalize(y.parse(text), { source: 'embed' }).diagnostics.map((d) => `${d.rule} ${(d.path || []).join('.')}`);
}

/** Applies `command` to `text`; fails unless the command succeeds and its edits produce its text. */
function applied(text, command) {
  const result = edit.apply(design(text), command);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(y.applyEdits(text, result.edits), result.text, 'the edits turn the input into the returned text');
  return result;
}

/** The data at `path` of the YAML `text`. */
function dataAt(text, path) {
  return path.reduce((value, segment) => (value == null ? undefined : value[segment]), y.toData(y.parse(text)));
}

// ---- addElement ------------------------------------------------------------------------------

const SHOP = lines(
  'systems:',
  '  shop:',
  '    name: Shop',
  '    description: Sells books.',
  '    tags: [retail]',
);

test('addElement inserts a container with a slug id and canonical keys', () => {
  const first = applied(SHOP, { op: 'addElement', parentId: 'shop', type: 'container', kind: 'database', name: 'Registration Database' });
  assert.equal(first.text, lines(
    'systems:',
    '  shop:',
    '    name: Shop',
    '    description: Sells books.',
    '    containers:',
    '      registration-database:',
    '        name: Registration Database',
    '        kind: database',
    '    tags: [retail]',
  ));
  assert.deepEqual(first.edits.map((e) => e.length), [0], 'one insertion');
  assert.deepEqual(first.selection, { elementId: 'registration-database' });

  const second = applied(first.text, { op: 'addElement', parentId: 'shop', type: 'container', name: 'Registration Database' });
  assert.deepEqual(second.selection, { elementId: 'registration-database-2' });
  assert.deepEqual(dataAt(second.text, ['systems', 'shop', 'containers', 'registration-database-2']), { name: 'Registration Database' });
});

test('addElement slugs code elements in PascalCase and adds people and systems at the top level', () => {
  const component = lines(
    'systems:',
    '  shop:',
    '    containers:',
    '      api:',
    '        components:',
    '          pricing: {name: Pricing}',
  );
  const code = applied(component, { op: 'addElement', parentId: 'pricing', type: 'code', kind: 'interface', name: 'Enrollment Policy' });
  assert.deepEqual(code.selection, { elementId: 'EnrollmentPolicy' });
  assert.deepEqual(dataAt(code.text, ['systems', 'shop', 'containers', 'api', 'components', 'pricing', 'code']),
    { EnrollmentPolicy: { name: 'Enrollment Policy', kind: 'interface' } });

  const person = applied(SHOP, { op: 'addElement', parentId: null, type: 'person', name: 'Café Owner' });
  assert.equal(person.text, lines('people:', '  cafe-owner:', '    name: Café Owner') + SHOP);
  assert.deepEqual(person.selection, { elementId: 'cafe-owner' });
});

test('addElement refuses a type its parent cannot hold and a kind the type does not have', () => {
  const shop = design(SHOP);
  assert.equal(edit.apply(shop, { op: 'addElement', parentId: 'shop', type: 'component', name: 'X' }).error, 'invalid-parent');
  assert.equal(edit.apply(shop, { op: 'addElement', parentId: null, type: 'container', name: 'X' }).error, 'invalid-parent');
  assert.equal(edit.apply(shop, { op: 'addElement', parentId: 'nowhere', type: 'container', name: 'X' }).error, 'unknown-element');
  assert.equal(edit.apply(shop, { op: 'addElement', parentId: 'shop', type: 'container', kind: 'class', name: 'X' }).error, 'invalid-kind');
  assert.equal(edit.apply(shop, { op: 'addElement', parentId: null, type: 'system', kind: 'database', name: 'X' }).error, 'invalid-kind');
});

// ---- setElementField -------------------------------------------------------------------------

test('setElementField writes and deletes fields in canonical order', () => {
  const text = lines(
    'systems:',
    '  shop:',
    '    containers:',
    '      api:',
    '        name: API',
    '        description: Takes orders.   # short',
    '        responsibilities:',
    '          - do: take orders',
  );
  const technology = applied(text, { op: 'setElementField', elementId: 'api', field: 'technology', value: 'Go' });
  assert.equal(technology.text, text.replace('        responsibilities:', '        technology: Go\n        responsibilities:'));
  assert.deepEqual(technology.selection, { elementId: 'api' });

  const kind = applied(technology.text, { op: 'setElementField', elementId: 'api', field: 'kind', value: 'function' });
  assert.equal(kind.text, technology.text.replace('        technology: Go', '        kind: function\n        technology: Go'));

  const renamed = applied(kind.text, { op: 'setElementField', elementId: 'api', field: 'name', value: 'Orders API' });
  assert.equal(renamed.text, kind.text.replace('name: API', 'name: Orders API'));

  const tags = applied(renamed.text, { op: 'setElementField', elementId: 'api', field: 'tags', value: ['core', 'go'] });
  assert.equal(tags.text, renamed.text + lines('        tags:', '          - core', '          - go'));

  const withoutDescription = applied(tags.text, { op: 'setElementField', elementId: 'api', field: 'description', value: null });
  assert.equal(withoutDescription.text, tags.text.replace('        description: Takes orders.   # short\n', ''));

  const absent = applied(withoutDescription.text, { op: 'setElementField', elementId: 'api', field: 'source', value: null });
  assert.deepEqual(absent.edits, []);
  assert.equal(absent.text, withoutDescription.text);
});

test('setElementField refuses fields the element type does not have and child collections', () => {
  const shop = design(SHOP);
  assert.equal(edit.apply(shop, { op: 'setElementField', elementId: 'shop', field: 'technology', value: 'Go' }).error, 'invalid-field');
  assert.equal(edit.apply(shop, { op: 'setElementField', elementId: 'shop', field: 'containers', value: null }).error, 'invalid-field');
  assert.equal(edit.apply(shop, { op: 'setElementField', elementId: 'nowhere', field: 'name', value: 'X' }).error, 'unknown-element');
});

// ---- deleteElement ---------------------------------------------------------------------------

// `db` is referenced from every site that Delete cleans up. The refines link names a responsibility of `db`
// from outside it (which the model reports), the only way such a link survives the deleted subtree.
const REFERENCED_DB = lines(
  'schema: c4-design/1',
  'systems:',
  '  shop:',
  '    containers:',
  '      api:',
  '        responsibilities:',
  '          - do: take orders',
  '            refines: db-do-1',
  '        collaborators:',
  '          db: writes orders to',
  '          web: notifies',
  '      web:',
  '        name: Web',
  '      db:',
  '        name: Database',
  '        responsibilities:',
  '          - do: store orders',
  '            id: db-do-1',
  'scenarios:',
  '  order:',
  '    steps:',
  '      - api -> db: writes orders to',
  '      - api -> web: notifies',
  'deployment:',
  '  prod:',
  '    nodes:',
  '      server: {hosts: [api, db]}',
  'decisions:',
  '  one-db:',
  '    title: One database',
  '    affects: [db, api]',
  'views:',
  '  storage:',
  '    view: containers of shop',
  '    include: [db]',
  'layout:',
  '  containers of shop:',
  '    api: [10, 20]',
  '    db: [30, 40]',
  'checks:',
  '  ignore:',
  '    - rule: c4/no-technology',
  '      element: db',
  '      because: drafted',
);

test('deleteElement removes the element and every dependent reference', () => {
  const result = applied(REFERENCED_DB, { op: 'deleteElement', elementId: 'db' });
  assert.equal(result.text, lines(
    'schema: c4-design/1',
    'systems:',
    '  shop:',
    '    containers:',
    '      api:',
    '        responsibilities:',
    '          - do: take orders',
    '        collaborators:',
    '          web: notifies',
    '      web:',
    '        name: Web',
    'scenarios:',
    '  order:',
    '    steps:',
    '      - api -> web: notifies',
    'deployment:',
    '  prod:',
    '    nodes:',
    '      server: {hosts: [api]}',
    'decisions:',
    '  one-db:',
    '    title: One database',
    '    affects: [api]',
    'views:',
    '  storage:',
    '    view: containers of shop',
    'layout:',
    '  containers of shop:',
    '    api: [10, 20]',
  ));
  assert.ok(result.edits.every((e) => e.text === ''), 'a delete only removes text');
  assert.equal(result.selection, null);
  assert.deepEqual(problemsOf(result.text), []);
});

test('dependentsOf lists every reference a delete removes, in document order', () => {
  const dependents = edit.dependentsOf(design(REFERENCED_DB), 'db');
  assert.deepEqual(dependents.map(({ kind, path }) => [kind, path]), [
    ['refines', ['systems', 'shop', 'containers', 'api', 'responsibilities', 0, 'refines']],
    ['collaborator', ['systems', 'shop', 'containers', 'api', 'collaborators', 'db']],
    ['step', ['scenarios', 'order', 'steps', 0]],
    ['hosts', ['deployment', 'prod', 'nodes', 'server', 'hosts', 1]],
    ['affects', ['decisions', 'one-db', 'affects', 0]],
    ['include', ['views', 'storage', 'include', 0]],
    ['layout', ['layout', 'containers of shop', 'db']],
    ['ignore', ['checks', 'ignore', 0]],
  ]);
  assert.equal(dependents[1].label, 'api collaborates with Database');
});

test('deleteElement removes a subtree without listing the references inside it', () => {
  const reference = fixture('course-registration.yml');
  const dependents = edit.dependentsOf(design(reference), 'api');
  assert.deepEqual(dependents.map(({ kind, path }) => [kind, path]), [
    ['collaborator', ['systems', 'registration', 'containers', 'web', 'collaborators', 'coordinator']],
    ['step', ['scenarios', 'enroll', 'steps', 0]],
    ['step', ['scenarios', 'enroll', 'steps', 1]],
    ['step', ['scenarios', 'enroll', 'steps', 2, 'alt', 0, 'steps', 0]],
    ['step', ['scenarios', 'enroll', 'steps', 2, 'alt', 0, 'steps', 1]],
    ['step', ['scenarios', 'enroll', 'steps', 2, 'alt', 1, 'steps', 0]],
    ['hosts', ['deployment', 'production', 'nodes', 'campus-cloud', 'nodes', 'api-pod', 'hosts', 0]],
    ['affects', ['decisions', 'one-database', 'affects', 1]],
  ]);
  const result = applied(reference, { op: 'deleteElement', elementId: 'api' });
  const data = y.toData(y.parse(result.text));
  assert.deepEqual(Object.keys(data.systems.registration.containers), ['web', 'db']);
  assert.equal(data.systems.registration.containers.web.collaborators, undefined);
  assert.deepEqual(data.scenarios.enroll.steps, [{ alt: [{ when: 'eligible' }, { when: 'not eligible' }] }]);
  assert.deepEqual(data.decisions['one-database'].affects, ['db']);
  assert.equal(data.deployment.production.nodes['campus-cloud'].nodes['api-pod'].hosts, undefined);
  assert.deepEqual(problemsOf(result.text), []);
});

test('deleteElement removes code references to a deleted class', () => {
  const text = lines(
    'systems:',
    '  s:',
    '    containers:',
    '      c:',
    '        components:',
    '          k:',
    '            code:',
    '              Rule: {kind: interface}',
    '              Base: {kind: abstract_class}',
    '              Concrete: {extends: Base, implements: [Rule]}',
  );
  const result = applied(text, { op: 'deleteElement', elementId: 'Base' });
  assert.equal(result.text, text.replace('              Base: {kind: abstract_class}\n', '').replace('extends: Base, ', ''));
  assert.deepEqual(edit.dependentsOf(design(text), 'Rule').map(({ kind, path }) => [kind, path]),
    [['implements', ['systems', 's', 'containers', 'c', 'components', 'k', 'code', 'Concrete', 'implements', 0]]]);
});

test('deleteElement keeps a class whose only field named the deleted class', () => {
  const text = lines(
    'systems:',
    '  s:',
    '    containers:',
    '      c:',
    '        components:',
    '          k:',
    '            code:',
    '              Base: {kind: abstract_class}',
    '              Concrete: {extends: Base}',
  );
  const result = applied(text, { op: 'deleteElement', elementId: 'Base' });
  assert.equal(result.text, text.replace('              Base: {kind: abstract_class}\n', '').replace('{extends: Base}', '{}'));
  assert.deepEqual(problemsOf(result.text), []);
});

test('deleteElement keeps a deployment node whose only field hosted the deleted element', () => {
  const text = lines(
    'systems:',
    '  s:',
    '    containers:',
    '      c: {name: C}',
    'deployment:',
    '  production:',
    '    nodes:',
    '      server:',
    '        hosts: c',
  );
  const result = applied(text, { op: 'deleteElement', elementId: 'c' });
  assert.equal(result.text, lines(
    'systems:',
    '  s:',
    'deployment:',
    '  production:',
    '    nodes:',
    '      server:',
  ));
  assert.deepEqual(Object.keys(dataAt(result.text, ['deployment', 'production', 'nodes'])), ['server']);
});

test('add then delete restores the original text', () => {
  const reference = fixture('course-registration.yml');
  const parents = [[null, 'person'], [null, 'system'], ['registration', 'container'], ['billing', 'container'],
    ['api', 'component'], ['db', 'component'], ['policy', 'code'], ['seats', 'code']];
  for (const [parentId, type] of parents) {
    const added = applied(reference, { op: 'addElement', parentId, type, name: 'New Part' });
    const removed = applied(added.text, { op: 'deleteElement', elementId: added.selection.elementId });
    assert.equal(removed.text, reference, `${type} in ${parentId}`);
  }
});

// ---- changeElementId -------------------------------------------------------------------------

const REFERENCED_API = lines(
  'view: components of api',
  'systems:',
  '  shop:',
  '    containers:',
  '      web:',
  '        collaborators:',
  '          api: {description: sends orders to, responsibility: api-do-1}',
  '      api:',
  '        responsibilities:',
  '          - do: take orders',
  '            id: api-do-1',
  '        components:',
  '          worker:',
  '            responsibilities:',
  '              - do: queue orders',
  '                refines: api-do-1',
  '            code:',
  '              Rule: {kind: interface}',
  '              Base: {kind: abstract_class}',
  '              Concrete: {extends: Base, implements: [Rule]}',
  'scenarios:',
  '  order:',
  '    steps:',
  '      - web ->  api: sends orders to',
  '      - {from: api, to: web, description: confirms the order to, responsibility: api-do-1}',
  'deployment:',
  '  prod:',
  '    nodes:',
  '      server: {hosts: api}',
  'decisions:',
  '  go:',
  '    title: Write the API in Go',
  '    affects: [api]',
  'views:',
  '  inside:',
  '    view: Components of api',
  '    include: [api]',
  '  outside:',
  '    view: containers of shop',
  '    exclude: [api]',
  'layout:',
  '  components of api:',
  '    worker: [1, 2]',
  '  containers of shop:',
  '    api: [3, 4]',
  'checks:',
  '  ignore:',
  '    - {rule: c4/no-technology, element: api, because: drafted}',
);

test('changeElementId rewrites every reference site', () => {
  assert.deepEqual(problemsOf(REFERENCED_API), []);
  const result = applied(REFERENCED_API, { op: 'changeElementId', elementId: 'api', newId: 'gateway' });
  const at = (...path) => dataAt(result.text, path);
  assert.deepEqual(result.selection, { elementId: 'gateway' });
  assert.deepEqual(Object.keys(at('systems', 'shop', 'containers')), ['web', 'gateway'], 'element key');
  assert.deepEqual(Object.keys(at('systems', 'shop', 'containers', 'web', 'collaborators')), ['gateway'], 'collaborator key');
  assert.equal(at('systems', 'shop', 'containers', 'gateway', 'responsibilities', 0, 'id'), 'gateway-do-1', 'generated responsibility id');
  assert.equal(at('systems', 'shop', 'containers', 'gateway', 'components', 'worker', 'responsibilities', 0, 'refines'), 'gateway-do-1', 'refines');
  assert.equal(at('systems', 'shop', 'containers', 'web', 'collaborators', 'gateway', 'responsibility'), 'gateway-do-1', 'collaborator responsibility');
  assert.deepEqual(at('decisions', 'go', 'affects'), ['gateway'], 'affects');
  assert.equal(at('deployment', 'prod', 'nodes', 'server', 'hosts'), 'gateway', 'hosts');
  assert.deepEqual(Object.keys(at('scenarios', 'order', 'steps', 0)), ['web ->  gateway'], 'step shorthand key');
  assert.equal(at('scenarios', 'order', 'steps', 1, 'from'), 'gateway', 'step map from');
  assert.equal(at('scenarios', 'order', 'steps', 1, 'responsibility'), 'gateway-do-1', 'step responsibility');
  assert.deepEqual(at('views', 'inside', 'include'), ['gateway'], 'include');
  assert.deepEqual(at('views', 'outside', 'exclude'), ['gateway'], 'exclude');
  assert.equal(at('views', 'inside', 'view'), 'Components of gateway', 'views.*.view');
  assert.equal(at('view'), 'components of gateway', 'top-level view');
  assert.deepEqual(Object.keys(at('layout')), ['components of gateway', 'containers of shop'], 'layout key');
  assert.deepEqual(Object.keys(at('layout', 'containers of shop')), ['gateway'], 'layout entry');
  assert.equal(at('checks', 'ignore', 0, 'element'), 'gateway', 'checks.ignore[].element');
  assert.deepEqual(problemsOf(result.text), []);
});

test('changeElementId rewrites extends and implements', () => {
  const base = applied(REFERENCED_API, { op: 'changeElementId', elementId: 'Base', newId: 'Root' });
  const rule = applied(base.text, { op: 'changeElementId', elementId: 'Rule', newId: 'Policy' });
  assert.equal(rule.text, REFERENCED_API
    .replace('Rule: {kind: interface}', 'Policy: {kind: interface}')
    .replace('Base: {kind: abstract_class}', 'Root: {kind: abstract_class}')
    .replace('{extends: Base, implements: [Rule]}', '{extends: Root, implements: [Policy]}'));
});

test('changeElementId refuses malformed and taken ids and changes nothing for the same id', () => {
  const api = design(REFERENCED_API);
  assert.equal(edit.apply(api, { op: 'changeElementId', elementId: 'api', newId: '2api' }).error, 'invalid-id');
  assert.equal(edit.apply(api, { op: 'changeElementId', elementId: 'api', newId: 'web' }).error, 'id-taken');
  assert.equal(edit.apply(api, { op: 'changeElementId', elementId: 'nowhere', newId: 'x' }).error, 'unknown-element');
  assert.deepEqual(edit.apply(api, { op: 'changeElementId', elementId: 'api', newId: 'api' }),
    { text: REFERENCED_API, edits: [], selection: { elementId: 'api' } });
});

// ---- moveElement -----------------------------------------------------------------------------

test('moveElement re-parents a component and keeps its comments', () => {
  const text = lines(
    'systems:',
    '  shop:',
    '    containers:',
    '      api:',
    '        name: API',
    '        components:',
    '          # Prices every order.',
    '          pricing:',
    '            name: Pricing   # renamed in v2',
    '            technology: Go',
    '          orders:',
    '            name: Orders',
    '      worker:',
    '        name: Worker',
    '        tags: [batch]',
  );
  const result = applied(text, { op: 'moveElement', elementId: 'pricing', newParentId: 'worker' });
  assert.equal(result.text, lines(
    'systems:',
    '  shop:',
    '    containers:',
    '      api:',
    '        name: API',
    '        components:',
    '          orders:',
    '            name: Orders',
    '      worker:',
    '        name: Worker',
    '        components:',
    '          # Prices every order.',
    '          pricing:',
    '            name: Pricing   # renamed in v2',
    '            technology: Go',
    '        tags: [batch]',
  ));
  assert.deepEqual(result.selection, { elementId: 'pricing' });

  const back = applied(result.text, { op: 'moveElement', elementId: 'orders', newParentId: 'worker' });
  assert.equal(dataAt(back.text, ['systems', 'shop', 'containers', 'api', 'components']), undefined, 'an emptied components key goes');
});

test('moveElement removes collaborator responsibilities that stop resolving', () => {
  const text = lines(
    'systems:',
    '  shop:',
    '    containers:',
    '      web:',
    '        collaborators:',
    '          api: {description: sends orders to, responsibility: pricing-do-1}',
    '      api:',
    '        components:',
    '          pricing:',
    '            responsibilities:',
    '              - do: price orders',
    '                id: pricing-do-1',
    '      worker:',
    '        name: Worker',
  );
  const result = applied(text, { op: 'moveElement', elementId: 'pricing', newParentId: 'worker' });
  assert.deepEqual(dataAt(result.text, ['systems', 'shop', 'containers', 'web', 'collaborators', 'api']), { description: 'sends orders to' });
  assert.deepEqual(problemsOf(result.text), []);
});

test('moveElement keeps a collaborator whose only field was the responsibility that stopped resolving', () => {
  const text = lines(
    'systems:',
    '  shop:',
    '    containers:',
    '      web:',
    '        collaborators:',
    '          api: {responsibility: pricing-do-1}',
    '      api:',
    '        components:',
    '          pricing:',
    '            responsibilities:',
    '              - do: price orders',
    '                id: pricing-do-1',
    '          orders: {name: Orders}',
    '      worker:',
    '        name: Worker',
  );
  const result = applied(text, { op: 'moveElement', elementId: 'pricing', newParentId: 'worker' });
  assert.deepEqual(dataAt(result.text, ['systems', 'shop', 'containers', 'web', 'collaborators']), { api: {} });
  assert.deepEqual(problemsOf(result.text), []);
});

test('moveElement refuses a parent of the wrong type', () => {
  const reference = design(fixture('course-registration.yml'));
  assert.equal(edit.apply(reference, { op: 'moveElement', elementId: 'policy', newParentId: 'registration' }).error, 'invalid-parent');
  assert.equal(edit.apply(reference, { op: 'moveElement', elementId: 'registration', newParentId: 'billing' }).error, 'invalid-parent');
});

// ---- Every command -------------------------------------------------------------------------

test('commands are refused while YAML errors exist', () => {
  const broken = design('systems:\n  shop: {name: Shop\n');
  assert.ok(broken.parsed.errors.length > 0);
  for (const command of [
    { op: 'addElement', parentId: null, type: 'system', name: 'X' },
    { op: 'setElementField', elementId: 'shop', field: 'name', value: 'X' },
    { op: 'deleteElement', elementId: 'shop' },
    { op: 'changeElementId', elementId: 'shop', newId: 'store' },
    { op: 'moveElement', elementId: 'shop', newParentId: 'x' },
  ]) {
    assert.deepEqual(edit.apply(broken, command), { error: 'yaml-errors' }, command.op);
  }
});

test('an unknown command is refused', () => {
  assert.equal(edit.apply(design(SHOP), { op: 'paint' }).error, 'unknown-command');
});

/** Every element command that applies to the reference model, with the shape its edits must have. */
function elementCommands(reference) {
  const commands = [];
  for (const element of reference.model.elements.values()) {
    const id = element.id;
    commands.push([{ op: 'deleteElement', elementId: id }, 'deletion']);
    commands.push([{ op: 'changeElementId', elementId: id, newId: `${id}Renamed` }, 'rename']);
    commands.push([{ op: 'setElementField', elementId: id, field: 'source', value: 'src/x' }, 'insertion']);
    commands.push([{ op: 'setElementField', elementId: id, field: 'name', value: null }, 'deletion']);
    const childType = { system: 'container', container: 'component', component: 'code' }[element.type];
    if (childType) commands.push([{ op: 'addElement', parentId: id, type: childType, name: 'Added Part' }, 'insertion']);
    if (element.type === 'component' && element.parentId === 'api') {
      commands.push([{ op: 'moveElement', elementId: id, newParentId: 'web' }, 'move']);
    }
  }
  return commands;
}

test('every element command leaves text outside its edits unchanged', () => {
  const text = fixture('course-registration.yml');
  const reference = design(text);
  for (const [command, shape] of elementCommands(reference)) {
    const where = JSON.stringify(command);
    const result = edit.apply(reference, command);
    assert.equal(result.error, undefined, where);
    assert.equal(y.applyEdits(text, result.edits), result.text, where);
    assert.deepEqual(y.parse(result.text).errors, [], where);
    if (shape === 'insertion') assert.ok(result.edits.every((e) => e.length === 0), `${where} only inserts`);
    if (shape === 'deletion') assert.ok(result.edits.every((e) => e.text === ''), `${where} only deletes`);
    if (shape === 'rename') {
      const renamed = (span) => span.replace(new RegExp(`(?<![A-Za-z0-9_-])${command.elementId}(?![A-Za-z0-9_-])`, 'g'), command.newId);
      for (const e of result.edits) assert.equal(e.text, renamed(text.slice(e.offset, e.offset + e.length)), `${where} only renames`);
    }
    if (shape === 'move') {
      // `web` has no components yet, so the moved entry arrives under a new `components:` key, unchanged.
      const [removal] = result.edits.filter((e) => e.text === '');
      const [insertion] = result.edits.filter((e) => e.length === 0);
      assert.equal(result.edits.length, 2, where);
      assert.equal(insertion.text, '        components:\n' + text.slice(removal.offset, removal.offset + removal.length), where);
    }
  }
});
