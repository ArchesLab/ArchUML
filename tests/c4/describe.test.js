'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const p = require('../../c4/c4-projection.js');
const { describe } = require('../../c4/c4-describe.js');
const { fixture } = require('./helpers.js');

const REFERENCE = fixture('course-registration.yml');

function load(text) {
  return modelApi.normalize(y.parse(text), { source: 'embed' }).model;
}

/** The reference text with `from` replaced by `to`; fails when `from` is absent, so edits cannot silently miss. */
function withReplaced(from, to) {
  assert.ok(REFERENCE.includes(from), `the reference model contains ${from}`);
  return REFERENCE.replace(from, to);
}

const reference = load(REFERENCE);

function describeView(model, selector) {
  return describe(p.projectView(model, selector));
}

function itemsOf(description, heading) {
  return description.sections.find((section) => section.heading === heading).items;
}

test('the brief label counts elements and relationships', () => {
  assert.equal(describeView(reference, 'containers of registration').brief,
    'Container view of Course Registration: 3 containers, 1 person, 1 external system, 4 relationships.');
});

test('the brief label uses the singular for a count of one', () => {
  const brief = describeView(reference, 'context of registration').brief;
  assert.equal(brief, 'System context view of Course Registration: 1 software system, 1 person, 1 external system, 2 relationships.');
});

test('the verbose text lists elements by type and relationships as sentences', () => {
  const description = describeView(reference, 'containers of registration');
  assert.deepEqual(description.sections.map((section) => section.heading),
    ['Containers', 'People', 'Software systems', 'Relationships', 'Legend']);
  assert.ok(itemsOf(description, 'Relationships').includes(
    'Planner Web App submits plans to Registration API using JSON/HTTPS (derived from Planner Web App → Registration Coordinator).'));
  assert.ok(itemsOf(description, 'Containers').includes(
    'Registration API (Container: Python, FastAPI): Decides eligibility and enrolls students atomically.'));
  assert.ok(itemsOf(description, 'Relationships').includes('Student plans a schedule and enrolls using Planner Web App.'));
  assert.ok(itemsOf(description, 'Legend').includes('External: not designed or owned by this team'));
});

test('absences are stated neutrally without naming rules', () => {
  const text = withReplaced('    description: Builds conflict-free schedules and enrolls students in their sections.\n',
    '    description: Builds conflict-free schedules and enrolls students in their sections.\n    collaborators:\n      billing: {technology: HTTPS}\n')
    .replace('coordinator: {description: submits plans to, technology: JSON/HTTPS}', 'coordinator: submits plans to');
  const model = load(text);
  const context = describeView(model, 'context of registration');
  assert.ok(itemsOf(context, 'Relationships').includes('Course Registration → Billing System: no description.'));
  const containers = describeView(model, 'containers of registration');
  const noTechnology = itemsOf(containers, 'Relationships').find((item) => item.startsWith('Planner Web App submits plans to Registration API'));
  assert.equal(noTechnology, 'Planner Web App submits plans to Registration API; no technology (derived from Planner Web App → Registration Coordinator).');
  [context, containers].forEach((description) => description.sections.flatMap((section) => section.items)
    .forEach((item) => assert.doesNotMatch(item, /c4\/|\b(?:xlevel|rdd|c4)\b/i)));
});

test('a view without elements is described as empty', () => {
  const view = { ...p.projectView(reference, 'landscape'), nodes: [], edges: [], legend: [] };
  assert.deepEqual(describe(view), { brief: 'System landscape: empty.', sections: [] });
});

test('a derived relationship names the ends of its source relationships from the view model alone', () => {
  const items = itemsOf(describe(p.projectView(reference, 'containers of registration')), 'Relationships');
  assert.ok(items.includes(
    'Planner Web App submits plans to Registration API using JSON/HTTPS (derived from Planner Web App → Registration Coordinator).'));
});

test('a view whose selector names nothing is described by its diagnostic', () => {
  assert.deepEqual(describe(p.projectView(reference, 'containers of nowhere')), {
    brief: 'This view cannot be drawn. There is no element named nowhere.',
    sections: [{ heading: 'How to fix it', items: ['Choose one of the listed views'] }],
  });
  const malformed = describe(p.projectView(reference, 'containers of'));
  assert.match(malformed.brief, /^This view cannot be drawn. "containers of" is not a view selector; use landscape, /);
  assert.deepEqual(malformed.sections, []);
});

test('a code view reads as classes and relationships', () => {
  const description = describeView(reference, 'code of policy');
  assert.equal(description.brief, 'Code view of Enrollment Policy: 4 classes, 3 relationships.');
  assert.ok(itemsOf(description, 'Relationships').includes('PrerequisiteRule implements EnrollmentRule.'));
  assert.ok(itemsOf(description, 'Classes').includes('EnrollmentRule (interface): + evaluate(student, section): RuleResult'));
});

test('a dynamic view reads as ordered steps that mark replies and alternatives', () => {
  const description = describeView(reference, 'dynamic enroll');
  assert.equal(description.brief, 'Dynamic view of Enroll in a planned schedule: 5 participants, 5 messages.');
  assert.deepEqual(itemsOf(description, 'Steps').slice(0, 3), [
    'Planner Web App → Registration Coordinator: submits the plan to [JSON/HTTPS].',
    'Registration Coordinator → Enrollment Policy: asks for an eligibility decision from.',
    '[alt: eligible] Registration Coordinator → Seat Gateway: reserves all seats or none through.',
  ]);
  assert.equal(itemsOf(description, 'Steps')[4],
    '[alt: not eligible] Registration Coordinator → Planner Web App: reports the refusal and its reason to [JSON/HTTPS] (reply).');
});

test('a deployment view reads as nested nodes with their hosted elements and paths', () => {
  const description = describeView(reference, 'deployment production');
  assert.equal(description.brief, 'Deployment view of Production: 7 nodes, 4 hosted elements, 4 communication paths.');
  assert.ok(itemsOf(description, 'Nodes').includes('API pod ×3 (environment, Docker), inside Campus cloud; hosts Registration API'));
  assert.ok(itemsOf(description, 'Communication paths').includes(
    'Registration API requests tuition charges from Billing System using AMQP (asynchronous).'));
});
