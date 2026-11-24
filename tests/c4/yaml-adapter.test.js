'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');

/** The data at `path` in `data`, following object keys and array indexes. */
function dataAt(data, path) {
  return path.reduce((node, segment) => node[segment], data);
}

/** A copy of `data` with the entry at `path` replaced by `value`. */
function withDataAt(data, path, value) {
  const copy = structuredClone(data);
  dataAt(copy, path.slice(0, -1))[path.at(-1)] = value;
  return copy;
}

/** The text before the value at `path`, and the text after the line on which that value ends. */
function textAroundValue(parsed, path) {
  const { offset, endOffset } = y.rangeOf(parsed, path);
  const lineBreak = parsed.text.indexOf('\n', endOffset - 1);
  return { before: parsed.text.slice(0, offset), after: lineBreak < 0 ? '' : parsed.text.slice(lineBreak + 1) };
}

/** A copy of `data` with the key `oldKey` of the object at `mapPath` renamed to `newKey`, keeping key order. */
function withKeyRenamed(data, mapPath, oldKey, newKey) {
  const copy = structuredClone(data);
  const map = dataAt(copy, mapPath);
  for (const [key, value] of Object.entries(map)) {
    delete map[key];
    map[key === oldKey ? newKey : key] = value;
  }
  return copy;
}

test('failsafe parsing keeps scalar text exactly', () => {
  assert.deepEqual(y.toData(y.parse('v: 1.10\nw: no\nx: on\n')), { v: '1.10', w: 'no', x: 'on' });
});

test('syntax errors carry a code and a 1-based position', () => {
  const p = y.parse('a:\n  - x\n - y\n');
  assert.ok(p.errors.length > 0);
  assert.equal(p.errors[0].range.start.line, 3);
});

test('duplicate keys are reported', () => {
  assert.equal(y.parse('a: 1\na: 2\n').errors[0].code, 'DUPLICATE_KEY');
});

test('rangeOf finds nested values, keys, and sequence items', () => {
  const p = y.parse('s:\n  api:\n    name: API\n    tags: [a, b]\n');
  assert.deepEqual(y.rangeOf(p, ['s', 'api', 'name']).start, { line: 3, col: 11 });
  assert.deepEqual(y.rangeOf(p, ['s', 'api', 'name'], 'key').start, { line: 3, col: 5 });
  // `b` in "    tags: [a, b]" is the 15th character: [ = 11, a = 12, comma = 13, space = 14.
  assert.deepEqual(y.rangeOf(p, ['s', 'api', 'tags', 1]).start, { line: 4, col: 15 });
});

test('replaceValue changes only the scalar and keeps aligned comments', () => {
  const p = y.parse('a: old   # keep\nb: x\n');
  assert.equal(y.applyEdits(p.text, y.replaceValue(p, ['a'], 'new')), 'a: new   # keep\nb: x\n');
});

test('replaceValue quotes text that needs quoting', () => {
  const p = y.parse('a: old\n');
  assert.equal(y.applyEdits(p.text, y.replaceValue(p, ['a'], 'x: y')), 'a: "x: y"\n');
});

test('replaceValue edits inside a flow map', () => {
  const p = y.parse('m: {k: v, z: w}\n');
  assert.equal(y.applyEdits(p.text, y.replaceValue(p, ['m', 'k'], 'q')), 'm: {k: q, z: w}\n');
});

test('renameKey changes only the key', () => {
  const p = y.parse('old: 1 # c\n');
  assert.equal(y.applyEdits(p.text, y.renameKey(p, [], 'old', 'neu')), 'neu: 1 # c\n');
});

test('applyEdits rejects overlapping edits', () => {
  assert.throws(() => y.applyEdits('abc', [{ offset: 0, length: 2, text: 'x' }, { offset: 1, length: 1, text: 'y' }]), RangeError);
});

test('scalar splices keep CRLF line endings', () => {
  const p = y.parse('a: x\r\nb: y\r\n');
  assert.equal(y.applyEdits(p.text, y.replaceValue(p, ['b'], 'z')), 'a: x\r\nb: z\r\n');
});

test('ranges count UTF-16 code units so non-ASCII text round-trips', () => {
  const p = y.parse('n: Café 学生\nm: x\n');
  assert.equal(y.applyEdits(p.text, y.replaceValue(p, ['m'], 'y')), 'n: Café 学生\nm: y\n');
});

test('ranges in a CRLF document end before the carriage return', () => {
  assert.deepEqual(y.rangeOf(y.parse('a: x\r\nb: y\r\n'), ['b']),
    { start: { line: 2, col: 4 }, end: { line: 2, col: 5 }, offset: 9, endOffset: 10 });
});

test('columns count UTF-16 code units, so positions after non-ASCII text on the same line stay exact', () => {
  // The emoji is two UTF-16 code units, so x is at column 20.
  const p = y.parse('k: {n: Café 😀, m: x}\n');
  assert.deepEqual(y.rangeOf(p, ['k', 'm']).start, { line: 1, col: 20 });
  assert.equal(y.applyEdits(p.text, y.replaceValue(p, ['k', 'm'], 'y')), 'k: {n: Café 😀, m: y}\n');
});

test('issues carry the parser code, a message without a source excerpt, the offset, and the span', () => {
  assert.deepEqual(y.parse('a: 1\na: 2\n').errors, [{
    code: 'DUPLICATE_KEY',
    message: 'Map keys must be unique',
    offset: 5,
    range: { start: { line: 2, col: 1 }, end: { line: 2, col: 2 } },
  }]);
});

test('errors are listed in document order', () => {
  assert.deepEqual(y.parse('a: *x\nb: 1\nb: 2\n').errors.map((issue) => issue.code), ['BAD_ALIAS', 'DUPLICATE_KEY']);
});

test('toData maps collections to objects and arrays and empty values to null', () => {
  const data = y.toData(y.parse('a:\nb: ""\nc:\n  -\n  - y\nd: {k: , z: w}\n'));
  assert.deepEqual(data, { a: null, b: '', c: [null, 'y'], d: { k: null, z: 'w' } });
});

test('an empty or comment-only document has no data', () => {
  assert.equal(y.toData(y.parse('')), null);
  assert.equal(y.toData(y.parse('# only a comment\n')), null);
});

test('a __proto__ key becomes an own property instead of a prototype', () => {
  const data = y.toData(y.parse('__proto__: x\n'));
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(data, '__proto__'),
    { value: 'x', writable: true, enumerable: true, configurable: true });
});

test('aliases read as the data of their anchor, also when a key carries the anchor', () => {
  assert.deepEqual(y.toData(y.parse('a: &x {k: v}\nb: *x\n')), { a: { k: 'v' }, b: { k: 'v' } });
  assert.deepEqual(y.toData(y.parse('&k a: 1\nb: *k\n')), { a: '1', b: 'a' });
});

test('an alias needs a complete anchor before it', () => {
  const forward = y.parse('a: *x\nb: &x 1\n').errors;
  assert.deepEqual(forward.map((issue) => [issue.code, issue.range.start]), [['BAD_ALIAS', { line: 1, col: 4 }]]);
  const recursive = y.parse('a: &x [*x]\n').errors;
  assert.deepEqual(recursive.map((issue) => [issue.code, issue.range.start]), [['BAD_ALIAS', { line: 1, col: 8 }]]);
});

test('aliases that would expand into a huge document are an error', () => {
  // Each level lists the previous one ten times, so level 9 alone expands to ten billion scalars.
  const lines = ['l0: &l0 [x, x, x, x, x, x, x, x, x, x]'];
  for (let level = 1; level < 10; level++) {
    lines.push(`l${level}: &l${level} [${Array(10).fill(`*l${level - 1}`).join(', ')}]`);
  }
  const codes = y.parse(lines.join('\n') + '\n').errors.map((issue) => issue.code);
  assert.deepEqual(codes, ['RESOURCE_EXHAUSTION']);
});

test('rangeOf reports 1-based positions and offsets of a value, a key, and a whole pair', () => {
  const p = y.parse('s:\n  api:\n    name: API   # c\n');
  assert.deepEqual(y.rangeOf(p, ['s', 'api', 'name']),
    { start: { line: 3, col: 11 }, end: { line: 3, col: 14 }, offset: 20, endOffset: 23 });
  assert.deepEqual(y.rangeOf(p, ['s', 'api', 'name'], 'key'),
    { start: { line: 3, col: 5 }, end: { line: 3, col: 9 }, offset: 14, endOffset: 18 });
  assert.deepEqual(y.rangeOf(p, ['s', 'api', 'name'], 'pair'),
    { start: { line: 3, col: 5 }, end: { line: 3, col: 14 }, offset: 14, endOffset: 23 });
});

test('rangeOf is null for paths that name nothing and for the key of a sequence item', () => {
  const p = y.parse('s: [a]\nm: {k: v}\n');
  assert.equal(y.rangeOf(p, ['missing']), null);
  assert.equal(y.rangeOf(p, ['s', 1]), null);
  assert.equal(y.rangeOf(p, ['m', 'k', 'deeper']), null);
  assert.equal(y.rangeOf(p, ['s', 0], 'key'), null);
});

test('rangeOf rejects a part other than value, key, or pair', () => {
  assert.throws(() => y.rangeOf(y.parse('s: [a]\n'), ['s'], 'item'), { name: 'RangeError', message: /Unknown range part "item"/ });
});

test('replaceValue fills an empty value after its indicator and before a comment', () => {
  const p = y.parse('a:\nb: # c\nc:\n  -\n');
  const edits = [...y.replaceValue(p, ['a'], 'x'), ...y.replaceValue(p, ['b'], 'y'), ...y.replaceValue(p, ['c', 0], 'z')];
  assert.equal(y.applyEdits(p.text, edits), 'a: x\nb: y # c\nc:\n  - z\n');
});

test('replaceValue writes multi-line text as a block scalar indented under its key', () => {
  const p = y.parse('s:\n  d: old   # c\n  e: x\n');
  assert.equal(y.applyEdits(p.text, y.replaceValue(p, ['s', 'd'], 'line 1\nline 2')),
    's:\n  d: |-   # c\n    line 1\n    line 2\n  e: x\n');
});

test('replaceValue writes multi-line text double-quoted when a block scalar would take in the comment below it', () => {
  // The block's content is indented two spaces: a comment indented one space stays outside it, one indented two would not.
  const outside = y.parse('a: old\n # note\nb: x\n');
  assert.equal(y.applyEdits(outside.text, y.replaceValue(outside, ['a'], 'line 1\nline 2')),
    'a: |-\n  line 1\n  line 2\n # note\nb: x\n');
  const inside = y.parse('a: old\n  # note\nb: x\n');
  assert.equal(y.applyEdits(inside.text, y.replaceValue(inside, ['a'], 'line 1\nline 2')),
    'a: "line 1\\nline 2"\n  # note\nb: x\n');
});

test('replaceValue rewrites a block scalar and keeps its header comment', () => {
  const p = y.parse('d: |- # c\n  old\ne: x\n');
  assert.equal(y.applyEdits(p.text, y.replaceValue(p, ['d'], 'new')), 'd: new # c\ne: x\n');
  assert.equal(y.applyEdits(p.text, y.replaceValue(p, ['d'], 'a\nb')), 'd: |- # c\n  a\n  b\ne: x\n');
});

test('a multi-line value in a map whose first key carries an anchor or a tag is indented one step past that key', () => {
  const anchored = y.parse('a:\n  &k k: old\n  m: 1\n');
  assert.equal(y.applyEdits(anchored.text, y.replaceValue(anchored, ['a', 'k'], 'one\ntwo')), 'a:\n  &k k: |-\n    one\n    two\n  m: 1\n');
  const tagged = y.parse('s:\n  - !!str k: v\n    m: old\n');
  assert.equal(y.applyEdits(tagged.text, y.replaceValue(tagged, ['s', 0, 'm'], ' lead\ntext')),
    's:\n  - !!str k: v\n    m: |2-\n       lead\n      text\n');
});

test('multi-line splices write CRLF line breaks into a CRLF document', () => {
  const flow = y.parse('a: x\r\nb: y\r\n');
  assert.equal(y.applyEdits(flow.text, y.replaceValue(flow, ['a'], 'one\ntwo')), 'a: |-\r\n  one\r\n  two\r\nb: y\r\n');
  const block = y.parse('a: |\r\n  old\r\nb: y\r\n');
  assert.equal(y.applyEdits(block.text, y.replaceValue(block, ['a'], 'one\ntwo')), 'a: |-\r\n  one\r\n  two\r\nb: y\r\n');
  assert.equal(y.applyEdits(block.text, y.replaceValue(block, ['a'], 'new')), 'a: new\r\nb: y\r\n');
});

test('replaceValue writes any scalar so that it reads back exactly and changes no text outside the value\'s lines', () => {
  const positions = [
    { text: 'a: old\n', path: ['a'] },
    { text: 's:\n  - name: old   # c\n    id: x\n', path: ['s', 0, 'name'] },
    { text: 's:\n  - old\n  - x\n', path: ['s', 0] },
    { text: 't: [p, old, q]\n', path: ['t', 1] },
    { text: 'm: {k: old, z: w}\n', path: ['m', 'k'] },
    { text: 'a:\nb: x\n', path: ['a'] },
    { text: 'a: |\n  old\n  text\nb: x\n', path: ['a'] },
    { text: 'x:\r\n    a: old\r\n    b: c\r\n', path: ['x', 'a'] },
    { text: 'a: "old"', path: ['a'] },
    { text: 'a: # c\nb: x\n', path: ['a'] },
    { text: 'a: old\n  text\nb: x\n', path: ['a'] },
    { text: 'a: >-\n  old\n  text\nb: x\n', path: ['a'] },
    { text: 'a: &x 1\nb: *x\n', path: ['b'] },
    { text: 'a: old\n\nb: x\n', path: ['a'] },
    { text: 's:\n  - old\n\n  - x\n', path: ['s', 0] },
    { text: 'a: |\n  old\n\nb: x\n', path: ['a'] },
    { text: 'a: |+\n  old\n\nb: x\n', path: ['a'] },
    // Lines below the value that a block scalar written there would take in: comments indented at or past its
    // content, a blank line holding more spaces than that, and a comment led by a tab.
    { text: 'a: old\n  # note\nb: x\n', path: ['a'] },
    { text: 'a:\n  # note\n', path: ['a'] },
    { text: 's:\n  - old\n    # note\n', path: ['s', 0] },
    { text: 'a: |4\n      old\n  # note\nb: x\n', path: ['a'] },
    { text: 'a: old\r\n  # note\r\nb: x\r\n', path: ['a'] },
    { text: 'a: old\n     \nb: x\n', path: ['a'] },
    { text: 'a: old\n\t# note\nb: x\n', path: ['a'] },
    // A map whose first key carries an anchor or a tag starts, for indentation, where those properties start.
    { text: 'a:\n  &k k: old\n  m: 1\n', path: ['a', 'k'] },
    { text: 's:\n  - !!str k: old\n    m: 1\n', path: ['s', 0, 'k'] },
    { text: 's:\n  - &k k: v\n    m: old\n', path: ['s', 0, 'm'] },
  ];
  const values = ['new', 'x: y', '', 'true', '1.10', 'line 1\nline 2', ' lead\ntext', 'keep\n\n', 'trail\n  ',
    '--- x', '# hash', 'a #b', 'JSON, HTTPS', '[x]', "it's", 'say "hi"\nthere', 'Café 学生 😀', 'tab\there',
    'bell\u0007', `${'x'.repeat(50)}\n  `, 'line\n\u2028separator', '\n', 'blank\n \n',
    `${'long '.repeat(10)}\nends in a blank line\n\n`, 3, true];
  for (const { text, path } of positions) {
    const parsed = y.parse(text);
    const expected = (value) => withDataAt(y.toData(parsed), path, String(value));
    const { before, after } = textAroundValue(parsed, path);
    for (const value of values) {
      const result = y.applyEdits(text, y.replaceValue(parsed, path, value));
      const reparsed = y.parse(result);
      const label = `${JSON.stringify(value)} at ${JSON.stringify(path)} in ${JSON.stringify(text)}`;
      assert.deepEqual(reparsed.errors, [], label);
      assert.deepEqual(y.toData(reparsed), expected(value), label);
      assert.equal(result.slice(0, before.length), before, label);
      assert.equal(result.slice(result.length - after.length), after, label);
    }
  }
});

test('renameKey quotes keys that need it, also inside flow maps', () => {
  const p = y.parse('a: 1\nm: {b: 2}\n');
  assert.equal(y.applyEdits(p.text, y.renameKey(p, [], 'a', 'web -> api')), 'web -> api: 1\nm: {b: 2}\n');
  assert.equal(y.applyEdits(p.text, y.renameKey(p, [], 'a', 'x: y')), '"x: y": 1\nm: {b: 2}\n');
  assert.equal(y.applyEdits(p.text, y.renameKey(p, ['m'], 'b', 'c, d')), 'a: 1\nm: {"c, d": 2}\n');
});

test('renameKey writes any key so that it reads back exactly and leaves other entries alone', () => {
  const positions = [
    { text: 'old: 1 # c\nz: 2\n', mapPath: [] },
    { text: 'm: {old: 1, z: 2}\n', mapPath: ['m'] },
    { text: 's:\n  - old: 1\n    z: 2\n', mapPath: ['s', 0] },
  ];
  const keys = ['neu', 'web -> api', 'x: y', 'a, b', 'true', '', '# k', 'Café 学生', 'line\nbreak'];
  for (const { text, mapPath } of positions) {
    const parsed = y.parse(text);
    for (const key of keys) {
      const reparsed = y.parse(y.applyEdits(text, y.renameKey(parsed, mapPath, 'old', key)));
      const label = `${JSON.stringify(key)} at ${JSON.stringify(mapPath)} in ${JSON.stringify(text)}`;
      assert.deepEqual(reparsed.errors, [], label);
      assert.deepEqual(y.toData(reparsed), withKeyRenamed(y.toData(parsed), mapPath, 'old', key), label);
    }
  }
});

test('renameKey writes a key of up to 1024 characters and refuses a longer one', () => {
  const p = y.parse('old: 1\nm: {old: 2}\n');
  const longest = 'k'.repeat(1024);
  const renamed = y.parse(y.applyEdits(p.text, [...y.renameKey(p, [], 'old', longest), ...y.renameKey(p, ['m'], 'old', longest)]));
  assert.deepEqual(renamed.errors, []);
  assert.deepEqual(y.toData(renamed), { [longest]: '1', m: { [longest]: '2' } });
  const tooLong = { name: 'RangeError', message: /does not fit on one line of 1024 characters/ };
  assert.throws(() => y.renameKey(p, [], 'old', 'k'.repeat(1025)), tooLong);
  assert.throws(() => y.renameKey(p, ['m'], 'old', 'k'.repeat(1025)), tooLong);
});

test('edit primitives reject paths and keys that name nothing', () => {
  const p = y.parse('a: 1\n');
  assert.throws(() => y.replaceValue(p, ['b'], 'v'), { name: 'RangeError', message: /No value at \["b"\]/ });
  assert.throws(() => y.replaceValue(y.parse('just text\n'), [], 'v'), { name: 'RangeError', message: /path of a map value/ });
  assert.throws(() => y.renameKey(p, [], 'b', 'c'), { name: 'RangeError', message: /No key "b"/ });
  assert.throws(() => y.renameKey(p, ['b'], 'a', 'c'), { name: 'RangeError', message: /No map at \["b"\]/ });
});

test('edit primitives reject nodes and values of the wrong kind', () => {
  const p = y.parse('s: [x]\n');
  assert.throws(() => y.replaceValue(p, ['s'], 'v'), { name: 'TypeError', message: /holds a collection/ });
  assert.throws(() => y.replaceValue(p, ['s', 0], ['v']), { name: 'TypeError', message: /string, number, or boolean/ });
  assert.throws(() => y.renameKey(p, ['s'], 'x', 'y'), { name: 'TypeError', message: /holds no map/ });
});

test('applyEdits applies every edit against the original text in any order', () => {
  const edits = [{ offset: 4, length: 1, text: 'E' }, { offset: 0, length: 0, text: '>' }, { offset: 1, length: 2, text: '' }];
  assert.equal(y.applyEdits('abcdef', edits), '>adEf');
});

test('applyEdits rejects edits that reach past the text', () => {
  assert.throws(() => y.applyEdits('abc', [{ offset: 2, length: 2, text: 'x' }]), RangeError);
});

test('stringifyFragment indents nested lines one step below the parent collection, leaving blank lines empty', () => {
  assert.equal(y.stringifyFragment('line 1\n\nline 3', { indent: 4 }), '|-\n      line 1\n\n      line 3');
  assert.equal(y.stringifyFragment({ name: 'API', tags: ['a'] }, { indent: 4 }), 'name: API\n      tags:\n        - a');
});

test('stringifyFragment writes a single flow node for a flow collection', () => {
  assert.equal(y.stringifyFragment('JSON, HTTPS', { flow: true }), '"JSON, HTTPS"');
  assert.equal(y.stringifyFragment({ k: ['x', 'y'] }, { flow: true }), '{k: [x, y]}');
  assert.equal(y.stringifyFragment('line 1\nline 2', { flow: true }), '"line 1\\nline 2"');
});

test('stringifyFragment writes text ending in a blank line so that blank lines after the fragment stay outside it', () => {
  const fragment = y.stringifyFragment({ tags: ['end\n\n'], description: 'end\n\n' }, { indent: 0 });
  const text = `s:\n  ${fragment}\n\nz: x\n`;
  assert.deepEqual(y.toData(y.parse(text)), { s: { tags: ['end\n\n'], description: 'end\n\n' }, z: 'x' });
});

test('stringifyFragment writes a repeated object in full instead of an anchor and alias', () => {
  const shared = { k: 'v' };
  assert.equal(y.stringifyFragment([shared, shared]), '- k: v\n  - k: v');
});
