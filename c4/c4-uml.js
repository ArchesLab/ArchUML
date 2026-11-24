(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.uml = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Code, dynamic, deployment, and interfaces views as ArchUML source text (spec §6.3), with `ids`, which maps every
  // alias of the text to the model thing it stands for, and a source map, which says what each line stands for
  // (UML-view editing spec §4.1). Every label that reaches the text goes through escapeLabel, so design text cannot end
  // a block, start a statement, or draw an arrow; no alias is a word the grammar reads at the start of a line.

  const ZERO_WIDTH_SPACE = '\u200B';
  const FULLWIDTH_BRACES = { '{': '\uFF5B', '}': '\uFF5D' };

  /**
   * Makes free text safe inside one ArchUML statement: newlines become spaces; quotes, braces, arrows, and
   * `@` directives are replaced by look-alikes or split by a zero-width space, so they stay readable but inert.
   */
  function escapeLabel(text) {
    return String(text)
      .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
      .replace(/"/g, '\u201D')
      .replace(/[{}]/g, (brace) => FULLWIDTH_BRACES[brace])
      .replace(/([-.])>/g, `$1${ZERO_WIDTH_SPACE}>`)
      .replace(/<([-.])/g, `<${ZERO_WIDTH_SPACE}$1`)
      .replace(/@(?=[A-Za-z])/g, `@${ZERO_WIDTH_SPACE}`);
  }

  /**
   * The words an ArchUML parser reads at the start of a line, per text type, in lower case (UML-view editing spec §4.1).
   * A line that starts with an alias (a message's sender, a relation's source, a link's source) is misread when the alias
   * is one of them: with a participant `loop`, `loop -> api` opens a loop fragment. Read off uml-bundle.js at M3: before
   * any parser runs, `callout` lines are taken out (UMLCallouts.extract); every parser reads `layout` directives and
   * notes; the sequence parser reads boxes and `end box`, participant and actor declarations, fragments with their
   * `else` and `end`, activations, `create`, and `destroy`; the class parser class, interface, enum, and abstract class
   * declarations; the deployment parser node, component, and artifact declarations. The sequence list holds every word
   * of the UML editor's SEQUENCE_KEYWORDS.
   */
  const UML_ALIAS_KEYWORDS = Object.freeze({
    sequence: Object.freeze(['callout', 'layout', 'note', 'box', 'end', 'participant', 'actor', 'alt', 'opt', 'loop', 'par',
      'break', 'critical', 'ref', 'neg', 'else', 'activate', 'deactivate', 'create', 'destroy']),
    class: Object.freeze(['callout', 'layout', 'note', 'class', 'interface', 'enum', 'abstract']),
    deployment: Object.freeze(['callout', 'layout', 'note', 'node', 'component', 'artifact']),
  });

  /**
   * Gives each key a unique identifier made of [A-Za-z0-9_] from `text` (default: the key). An identifier that equals
   * one of `keywords`, compared without case, gains a trailing `_`; a repeated identifier then gains _2, _3, and so on.
   * The first call of `aliasOf` for a key fixes its identifier; `ids()` maps each identifier given so far to its key.
   */
  function aliasing(keywords) {
    const reserved = new Set(keywords);
    const aliasByKey = new Map();
    const keyByAlias = new Map();
    const aliasOf = (key, text = key) => {
      if (!aliasByKey.has(key)) {
        const sanitized = String(text).replace(/[^A-Za-z0-9_]/g, '_');
        const base = reserved.has(sanitized.toLowerCase()) ? `${sanitized}_` : sanitized;
        let alias = base;
        for (let suffix = 2; keyByAlias.has(alias); suffix += 1) alias = `${base}_${suffix}`;
        keyByAlias.set(alias, key);
        aliasByKey.set(key, alias);
      }
      return aliasByKey.get(key);
    };
    return { aliasOf, ids: () => Object.fromEntries(keyByAlias) };
  }

  /** One line of a text and its source-map entry: what the line stands for, or null. */
  const row = (line, entry = null) => ({ line, entry });

  /**
   * `{ type, text, ids, source }` for the rows between `@startuml` and `@enduml`: `source.lines[i]` is the entry of line
   * i of the text, the numbering the renderers stamp (`rel:i`, `seqmsg:i`, `frag:i`); `more` adds fields to `source`.
   * `layoutLines`, ArchUML's layout block, go directly after `@startuml`; the renderers take the block out before they
   * number the lines, so `source.lines` leaves it out too (UML-view editing spec §6).
   */
  function diagram(type, rows, ids, more, layoutLines = []) {
    const all = [row('@startuml')].concat(rows, row('@enduml'));
    const lines = all.map((each) => each.line);
    return {
      type, text: lines.slice(0, 1).concat(layoutLines, lines.slice(1)).join('\n'), ids,
      source: Object.assign({ lines: all.map((each) => each.entry) }, more),
    };
  }

  // ---- Layout block (UML-view editing spec §4.2, §6) ------------------------------------------
  //
  // A view's layout entry reaches the drawing as ArchUML's own layout block: a `node` line per position of a drawn box
  // that can hold one, keyed by its alias, and an `edge` line per route whose line the view draws exactly once, keyed by
  // the line's number (`rel:N`, as the class and deployment renderers stamp it). An entry that names something the view
  // does not draw is left out, which is not an error.

  /** The line number of the one row whose entry `matches`, or null when no row or several rows match. */
  function onlyLine(rows, matches) {
    const lines = rows.flatMap((each, index) => (each.entry && matches(each.entry) ? [index + 1] : [])); // line 0 is @startuml
    return lines.length === 1 ? lines[0] : null;
  }

  /**
   * The layout block of `layout` (null: none), with `aliasOfBox(id)` the alias of a box that can hold a position (null
   * otherwise) and `lineOfRoute(route)` the line number of the one line a route stands for (null otherwise); [] when
   * no line remains.
   */
  function layoutBlock(layout, aliasOfBox, lineOfRoute) {
    if (!layout) return [];
    const nodes = [...layout.positions].flatMap(([id, [x, y]]) => {
      const alias = aliasOfBox(id);
      return alias ? [`node "${alias}" x=${x} y=${y}`] : [];
    });
    const edges = layout.routes.flatMap((route) => {
      const line = lineOfRoute(route);
      return line === null ? [] : [`edge "rel:${line}" points="${route.points.map(([x, y]) => `${x},${y}`).join(' ')}"`];
    });
    const lines = nodes.concat(edges);
    return lines.length ? ['@layout'].concat(lines, ['@endlayout']) : [];
  }

  /** `ids()` turned around: the alias of each model key. */
  function aliasesOf(ids) {
    return new Map(Object.entries(ids).map(([alias, key]) => [key, alias]));
  }

  // ---- Class diagram ------------------------------------------------------------------------

  const CLASS_KEYWORDS = { interface: 'interface', abstract_class: 'abstract class', enum: 'enum' };
  const RELATION_ARROWS = { extends: '--|>', implements: '..|>', dependency: '..>' };
  const RELATION_KINDS = { extends: 'extends', implements: 'implements', dependency: 'collaborator' };

  /** A member line; a leading `{static}` or `{abstract}` modifier keeps its braces. */
  function memberLine(member) {
    const [, head = '', modifier = '', rest] = /^([+\-#~]?\s*)(\{(?:static|abstract)\}\s*)?([\s\S]*)$/.exec(member);
    return `  ${head}${modifier}${escapeLabel(rest)}`;
  }

  /** The member rows of a class, attributes first; a function's own call is its one synthesized operation. */
  function memberRows(entry) {
    const memberRow = (list, synthesized) => (member, index) =>
      row(memberLine(member), { kind: 'member', id: entry.id, list, index, synthesized });
    return entry.attributes.map(memberRow('attributes', false))
      .concat(entry.operations.map(memberRow('operations', entry.synthesizedOperations)));
  }

  function classRows(entry, aliasOf) {
    const keyword = CLASS_KEYWORDS[entry.kind] || 'class';
    const stereotype = entry.keyword ? ` <<${entry.keyword}>>` : '';
    const head = `${keyword} ${aliasOf(entry.id)}${stereotype}`;
    const declaration = { kind: 'element', id: entry.id, lifted: entry.lifted };
    const members = memberRows(entry);
    return members.length ? [row(`${head} {`, declaration)].concat(members, row('}')) : [row(head, declaration)];
  }

  /** A relation row; `from` and `to` are the drawn ends, `modelFrom` and `modelTo` the declared ones. */
  function relationRow(relation, aliasOf) {
    const label = relation.label ? ` : ${escapeLabel(relation.label)}` : '';
    return row(`${aliasOf(relation.sourceId)} ${RELATION_ARROWS[relation.type]} ${aliasOf(relation.targetId)}${label}`, {
      kind: 'relation', relation: RELATION_KINDS[relation.type], from: relation.sourceId, to: relation.targetId,
      modelFrom: relation.modelSourceId, modelTo: relation.modelTargetId, relationshipId: relation.relationshipId,
    });
  }

  function classDiagram({ classes, relations }, layout) {
    // A class is named by its display name, so lifted elements read naturally ("Billing_System").
    const { aliasOf, ids } = aliasing(UML_ALIAS_KEYWORDS.class);
    classes.forEach((entry) => aliasOf(entry.id, entry.name));
    const rows = classes.flatMap((entry) => classRows(entry, aliasOf)).concat(relations.map((relation) => relationRow(relation, aliasOf)));
    // Every drawn box holds a position; a route bends a dependency, the one line the renderer stamps (spec §4.2).
    const aliases = aliasesOf(ids());
    const lineOfRoute = (route) => (route.relation !== 'collaborator' ? null : onlyLine(rows, (entry) =>
      entry.kind === 'relation' && entry.relation === 'collaborator' && entry.from === route.from && entry.to === route.to));
    return diagram('class', rows, ids(), undefined, layoutBlock(layout, (id) => aliases.get(id) || null, lineOfRoute));
  }

  // ---- Sequence diagram ---------------------------------------------------------------------

  const SEQUENCE_ARROWS = { sync: '->', reply: '-->', async: '->>' };

  /** Participants in declaration order, except that those of one box are declared together (boxes do not nest). */
  function participantUnits(participants) {
    const units = [];
    participants.forEach((participant) => {
      const unit = participant.boxId && units.find((candidate) => candidate.boxId === participant.boxId);
      if (unit) unit.members.push(participant);
      else units.push({ boxId: participant.boxId, members: [participant] });
    });
    return units;
  }

  function participantRow(participant, aliasOf) {
    return row(`${participant.kind === 'actor' ? 'actor' : 'participant'} ${aliasOf(participant.id)}: ${escapeLabel(participant.name)}`,
      { kind: 'participant', id: participant.id, boxId: participant.boxId });
  }

  function declarationRows(uml, aliasOf) {
    return participantUnits(uml.participants).flatMap(({ boxId, members }) => {
      const rows = members.map((participant) => participantRow(participant, aliasOf));
      if (!boxId) return rows;
      const box = uml.boxes.find((candidate) => candidate.id === boxId);
      return [row(`box "${escapeLabel(box.label)}"${box.external ? ' <<external>>' : ''}`, { kind: 'box', id: box.id })].concat(rows, row('end box'));
    });
  }

  /** The step position at the end of a branch: after every step the model lists in it, drawn or not. */
  function branchEnd(branch) {
    return { containerPath: branch.containerPath, index: branch.stepCount };
  }

  /**
   * The rows of a fragment: its operator line, an `else` line per further branch, and `end`. An `else` line closes the
   * branch above it, and `end` closes the last branch (`closes`, null for a fragment without branches).
   */
  function fragmentRows(item, aliasOf) {
    const place = { containerPath: item.step.containerPath, index: item.step.index };
    const branchRows = item.branches.flatMap((branch, position) => [position === 0
      ? row(`${item.operator} [${escapeLabel(branch.guard)}]`, Object.assign({ kind: 'fragment', operator: item.operator }, place))
      : row(`else [${escapeLabel(branch.guard)}]`, Object.assign({ kind: 'branch', branch: branch.index,
        closes: branchEnd(item.branches[position - 1]) }, place))]
      .concat(itemRows(branch.items, aliasOf)));
    const last = item.branches[item.branches.length - 1];
    return branchRows.concat(row('end', Object.assign({ kind: 'fragment-end', closes: last ? branchEnd(last) : null }, place)));
  }

  function itemRows(items, aliasOf) {
    return items.flatMap((item) => {
      if (item.type !== 'message') return fragmentRows(item, aliasOf);
      const label = item.label ? `: ${escapeLabel(item.label)}` : '';
      return [row(`${aliasOf(item.from)} ${SEQUENCE_ARROWS[item.arrow]} ${aliasOf(item.to)}${label}`,
        { kind: 'message', containerPath: item.step.containerPath, index: item.step.index, status: item.status })];
    });
  }

  // A dynamic view's head names and message labels are sentences, often 30 characters or more; one line each makes
  // the drawing too wide to print at 9 pt. Wrapped at 120 units (about 16 characters), the course-registration
  // enroll view is 923 units wide, inside the 959 px a printed figure gets of the Letter landscape column; 130
  // widens it to 1006.
  const SEQUENCE_WRAP_WIDTH = 120;

  /** The participants that `lifelines` lists first, in its order, then the others in their own order. */
  function inLifelineOrder(participants, lifelines) {
    const rank = new Map();
    lifelines.forEach((id) => { if (!rank.has(id)) rank.set(id, rank.size); });
    const listed = participants.filter((participant) => rank.has(participant.id))
      .sort((a, b) => rank.get(a.id) - rank.get(b.id));
    return listed.concat(participants.filter((participant) => !rank.has(participant.id)));
  }

  /**
   * The sequence diagram of a scenario; `source.scenarioEnd` is the step position after its last top-level step. A
   * stored lifeline order (spec §4.2) decides the order of the declarations; the lifelines of one box stay together, at
   * the place of its first one. Aliases follow the scenario's own order, so the stored order changes none.
   */
  function sequenceDiagram(uml, layout) {
    const { aliasOf, ids } = aliasing(UML_ALIAS_KEYWORDS.sequence);
    participantUnits(uml.participants).forEach(({ members }) => members.forEach((participant) => aliasOf(participant.id)));
    const declared = { participants: inLifelineOrder(uml.participants, layout ? layout.lifelines : []), boxes: uml.boxes };
    const rows = [row(`layout wrap ${SEQUENCE_WRAP_WIDTH}`)].concat(declarationRows(declared, aliasOf), itemRows(uml.items, aliasOf));
    return diagram('sequence', rows, ids(), { scenarioEnd: { containerPath: [], index: uml.stepCount } });
  }

  // ---- Deployment diagram -------------------------------------------------------------------

  const NODE_STEREOTYPES = { device: 'device', environment: 'executionEnvironment', infrastructure: 'infrastructure' };
  const INSTANCE_STEREOTYPES = { container: 'container', system: 'software system', component: 'component', person: 'person' };

  /** The model key of a hosted instance (spec §4.2): `<element>@<node>`, also for an element hosted once. */
  const instanceKey = (instance) => `${instance.elementId}@${instance.nodeId}`;

  function instanceRow(instance, aliasOf, indent) {
    return row(`${indent}component "${escapeLabel(instance.name)}" as ${aliasOf(instanceKey(instance), instance.instanceId)} <<${INSTANCE_STEREOTYPES[instance.type]}>>`,
      { kind: 'instance', elementId: instance.elementId, nodeId: instance.nodeId });
  }

  function nodeRows(node, nodes, aliasOf, indent) {
    const label = escapeLabel(node.instances > 1 ? `${node.name} ×${node.instances}` : node.name);
    const stereotype = NODE_STEREOTYPES[node.kind] ? ` <<${NODE_STEREOTYPES[node.kind]}>>` : '';
    const head = `${indent}node "${label}" as ${aliasOf(node.id)}${stereotype}`;
    const declaration = { kind: 'node', id: node.id, parentId: node.parentId };
    const inner = node.hosted.map((instance) => instanceRow(instance, aliasOf, `${indent}  `)).concat(nodes
      .filter((child) => child.parentId === node.id).flatMap((child) => nodeRows(child, nodes, aliasOf, `${indent}  `)));
    return inner.length ? [row(`${head} {`, declaration)].concat(inner, row(`${indent}}`)) : [row(head, declaration)];
  }

  /** A link row; its ends are model keys: a node id, or the key of a hosted instance. */
  function linkRow(link, keyOf, aliasOf) {
    const label = [link.label, link.technology && `[${link.technology}]`].filter(Boolean).map(escapeLabel).join(' ');
    const [from, to] = [keyOf.get(link.sourceId), keyOf.get(link.targetId)];
    return row(`${aliasOf(from)} --> ${aliasOf(to)}${link.async ? ' dashed' : ''}${label ? ` : ${label}` : ''}`,
      { kind: 'link', derived: link.derived, from, to, relationshipIds: link.relationshipIds });
  }

  function deploymentDiagram({ nodes, links }, layout) {
    const { aliasOf, ids } = aliasing(UML_ALIAS_KEYWORDS.deployment);
    const keyOf = new Map(nodes.flatMap((node) => [[node.id, node.id]]
      .concat(node.hosted.map((instance) => [instance.instanceId, instanceKey(instance)]))));
    const topLevel = nodes.filter((node) => node.parentId === null);
    const rows = topLevel.flatMap((node) => nodeRows(node, nodes, aliasOf, '')).concat(links.map((link) => linkRow(link, keyOf, aliasOf)));
    // Only a top-level node holds a position: what is inside a node is laid out inside it (spec §4.2). A route bends a
    // link between nodes or a derived path between hosted instances.
    const aliasOfBox = (id) => (topLevel.some((node) => node.id === id) ? aliasOf(id) : null);
    const lineOfRoute = (route) => onlyLine(rows, (entry) => entry.kind === 'link' && entry.derived === (route.relation === 'derived')
      && entry.from === route.from && entry.to === route.to);
    return diagram('deployment', rows, ids(), undefined, layoutBlock(layout, aliasOfBox, lineOfRoute));
  }

  // ---- Component diagram (interfaces of E) ----------------------------------------------------

  const NEWLINES = /\s*[\r\n\u2028\u2029]+\s*/g;
  const ANGLE_LOOKALIKES = { '<': '\u2039', '>': '\u203A' };

  /** Newlines become spaces and the ends are trimmed; nothing else changes (the label is the rest of the line). */
  function foldNewlines(text) {
    return String(text).replace(NEWLINES, ' ').trim();
  }

  /** Free text inside quotes: `"` becomes `'`, braces become parentheses, newlines become spaces. */
  function escapeName(text) {
    return foldNewlines(text).replace(/"/g, "'").replace(/\{/g, '(').replace(/\}/g, ')');
  }

  /** Free text inside `<<…>>`: like a name, and angle brackets become single guillemets. */
  function escapeKeyword(text) {
    return escapeName(text).replace(/[<>]/g, (bracket) => ANGLE_LOOKALIKES[bracket]);
  }

  const LAYOUT_WORDS = { down: 'vertical', right: 'horizontal' };

  /**
   * Gives every port its alias and row, and records which ports each assembly joins: one provide port per assembly (a
   * ball used by two consumers is drawn twice), and one require port per interface a component requires. A ball's
   * entry names the consumer of its assembly (null for a ball nobody uses); a socket's names its own component.
   */
  function portPlan(uml) {
    const counters = { p: 0, r: 0 };
    const ids = {};
    const nextPort = (letter, interfaceId) => {
      counters[letter] += 1;
      const alias = `${letter}${counters[letter]}`;
      ids[alias] = interfaceId;
      return alias;
    };
    const portEntry = (role, interfaceId, elementId, consumerId) => ({ kind: 'port', role, interfaceId, elementId, consumerId });
    const socketOf = new Map();
    const ballOf = new Map();
    const portRows = new Map();
    uml.components.forEach((component) => {
      const rows = [];
      component.provides.forEach(({ interfaceId, name }) => {
        const own = uml.assemblies.filter((assembly) => assembly.providerId === component.id && assembly.interfaceId === interfaceId);
        const balls = own.length ? own : [null];
        balls.forEach((assembly) => {
          const alias = nextPort('p', interfaceId);
          if (assembly) ballOf.set(assembly, alias);
          rows.push(row(`  provide "${escapeName(name)}" as ${alias}`,
            portEntry('provided', interfaceId, component.id, assembly ? assembly.consumerId : null)));
        });
      });
      component.requires.forEach(({ interfaceId, name }) => {
        const alias = nextPort('r', interfaceId);
        uml.assemblies.filter((assembly) => assembly.consumerId === component.id && assembly.interfaceId === interfaceId)
          .forEach((assembly) => socketOf.set(assembly, alias));
        rows.push(row(`  require "${escapeName(name)}" as ${alias}`, portEntry('required', interfaceId, component.id, component.id)));
      });
      portRows.set(component.id, rows);
    });
    return { ids, socketOf, ballOf, portRows };
  }

  function componentRows(component, alias, portRows) {
    const head = `component "${escapeName(component.name)}" as ${alias} <<${escapeKeyword(component.typeLabel)}>>`;
    const declaration = { kind: 'element', id: component.id, role: component.role };
    return portRows.length ? [row(`${head} {`, declaration)].concat(portRows, row('}')) : [row(head, declaration)];
  }

  function connectorRow(assembly, plan) {
    const label = assembly.label === null ? '' : foldNewlines(assembly.label);
    return row(`${plan.ballOf.get(assembly)} --> ${plan.socketOf.get(assembly)}${label ? ` : ${label}` : ''}`,
      { kind: 'assembly', interfaceId: assembly.interfaceId, providerId: assembly.providerId, consumerId: assembly.consumerId });
  }

  /**
   * The component diagram of an interfaces view; its aliases (e1…, p1…, r1…) are numbered, so none is a keyword. Once a
   * drawn box holds a position, the line `layout ports facing` after the direction line turns balls and sockets to
   * face their partners (UML-view editing spec §6); without one the text is as it was.
   */
  function componentDiagram(uml, layout) {
    const plan = portPlan(uml);
    const ids = Object.assign({}, plan.ids);
    const boxAliases = new Map();
    const rows = uml.components.flatMap((component, index) => {
      const alias = `e${index + 1}`;
      ids[alias] = component.id;
      boxAliases.set(component.id, alias);
      return componentRows(component, alias, plan.portRows.get(component.id));
    });
    const connectors = uml.assemblies.filter((assembly) => plan.ballOf.has(assembly) && plan.socketOf.has(assembly))
      .map((assembly) => connectorRow(assembly, plan));
    // A ball or socket and the line between them are placed and routed for the boxes: no route is kept (spec §4.2).
    const block = layoutBlock(layout, (id) => boxAliases.get(id) || null, () => null);
    const facing = block.length ? [row('layout ports facing')] : [];
    return diagram('component', [row(`layout ${LAYOUT_WORDS[uml.direction]}`)].concat(facing, rows, connectors), ids, undefined, block);
  }

  const DIAGRAMS = {
    'uml-class': classDiagram,
    'uml-sequence': sequenceDiagram,
    'uml-deployment': deploymentDiagram,
    'uml-component': componentDiagram,
  };

  /**
   * The ArchUML source of a code, dynamic, deployment, or interfaces view: `{ type, text, ids, source }`. `ids` maps
   * every alias of the text to a model id (an element, interface, or node id) or an instance key `<element>@<node>`;
   * `source.lines` has one entry per line of the text without its layout block: null, or what the line stands for
   * (UML-view editing spec §4.1). Entries share their arrays (container paths, relationship ids) with the view model; both
   * are read-only. The view's layout entry is written into the text (spec §6).
   */
  function toUml(view) {
    const build = DIAGRAMS[view.notation];
    if (!build) throw new Error(`toUml: the ${view.key} view uses ${view.notation} notation, which has no ArchUML text`);
    return build(view.uml, view.layout || null);
  }

  /** A copy of a step position, which the caller may change. */
  const positionCopy = (position) => position && { containerPath: position.containerPath.slice(), index: position.index };

  /**
   * The step position an insertion anchor `{ beforeLine }` of a dynamic view's text stands for (spec §4.1): before a
   * message or fragment line, that item's position; before an `else`, the end of the branch above it; before `end`, the
   * end of the fragment's last branch; before `@enduml`, the end of the scenario. Null before any other line, before
   * which no step can go. Positions count the model's steps, so a step left out of the drawing is counted.
   */
  function positionForAnchor(source, beforeLine) {
    const entry = source.lines[beforeLine];
    if (beforeLine === source.lines.length - 1 && source.scenarioEnd) return positionCopy(source.scenarioEnd);
    if (!entry) return null;
    if (entry.kind === 'message' || entry.kind === 'fragment') return positionCopy(entry);
    if (entry.kind === 'branch' || entry.kind === 'fragment-end') return positionCopy(entry.closes);
    return null;
  }

  return { toUml, positionForAnchor, escapeLabel, UML_ALIAS_KEYWORDS };
});
