'use strict';

// The refusal table of the C4 editor's UML-notation views (UML-view editing spec §5.1, §5.6, plan Task 33):
// js/ArchUML/c4/editor/c4-editor-uml-refusals.js. This file is the one place that pins the words (SC-10): every code's
// short reason, sentence, and offer equal the reviewed table in fixtures/uml-refusals.json, filled with the fixture's
// fixed values. Every other test asserts codes.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./helpers.js');

const EDITOR_DIR = path.join(__dirname, '..', '..', 'c4', 'editor');
const refusals = require(path.join(EDITOR_DIR, 'c4-editor-uml-refusals.js'));
const { createEditorState } = require(path.join(EDITOR_DIR, 'c4-editor-state.js'));

const TABLE = JSON.parse(fixture('uml-refusals.json'));
const FILL = TABLE.fill;
const ARROW_SIGNS = ['→', '←', '->', '-->', '⟶'];
const SHORT_REASON_LIMIT = 60;
const CODE_KINDS = ['class', 'abstract_class', 'interface', 'enum', 'function', 'module'];
const STEP_CODES = TABLE.rows.map((row) => row.code).filter((code) => code.startsWith('step/'));
const DECLARE_OFFER_CODES = TABLE.rows.filter((row) => (row.offerProfiles || []).includes('expert')).map((row) => row.code);

/** The table's text with every ‹placeholder› replaced by its value in `values`. */
function filled(text, values) {
  return text === null ? null : text.replace(/‹([^›]+)›/g, (whole, name) => {
    assert.ok(name in values, `the fixture has a value for ${whole}`);
    return values[name];
  });
}

/** The sentence the editor shows today when its mode refuses an edit (c4-editor-state.js): read-only or YAML errors. */
function existingSentence(code) {
  const modes = { 'read-only': { text: fixture('course-registration.yml'), readOnly: true }, 'yaml-errors': { text: 'schema: [unclosed' } };
  const state = createEditorState(Object.assign({ host: { onTextChange() {} } }, modes[code]));
  return state.refusalText(state.dispatch({ op: 'addElement', parentId: null, type: 'person', name: 'Visitor' }));
}

/** Every verdict the table can give with the fixture's values: one per row, plus each written-out case. */
function everyVerdict(options) {
  return TABLE.rows.flatMap((row) => (TABLE.cases[row.code] || [{ values: FILL }])
    .map(({ values }) => ({ code: row.code, values, verdict: refusals.verdict(row.code, values, options) })));
}

test('codes lists exactly the codes of the reviewed table, in its order, and has answers for each', () => {
  assert.deepEqual(refusals.codes(), TABLE.rows.map((row) => row.code));
  assert.ok(refusals.codes().every((code) => refusals.has(code)));
  assert.equal(refusals.has('model/interface-provider'), false, 'a core refusal outside the table passes on with the core\'s words');
});

test('each code\'s short reason and sentence equal the reviewed table', () => {
  for (const row of TABLE.rows.filter((each) => !TABLE.cases[each.code])) {
    const verdict = refusals.verdict(row.code, FILL);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, row.code);
    assert.equal(verdict.summary, filled(row.summary, FILL), `the short reason of ${row.code}`);
    assert.equal(verdict.message, row.existing ? existingSentence(row.code) : filled(row.sentence, FILL), `the sentence of ${row.code}`);
    assert.equal(verdict.offer && verdict.offer.label, filled(row.offer, FILL), `the offer of ${row.code}`);
  }
});

test('each code whose words depend on the model gives the reviewed words in every case', () => {
  for (const [code, cases] of Object.entries(TABLE.cases)) {
    for (const { values, summary, sentence, offer } of cases) {
      const verdict = refusals.verdict(code, values);
      const which = `${code} with ${JSON.stringify(values)}`;
      assert.equal(verdict.code, code);
      assert.equal(verdict.summary, summary, `the short reason of ${which}`);
      assert.equal(verdict.message, sentence, `the sentence of ${which}`);
      assert.equal(verdict.offer && verdict.offer.label, offer, `the offer of ${which}`);
    }
  }
});

test('no sentence contains an arrow sign', () => {
  const texts = everyVerdict({ profile: 'expert' }).flatMap(({ code, verdict }) => [
    [code, verdict.message], [code, verdict.summary], [code, verdict.offer && verdict.offer.label],
  ]).concat(refusals.helpRows().flatMap((row) => [[row.code, row.message], [row.code, row.summary]]));
  for (const [code, text] of texts.filter(([, each]) => each)) {
    const sign = ARROW_SIGNS.find((arrow) => text.includes(arrow));
    assert.equal(sign, undefined, `${code}: "${text}" contains ${sign}, which a screen reader reads as an arrow`);
  }
});

test(`every short reason fills to at most ${SHORT_REASON_LIMIT} characters`, () => {
  const kindPairs = ['extends', 'implements'].flatMap((relation) => CODE_KINDS.flatMap((sourceKind) => CODE_KINDS
    .map((targetKind) => ({ Source: FILL.Source, Target: FILL.Target, relation, sourceKind, targetKind }))));
  const summaries = everyVerdict().map(({ code, verdict }) => [code, verdict.summary])
    .concat(kindPairs.map((values) => ['extends-kind', refusals.verdict('extends-kind', values).summary]))
    .concat(refusals.helpRows().map((row) => [row.code, row.summary]));
  for (const [code, summary] of summaries.filter(([, each]) => each !== null)) {
    assert.ok(summary.length <= SHORT_REASON_LIMIT, `${code}: "${summary}" has ${summary.length} characters`);
    assert.equal(summary.includes('\n'), false, `${code}: a short reason is one line`);
  }
});

test('with checks withheld a step refusal is step/not-available without reason or offer', () => {
  const general = filled(TABLE.rows.find((row) => row.code === 'step/not-available').sentence, FILL);
  for (const code of STEP_CODES) {
    const withheld = refusals.verdict(code, FILL, { checksReleased: false, profile: 'expert' });
    assert.equal(withheld.code, 'step/not-available', code);
    assert.equal(withheld.message, general, `${code} says no more than the general sentence`);
    assert.equal(withheld.offer, null, `${code} offers nothing`);

    assert.equal(refusals.verdict(code, FILL, { checksReleased: true, profile: 'expert' }).code, code, `${code} once the checks are released`);
  }
});

test('the novice profile gets no declare offer', () => {
  for (const code of DECLARE_OFFER_CODES) {
    assert.equal(refusals.verdict(code, FILL, { profile: 'novice' }).offer, null, `${code} for a novice`);
    assert.ok(refusals.verdict(code, FILL, { profile: 'expert' }).offer, `${code} for an expert`);
  }
  assert.deepEqual(DECLARE_OFFER_CODES, ['step/no-relationship', 'step/asynchronous-no-reply']);
  assert.ok(refusals.verdict('step/reply-without-request', FILL, { profile: 'novice' }).offer,
    'adding the request first changes no relationship, so a novice is offered it (spec §14 D2)');
});

test('helpRows lists every code once, in the table\'s order, with its short reason and a sentence that names no placeholder', () => {
  const rows = refusals.helpRows();
  assert.deepEqual(rows.map((row) => row.code), refusals.codes());
  for (const row of rows) {
    const reviewed = TABLE.rows.find((each) => each.code === row.code);
    assert.ok(row.message.length > 0 && !/[‹›]/.test(row.message), `${row.code}: "${row.message}"`);
    assert.equal(/^Error:/.test(row.message), false, `${row.code}: Help shows the sentence as the message region does`);
    if (reviewed.sentence !== null && !/‹/.test(reviewed.sentence)) assert.equal(row.message, reviewed.sentence, row.code);
    if (reviewed.summary !== null && !/‹/.test(reviewed.summary)) assert.equal(row.summary, reviewed.summary, row.code);
  }
});

test('a verdict for a code outside the table, or without a value its words need, is a programming error', () => {
  assert.throws(() => refusals.verdict('model/interface-provider', {}), TypeError);
  assert.throws(() => refusals.verdict('outside-view', { Name: 'Seat Gateway', type: 'component', Scope: 'Enrollment Policy' }),
    (error) => error instanceof TypeError && /‹view title›/.test(error.message));
});
