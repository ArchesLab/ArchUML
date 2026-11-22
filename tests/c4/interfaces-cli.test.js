'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadCore, fixture } = require('./helpers.js');

// The interface additions of the command line (spec §7.3).

const CLI = path.join(__dirname, '..', '..', 'c4', 'cli.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const REGISTRATION = path.join(FIXTURES, 'course-registration-interfaces.yml');

function cli(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('views --interfaces prints the Milestone 1 views followed by the interface views', () => {
  const { code, out } = cli('views', REGISTRATION, '--interfaces');
  const lines = out.trimEnd().split('\n');
  assert.equal(code, 0);
  assert.equal(lines.length, 15);
  assert.deepEqual(lines, loadCore().listViews(loadCore().load(fixture('course-registration-interfaces.yml')), { interfaces: true })
    .map((view) => view.selector));
});

test('views without --interfaces prints the seven Milestone 1 views', () => {
  assert.equal(cli('views', REGISTRATION).out.trimEnd().split('\n').length, 7);
});

test('uml --view "interfaces of api" prints the component diagram text', () => {
  const { code, out } = cli('uml', REGISTRATION, '--view', 'interfaces of api');
  assert.equal(code, 0);
  assert.ok(out.startsWith('@startuml\nlayout vertical\ncomponent "Planner Web App" as e1 <<Container: TypeScript, React>> {'), out.slice(0, 200));
});

test('describe --view "interface enrollment-api" prints the card description', () => {
  const { code, out } = cli('describe', REGISTRATION, '--view', 'interface enrollment-api');
  const core = loadCore();
  const expected = core.describe(core.project(core.load(fixture('course-registration-interfaces.yml')), 'interface enrollment-api'));
  assert.equal(code, 0);
  assert.ok(out.startsWith(`${expected.brief}\n`), out.slice(0, 200));
});

test('describe --panels syntax prints less than the full card description', () => {
  const full = cli('describe', REGISTRATION, '--view', 'interface enrollment-api');
  const syntax = cli('describe', REGISTRATION, '--view', 'interface enrollment-api', '--panels', 'syntax');
  assert.equal(syntax.code, 0);
  assert.ok(syntax.out.length < full.out.length);
});

test('check exits 0 on the interface reference model', () => {
  assert.equal(cli('check', REGISTRATION).code, 0);
});

test('check --strict exits 2 on a model with warnings', () => {
  assert.equal(cli('check', path.join(FIXTURES, 'interfaces-shop.yml'), '--strict').code, 2);
});

test('check exits 0 on a model with warnings and no errors', () => {
  assert.equal(cli('check', path.join(FIXTURES, 'interfaces-l14-booking.yml')).code, 0);
});

test('--panels with an unknown value is a usage error', () => {
  const { code, err } = cli('describe', REGISTRATION, '--panels', 'everything');
  assert.equal(code, 64);
  assert.match(err, /panels/);
});
