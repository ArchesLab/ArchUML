(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/yaml/2.9.1/yaml.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.yaml = factory(root.ArchUMLYAML);
  }
})(typeof self !== 'undefined' ? self : this, function (YAML) {
  'use strict';

  // The only module that touches the YAML library (spec §3, §4.9). It parses with source ranges and
  // edits by splicing new text into the original; it never prints a whole document.

  // The failsafe schema keeps every scalar a string, so `1.10`, `no`, and `on` keep their text.
  // prettyErrors is off so messages carry no source excerpt; each issue has a range instead.
  const PARSE_OPTIONS = { schema: 'failsafe', keepSourceTokens: true, uniqueKeys: true, prettyErrors: false };

  // Fixed formatting for every new or changed node (spec §4.9). Without aliasDuplicateObjects a
  // fragment never carries an anchor that could clash with the document's own anchors.
  const FRAGMENT_OPTIONS = { indent: 2, lineWidth: 0, flowCollectionPadding: false, aliasDuplicateObjects: false };

  // Nested aliases can expand exponentially ("billion laughs"), so a document whose aliases repeat
  // more nodes than this is refused before anything walks its data.
  const MAX_ALIASED_NODES = 100000;

  const MAX_IMPLICIT_KEY_LENGTH = 1024;
  const RANGE_PARTS = ['value', 'key', 'pair'];

  // Text whose last line is blank: 'end\n\n', 'a\n \n', or just '\n'.
  const ENDS_IN_BLANK_LINE = /(^|\n)[\t ]*\n$/;

  // ---- Parsing -------------------------------------------------------------------------------

  /**
   * Parses `text` into a document that keeps source ranges and tokens.
   * Returns `{ text, document, lineCounter, errors, warnings }`; each issue is
   * `{ code, message, offset, range: { start: { line, col }, end: { line, col } } }`, 1-based.
   */
  function parse(text) {
    const lineCounter = new YAML.LineCounter();
    const yamlDocument = YAML.parseDocument(text, Object.assign({ lineCounter }, PARSE_OPTIONS));
    const fromYamlError = (error) => issue(lineCounter, error.code, error.message, error.pos[0], error.pos[1]);
    const errors = yamlDocument.errors.map(fromYamlError).concat(aliasIssues(yamlDocument, lineCounter));
    return {
      text,
      document: yamlDocument,
      lineCounter,
      errors: errors.sort((a, b) => a.offset - b.offset),
      warnings: yamlDocument.warnings.map(fromYamlError),
    };
  }

  function issue(lineCounter, code, message, offset, endOffset) {
    return { code, message, offset, range: lineSpan(lineCounter, offset, endOffset) };
  }

  function lineSpan(lineCounter, offset, endOffset) {
    return { start: lineCounter.linePos(offset), end: lineCounter.linePos(endOffset) };
  }

  /**
   * The YAML library resolves aliases only when converting to JS, which this module does itself, so
   * aliases are checked here. An alias names the latest anchor whose node is complete before it, so a
   * node cannot alias itself and data stays acyclic.
   */
  function aliasIssues(yamlDocument, lineCounter) {
    const anchorSizes = new Map();
    const problems = [];
    let aliasedNodes = 0;
    let overLimitAlias = null;
    const expandedSize = (node) => {
      if (YAML.isAlias(node)) {
        if (!anchorSizes.has(node.source)) {
          problems.push([node, 'BAD_ALIAS', `Alias *${node.source} has no complete anchor &${node.source} before it`]);
          return 0;
        }
        const anchorSize = anchorSizes.get(node.source);
        aliasedNodes += anchorSize;
        if (aliasedNodes > MAX_ALIASED_NODES && !overLimitAlias) overLimitAlias = node;
        return anchorSize;
      }
      const size = childNodes(node).reduce((sum, child) => sum + expandedSize(child), 1);
      if (node.anchor) anchorSizes.set(node.anchor, size);
      return size;
    };
    if (yamlDocument.contents) expandedSize(yamlDocument.contents);
    if (overLimitAlias) {
      problems.push([overLimitAlias, 'RESOURCE_EXHAUSTION', `Aliases repeat more than ${MAX_ALIASED_NODES} nodes`]);
    }
    return problems.map(([node, code, message]) => issue(lineCounter, code, message, node.range[0], node.range[1]));
  }

  function childNodes(node) {
    if (YAML.isMap(node)) return node.items.flatMap((pair) => [pair.key, pair.value]).filter(Boolean);
    if (YAML.isSeq(node)) return node.items;
    return [];
  }

  // ---- Data ----------------------------------------------------------------------------------

  /** The document as plain data: maps → objects, sequences → arrays, scalars → strings, empty values → null. */
  function toData(parsed) {
    const anchored = new Map();
    const convert = (node) => {
      if (!node) return null;
      if (YAML.isAlias(node)) return anchored.has(node.source) ? anchored.get(node.source) : null;
      let data;
      if (YAML.isMap(node)) data = mapData(node, convert, parsed.text);
      else if (YAML.isSeq(node)) data = node.items.map(convert);
      else data = isEmptyValue(node) ? null : node.value;
      if (node.anchor) anchored.set(node.anchor, data);
      return data;
    };
    return convert(parsed.document.contents);
  }

  function mapData(map, convert, text) {
    const data = {};
    for (const pair of map.items) {
      convert(pair.key); // records an anchor the key may carry, in document order
      // defineProperty keeps a `__proto__` key an own property instead of replacing the prototype.
      Object.defineProperty(data, keyOf(pair, text),
        { value: convert(pair.value), writable: true, enumerable: true, configurable: true });
    }
    return data;
  }

  // An empty value (`key:` or `-` with nothing after it) has no source text of its own.
  function isEmptyValue(node) {
    return node.range[0] === node.range[1];
  }

  // Keys are strings under the failsafe schema; a collection or alias used as a key is named by its source text.
  function keyOf(pair, text) {
    return YAML.isScalar(pair.key) ? pair.key.value : text.slice(pair.key.range[0], pair.key.range[1]);
  }

  // ---- Paths and ranges ----------------------------------------------------------------------

  /** The node at `path` (map keys and sequence indexes), the pair holding it, and the collections above it. */
  function locate(parsed, path) {
    let node = parsed.document.contents;
    let pair = null;
    const ancestors = [];
    for (const segment of path) {
      const child = childAt(node, segment, parsed.text);
      if (!child) return null;
      ancestors.push(node);
      node = child.node;
      pair = child.pair;
    }
    return { node, pair, ancestors };
  }

  function childAt(collection, segment, text) {
    if (YAML.isSeq(collection) && Number.isInteger(segment)) {
      const item = collection.items[segment];
      return item ? { node: item, pair: null } : null;
    }
    const pair = YAML.isMap(collection) && typeof segment === 'string' ? findPair(collection, segment, text) : null;
    return pair ? { node: pair.value, pair } : null;
  }

  function findPair(map, key, text) {
    return map.items.find((pair) => keyOf(pair, text) === key) || null;
  }

  /**
   * The span of the value, key, or whole pair at `path`: `{ start, end, offset, endOffset }` with 1-based
   * line/column positions and UTF-16 offsets. Null when the path names nothing; a sequence item has no key or pair.
   */
  function rangeOf(parsed, path, part = 'value') {
    if (!RANGE_PARTS.includes(part)) throw new RangeError(`Unknown range part "${part}"; use value, key, or pair`);
    const location = locate(parsed, path);
    const span = location && partSpan(location, part);
    if (!span) return null;
    return Object.assign(lineSpan(parsed.lineCounter, span[0], span[1]), { offset: span[0], endOffset: span[1] });
  }

  function partSpan({ node, pair }, part) {
    if (part === 'value') return node && [node.range[0], node.range[1]];
    if (!pair) return null;
    if (part === 'key') return [pair.key.range[0], pair.key.range[1]];
    return [pair.key.range[0], (node || pair.key).range[1]];
  }

  // ---- Source text -----------------------------------------------------------------------------

  /**
   * The source text of the node at `path` as one line of YAML flow (spec §4.11 example text): a flow collection or a
   * scalar as written, its line breaks folded to single spaces; a block collection as a flow collection built from
   * the written text of its keys and scalars, so quotes stay as written and comments are dropped. A block scalar,
   * which has no one-line spelling, is written as JSON. Null when the path names nothing.
   */
  function flowText(parsed, path) {
    const location = locate(parsed, path);
    return location && location.node ? nodeFlowText(parsed.text, location.node) : null;
  }

  function nodeFlowText(text, node) {
    if (YAML.isCollection(node) && !node.flow) return blockCollectionFlowText(text, node);
    if (YAML.isScalar(node) && isBlockScalarNode(node)) return JSON.stringify(node.value);
    return foldedLines(text.slice(node.range[0], node.range[1]));
  }

  // An empty value in a map leaves its key alone (`{a, b: c}` reads `a` as empty); in a sequence it is written `""`.
  function blockCollectionFlowText(text, collection) {
    if (YAML.isSeq(collection)) {
      return `[${collection.items.map((item) => (isEmptyNode(item) ? '""' : nodeFlowText(text, item))).join(', ')}]`;
    }
    const entries = collection.items.map((pair) => {
      const key = nodeFlowText(text, pair.key);
      return isEmptyNode(pair.value) ? key : `${key}: ${nodeFlowText(text, pair.value)}`;
    });
    return `{${entries.join(', ')}}`;
  }

  function isEmptyNode(node) {
    return !node || (YAML.isScalar(node) && isEmptyValue(node));
  }

  function foldedLines(source) {
    return source.replace(/[ \t]*\r?\n\s*/g, ' ');
  }

  // ---- Edits ---------------------------------------------------------------------------------

  /**
   * Applies `{ offset, length, text }` splices made against `text`. They may come in any order; insertions
   * at the same offset keep their order. Throws a RangeError when edits overlap or reach past the text.
   */
  function applyEdits(text, edits) {
    const ordered = edits.slice().sort((a, b) => a.offset - b.offset);
    let result = '';
    let cursor = 0;
    for (const edit of ordered) {
      const end = edit.offset + edit.length;
      if (edit.offset < 0 || edit.length < 0 || end > text.length) {
        throw new RangeError(`Edit [${edit.offset}, ${end}) lies outside the text`);
      }
      if (edit.offset < cursor) throw new RangeError(`Edit at offset ${edit.offset} overlaps the edit before it`);
      result += text.slice(cursor, edit.offset) + edit.text;
      cursor = end;
    }
    return result + text.slice(cursor);
  }

  /**
   * YAML text for `value` as a map value or sequence item in a collection indented `indent` spaces.
   * The first line is unindented and nested lines sit one step (two spaces) deeper than the collection,
   * so a block collection belongs at column `indent + 2`: after `- `, or on its own line under `key:`.
   * With `flow`, the text is one flow node, as `[…]` and `{…}` require.
   * A block scalar in the text also takes in the lines after the splice that are blank or indented at or past its
   * content (comments, trailing spaces), so a caller must check that such text reads back, as replaceValue does.
   */
  function stringifyFragment(value, { indent = 0, flow = false } = {}) {
    return flow ? flowNodeText(value) : blockFragment(value, indent, quoteTextEndingInBlankLine);
  }

  // stringifyFragment's block text, with `quoteText` (a YAML replacer) choosing which text is double-quoted.
  function blockFragment(value, indent, quoteText) {
    return blockValueText(value, quoteText).replace(/\n(?!\n|$)/g, '\n' + ' '.repeat(indent));
  }

  // As the value of a key, YAML indents nested lines one step below that key.
  function blockValueText(value, quoteText) {
    // 'x: …\n', or 'x:\n  …\n' for a block collection
    const pair = YAML.stringify({ x: value }, quoteText, FRAGMENT_OPTIONS);
    const body = pair.slice('x:'.length, -'\n'.length);
    return body.startsWith(' ') ? body.slice(' '.length) : body.slice('\n  '.length);
  }

  // A block scalar can end in a blank line only with keep chomping (`|+`), and a kept block scalar also takes
  // in the blank lines that follow it in the document. Text ending in a blank line is written double-quoted.
  function quoteTextEndingInBlankLine(key, value) {
    return typeof value === 'string' && ENDS_IN_BLANK_LINE.test(value) ? doubleQuoted(value) : value;
  }

  // Every multi-line text double-quoted, for a splice where a block scalar would take in the lines after it.
  function quoteMultilineText(key, value) {
    return typeof value === 'string' && value.includes('\n') ? doubleQuoted(value) : value;
  }

  function doubleQuoted(text) {
    const quoted = new YAML.Scalar(text);
    quoted.type = YAML.Scalar.QUOTE_DOUBLE;
    return quoted;
  }

  // As an item of a flow sequence, a scalar is quoted wherever a flow indicator would end it. Text YAML
  // would spread over several lines is written as JSON instead, which is a one-line YAML flow node.
  function flowNodeText(value) {
    const sequence = YAML.stringify([value], Object.assign({ flow: true }, FRAGMENT_OPTIONS)); // '[…]\n'
    const text = sequence.slice('['.length, -']\n'.length);
    return text.includes('\n') ? JSON.stringify(value) : text;
  }

  // A key is written implicitly (`key: value`), which YAML allows only on one line of at most 1024 characters.
  function stringifyKey(key, flow) {
    const pair = YAML.stringify({ [key]: 0 }, Object.assign({ flow }, FRAGMENT_OPTIONS));
    const text = flow ? pair.slice('{'.length, -': 0}\n'.length) : pair.slice(0, -': 0\n'.length);
    if (text.includes('\n') || text.length > MAX_IMPLICIT_KEY_LENGTH) {
      throw new RangeError(`The key ${JSON.stringify(key)} does not fit on one line of ${MAX_IMPLICIT_KEY_LENGTH} characters`);
    }
    return text;
  }

  /** Edits that replace the scalar at `path` with `value` (a string, number, or boolean), keeping comments. */
  function replaceValue(parsed, path, value) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new TypeError(`replaceValue writes a string, number, or boolean, not ${JSON.stringify(value)}`);
    }
    if (path.length === 0) throw new RangeError('replaceValue needs the path of a map value or a sequence item');
    const location = locate(parsed, path);
    if (!location || !location.node) throw new RangeError(`No value at ${JSON.stringify(path)}`);
    if (YAML.isCollection(location.node)) throw new TypeError(`${JSON.stringify(path)} holds a collection, not a scalar`);
    const parent = location.ancestors[location.ancestors.length - 1];
    const fragment = stringifyFragment(value, { indent: columnOf(parsed, parent), flow: Boolean(parent.flow) });
    const writeOver = (scalarText) =>
      withLineBreak(scalarEdit(parsed.text, location.node, scalarText), lineBreakOf(parsed.text));
    const edit = writeOver(fragment);
    // A block scalar, which multi-line text becomes, also takes in the lines below it that are blank or indented
    // at or past its content, such as a comment under the old value or a blank line holding trailing spaces.
    // Rather than copy the parser's rules for those lines, the spliced text is parsed again; text that would not
    // read back is written as JSON instead, which is a double-quoted scalar on one line.
    if (isBlockScalarText(fragment) && !readsBack(parsed, path, edit, value)) return [writeOver(JSON.stringify(value))];
    return [edit];
  }

  // Whether the value at `path` reads back as the text `expected` once `edit` is applied to the document.
  function readsBack(parsed, path, edit, expected) {
    const location = locate(parse(applyEdits(parsed.text, [edit])), path);
    return Boolean(location) && YAML.isScalar(location.node) && location.node.value === expected;
  }

  /** Edits that rename `oldKey` of the map at `mapPath` to `newKey`, leaving its value and comments untouched. */
  function renameKey(parsed, mapPath, oldKey, newKey) {
    const location = locate(parsed, mapPath);
    if (!location || !location.node) throw new RangeError(`No map at ${JSON.stringify(mapPath)}`);
    if (!YAML.isMap(location.node)) throw new TypeError(`${JSON.stringify(mapPath)} holds no map`);
    const pair = findPair(location.node, oldKey, parsed.text);
    if (!pair) throw new RangeError(`No key ${JSON.stringify(oldKey)} in the map at ${JSON.stringify(mapPath)}`);
    const [start, end] = pair.key.range;
    return [{ offset: start, length: end - start, text: stringifyKey(newKey, Boolean(location.node.flow)) }];
  }

  // Anchors and tags written on a line before a block collection's first key (`&a k: v`, `- !!str k: v`).
  const LEADING_PROPERTIES = /(?:(?:&\S+|!\S*)[ \t]+)+$/;

  // The 0-based column where a collection starts; for a block collection (first key or `-`) that is its
  // indentation. A map's range starts at its first key, after any anchor or tag written before that key, so the
  // column is taken where those properties start. A flow collection's column is unused, as a flow fragment never
  // spans lines.
  function columnOf(parsed, collection) {
    const start = collection.range[0];
    const lineStart = parsed.text.lastIndexOf('\n', start - 1) + 1;
    const properties = LEADING_PROPERTIES.exec(parsed.text.slice(lineStart, start));
    return parsed.lineCounter.linePos(start - (properties ? properties[0].length : 0)).col - 1;
  }

  // ---- Scalar splices --------------------------------------------------------------------------

  // One edit replacing a scalar's text. A block scalar (`|`, `>`) owns its header line and content lines;
  // written over a flow scalar, its content lines go after the end of the old value's line.
  function scalarEdit(text, node, fragment) {
    if (isBlockScalarNode(node)) return replaceBlockScalar(text, node, fragment);
    const [start, end] = node.range;
    const spacing = start === end ? emptyValueSpacing(text, start) : { before: '', after: '' };
    if (isBlockScalarText(fragment)) return blockScalarOverInlineValue(text, start, end, spacing.before + fragment);
    return { offset: start, length: end - start, text: spacing.before + fragment + spacing.after };
  }

  // An empty value has no text of its own, so new text needs a space after the indicator before it
  // (`key:`, `-`, `&anchor`) and before a comment right after it.
  function emptyValueSpacing(text, offset) {
    return { before: /\S/.test(text.charAt(offset - 1)) ? ' ' : '', after: text.charAt(offset) === '#' ? ' ' : '' };
  }

  // The header replaces the old value, the rest of its line (spaces, a comment) stays, and the content
  // lines take the place of the line break.
  function blockScalarOverInlineValue(text, start, end, fragment) {
    const lineEnd = lineEndAt(text, end);
    const rest = text.slice(end, lineEnd);
    const separatedRest = /^\S/.test(rest) ? ' ' + rest : rest;
    return { offset: start, length: lineBreakEnd(text, lineEnd) - start, text: blockScalarWithRest(fragment, separatedRest) };
  }

  // The node starts with its header indicator (`|-`, `>2`); the rest of the header line (a comment) stays.
  // A flow scalar written over the block keeps the line break that ended the block.
  function replaceBlockScalar(text, node, fragment) {
    const [start, end] = node.range;
    const headerEnd = blockScalarHeaderEnd(node);
    const rest = text.slice(headerEnd, lineEndAt(text, headerEnd));
    const finalLineBreak = text.charAt(end - 1) === '\n' ? '\n' : '';
    const replacement = isBlockScalarText(fragment) ? blockScalarWithRest(fragment, rest) : fragment + rest + finalLineBreak;
    return { offset: start, length: end - start, text: replacement };
  }

  // A block scalar fragment with `rest` (what followed the old value on its line) after its header. The content
  // always ends with a line break, even at the end of a file that had none: without one, parsers disagree on
  // whether a `|` scalar ends with a line break.
  function blockScalarWithRest(fragment, rest) {
    const [header, content] = splitHeader(fragment);
    return `${header}${rest}\n${content}\n`;
  }

  function isBlockScalarNode(node) {
    return node.type === YAML.Scalar.BLOCK_LITERAL || node.type === YAML.Scalar.BLOCK_FOLDED;
  }

  // Just after a block scalar's header indicator (`|-`, `>2`).
  function blockScalarHeaderEnd(node) {
    const header = node.srcToken.props.find((token) => token.type === 'block-scalar-header');
    return header.offset + header.source.length;
  }

  // stringifyFragment writes a block scalar as a `|` or `>` header line followed by its content lines.
  function isBlockScalarText(fragment) {
    return /^[|>]/.test(fragment);
  }

  function splitHeader(fragment) {
    const lineBreak = fragment.indexOf('\n');
    return [fragment.slice(0, lineBreak), fragment.slice(lineBreak + 1)];
  }

  // Where the line holding `offset` ends, before its `\n` or `\r\n`.
  function lineEndAt(text, offset) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return text.length;
    return newline > offset && text.charAt(newline - 1) === '\r' ? newline - 1 : newline;
  }

  // Just after the line break starting at `lineEnd`, or the end of the text when there is none.
  function lineBreakEnd(text, lineEnd) {
    if (text.startsWith('\r\n', lineEnd)) return lineEnd + 2;
    return text.charAt(lineEnd) === '\n' ? lineEnd + 1 : lineEnd;
  }

  // Inserted lines follow the document's first line break, so a CRLF file stays CRLF.
  function lineBreakOf(text) {
    const match = /\r?\n/.exec(text);
    return match ? match[0] : '\n';
  }

  function withLineBreak(edit, lineBreak) {
    return lineBreak === '\n' ? edit : Object.assign({}, edit, { text: edit.text.replace(/\n/g, lineBreak) });
  }

  // ---- Collection splices ----------------------------------------------------------------------
  //
  // An entry is a pair of a map or an item of a sequence. In a block collection an entry owns its lines: from the line
  // where its key or `-` stands to the end of its value, with the comment lines below that are indented past it.
  // The comment lines right above an entry, indented no deeper, describe it: new entries go above them and moves
  // carry them along, while deletions keep them. The comments that open the file (an embed's caption) describe no
  // entry. New block lines follow their siblings' column; a new collection sits two spaces deeper than its key. Flow
  // collections are edited between their brackets with `, ` separators. Values are plain data: strings, numbers,
  // booleans, and lists and maps of them.

  /**
   * Edits that set `key` of the map at `mapPath` to `value`. An existing value is written over in place, keeping the
   * comment on its line, in block style unless it was a flow collection. A new key goes before the first existing key
   * that comes later in `order`, else after the last key. Missing maps on the way are created, and an empty value or
   * an empty document is filled.
   */
  function setEntry(parsed, mapPath, key, value, { order = [] } = {}) {
    assertWritable(value);
    const location = locate(parsed, mapPath);
    const pair = location && YAML.isMap(location.node) ? findPair(location.node, key, parsed.text) : null;
    if (pair) return writtenOver(parsed, location.node, pair, [...mapPath, key], value);
    return checkedSplice(parsed, [...mapPath, key], value, (quoteText) =>
      addEntry(parsed, mapPath, pairEntry(key, value, quoteText), { kind: 'map', key, order }));
  }

  /**
   * Edits that remove `key` from the map at `mapPath`: in a block map its lines through the end of its value, inline
   * comment included, keeping the comment lines above it. A block map left without keys reads as an empty value.
   */
  function deleteEntry(parsed, mapPath, key) {
    const map = collectionAt(parsed, mapPath, 'map');
    return [removal(parsed, map, pairIndex(parsed, map, mapPath, key), { withComments: false })];
  }

  /** Edits that insert `value` before the item at `index` (0 to the length) of the sequence at `seqPath`. */
  function insertItem(parsed, seqPath, index, value) {
    assertWritable(value);
    return checkedSplice(parsed, [...seqPath, index], value, (quoteText) =>
      addEntry(parsed, seqPath, itemEntry(value, quoteText), { kind: 'sequence', index }));
  }

  /** Edits that add `value` after the last item of the sequence at `seqPath`, creating the sequence like setEntry. */
  function appendItem(parsed, seqPath, value) {
    const location = locate(parsed, seqPath);
    return insertItem(parsed, seqPath, location && YAML.isSeq(location.node) ? location.node.items.length : 0, value);
  }

  /** Edits that remove the item at `index` of the sequence at `seqPath`, as deleteEntry removes a key. */
  function deleteItem(parsed, seqPath, index) {
    const sequence = collectionAt(parsed, seqPath, 'sequence');
    checkIndex(seqPath, index, sequence.items.length);
    return [removal(parsed, sequence, index, { withComments: false })];
  }

  /**
   * Edits that move the item at `from` of the sequence at `seqPath` to index `to`, with its comments. An item holding
   * a block scalar that would take in the lines below its new place is written from its data, as moveEntry does.
   */
  function moveItem(parsed, seqPath, from, to) {
    const sequence = collectionAt(parsed, seqPath, 'sequence');
    checkIndex(seqPath, from, sequence.items.length);
    checkIndex(seqPath, to, sequence.items.length);
    return moveWithin(parsed, sequence, from, to, { oldPath: [...seqPath, from], newPath: [...seqPath, to], entryOf: itemEntry });
  }

  /**
   * Edits that move `key` from the map at `fromMapPath` into the map at `toMapPath`, placed by `order` among the keys
   * that remain there and with missing maps created as setEntry does. Between block maps the entry's raw text moves,
   * with its comments, re-indented by the difference in columns; into or out of a flow map the entry is written from
   * its data. So is an entry holding a block scalar that would take in the lines below its new place. Written from
   * data, an entry cannot hold an empty value, which throws a TypeError.
   */
  function moveEntry(parsed, fromMapPath, key, toMapPath, { order = [] } = {}) {
    const source = collectionAt(parsed, fromMapPath, 'map');
    const index = pairIndex(parsed, source, fromMapPath, key);
    const entryPath = [...fromMapPath, key];
    if (entryPath.every((segment, i) => toMapPath[i] === segment)) {
      throw new RangeError(`Cannot move ${JSON.stringify(entryPath)} into itself`);
    }
    const toLocation = locate(parsed, toMapPath);
    if (toLocation && toLocation.node === source) {
      const entryOf = (data, quoteText) => pairEntry(key, data, quoteText);
      return moveWithin(parsed, source, index, finalIndex(parsed, source, index, order), { oldPath: entryPath, newPath: entryPath, entryOf });
    }
    if (toLocation && YAML.isMap(toLocation.node) && findPair(toLocation.node, key, parsed.text)) {
      throw new RangeError(`The map at ${JSON.stringify(toMapPath)} already has the key ${JSON.stringify(key)}`);
    }
    const destinationPath = [...toMapPath, key];
    if (!source.flow && takesBlockLines(parsed, toMapPath)) {
      const lines = rawEntry(parsed, source, index);
      const edits = movedEdits(parsed, removal(parsed, source, index, { withComments: true }),
        (doc) => addEntry(doc, toMapPath, lines, { kind: 'map', key, order })[0]);
      if (keepsMovedData(parsed, edits, entryPath, destinationPath)) return edits;
    }
    const value = writableData(parsed, entryPath);
    return movedEdits(parsed, removal(parsed, source, index, { withComments: false }), (doc) =>
      checkedSplice(doc, destinationPath, value, (quoteText) =>
        addEntry(doc, toMapPath, pairEntry(key, value, quoteText), { kind: 'map', key, order }))[0]);
  }

  // ---- Finding collections and positions ----

  function collectionAt(parsed, path, kind) {
    const location = locate(parsed, path);
    if (!location || !location.node) throw new RangeError(`No ${kind} at ${JSON.stringify(path)}`);
    if (!isKind(location.node, kind)) throw new TypeError(`${JSON.stringify(path)} holds no ${kind}`);
    return location.node;
  }

  function isKind(node, kind) {
    return kind === 'map' ? YAML.isMap(node) : YAML.isSeq(node);
  }

  function pairIndex(parsed, map, mapPath, key) {
    const index = map.items.findIndex((pair) => keyOf(pair, parsed.text) === key);
    if (index < 0) throw new RangeError(`No key ${JSON.stringify(key)} in the map at ${JSON.stringify(mapPath)}`);
    return index;
  }

  // Rejects `index` unless it names an item of a sequence of `length` items, or, `orEnd`, the place after the last.
  function checkIndex(seqPath, index, length, { orEnd = false } = {}) {
    if (Number.isInteger(index) && index >= 0 && index < length + (orEnd ? 1 : 0)) return;
    throw new RangeError(`Index ${index} is outside the sequence at ${JSON.stringify(seqPath)} (length ${length})`);
  }

  // The deepest node that `path` reaches, and how many of its segments lead there.
  function deepestLocation(parsed, path) {
    for (let depth = path.length; depth > 0; depth--) {
      const location = locate(parsed, path.slice(0, depth));
      if (location) return { location, depth };
    }
    return { location: locate(parsed, []), depth: 0 };
  }

  // The index of the first pair whose key comes later than `key` in `order`; the pair count when none does.
  function insertionIndex(parsed, map, key, order) {
    const rank = order.indexOf(key);
    const later = rank < 0 ? -1 : map.items.findIndex((pair) => order.indexOf(keyOf(pair, parsed.text)) > rank);
    return later < 0 ? map.items.length : later;
  }

  // Where the pair at `from` ends up when its map's other pairs take it by `order`. insertionIndex never returns
  // `from` itself, as a pair does not come later than its own key.
  function finalIndex(parsed, map, from, order) {
    const before = insertionIndex(parsed, map, keyOf(map.items[from], parsed.text), order);
    return before > from ? before - 1 : before;
  }

  // ---- Adding entries ----

  /**
   * Edits that add `entry` to the map (placing `key` by `order`) or the sequence (at `index`) at `path`. Missing
   * maps go into the deepest existing map, by `order` too; an empty value or an empty document is filled.
   */
  function addEntry(parsed, path, entry, { kind, key, index = 0, order = [] }) {
    const { location, depth } = deepestLocation(parsed, path);
    const node = location.node;
    const missing = path.slice(depth);
    const missingItem = missing.findIndex((segment) => typeof segment !== 'string');
    if (missingItem >= 0) throw new RangeError(`No item at ${JSON.stringify(path.slice(0, depth + missingItem + 1))}`);
    if (missing.length === 0 && isKind(node, kind)) {
      if (kind === 'map') return [insertEntry(parsed, node, insertionIndex(parsed, node, key, order), entry)];
      checkIndex(path, index, node.items.length, { orEnd: true });
      return [insertEntry(parsed, node, index, entry)];
    }
    if (kind === 'sequence') checkIndex(path, index, 0, { orEnd: true });
    const holderKind = missing.length > 0 ? 'map' : kind;
    const content = missing.length > 0 ? inMissingKeys(missing, entry, kind) : entry;
    if (depth === 0 && (!node || isEmptyScalar(node))) return [intoEmptyDocument(parsed, content)];
    if (isEmptyScalar(node)) return [filled(parsed, location, content, holderKind)];
    if (!isKind(node, holderKind)) throw new TypeError(`${JSON.stringify(path.slice(0, depth))} holds no ${holderKind}`);
    return [insertEntry(parsed, node, insertionIndex(parsed, node, missing[0], order), content)];
  }

  // The edit that inserts `entry` before the entry at `index` (with the comment lines above it), or after the last.
  function insertEntry(parsed, collection, index, entry) {
    const { text } = parsed;
    if (collection.flow) return flowInsertion(collection, index, entry.flow());
    const column = entryLayout(parsed, collection, 0).column;
    if (index === collection.items.length) {
      return linesEdit(text, linesInsertedAt(text, entryLayout(parsed, collection, index - 1).ownEnd, entry.block(column)));
    }
    const next = entryLayout(parsed, collection, index);
    // The first key of a map in a sequence item shares the item's line: the new entry takes its place there.
    if (next.inline) return linesEdit(text, { offset: next.start, length: 0, text: `${unindented(entry.block(column))}\n${spaces(column)}` });
    return linesEdit(text, { offset: next.attachedStart, length: 0, text: `${entry.block(column)}\n` });
  }

  function flowInsertion(collection, index, entryText) {
    const count = collection.items.length;
    if (count === 0) return { offset: collection.range[0] + 1, length: 0, text: entryText };
    if (index < count) return { offset: entryStart(collection, index), length: 0, text: `${entryText}, ` };
    return { offset: entryContentEnd(collection, count - 1), length: 0, text: `, ${entryText}` };
  }

  // The edit that gives an empty document (nothing, comments, or a `---` marker, whose empty value is the root) its
  // first `entry`: on the line after the document's comments and marker, and before a `...` that ends the document.
  function intoEmptyDocument(parsed, entry) {
    const { text } = parsed;
    return linesEdit(text, linesInsertedAt(text, lineStartFrom(text, parsed.document.range[1]), entry.block(0)));
  }

  // The edit that fills the empty value at `location` with a new collection holding `entry`: in a flow collection
  // between brackets, else as lines below the key or `-` that holds the value.
  function filled(parsed, location, entry, kind) {
    const parent = location.ancestors[location.ancestors.length - 1];
    if (parent.flow) return flowValueEdit(parsed.text, location.node, kind === 'map' ? `{${entry.flow()}}` : `[${entry.flow()}]`);
    return linesBelowHolder(parsed, location, entry.block);
  }

  // The edit that adds `linesAt(column)` after the lines of the entry holding the empty value at `location`, two
  // columns deeper than it, so that any comments below its key stay right under the key.
  function linesBelowHolder(parsed, location, linesAt) {
    const parent = location.ancestors[location.ancestors.length - 1];
    const holder = entryLayout(parsed, parent, parent.items.indexOf(location.pair || location.node));
    return linesEdit(parsed.text, linesInsertedAt(parsed.text, holder.ownEnd, linesAt(holder.column + 2)));
  }

  // The edit that writes flow `fragment` over the value `node` inside a flow collection; an empty value has no text,
  // so the fragment needs a space after the indicator and before a comment right after it.
  function flowValueEdit(text, node, fragment) {
    const [start, end] = node.range;
    const spacing = start === end ? emptyValueSpacing(text, start) : { before: '', after: '' };
    return { offset: start, length: end - start, text: spacing.before + fragment + spacing.after };
  }

  // An edit inserting whole `lines` at a line start. At the end of a text without a final line break the line break
  // goes before the lines instead, so the text still ends without one.
  function linesInsertedAt(text, offset, lines) {
    const unterminated = offset === text.length && offset > 0 && text.charAt(offset - 1) !== '\n';
    return { offset, length: 0, text: unterminated ? `\n${lines}` : `${lines}\n` };
  }

  // An edit whose new text is written with `\n`, converted to the document's line breaks.
  function linesEdit(text, edit) {
    return withLineBreak(edit, lineBreakOf(text));
  }

  // ---- New entries: their block lines at a column, and their text between flow brackets ----

  function pairEntry(key, value, quoteText) {
    return {
      block: (column) => {
        const valueText = blockFragment(value, column, quoteText);
        const keyText = stringifyKey(key, false);
        return isBlockCollection(value)
          ? `${spaces(column)}${keyText}:\n${spaces(column + 2)}${valueText}`
          : `${spaces(column)}${keyText}: ${valueText}`;
      },
      flow: () => `${stringifyKey(key, true)}: ${flowNodeText(value)}`,
    };
  }

  function itemEntry(value, quoteText) {
    return {
      block: (column) => `${spaces(column)}- ${blockFragment(value, column, quoteText)}`,
      flow: () => flowNodeText(value),
    };
  }

  // `entry` inside new maps under the missing `keys`, the last of which holds a collection of `kind`.
  function inMissingKeys(keys, entry, kind) {
    return keys.reduceRight((inner, key, i) => {
      const innerKind = i === keys.length - 1 ? kind : 'map';
      return {
        block: (column) => `${spaces(column)}${stringifyKey(key, false)}:\n${inner.block(column + 2)}`,
        flow: () => `${stringifyKey(key, true)}: ${innerKind === 'map' ? `{${inner.flow()}}` : `[${inner.flow()}]`}`,
      };
    }, entry);
  }

  // The entry at `index` as it stands in the text: in a block collection its lines with the comment lines above it
  // (only block lines, re-indented to the new column), in a flow collection its text.
  function rawEntry(parsed, collection, index) {
    if (collection.flow) {
      const raw = parsed.text.slice(entryStart(collection, index), entryContentEnd(collection, index));
      return { flow: () => raw.replace(/\r\n/g, '\n') };
    }
    const layout = entryLayout(parsed, collection, index);
    const raw = parsed.text.slice(layout.attachedStart, layout.ownEnd).replace(/\r\n/g, '\n').replace(/\n$/, '');
    const lines = layout.inline ? spaces(layout.column) + raw : raw;
    return { block: (column) => reindented(lines, column - layout.column) };
  }

  // `lines` moved `delta` columns to the right (or left). Whitespace-only lines move too, as they can hold the spaces
  // of a block scalar's text; empty lines stay empty.
  function reindented(lines, delta) {
    if (delta === 0) return lines;
    return lines.split('\n').map((line) => {
      if (delta > 0) return line === '' ? line : spaces(delta) + line;
      return line.slice(Math.min(-delta, /^ */.exec(line)[0].length));
    }).join('\n');
  }

  function spaces(count) {
    return ' '.repeat(count);
  }

  function unindented(lines) {
    return lines.replace(/^ +/, '');
  }

  // Whether the entries of the map at `path` are written as block lines: the deepest existing map on the way, or the
  // empty value or empty document that will hold it, is not inside a flow collection.
  function takesBlockLines(parsed, path) {
    const { location } = deepestLocation(parsed, path);
    if (YAML.isCollection(location.node)) return !location.node.flow;
    const parent = location.ancestors[location.ancestors.length - 1];
    return !parent || !parent.flow;
  }

  // ---- Writing over values ----

  // The edits that write `value` over the value of an existing pair.
  function writtenOver(parsed, map, pair, entryPath, value) {
    const node = pair.value;
    if (!node) throw new RangeError(`No value at ${JSON.stringify(entryPath)}`);
    if (!YAML.isCollection(node) && !isCollectionValue(value)) return replaceValue(parsed, entryPath, value);
    if (map.flow) return [flowValueEdit(parsed.text, node, flowNodeText(value))];
    return checkedSplice(parsed, entryPath, value, (quoteText) => {
      if (isEmptyScalar(node) && isBlockCollection(value)) {
        // Filled like a missing map that setEntry creates: below the comments under the key.
        const location = locate(parsed, entryPath);
        return [linesBelowHolder(parsed, location, (column) => spaces(column) + blockFragment(value, column - 2, quoteText))];
      }
      return [blockValueEdit(parsed, map, pair, value, quoteText)];
    });
  }

  // The edit that writes `value` over the value of a pair in a block map. The new value starts after the `:` and the
  // old value's anchor or tag; what followed the old value on its line (a comment) stays on the key's line; a block
  // collection takes the lines below in block style, unless the old value was a flow collection, which stays flow.
  function blockValueEdit(parsed, map, pair, value, quoteText) {
    const { text } = parsed;
    const node = pair.value;
    const valueStart = valueIndicatorEnd(pair);
    let restStart = node.range[1];
    if (isBlockScalarNode(node)) restStart = blockScalarHeaderEnd(node);
    else if (YAML.isCollection(node) && !node.flow) restStart = valueStart;
    const rest = text.slice(restStart, lineEndAt(text, restStart));
    const column = entryLayout(parsed, map, map.items.indexOf(pair)).column;
    const { inline, below } = newValueLayout(value, column, quoteText, YAML.isCollection(node) && node.flow);
    const newText = (inline ? ` ${inline}` : '') + (/^\S/.test(rest) ? ` ${rest}` : rest) + (below ? `\n${below}` : '');
    return linesEdit(text, { offset: valueStart, length: lineEndBefore(text, contentEnd(node)) - valueStart, text: newText });
  }

  // How `value` is laid out after a key at `column`: the text `inline` on the key's line and the lines `below` it.
  function newValueLayout(value, column, quoteText, flowStyle) {
    if (flowStyle && isCollectionValue(value)) return { inline: flowNodeText(value), below: null };
    const fragment = blockFragment(value, column, quoteText);
    if (isBlockCollection(value)) return { inline: '', below: spaces(column + 2) + fragment };
    if (!isBlockScalarText(fragment)) return { inline: fragment, below: null };
    const [header, content] = splitHeader(fragment);
    return { inline: header, below: content };
  }

  const VALUE_INDICATOR_TOKENS = ['map-value-ind', 'anchor', 'tag'];

  // Just after a pair's `:` and its value's anchor or tag: where a value on the key's line starts.
  function valueIndicatorEnd(pair) {
    const last = pair.srcToken.sep.filter((token) => VALUE_INDICATOR_TOKENS.includes(token.type)).pop();
    return last.offset + last.source.length;
  }

  // ---- Removing and moving entries ----

  // The edit that removes the entry at `index`: in a flow collection with a separator, in a block collection with
  // its lines and, `withComments`, the comment lines above it.
  function removal(parsed, collection, index, { withComments }) {
    if (collection.flow) return flowRemoval(collection, index);
    const { text } = parsed;
    const layout = entryLayout(parsed, collection, index);
    if (layout.inline) return inlineEntryRemoval(text, collection, layout);
    return linesRemoved(text, withComments ? layout.attachedStart : layout.ownStart, layout.ownEnd);
  }

  function flowRemoval(collection, index) {
    const count = collection.items.length;
    const start = entryStart(collection, index);
    const end = entryContentEnd(collection, index);
    if (index < count - 1) return { offset: start, length: entryStart(collection, index + 1) - start, text: '' };
    const from = index > 0 ? entryContentEnd(collection, index - 1) : start;
    return { offset: from, length: end - from, text: '' };
  }

  // An entry that shares its line with the `-` of the item holding its collection: the next entry moves up into its
  // place, or, when it is the only entry, the item is left empty.
  function inlineEntryRemoval(text, collection, layout) {
    if (collection.items.length > 1) {
      const nextText = layout.ownEnd + /^[ \t\r\n]*/.exec(text.slice(layout.ownEnd))[0].length;
      return { offset: layout.start, length: nextText - layout.start, text: '' };
    }
    const from = layout.start - /[ \t]*$/.exec(text.slice(0, layout.start))[0].length;
    return { offset: from, length: lineEndBefore(text, layout.ownEnd) - from, text: '' };
  }

  // An edit removing whole lines. When they end a text without a final line break, the line break before them goes
  // too, so the text still ends without one; a blank line keeps its line break, as it can be text of a `|+` block scalar.
  function linesRemoved(text, start, end) {
    const unterminated = end === text.length && text.charAt(end - 1) !== '\n';
    const takesLineBreakAbove = unterminated && start > 0 && !lineAt(text, lineStartAt(text, start - 1)).blank;
    const from = takesLineBreakAbove ? start - (text.startsWith('\r\n', start - 2) ? 2 : 1) : start;
    return { offset: from, length: end - from, text: '' };
  }

  // The edits that move the entry at `from` of `collection` to index `to`, carrying its comment lines. The insertion
  // lands at least one entry away from the moved entry, so the two edits never touch. The entry's raw text moves,
  // unless its data, at `oldPath` before the move and at `newPath` after it, would then not read back; it is then
  // written from that data by `entryOf(data, quoteText)`, as checkedSplice writes new entries.
  function moveWithin(parsed, collection, from, to, { oldPath, newPath, entryOf }) {
    if (from === to) return [];
    const removalEdit = removal(parsed, collection, from, { withComments: true });
    const movedAs = (entry) => [insertEntry(parsed, collection, to < from ? to : to + 1, entry), removalEdit];
    const rawEdits = movedAs(rawEntry(parsed, collection, from));
    if (keepsMovedData(parsed, rawEdits, oldPath, newPath)) return rawEdits;
    const data = writableData(parsed, oldPath);
    return checkedSplice(parsed, newPath, data, (quoteText) =>
      movedAs(withAttachedComments(parsed, collection, from, entryOf(data, quoteText))));
  }

  // Whether `edits`, which move the raw text of the entry at `oldPath` to `newPath`, keep its data. Only a block
  // scalar can change: it also takes in the lines below its new place that are blank (kept by `|+`), led by a tab,
  // or indented past its content.
  function keepsMovedData(parsed, edits, oldPath, newPath) {
    return !hasBlockScalar(locate(parsed, oldPath).node) || readsBackAs(parsed, edits, newPath, dataAt(parsed, oldPath));
  }

  // The data at `path`, for writing a moved entry from it. An empty value has no text that writes it, so it is
  // refused like any value collection splices do not write.
  function writableData(parsed, path) {
    const data = dataAt(parsed, path);
    assertWritable(data, path);
    return data;
  }

  // `entry` below the comment lines right above the entry at `index` of a block collection; within one collection
  // they keep their column.
  function withAttachedComments(parsed, collection, index, entry) {
    const { attachedStart, ownStart } = entryLayout(parsed, collection, index);
    const comments = parsed.text.slice(attachedStart, ownStart).replace(/\r\n/g, '\n');
    return { block: (column) => comments + entry.block(column) };
  }

  /**
   * The edits that move an entry out with `removalEdit` and in with the edit that `insertionInto(parsed)` builds.
   * An insertion inside the removed text or at either end of it would interfere with the removal: a separator or line
   * break written twice or not at all, or a flow collection left with a stray `, `. The entry is then removed first and
   * inserted into the shortened text, and one edit spans both changes.
   */
  function movedEdits(parsed, removalEdit, insertionInto) {
    const insertion = insertionInto(parsed);
    const removalEnd = removalEdit.offset + removalEdit.length;
    if (insertion.offset < removalEdit.offset || insertion.offset > removalEnd) return [insertion, removalEdit];
    const shortened = applyEdits(parsed.text, [removalEdit]);
    const lineBreak = lineBreakOf(parsed.text);
    const insertionAfter = insertionInto(parse(shortened));
    // A shortened text with no line break left to copy gets `\n` in its new lines; they take the document's instead.
    const inserted = lineBreakOf(shortened) === lineBreak ? insertionAfter : withLineBreak(insertionAfter, lineBreak);
    return [differingSpan(parsed.text, applyEdits(shortened, [inserted]))];
  }

  // The one edit that turns `text` into `changed`: the span between their common start and common end, widened so
  // that it never splits a surrogate pair.
  function differingSpan(text, changed) {
    const limit = Math.min(text.length, changed.length);
    let start = 0;
    while (start < limit && text.charCodeAt(start) === changed.charCodeAt(start)) start++;
    if (start > 0 && isHighSurrogate(text.charCodeAt(start - 1))) start--;
    let end = 0;
    while (end < limit - start && text.charCodeAt(text.length - 1 - end) === changed.charCodeAt(changed.length - 1 - end)) end++;
    if (end > 0 && isHighSurrogate(text.charCodeAt(text.length - 1 - end))) end--;
    return { offset: start, length: text.length - end - start, text: changed.slice(start, changed.length - end) };
  }

  function isHighSurrogate(code) {
    return code >= 0xd800 && code <= 0xdbff;
  }

  // ---- Where entries stand in the text ----

  /**
   * Where the entry at `index` of a block collection stands: the `start` of its text (its `-`, `?`, anchor, tag, or
   * key) and that start's `column`; whether it is `inline`, after other text on its line (the first key of a map in a
   * sequence item); the span `ownStart`–`ownEnd` of its own lines; and `attachedStart`, where the comment lines above
   * it begin.
   */
  function entryLayout(parsed, collection, index) {
    const { text } = parsed;
    const start = entryStart(collection, index);
    const lineStart = lineStartAt(text, start);
    const column = start - lineStart;
    const inline = /\S/.test(text.slice(lineStart, start));
    const ownStart = inline ? start : lineStart;
    const ownEnd = blockEnd(text, entryContentEnd(collection, index), column);
    // Comment lines that reach the start of the file are its header (such as an embed's caption), not the entry's.
    const commentsStart = inline ? ownStart : commentLinesAbove(text, lineStart, column);
    const attachedStart = commentsStart === 0 ? ownStart : commentsStart;
    return { start, column, inline, ownStart, ownEnd, attachedStart };
  }

  const ENTRY_START_TOKENS = ['seq-item-ind', 'explicit-key-ind', 'anchor', 'tag'];

  function entryStart(collection, index) {
    const entry = collection.items[index];
    const sourceItem = YAML.isMap(collection) ? entry.srcToken : collection.srcToken.items[index];
    const token = sourceItem.start.find((t) => ENTRY_START_TOKENS.includes(t.type));
    if (token) return token.offset;
    return YAML.isPair(entry) ? entry.key.range[0] : entry.range[0];
  }

  function entryContentEnd(collection, index) {
    const entry = collection.items[index];
    if (!YAML.isPair(entry)) return contentEnd(entry);
    return entry.value ? Math.max(entry.key.range[1], contentEnd(entry.value)) : entry.key.range[1];
  }

  // Where the text of `node` ends: at its last entry for a block collection, as its range then also takes in the
  // comment lines after it, however deep they are indented.
  function contentEnd(node) {
    if (YAML.isCollection(node) && !node.flow && node.items.length > 0) return entryContentEnd(node, node.items.length - 1);
    return node.range[1];
  }

  // Just after the last line of an entry whose text ends at `contentEnd`, extended over the comment lines below it
  // that are indented past `column`, and the blank lines between them.
  function blockEnd(text, contentEnd, column) {
    let end = lineBreakEnd(text, lineEndBefore(text, contentEnd));
    for (let start = end; start < text.length;) {
      const line = lineAt(text, start);
      if (line.comment && line.indent > column) end = line.next;
      else if (!line.blank) break;
      start = line.next;
    }
    return end;
  }

  // The start of the comment lines right above `lineStart` that are indented no deeper than `column`.
  function commentLinesAbove(text, lineStart, column) {
    let start = lineStart;
    while (start > 0) {
      const above = lineStartAt(text, start - 1);
      const line = lineAt(text, above);
      if (!line.comment || line.indent > column) break;
      start = above;
    }
    return start;
  }

  // The line starting at `start`: where the next line starts, its indentation, and whether it is blank or a comment.
  function lineAt(text, start) {
    const end = lineEndAt(text, start);
    const indent = /^[ \t]*/.exec(text.slice(start, end))[0].length;
    return { next: lineBreakEnd(text, end), indent, blank: start + indent === end, comment: text.charAt(start + indent) === '#' };
  }

  // Where the line holding the character before `offset` ends, before its line break.
  function lineEndBefore(text, offset) {
    return lineEndAt(text, lineStartAt(text, offset - 1));
  }

  // Where the line holding `offset` starts. A line break belongs to the line it ends.
  function lineStartAt(text, offset) {
    return offset > 0 ? text.lastIndexOf('\n', offset - 1) + 1 : 0;
  }

  // The first line start at or after `offset`, or the end of a text whose last line holds `offset`.
  function lineStartFrom(text, offset) {
    return lineStartAt(text, offset) === offset ? offset : lineBreakEnd(text, lineEndAt(text, offset));
  }

  // ---- Values ----

  // Collection splices write the data toData reads, plus numbers and booleans, which read back as their text.
  function assertWritable(value, path = []) {
    if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return;
    if (Array.isArray(value) || isPlainObject(value)) {
      const entries = Array.isArray(value) ? Array.from(value).entries() : Object.entries(value);
      for (const [key, child] of entries) assertWritable(child, [...path, key]);
      return;
    }
    const shown = typeof value === 'object' && value !== null ? Object.prototype.toString.call(value) : String(value);
    const where = path.length > 0 ? ` at ${JSON.stringify(path)}` : '';
    throw new TypeError(`Collection splices write strings, numbers, booleans, and lists and maps of them, not ${shown}${where}`);
  }

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  }

  function isCollectionValue(value) {
    return typeof value === 'object';
  }

  // A list or map with entries; block style cannot write an empty one, which is written `[]` or `{}`.
  function isBlockCollection(value) {
    return isCollectionValue(value) && Object.keys(value).length > 0;
  }

  function isEmptyScalar(node) {
    return YAML.isScalar(node) && isEmptyValue(node);
  }

  /**
   * The edits that `build` writes with multi-line text as block scalars, or, when the value at `path` would not read
   * back, with that text double-quoted: a block scalar also takes in lines after the splice that are indented past
   * its content or led by a tab. As in replaceValue, the spliced text is parsed again rather than copying the
   * parser's rules for those lines.
   */
  function checkedSplice(parsed, path, value, build) {
    const edits = build(quoteTextEndingInBlankLine);
    if (!hasMultilineText(value) || readsBackAs(parsed, edits, path, value)) return edits;
    return build(quoteMultilineText);
  }

  function hasMultilineText(value) {
    if (typeof value === 'string') return value.includes('\n');
    return isCollectionValue(value) && Object.values(value).some(hasMultilineText);
  }

  function hasBlockScalar(node) {
    return (YAML.isScalar(node) && isBlockScalarNode(node)) || childNodes(node).some(hasBlockScalar);
  }

  // Whether the data at `path` reads back as `value` (its scalars as text) once `edits` are applied to the document.
  function readsBackAs(parsed, edits, path, value) {
    return JSON.stringify(dataAt(parse(applyEdits(parsed.text, edits)), path)) === JSON.stringify(asText(value));
  }

  // The data at `path` in the document; undefined when the path names nothing.
  function dataAt(parsed, path) {
    return path.reduce((data, segment) => (data == null ? undefined : data[segment]), toData(parsed));
  }

  // `value` as toData would read it back; an empty value, which a moved entry may hold, stays null.
  function asText(value) {
    if (value === null) return null;
    if (Array.isArray(value)) return value.map(asText);
    if (isCollectionValue(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, asText(child)]));
    return String(value);
  }

  return {
    parse,
    toData,
    rangeOf,
    flowText,
    applyEdits,
    stringifyFragment,
    replaceValue,
    renameKey,
    setEntry,
    deleteEntry,
    insertItem,
    appendItem,
    deleteItem,
    moveItem,
    moveEntry,
    differingSpan,
  };
});
