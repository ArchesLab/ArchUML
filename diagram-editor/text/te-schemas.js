(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.textSchemas) parts.textSchemas = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // The palette of each diagram type the editor draws (UML-view editing spec §3.4 tools, §3.6): its element and relation
  // schemas, each with the ArchUML line it writes, and the words the sequence grammar reads at the start of a line.
  //
  // Moved from the inline script of _includes/uml-editor.html without a changed statement (plan Task 21, spec
  // §3.6); every function reads only its arguments: the text, the diagram type, the operation, and the bundle.

  // ─── Element + relation schemas ───
  // Each element schema: id (palette key), label (visible), glyph (icon), base (default name),
  //   build(id, opts) → ArchUML line, supports flags for the properties panel.
  // Each relation schema: id, label, glyph, op (the connector), supports flags.
  // Note schema is shared across diagrams that support `note as id "text"`.
  var NOTE_SCHEMA = { id: 'note', label: 'Note', glyph: '✎', base: 'N', keyword: 'note', supports: { displayLabel: true }, isNote: true };

  // Words the sequence grammar reads at the start of a line. A lifeline with one
  // of these ids turns its own messages into declarations or fragments.
  var SEQUENCE_KEYWORDS = ['participant', 'actor', 'activate', 'deactivate', 'create', 'destroy', 'note',
    'alt', 'opt', 'loop', 'par', 'break', 'critical', 'ref', 'neg', 'else', 'end'];

  function isSequenceKeyword(type, id) {
    return type === 'sequence' && SEQUENCE_KEYWORDS.indexOf(String(id).toLowerCase()) !== -1;
  }

  var ELEMENT_SCHEMAS = {
    class: [
      { id: 'class',     label: 'Class',     glyph: '▢', base: 'Class',     keyword: 'class',          supports: { stereotype: true, members: true, abstract: true, highlight: true, texture: true } },
      { id: 'abstract',  label: 'Abstract',  glyph: '■', base: 'Abstract',  keyword: 'abstract class', supports: { stereotype: true, members: true, highlight: true, texture: true } },
      { id: 'interface', label: 'Interface', glyph: '○', base: 'IFace',     keyword: 'interface',      supports: { stereotype: true, members: true, highlight: true, texture: true } },
      { id: 'enum',      label: 'Enum',      glyph: '≡', base: 'Enum',      keyword: 'enum',           supports: { stereotype: true, enumValues: true, highlight: true, texture: true } },
      NOTE_SCHEMA
    ],
    sequence: [
      { id: 'actor',       label: 'Actor',       glyph: '☺', base: 'user',   keyword: 'actor',      supports: { displayLabel: true, highlight: true, texture: true } },
      { id: 'participant', label: 'Participant', glyph: '▭', base: 'p',      keyword: 'participant', supports: { displayLabel: true, highlight: true, texture: true } },
      { id: 'activate',    label: 'Activate',    glyph: '▮', base: 'activate', keyword: 'activate', supports: {}, sequenceControl: 'activate' },
      { id: 'deactivate',  label: 'Deactivate',  glyph: '▯', base: 'deactivate', keyword: 'deactivate', supports: {}, sequenceControl: 'deactivate' },
      { id: 'destroy',     label: 'Destroy',     glyph: '×', base: 'destroy', keyword: 'destroy', supports: {}, sequenceControl: 'destroy' },
      { id: 'note-right',  label: 'Note',        glyph: '✎', base: 'note', keyword: 'note', supports: { displayLabel: true }, sequenceNote: 'right' },
      { id: 'alt',   label: 'alt fragment',   glyph: '⌥', base: 'alt',   keyword: 'alt',   supports: {}, sequenceFragment: 'alt' },
      { id: 'opt',   label: 'opt fragment',   glyph: '?', base: 'opt',   keyword: 'opt',   supports: {}, sequenceFragment: 'opt' },
      { id: 'loop',  label: 'loop fragment',  glyph: '↻', base: 'loop',  keyword: 'loop',  supports: {}, sequenceFragment: 'loop' },
      { id: 'par',   label: 'par fragment',   glyph: '∥', base: 'par',   keyword: 'par',   supports: {}, sequenceFragment: 'par' },
      { id: 'break', label: 'break fragment', glyph: '⊗', base: 'break', keyword: 'break', supports: {}, sequenceFragment: 'break' },
      { id: 'critical', label: 'critical fragment', glyph: '!', base: 'critical', keyword: 'critical', supports: {}, sequenceFragment: 'critical' },
      { id: 'ref', label: 'ref fragment', glyph: '↗', base: 'ref', keyword: 'ref', supports: {}, sequenceFragment: 'ref' },
      { id: 'neg', label: 'neg fragment', glyph: '¬', base: 'neg', keyword: 'neg', supports: {}, sequenceFragment: 'neg' }
    ],
    state: [
      { id: 'state',     label: 'State',          glyph: '▢', base: 'State',  keyword: 'state', supports: { stereotype: true, highlight: true, texture: true, subStates: true } },
      { id: 'composite', label: 'Composite',      glyph: '⊞', base: 'Group',  keyword: 'state', supports: { stereotype: true, highlight: true, texture: true, subStates: true }, isComposite: true },
      { id: 'choice',    label: 'Choice <>',      glyph: '⬢', base: 'Choice', keyword: 'state', supports: {}, fixedStereotype: '<<choice>>' },
      { id: 'junction',    label: 'Junction',          glyph: '●', base: 'Junction',    keyword: 'state', supports: {}, fixedStereotype: '<<junction>>' },
      { id: 'history',     label: 'History (H)',       glyph: 'Ⓗ', base: 'History',     keyword: 'state', supports: {}, fixedStereotype: '<<history>>' },
      { id: 'deepHistory', label: 'Deep history (H*)', glyph: 'Ⓗ', base: 'DeepHistory', keyword: 'state', supports: {}, fixedStereotype: '<<deepHistory>>' },
      { id: 'fork',        label: 'Fork',              glyph: '━', base: 'Fork',        keyword: 'state', supports: {}, fixedStereotype: '<<fork>>' },
      { id: 'join',        label: 'Join',              glyph: '━', base: 'Join',        keyword: 'state', supports: {}, fixedStereotype: '<<join>>' },
      { id: 'terminate',   label: 'Terminate ✕',       glyph: '✕', base: 'Terminate',   keyword: 'state', supports: {}, fixedStereotype: '<<terminate>>' },
      { id: 'initial', label: 'Initial ●', glyph: '●', base: '__init', keyword: '',     supports: {}, pseudo: 'initial' },
      { id: 'final',   label: 'Final ◉',   glyph: '◉', base: '__final',keyword: '',     supports: {}, pseudo: 'final' },
      NOTE_SCHEMA
    ],
    component: [
      { id: 'component', label: 'Component', glyph: '▢', base: 'Component', keyword: 'component', supports: { displayLabel: true, stereotype: true, dashed: true, ports: true, highlight: true, texture: true } },
      { id: 'portin',    label: 'Port In',   glyph: '▶', base: 'in',  keyword: 'port',    supports: { displayLabel: true }, isPort: true,      portKind: 'portin' },
      { id: 'portout',   label: 'Port Out',  glyph: '◀', base: 'out', keyword: 'port',    supports: { displayLabel: true }, isPort: true,      portKind: 'portout' },
      { id: 'provide',   label: 'Provided I/F', glyph: '○', base: 'p_iface', keyword: 'provide', supports: { displayLabel: true }, isInterface: true, interfaceKind: 'provide' },
      { id: 'require',   label: 'Required I/F', glyph: '⊃', base: 'r_iface', keyword: 'require', supports: { displayLabel: true }, isInterface: true, interfaceKind: 'require' },
      NOTE_SCHEMA
    ],
    deployment: [
      { id: 'node',      label: 'Node',      glyph: '□', base: 'Node',     keyword: 'node',      supports: { displayLabel: true, stereotype: true, highlight: true, texture: true } },
      { id: 'component', label: 'Component', glyph: '▢', base: 'Component',keyword: 'component', supports: { displayLabel: true, stereotype: true, highlight: true, texture: true } },
      { id: 'artifact',  label: 'Artifact',  glyph: '⧉', base: 'Artifact', keyword: 'artifact',  supports: { displayLabel: true, stereotype: true, highlight: true, texture: true } },
      NOTE_SCHEMA
    ],
    usecase: [
      { id: 'actor',     label: 'Actor',           glyph: '☺', base: 'Actor',  keyword: 'actor',     supports: { displayLabel: true, highlight: true } },
      { id: 'usecase',   label: 'Use Case',        glyph: '⬭', base: 'UC',     keyword: 'usecase',   supports: { displayLabel: true, highlight: true } },
      { id: 'system',    label: 'System Boundary', glyph: '⬚', base: 'System', keyword: 'rectangle', supports: { displayLabel: true, system: true } },
      NOTE_SCHEMA
    ],
    activity: [
      { id: 'action',   label: 'Action',          glyph: '▢', base: 'Action', keyword: 'action', supports: { displayLabel: true }, activityAction: true },
      { id: 'initial',  label: 'Initial/Final ◉', glyph: '◉', base: '*',      keyword: '(*)',    supports: {}, activityPseudo: true },
      { id: 'decision', label: 'Decision (if)',   glyph: '⬥', base: 'Cond',   keyword: 'if',     supports: { displayLabel: true }, activityDecision: true },
      { id: 'fork',     label: 'Fork/Join',       glyph: '∥', base: 'Fork',   keyword: 'fork',   supports: {}, activityFork: true },
      { id: 'lane',     label: 'Swimlane',        glyph: '|', base: 'Lane',   keyword: '||',     supports: { displayLabel: true }, activityLane: true },
      NOTE_SCHEMA
    ],
    freeform: [
      { id: 'box',     label: 'Box',       glyph: '▢', base: 'Box',     keyword: 'box', supports: { displayLabel: true, highlight: true, texture: true }, freeformShape: 'rect' },
      { id: 'round',   label: 'Rounded',   glyph: '▢', base: 'Round',   keyword: 'box', supports: { displayLabel: true, highlight: true, texture: true }, freeformShape: 'round' },
      { id: 'pill',    label: 'Pill',      glyph: '▭', base: 'Pill',    keyword: 'box', supports: { displayLabel: true, highlight: true, texture: true }, freeformShape: 'pill' },
      { id: 'circle',  label: 'Circle',    glyph: '○', base: 'Circle',  keyword: 'box', supports: { displayLabel: true, highlight: true, texture: true }, freeformShape: 'circle' },
      { id: 'ellipse', label: 'Ellipse',   glyph: '⬭', base: 'Ellipse', keyword: 'box', supports: { displayLabel: true, highlight: true, texture: true }, freeformShape: 'ellipse' },
      { id: 'hex',     label: 'Hexagon',   glyph: '⬢', base: 'Hex',     keyword: 'box', supports: { displayLabel: true, highlight: true, texture: true }, freeformShape: 'hex' },
      { id: 'noteBox', label: 'Note box',  glyph: '✎', base: 'NoteBox', keyword: 'box', supports: { displayLabel: true, highlight: true, texture: true }, freeformShape: 'note' },
      NOTE_SCHEMA
    ],
    venn: [
      { id: 'set', label: 'Set', glyph: '○', base: 'Set', keyword: 'set', supports: { displayLabel: true, highlight: true } },
      NOTE_SCHEMA
    ],
    gitgraph: [
      { id: 'branch', label: 'Branch', glyph: '⑂', base: 'main', keyword: 'branch', supports: { displayLabel: true }, gitBranch: true },
      { id: 'commit', label: 'Commit', glyph: '●', base: 'C', keyword: 'commit', supports: { displayLabel: true }, gitCommit: true }
    ],
    'folder-tree': [
      { id: 'folder', label: 'Folder', glyph: '▸', base: 'folder', keyword: 'folder', supports: { displayLabel: true }, folderTreeKind: 'folder' },
      { id: 'file', label: 'File', glyph: '□', base: 'file', keyword: 'file', supports: { displayLabel: true }, folderTreeKind: 'file' }
    ],
    crc: [
      { id: 'card', label: 'CRC Card', glyph: '▤', base: 'Card', keyword: 'card', supports: {} }
    ],
    er: [
      { id: 'entity',       label: 'Entity',       glyph: '□', base: 'Entity',     keyword: 'entity',                   supports: { erAttributes: true, highlight: true, texture: true } },
      { id: 'weak',         label: 'Weak Entity',  glyph: '⧈', base: 'Weak',       keyword: 'weak entity',              supports: { erAttributes: true, highlight: true, texture: true } },
      { id: 'relationship', label: 'Relationship', glyph: '◈', base: 'Rel',        keyword: 'relationship',             supports: { erAttributes: true, highlight: true, texture: true } },
      { id: 'idrel',        label: 'ID Relation',  glyph: '⧖', base: 'IDRel',      keyword: 'identifying relationship', supports: { erAttributes: true, highlight: true, texture: true } }
    ]
  };

  var RELATION_SCHEMAS = {
    class: [
      { id: 'gen',       label: 'Generalization', glyph: '─▷', op: '--|>', supports: { label: true } },
      { id: 'real',      label: 'Realization',    glyph: '··▷', op: '..|>', supports: { label: true }, dashed: true },
      { id: 'compose',   label: 'Composition',    glyph: '◆─', op: '*--',  supports: { label: true, multiplicity: true, navigability: true } },
      { id: 'aggregate', label: 'Aggregation',    glyph: '◇─', op: 'o--',  supports: { label: true, multiplicity: true, navigability: true } },
      { id: 'assoc',     label: 'Association',    glyph: '─→', op: '-->',  supports: { label: true, multiplicity: true, navigability: true } },
      { id: 'biassoc',   label: 'Bidirectional',  glyph: '↔', op: '<-->', supports: { label: true, multiplicity: true, navigability: true } },
      { id: 'plain',     label: 'Plain Assoc.',   glyph: '──', op: '--',   supports: { label: true, multiplicity: true, navigability: true } },
      { id: 'depend',    label: 'Dependency',     glyph: '··→', op: '..>',  supports: { label: true, stereotype: true } }
    ],
    sequence: [
      { id: 'sync',   label: 'Synchronous',  glyph: '─→', op: '->',  supports: { label: true }, defaultLabel: 'message()' },
      { id: 'async',  label: 'Asynchronous', glyph: '↠', op: '->>', supports: { label: true }, defaultLabel: 'event()' },
      { id: 'return', label: 'Return',       glyph: '··→', op: '-->', supports: { label: true }, defaultLabel: 'response' },
      { id: 'asyncReply', label: 'Async reply', glyph: '··↠', op: '-->>', supports: { label: true }, defaultLabel: 'reply' },
      { id: 'create', label: 'Create',       glyph: '⊕', op: '-->', supports: { label: true }, defaultLabel: '<<create>>', sequenceCreate: true },
      { id: 'lost',   label: 'Lost',         glyph: '→●', op: '->o', supports: { label: true }, defaultLabel: 'lost', sequenceSingle: 'lost' },
      { id: 'found',  label: 'Found',        glyph: '●→', op: 'o->', supports: { label: true }, defaultLabel: 'found', sequenceSingle: 'found' }
    ],
    state: [
      { id: 'transition', label: 'Transition', glyph: '→', op: '-->', supports: { label: true } }
    ],
    component: [
      { id: 'arrow',  label: 'Connector',  glyph: '─→', op: '-->', supports: { label: true, dashed: true } },
      { id: 'plain',  label: 'Plain Line', glyph: '──', op: '--',  supports: { label: true, dashed: true } },
      { id: 'depend', label: 'Dependency', glyph: '··→', op: '..>', supports: { label: true, dashed: true } }
    ],
    deployment: [
      { id: 'arrow',  label: 'Connector',  glyph: '─→', op: '-->', supports: { label: true, dashed: true } },
      { id: 'plain',  label: 'Plain Line', glyph: '──', op: '--',  supports: { label: true, dashed: true } },
      { id: 'depend', label: 'Dependency', glyph: '··→', op: '..>', supports: { label: true, dashed: true } }
    ],
    usecase: [
      { id: 'plain',   label: 'Association',  glyph: '─', op: '--',  supports: { label: true } },
      { id: 'arrow',   label: 'Directed',     glyph: '→', op: '-->', supports: { label: true } },
      { id: 'include', label: 'include',      glyph: '«', op: '..>', stereotype: '<<include>>' },
      { id: 'extend',  label: 'extend',       glyph: '«', op: '..>', stereotype: '<<extend>>' },
      { id: 'gen',     label: 'Generalize',   glyph: '▷', op: '--|>' }
    ],
    activity: [
      { id: 'flow', label: 'Flow', glyph: '→', op: '-->', supports: { label: true } }
    ],
    freeform: [
      { id: 'arrow', label: 'Arrow',          glyph: '→',  op: '-->',  supports: { label: true } },
      { id: 'back',  label: 'Reverse Arrow',  glyph: '←',  op: '<--',  supports: { label: true } },
      { id: 'both',  label: 'Two-way Arrow',  glyph: '↔',  op: '<->',  supports: { label: true } },
      { id: 'plain', label: 'Plain Line',     glyph: '─',  op: '--',   supports: { label: true } },
      { id: 'dash',  label: 'Dashed Arrow',   glyph: '··→', op: '..>', supports: { label: true } },
      { id: 'thick', label: 'Thick Arrow',    glyph: '⇒',  op: '==>',  supports: { label: true } }
    ],
    er: [
      { id: 'plain', label: 'Connection',     glyph: '─', op: '--', supports: { erCardinality: true } },
      { id: 'total', label: 'Total Particip.', glyph: '═', op: '==', supports: { erCardinality: true } }
    ]
  };

  function diagramSupportsAnchoredNotes(type) {
    return /^(class|state|component|deployment|usecase|activity|freeform|venn)$/.test(String(type || ''));
  }

  function elementSchemasFor(type) { return ELEMENT_SCHEMAS[type] || []; }

  function relationSchemasFor(type) { return RELATION_SCHEMAS[type] || []; }

  function findElementSchema(type, id) {
    return (elementSchemasFor(type) || []).find(function (s) { return s.id === id; }) || null;
  }

  function findRelationSchema(type, id) {
    return (relationSchemasFor(type) || []).find(function (s) { return s.id === id; }) || null;
  }

  function defaultElementLabelForPlacement(type, spec, id) {
    if (type === 'sequence' && spec) {
      if (spec.id === 'actor' || spec.keyword === 'actor') return 'Actor';
      if (spec.id === 'participant' || spec.keyword === 'participant') return 'Participant';
    }
    return id;
  }

  /** The palette of diagram type `type` (spec §3.4, tools): its element and relation tools. */
  function toolsFor(type) {
    return { elements: elementSchemasFor(type).slice(), relations: relationSchemasFor(type).slice(), unavailable: [] };
  }

  // What a state's `<<kind>>` makes it. '' is an ordinary state, which may
  // carry any other stereotype. Aliases are the spellings the renderer accepts.
  var STATE_KINDS = [
    { value: '', label: 'State' },
    { value: 'choice', label: 'Choice' },
    { value: 'junction', label: 'Junction' },
    { value: 'history', label: 'Shallow history (H)', aliases: ['shallowhistory'] },
    { value: 'deepHistory', label: 'Deep history (H*)', aliases: ['history*'] },
    { value: 'fork', label: 'Fork' },
    { value: 'join', label: 'Join' },
    { value: 'terminate', label: 'Terminate' }
  ];

  function stateKindForStereotype(stereotype) {
    var name = String(stereotype || '').replace(/^<<\s*|\s*>>$/g, '').toLowerCase();
    var kind = STATE_KINDS.find(function (candidate) {
      return candidate.value && (candidate.value.toLowerCase() === name || (candidate.aliases || []).indexOf(name) !== -1);
    });
    return kind ? kind.value : '';
  }

  // Whether the editor can add elements to a diagram of `type` (it has a palette). Moved from the top level of the
  // inline script of _includes/uml-editor.html by plan Task 24, without a changed statement.
  function diagramSupportsCreation(type) {
    return Object.prototype.hasOwnProperty.call(ELEMENT_SCHEMAS, type);
  }

  return {
    STATE_KINDS: STATE_KINDS,
    stateKindForStereotype: stateKindForStereotype,
    isSequenceKeyword: isSequenceKeyword,
    diagramSupportsCreation: diagramSupportsCreation,
    diagramSupportsAnchoredNotes: diagramSupportsAnchoredNotes,
    findElementSchema: findElementSchema,
    findRelationSchema: findRelationSchema,
    defaultElementLabelForPlacement: defaultElementLabelForPlacement,
    elementSchemasFor: elementSchemasFor,
    relationSchemasFor: relationSchemasFor,
    toolsFor: toolsFor,
    ELEMENT_SCHEMAS: ELEMENT_SCHEMAS
  };
});
