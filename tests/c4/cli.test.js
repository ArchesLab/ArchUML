'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', 'c4', 'cli.js');
const REFERENCE = path.join(__dirname, 'fixtures', 'course-registration.yml');

const USAGE_ERROR = 64;
const UNREADABLE_FILE = 66;

function cli(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Runs `body` with the path of a temporary file holding `text`. */
function withFile(text, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-cli-'));
  const file = path.join(directory, 'design.yml');
  fs.writeFileSync(file, text);
  try {
    return body(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const WARNING_ONLY = 'schema: c4-design/1\nsystems:\n  shop:\n    name: Shop\n    responsibilities:\n      - do: sell things\n    containers:\n      web:\n        name: Web\n        description: Serves pages to shoppers.\n';

test('check exits 0 and prints the JSON shape for the reference model', () => {
  const { code, out } = cli('check', REFERENCE, '--json');
  const report = JSON.parse(out);
  assert.equal(code, 0);
  assert.deepEqual(Object.keys(report), ['valid', 'counts', 'diagnostics']);
  assert.equal(report.valid, true);
  assert.deepEqual(report.counts, { error: 0, warning: 0, info: report.diagnostics.length });
  assert.ok(report.diagnostics.every((found) => found.severity === 'info'));
});

test('check --strict still exits 0 when only information remains', () => {
  assert.equal(cli('check', REFERENCE, '--strict').code, 0);
});

test('check exits 1 and reports a file with an unknown key', () => {
  withFile('schema: c4-design/1\nsystems:\n  shop:\n    name: Shop\n    colour: red\n', (file) => {
    const { code, out } = cli('check', file, '--json');
    const report = JSON.parse(out);
    assert.equal(code, 1);
    assert.equal(report.valid, false);
    assert.equal(report.counts.error, 1);
    assert.equal(report.diagnostics[0].rule, 'schema/unknown-key');
  });
});

test('check exits 0 on warnings, and 2 with --strict', () => {
  withFile(WARNING_ONLY, (file) => {
    const lenient = cli('check', file, '--json');
    assert.equal(lenient.code, 0);
    assert.ok(JSON.parse(lenient.out).counts.warning > 0);
    assert.equal(cli('check', file, '--strict').code, 2);
  });
});

test('check --disable drops the named rules', () => {
  withFile(WARNING_ONLY, (file) => {
    const rules = JSON.parse(cli('check', file, '--json').out).diagnostics.map((found) => found.rule);
    const result = cli('check', file, '--json', '--strict', '--disable', rules.join(','));
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.out).diagnostics, []);
  });
});

test('check prints each diagnostic with its position and rule in plain text', () => {
  withFile('schema: c4-design/1\nsystems:\n  shop:\n    name: Shop\n    colour: red\n', (file) => {
    const { code, out } = cli('check', file);
    assert.equal(code, 1);
    assert.match(out, /:5:\d+ error schema\/unknown-key /);
  });
});

test('no arguments is a usage error', () => {
  const { code, err } = cli();
  assert.equal(code, USAGE_ERROR);
  assert.match(err, /Usage: /);
});

test('an unknown command or option is a usage error', () => {
  assert.equal(cli('frobnicate', REFERENCE).code, USAGE_ERROR);
  assert.equal(cli('check', REFERENCE, '--bogus').code, USAGE_ERROR);
  assert.equal(cli('check').code, USAGE_ERROR);
});

test('a missing file exits 66', () => {
  assert.equal(cli('check', path.join(os.tmpdir(), 'c4-cli-no-such-file.yml')).code, UNREADABLE_FILE);
});

test('views prints the seven selectors of the reference model', () => {
  const { code, out } = cli('views', REFERENCE);
  assert.equal(code, 0);
  assert.deepEqual(out.trim().split('\n'), [
    'landscape', 'context of registration', 'containers of registration', 'components of api',
    'code of policy', 'dynamic enroll', 'deployment production',
  ]);
});

test('uml --view "code of policy" prints class text', () => {
  const { code, out } = cli('uml', REFERENCE, '--view', 'code of policy');
  assert.equal(code, 0);
  assert.match(out, /EnrollmentPolicy/);
  assert.match(out, /EnrollmentRule/);
});

test('uml of a C4-notation view is a usage error', () => {
  assert.equal(cli('uml', REFERENCE, '--view', 'containers of registration').code, USAGE_ERROR);
});

test('describe prints the brief of the requested view', () => {
  const { code, out } = cli('describe', REFERENCE, '--view', 'containers of registration');
  assert.equal(code, 0);
  assert.match(out, /^Container view/);
});

test('describe of an unknown view exits 1 and names the problem', () => {
  const { code, err } = cli('describe', REFERENCE, '--view', 'containers of nothing');
  assert.equal(code, 1);
  assert.match(err, /view\/unknown-selector/);
});

test('describe, views, and uml refuse a file with errors and print its diagnostics', () => {
  withFile('systems: [unclosed', (file) => {
    ['describe', 'views', 'uml'].forEach((command) => {
      const { code, err } = cli(command, file);
      assert.equal(code, 1, command);
      assert.match(err, /yaml\/syntax/);
    });
  });
});

test('schema prints the JSON Schema that is committed', () => {
  const committed = fs.readFileSync(path.join(__dirname, '..', '..', 'c4', 'schema', '1', 'design.schema.json'), 'utf8');
  const { code, out } = cli('schema');
  assert.equal(code, 0);
  assert.equal(out, committed);
});
