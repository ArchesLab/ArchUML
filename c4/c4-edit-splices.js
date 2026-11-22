(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'), require('./c4-yaml.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.editSplices = factory(parts.schema, parts.yaml);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, yamlAdapter) {
  'use strict';

  // The splice and YAML-path machinery of the edit commands (spec §4.9): drafts that apply several splices one after
  // another and report them as disjoint splices against the original text, removals that prune the collections they
  // empty, key-by-key writes, and reading values by YAML path. It knows no command and no model.

  // Keys whose value is a map from ids to records: elements, collaborations, nodes, decisions, views, scenarios.
  // Interface descriptions add maps from ids or names to records: interfaces, operations, types, fields, errors, terms.
  const ID_MAP_KEYS = new Set(Object.values(schema.CHILD_KEY).concat(['people', 'systems', 'collaborators', 'deployment',
    'nodes', 'decisions', 'views', 'scenarios', 'layout', 'provides', 'operations', 'types', 'fields', 'errors', 'vocabulary']));

  // A scalar a splice writes first, where flow text or a block collection then takes its place.
  const PLACEHOLDER = 'x';

  // ---- Drafts: commands made of several splices ----------------------------------------------
  //
  // A draft holds the text after each step and, as `pieces`, how that text is made of spans of the original text
  // (`{ start, end }`) and new text (`{ text }`). Its edits against the original are the gaps between those spans.

  function createDraft(text) {
    return { original: text, text, parsed: yamlAdapter.parse(text), pieces: [{ start: 0, end: text.length }] };
  }

  /** Applies `edits`, made against the draft's current text, and re-parses it. */
  function applyStep(draft, edits) {
    edits.slice().sort((a, b) => b.offset - a.offset).forEach((edit) => {
      draft.pieces = slicePieces(draft.pieces, 0, edit.offset)
        .concat(edit.text ? [{ text: edit.text }] : [], slicePieces(draft.pieces, edit.offset + edit.length, Infinity));
    });
    draft.text = yamlAdapter.applyEdits(draft.text, edits);
    draft.parsed = yamlAdapter.parse(draft.text);
  }

  /** The pieces covering positions `from` to `to` of the text they make up. */
  function slicePieces(pieces, from, to) {
    const result = [];
    let position = 0;
    for (const piece of pieces) {
      const size = 'text' in piece ? piece.text.length : piece.end - piece.start;
      const start = Math.max(from, position) - position;
      const end = Math.min(to, position + size) - position;
      if (start < end) result.push('text' in piece ? { text: piece.text.slice(start, end) } : { start: piece.start + start, end: piece.start + end });
      position += size;
    }
    return result;
  }

  /** The disjoint edits that turn the draft's original text into its current text. */
  function draftEdits(draft) {
    const edits = [];
    let cursor = 0;
    let inserted = '';
    const flush = (until) => {
      if (until !== cursor || inserted) edits.push({ offset: cursor, length: until - cursor, text: inserted });
      inserted = '';
    };
    for (const piece of draft.pieces) {
      if ('text' in piece) { inserted += piece.text; continue; }
      flush(piece.start);
      cursor = piece.end;
    }
    flush(draft.original.length);
    return edits;
  }

  /** Removes the map entry or sequence item at `path`, then the collection it leaves empty. */
  function removeAndPrune(draft, path) {
    removeAllAndPrune(draft, [path]);
  }

  /**
   * Removes the entries and items at `paths` and the collections they leave empty, with their keys; a top-level section
   * that this empties in turn (`layout`, `checks`) goes as well. Which collections empty is decided on the data
   * before any removal, so every path keeps its meaning.
   */
  function removeAllAndPrune(draft, paths) {
    removeInRounds(draft, withEmptiedCollections(yamlAdapter.toData(draft.parsed), paths));
  }

  /**
   * `paths` in which every collection whose entries they all name stands in for those entries; a top-level section
   * stands in for an emptied two-level collection in turn. Element and record maps are never collections here.
   */
  function withEmptiedCollections(data, paths) {
    const first = promoteEmptied(data, distinctPaths(paths), distinctPaths(paths.map(holderOf)));
    const sections = distinctPaths(first.emptied.filter((holder) => holder.length === 2).map(holderOf));
    return promoteEmptied(data, first.paths, sections).paths;
  }

  /** Replaces the paths inside each of `holders` that they would leave empty by the holder itself. */
  function promoteEmptied(data, paths, holders) {
    const inside = (holder) => paths.filter((path) => path.length === holder.length + 1 && startsWith(path, holder));
    const emptied = holders.filter((holder) => holder.length > 0 && isCollectionPath(holder)
      && inside(holder).length === entryCount(valueAt(data, holder)));
    const kept = paths.filter((path) => !emptied.some((holder) => path.length === holder.length + 1 && startsWith(path, holder)));
    return { emptied, paths: kept.concat(emptied) };
  }

  function holderOf(path) {
    return path.slice(0, -1);
  }

  function entryCount(value) {
    if (Array.isArray(value)) return value.length;
    return isMap(value) ? Object.keys(value).length : 0;
  }

  function distinctPaths(paths) {
    return [...new Map(paths.map((path) => [JSON.stringify(path), path])).values()];
  }

  /**
   * Removes the entries and items at `paths` in rounds, each against one parse: a round takes the remaining paths in
   * descending offset order for as long as their holders differ, so no removal shifts the index of a path in the same
   * round or in a later one, which all lie before it.
   */
  function removeInRounds(draft, paths) {
    const ordered = byOffsetDescending(draft.parsed, paths);
    for (let start = 0; start < ordered.length;) {
      const round = removalRound(ordered, start);
      start += round.length;
      applyRemovals(draft, round);
    }
  }

  /** The longest run of `ordered` from `start` whose paths all have different holders. */
  function removalRound(ordered, start) {
    const holders = new Set();
    const round = [];
    for (const path of ordered.slice(start)) {
      const holder = JSON.stringify(holderOf(path));
      if (holders.has(holder)) break;
      holders.add(holder);
      round.push(path);
    }
    return round;
  }

  /** Applies the removals of a round in one step; should two of their splices overlap, one after another instead. */
  function applyRemovals(draft, round) {
    const edits = round.flatMap((path) => removal(draft.parsed, path));
    if (areDisjoint(edits)) {
      applyStep(draft, edits);
      return;
    }
    round.forEach((path) => applyStep(draft, removal(draft.parsed, path)));
  }

  /** Whether no two splices overlap or start at the same offset (adjacent splices are fine). */
  function areDisjoint(edits) {
    const sorted = edits.slice().sort((a, b) => a.offset - b.offset);
    return sorted.every((edit, index) => index === 0
      || (sorted[index - 1].offset < edit.offset && sorted[index - 1].offset + sorted[index - 1].length <= edit.offset));
  }

  function removal(parsed, path) {
    const holder = holderOf(path);
    const last = path[path.length - 1];
    return typeof last === 'string' ? yamlAdapter.deleteEntry(parsed, holder, last) : yamlAdapter.deleteItem(parsed, holder, last);
  }

  /**
   * After the entry at `path` went (moved away): a collection it left empty goes too, with its key, and a top-level
   * section that this empties in turn.
   */
  function pruneEmptied(draft, path) {
    const holder = holderOf(path);
    if (holder.length === 0 || !isCollectionPath(holder)) return;
    if (!isEmptyCollection(valueAt(yamlAdapter.toData(draft.parsed), holder))) return;
    applyStep(draft, removal(draft.parsed, holder));
    if (holder.length === 2) pruneEmptied(draft, holder);
  }

  /**
   * Whether `path` names a collection (a map keyed by ids, or a field holding a list) rather than a record: an element,
   * deployment node, decision, view, scenario, step, or collaboration. Records are the entries of id-keyed maps and
   * the items of lists; the entries of a `layout` entry are positions keyed by element id, so it is a collection.
   */
  function isCollectionPath(path) {
    let state = 'record';
    path.forEach((segment, index) => {
      if (typeof segment === 'number') state = 'record';
      else if (state === 'id-map') state = path[index - 1] === 'layout' && index === 1 ? 'id-map' : 'record';
      else state = ID_MAP_KEYS.has(segment) ? 'id-map' : 'field';
    });
    return state !== 'record';
  }

  // A block collection left without entries reads as an empty value; a flow one as `[]` or `{}`.
  function isEmptyCollection(value) {
    return value === null || (Array.isArray(value) && value.length === 0) || (isMap(value) && Object.keys(value).length === 0);
  }

  /** `paths` ordered from the end of the document to its start, so removing one never moves the ones after it. */
  function byOffsetDescending(parsed, paths) {
    return paths.slice().sort((a, b) => entryOffset(parsed, b) - entryOffset(parsed, a));
  }

  function entryOffset(parsed, path) {
    const part = typeof path[path.length - 1] === 'string' ? 'pair' : 'value';
    return yamlAdapter.rangeOf(parsed, path, part).offset;
  }

  // ---- Writes --------------------------------------------------------------------------------

  /**
   * Edits that insert `value` at `index` of the list under `key` of the map at `holderPath`. A missing or empty key
   * is created with the one-item list, placed by `order`.
   */
  function listInsertion(parsed, holderPath, key, index, value, order) {
    if (Array.isArray(valueAt(yamlAdapter.toData(parsed), holderPath.concat(key)))) {
      return yamlAdapter.insertItem(parsed, holderPath.concat(key), index, value);
    }
    return yamlAdapter.setEntry(parsed, holderPath, key, [value], { order });
  }

  /** Sets each of `fields` on the map at `path`, a key at a time; null removes a key, and an unchanged value is skipped. */
  function writeFields(draft, path, fields, order) {
    Object.entries(fields).forEach(([key, value]) => {
      const map = valueAt(yamlAdapter.toData(draft.parsed), path);
      const present = isMap(map) && hasOwn(map, key);
      if (value === null) {
        if (present) applyStep(draft, yamlAdapter.deleteEntry(draft.parsed, path, key));
      } else if (!present || JSON.stringify(map[key]) !== JSON.stringify(value)) {
        applyStep(draft, yamlAdapter.setEntry(draft.parsed, path, key, value, { order }));
      }
    });
  }

  /** Writes the collection `value` over the map value or sequence item at `path`. */
  function replaceEntry(draft, path, value) {
    const holder = path.slice(0, -1);
    const last = path[path.length - 1];
    if (typeof last === 'string') {
      applyStep(draft, yamlAdapter.setEntry(draft.parsed, holder, last, value));
      return;
    }
    applyStep(draft, yamlAdapter.deleteItem(draft.parsed, holder, last));
    applyStep(draft, yamlAdapter.insertItem(draft.parsed, holder, last, value));
  }

  /** `fields` with its keys in `order`, then any others. */
  function ordered(fields, order) {
    const keys = Object.keys(fields).sort((a, b) => rank(order, a) - rank(order, b));
    return Object.fromEntries(keys.map((key) => [key, fields[key]]));
  }

  function rank(order, key) {
    const index = order.indexOf(key);
    return index < 0 ? order.length : index;
  }

  function withoutNulls(fields) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));
  }

  function withoutEmptyList(value) {
    return Array.isArray(value) && value.length === 0 ? null : value;
  }

  // ---- Splices of flow text and block collections -------------------------------------------

  /**
   * Sets `key` of the map at `mapPath` to the one-line YAML `text` as written (flow text, an example the user typed):
   * the entry is set to a placeholder scalar, placed by `order`, whose text `text` then takes over.
   */
  function writeRawValue(draft, mapPath, key, text, order) {
    applyStep(draft, yamlAdapter.setEntry(draft.parsed, mapPath, key, PLACEHOLDER, { order }));
    const range = yamlAdapter.rangeOf(draft.parsed, mapPath.concat(key), 'value');
    applyStep(draft, [{ offset: range.offset, length: range.endOffset - range.offset, text }]);
  }

  /** Sets `key` like setEntry, but writes a collection in block style over a flow one in a block map. */
  function writeBlockEntry(draft, mapPath, key, value, order) {
    const path = mapPath.concat(key);
    if (isFlowCollectionAt(draft, path) && !isFlowCollectionAt(draft, mapPath)) {
      applyStep(draft, yamlAdapter.setEntry(draft.parsed, mapPath, key, PLACEHOLDER, { order }));
    }
    applyStep(draft, yamlAdapter.setEntry(draft.parsed, mapPath, key, value, { order }));
  }

  function isFlowCollectionAt(draft, path) {
    const range = path.length === 0 ? null : yamlAdapter.rangeOf(draft.parsed, path, 'value');
    return Boolean(range) && ['{', '['].includes(draft.text.charAt(range.offset));
  }

  // ---- Data ----------------------------------------------------------------------------------

  function valueAt(data, path) {
    return path.reduce((value, segment) => (value != null && typeof value === 'object' ? value[segment] : undefined), data);
  }

  function isMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  function fieldOf(value, key) {
    return isMap(value) ? value[key] : undefined;
  }

  function startsWith(path, prefix) {
    return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
  }

  return {
    PLACEHOLDER, createDraft, applyStep, draftEdits, removeAndPrune, removeAllAndPrune, pruneEmptied,
    isEmptyCollection, entryOffset, listInsertion, writeFields, replaceEntry, ordered, withoutNulls,
    withoutEmptyList, writeRawValue, writeBlockEntry, isFlowCollectionAt, valueAt, isMap, hasOwn, fieldOf,
    startsWith,
  };
});
