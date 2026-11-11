const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = {
  document: { readyState: 'loading', addEventListener() {}, documentElement: {} },
  MutationObserver: class { observe() {} },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../uml-bundle.js'), 'utf8'), sandbox);
const parse = source => sandbox.UMLSequenceDiagram.parse(source);

for (const message of ['caller -> p : takeTurn()', 'o-> p : takeTurn()', 'p ->o : done()']) {
  test(`an explicit declaration supplies the class after ${message}`, () => {
    const model = parse(`${message}\nparticipant p: Player`);
    assert.equal(model.participants.filter(part => part.id === 'p').length, 1);
    assert.equal(model.participants.find(part => part.id === 'p').label, 'Player');
    assert.equal(model.messages.length, 1);
  });
}

test('a late actor declaration supplies its label and actor kind', () => {
  const model = parse('human -> p : takeTurn()\nactor human: User\nparticipant p: Player');
  const actor = model.participants.find(part => part.id === 'human');
  assert.equal(actor.label, 'User');
  assert.equal(actor.isActor, true);
  assert.deepEqual(Array.from(model.participants, part => part.id), ['human', 'p']);
});

test('late declarations retain lane membership and style without duplicating a lifeline', () => {
  const model = parse('p -> service : request()\nbox "Players"\nparticipant p: Player #yellow\nend box');
  const part = model.participants.find(part => part.id === 'p');
  assert.equal(part.label, 'Player');
  assert.equal(part.box, 0);
  assert.equal(part.highlight, 'yellow');
  assert.equal(model.boxes[0].title, 'Players');
  assert.equal(model.participants.length, 2);
});

test('repeated explicit declarations retain the first identity and can add styling', () => {
  const model = parse('participant p: Player\nparticipant p #yellow\np -> q : next()');
  const part = model.participants.find(part => part.id === 'p');
  assert.equal(part.label, 'Player');
  assert.equal(part.highlight, 'yellow');
  assert.equal(model.participants.filter(item => item.id === 'p').length, 1);
});

test('instance declarations remain typed when instance and class names match', () => {
  for (const declaration of ['participant Player: Player', 'participant Player as Player']) {
    const part = parse(declaration).participants[0];
    assert.equal(part.label, 'Player');
    assert.equal(part.isInstance, true);
  }
  assert.notEqual(parse('participant Player').participants[0].isInstance, true);
});

test('declaration keywords and aliases accept the same casing as the editor', () => {
  const model = parse('PARTICIPANT p AS Player\nACTOR user: User\np -> user : notify()');
  assert.deepEqual(Array.from(model.participants, part => [part.id, part.label]), [['p', 'Player'], ['user', 'User']]);
  assert.equal(model.participants[1].isActor, true);
});

test('anonymous instances keep their declared class after an earlier message', () => {
  const part = parse('caller -> p : next()\nparticipant p as : Player').participants.find(item => item.id === 'p');
  assert.equal(part.label, ': Player');
});

test('object-prototype names are valid lifeline identifiers', () => {
  const model = parse('caller -> __proto__ : next()\nparticipant __proto__: Player');
  assert.equal(model.participants.find(part => part.id === '__proto__').label, 'Player');
  assert.equal(model.messages[0].to, '__proto__');
});

for (const declaration of [
  'participant player: Player #lightblue hatched',
  'participant player : Player',
  'participant player as Player',
  'participant player AS : Player',
  'actor player: Player',
]) {
  test(`inline layout positions belong to the instance in ${declaration}`, () => {
    const extracted = sandbox.UMLShared.extractLayoutMetadata(declaration + ' @pos(240, 100)');
    assert.deepEqual(Object.keys(extracted.layout.positions), ['player']);
    assert.equal(extracted.layout.positions.player.x, 240);
    assert.equal(extracted.layout.positions.player.y, 100);
    const participant = parse(extracted.text).participants[0];
    assert.equal(participant.id, 'player');
    assert.equal(participant.label.replace(/^:\s*/, ''), 'Player');
  });
}

for (const declaration of ['actor "Customer" as customer', 'actor Customer as customer', 'actor "Customer: Shopper" as customer']) {
  test(`shared position extraction keeps use-case aliases in ${declaration}`, () => {
    const extracted = sandbox.UMLShared.extractLayoutMetadata(declaration + ' @pos(240, 100)');
    assert.deepEqual(Object.keys(extracted.layout.positions), ['customer']);
    assert.equal(extracted.layout.positions.customer.x, 240);
    assert.equal(extracted.layout.positions.customer.y, 100);
  });
}
