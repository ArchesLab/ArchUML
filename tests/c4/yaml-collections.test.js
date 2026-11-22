'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const { CANONICAL_ORDER, TOP_LEVEL_KEYS } = require('../../c4/c4-schema.js');
const { fixture } = require('./helpers.js');

/** `rows` as a text with a line break after each row. */
function lines(...rows) {
  return rows.map((row) => `${row}\n`).join('');
}

/** `text` after the edits that `primitive` returns for it. */
function spliced(text, primitive) {
  return y.applyEdits(text, primitive(y.parse(text)));
}

// ---- Inserting and replacing entries ---------------------------------------------------------

test('setEntry inserts a key in canonical order with sibling indentation', () => {
  const text = lines(
    'containers:',
    '  db:',
    '    name: Registration Database',
    '    kind: database',
    '    responsibilities:',
    '      - do: durably store plans, attempts, and seat holds',
  );
  const result = spliced(text, (p) => y.setEntry(p, ['containers', 'db'], 'technology', 'PostgreSQL 16', { order: CANONICAL_ORDER }));
  assert.equal(result, lines(
    'containers:',
    '  db:',
    '    name: Registration Database',
    '    kind: database',
    '    technology: PostgreSQL 16',
    '    responsibilities:',
    '      - do: durably store plans, attempts, and seat holds',
  ));
});

test('setEntry creates missing parent collections', () => {
  const text = lines('systems:', '  reg:', '    name: Course Registration', '    tags: [core]');
  const database = { name: 'Registration Database', kind: 'database' };
  assert.equal(spliced(text, (p) => y.setEntry(p, ['systems', 'reg', 'containers'], 'db', database, { order: CANONICAL_ORDER })), lines(
    'systems:',
    '  reg:',
    '    name: Course Registration',
    '    containers:',
    '      db:',
    '        name: Registration Database',
    '        kind: database',
    '    tags: [core]',
  ));
  // Two missing levels: `billing` is not in the order, so it goes after the last key of `systems`.
  const gateway = { name: 'Billing Gateway' };
  assert.equal(spliced(text, (p) => y.setEntry(p, ['systems', 'billing', 'containers'], 'gateway', gateway, { order: CANONICAL_ORDER })), lines(
    'systems:',
    '  reg:',
    '    name: Course Registration',
    '    tags: [core]',
    '  billing:',
    '    containers:',
    '      gateway:',
    '        name: Billing Gateway',
  ));
});

test('setEntry follows four-space indentation', () => {
  const text = lines(
    'systems:',
    '    reg:',
    '        name: Course Registration',
    '        containers:',
    '            web:',
    '                name: Planner Web App',
  );
  assert.equal(spliced(text, (p) => y.setEntry(p, ['systems', 'reg'], 'description', 'Builds schedules.', { order: CANONICAL_ORDER })), lines(
    'systems:',
    '    reg:',
    '        name: Course Registration',
    '        description: Builds schedules.',
    '        containers:',
    '            web:',
    '                name: Planner Web App',
  ));
  // The new key sits at its siblings' column; the list it starts has no siblings, so it is indented two more spaces.
  assert.equal(spliced(text, (p) => y.setEntry(p, ['systems', 'reg', 'containers', 'web'], 'tags', ['ui'], { order: CANONICAL_ORDER })), lines(
    'systems:',
    '    reg:',
    '        name: Course Registration',
    '        containers:',
    '            web:',
    '                name: Planner Web App',
    '                tags:',
    '                  - ui',
  ));
});

test('setEntry inserts a new key above the comment lines of the key that follows it', () => {
  const text = lines('web:', '  name: Planner Web App', '  # Shown in the browser.', '  technology: TypeScript, React');
  const description = 'Lets students compare draft schedules.';
  assert.equal(spliced(text, (p) => y.setEntry(p, ['web'], 'description', description, { order: CANONICAL_ORDER })), lines(
    'web:',
    '  name: Planner Web App',
    `  description: ${description}`,
    '  # Shown in the browser.',
    '  technology: TypeScript, React',
  ));
});

test('a top-level key inserted first goes below the leading comments of the file', () => {
  // The leading comment can be an embed's caption, which has to stay on the first line.
  const text = lines('# caption: The registration system', 'name: Course Registration');
  assert.equal(spliced(text, (p) => y.setEntry(p, [], 'schema', 'c4-design/1', { order: TOP_LEVEL_KEYS })),
    lines('# caption: The registration system', 'schema: c4-design/1', 'name: Course Registration'));
  // A comment set apart from the leading ones by a blank line describes the key below it.
  const described = lines('# caption: The registration system', '', '# The name shown in diagram titles.', 'name: Course Registration');
  assert.equal(spliced(described, (p) => y.setEntry(p, [], 'schema', 'c4-design/1', { order: TOP_LEVEL_KEYS })), lines(
    '# caption: The registration system',
    '',
    'schema: c4-design/1',
    '# The name shown in diagram titles.',
    'name: Course Registration',
  ));
});

test('setEntry fills an empty value and an empty document', () => {
  const text = lines('reg:', '  name: Course Registration', '  containers:   # none yet', '    # One per deployable unit.', '  tags: [core]');
  const filled = lines(
    'reg:',
    '  name: Course Registration',
    '  containers:   # none yet',
    '    # One per deployable unit.',
    '    db:',
    '      name: Registration Database',
    '  tags: [core]',
  );
  assert.equal(spliced(text, (p) => y.setEntry(p, ['reg', 'containers'], 'db', { name: 'Registration Database' })), filled);
  assert.equal(spliced(text, (p) => y.setEntry(p, ['reg'], 'containers', { db: { name: 'Registration Database' } })), filled);
  assert.equal(spliced('', (p) => y.setEntry(p, [], 'schema', 'c4-design/1')), 'schema: c4-design/1\n');
  assert.equal(spliced('# caption: Draft\n', (p) => y.setEntry(p, ['systems', 'reg'], 'name', 'Course Registration')),
    lines('# caption: Draft', 'systems:', '  reg:', '    name: Course Registration'));
  // A document holding only a `---` marker is empty too: the entry goes below the marker, inside a `...` that ends it.
  assert.equal(spliced('---\n', (p) => y.setEntry(p, [], 'schema', 'c4-design/1')), '---\nschema: c4-design/1\n');
  assert.equal(spliced('---\n...\n', (p) => y.setEntry(p, [], 'schema', 'c4-design/1')), '---\nschema: c4-design/1\n...\n');
  assert.equal(spliced('# caption: Draft\n...\n', (p) => y.setEntry(p, [], 'schema', 'c4-design/1')),
    '# caption: Draft\nschema: c4-design/1\n...\n');
});

test('setEntry replaces a value in place and keeps the comment on its line', () => {
  const text = lines(
    'coordinator:',
    '  technology: Python module   # pinned',
    '  collaborators:',
    '    policy: asks for an eligibility decision from',
    '    seats:',
    '      description: reserves all seats or none through',
    '      technology: SQL/TCP',
    '  tags: [core]',
  );
  const collaborators = ['coordinator', 'collaborators'];
  const call = { description: 'asks for an eligibility decision from', technology: 'in-process call' };
  assert.equal(spliced(text, (p) => y.setEntry(p, collaborators, 'policy', call)), lines(
    'coordinator:',
    '  technology: Python module   # pinned',
    '  collaborators:',
    '    policy:',
    '      description: asks for an eligibility decision from',
    '      technology: in-process call',
    '    seats:',
    '      description: reserves all seats or none through',
    '      technology: SQL/TCP',
    '  tags: [core]',
  ));
  assert.equal(spliced(text, (p) => y.setEntry(p, collaborators, 'seats', 'reserves all seats or none through')), lines(
    'coordinator:',
    '  technology: Python module   # pinned',
    '  collaborators:',
    '    policy: asks for an eligibility decision from',
    '    seats: reserves all seats or none through',
    '  tags: [core]',
  ));
  assert.equal(spliced(text, (p) => y.setEntry(p, ['coordinator'], 'technology', ['Python 3.12', 'FastAPI'])), lines(
    'coordinator:',
    '  technology:   # pinned',
    '    - Python 3.12',
    '    - FastAPI',
    '  collaborators:',
    '    policy: asks for an eligibility decision from',
    '    seats:',
    '      description: reserves all seats or none through',
    '      technology: SQL/TCP',
    '  tags: [core]',
  ));
  assert.equal(spliced('owns: # none yet\n', (p) => y.setEntry(p, [], 'owns', [])), 'owns: [] # none yet\n');
});

test('setEntry keeps the anchor of the value it writes over', () => {
  assert.equal(spliced('base: &base [a, b]\nalso: *base\n', (p) => y.setEntry(p, [], 'base', ['c'])), 'base: &base [c]\nalso: *base\n');
  assert.equal(spliced('base: &base\n  k: v\nalso: *base\n', (p) => y.setEntry(p, [], 'base', { k: 'w' })),
    'base: &base\n  k: w\nalso: *base\n');
});

test('setEntry keeps a flow collection in flow style', () => {
  const text = lines('coordinator:', '  stereotypes: [coordinator]   # one role', '  name: Registration Coordinator');
  assert.equal(spliced(text, (p) => y.setEntry(p, ['coordinator'], 'stereotypes', ['coordinator', 'controller'])),
    lines('coordinator:', '  stereotypes: [coordinator, controller]   # one role', '  name: Registration Coordinator'));
});

test('setEntry edits a flow map between its braces in order', () => {
  const text = 'billing: {description: requests tuition charges from, technology: AMQP}\n';
  assert.equal(spliced(text, (p) => y.setEntry(p, ['billing'], 'connector', 'message')),
    'billing: {description: requests tuition charges from, technology: AMQP, connector: message}\n');
  const order = ['description', 'connector', 'technology'];
  assert.equal(spliced(text, (p) => y.setEntry(p, ['billing'], 'connector', 'message', { order })),
    'billing: {description: requests tuition charges from, connector: message, technology: AMQP}\n');
  assert.equal(spliced(text, (p) => y.setEntry(p, ['billing', 'choices'], 'styles', ['event-driven'])),
    'billing: {description: requests tuition charges from, technology: AMQP, choices: {styles: [event-driven]}}\n');
});

test('setEntry writes numbers and booleans as text that reads back as their string form', () => {
  const result = spliced('pod:\n  name: API pod\n', (p) => y.setEntry(p, ['pod'], 'scaling', { instances: 3, external: true }));
  assert.deepEqual(y.toData(y.parse(result)), { pod: { name: 'API pod', scaling: { instances: '3', external: 'true' } } });
});

// ---- Sequences -------------------------------------------------------------------------------

test('appendItem extends block and flow sequences and creates missing ones', () => {
  const text = lines('seats:', '  name: Seat Gateway', '  tags: [gateway]', '  responsibilities:', '    - do: hold every requested seat');
  assert.equal(spliced(text, (p) => y.appendItem(p, ['seats', 'tags'], 'python')),
    lines('seats:', '  name: Seat Gateway', '  tags: [gateway, python]', '  responsibilities:', '    - do: hold every requested seat'));
  assert.equal(spliced(text, (p) => y.appendItem(p, ['seats', 'responsibilities'], { know: 'which seats are held' })), lines(
    'seats:',
    '  name: Seat Gateway',
    '  tags: [gateway]',
    '  responsibilities:',
    '    - do: hold every requested seat',
    '    - know: which seats are held',
  ));
  assert.equal(spliced(text, (p) => y.appendItem(p, ['seats', 'owns'], 'seat holds')), lines(
    'seats:',
    '  name: Seat Gateway',
    '  tags: [gateway]',
    '  responsibilities:',
    '    - do: hold every requested seat',
    '  owns:',
    '    - seat holds',
  ));
});

test('insertItem puts an item before the item at its index', () => {
  const text = lines('steps:', '  - web -> coordinator: submits the plan to', '  - coordinator -> policy: asks for a decision from');
  assert.equal(spliced(text, (p) => y.insertItem(p, ['steps'], 1, { 'coordinator -> seats': 'reserves seats through' })), lines(
    'steps:',
    '  - web -> coordinator: submits the plan to',
    '  - coordinator -> seats: reserves seats through',
    '  - coordinator -> policy: asks for a decision from',
  ));
  assert.equal(spliced('tags: [b, c]\n', (p) => y.insertItem(p, ['tags'], 0, 'a')), 'tags: [a, b, c]\n');
  assert.equal(spliced('tags: []\n', (p) => y.insertItem(p, ['tags'], 0, 'a')), 'tags: [a]\n');
});

test('deleteItem removes a flow item with its separator', () => {
  const text = 'tags: [a, b, c]\n';
  assert.equal(spliced(text, (p) => y.deleteItem(p, ['tags'], 0)), 'tags: [b, c]\n');
  assert.equal(spliced(text, (p) => y.deleteItem(p, ['tags'], 1)), 'tags: [a, c]\n');
  assert.equal(spliced(text, (p) => y.deleteItem(p, ['tags'], 2)), 'tags: [a, b]\n');
  assert.equal(spliced('tags: [a]\n', (p) => y.deleteItem(p, ['tags'], 0)), 'tags: []\n');
});

test('moveItem reorders block items with their own comments', () => {
  const text = lines(
    'responsibilities:',
    '  # The attempt runs in order.',
    '  - do: sequence one enrollment attempt   # main duty',
    '  # Chooses the next step.',
    '  - decide: which step of the attempt runs next',
    '    refines: api-holds',
    '  - know: which seats are held',
  );
  assert.equal(spliced(text, (p) => y.moveItem(p, ['responsibilities'], 1, 0)), lines(
    'responsibilities:',
    '  # Chooses the next step.',
    '  - decide: which step of the attempt runs next',
    '    refines: api-holds',
    '  # The attempt runs in order.',
    '  - do: sequence one enrollment attempt   # main duty',
    '  - know: which seats are held',
  ));
  assert.equal(spliced(text, (p) => y.moveItem(p, ['responsibilities'], 0, 2)), lines(
    'responsibilities:',
    '  # Chooses the next step.',
    '  - decide: which step of the attempt runs next',
    '    refines: api-holds',
    '  - know: which seats are held',
    '  # The attempt runs in order.',
    '  - do: sequence one enrollment attempt   # main duty',
  ));
});

test('moveItem reorders flow items', () => {
  assert.equal(spliced('tags: [a, b, c]\n', (p) => y.moveItem(p, ['tags'], 0, 2)), 'tags: [b, c, a]\n');
  assert.equal(spliced('tags: [a, b, c]\n', (p) => y.moveItem(p, ['tags'], 2, 0)), 'tags: [c, a, b]\n');
  assert.equal(spliced('tags: [a, b, c]\n', (p) => y.moveItem(p, ['tags'], 1, 1)), 'tags: [a, b, c]\n');
});

test('moveItem keeps the text of a block scalar that would take in the lines below its new place', () => {
  // Moved as raw text above the blank line, the `|+` scalar would keep that line too and read 'kept\n\n'. Written
  // from its data as a `|` scalar, it still reads 'kept\n'.
  assert.equal(spliced(lines('s:', '  - |+', '    kept', '  - c', '', 'z: 1'), (p) => y.moveItem(p, ['s'], 0, 1)),
    lines('s:', '  - c', '  - |', '    kept', '', 'z: 1'));
  // The comment lines above the item move with it.
  assert.equal(spliced('s:\r\n  # why\r\n  - |+\r\n    kept\r\n  - c\r\n\r\nz: 1\r\n', (p) => y.moveItem(p, ['s'], 0, 1)),
    's:\r\n  - c\r\n  # why\r\n  - |\r\n    kept\r\n\r\nz: 1\r\n');
  // A comment line led by a tab would become text of any block scalar right above it, so the text is double-quoted.
  assert.equal(spliced(lines('s:', '  - |', '    text', '  - b', '\t# note', '  - c'), (p) => y.moveItem(p, ['s'], 0, 1)),
    lines('s:', '  - b', '  - "text\\n"', '\t# note', '  - c'));
});

// ---- Deleting entries ------------------------------------------------------------------------

test('deleteEntry removes a nested block and its inline comment, keeping comments above', () => {
  const text = lines(
    'components:',
    '  # Runs one enrollment attempt at a time.',
    '  coordinator:   # the only writer of attempts',
    '    name: Registration Coordinator',
    '    collaborators:',
    '      policy: asks for an eligibility decision from',
    '',
    '      # Seats are written through the gateway.',
    '  policy:',
    '    name: Enrollment Policy   # a pure function',
  );
  assert.equal(spliced(text, (p) => y.deleteEntry(p, ['components'], 'coordinator')), lines(
    'components:',
    '  # Runs one enrollment attempt at a time.',
    '  policy:',
    '    name: Enrollment Policy   # a pure function',
  ));
});

test('emptying a block collection leaves an empty value, while a flow collection keeps its brackets', () => {
  assert.equal(spliced('a:\n  b: 1\nc: 2\n', (p) => y.deleteEntry(p, ['a'], 'b')), 'a:\nc: 2\n');
  assert.equal(spliced('owns:\n  - seat holds\n', (p) => y.deleteItem(p, ['owns'], 0)), 'owns:\n');
  assert.equal(spliced('m: {k: v}\n', (p) => y.deleteEntry(p, ['m'], 'k')), 'm: {}\n');
  assert.equal(spliced('only: 1\n', (p) => y.deleteEntry(p, [], 'only')), '');
});

test('entries of a map that starts on a sequence item line can be added, removed, and moved', () => {
  const text = lines('responsibilities:', '  - do: hold a seat in every section of a plan', '    refines: sys-holds');
  const first = ['responsibilities', 0];
  assert.equal(spliced(text, (p) => y.setEntry(p, first, 'id', 'api-holds')),
    lines('responsibilities:', '  - do: hold a seat in every section of a plan', '    refines: sys-holds', '    id: api-holds'));
  assert.equal(spliced(text, (p) => y.setEntry(p, first, 'id', 'api-holds', { order: ['id', 'do'] })),
    lines('responsibilities:', '  - id: api-holds', '    do: hold a seat in every section of a plan', '    refines: sys-holds'));
  assert.equal(spliced(text, (p) => y.deleteEntry(p, first, 'do')), lines('responsibilities:', '  - refines: sys-holds'));
  assert.equal(spliced(text, (p) => y.moveEntry(p, first, 'refines', first, { order: ['refines', 'do'] })),
    lines('responsibilities:', '  - refines: sys-holds', '    do: hold a seat in every section of a plan'));
  const withRetired = text + lines('retired:', '  note: kept for the audit');
  assert.equal(spliced(withRetired, (p) => y.moveEntry(p, first, 'do', ['retired'])), lines(
    'responsibilities:',
    '  - refines: sys-holds',
    'retired:',
    '  note: kept for the audit',
    '  do: hold a seat in every section of a plan',
  ));
  assert.equal(spliced('steps:\n  - web -> api: calls\n  - api -> db: reads\n', (p) => y.deleteEntry(p, ['steps', 0], 'web -> api')),
    'steps:\n  -\n  - api -> db: reads\n');
});

test('an anchor or tag before a key or a flow item stays with its entry', () => {
  assert.equal(spliced('&main name: Course Registration\nstatus: proposed\n', (p) => y.deleteEntry(p, [], 'name')), 'status: proposed\n');
  assert.equal(spliced('tags: [&first a, b]\n', (p) => y.deleteItem(p, ['tags'], 0)), 'tags: [b]\n');
  assert.equal(spliced('tags: [a, !!str b]\n', (p) => y.moveItem(p, ['tags'], 1, 0)), 'tags: [!!str b, a]\n');
});

// ---- Moving entries --------------------------------------------------------------------------

test('moveEntry re-indents an element block into another parent', () => {
  const text = lines(
    'containers:',
    '  api:',
    '    components:',
    '        seats:',
    '            name: Seat Gateway',
    '            # Seat state has one writer.',
    '            owns: [seat holds]',
    '        coordinator:',
    '            name: Registration Coordinator',
    '  worker:',
    '    name: Billing Worker',
    '    components:',
    '      jobs:',
    '        name: Job Runner',
  );
  const from = ['containers', 'api', 'components'];
  const to = ['containers', 'worker', 'components'];
  const edits = y.moveEntry(y.parse(text), from, 'seats', to, { order: CANONICAL_ORDER });
  assert.equal(y.applyEdits(text, edits), lines(
    'containers:',
    '  api:',
    '    components:',
    '        coordinator:',
    '            name: Registration Coordinator',
    '  worker:',
    '    name: Billing Worker',
    '    components:',
    '      jobs:',
    '        name: Job Runner',
    '      seats:',
    '          name: Seat Gateway',
    '          # Seat state has one writer.',
    '          owns: [seat holds]',
  ));
  // One edit at each end: the lines in between stay outside every edit, so an editor keeps its markers on them.
  const between = { start: text.indexOf('        coordinator:'), end: text.length };
  assert.deepEqual(edits.filter((edit) => edit.offset < between.end && edit.offset + edit.length > between.start), []);
});

test('moveEntry creates a missing destination map and carries the comment lines above the entry', () => {
  const text = lines(
    'containers:',
    '  api:',
    '    components:',
    '      # Holds seats for one attempt.',
    '      seats:',
    '        name: Seat Gateway',
    '      coordinator:',
    '        name: Registration Coordinator',
    '  worker:',
    '    name: Billing Worker',
    '    tags: [async]',
  );
  const from = ['containers', 'api', 'components'];
  const to = ['containers', 'worker', 'components'];
  assert.equal(spliced(text, (p) => y.moveEntry(p, from, 'seats', to, { order: CANONICAL_ORDER })), lines(
    'containers:',
    '  api:',
    '    components:',
    '      coordinator:',
    '        name: Registration Coordinator',
    '  worker:',
    '    name: Billing Worker',
    '    components:',
    '      # Holds seats for one attempt.',
    '      seats:',
    '        name: Seat Gateway',
    '    tags: [async]',
  ));
});

test('moveEntry fills an empty map right above the entry and indents the entry under it', () => {
  const text = lines('api:', '  components:', '  seats:', '    name: Seat Gateway', '  name: Registration API');
  assert.equal(spliced(text, (p) => y.moveEntry(p, ['api'], 'seats', ['api', 'components'])),
    lines('api:', '  components:', '    seats:', '      name: Seat Gateway', '  name: Registration API'));
});

test('a moved block scalar is written double-quoted when it would take in the line after it', () => {
  const text = lines('a:', '  description: |', '    Takes orders and', '    sends them on.', 'b:', '  name: Bar', '\t# a note led by a tab', 'c: x');
  assert.equal(spliced(text, (p) => y.moveEntry(p, ['a'], 'description', ['b'])),
    lines('a:', 'b:', '  name: Bar', '  description: "Takes orders and\\nsends them on.\\n"', '\t# a note led by a tab', 'c: x'));
});

test('moveEntry reorders a key within its own map', () => {
  const text = lines('db:', '  technology: PostgreSQL 16', '  name: Registration Database', '  kind: database');
  assert.equal(spliced(text, (p) => y.moveEntry(p, ['db'], 'technology', ['db'], { order: CANONICAL_ORDER })),
    lines('db:', '  name: Registration Database', '  kind: database', '  technology: PostgreSQL 16'));
});

test('moveEntry within its own map keeps the text of a block scalar that would take in the lines below its new place', () => {
  assert.equal(spliced(lines('m:', '  d: |+', '    kept', '  c: x', '', 'z: 1'), (p) => y.moveEntry(p, ['m'], 'd', ['m'], { order: ['c', 'd'] })),
    lines('m:', '  c: x', '  d: |', '    kept', '', 'z: 1'));
  assert.equal(spliced(lines('m:', '  a: |', '    text', '  b: x', '\t# note', '  c: y'), (p) => y.moveEntry(p, ['m'], 'a', ['m'], { order: ['b', 'a', 'c'] })),
    lines('m:', '  b: x', '  a: "text\\n"', '\t# note', '  c: y'));
  // The first key of a map in a sequence item shares the item's line and has no comment lines of its own to carry.
  assert.equal(spliced(lines('s:', '  - a: |+', '      kept', '    b: x', '', '  - z'), (p) => y.moveEntry(p, ['s', 0], 'a', ['s', 0], { order: ['b', 'a'] })),
    lines('s:', '  - b: x', '    a: |', '      kept', '', '  - z'));
});

test('a moved block scalar beside an empty value keeps its raw text', () => {
  assert.equal(spliced(lines('s:', '  - text: |', '      line', '    owner:', '  - b'), (p) => y.moveItem(p, ['s'], 0, 1)),
    lines('s:', '  - b', '  - text: |', '      line', '    owner:'));
  assert.equal(spliced(lines('m:', '  t:', '    x: |', '      text', '    e:', '  b: y'), (p) => y.moveEntry(p, ['m'], 't', ['m'], { order: ['b', 't'] })),
    lines('m:', '  b: y', '  t:', '    x: |', '      text', '    e:'));
  assert.equal(spliced(lines('a:', '  t:', '    x: |', '      text', '    e:', 'm:', '  b: y'), (p) => y.moveEntry(p, ['a'], 't', ['m'])),
    lines('a:', 'm:', '  b: y', '  t:', '    x: |', '      text', '    e:'));
});

test('a move that writes an entry from its data refuses an empty value, which it cannot write', () => {
  const kept = y.parse(lines('s:', '  - owner:', '    text: |+', '      kept', '  - c', '', 'z: 1'));
  assert.throws(() => y.moveItem(kept, ['s'], 0, 1), { name: 'TypeError', message: /not null at \["s",0,"owner"\]/ });
  const flow = y.parse(lines('a:', '  k:', 'm: {b: x}'));
  assert.throws(() => y.moveEntry(flow, ['a'], 'k', ['m']), { name: 'TypeError', message: /not null at \["a","k"\]/ });
});

test('moveEntry into a new map in the entry\'s own map leaves no stray separator or line', () => {
  const link = 'link: {description: calls, technology: HTTPS}\n';
  assert.equal(spliced('link: {technology: HTTPS}\n', (p) => y.moveEntry(p, ['link'], 'technology', ['link', 'choices'])),
    'link: {choices: {technology: HTTPS}}\n');
  // The new map is placed among the keys that remain, so `order` cannot put it before the key that moves into it.
  const order = ['description', 'choices', 'technology'];
  assert.equal(spliced(link, (p) => y.moveEntry(p, ['link'], 'technology', ['link', 'choices'], { order })),
    'link: {description: calls, choices: {technology: HTTPS}}\n');
  assert.equal(spliced('steps:\n  - do: hold seats\n', (p) => y.moveEntry(p, ['steps', 0], 'do', ['steps', 0, 'x'], { order: ['x', 'do'] })),
    'steps:\n  -\n    x:\n      do: hold seats\n');
});

test('moveEntry into or out of a flow map writes the entry in the destination style', () => {
  const text = lines('a:', '  link: {description: calls, technology: HTTPS}', 'b:', '  connector: message');
  assert.equal(spliced(text, (p) => y.moveEntry(p, ['a', 'link'], 'technology', ['b'])),
    lines('a:', '  link: {description: calls}', 'b:', '  connector: message', '  technology: HTTPS'));
  assert.equal(spliced(text, (p) => y.moveEntry(p, ['b'], 'connector', ['a', 'link'])),
    lines('a:', '  link: {description: calls, technology: HTTPS, connector: message}', 'b:'));
});

// ---- Line breaks, text, and errors -----------------------------------------------------------

test('collection splices keep CRLF line endings', () => {
  const text = 'a:\r\n  b: 1\r\n  s:\r\n    - x\r\n    - y\r\nc: 2\r\n';
  assert.equal(spliced(text, (p) => y.setEntry(p, ['a'], 'n', { k: 'v' })),
    'a:\r\n  b: 1\r\n  s:\r\n    - x\r\n    - y\r\n  n:\r\n    k: v\r\nc: 2\r\n');
  assert.equal(spliced(text, (p) => y.appendItem(p, ['a', 's'], 'z')),
    'a:\r\n  b: 1\r\n  s:\r\n    - x\r\n    - y\r\n    - z\r\nc: 2\r\n');
  assert.equal(spliced(text, (p) => y.deleteEntry(p, ['a'], 'b')), 'a:\r\n  s:\r\n    - x\r\n    - y\r\nc: 2\r\n');
  assert.equal(spliced(text, (p) => y.moveItem(p, ['a', 's'], 1, 0)), 'a:\r\n  b: 1\r\n  s:\r\n    - y\r\n    - x\r\nc: 2\r\n');
  assert.equal(spliced(text, (p) => y.moveEntry(p, ['a'], 's', ['d'])), 'a:\r\n  b: 1\r\nc: 2\r\nd:\r\n  s:\r\n    - x\r\n    - y\r\n');
  // Moved out of its place, the only entry leaves no line break behind to copy.
  assert.equal(spliced('a:\r\n  b: 1\r\n', (p) => y.moveEntry(p, [], 'a', ['d'])), 'd:\r\n  a:\r\n    b: 1\r\n');
  assert.equal(spliced(text, (p) => y.setEntry(p, ['a'], 'b', 'line 1\nline 2')), 'a:\r\n  b: |-\r\n    line 1\r\n    line 2\r\n  s:\r\n    - x\r\n    - y\r\nc: 2\r\n');
});

test('a file without a final line break keeps none after splices at its end', () => {
  assert.equal(spliced('a: x', (p) => y.setEntry(p, [], 'b', 'y')), 'a: x\nb: y');
  assert.equal(spliced('a: x\nb: y', (p) => y.deleteEntry(p, [], 'b')), 'a: x');
  assert.equal(spliced('s:\n  - x', (p) => y.appendItem(p, ['s'], 'y')), 's:\n  - x\n  - y');
  // Moved into the map that ends right above it, the last entry's lines stay the last lines.
  assert.equal(spliced('a:\n  b: 1\nc: 2', (p) => y.moveEntry(p, [], 'c', ['a'])), 'a:\n  b: 1\n  c: 2');
  assert.equal(spliced('a:\r\n  b: 1\r\nc: 2', (p) => y.moveEntry(p, [], 'c', ['a'])), 'a:\r\n  b: 1\r\n  c: 2');
  assert.equal(spliced('a:\nb: 1', (p) => y.moveEntry(p, [], 'b', ['a'])), 'a:\n  b: 1');
});

test('removing the last lines of a file without a final line break keeps the blank line above them', () => {
  // The blank lines below a `|+` block scalar are part of its text.
  assert.equal(spliced('note: |+\n  kept\n\nstatus: draft', (p) => y.deleteEntry(p, [], 'status')), 'note: |+\n  kept\n\n');
});

test('inserted multi-line text is a block scalar unless a block scalar would take in the line after it', () => {
  const text = lines('a:', '  b: x', 'c: y');
  assert.equal(spliced(text, (p) => y.setEntry(p, ['a'], 'd', 'line 1\nline 2')),
    lines('a:', '  b: x', '  d: |-', '    line 1', '    line 2', 'c: y'));
  // A comment line led by a tab would become part of a block scalar written above it.
  const tabbed = lines('a:', '  b: x', '\t# note', 'c: y');
  assert.equal(spliced(tabbed, (p) => y.setEntry(p, ['a'], 'd', 'line 1\nline 2')),
    lines('a:', '  b: x', '  d: "line 1\\nline 2"', '\t# note', 'c: y'));
  assert.equal(spliced(tabbed, (p) => y.appendItem(p, ['a', 'e'], { text: 'line 1\nline 2' })),
    lines('a:', '  b: x', '  e:', '    - text: "line 1\\nline 2"', '\t# note', 'c: y'));
});

test('non-ASCII keys and text are spliced at the right offsets', () => {
  const text = lines('café:', '  name: 学生 Café 😀', '  tags: [café]');
  assert.equal(spliced(text, (p) => y.setEntry(p, ['café'], 'description', 'Für 学生', { order: CANONICAL_ORDER })),
    lines('café:', '  name: 学生 Café 😀', '  description: Für 学生', '  tags: [café]'));
  assert.equal(spliced(text, (p) => y.appendItem(p, ['café', 'tags'], '学生')), lines('café:', '  name: 学生 Café 😀', '  tags: [café, 学生]'));
  assert.equal(spliced(text, (p) => y.deleteEntry(p, ['café'], 'name')), lines('café:', '  tags: [café]'));
});

test('a move written as one edit never starts or ends inside a surrogate pair', () => {
  // Editors keep positions out of surrogate pairs, so they would shift such an edit. 😀 (U+1F600) shares its first
  // UTF-16 code unit with 😁 and its second with 𐘀 (U+10600).
  const cases = [
    ['m: {😀: smile}\n', (p) => y.moveEntry(p, ['m'], '😀', ['m', '😁']), 'm: {😁: {😀: smile}}\n'],
    ['s:\n  - k: a😀\n    id: a𐘀\n', (p) => y.moveEntry(p, ['s', 0], 'k', ['s', 0, 'x'], { order: ['x', 'k'] }),
      's:\n  - id: a𐘀\n    x:\n      k: a😀\n'],
  ];
  for (const [text, move, expected] of cases) {
    const edits = move(y.parse(text));
    assert.equal(y.applyEdits(text, edits), expected);
    const splitsPair = (offset) => /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(offset));
    assert.deepEqual(edits.filter((edit) => splitsPair(edit.offset) || splitsPair(edit.offset + edit.length)), [], text);
  }
});

test('differingSpan is the one splice between two texts, widened so it never splits a surrogate pair', () => {
  // 😀 is 😀, 😁 is 😁 (same first unit), 𐘀 is 𐘀 (same second unit).
  assert.deepEqual(y.differingSpan('a: x\n', 'a: yz\n'), { offset: 3, length: 1, text: 'yz' });
  assert.deepEqual(y.differingSpan('k: 😀!\n', 'k: 😁!\n'), { offset: 3, length: 2, text: '😁' });
  assert.deepEqual(y.differingSpan('k: 😀!\n', 'k: 𐘀!\n'), { offset: 3, length: 2, text: '𐘀' });
  assert.deepEqual(y.differingSpan('k: 😀\n', 'k: 😀😀\n'), { offset: 5, length: 0, text: '😀' });
});

test('collection splices reject paths, keys, and indexes that name nothing', () => {
  const p = y.parse(lines('m:', '  k: v', 's: [x]', 'n:', '  k: w'));
  assert.throws(() => y.deleteEntry(p, ['m'], 'missing'), { name: 'RangeError', message: /No key "missing" in the map at \["m"\]/ });
  assert.throws(() => y.deleteEntry(p, ['missing'], 'k'), { name: 'RangeError', message: /No map at \["missing"\]/ });
  assert.throws(() => y.deleteItem(p, ['missing'], 0), { name: 'RangeError', message: /No sequence at \["missing"\]/ });
  assert.throws(() => y.deleteItem(p, ['s'], 1), { name: 'RangeError', message: /Index 1 is outside the sequence at \["s"\]/ });
  assert.throws(() => y.insertItem(p, ['s'], 2, 'y'), { name: 'RangeError', message: /Index 2 is outside the sequence at \["s"\]/ });
  assert.throws(() => y.insertItem(p, ['new'], 1, 'y'), { name: 'RangeError', message: /Index 1 is outside the sequence at \["new"\]/ });
  assert.throws(() => y.moveItem(p, ['s'], 0, 1), { name: 'RangeError', message: /Index 1 is outside the sequence at \["s"\]/ });
  assert.throws(() => y.setEntry(p, ['s', 3], 'k', 'v'), { name: 'RangeError', message: /No item at \["s",3\]/ });
  assert.throws(() => y.moveEntry(p, ['m'], 'missing', ['n']), { name: 'RangeError', message: /No key "missing" in the map at \["m"\]/ });
});

test('collection splices reject collections of the wrong kind and values YAML cannot hold', () => {
  const p = y.parse(lines('m:', '  k: v', 's: [x]', 'text: plain'));
  assert.throws(() => y.setEntry(p, ['s'], 'k', 'v'), { name: 'TypeError', message: /\["s"\] holds no map/ });
  assert.throws(() => y.setEntry(p, ['text', 'deeper'], 'k', 'v'), { name: 'TypeError', message: /\["text"\] holds no map/ });
  assert.throws(() => y.appendItem(p, ['m'], 'x'), { name: 'TypeError', message: /\["m"\] holds no sequence/ });
  assert.throws(() => y.deleteEntry(p, ['s'], 'x'), { name: 'TypeError', message: /\["s"\] holds no map/ });
  assert.throws(() => y.moveItem(p, ['m'], 0, 0), { name: 'TypeError', message: /\["m"\] holds no sequence/ });
  for (const value of [null, undefined, { k: null }, ['x', undefined], new Date(0), Number.NaN]) {
    assert.throws(() => y.setEntry(p, ['m'], 'j', value), { name: 'TypeError', message: /write strings, numbers, booleans/ }, String(value));
  }
});

test('moveEntry refuses to move an entry into itself or onto an existing key', () => {
  const p = y.parse(lines('m:', '  k:', '    x: 1', 'n:', '  k: w'));
  assert.throws(() => y.moveEntry(p, ['m'], 'k', ['m', 'k', 'inner']), { name: 'RangeError', message: /Cannot move \["m","k"\] into itself/ });
  assert.throws(() => y.moveEntry(p, ['m'], 'k', ['n']), { name: 'RangeError', message: /The map at \["n"\] already has the key "k"/ });
});

// ---- Properties over whole files -------------------------------------------------------------

// A hand-written design in four-space indentation, with comments above, beside, inside, and below entries, blank
// lines, a block scalar, flow collections, and non-ASCII text.
const FOUR_SPACE_TEXT = lines(
  '# caption: Café ordering, indented by four spaces',
  'schema: c4-design/1',
  'name: Café Ordering',
  '',
  'people:',
  '    # Orders at the counter or in the app.',
  '    customer:',
  '        name: 学生 Customer    # a person, not a system',
  '        collaborators:',
  '            app: orders drinks using',
  '',
  'systems:',
  '    ordering:',
  '        name: Ordering',
  '        description: |',
  '            Takes orders and',
  '            sends them to the bar.',
  '        responsibilities:',
  '            -   do: take an order',
  '                id: ordering-do-1',
  '            # Payments are out of scope.',
  '            -   know: which orders are open',
  '        containers:',
  '            app:',
  '                name: Order App',
  '                kind: mobile_app',
  '                tags: [mobile, ui]',
  '                # Talks to the API only.',
  '                collaborators:',
  '                    api: {description: sends orders to, technology: HTTPS}',
  '',
  '            api:',
  '                name: Order API',
  '                technology: Go',
  '                    # Pinned by decision one-api.',
  '        tags: [core]',
);
const COURSE_REGISTRATION = fixture('course-registration.yml');
const FILES = [
  ['course-registration.yml', COURSE_REGISTRATION],
  ['the four-space file', FOUR_SPACE_TEXT],
  ['course-registration.yml with CRLF line breaks', COURSE_REGISTRATION.replace(/\n/g, '\r\n')],
];
const NESTED_VALUE = { list: ['a', 'line 1\nline 2'] };

/** Every map and sequence in `data`, parents before children, as `{ path, value }`. */
function collectionsIn(data, path = []) {
  if (data === null || typeof data !== 'object') return [];
  const children = Object.entries(data).flatMap(([key, child]) =>
    collectionsIn(child, [...path, Array.isArray(data) ? Number(key) : key]));
  return [{ path, value: data }, ...children];
}

/** Whether the collection at `path` is written in flow style (`[…]` or `{…}`). */
function isFlow(parsed, path) {
  return '[{'.includes(parsed.text.charAt(y.rangeOf(parsed, path).offset));
}

/** A copy of `map` with `value` at `key`: in place if the key exists, else before the first key later in `order`. */
function withKey(map, key, value, order = []) {
  const entries = Object.entries(map);
  const existing = entries.findIndex(([k]) => k === key);
  if (existing >= 0) {
    entries[existing] = [key, value];
    return Object.fromEntries(entries);
  }
  const rank = order.indexOf(key);
  const later = rank < 0 ? -1 : entries.findIndex(([k]) => order.indexOf(k) > rank);
  entries.splice(later < 0 ? entries.length : later, 0, [key, value]);
  return Object.fromEntries(entries);
}

/**
 * A copy of `data` with the collection at `path` replaced by `update(collection)`. Maps missing on the way, and an
 * empty value, are created; the first missing key goes into its map by `order`.
 */
function updatedAt(data, path, update, order = []) {
  if (path.length === 0) return update(data);
  const [segment, ...rest] = path;
  const container = data === null ? {} : data;
  const child = updatedAt(segment in container ? container[segment] : null, rest, update, order);
  if (Array.isArray(container)) return container.map((item, index) => (index === segment ? child : item));
  return withKey(container, segment, child, order);
}

/** What a collection reads as once its last entry is removed: block style cannot write an empty collection. */
function emptiedTo(collection, flow) {
  const empty = Array.isArray(collection) ? collection.length === 0 : Object.keys(collection).length === 0;
  return empty && !flow ? null : collection;
}

function withoutKey(map, key) {
  return Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
}

function inserted(list, index, value) {
  return [...(list || []).slice(0, index), value, ...(list || []).slice(index)];
}

function moved(list, from, to) {
  const rest = list.filter((_, index) => index !== from);
  return inserted(rest, to, list[from]);
}

/** The path of the closest map that holds the collection at `path`; null for the document itself. */
function enclosingMapPath(data, path) {
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const ancestor = path.slice(0, depth);
    if (!Array.isArray(ancestor.reduce((node, segment) => node[segment], data))) return ancestor;
  }
  return null;
}

/**
 * The span of the lines holding the entry that starts at `start` and everything indented under it: up to the text of
 * the next line with text other than a comment that is indented no deeper than the entry. (Removing the first key of
 * a map in a sequence item moves that text up onto the item's line.)
 */
function linesOfEntry(text, start) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const column = start - lineStart;
  let end = text.indexOf('\n', start) + 1 || text.length;
  while (end < text.length) {
    const lineEnd = text.indexOf('\n', end) + 1 || text.length;
    const line = text.slice(end, lineEnd).replace(/\r?\n$/, '');
    const body = line.replace(/^[ \t]*/, '');
    if (body !== '' && !body.startsWith('#') && line.length - body.length <= column) return { start: lineStart, end: end + line.length - body.length };
    end = lineEnd;
  }
  return { start: lineStart, end };
}

/** The lines of the map key or sequence item at `path`; the whole text for the document itself. */
function regionOf(parsed, path) {
  if (path.length === 0) return { start: 0, end: parsed.text.length };
  if (typeof path[path.length - 1] === 'string') return linesOfEntry(parsed.text, y.rangeOf(parsed, path, 'key').offset);
  const valueStart = y.rangeOf(parsed, path).offset;
  const dash = parsed.text.slice(0, valueStart).search(/-[ \t\r\n]*$/);
  return linesOfEntry(parsed.text, dash < 0 ? valueStart : dash);
}

/**
 * The deterministic list of splices the properties run on `parsed`: every primitive on every map, key, sequence, and
 * item. Each has the data the result must read as, the lines it may touch, and whether it only inserts or deletes.
 */
function splicesOn(parsed) {
  const data = y.toData(parsed);
  const splices = [];
  const add = (label, edits, expected, region, shape = null) => splices.push({ label, edits, expected, region, shape });
  for (const { path, value } of collectionsIn(data)) {
    const flow = isFlow(parsed, path);
    const region = regionOf(parsed, path);
    const at = JSON.stringify(path);
    if (Array.isArray(value)) {
      add(`appendItem ${at}`, () => y.appendItem(parsed, path, 'added'),
        updatedAt(data, path, (list) => inserted(list, list.length, 'added')), region, 'insertion');
      add(`insertItem ${at} 0`, () => y.insertItem(parsed, path, 0, { k: 'v' }),
        updatedAt(data, path, (list) => inserted(list, 0, { k: 'v' })), region, 'insertion');
      value.forEach((_, index) => add(`deleteItem ${at} ${index}`, () => y.deleteItem(parsed, path, index),
        updatedAt(data, path, (list) => emptiedTo(list.filter((__, i) => i !== index), flow)),
        regionOf(parsed, [...path, index]), 'deletion'));
      if (value.length >= 2) {
        const last = value.length - 1;
        add(`moveItem ${at} 0 ${last}`, () => y.moveItem(parsed, path, 0, last), updatedAt(data, path, (list) => moved(list, 0, last)), region);
        add(`moveItem ${at} ${last} 0`, () => y.moveItem(parsed, path, last, 0), updatedAt(data, path, (list) => moved(list, last, 0)), region);
      }
      continue;
    }
    add(`setEntry ${at} new key`, () => y.setEntry(parsed, path, 'x-new', 'added'),
      updatedAt(data, path, (map) => withKey(map, 'x-new', 'added')), region, 'insertion');
    add(`setEntry ${at} new collection`, () => y.setEntry(parsed, path, 'x-new', NESTED_VALUE),
      updatedAt(data, path, (map) => withKey(map, 'x-new', NESTED_VALUE)), region, 'insertion');
    add(`setEntry ${at} new map`, () => y.setEntry(parsed, [...path, 'x-map'], 'k', 'v'),
      updatedAt(data, [...path, 'x-map'], (map) => withKey(map || {}, 'k', 'v')), region, 'insertion');
    add(`appendItem ${at} new list`, () => y.appendItem(parsed, [...path, 'x-list'], 'added'),
      updatedAt(data, [...path, 'x-list'], (list) => inserted(list, 0, 'added')), region, 'insertion');
    if (!('technology' in value)) {
      add(`setEntry ${at} canonical key`, () => y.setEntry(parsed, path, 'technology', 'added', { order: CANONICAL_ORDER }),
        updatedAt(data, path, (map) => withKey(map, 'technology', 'added', CANONICAL_ORDER)), region, 'insertion');
    }
    const enclosingMap = enclosingMapPath(data, path);
    for (const key of Object.keys(value)) {
      const entryRegion = regionOf(parsed, [...path, key]);
      add(`setEntry ${at} ${key} to a list`, () => y.setEntry(parsed, path, key, ['replaced']),
        updatedAt(data, path, (map) => withKey(map, key, ['replaced'])), entryRegion);
      add(`setEntry ${at} ${key} to text`, () => y.setEntry(parsed, path, key, 'replaced'),
        updatedAt(data, path, (map) => withKey(map, key, 'replaced')), entryRegion);
      add(`deleteEntry ${at} ${key}`, () => y.deleteEntry(parsed, path, key),
        updatedAt(data, path, (map) => emptiedTo(withoutKey(map, key), flow)), entryRegion, 'deletion');
      if (enclosingMap) {
        // Into a new map beside the one holding this map, or beside the sequence that holds it.
        const destination = [...enclosingMap, 'x-moved'];
        const removed = updatedAt(data, path, (map) => emptiedTo(withoutKey(map, key), flow));
        add(`moveEntry ${at} ${key}`, () => y.moveEntry(parsed, path, key, destination),
          updatedAt(removed, destination, (map) => withKey(map || {}, key, value[key])), regionOf(parsed, enclosingMap));
      }
    }
  }
  return splices;
}

test('bytes outside edit ranges are unchanged', () => {
  for (const [name, text] of FILES) {
    const parsed = y.parse(text);
    for (const { label, edits, expected, region, shape } of splicesOn(parsed)) {
      const where = `${label} in ${name}`;
      const returned = edits();
      const result = y.applyEdits(text, returned);
      assert.equal(result.slice(0, region.start), text.slice(0, region.start), `text before the lines of ${where}`);
      assert.equal(result.slice(result.length - (text.length - region.end)), text.slice(region.end), `text after the lines of ${where}`);
      if (shape === 'insertion') assert.ok(returned.every((edit) => edit.length === 0), `${where} only inserts`);
      if (shape === 'deletion') assert.ok(returned.every((edit) => edit.text === ''), `${where} only deletes`);
      const reparsed = y.parse(result);
      assert.deepEqual(reparsed.errors, [], where);
      assert.deepEqual(y.toData(reparsed), expected, where);
      if (text.includes('\r\n')) assert.doesNotMatch(result, /(^|[^\r])\n/, `${where} writes CRLF line breaks`);
    }
  }
});

test('insert then delete restores the original text: setEntry and deleteEntry', () => {
  for (const [name, text] of FILES) {
    const parsed = y.parse(text);
    const maps = collectionsIn(y.toData(parsed)).filter(({ value }) => !Array.isArray(value));
    for (const { path, value } of maps) {
      // An empty order appends the key; ['x-new', key] puts it right before `key`.
      for (const order of [[], ...Object.keys(value).map((key) => ['x-new', key])]) {
        for (const entry of ['added', NESTED_VALUE]) {
          const withEntry = y.applyEdits(text, y.setEntry(parsed, path, 'x-new', entry, { order }));
          const restored = y.applyEdits(withEntry, y.deleteEntry(y.parse(withEntry), path, 'x-new'));
          assert.equal(restored, text, `x-new = ${JSON.stringify(entry)} at ${JSON.stringify(path)} by ${JSON.stringify(order)} in ${name}`);
        }
      }
    }
  }
});

test('insert then delete restores the original text: appendItem, insertItem, and deleteItem', () => {
  for (const [name, text] of FILES) {
    const parsed = y.parse(text);
    const sequences = collectionsIn(y.toData(parsed)).filter(({ value }) => Array.isArray(value));
    for (const { path, value } of sequences) {
      for (let index = 0; index <= value.length; index++) {
        for (const item of ['added', NESTED_VALUE]) {
          const edits = index === value.length ? y.appendItem(parsed, path, item) : y.insertItem(parsed, path, index, item);
          const withItem = y.applyEdits(text, edits);
          const restored = y.applyEdits(withItem, y.deleteItem(y.parse(withItem), path, index));
          assert.equal(restored, text, `${JSON.stringify(item)} at ${index} of ${JSON.stringify(path)} in ${name}`);
        }
      }
    }
  }
});
