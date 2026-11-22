(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'));
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.actionsShared = factory(root.ArchUMLC4);
  }
})(typeof self !== 'undefined' ? self : this, function (C4) {
  'use strict';

  // The DOM-free part of the shared commands (c4-editor-actions.js and its units): the element types and their levels,
  // the relationship fields, the rules a relationship's end or move must keep (spec §4.6, §9.2), the placeholder names
  // of new things, and the texts that name elements and relationships in announcements, menus, and labels (with the
  // model-wide wording of the UML views' canvases). Nothing here reads the editor's state.

  const PARENT_TYPE = { container: 'system', component: 'container', code: 'component' };
  const CHILD_VIEW = { system: 'containers', container: 'components', component: 'code' };
  const TYPE_NAMES = { person: 'person', system: 'software system', container: 'container', component: 'component', code: 'code element' };
  const DEFAULT_CONNECTOR = 'call';
  const RELATIONSHIP_FIELDS = ['description', 'technology', 'connector'];
  // Relationship diagnostics whose subject is the technology; the others concern the description (spec §9.2).
  const TECHNOLOGY_RULES = new Set(['c4/cross-container-technology', 'c4/technology-tbd']);
  // The names a code element is added with, by its kind (UML-view editing spec §5.1).
  const CODE_PLACEHOLDERS = {
    class: 'New class', abstract_class: 'New abstract class', interface: 'New interface', enum: 'New enum',
    function: 'New function', module: 'New module',
  };

  /**
   * The name a new thing carries until its first rename (UML-view editing spec §5.1): a code element by its kind ("New
   * class"; one without a known kind reads as a class, as the model reads it), "New node" or, of kind `infrastructure`,
   * "New infrastructure node" for a deployment node (`type: 'node'`), "New interface" for a provided interface
   * (`type: 'interface'`), and "New <type>" for the other element types.
   */
  function placeholderName(type, kind = null) {
    if (type === 'code') return CODE_PLACEHOLDERS[kind] || CODE_PLACEHOLDERS.class;
    if (type === 'node') return kind === 'infrastructure' ? 'New infrastructure node' : 'New node';
    if (type === 'interface') return 'New interface';
    return `New ${TYPE_NAMES[type]}`;
  }

  /**
   * The words of a shared action's result whose edit reaches beyond the open view (the option `wording: 'model-wide'`,
   * UML-view editing spec §5.1): for each result its announcement (`message`) and the label of its undo step (`label`).
   * Planners and tests call these instead of repeating the words; without the option the actions keep today's.
   */
  const modelWideWording = Object.freeze({
    /** A rename; `newId` is the id the first rename gave the thing, or null when it kept its id. */
    rename: (oldName, newName, newId = null) => ({
      message: `Renamed ${oldName} to ${newName} everywhere in the model${newId === null ? '' : `; its id is now ${newId}`}.`,
      label: `Rename ${oldName} everywhere in the model`,
    }),
    /** An element deleted with `referenceCount` references to it. */
    elementDeletion: (name, referenceCount) => ({
      message: `Deleted ${name}${referenceCount === 0 ? '' : ` and ${plural(referenceCount, 'reference')} to it`} everywhere in the model.`,
      label: `Delete ${name} everywhere in the model`,
    }),
    /** A relationship deleted; `phrase` names it as relationshipPhrase does. */
    relationshipDeletion: (phrase) => ({
      message: `Deleted ${phrase} everywhere in the model.`,
      label: `Delete ${phrase} everywhere in the model`,
    }),
    /** A relationship added from `source` to `target`, read aloud as sentence() reads it. */
    relationshipAddition: (source, description, target, technology) => ({
      message: `Added: ${sentence(source, description, target, technology)}. It is added to the model and appears in the C4 views of both elements.`,
      label: `Add to the model a relationship from ${source} to ${target}`,
    }),
  });

  /** "A", "A and B", "A, B, and C". */
  function namesList(names) {
    if (names.length <= 2) return names.join(' and ');
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  }

  function elementName(model, id) {
    const element = model ? model.elements.get(id) : null;
    return element ? element.name || id : id;
  }

  /**
   * For each of `ids` (one menu group), what tells it apart from a candidate with the same name, in parentheses:
   * its type and the element it lies in ("(container in Course Registration)"), and its id when even those are the
   * same. Null for a name no other candidate in the group has (spec §9.2: a menu lists elements by name).
   */
  function namesakeNotes(current, ids) {
    const kindOf = (id) => {
      const element = current.elements.get(id);
      const where = element.parentId === null ? '' : ` in ${elementName(current, element.parentId)}`;
      return `${TYPE_NAMES[element.type]}${where}`;
    };
    return new Map(ids.map((id) => {
      const namesakes = ids.filter((other) => elementName(current, other) === elementName(current, id));
      if (namesakes.length < 2) return [id, null];
      const sameKind = namesakes.filter((other) => kindOf(other) === kindOf(id)).length > 1;
      return [id, `(${kindOf(id)}${sameKind ? `, id ${id}` : ''})`];
    }));
  }

  function isAncestor(model, ancestorId, id) {
    for (let element = model.elements.get(id); element && element.parentId !== null; element = model.elements.get(element.parentId)) {
      if (element.parentId === ancestorId) return true;
    }
    return false;
  }

  function areNested(model, a, b) {
    return isAncestor(model, a, b) || isAncestor(model, b, a);
  }

  /** Every element id in the model's order, with the direct children of `id` first. */
  function childrenFirst(model, id) {
    const children = model.elements.get(id).childIds;
    return children.concat([...model.elements.keys()].filter((candidate) => !children.includes(candidate)));
  }

  function startsWith(path, prefix) {
    return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
  }

  /** The relationship written at `path`, or the first one inside it (a collaborator key that holds a list). */
  function relationshipAtPath(model, path) {
    return model.relationships.find((relationship) => startsWith(relationship.path, path) && relationship.path.length === path.length)
      || model.relationships.find((relationship) => startsWith(relationship.path, path)) || null;
  }

  /** The field a relationship diagnostic belongs beside, or null for one this form has no field for. */
  function diagnosticField(diagnostic, relationship) {
    const next = diagnostic.path[relationship.path.length];
    if (next !== undefined) return RELATIONSHIP_FIELDS.includes(next) ? next : null;
    return TECHNOLOGY_RULES.has(diagnostic.rule) ? 'technology' : 'description';
  }

  /**
   * Why no relationship can join `sourceId` → `targetId` at all (an unknown element, a self-loop, or an element and
   * what it contains), as `{ code, message }`, or null.
   */
  function endsProblem(model, sourceId, targetId) {
    const [source, target] = [elementName(model, sourceId), elementName(model, targetId)];
    if (!model.elements.has(sourceId) || !model.elements.has(targetId)) {
      return { code: 'unknown-element', message: `Error: There is no element ${model.elements.has(sourceId) ? targetId : sourceId}.` };
    }
    if (sourceId === targetId) {
      return { code: 'self-loop', message: `Error: A relationship cannot point ${source} at itself; choose another element.` };
    }
    if (areNested(model, sourceId, targetId)) {
      const [outer, inner] = isAncestor(model, sourceId, targetId) ? [source, target] : [target, source];
      return { code: 'containment',
        message: `Error: ${outer} contains ${inner}, and a relationship never connects an element with what is inside it.` };
    }
    return null;
  }

  /** Why a relationship cannot move to the ends `sourceId` → `targetId`, as `{ code, message }`, or null. */
  function relationshipMoveProblem(model, relationship, sourceId, targetId) {
    const problem = endsProblem(model, sourceId, targetId);
    if (problem) return problem;
    const [source, target] = [elementName(model, sourceId), elementName(model, targetId)];
    const declared = model.relationships.find((candidate) => candidate.sourceId === sourceId && candidate.targetId === targetId);
    if (declared && declared.id !== relationship.id) {
      const named = declared.description === null ? 'one without a description' : `'${declared.description}'`;
      return { code: 'duplicate', message: `Error: ${source} already has a relationship to ${target}: ${named}. `
        + 'Moving this one there would duplicate it; edit that one instead.' };
    }
    return null;
  }

  /**
   * The commands that move a relationship, as one batch: remove it, add it between the new ends, then restore its
   * requested responsibility, choices, and uses on the new relationship (whose id a dry run gives, Ruling 14). This
   * is the fallback of Ruling 18 until the core has `moveRelationship`: the entry is appended at its new place, its
   * comments are not kept, and a relationship without a description cannot move (`addRelationship` refuses it).
   */
  function relationshipMoveBatch(design, relationship, sourceId, targetId) {
    if (relationship.description === null) {
      return { error: 'invalid-description', message: 'Describe the relationship first; moving it keeps the description' };
    }
    const removeAndAdd = [
      { op: 'removeRelationship', relationshipId: relationship.id },
      { op: 'addRelationship', sourceId, targetId, description: relationship.description, technology: relationship.technology,
        connector: relationship.connector },
    ];
    const dryRun = C4.edit(design, { op: 'batch', commands: removeAndAdd });
    if (dryRun.error) return dryRun;
    const movedId = dryRun.selection.relationshipId;
    const restored = [];
    if (relationship.responsibility !== null) {
      restored.push({ op: 'updateRelationship', relationshipId: movedId, responsibility: relationship.responsibility });
    }
    const choices = authoredChoices(relationship.choices);
    if (choices !== null) restored.push({ op: 'setChoices', relationshipId: movedId, choices });
    if (relationship.uses.length > 0) restored.push({ op: 'setUses', relationshipId: movedId, uses: relationship.uses.map((use) => use.text) });
    return { command: { op: 'batch', commands: removeAndAdd.concat(restored) } };
  }

  /** Design choices as the model reads them, without the null fields and empty lists it fills in. */
  function authoredChoices(value) {
    if (Array.isArray(value)) {
      const items = value.map(authoredChoices).filter((item) => item !== null);
      return items.length > 0 ? items : null;
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, item]) => [key, authoredChoices(item)]).filter(([, item]) => item !== null);
      return entries.length > 0 ? Object.fromEntries(entries) : null;
    }
    return value === undefined ? null : value;
  }

  /** The fields of `changes` that differ from the relationship, as `updateRelationship` takes them. */
  function changedFields(relationship, changes) {
    const current = valuesOf(relationship);
    const written = {};
    RELATIONSHIP_FIELDS.forEach((field) => {
      if (!(field in changes)) return;
      const value = changes[field] === null ? '' : String(changes[field]);
      if (value !== current[field]) written[field] = value === '' && field !== 'description' ? null : value;
    });
    return written;
  }

  function valuesOf(relationship) {
    return { description: relationship.description || '', technology: relationship.technology || '',
      connector: relationship.connector || DEFAULT_CONNECTOR };
  }

  /** The read-aloud sentence (spec §9.3): "<Source> <description> <Target> [<technology>]". */
  function sentence(source, description, target, technology) {
    return `${source} ${description || '…'} ${target}${technology ? ` [${technology}]` : ''}`;
  }

  /** "'writes seat holds to'", or "the relationship from A to B" when it has no description. */
  function relationshipTitle(model, relationship) {
    return relationship.description === null
      ? `the relationship from ${elementName(model, relationship.sourceId)} to ${elementName(model, relationship.targetId)}`
      : `'${relationship.description}'`;
  }

  /** "'writes seat holds to' from A to B", or "the relationship from A to B". */
  function relationshipPhrase(model, relationship) {
    const title = relationshipTitle(model, relationship);
    return relationship.description === null ? title
      : `${title} from ${elementName(model, relationship.sourceId)} to ${elementName(model, relationship.targetId)}`;
  }

  function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
  }

  return {
    PARENT_TYPE,
    CHILD_VIEW,
    TYPE_NAMES,
    DEFAULT_CONNECTOR,
    RELATIONSHIP_FIELDS,
    placeholderName,
    modelWideWording,
    namesList,
    elementName,
    namesakeNotes,
    areNested,
    childrenFirst,
    startsWith,
    relationshipAtPath,
    diagnosticField,
    endsProblem,
    relationshipMoveProblem,
    relationshipMoveBatch,
    changedFields,
    valuesOf,
    sentence,
    relationshipTitle,
    relationshipPhrase,
    plural,
  };
});
