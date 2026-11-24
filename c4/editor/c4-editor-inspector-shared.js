(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return { state: require('./c4-editor-state.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorShared = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // The DOM-free part of the inspector (c4-editor-inspector.js and its forms): the element types and the fields each
  // allows, the inspector's shared texts, the splice writer for the edits the core has no command for yet, and the
  // pure helpers every form uses to name, compare, and key what it shows.

  const TYPE_LABELS = { person: 'Person', system: 'Software system', container: 'Container', component: 'Component', code: 'Code element' };
  // The fields each element type allows (spec §4.4; the schema's FIELDS, which the facade does not expose).
  const DESIGN_SLOTS = ['responsibilities', 'owns', 'provides', 'invariants', 'quality', 'choices'];
  const TYPE_FIELDS = {
    person: ['external', 'in_enterprise', 'group'],
    system: ['external', 'in_enterprise', 'group'].concat(DESIGN_SLOTS),
    container: ['kind', 'technology', 'group', 'stereotypes'].concat(DESIGN_SLOTS),
    component: ['technology', 'group', 'stereotypes'].concat(DESIGN_SLOTS),
    code: ['kind', 'stereotypes'].concat(DESIGN_SLOTS),
  };
  const TEXT = {
    empty: 'Select an element, a relationship, a scenario, or a deployment node on the canvas or in the outline to edit it here.',
    locked: 'Locked: given by the task, so it cannot be changed here.',
    deleteLocked: (name) => editorParts().state.lockedSentence(name, 'it cannot be deleted'),
    changeIdLocked: (name) => editorParts().state.lockedSentence(name, 'its id cannot be changed'),
    noNewEntry: (many, one) => `Locked: the task gives the ${many} here, so no ${one} can be added.`,
    readOnly: 'Read-only: this model cannot be changed now.',
    fullFormProvides: 'Provides: described in the Interfaces section.',
    patternsNote: 'Edit patterns in the YAML.',
    derivedLead: 'This relationship is not declared in the model. It is drawn because these relationships connect parts of the two elements:',
  };

  /** Whether the element form shows an Interfaces section (code elements list `provides` as syntax lines instead). */
  function hasInterfacesSection(element) {
    return TYPE_FIELDS[element.type].includes('provides') && element.type !== 'code';
  }

  /**
   * Writes the edits the core has no command for yet (scenario, environment, and record fields): each step
   * `(parsed, yaml) => edits` splices with the core's own YAML primitives (spec §4.9) against the text the step before
   * produced, starting from the current text, and the result reaches the state as one change and one undo step.
   * `dataAt(path)` reads the authored YAML there.
   */
  function createSpliceWriter(state, coreYaml) {
    return {
      dataAt(path) {
        return valueAt(coreYaml().toData(state.getDesign().parsed), path);
      },
      write(label, steps) {
        if (state.isReadOnly()) return false;
        const yaml = coreYaml();
        const text = steps.reduce((current, step) => yaml.applyEdits(current, step(yaml.parse(current), yaml)), state.getText());
        return state.applySourceText(text, { label });
      },
    };
  }

  /** Sets `key` of the map at `mapPath` to `value`, or removes it for null. */
  function setOrDelete(yaml, parsed, mapPath, key, value, order = []) {
    if (value !== null) return yaml.setEntry(parsed, mapPath, key, value, { order });
    const fields = valueAt(yaml.toData(parsed), mapPath);
    return fields && typeof fields === 'object' && key in fields ? yaml.deleteEntry(parsed, mapPath, key) : [];
  }

  function valueAt(data, path) {
    return path.reduce((current, key) => (current == null ? undefined : current[key]), data);
  }

  function listOrNull(items) {
    return items.length > 0 ? items : null;
  }

  const textValue = (value) => (value.trim() === '' ? null : value.trim());

  function withCurrent(ids, ...current) {
    return ids.concat(current.filter((id) => id && !ids.includes(id)));
  }

  /** `{ value, label }` for element ids, by name (with the id when two names are equal, or `byId` for code elements). */
  function elementChoices(model, elementIds, { byId = false } = {}) {
    const names = new Map();
    model.elements.forEach((element) => names.set(element.name, (names.get(element.name) || 0) + 1));
    return elementIds.map((id) => {
      const element = model.elements.get(id);
      if (!element) return { value: id, label: `${id} (not in the model)` };
      const label = byId ? element.id : names.get(element.name) > 1 ? `${element.name} (${element.id})` : element.name;
      return { value: id, label };
    });
  }

  function relationshipById(model, id) {
    return model.relationships.find((relationship) => relationship.id === id) || null;
  }

  /** The read-aloud sentence (spec §9.3): "<Source> <description> <Target> [<technology>]". */
  function sentenceOf(model, relationship) {
    const source = model.elements.get(relationship.sourceId).name;
    const target = model.elements.get(relationship.targetId).name;
    const technology = relationship.technology ? ` [${relationship.technology}]` : '';
    return `${source} ${relationship.description || '…'} ${target}${technology}`;
  }

  function startsWith(path, prefix) {
    return prefix.length <= path.length && prefix.every((part, index) => String(path[index]) === String(part));
  }

  function moved(items, from, to) {
    const next = items.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }

  function compact(map) {
    const entries = Object.entries(map).filter(([, value]) => value !== null && !(Array.isArray(value) && value.length === 0));
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  }

  /** "browser_app" → "Browser app". */
  function words(value) {
    return capitalize(String(value).replace(/_/g, ' '));
  }

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** A key made safe for an instance-prefixed id and an attribute selector: letters, digits, - and _. */
  function slug(key) {
    return String(key).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  /** A keydown listener that runs `action` on Enter. */
  function onEnter(action) {
    return (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      action();
    };
  }

  return {
    TYPE_LABELS,
    TYPE_FIELDS,
    TEXT,
    hasInterfacesSection,
    createSpliceWriter,
    setOrDelete,
    listOrNull,
    textValue,
    withCurrent,
    elementChoices,
    relationshipById,
    sentenceOf,
    startsWith,
    moved,
    compact,
    words,
    capitalize,
    slug,
    cssEscape,
    onEnter,
  };
});
