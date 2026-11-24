'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadCore, fixture } = require('./helpers.js');

// The interface reference model (spec §4.2, J13) keeps every Milestone 1 invariant of the reference model and adds
// the chapter review's amendments and the 2026-11-09 instructor decisions.

const MILESTONE_1_FIXTURE_SHA256 = 'f44c26acbd4593a09904831983be65cf2b08641ad0e17b17b48784a8e84b5720';

const core = loadCore();
const design = core.load(fixture('course-registration-interfaces.yml'), { source: 'file' });
const { model } = design;

function responsibility(id) {
  return model.responsibilityById.get(id);
}

function errorsAndWarnings(found) {
  return found.filter((diagnostic) => diagnostic.severity !== 'info');
}

test('the interface reference model keeps every Milestone 1 invariant', () => {
  assert.deepEqual(design.diagnostics, []);
  assert.equal(model.elements.size, 14);
  assert.deepEqual(model.rootIds, ['student', 'registration', 'billing']);
  assert.equal(model.relationships.length, 8);
  assert.deepEqual(core.listViews(design).map((view) => view.selector), [
    'landscape', 'context of registration', 'containers of registration', 'components of api',
    'code of policy', 'dynamic enroll', 'deployment production',
  ]);
  assert.equal(core.describe(core.project(design, 'containers of registration')).brief,
    'Container view of Course Registration: 3 containers, 1 person, 1 external system, 4 relationships.');
  assert.deepEqual(errorsAndWarnings(core.check(design)), []);
  assert.deepEqual([...model.interfaces.keys()], ['enrollment-api', 'tuition-charges']);
});

test('the interface reference model carries the chapter review amendments', () => {
  assert.match(model.requirements.get('FR-07').text, /^A student who lacks a prerequisite/);
  const production = model.environments.get('production');
  assert.deepEqual(production.nodes.get('browser').relationships.map((link) => link.targetId), ['ingress']);
  assert.equal(production.nodes.get('api-pod').technology, 'Kubernetes pod');
});

test('the interface reference model carries the 2026-11-09 decisions', () => {
  assert.deepEqual([...model.requirements.keys()], ['FR-07', 'FR-09', 'FR-11']);
  assert.equal(responsibility('sys-billing').ownerId, 'registration');
  assert.deepEqual(responsibility('sys-billing').requirements, ['FR-11']);
  assert.deepEqual(responsibility('api-billing').refines, ['sys-billing']);
  const billingPaths = ['sys-billing', 'api-billing'].map((id) => JSON.stringify(responsibility(id).path));
  const found = core.check(design);
  assert.deepEqual(found.filter((diagnostic) => diagnostic.rule === 'rdd/uncovered-requirement'), []);
  assert.deepEqual(found.filter((diagnostic) => diagnostic.rule === 'rdd/unrefined'
    && billingPaths.includes(JSON.stringify(diagnostic.path))), []);
  assert.doesNotMatch(model.meta.description, /conflict-free/);
  assert.doesNotMatch(model.elements.get('registration').description, /conflict-free/);
  const chargeTuition = model.interfaces.get('tuition-charges').operations.find((operation) => operation.id === 'charge-tuition');
  assert.equal(chargeTuition.syntax, 'send ChargeRequested to the queue billing.charges');
});

test('the Milestone 1 fixture is unchanged', () => {
  const digest = crypto.createHash('sha256').update(fixture('course-registration.yml'), 'utf8').digest('hex');
  assert.equal(digest, MILESTONE_1_FIXTURE_SHA256);
});
