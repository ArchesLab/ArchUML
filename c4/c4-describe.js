(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.describe = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Brief and verbose text descriptions of a projected view (spec §6.5). Absences are stated neutrally and
  // rules are never named, so a find-the-flaw figure stays equivalent for readers of the text.

  const VIEW_TITLE_PREFIX = /^(System context view|Container view|Component view|Code view|Dynamic view|Deployment view|Interface view): /;

  // Brief order: the nested elements first, then who and what surrounds them.
  const BRIEF_CATEGORIES = [
    { singular: 'code element', plural: 'code elements', has: (node) => node.type === 'code' },
    { singular: 'component', plural: 'components', has: (node) => node.type === 'component' },
    { singular: 'container', plural: 'containers', has: (node) => node.type === 'container' },
    { singular: 'software system', plural: 'software systems', has: (node) => node.type === 'system' && !node.external },
    { singular: 'person', plural: 'people', has: (node) => node.type === 'person' },
    { singular: 'external system', plural: 'external systems', has: (node) => node.type === 'system' && Boolean(node.external) },
  ];

  const ELEMENT_SECTIONS = [
    { type: 'code', heading: 'Code elements' },
    { type: 'component', heading: 'Components' },
    { type: 'container', heading: 'Containers' },
    { type: 'person', heading: 'People' },
    { type: 'system', heading: 'Software systems' },
  ];

  function counted(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  /** The view's title read as a label: "Container view: X" becomes "Container view of X". */
  function viewLabel(view) {
    return view.title.replace(VIEW_TITLE_PREFIX, '$1 of ');
  }

  function briefOf(label, countedParts) {
    return `${label}: ${countedParts.length ? countedParts.join(', ') : 'empty'}.`;
  }

  function section(heading, items) {
    return items.length ? [{ heading, items }] : [];
  }

  // ---- C4 views ----------------------------------------------------------------------------

  /** "Provides A, B (delegated from C)." for an annotated node (spec §6.6 accessible text). */
  function providedSentence(node) {
    const names = node.interfaces.map((entry) => {
      if (entry.delegatedFromName) return `${entry.name} (delegated from ${entry.delegatedFromName})`;
      return entry.declaredOnName ? `${entry.name} (offered through ${entry.declaredOnName})` : entry.name;
    });
    return `Provides ${names.join(', ')}.`;
  }

  function nodeItem(node) {
    const lines = node.lines.concat(node.interfaces.length ? [providedSentence(node)] : []);
    return `${node.name} (${node.typeLabel})${lines.length ? `: ${lines.join(' ')}` : ''}`;
  }

  function interfaceNames(edge) {
    return edge.interfaces.map((entry) => entry.name).join(' and ');
  }

  /** A declared relationship behind an edge, as "A → B". */
  function relationshipName({ sourceName, targetName }) {
    return `${sourceName} → ${targetName}`;
  }

  function absencesOf(edge, source, target) {
    const absent = [];
    if (!edge.description) absent.push('no description');
    if (!edge.technology && source.type === 'container' && target.type === 'container') absent.push('no technology');
    return absent;
  }

  function relationshipItem(edge, endpointById, annotated) {
    const [source, target] = [endpointById.get(edge.sourceId), endpointById.get(edge.targetId)];
    const via = annotated && edge.interfaces.length ? ` via ${interfaceNames(edge)}` : '';
    const stated = edge.description
      ? `${source.name} ${edge.description} ${target.name}${edge.technology ? ` using ${edge.technology}` : ''}${via}`
      : `${source.name} → ${target.name}${via}`;
    const absent = absencesOf(edge, source, target);
    const absence = absent.length ? `${edge.description ? '; ' : ': '}${absent.join(', ')}` : '';
    const derivation = edge.derived ? ` (derived from ${edge.sourceRelationships.map(relationshipName).join(' and ')})` : '';
    return `${stated}${absence}${derivation}.`;
  }

  /** Where an edge can end: a drawn node, or a boundary (a landing on a system whose parts are drawn instead). */
  function endpointsOf(view) {
    const boundaries = view.boundaries.map((boundary) => [boundary.id, { name: boundary.label, type: boundary.kind }]);
    return new Map(boundaries.concat(view.nodes.map((node) => [node.id, node])));
  }

  function describeC4(view) {
    const countedParts = BRIEF_CATEGORIES
      .map((category) => [view.nodes.filter(category.has).length, category])
      .filter(([count]) => count > 0)
      .map(([count, { singular, plural }]) => counted(count, singular, plural));
    if (view.edges.length) countedParts.push(counted(view.edges.length, 'relationship', 'relationships'));
    const endpointById = endpointsOf(view);
    const annotated = view.annotations.includes('interfaces');
    const sections = ELEMENT_SECTIONS.flatMap(({ type, heading }) => section(heading, view.nodes
      .filter((node) => node.type === type).map(nodeItem)));
    return {
      brief: briefOf(viewLabel(view), countedParts),
      sections: sections
        .concat(section('Relationships', view.edges.map((edge) => relationshipItem(edge, endpointById, annotated))))
        .concat(section('Legend', view.legend.map((entry) => entry.label))),
    };
  }

  // ---- UML views ---------------------------------------------------------------------------

  function classItem(entry) {
    const members = entry.attributes.concat(entry.operations);
    return `${entry.name} (${entry.keyword || entry.kind})${members.length ? `: ${members.join('; ')}` : ''}`;
  }

  const RELATION_VERBS = { extends: 'extends', implements: 'implements', dependency: 'depends on' };

  function describeClasses(view) {
    const { classes, relations } = view.uml;
    const nameOf = (id) => classes.find((entry) => entry.id === id).name;
    const items = relations.map((relation) => `${nameOf(relation.sourceId)} ${RELATION_VERBS[relation.type]} ${nameOf(relation.targetId)}`
      + `${relation.label ? ` (${relation.label})` : ''}.`);
    return {
      brief: briefOf(viewLabel(view), [counted(classes.length, 'class', 'classes')]
        .concat(relations.length ? [counted(relations.length, 'relationship', 'relationships')] : [])),
      sections: section('Classes', classes.map(classItem)).concat(section('Relationships', items)),
    };
  }

  const ARROW_NOTES = { reply: ' (reply)', async: ' (asynchronous)', sync: '' };

  function messageLines(items, nameOf, context = '') {
    return items.flatMap((item) => {
      if (item.type === 'fragment') {
        return item.branches.flatMap((branch) => messageLines(branch.items, nameOf, `${context}[${item.operator}: ${branch.guard}] `));
      }
      return [`${context}${nameOf(item.from)} → ${nameOf(item.to)}: ${item.label}${ARROW_NOTES[item.arrow]}.`];
    });
  }

  function describeSequence(view) {
    const { participants, items } = view.uml;
    const names = new Map(participants.map((participant) => [participant.id, participant.name]));
    const lines = messageLines(items, (id) => names.get(id));
    return {
      brief: briefOf(viewLabel(view), [counted(participants.length, 'participant', 'participants'), counted(lines.length, 'message', 'messages')]),
      sections: section('Participants', participants.map((participant) => participant.name)).concat(section('Steps', lines)),
    };
  }

  function deploymentNodeItem(node, nodes) {
    const parent = nodes.find((candidate) => candidate.id === node.parentId);
    const facts = [node.kind, node.technology].filter(Boolean).join(', ');
    const hosting = node.hosted.length ? `; hosts ${node.hosted.map((instance) => instance.name).join(', ')}` : '';
    return `${node.name}${node.instances > 1 ? ` ×${node.instances}` : ''}${facts ? ` (${facts})` : ''}${parent ? `, inside ${parent.name}` : ''}${hosting}`;
  }

  function describeDeployment(view) {
    const { nodes, links } = view.uml;
    const instances = nodes.flatMap((node) => node.hosted);
    const nameOf = (id) => (nodes.find((node) => node.id === id) || instances.find((instance) => instance.instanceId === id)).name;
    const linkItems = links.map((link) => `${nameOf(link.sourceId)} ${link.label} ${nameOf(link.targetId)}`
      + `${link.technology ? ` using ${link.technology}` : ''}${link.async ? ' (asynchronous)' : ''}.`);
    return {
      brief: briefOf(viewLabel(view), [counted(nodes.length, 'node', 'nodes'), counted(instances.length, 'hosted element', 'hosted elements'),
        counted(links.length, 'communication path', 'communication paths')]),
      sections: section('Nodes', nodes.map((node) => deploymentNodeItem(node, nodes))).concat(section('Communication paths', linkItems)),
    };
  }

  const UML_DESCRIBERS = { 'uml-class': describeClasses, 'uml-sequence': describeSequence, 'uml-deployment': describeDeployment };

  // ---- Interface views ---------------------------------------------------------------------------

  // The legend names the subject, not a place: boxes can be moved (UML-view editing spec §6), and a place says nothing to
  // a reader who does not see the layout (WCAG 1.3.3).
  const LEGEND_SENTENCE = (scopeName) => 'Ball: an interface the element provides. Socket: an interface it requires. Ball in socket: '
    + `the consumer uses that interface. The subject of this view is ${scopeName}.`;

  /** An assembly label in parentheses; a label that already starts with one ("(through X)") is not wrapped twice. */
  function parenthesized(label) {
    if (label === null) return '';
    return ` ${label.startsWith('(') ? label : `(${label})`}`;
  }

  function providedItems(scope, components, assemblies, people) {
    const nameOf = new Map(components.map((component) => [component.id, component.name]));
    return scope.provides.map((entry) => {
      const consumers = assemblies.filter((assembly) => assembly.providerId === scope.id && assembly.interfaceId === entry.interfaceId)
        .map((assembly) => `${nameOf.get(assembly.consumerId)}${parenthesized(assembly.label)}`)
        .concat(people.filter((person) => person.interfaceIds.includes(entry.interfaceId)).map((person) => `${person.name} (person)`));
      return consumers.length
        ? `${scope.name} provides ${entry.name}, used by ${consumers.join(' and ')}.`
        : `${scope.name} provides ${entry.name}; no element uses it.`;
    });
  }

  function requiredItems(scope, components, assemblies) {
    const nameOf = new Map(components.map((component) => [component.id, component.name]));
    const interfaceNameOf = new Map(scope.requires.map((entry) => [entry.interfaceId, entry.name]));
    return assemblies.filter((assembly) => assembly.consumerId === scope.id)
      .map((assembly) => `${scope.name} requires ${interfaceNameOf.get(assembly.interfaceId)} from ${nameOf.get(assembly.providerId)}`
        + `${parenthesized(assembly.label)}.`);
  }

  function describeInterfaces(view) {
    const { components, assemblies, people, notes, emptyText } = view.uml;
    const scope = components.find((component) => component.role === 'scope');
    const connected = components.length - 1 + people.length;
    const brief = `${viewLabel(view)}: provides ${counted(scope.provides.length, 'interface', 'interfaces')}, `
      + `requires ${counted(scope.requires.length, 'interface', 'interfaces')}, `
      + `${counted(connected, 'connected element', 'connected elements')}.`;
    const interfaceItems = providedItems(scope, components, assemblies, people).concat(requiredItems(scope, components, assemblies));
    return {
      brief,
      sections: section('Interfaces', interfaceItems)
        .concat(section('Legend', [emptyText || LEGEND_SENTENCE(scope.name)]))
        .concat(section('Notes', notes)),
    };
  }

  // ---- Interface description card ----------------------------------------------------------------

  /** `text` as a sentence: it gains a full stop unless it already ends in one. */
  function sentence(text) {
    return /[.!?]$/.test(text) ? text : `${text}.`;
  }

  function errorSentence({ name, code, when }) {
    return sentence(`${name}${code ? ` (${code})` : ''}: ${when}`);
  }

  function typeUseText(label, use) {
    if (use === null) return [];
    return [`${label}: ${use.typeText || use.typeName}.`];
  }

  function syntacticItem(operation) {
    const head = operation.syntax === null ? operation.id : `${operation.id}: ${operation.syntax}`;
    return [`${head}.`].concat(typeUseText('Input', operation.input), typeUseText('Output', operation.output)).join(' ');
  }

  function operationHead(operation) {
    return operation.syntax === null ? `${operation.id}.` : `${operation.id}: ${operation.syntax}.`;
  }

  function exampleText({ inputText, outputText, note }) {
    return `Input ${inputText} → Output ${outputText}.${note ? ` ${sentence(note)}` : ''}`;
  }

  function realizesText({ kind, text, ownerName }) {
    return `${kind ? `${kind.toUpperCase()} ` : ''}${text} (${ownerName})`;
  }

  function semanticItem(operation) {
    const parts = [operationHead(operation),
      operation.purpose ? `Purpose: ${sentence(operation.purpose)}` : 'Purpose: not stated.'];
    if (operation.sideEffects.length) parts.push(`Side effects: ${operation.sideEffects.map(sentence).join(' ')}`);
    if (operation.restrictions.length) parts.push(`Usage restrictions: ${operation.restrictions.map(sentence).join(' ')}`);
    parts.push(operation.errors.length ? `Errors: ${operation.errors.map(errorSentence).join(' ')}` : 'Errors: none stated.');
    if (operation.examples.length) parts.push(`Examples: ${operation.examples.map(exampleText).join(' ')}`);
    if (operation.realizes.length) parts.push(`Realizes: ${operation.realizes.map(realizesText).join('; ')}.`);
    return parts.join(' ');
  }

  function allOperationsItem({ restrictions, errors }) {
    const parts = ['All operations:'];
    if (restrictions.length) parts.push(`Usage restrictions: ${restrictions.map(sentence).join(' ')}`);
    if (errors.length) parts.push(`Errors: ${errors.map(errorSentence).join(' ')}`);
    return parts.join(' ');
  }

  function semanticItems(card) {
    if (card.shorthand) return ['Semantic view: not described yet.'];
    const hasAll = card.all.restrictions.length > 0 || card.all.errors.length > 0;
    return (hasAll ? [allOperationsItem(card.all)] : []).concat(card.operations.map(semanticItem));
  }

  /** "name: type[, optional][, in the path]; …" with the meanings left out when only the syntax is asked for. */
  function fieldItem(field, syntaxOnly) {
    const head = `${field.name}: ${field.typeText}${field.required ? '' : ', optional'}${field.inPath ? ', in the path' : ''}`;
    const parts = [head];
    if (field.values) {
      const values = field.values.map(({ value, meaning }) => (syntaxOnly || !meaning ? value : `${value} (${meaning})`));
      parts.push(`one of ${values.join(', ')}`);
    }
    if (field.constraints.length) parts.push(`constraints: ${field.constraints.join('; ')}`);
    if (!syntaxOnly) {
      if (field.unit) parts.push(`unit: ${field.unit}`);
      if (field.format) parts.push(`format: ${field.format}`);
      if (field.meaning) parts.push(`meaning: ${field.meaning}`);
      if (field.example !== null) parts.push(`example: ${field.example}`);
    }
    return sentence(parts.join('; '));
  }

  function typeItems(type, syntaxOnly) {
    const heading = `Type ${type.name}${type.description && !syntaxOnly ? `: ${sentence(type.description)}` : '.'}`;
    return [heading].concat(type.fields.map((field) => fieldItem(field, syntaxOnly)));
  }

  function usedByItems(card) {
    const users = card.usedBy.map((user) => `${user.name} (${user.typeLabel}): ${user.operationIds.length ? user.operationIds.join(', ') : 'the whole interface'}.`);
    const handlers = card.handledBy.map((handler) => `Handled inside ${card.provider.name} by ${handler.name} `
      + `(${handler.operationIds.length ? handler.operationIds.join(', ') : 'the whole interface'}).`);
    return users.concat(handlers);
  }

  function errorCount(card) {
    return card.all.errors.length + card.operations.reduce((total, operation) => total + operation.errors.length, 0);
  }

  function cardBrief(view) {
    const { card } = view;
    const counts = [counted(card.operations.length, 'operation', 'operations'), counted(card.types.length, 'type', 'types')];
    if (!card.shorthand) counts.push(counted(errorCount(card), 'error', 'errors'));
    return `Interface description of ${card.name} (${card.typeLabel.split(' · ').join(', ')}), provided by ${card.provider.name}: ${counts.join(', ')}.`;
  }

  function describeCard(view, syntaxOnly) {
    const { card } = view;
    const syntactic = (card.documentFormat ? ['Document format: the types below.'] : []).concat(card.operations.map(syntacticItem));
    const vocabulary = card.vocabulary.map(({ term, meaning, shared }) => sentence(`${term}: ${meaning}${shared ? ' (shared by the whole model)' : ''}`));
    return {
      brief: cardBrief(view),
      sections: section('Syntactic view', syntactic)
        .concat(syntaxOnly ? [] : section('Semantic view', semanticItems(card)))
        .concat(section('Data types', card.types.flatMap((type) => typeItems(type, syntaxOnly))))
        .concat(syntaxOnly ? [] : section('Shared vocabulary', vocabulary))
        .concat(section('Used by', usedByItems(card))),
    };
  }

  // ---- Views that could not be drawn ---------------------------------------------------------

  /** A view whose selector or design could not be read (type null) states its diagnostic, and its line when known. */
  function describeError(view) {
    const [diagnostic] = view.diagnostics;
    const line = diagnostic.range ? ` (line ${diagnostic.range.start.line})` : '';
    return {
      brief: `This view cannot be drawn. ${diagnostic.message}${line}.`,
      sections: section('How to fix it', diagnostic.hint ? [diagnostic.hint] : []),
    };
  }

  /**
   * The accessible text of a projected view: `{ brief, sections: [{ heading, items }] }`. `panels: 'syntax'` leaves
   * the meanings and the absences out of an interface description (spec §6.6 item 7).
   */
  function describe(view, { panels = 'all' } = {}) {
    if (view.type === null) return describeError(view);
    if (view.notation === 'interface-card') return describeCard(view, panels === 'syntax');
    if (view.notation === 'uml-component') return describeInterfaces(view);
    return view.notation === 'c4' ? describeC4(view) : UML_DESCRIBERS[view.notation](view);
  }

  return { describe };
});
