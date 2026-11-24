(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return { state: require('./c4-editor-state.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.umlRefusals = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // The refusals of the C4 editor's UML-notation views (UML-view editing spec §5.1, §5.6): one row per stable code,
  // with its short reason (one line, for menus, choosers, and the list of unavailable tools), its sentence (shown in
  // the message region and announced), and its offer (one button in the message region). This file owns their words;
  // every other part asks for a verdict by code and fills it from the model. The words were reviewed for alignment
  // with the C4 chapter and both C4 tutorials (CP-4); a change goes through that review and changes
  // js/ArchUML/tests/c4/fixtures/uml-refusals.json with it. Sentences never use an arrow sign, which a screen reader
  // reads as "right arrow", and they speak of "this design model" where the limit is the schema's, not C4's or UML's.
  //
  // A verdict fills each ‹placeholder› of its row with `values[placeholder]`, keyed by the placeholder's own words
  // ('Name', 'view title', 'Node A', 'uses | provides', …). Three keys hold model facts that the words are made from:
  // `type` (an element type id: 'person', 'system', 'container', 'component', 'code'), and for code elements
  // `sourceKind` and `targetKind` (a code kind id: 'class', 'abstract_class', 'interface', 'enum', 'function',
  // 'module') with `relation` ('extends' | 'implements'). An offer is `{ kind, label }`: the host turns its `kind`
  // ('open-view', 'show-relationship', 'show-link', 'declare-relationship', 'add-request', 'add-link') into the action
  // it runs, with the values it filled the verdict from.

  const PLACEHOLDER = /‹([^›]+)›/g;
  const ERROR_WORD = /^Error:\s*/;
  const TYPE_WORDS = { person: 'person', system: 'software system', container: 'container', component: 'component', code: 'code element' };
  const KIND_WORDS = { class: 'a class', abstract_class: 'an abstract class', interface: 'an interface', enum: 'an enum',
    function: 'a function', module: 'a module' };
  const RELATION_VERBS = { extends: 'extend', implements: 'implement' };
  // The kind rule of c4-constraints.js, as the learner reads it.
  const KIND_RULES = {
    extends: 'A class extends a class, and an interface extends an interface.',
    implements: 'A class, an abstract class, or an enum implements an interface.',
  };
  // The kinds the core's kind rule lets implement an interface (c4-constraints.js): for them a realization is the fix.
  const IMPLEMENTING_KINDS = ['class', 'abstract_class', 'enum'];

  const OPEN_VIEW = { kind: 'open-view', label: 'Open ‹view title›' };
  const SHOW_RELATIONSHIP = { kind: 'show-relationship', label: 'Show the relationship' };
  // An offer that would add a relationship opens the relationship form, and only for the expert profile (spec §5.1).
  const DECLARE_RELATIONSHIP = { kind: 'declare-relationship', label: 'Declare a relationship from ‹Sender› to ‹Receiver›…', profiles: ['expert'] };

  // The rows in the order of spec §5.1, with the proposed row link-self after link-ends. `summary` and `sentence` are a
  // text with placeholders, or a function of the verdict's words (see wordsFor); `offer` is an offer, a function, or
  // absent. A null summary means the code has no short reason (it is never listed in a menu).
  const ROWS = [
    { code: 'read-only', summary: 'Read-only', sentence: () => modeSentence('read-only') },
    { code: 'yaml-errors', summary: 'Fix the YAML errors first', sentence: () => modeSentence('yaml-errors') },
    { code: 'locked', summary: 'Given by the task', sentence: (words) => editorParts().state.lockedSentence(words.optional('subject')) },
    { code: 'stale', summary: null, sentence: 'The drawing changed before this edit was applied, so nothing was changed. Try again.' },
    {
      code: 'outside-view', summary: 'Shown from outside ‹Scope›', offer: OPEN_VIEW,
      sentence: '‹Name› is a ‹type› outside ‹Scope›. It is shown here because ‹Scope› works with it. Rename or delete it in ‹view title›.',
    },
    {
      code: 'outside-view/lifted-end', summary: 'Ends inside ‹Box›', offer: OPEN_VIEW,
      sentence: 'This line ends at ‹Deep name›, a ‹type› inside ‹Box›, which this view draws as one box. Move or turn that end in ‹view title›, where ‹Deep name› is drawn.',
    },
    {
      code: 'outside-view/both-ends', summary: 'Both ends are outside ‹Scope›', offer: OPEN_VIEW,
      sentence: '‹A› and ‹B› are both outside ‹Scope›, so a line between them would not appear in this view. Add it in ‹view title›.',
    },
    {
      code: 'not-in-model/note', summary: 'No notes in this design model',
      sentence: 'This design model has no place for notes on a diagram. Write the explanation in the element\'s description.',
    },
    {
      code: 'not-in-model/duplicate', summary: 'One identity per element',
      sentence: 'Duplicating is not available here: every element has one identity in the model. Add a new element and name it.',
    },
    {
      code: 'not-in-model/association', summary: 'Not recorded in this design model',
      sentence: 'This design model records three kinds of line between code elements: extends, implements, and a collaborator, drawn as a dependency. It has no place for a composition, an aggregation, or an association, although UML has them. Draw a dependency and say what ‹Source› asks ‹Target› for.',
    },
    {
      code: 'extends-target', summary: '‹Target› is not a code element',
      sentence: (words) => `${words.fill('‹Source› can extend or implement a code element. ‹Target› is a ‹type›.')} ${words.value('type') === 'component'
        ? 'Its classes and interfaces are in its code view.' : 'Classes belong to the components inside a container.'}`,
      offer: (words) => (words.value('type') === 'component' ? { kind: 'open-view', label: words.fill('Open code of ‹Target›') } : null),
    },
    {
      code: 'extends-kind',
      summary: (words) => `${capitalized(words.kind('sourceKind'))} cannot ${RELATION_VERBS[words.relation()]} ${words.kind('targetKind')}`,
      sentence: (words) => [
        `${words.fill('‹Source›')} is ${words.kind('sourceKind')} and ${words.fill('‹Target›')} is ${words.kind('targetKind')}.`,
        KIND_RULES[words.relation()],
        kindAdvice(words),
      ].filter(Boolean).join(' '),
    },
    {
      code: 'implements-target', summary: 'Only an interface can be implemented',
      sentence: (words) => `${words.fill('‹Target›')} is ${words.kind('targetKind')}. A class implements an interface; to build on a class, draw a generalization.`,
    },
    { code: 'extends-cycle', summary: 'Would make a cycle', sentence: '‹Target› already extends ‹Source›, so ‹Source› cannot extend ‹Target›.' },
    {
      code: 'derived/keyword', summary: 'Shows the element\'s kind',
      sentence: 'The keyword shows the kind of this code element. Change its kind in the inspector.',
    },
    {
      code: 'derived/function-operation', summary: 'Drawn from the function\'s name',
      sentence: 'A function is drawn with one operation, its own call. Edit the line to give it a signature; to remove it, change the element\'s kind.',
    },
    {
      code: 'step/not-available', summary: 'No step possible here',
      sentence: 'A step runs along a relationship the design has, or answers an earlier request in this scenario. A step from ‹Sender› to ‹Receiver› does neither at this place.',
    },
    {
      code: 'step/no-relationship', summary: 'No relationship from ‹Sender›', offer: DECLARE_RELATIONSHIP,
      sentence: '‹Sender› has no relationship to ‹Receiver›, and no earlier step asks ‹Sender› for something it could answer. A scenario uses the collaborations the design has: ‹Sender› can answer an element that asked it earlier, or the message can go through an element that already works with ‹Receiver›.',
    },
    {
      code: 'step/reply-without-request', summary: 'No request to answer yet',
      offer: { kind: 'add-request', label: 'Add the request from ‹Receiver› to ‹Sender› first…' },
      sentence: '‹Sender› can reply to ‹Receiver› only after an unanswered step from ‹Receiver› to ‹Sender›, earlier in this scenario or branch. A reply travels back along the request\'s relationship and needs none of its own.',
    },
    {
      code: 'step/asynchronous-no-reply', summary: 'No reply to an asynchronous message', offer: DECLARE_RELATIONSHIP,
      sentence: 'The relationship from ‹Receiver› to ‹Sender› is asynchronous: ‹Receiver› does not wait, so no reply travels back along it. If ‹Sender› must tell ‹Receiver› something, that is a collaboration of its own.',
    },
    {
      code: 'step/nested-ends', summary: 'One is inside the other',
      sentence: '‹Child› is inside ‹Parent›. A step runs between two elements that are not inside each other.',
    },
    {
      code: 'step/same-element', summary: 'A step needs two elements',
      sentence: 'A step runs between two elements. What ‹Name› does on its own belongs in its responsibilities.',
    },
    {
      code: 'not-in-model/lifeline', summary: 'Lifelines come from steps',
      sentence: 'A lifeline appears when a step uses its element. Choose Message, then the sender, then the receiver; Another element… lists the elements a step can reach from the sender.',
    },
    {
      code: 'not-in-model/sequence-detail', summary: 'Not recorded in a scenario',
      sentence: 'Activation bars, create and destroy marks, and lost and found messages have no place in this design model\'s scenarios. A scenario records who asks whom for what, in order.',
    },
    {
      code: 'not-in-model/fragment', summary: 'Not one of the five fragments',
      sentence: 'A scenario in this design model has five fragments: alt, opt, loop, par, and break.',
    },
    {
      code: 'single-branch', summary: '‹operator› has one branch',
      sentence: '‹operator› has one branch. Use alt for alternatives or par for branches that run at the same time.',
    },
    {
      code: 'last-branch', summary: 'A fragment keeps one branch',
      sentence: 'This is the fragment\'s only branch. Delete the fragment, or unwrap it to keep its steps.',
    },
    { code: 'fragment-into-itself', summary: 'Cannot go inside itself', sentence: 'A fragment cannot be moved into one of its own branches.' },
    {
      code: 'derived/arrow', summary: 'Follows the model',
      sentence: 'The arrow follows the model: solid for a call, dashed for a reply, an open arrowhead for a message, event, or stream. To change it, change the connector of the relationship this step runs along, or the step\'s direction.',
    },
    { code: 'derived/box', summary: 'Follows the model', sentence: 'This box shows that these lifelines belong to ‹Name›. It follows the model.' },
    {
      code: 'not-in-model/artifact', summary: 'Host a container or system instead',
      sentence: 'A deployment view of this design model shows which containers and software systems run on which nodes. It has no place for artifacts; host a container or a system on the node.',
    },
    {
      code: 'infrastructure-leaf', summary: 'Infrastructure hosts nothing',
      sentence: '‹Node› is infrastructure, such as a load balancer: it hosts nothing and holds no nodes.',
    },
    { code: 'node-into-itself', summary: 'Cannot go inside itself', sentence: '‹Node› cannot be moved into itself or into a node inside it.' },
    { code: 'already-hosted', summary: 'Already runs there', sentence: '‹Node› already hosts ‹Element›.' },
    {
      code: 'derived/path', summary: 'Drawn from a relationship', offer: SHOW_RELATIONSHIP,
      sentence: 'This path is drawn from the relationship from ‹Source› to ‹Target› (‹description›), because both run on these nodes. Change that relationship, or add a link between the two nodes.',
    },
    {
      code: 'link-ends', summary: 'A link joins two nodes',
      sentence: 'A link joins two nodes. To show that two elements talk, add a relationship between them.',
    },
    {
      code: 'link-self', summary: 'A node cannot link to itself',
      sentence: 'A link joins two different nodes. What runs inside ‹Node› is shown by what it hosts and by the nodes inside it.',
    },
    {
      code: 'link-exists', summary: 'These nodes are already linked', offer: { kind: 'show-link', label: 'Show the link' },
      sentence: '‹Node A› already has a link to ‹Node B›. Edit that link.',
    },
    {
      code: 'same-element-instances', summary: 'Both are instances of ‹Element›', offer: { kind: 'add-link', label: 'Add a link from ‹Node A› to ‹Node B›…' },
      sentence: 'Both boxes are instances of ‹Element›, running on two nodes. To show that the instances talk to each other, add a link between ‹Node A› and ‹Node B›.',
    },
    {
      code: 'layout/inside-node', summary: 'Laid out inside ‹Parent›',
      sentence: '‹Name› is inside ‹Parent›, and what is inside a node is laid out for you. Move ‹Parent›, or use Move to… to put ‹Name› somewhere else.',
    },
    {
      code: 'not-in-model/port', summary: 'Offer or use an interface instead',
      sentence: 'This design model has no ports. An element offers an interface (a ball) and uses one (a socket).',
    },
    {
      code: 'interfaces/add-element', summary: 'Elements appear through interfaces',
      sentence: 'This view shows ‹Scope› and the elements that share an interface with it. Add elements in a context, container, or component view; they appear here once they use or provide an interface.',
    },
    {
      // ‹Interface› names the interface renamed or removed; an addition on a neighbour has none yet (spec §5.5).
      code: 'interfaces/declared-elsewhere', summary: 'Declared on ‹Owner›', offer: { kind: 'open-view', label: 'Open interfaces of ‹Owner›' },
      sentence: (words) => words.fill(words.optional('Interface') === null
        ? 'Each element declares its own interfaces. Add one to ‹Owner› in the interfaces view of ‹Owner›.'
        : '‹Interface› is declared on ‹Owner›. Rename or remove it in the interfaces view of ‹Owner›.'),
    },
    {
      code: 'interfaces/neighbour', summary: 'Here because of an interface',
      sentence: '‹Name› appears here because it ‹uses | provides› ‹Interface›. Delete that use, or delete the element in a context, container, or component view.',
    },
    {
      code: 'interfaces/assembly-ends', summary: 'Delete it and draw the new one',
      sentence: 'A line joins one use to one interface. To change it, delete this use and draw the new one.',
    },
    {
      code: 'interfaces/assembly-direction', summary: 'The provider keeps the ball',
      sentence: 'The ball is on the side of the element that provides ‹Interface›. To turn the line around, describe an interface on ‹Consumer› and let ‹Provider› use it.',
    },
    {
      code: 'derived/assembly-label', summary: 'Lists the operations used', offer: SHOW_RELATIONSHIP,
      sentence: 'The label lists the operations ‹Consumer› uses. Change them under Uses in the relationship.',
    },
    {
      code: 'layout/assembly', summary: 'Routed for you',
      sentence: 'The line between a ball and its socket is routed for you, so the two stay joined. Move the elements to change it.',
    },
    {
      code: 'layout/port', summary: 'Placed for you',
      sentence: 'A ball or socket is placed for you, on the side of its element that faces the other end. Move the elements to turn it.',
    },
    {
      code: 'layout/inheritance-line', summary: 'Routed for you',
      sentence: 'Generalization and realization lines are drawn as one tree for each parent, so they are routed for you. Move the elements to change them.',
    },
    {
      code: 'layout/parallel-lines', summary: 'Routed for you',
      sentence: 'Two lines of this kind join ‹A› and ‹B›, so they are routed for you. Move the elements to change them.',
    },
    { code: 'layout/label', summary: 'Follows its line', sentence: 'Labels follow their lines here. Move a bend, or the elements the line joins.' },
  ];
  const ROW_BY_CODE = new Map(ROWS.map((row) => [row.code, row]));

  // Help (spec §5.6) lists every refusal without a model at hand, so it fills the placeholders with role words: what
  // the name stands for, never a name from some model. A sentence that begins with one is capitalized; HELP_VALUES_BY_CODE
  // gives the facts the words of a few rows are made from, and rewords a role where the general one reads badly.
  const HELP_VALUES = {
    Scope: 'this view\'s component', Name: 'the element', type: 'component', 'view title': 'the view where it belongs',
    Box: 'the box', 'Deep name': 'the real end', A: 'one element', B: 'another', Source: 'the source', Target: 'the target',
    Sender: 'the sender', Receiver: 'the receiver', Child: 'one element', Parent: 'the other', operator: 'an opt, loop, or break fragment',
    Node: 'the node', Element: 'the same element', description: 'its description', 'Node A': 'one node', 'Node B': 'the other node',
    Interface: 'the interface', Owner: 'its owner', 'uses | provides': 'uses or provides', Consumer: 'the consumer', Provider: 'the provider',
  };
  const HELP_VALUES_BY_CODE = {
    'outside-view': { Name: 'a box' },
    'outside-view/lifted-end': { 'view title': 'the view of the box' },
    'extends-kind': { relation: 'extends', sourceKind: 'class', targetKind: 'interface' },
    'implements-target': { targetKind: 'class' },
    'already-hosted': { Element: 'this element' },
    'link-exists': { 'Node B': 'the other' },
    'layout/inside-node': { Name: 'a nested box', Parent: 'its parent node' },
    'interfaces/add-element': { Scope: 'one element' },
  };

  /** Every code of the table, in its order. */
  function codes() {
    return ROWS.map((row) => row.code);
  }

  /** Whether `code` is a row of the table (a core refusal whose code is not passes on with the core's message). */
  function has(code) {
    return ROW_BY_CODE.has(code);
  }

  /**
   * The refusal for `code`, filled from `values` (see the file's head): `{ ok: false, code, summary, message, offer }`.
   * While a tutorial withholds its checks (`checksReleased` false) every step/* code becomes step/not-available, which
   * gives no reason and no offer (spec §5.1), so the values of a step refusal always hold its ends, ‹Sender› and
   * ‹Receiver›. An offer reserved to the expert profile is null for the novice one. Throws a TypeError for a code
   * outside the table or a value its words need and `values` lacks.
   */
  function verdict(code, values = {}, { checksReleased = true, profile = 'expert' } = {}) {
    if (!has(code)) throw new TypeError(`The UML refusal table has no code ${JSON.stringify(code)}`);
    const shownCode = !checksReleased && code.startsWith('step/') ? 'step/not-available' : code;
    const row = ROW_BY_CODE.get(shownCode);
    const words = wordsFor(shownCode, values);
    return {
      ok: false,
      code: shownCode,
      summary: row.summary === null ? null : words.text(row.summary),
      message: words.text(row.sentence),
      offer: offerOf(row, words, profile),
    };
  }

  /**
   * Help's list (spec §5.6): `[{ code, summary, message }]`, one per code in the table's order, each sentence filled
   * with role words (HELP_VALUES) and shown as the message region shows it, without a leading "Error:".
   */
  function helpRows() {
    return ROWS.map((row) => {
      const values = Object.assign({}, HELP_VALUES, HELP_VALUES_BY_CODE[row.code]);
      const shown = verdict(row.code, values);
      return { code: row.code, summary: shown.summary && sentenceCase(shown.summary), message: sentenceCase(shown.message.replace(ERROR_WORD, '')) };
    });
  }

  // ---- Words -----------------------------------------------------------------------------------

  /**
   * The words of one verdict: `fill(template)` fills its placeholders, `text(textOrFunction)` a row's summary or
   * sentence, `value(key)` and `optional(key)` read a value, `kind(key)` gives a code kind with its article, and
   * `relation()` the relation of extends-kind. A value the words need and `values` lacks is a TypeError naming it.
   */
  function wordsFor(code, values) {
    const missing = (what) => new TypeError(`The UML refusal ${code} needs a value for ${what}`);
    const words = {
      value(key) {
        if (typeof values[key] !== 'string') throw missing(`‹${key}›`);
        return values[key];
      },
      optional: (key) => (typeof values[key] === 'string' ? values[key] : null),
      fill: (template) => template.replace(PLACEHOLDER, (whole, key) => {
        if (key !== 'type') return words.value(key);
        if (!TYPE_WORDS[values.type]) throw missing('‹type› (an element type id)');
        return TYPE_WORDS[values.type];
      }),
      text: (textOrFunction) => (typeof textOrFunction === 'function' ? textOrFunction(words) : words.fill(textOrFunction)),
      kind(key) {
        if (!KIND_WORDS[values[key]]) throw missing(`${key} (a code kind id)`);
        return KIND_WORDS[values[key]];
      },
      relation() {
        if (!RELATION_VERBS[values.relation]) throw missing('relation (extends or implements)');
        return values.relation;
      },
    };
    return words;
  }

  /** The advice that ends an extends-kind sentence when the other relation is what the learner wants, or null. */
  function kindAdvice(words) {
    const [relation, source, target] = [words.relation(), words.value('sourceKind'), words.value('targetKind')];
    if (relation === 'extends' && target === 'interface' && IMPLEMENTING_KINDS.includes(source)) return 'To promise an interface\'s operations, draw a realization.';
    if (relation === 'implements' && source === 'interface') return 'To build on an interface, draw a generalization.';
    return null;
  }

  function offerOf(row, words, profile) {
    const offer = typeof row.offer === 'function' ? row.offer(words) : row.offer;
    if (!offer || (offer.profiles && !offer.profiles.includes(profile))) return null;
    return { kind: offer.kind, label: words.fill(offer.label) };
  }

  /** The words of a mode refusal, read from the editor state, which owns them. */
  function modeSentence(reason) {
    return editorParts().state.modeRefusalText(reason);
  }

  function capitalized(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** `text` with the first letter of each sentence capitalized: Help's role words can begin one. */
  function sentenceCase(text) {
    return text.replace(/(^|[.!?] )([a-z])/g, (whole, before, letter) => before + letter.toUpperCase());
  }

  return { codes, has, verdict, helpRows };
});
