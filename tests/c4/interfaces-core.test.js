'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const YAML = require('../../vendor/yaml/2.9.1/yaml.js');
const { loadCore, fixture } = require('./helpers.js');

// The facade additions of the interface descriptions (spec §3, §4.11), the committed JSON Schema, and the
// performance bound of Milestone 1 Review Focus 5 extended to interfaces.

const core = loadCore();
const C4_ROOT = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(C4_ROOT, 'c4', 'manifest.json'), 'utf8'));
const SCHEMA_FILE = path.join(C4_ROOT, 'c4', 'schema', '1', 'design.schema.json');
const TIME_BOUND_MS = 3000;

const REGISTRATION = core.load(fixture('course-registration-interfaces.yml'), { source: 'file' });
const ENDPOINT = core.load(fixture('interfaces-endpoint.yml'), { source: 'file' });
const EVENTS = core.load(fixture('interfaces-events.yml'), { source: 'file' });

/** `text` with `from` replaced by `to`; fails when `from` is absent, so an edit cannot silently miss. */
function replaced(text, from, to) {
  assert.ok(text.includes(from), `the model text contains ${from}`);
  return text.replace(from, to);
}

const interfaceIds = (entries) => entries.map((entry) => entry.interfaceId);

test('every manifest file still loads in order and publishes version 1.1.0', () => {
  const context = vm.createContext({});
  context.self = context;
  manifest.core.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(C4_ROOT, file), 'utf8'), context, { filename: file });
  });
  assert.equal(vm.runInContext('ArchUMLC4.version', context), '1.1.0');
  assert.equal(core.version, '1.1.0');
});

test('usableInterfaces offers the interface a request enters through, marked as entered', () => {
  const [entered] = core.usableInterfaces(REGISTRATION, { sourceId: 'web', targetId: 'coordinator' });
  assert.equal(entered.interfaceId, 'enrollment-api');
  assert.equal(entered.relation, 'entered');
  assert.equal(entered.providerId, 'api');
  assert.equal(entered.providerName, 'Registration API');
  assert.deepEqual(entered.operations.map((operation) => operation.id), ['submit-plan']);
});

test('usableInterfaces offers nothing between elements that no interface connects', () => {
  assert.deepEqual(core.usableInterfaces(REGISTRATION, { sourceId: 'seats', targetId: 'db' }), []);
});

test('usableInterfaces offers the interface of the target itself with its operations', () => {
  const usable = core.usableInterfaces(REGISTRATION, { sourceId: 'billing-gateway', targetId: 'billing' });
  assert.equal(usable.length, 1);
  assert.equal(usable[0].interfaceId, 'tuition-charges');
  assert.equal(usable[0].relation, 'target');
  assert.deepEqual(usable[0].operations,
    [{ id: 'charge-tuition', syntax: 'send ChargeRequested to the queue billing.charges', realizes: [] }]);
});

test('usableInterfaces marks an interface provided inside the target as inside-target', () => {
  const usable = core.usableInterfaces(ENDPOINT, { sourceId: 'web', targetId: 'api' });
  const endpoint = usable.find((entry) => entry.interfaceId === 'enrollment-endpoint');
  assert.equal(endpoint.relation, 'inside-target');
});

test('usableInterfaces marks emission, channel, and broker-peer uses of an event interface', () => {
  const relationOf = (sourceId, targetId) => core.usableInterfaces(EVENTS, { sourceId, targetId })
    .filter((entry) => entry.interfaceId === 'order-events').map((entry) => entry.relation);
  assert.deepEqual(relationOf('orders', 'analytics'), ['emitted']);
  assert.deepEqual(relationOf('orders', 'order-topic'), ['channel']);
  assert.deepEqual(relationOf('shipping', 'order-topic'), ['broker-peer']);
});

test('usableInterfaces lists interfaces in document order, not alphabetical order', () => {
  const design = core.load(`systems:
  shop:
    name: Shop
    containers:
      api:
        name: API
        provides:
          zeta: {operations: {z: "GET /z"}}
          alpha: {operations: {a: "GET /a"}}
      web:
        name: Web
`, { source: 'embed' });
  assert.deepEqual(interfaceIds(core.usableInterfaces(design, { sourceId: 'web', targetId: 'api' })), ['zeta', 'alpha']);
});

test('usableInterfaces leaves out in-process interfaces across containers', () => {
  const withPolicyInterface = core.load(replaced(fixture('course-registration-interfaces.yml'),
    '            name: Enrollment Policy\n',
    '            name: Enrollment Policy\n            provides: ["decide(student, section) -> Decision"]\n'), { source: 'file' });
  assert.deepEqual(interfaceIds(core.usableInterfaces(withPolicyInterface, { sourceId: 'web', targetId: 'api' })), ['enrollment-api']);
  assert.deepEqual(interfaceIds(core.usableInterfaces(withPolicyInterface, { sourceId: 'coordinator', targetId: 'policy' })), ['policy']);
});

test('usableInterfaces answers an unreadable design or unknown element with an empty list', () => {
  const unreadable = core.load('systems: [unclosed', { source: 'embed' });
  assert.deepEqual(core.usableInterfaces(unreadable, { sourceId: 'a', targetId: 'b' }), []);
  assert.deepEqual(core.usableInterfaces(REGISTRATION, { sourceId: 'nobody', targetId: 'api' }), []);
});

test('interfacesOf returns the provided and required sets of a container', () => {
  const { provided, required } = core.interfacesOf(REGISTRATION, 'api');
  assert.deepEqual(interfaceIds(provided), ['enrollment-api']);
  assert.deepEqual(interfaceIds(required), ['tuition-charges']);
  assert.equal(required[0].providerId, 'billing');
});

test('interfacesOf shows an interface handled by a component as delegated from its container', () => {
  const { provided } = core.interfacesOf(REGISTRATION, 'coordinator');
  const delegated = provided.find((entry) => entry.interfaceId === 'enrollment-api');
  assert.equal(delegated.delegatedFromId, 'api');
  assert.equal(delegated.delegatedFromName, 'Registration API');
});

test('interfacesOf answers an unreadable design with empty sets', () => {
  const unreadable = core.load('systems: [unclosed', { source: 'embed' });
  assert.deepEqual(core.interfacesOf(unreadable, 'api'), { provided: [], required: [] });
});

test('interfaceDependentsOf lists the uses entries that name the interface', () => {
  const dependents = core.interfaceDependentsOf(REGISTRATION, 'enrollment-api');
  assert.ok(dependents.length >= 1);
  assert.ok(dependents.every((entry) => ['kind', 'path', 'label'].every((key) => key in entry)));
  assert.deepEqual(core.interfaceDependentsOf(REGISTRATION, 'no-such-interface'), []);
  assert.deepEqual(core.interfaceDependentsOf(core.load('systems: [unclosed', { source: 'embed' }), 'x'), []);
});

test('listViews adds the interface views only when asked', () => {
  const plain = core.listViews(REGISTRATION).map((view) => view.selector);
  const withInterfaces = core.listViews(REGISTRATION, { interfaces: true }).map((view) => view.selector);
  assert.equal(plain.length, 7);
  assert.equal(withInterfaces.length, 15);
  assert.deepEqual(withInterfaces.filter((selector) => plain.includes(selector)), plain);
});

test('describe with panels syntax leaves out the semantic panels of an interface card', () => {
  const view = core.project(REGISTRATION, 'interface enrollment-api');
  const all = core.describe(view);
  const syntax = core.describe(view, { panels: 'syntax' });
  assert.equal(syntax.brief, all.brief);
  const length = (description) => description.sections.reduce((sum, section) => sum + section.items.length, 0);
  assert.ok(length(syntax) < length(all));
});

// ---- The committed JSON Schema ----------------------------------------------------------------

test('the committed JSON Schema equals the generated one', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')), core.toJsonSchema());
});

/** A validator for the draft-07 subset the generated schema uses; no validator library is available. */
function validator(rootSchema) {
  const resolve = (ref) => ref.slice('#/definitions/'.length).split('/').reduce((node, key) => node[key], rootSchema.definitions);
  const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array'
    : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value);
  const typeMatches = (expected, value) => [].concat(expected)
    .some((name) => name === typeOf(value) || (name === 'number' && typeOf(value) === 'integer'));
  const objectValid = (node, value) => {
    const declared = node.properties || {};
    const patterns = Object.entries(node.patternProperties || {});
    const required = node.required || [];
    if (!required.every((key) => key in value)) return false;
    if (node.minProperties !== undefined && Object.keys(value).length < node.minProperties) return false;
    return Object.entries(value).every(([key, item]) => {
      const matching = patterns.filter(([pattern]) => new RegExp(pattern).test(key));
      if (key in declared && !valid(declared[key], item)) return false;
      if (!matching.every(([, subschema]) => valid(subschema, item))) return false;
      return key in declared || matching.length > 0 || node.additionalProperties !== false;
    });
  };
  function valid(node, value) {
    if (node.$ref) return valid(resolve(node.$ref), value);
    if (node.anyOf && !node.anyOf.some((option) => valid(option, value))) return false;
    if (node.enum && !node.enum.some((option) => option === value)) return false;
    if (node.if) {
      const branch = valid(node.if, value) ? node.then : node.else;
      if (branch && !valid(branch, value)) return false;
    }
    if (node.type && !typeMatches(node.type, value)) return false;
    if (node.pattern && !(typeof value === 'string' && new RegExp(node.pattern).test(value))) return false;
    if (node.minimum !== undefined && !(typeof value === 'number' && value >= node.minimum)) return false;
    if (typeOf(value) === 'array') {
      if (node.minItems !== undefined && value.length < node.minItems) return false;
      if (node.maxItems !== undefined && value.length > node.maxItems) return false;
      if (node.items && !value.every((item) => valid(node.items, item))) return false;
    }
    return typeOf(value) !== 'object' || objectValid(node, value);
  }
  return (value) => valid(rootSchema, value);
}

const schemaAccepts = validator(core.toJsonSchema());

/** A model with one container `api` whose `provides` is `provides`, wrapped so each corpus entry stays short. */
function withProvides(provides, extra = '') {
  return `systems:\n  shop:\n    name: Shop\n    containers:\n      api:\n        name: API\n        provides: ${provides}\n${extra}`;
}

const INTERFACE = (body) => withProvides(`\n          orders:\n${body.split('\n').map((line) => `            ${line}`).join('\n')}`);

/** A client system whose collaborator on the shop carries `collaboratorFields`; the shop's api provides `orders`. */
function withClient(collaboratorFields) {
  const fields = collaboratorFields.startsWith('description') ? collaboratorFields : `description: asks, ${collaboratorFields}`;
  return `people: {}\nsystems:\n  client:\n    name: Client\n    collaborators:\n      shop: {${fields}}\n  shop:\n    name: Shop\n    containers:\n      api:\n        name: API\n        provides:\n          orders:\n            operations:\n              place: POST /orders\n              list: GET /orders\n`;
}

const ACCEPTED = {
  'a shorthand list': withProvides('["GET /orders", "POST /orders"]'),
  'an empty list': withProvides('[]'),
  'a full form interface': INTERFACE('name: Orders\nstyle: rest\noperations:\n  list: GET /orders'),
  'an operation with input, output, and an example': INTERFACE('operations:\n  place:\n    syntax: POST /orders\n    input: Order\n    output: Order\n    examples:\n      - input: {id: 1}\n        note: first\n    errors:\n      invalid: the order is invalid'),
  'a field map and the field shorthands': INTERFACE('types:\n  Order:\n    fields:\n      id: string\n      total: {type: integer, unit: cents, required: false}'),
  'a values map and a values list': INTERFACE('types:\n  Order:\n    fields:\n      status: {type: string, values: {open: still editable, closed: final}}\n      kind: {type: string, values: [a, b]}'),
  'constraints as a string and as a list': INTERFACE('types:\n  Order:\n    fields:\n      a: {type: string, constraints: at most 10 characters}\n      b: {type: string, constraints: [x, y]}'),
  'interface-level restrictions and errors': INTERFACE('restrictions: [only staff]\nerrors:\n  denied: {when: not allowed, code: 401}'),
  'a document format': INTERFACE('types:\n  Roster:\n    fields:\n      name: string'),
  'required as a quoted false': INTERFACE('types:\n  Order:\n    fields:\n      a: {type: string, required: "false"}'),
  'version 1.10': INTERFACE('version: 1.10'),
  'an error code of 401': INTERFACE('errors:\n  denied: {when: not allowed, code: 401}'),
  'fields named required and external': INTERFACE('types:\n  Order:\n    fields:\n      required: boolean\n      external: boolean'),
  'str as a field type': INTERFACE('types:\n  Order:\n    fields:\n      id: str'),
  'top-level vocabulary': 'vocabulary:\n  unit: a credit\n',
  'uses as a string': withClient('uses: orders'),
  'uses as a list': withClient('uses: [orders.place, orders.list]'),
  'a step uses': `${withClient('uses: orders.place')}scenarios:\n  s:\n    steps:\n      - from: client\n        to: shop\n        description: asks\n        uses: orders.place\n`,
  'annotations interfaces on a dynamic custom view': `${withClient('uses: orders.place')}scenarios:\n  s:\n    steps:\n      - client -> shop: asks\nviews:\n  flow:\n    view: dynamic s\n    annotations: [interfaces]\n`,
};

const REJECTED = {
  'a provides list that mixes syntax lines and maps': withProvides('["GET /orders", {a: b}]'),
  'a misspelled interface key': INTERFACE('stlye: rest'),
  'an unknown interface style': INTERFACE('style: restful'),
  'a field map with an unknown key (the comma typo)': INTERFACE('types:\n  Order:\n    fields:\n      a: {type: string, meaning: a, b}'),
  'uses on a deployment node collaborator': 'deployment:\n  prod:\n    nodes:\n      n:\n        collaborators:\n          m: {description: x, uses: orders}\n',
  'an example with no keys': INTERFACE('operations:\n  place:\n    syntax: POST /orders\n    examples:\n      - {}'),
  'include on an interfaces of custom view': 'views:\n  mine:\n    view: interfaces of api\n    include: [api]\n',
};

/** True when the YAML reader reports no error: the model-side verdict the JSON Schema must agree with. */
function modelAccepts(text) {
  return !core.load(text, { source: 'embed' }).diagnostics.some((found) => found.severity === 'error');
}

/** The document as an editor with a YAML language server reads it: the core schema types scalars (`1.10` is a number). */
const asEditorData = (text) => YAML.parse(text);

Object.entries(ACCEPTED).forEach(([name, text]) => {
  test(`both the model and the JSON Schema accept ${name}`, () => {
    assert.equal(modelAccepts(text), true, 'model');
    assert.equal(schemaAccepts(asEditorData(text)), true, 'JSON Schema');
  });
});

Object.entries(REJECTED).forEach(([name, text]) => {
  test(`both the model and the JSON Schema reject ${name}`, () => {
    assert.equal(modelAccepts(text), false, 'model');
    assert.equal(schemaAccepts(asEditorData(text)), false, 'JSON Schema');
  });
});

test('the JSON Schema accepts the interface fixtures the model accepts', () => {
  ['course-registration-interfaces.yml', 'interfaces-endpoint.yml', 'interfaces-events.yml', 'interfaces-shop.yml',
    'interfaces-l14-booking.yml', 'course-registration.yml'].forEach((name) => {
    assert.equal(schemaAccepts(asEditorData(fixture(name))), true, name);
  });
});

// ---- Performance (Milestone 1 Review Focus 5, extended) ----------------------------------------

/** 300 elements: 9 people, 1 system, 10 containers of 28 components; 100 interfaces of 3 operations each. */
function generatedInterfaceModel() {
  const lines = ['schema: c4-design/1', 'name: Large', 'people:'];
  for (let p = 0; p < 9; p++) lines.push(`  p${p}:`, `    name: Person ${p}`, `    description: Person ${p} uses the system.`);
  lines.push('systems:', '  big:', '    name: Big', '    description: A large system.', '    containers:');
  let interfaces = 0;
  for (let c = 0; c < 10; c++) {
    lines.push(`      c${c}:`, `        name: Container ${c}`, '        description: A container.', '        components:');
    for (let k = 0; k < 28; k++) {
      const id = `k${c}-${k}`;
      lines.push(`          ${id}:`, `            name: Component ${c}-${k}`, '            description: A component.');
      if (k < 10 && interfaces < 100) {
        interfaces++;
        lines.push('            provides:', `              i${c}-${k}:`, `                name: Interface ${c}-${k}`, '                style: rpc',
          '                operations:');
        for (let o = 0; o < 3; o++) lines.push(`                  op${o}: {syntax: "op${o}(x)", input: string, output: string, purpose: Does op${o}.}`);
      }
      if (k === 0 && c > 0) lines.push('            collaborators:', `              k${c - 1}-0: {description: calls, uses: i${c - 1}-0.op0}`);
    }
  }
  return lines.join('\n') + '\n';
}

test('a generated 300-element model with 100 interfaces and 300 operations loads, checks, and projects every listed view, interface views included, within 3 seconds', () => {
  const text = generatedInterfaceModel();
  const started = Date.now();
  const design = core.load(text, { source: 'file' });
  assert.equal(design.model.interfaces.size, 100);
  assert.equal(design.model.elements.size, 300 - 0, 'elements');
  core.check(design);
  const views = core.listViews(design, { interfaces: true });
  views.forEach((view) => core.project(design, view.selector));
  const elapsed = Date.now() - started;
  assert.ok(views.some((view) => view.type === 'interface'), 'interface views are listed');
  assert.ok(elapsed < TIME_BOUND_MS, `took ${elapsed} ms`);
});
