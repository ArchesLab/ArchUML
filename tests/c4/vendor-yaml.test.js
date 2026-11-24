'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const VENDOR_DIR = path.join(__dirname, '..', '..', 'vendor', 'yaml', '2.9.1');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(VENDOR_DIR, file))).digest('hex');
const readSource = () => fs.readFileSync(path.join(VENDOR_DIR, 'yaml.js'), 'utf8');

test('vendored yaml loads through require and parses a mapping', () => {
  const Y = require('../../vendor/yaml/2.9.1/yaml.js');
  assert.equal(Y.parse('a: b').a, 'b');
  assert.equal(typeof Y.LineCounter, 'function');
});

test('vendored yaml exposes the full API the C4 core consumes', () => {
  const Y = require('../../vendor/yaml/2.9.1/yaml.js');
  for (const name of ['parseDocument', 'parse', 'stringify', 'LineCounter', 'isMap', 'isSeq', 'isScalar', 'isPair', 'visit']) {
    assert.equal(typeof Y[name], 'function', name);
  }
  assert.equal(typeof Y.CST, 'object');
});

test('vendored yaml defines ArchUMLYAML in a classic-script context', () => {
  const ctx = vm.createContext({});
  vm.runInContext(readSource(), ctx);
  assert.equal(typeof ctx.ArchUMLYAML.parseDocument, 'function');
});

test('vendored yaml has no AMD branch and no closing script tag', () => {
  const src = readSource();
  assert.doesNotMatch(src, /define\.amd/);
  assert.doesNotMatch(src, /<\/script/i);
});

test('SHA256SUMS matches the vendored files', () => {
  const lines = fs.readFileSync(path.join(VENDOR_DIR, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.deepEqual(lines, [`${sha256('yaml.js')}  yaml.js`, `${sha256('LICENSE')}  LICENSE`]);
});

test('package.json pins yaml 2.9.1 exactly', () => {
  assert.equal(require('../../../../package.json').devDependencies.yaml, '2.9.1');
});
