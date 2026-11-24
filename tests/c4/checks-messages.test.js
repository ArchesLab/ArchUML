'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const checks = require('../../c4/c4-checks.js');
const { fixture } = require('./helpers.js');

// The learner messages of the core rules (spec §7.2, "Learner messages for the core rules"): each says what is
// wrong in the learner's terms, why a reader needs it, and a question or a neutral example.

/** Words the chapter does not teach, which no learner message or hint may use. */
const UNTAUGHT_TERMS = /\b(?:lifted|decomposed|off-chain|derived)\b/i;

// The chapter and its tutorials write American English; the rule catalog's titles and rationales, which the
// editor's problems panel shows learners, follow them.
const BRITISH_SPELLINGS = /\b(?:labell(?:ed|ing)|centres?|colours?|behaviours?|modell(?:ed|ing)|analys(?:e|ed|ing)|organis(?:e|ed|ing|ation)|fulfils?|fulfilment|cancell(?:ed|ing))\b/i;

test('every rule title and rationale uses American spelling', () => {
  const british = checks.RULES.filter((entry) => BRITISH_SPELLINGS.test(`${entry.title} ${entry.rationale}`)).map((entry) => entry.id);
  assert.deepEqual(british, []);
});

function diagnosticsOf(text) {
  const parsed = y.parse(text);
  const { model, diagnostics } = modelApi.normalize(parsed, { source: 'embed' });
  assert.deepEqual(diagnostics, [], 'fixture diagnostics');
  return checks.run(model, { parsed });
}

/** The `{ message, hint }` of each diagnostic one rule reports on `text`. */
function wordingOf(text, ruleId) {
  return diagnosticsOf(text).filter((diagnostic) => diagnostic.rule === ruleId)
    .map(({ message, hint }) => ({ message, hint }));
}

const CONTAINERS = [
  'systems:',
  '  shop:',
  '    name: Shop',
  '    description: Sells books to readers.',
  '    containers:',
  '      web:',
  '        name: Web Shop',
  '        technology: React',
  '        collaborators:',
  '          api: {technology: JSON/HTTPS}',
  '      api:',
  '        name: Order API',
  '        technology: Python',
  '        collaborators:',
  '          db: reads',
  '      db:',
  '        name: Order Store',
  '        kind: database',
  '        technology: Docker',
].join('\n');

const LANDINGS = [
  'people:',
  '  student: {name: Student, collaborators: {planner: plans a schedule using}}',
  'systems:',
  '  planner:',
  '    name: Planner',
  '    collaborators: {billing: requests tuition charges from}',
  '    containers:',
  '      web: {name: Web App}',
  '  billing: {name: Billing System, external: true}',
].join('\n');

const SCENARIO = [
  'people:',
  '  student: {name: Student, collaborators: {shop: buys books from}}',
  '  clerk: {name: Clerk}',
  'systems:',
  '  shop: {name: Shop}',
  'scenarios:',
  '  buy:',
  '    steps:',
  '      - student -> shop: buys books from',
  '      - alt:',
  '          - when: in stock',
  '            steps:',
  '              - shop -> clerk: asks to pack the order',
].join('\n');

const DUPLICATE_OWNERS = [
  'systems:',
  '  shop:',
  '    name: Shop',
  '    containers:',
  '      api: {name: Order API, owns: [seat holds]}',
  '      worker: {name: Worker, owns: [seat holds]}',
].join('\n');

const OBLIGATION = 'systems:\n  shop:\n    name: Shop\n    responsibilities:\n      - know: seatCount\n';
const GENERIC = 'systems:\n  s:\n    name: Backend\n';
const REQUIREMENT = 'requirements:\n  FR-1: Students can enroll.\nsystems:\n  shop:\n    name: Shop\n';
const CENTRAL = [
  'systems:',
  '  shop:',
  '    name: Shop',
  '    containers:',
  '      a: {name: Alpha, responsibilities: [decide which order ships first]}',
  '      b: {name: Beta, responsibilities: [know the stock levels]}',
  '      c: {name: Gamma, responsibilities: [know the delivery slots]}',
].join('\n');

test('rdd/not-an-obligation says the text reads like code and asks what the element promises', () => {
  assert.deepEqual(wordingOf(OBLIGATION, 'rdd/not-an-obligation'), [{
    message: "'seatCount' reads like a field, a method, or a screen step. A responsibility is a promise a reader can check.",
    hint: "Finish the sentence 'Shop promises to…' with KNOW, DO, or DECIDE.",
  }]);
});

test('rdd/no-reason asks what the source asks the target for', () => {
  assert.deepEqual(wordingOf(CONTAINERS, 'rdd/no-reason'), [{
    message: "Web Shop's relationship to Order API has no description. A reader cannot tell what Web Shop asks for.",
    hint: 'Read it aloud from Web Shop: what does it ask Order API for?',
  }]);
});

test('c4/vague-relationship says the label could be on any arrow', () => {
  assert.deepEqual(wordingOf(CONTAINERS, 'c4/vague-relationship'), [{
    message: "'reads' could label any arrow. A reader cannot tell what Order API asks of Order Store.",
    hint: "Write what is asked, ending with a word such as from, to, or through: 'requests tuition charges from'.",
  }]);
});

test('c4/cross-container-technology says the request travels between separate applications', () => {
  assert.deepEqual(wordingOf(CONTAINERS, 'c4/cross-container-technology'), [{
    message: 'Order API and Order Store run as separate applications, but the relationship names no technology. ' +
      'A reader cannot tell how the request travels.',
    hint: 'Name the protocol or format, such as JSON/HTTPS or SQL/TCP.',
  }]);
});

test('c4/infrastructure-container says the technology names where the container runs', () => {
  assert.deepEqual(wordingOf(CONTAINERS, 'c4/infrastructure-container'), [{
    message: 'Docker says where Order Store runs, not what it is built with. Where it runs belongs in a deployment view.',
    hint: 'Name the language and framework, or the database product; write TBD if the team has not chosen.',
  }]);
});

test('c4/generic-name says the name could belong to any system', () => {
  assert.deepEqual(wordingOf(GENERIC, 'c4/generic-name'), [{
    message: "'Backend' could name a part of any system. A reader cannot tell what this one does.",
    hint: 'Name it after what it does for its users.',
  }]);
});

test('xlevel/scenario-step numbers the step among all steps, fragments included', () => {
  assert.deepEqual(wordingOf(SCENARIO, 'xlevel/scenario-step'), [{
    message: 'Step 2, Shop to Clerk, follows no relationship in the model and answers no earlier request. ' +
      'A scenario can only use collaborations the design has.',
    hint: 'Does an earlier step ask Shop for something it could answer?',
  }]);
});

test('xlevel/unreceived and xlevel/unsent ask which part receives or sends the relationship', () => {
  assert.deepEqual(wordingOf(LANDINGS, 'xlevel/unreceived'), [{
    message: 'Student → Planner reaches Planner, but no part inside it receives it.',
    hint: 'Choose which part receives it.',
  }]);
  assert.deepEqual(wordingOf(LANDINGS, 'xlevel/unsent'), [{
    message: 'Planner → Billing System reaches Planner, but no part inside it sends it.',
    hint: 'Choose which part sends it.',
  }]);
});

test('rdd/uncovered-requirement asks which responsibility keeps the promise', () => {
  assert.deepEqual(wordingOf(REQUIREMENT, 'rdd/uncovered-requirement'), [{
    message: 'No responsibility traces to the requirement FR-1.',
    hint: 'Which responsibility keeps the promise FR-1 asks for? Add FR-1 to its Requirements.',
  }]);
  const rule = checks.RULES.find((candidate) => candidate.id === 'rdd/uncovered-requirement');
  assert.equal(rule.title, 'Requirement no responsibility traces to');
  assert.equal(rule.rationale, 'Tracing each requirement to a responsibility shows which element is accountable for it; ' +
    'whether the design actually meets the requirement is for review and testing to show.');
});

test('rdd/centralized-control presents central control as a choice', () => {
  const [found] = wordingOf(CENTRAL, 'rdd/centralized-control');
  assert.equal(found.hint, 'Centralized control is a choice. If rules keep accumulating here and the siblings hold the data each ' +
    'decision needs, consider delegating; for novice maintainers, a central element may be easier to follow.');
  const rule = checks.RULES.find((candidate) => candidate.id === 'rdd/centralized-control');
  assert.equal(rule.rationale, 'A centralized style is simple to follow, but the central element grows with every new rule; ' +
    'a delegated style keeps each decision beside its data but asks maintainers to follow more collaborations. ' +
    'Which pays off depends on who maintains it and which changes come.');
});

test('rdd/duplicate-authority asks which of the two owners writes the fact', () => {
  assert.deepEqual(wordingOf(DUPLICATE_OWNERS, 'rdd/duplicate-authority'), [{
    message: 'seat holds is owned by both Order API and Worker, which are not part of each other. A fact has one owner, its only writer.',
    hint: 'Which of the two writes seat holds? A container and its own component may both list it.',
  }]);
});

test('no message or hint uses a term the chapter does not teach', () => {
  const texts = [CONTAINERS, LANDINGS, SCENARIO, DUPLICATE_OWNERS, OBLIGATION, GENERIC, REQUIREMENT, CENTRAL,
    fixture('course-registration.yml')];
  const found = texts.flatMap(diagnosticsOf);
  assert.ok(found.length >= 12, 'the corpus raises the rules under test');
  found.forEach(({ rule, message, hint }) => {
    assert.doesNotMatch(message, UNTAUGHT_TERMS, rule);
    if (hint) assert.doesNotMatch(hint, UNTAUGHT_TERMS, rule);
  });
});
