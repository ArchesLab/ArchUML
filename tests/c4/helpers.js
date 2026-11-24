'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

/** The assembled DOM-free core (`ArchUMLC4`). */
function loadCore() {
  return require('../../c4/c4-core.js');
}

/** Text of a fixture file under tests/c4/fixtures. */
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** The rule ids of a diagnostics list, in order. */
function rulesOf(diagnostics) {
  return diagnostics.map((diagnostic) => diagnostic.rule);
}

module.exports = { loadCore, fixture, rulesOf };
