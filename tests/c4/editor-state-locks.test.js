'use strict';

// What a lock refusal names (UML-view editing spec §5.1 "Locks and read-only", plan Task 33): the editor state's
// lockedRefusal names the drawn thing that holds the locked path, so a refusal on a UML-notation view tells the learner
// which step, node, link, or layout the task gives. An element's name stays the subject it is today
// (editor-state.test.js pins those sentences).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./helpers.js');

const { createEditorState, lockedSentence } = require(path.join(__dirname, '..', '..', 'c4', 'editor', 'c4-editor-state.js'));

const REFERENCE = fixture('course-registration.yml');
const SCENARIO = 'Enroll in a planned schedule';
// The enroll scenario's steps: 1 web -> coordinator, 2 coordinator -> policy, 3 an alt whose first branch holds
// coordinator -> seats and coordinator -> billing-gateway.
const ENROLL_STEPS = 'scenarios.enroll.steps';
const CAMPUS = 'deployment.production.nodes.campus-cloud.nodes';
const NEW_STEP = { from: 'coordinator', to: 'policy', description: 'asks for a second decision from' };

/** An editor state on the reference model with `lockedFields`, open on `view` (default: its default view). */
function editor(lockedFields, view) {
  return createEditorState({ text: REFERENCE, host: { onTextChange() {} }, lockedFields, view });
}

/** Dispatches `command` and returns the refusal's sentence, after checking it is a lock refusal that changed nothing. */
function refusedSentence(state, command) {
  const result = state.dispatch(command);
  assert.equal(result.error, 'locked', `the command is refused for its lock, not for "${result.message}"`);
  assert.equal(state.getText(), REFERENCE, 'nothing is written');
  assert.equal(state.lockRefusal(command).message, result.message, 'lockRefusal says what dispatch says');
  return result.message;
}

test('a refused addStep under a locked scenarios path names step 3 of its scenario', () => {
  const state = editor([`${ENROLL_STEPS}.2.alt.0.steps.0`]);

  const sentence = refusedSentence(state, { op: 'addStep', scenarioId: 'enroll', containerPath: [2, 'alt', 0], index: 0, step: NEW_STEP });

  assert.equal(sentence, lockedSentence(`step 3 of ${SCENARIO}`), 'the step of the scenario that holds the locked branch');
});

test('a refused addStep under a lock of a scenario\'s whole step list names the steps of its scenario', () => {
  const state = editor([ENROLL_STEPS]);

  const sentence = refusedSentence(state, { op: 'addStep', scenarioId: 'enroll', containerPath: [], index: 3, step: NEW_STEP });

  assert.equal(sentence, lockedSentence(`the steps of ${SCENARIO}`));
});

test('a step that a wildcard lock covers before it exists is named as a part of the scenario\'s steps, not by a number', () => {
  const state = editor(['scenarios.*.steps.*']);

  const sentence = refusedSentence(state, { op: 'addStep', scenarioId: 'enroll', containerPath: [], index: 3, step: NEW_STEP });

  assert.equal(sentence, lockedSentence(`the steps of ${SCENARIO}`), 'step 4 is not given by the task: it is the one being added');
});

test('a refused setUmlLayout names the positions in this view', () => {
  const state = editor(['layout'], 'code of policy');

  const sentence = refusedSentence(state, { op: 'setUmlLayout', viewKey: 'code of policy', positions: { EnrollmentPolicy: [40, 40] } });

  assert.equal(sentence, lockedSentence('the positions in this view'));
});

test('a refused lifeline order names the lifeline order in this view', () => {
  const state = editor(['layout.dynamic enroll'], 'dynamic enroll');

  const sentence = refusedSentence(state, { op: 'setUmlLayout', viewKey: 'dynamic enroll', lifelines: ['policy', 'coordinator'] });

  assert.equal(sentence, lockedSentence('the lifeline order in this view'));
});

test('a locked layout of a view that is not open is not called this view', () => {
  const state = editor(['layout'], 'code of policy');

  const sentence = refusedSentence(state, { op: 'setUmlLayout', viewKey: 'deployment production', positions: { laptop: [10, 10] } });

  assert.equal(sentence, lockedSentence(null));
});

test('a refused setNodeLink names the link', () => {
  const state = editor([`${CAMPUS}.ingress.collaborators.api-pod`], 'deployment production');

  const sentence = refusedSentence(state, {
    op: 'setNodeLink', environmentId: 'production', nodeId: 'ingress', targetNodeId: 'api-pod', description: 'routes HTTPS requests to', replace: true,
  });

  assert.equal(sentence, lockedSentence('the link from Ingress load balancer to API pod'));
});

test('a refused updateNode names the node', () => {
  const state = editor([`${CAMPUS}.api-pod.technology`], 'deployment production');

  const sentence = refusedSentence(state, { op: 'updateNode', environmentId: 'production', nodeId: 'api-pod', field: 'technology', value: 'Docker 27' });

  assert.equal(sentence, lockedSentence('node API pod'));
});
