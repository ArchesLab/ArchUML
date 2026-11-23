(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../de-operations.js'), require('../de-scene.js'), require('./te-schemas.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.textRead) parts.textRead = factory(parts.operations, parts.scene, parts.textSchemas);
  }
})(typeof self !== 'undefined' ? self : this, function (operationsPart, scenePart, schemasPart) {
  // Reading ArchUML text (UML-view editing spec §3.2, §3.4 contents, §3.6): the lexical helpers and the grammar the
  // rewrites share (relation lines, members, declarations, layout metadata, bodies, fragments), and readContents, what a
  // document means as the session and the commands ask for it. `textGrammar` is one table of the grammar that needs the
  // diagram type or the bundle's parsers, which are passed in as arguments.
  //
  // Moved from the inline script of _includes/uml-editor.html without a changed statement (plan Task 21, spec
  // §3.6); every function reads only its arguments: the text, the diagram type, the operation, and the bundle.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var revisionOf = operationsPart.revisionOf;
  var isSequenceKeyword = schemasPart.isSequenceKeyword;
  // Two helpers that know no grammar, which the core's scene owns since plan Task 38 (a host surface loads the core
  // alone); this part hands them on under the same names.
  var layoutRouteStorageKey = scenePart.layoutRouteStorageKey;
  var clonePointsOf = scenePart.clonePointsOf;

  // ─── The text adapter (spec 2026-11-12 §3.4, §3.6; stage R1) ───
  // The editor changes its document in one way: a command builds an operation from the drawing, and
  // the text adapter asks that operation's rewrite for the new text and hands it to the host's write.
  // A rewrite, and every grammar function below, reads only its arguments (the text, the diagram
  // type, the operation, and the bundle's parsers), never the page, a clock, or a global, so a logged
  // operation replays outside the page. The UML editor's session and host, still in its include,
  // reach the grammar they call by name through aliases of this part at the top of their script.

  function normalizeLineEndings(text) {
    return (text || '').replace(/\r\n?/g, '\n');
  }

  function normalizeLayoutMode(mode) {
    var value = (mode || '').toLowerCase();
    if (value === 'lr') value = 'horizontal';
    if (value === 'tb') value = 'vertical';
    if (value === 'tight') value = 'compact';
    if (value === 'square' || value === 'landscape' || value === 'portrait' || value === 'auto' ||
        value === 'horizontal' || value === 'vertical' || value === 'compact' || value === 'none') {
      return value;
    }
    return null;
  }

  function isLayoutModeDirective(line) {
    var trimmed = String(line || '').trim();
    if (!/^layout\s+/i.test(trimmed)) return false;
    if (/^layout\s+shadows\b/i.test(trimmed)) return false;
    var body = trimmed.replace(/^layout\s+/i, '').trim().split(/\s+/)[0];
    return !!normalizeLayoutMode(body);
  }

  function applyLayoutDirective(text, layoutMode) {
    var normalizedText = normalizeLineEndings(text);
    var lines = normalizedText.split('\n');
    var filtered = [];
    for (var i = 0; i < lines.length; i++) {
      if (isLayoutModeDirective(lines[i])) continue;
      filtered.push(lines[i]);
    }

    var mode = normalizeLayoutMode(layoutMode);
    if (!mode) return filtered.join('\n');

    var insertAt = 0;
    while (insertAt < filtered.length && !filtered[insertAt].trim()) insertAt++;
    if (insertAt < filtered.length && filtered[insertAt].trim() === '@startuml') insertAt++;
    filtered.splice(insertAt, 0, 'layout ' + mode);
    return filtered.join('\n');
  }

  function unquoteId(text) {
    return String(text || '').trim().replace(/^"((?:[^"\\]|\\.)*)"$/, '$1').replace(/\\"/g, '"');
  }

  function insertPos(line, pos) {
    // Coordinates written here flow into the diagram source and then into
    // localStorage via autosave. A non-finite value (e.g. NaN from an
    // interrupted drag) would serialize as the literal "@pos(NaN, …)" and
    // corrupt the saved draft on reload, so clamp non-finite values to 0.
    var px = isFinite(pos.x) ? Math.round(pos.x) : 0;
    var py = isFinite(pos.y) ? Math.round(pos.y) : 0;
    var suffix = ' @pos(' + px + ', ' + py + ')';
    var brace = line.match(/(\s*\{.*)$/);
    if (brace) return line.slice(0, -brace[1].length) + suffix + brace[1];
    return line + suffix;
  }

  function cloneRoutes(routes) {
    var copy = Object.create(null);
    Object.keys(routes || {}).forEach(function (id) {
      var route = routes[id];
      if (!route || !route.points || route.points.length < 2) return;
      copy[id] = {
        points: route.points.map(function (p) { return { x: Number(p.x), y: Number(p.y) }; })
      };
    });
    return copy;
  }


  function tokenizeRelationParts(text) {
    var tokens = [];
    // A bracketed group is one token even with spaces inside: an activity
    // guard `[is valid]`, a component `[Web App]`.
    var re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\[[^\]\s][^\]]*\]|\S+)/g;
    var m;
    while ((m = re.exec(String(text || '')))) {
      if (m[1] != null) {
        tokens.push({ value: unquoteId('"' + m[1] + '"'), quoted: true, start: m.index, end: re.lastIndex });
      } else if (m[2] != null) {
        tokens.push({ value: m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\'), quoted: true, start: m.index, end: re.lastIndex });
      } else {
        tokens.push({ value: m[3], quoted: false, start: m.index, end: re.lastIndex });
      }
    }
    return tokens;
  }

  function isRelationOperatorToken(token) {
    var op = String(token && token.value || '').trim();
    if (!op || token.quoted) return false;
    if (op === '..') return true;
    return /^[-.<=>|*ox]+$/.test(op) && /[-<=>|]/.test(op);
  }

  function relationTokenLooksLikeMultiplicity(token) {
    if (!token) return false;
    var value = String(token.value || '').trim();
    if (!value) return false;
    if (!token.quoted && /^\[[^\]]+\]$/.test(value)) return true;
    return /^[*0-9nNmM.]+$/.test(value) || /\.\./.test(value);
  }

  // The palette's tools and the ArchUML grammar that reads only its arguments: the rewrites below
  // and the editor's own code share them.

  function sequenceSourceWithScaffold(text) {
    var raw = normalizeLineEndings(text || '');
    if (!raw.trim()) return '@startuml\n@enduml';
    if (raw.indexOf('@startuml') === -1) return '@startuml\n' + raw.trim() + '\n@enduml';
    return raw;
  }

  function sourceWithScaffold(text) {
    var raw = normalizeLineEndings(text || '');
    if (!raw.trim()) return '@startuml\n@enduml';
    if (raw.indexOf('@startuml') === -1) return '@startuml\n' + raw.trim() + '\n@enduml';
    return raw;
  }

  function escapeQuoted(s) {
    return String(s || '').replace(/"/g, '\\"');
  }

  function formatActivityEndpointId(id) {
    var value = String(id || '').trim();
    if (!value) return value;
    if (value === '(*)' || /^__(?:initial|final)__/.test(value)) return '(*)';
    if (/^"((?:[^"\\]|\\.)*)"$/.test(value)) return value;
    return '"' + escapeQuoted(value) + '"';
  }

  // `type`, the diagram type, matters for a component diagram only.
  function formatRelationEndpointId(id, type) {
    var value = String(id || '').trim();
    if (!value) return value;
    if (/^"((?:[^"\\]|\\.)*)"$/.test(value)) return value;
    // A component connector names a component with spaces in brackets;
    // the component grammar reads a quoted endpoint as nothing at all.
    if (type === 'component') {
      if (/^\[[^\]]+\]$/.test(value)) return value;
      if (/\s/.test(value) && !/[\[\]"]/.test(value)) return '[' + value + ']';
    }
    return /\s|"/.test(value) ? '"' + escapeQuoted(value) + '"' : value;
  }

  function findInsertPointForDeclaration(lines) {
    // Insert just before @enduml, or at end if missing.
    for (var i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === '@enduml') return i;
    }
    return lines.length;
  }

  function firstGitgraphBranchName(lines) {
    for (var i = 0; i < lines.length; i++) {
      var m = String(lines[i] || '').trim().match(/^branch\s+([^\s:]+)(?:\s+from\s+\S+)?\s*:?\s*$/i);
      if (m) return m[1];
    }
    return '';
  }

  function clonePositions(positions) {
    var copy = Object.create(null);
    Object.keys(positions || {}).forEach(function (id) {
      var pos = positions[id];
      if (!pos || pos.x === undefined || pos.y === undefined) return;
      copy[id] = { x: Number(pos.x), y: Number(pos.y) };
    });
    return copy;
  }

  function clearSequenceMessageLayoutMetadata(positions, routes) {
    Object.keys(routes || {}).forEach(function (key) {
      if (/^seqmsg:/.test(key)) delete routes[key];
    });
    Object.keys(positions || {}).forEach(function (key) {
      if (/^(?:label:)?seqmsg:/.test(key) || /^label:seqmsg:/.test(key)) delete positions[key];
    });
  }

  function addElement(list, seen, id, label, axis) {
    id = unquoteId(id);
    label = unquoteId(label || id);
    if (!id || seen[id]) return;
    seen[id] = true;
    list.push({ id: id, label: label, axis: axis || 'xy' });
  }

  function activityLayoutIdForNode(node) {
    if (!node) return '';
    return node.type === 'action' ? (node.label || node.id) : node.id;
  }

  function activityLabelForNode(node) {
    if (!node) return '';
    if (node.type === 'initial') return 'Initial pseudostate';
    if (node.type === 'final') return 'Final pseudostate';
    if (node.type === 'fork') return 'Fork';
    if (node.type === 'join') return 'Join';
    if (node.type === 'decision' || node.type === 'merge') return node.label || 'Decision';
    return node.label || node.id;
  }

  function sequenceDisplay(id, label) {
    id = unquoteId(id);
    label = unquoteId(label || id);
    if (label.charAt(0) === ':') return label.replace(/^:\s*/, ': ');
    return id !== label ? id + ': ' + label : label;
  }

  // Source spans complement the renderer model when rewriting a declaration.
  function componentDeclaration(line) {
    const match = String(line || '').match(/^(\s*(?:component\s+)?)(\[[^\]]+\]|"(?:[^"\\]|\\.)*"|[^\s{]+)(?:\s+as\s+("(?:[^"\\]|\\.)*"|[^\s{]+))?/i);
    if (!match || (!/^\s*component\s/i.test(line) && match[2].charAt(0) !== '[')) return null;
    if (isRelationOperatorToken({ value: match[2] })) return null;
    if (isRelationOperatorToken({ value: String(line).slice(match[0].length).trim().split(/\s+/)[0] })) return null;
    const label = match[2].charAt(0) === '[' ? match[2].slice(1, -1).trim() : unquoteId(match[2]);
    const token = match[3] || match[2];
    const start = match[3] ? match[0].lastIndexOf(token) : match[1].length;
    return { id: match[3] ? unquoteId(match[3]) : label, label: label,
      start: start, end: start + token.length, headEnd: match[0].length };
  }

  // Venn names may contain spaces; separators only count outside quotes.
  // Keep offsets so edits retain the learner's separators and note prose.
  function vennReferenceSpans(text, offset) {
    if (/^(?:outside|none|\*)$/i.test(text.trim())) return [];
    const spans = [];
    let start = 0;
    let quoted = false;
    for (let index = 0; index <= text.length; index++) {
      if (text[index] === '"') quoted = !quoted;
      if (index < text.length && (quoted || !/[&+,∩]/.test(text[index]))) continue;
      const raw = text.slice(start, index);
      const token = raw.trim();
      if (token) {
        const tokenStart = offset + start + raw.indexOf(token);
        spans.push({ value: unquoteId(token), quoted: token[0] === '"', start: tokenStart, end: tokenStart + token.length });
      }
      start = index + 1;
    }
    return spans;
  }

  function sequenceLineKind(line) {
    var t = String(line || '').trim();
    if (/^actor\b/i.test(t)) return 'Actor';
    if (/^participant\b/i.test(t)) return 'Participant';
    if (/^activate\b/i.test(t)) return 'Activate';
    if (/^deactivate\b/i.test(t)) return 'Deactivate';
    if (/^create\b/i.test(t)) return 'Create';
    if (/^destroy\b/i.test(t)) return 'Destroy';
    if (/^note\b/i.test(t)) return 'Note';
    if (/^(alt|opt|loop|par|break|critical|ref|neg)\b/i.test(t)) return 'Fragment start';
    if (/^else\b/i.test(t)) return 'Fragment branch';
    if (/^end$/i.test(t)) return 'Fragment end';
    if (/^o->\s+\S+/i.test(t)) return 'Found message';
    if (/^\S+\s+->o\b/i.test(t)) return 'Lost message';
    // Mirror the renderer's arrows, including the right-to-left spellings.
    if (/^\S+\s+(?:--?>>|<<--?)\s+\S+/.test(t)) return 'Async message';
    if (/^\S+\s+(?:-->|<--)\s+\S+/.test(t)) return 'Return message';
    if (/^\S+\s+(?:->x|->\s*\*|->|<-)\s+\S+/.test(t)) return 'Sync message';
    return '';
  }

  function buildCrcCardSource(card) {
    var name = String(card.name || card.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    var quotedId = '"' + String(card.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    var sourceId = /^[A-Za-z_][\w.:-]*$/.test(card.id) ? card.id : quotedId;
    var header = card.name === card.id ? sourceId : '"' + name + '" as ' + sourceId;
    var lines = ['card ' + header + ' {'];
    card.responsibilities.forEach(function (text) { lines.push('  responsibility: ' + text); });
    card.collaborators.forEach(function (text) { lines.push('  collaborator: ' + text); });
    lines.push('}');
    return lines.join('\n');
  }

  function buildComponentBody(parsed, separator) {
    var pieces = parsed.ports.map(function (p) {
      var s = (p.kind || 'portin') + ' "' + escapeQuoted(p.label || '') + '"';
      if (p.alias && p.alias !== p.label) s += ' as ' + p.alias;
      if (p.dashed) s += ' dashed';
      return s;
    });
    pieces = pieces.concat(parsed.raw);
    return pieces.join(separator);
  }

  function cleanRelationMultiplicityToken(token) {
    var value = String(token && token.value || '').trim();
    var bracket = !token.quoted && value.match(/^\[([^\]]+)\]$/);
    return bracket ? bracket[1].trim() : value;
  }

  function joinRelationEndpointTokens(tokens) {
    return (tokens || []).map(function (token) {
      return String(token && token.value || '').trim();
    }).filter(Boolean).join(' ').trim();
  }

  function parseRelationEndpointTokens(tokens, side) {
    var list = (tokens || []).filter(function (token) {
      return token && String(token.value || '').trim();
    });
    var multiplicity = null;
    if (side === 'source' && list.length === 2 && list[0].quoted &&
        relationTokenLooksLikeMultiplicity(list[0]) && !relationTokenLooksLikeMultiplicity(list[1])) {
      // Tolerate the legacy `"1" A -- B` spelling.
      multiplicity = list.shift();
    } else if (side === 'target' && list.length >= 2 &&
        (list[0].quoted || /^\[[^\]]+\]$/.test(list[0].value))) {
      multiplicity = list.shift();
    } else if (list.length >= 2 &&
        (list[list.length - 1].quoted || /^\[[^\]]+\]$/.test(list[list.length - 1].value))) {
      multiplicity = list.pop();
    }
    return { id: joinRelationEndpointTokens(list),
      mult: multiplicity ? cleanRelationMultiplicityToken(multiplicity) : '', tokens: list };
  }

  // A namespace separator or a colon inside a quoted identifier is not a
  // relation label. Both property edits and reference rewrites use this split.
  function relationLabelIndex(text) {
    var quote = '';
    for (var index = 0; index < text.length; index++) {
      var char = text[index];
      if (quote) {
        if (char === '\\') { index++; continue; }
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ':' && text[index - 1] !== ':' && text[index + 1] !== ':') {
        return index;
      }
    }
    return -1;
  }

  function parseTokenizedRelationLine(text) {
    var tokens = tokenizeRelationParts(text);
    var opIdx = -1;
    for (var i = 0; i < tokens.length; i++) {
      if (isRelationOperatorToken(tokens[i])) { opIdx = i; break; }
    }
    if (opIdx <= 0 || opIdx >= tokens.length - 1) return null;
    var source = parseRelationEndpointTokens(tokens.slice(0, opIdx), 'source');
    var target = parseRelationEndpointTokens(tokens.slice(opIdx + 1), 'target');
    if (!source.id || !target.id) return null;
    return {
      kind: guessRelationKind(tokens[opIdx].value),
      label: '',
      sourceMult: source.mult,
      targetMult: target.mult,
      navigability: '',
      stereotype: '',
      source: source.id,
      target: target.id,
      op: tokens[opIdx].value
    };
  }

  function parseRelationLine(line) {
    var info = { kind: '', label: '', sourceMult: '', targetMult: '', navigability: '', stereotype: '', source: '', target: '', dashed: false };
    if (!line) return info;
    var t = line.trim();
    // Pull off label
    var labelIndex = relationLabelIndex(t);
    if (labelIndex >= 0) {
      var labRaw = t.slice(labelIndex + 1).trim();
      var sm = labRaw.match(/^<<\s*([^>]+?)\s*>>\s*(.*)$/);
      if (sm) { info.stereotype = '<<' + sm[1] + '>>'; info.label = sm[2].trim(); }
      else info.label = labRaw.trim();
      t = t.slice(0, labelIndex).trim();
    }
    if (/\s+dashed\s*$/i.test(t)) {
      info.dashed = true;
      t = t.replace(/\s+dashed\s*$/i, '');
    }
    var lost = t.match(/^(?:"((?:[^"\\]|\\.)*)"|(\S+))\s+->o\s*$/);
    if (lost) {
      info.source = lost[1] ? unquoteId('"' + lost[1] + '"') : lost[2];
      info.target = info.source;
      info.kind = 'lost';
      info.op = '->o';
      return finalizeParsedRelationInfo(info);
    }
    var found = t.match(/^o->\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*$/);
    if (found) {
      info.source = found[1] ? unquoteId('"' + found[1] + '"') : found[2];
      info.target = info.source;
      info.kind = 'found';
      info.op = 'o->';
      return finalizeParsedRelationInfo(info);
    }
    // An activity continuation (`--> [guard] Target`) flows from the node
    // before it, such as the decision that opens an if/else branch.
    var continuation = t.match(/^-->\s*(?:\[([^\]]*)\]\s*)?(\(\*\)|"(?:[^"\\]|\\.)*"|\S+)$/);
    if (continuation) {
      info.op = '-->';
      info.implicitSource = true;
      info.guard = continuation[1] || '';
      info.target = continuation[2].charAt(0) === '"' ? unquoteId(continuation[2]) : continuation[2];
      return finalizeParsedRelationInfo(info);
    }
    var tokenized = parseTokenizedRelationLine(t);
    if (tokenized) {
      tokenized.label = info.label;
      tokenized.stereotype = info.stereotype;
      tokenized.dashed = info.dashed;
      return finalizeParsedRelationInfo(tokenized);
    }
    var quotedBoth = t.match(/^"((?:[^"\\]|\\.)*)"\s+([-.\|<>=*ox]+)\s+"((?:[^"\\]|\\.)*)"$/);
    if (quotedBoth) {
      info.source = unquoteId('"' + quotedBoth[1] + '"');
      info.op = quotedBoth[2];
      info.kind = guessRelationKind(quotedBoth[2]);
      info.target = unquoteId('"' + quotedBoth[3] + '"');
      return finalizeParsedRelationInfo(info);
    }
    var quotedSource = t.match(/^"((?:[^"\\]|\\.)*)"\s+([-.\|<>=*ox]+)\s+(\S+)$/);
    if (quotedSource) {
      info.source = unquoteId('"' + quotedSource[1] + '"');
      info.op = quotedSource[2];
      info.kind = guessRelationKind(quotedSource[2]);
      info.target = quotedSource[3];
      return finalizeParsedRelationInfo(info);
    }
    var quotedTarget = t.match(/^(\S+)\s+([-.\|<>=*ox]+)\s+"((?:[^"\\]|\\.)*)"$/);
    if (quotedTarget) {
      info.source = quotedTarget[1];
      info.op = quotedTarget[2];
      info.kind = guessRelationKind(quotedTarget[2]);
      info.target = unquoteId('"' + quotedTarget[3] + '"');
      return finalizeParsedRelationInfo(info);
    }
    // Pull source multiplicity after quoted endpoints have had a chance to
    // match. Otherwise `"Receive Order" --> "Validate Payment"` looks like a
    // multiplicity instead of a quoted activity node id.
    var firstQ = t.match(/^"((?:[^"\\]|\\.)*)"\s+(.*)$/);
    if (firstQ) { info.sourceMult = firstQ[1]; t = firstQ[2]; }
    // Tokens: source op (... maybe quote ...) target — handle ER form: A "N" -- B
    var lastQ = t.match(/^(\S+)\s+"((?:[^"\\]|\\.)*)"\s+([-.\|<>=*ox]+)\s+(\S+)$/);
    if (lastQ) { info.source = lastQ[1]; info.sourceMult = info.sourceMult || lastQ[2]; var op0 = lastQ[3]; var tg0 = lastQ[4]; info.op = op0; info.kind = guessRelationKind(op0); info.target = tg0; return finalizeParsedRelationInfo(info); }
    var midQ = t.match(/^(\S+)\s+([-.\|<>=*ox]+)\s+"((?:[^"\\]|\\.)*)"\s+(\S+)$/);
    if (midQ) { info.source = midQ[1]; info.op = midQ[2]; info.kind = guessRelationKind(midQ[2]); info.targetMult = midQ[3]; info.target = midQ[4]; return finalizeParsedRelationInfo(info); }
    var simple = t.match(/^(\S+)\s+([-.\|<>=*ox]+)\s+(\S+)$/);
    if (simple) { info.source = simple[1]; info.op = simple[2]; info.kind = guessRelationKind(simple[2]); info.target = simple[3]; }
    return finalizeParsedRelationInfo(info);
  }

  function relationNavigabilityFromOp(op) {
    op = String(op || '').trim();
    if (/^(\*|o)<-->$/.test(op)) return 'bidirectional';
    if (/^(\*|o)-->$/.test(op)) return 'navigable';
    if (/^(\*|o)--x$/.test(op)) return 'nonnav';
    if (op === '<-->') return 'bidirectional';
    if (op === '-->' || op === '<--') return 'navigable';
    if (op === '--x') return 'nonnav';
    if (op === 'x--' || op === 'x--x') return 'nonnav';
    return '';
  }

  function finalizeParsedRelationInfo(info) {
    if (!info) return info;
    var reverseOps = {
      '<|--': { op: '--|>', kind: 'gen' },
      '<|..': { op: '..|>', kind: 'real' },
      '<..': { op: '..>', kind: 'depend' },
      '--*': { op: '*--', kind: 'compose' },
      '<--*': { op: '*-->', kind: 'compose', navigability: 'navigable' },
      '<-->*': { op: '*<-->', kind: 'compose', navigability: 'bidirectional' },
      'x--*': { op: '*--x', kind: 'compose', navigability: 'nonnav' },
      '--o': { op: 'o--', kind: 'aggregate' },
      '<--o': { op: 'o-->', kind: 'aggregate', navigability: 'navigable' },
      '<-->o': { op: 'o<-->', kind: 'aggregate', navigability: 'bidirectional' },
      'x--o': { op: 'o--x', kind: 'aggregate', navigability: 'nonnav' }
    };
    var reverse = reverseOps[info.op || ''];
    if (reverse) {
      var oldSource = info.source;
      info.source = info.target;
      info.target = oldSource;
      var oldSourceMult = info.sourceMult;
      info.sourceMult = info.targetMult;
      info.targetMult = oldSourceMult;
      info.op = reverse.op;
      info.kind = reverse.kind;
      info.navigability = reverse.navigability || relationNavigabilityFromOp(info.op);
    } else if (!info.kind && info.op) {
      info.kind = guessRelationKind(info.op);
    }
    if (!info.navigability) info.navigability = relationNavigabilityFromOp(info.op);
    var associationEnds = String(info.op || '').match(/^[*o]?([<x]?)--([>x]?)$/);
    if (associationEnds) {
      info.sourceNavigability = associationEnds[1] === '<' ? 'navigable' : (associationEnds[1] === 'x' ? 'nonnav' : '');
      info.targetNavigability = associationEnds[2] === '>' ? 'navigable' : (associationEnds[2] === 'x' ? 'nonnav' : '');
    }
    return info;
  }

  // The palette kind that a freeform operator is a style of.
  function freeformRelationKind(op) {
    if (op === '<--' || op === '<..' || op === '<==') return 'back';
    if (op === '<->' || op === '<..>' || op === '<==>') return 'both';
    if (op === '--') return 'plain';
    if (op === '..>' || op === '..') return 'dash';
    if (op === '==>' || op === '==') return 'thick';
    if (op === '-->') return 'arrow';
    return '';
  }

  function guessRelationKind(op) {
    var t = (op || '').trim();
    if (t === '--|>') return 'gen';
    if (t === '..|>') return 'real';
    if (t.charAt(0) === '*') return 'compose';
    if (t.charAt(0) === 'o') return 'aggregate';
    if (t === '<-->') return 'biassoc';
    if (t === '-->') return 'assoc';
    if (/^[<x]?--[>x]?$/.test(t) && t !== '--') return 'assoc';
    if (t === '..>') return 'depend';
    if (t === '--') return 'plain';
    if (t === '==') return 'total';
    if (t === '->') return 'sync';
    if (t === '->>') return 'async';
    if (t === '-->>') return 'asyncReply';
    if (t === '->o') return 'lost';
    if (t === 'o->') return 'found';
    return '';
  }

  function normalizeRelationInfoForType(info, type, lineText) {
    if (!info) return info;
    var op = info.op || '';
    if (!op && lineText) {
      var m = String(lineText).match(/\s([-.\|<>=*ox]+)\s/);
      op = m ? m[1] : '';
    }
    if (type === 'state' && (op === '-->' || info.kind === 'assoc')) info.kind = 'transition';
    if (type === 'activity' && (op === '-->' || info.kind === 'assoc')) info.kind = 'flow';
    if (type === 'activity') {
      // Activity flows carry guards, not multiplicities: `"A" --> [ok] "B"`.
      if (info.targetMult && !info.guard) { info.guard = info.targetMult; info.targetMult = ''; }
      // A flow shows one text, and a guard is it unless a `: label` is
      // written. Edit whichever one the diagram shows.
      if (info.guard && !info.label) { info.label = info.guard; info.labelIsGuard = true; }
    }
    if ((type === 'component' || type === 'deployment') && info.kind === 'assoc') info.kind = 'arrow';
    if (type === 'sequence' && op === '-->' && info.kind === 'assoc') info.kind = 'return';
    if (type === 'freeform') {
      info.kind = freeformRelationKind(op) || (info.kind === 'assoc' ? 'arrow' : info.kind);
    }
    if (type === 'usecase') {
      if (/^<<\s*include\s*>>$/i.test(info.stereotype || '')) info.kind = 'include';
      else if (/^<<\s*extend\s*>>$/i.test(info.stereotype || '')) info.kind = 'extend';
      else if (op === '-->' || info.kind === 'assoc') info.kind = 'arrow';
    }
    return info;
  }

  // Everything buildRelationLine needs to re-emit a parsed relation in its form.
  function relationLineOptions(info) {
    return {
      label: info.label, sourceMult: info.sourceMult, targetMult: info.targetMult,
      navigability: info.navigability, sourceNavigability: info.sourceNavigability,
      targetNavigability: info.targetNavigability, stereotype: info.stereotype, dashed: info.dashed,
      guard: info.guard, labelIsGuard: info.labelIsGuard, implicitSource: info.implicitSource, op: info.op
    };
  }


  // The relation written on `lineText` (a line of the document without its layout metadata, or '' for
  // none), read for the diagram type as the editor reads a drawn route's line: ends the line does not
  // name come from a route id that names them (edge:A|B).
  function relationOfLine(lineText, type, routeId) {
    var info = parseRelationLine(lineText);
    normalizeRelationInfoForType(info, type, lineText);
    var ends = String(routeId || '').match(/^edge:([^|]+)\|([^|]+)$/);
    if (ends) {
      info.source = info.source || ends[1];
      info.target = info.target || ends[2];
    }
    return info;
  }


  function routeIdForRelationInfo(routeId, info) {
    var m = String(routeId || '').match(/^edge:([^|]+)\|([^|]+)$/);
    return m ? 'edge:' + info.source + '|' + info.target : routeId;
  }

  function clearRouteLayoutForRewire(routes, positions, routeId, nextRouteId) {
    if (routes) {
      delete routes[routeId];
      if (nextRouteId !== routeId) delete routes[nextRouteId];
    }
    if (positions) {
      delete positions['label:' + routeId];
      if (nextRouteId !== routeId) delete positions['label:' + nextRouteId];
    }
  }

  function invertedRouteId(routeId) {
    var m = String(routeId || '').match(/^edge:([^|]+)\|([^|]+)$/);
    return m ? 'edge:' + m[2] + '|' + m[1] : routeId;
  }

  function reverseSavedRoute(routes, routeId, nextRouteId, bundle) {
    if (!routes || !routeId || !routes[routeId]) return;
    var route = routes[routeId];
    if (!route || !route.points || route.points.length < 2) return;
    var reversed = { points: clonePointsOf(route.points, bundle).reverse() };
    if (nextRouteId !== routeId) delete routes[routeId];
    routes[nextRouteId] = reversed;
  }

  function moveRelationLabelPosition(positions, routeId, nextRouteId) {
    if (!positions || !routeId || !nextRouteId || routeId === nextRouteId) return;
    var oldLabelId = 'label:' + routeId;
    var newLabelId = 'label:' + nextRouteId;
    if (!positions[oldLabelId]) return;
    positions[newLabelId] = positions[oldLabelId];
    delete positions[oldLabelId];
  }

  function statePseudoInfoForId(id) {
    var m = String(id || '').match(/^__(initial|final)__(\d+)$/);
    if (!m) return null;
    return {
      kind: m[1],
      ordinal: Number(m[2]),
      label: m[1] === 'initial' ? 'Initial pseudostate' : 'Final pseudostate'
    };
  }

  function parseMemberLine(line) {
    var t = line.trim();
    var member = { visibility: '', isAbstract: false, isStatic: false, text: t };
    var m = t.match(/^([+\-#~])\s*(.*)$/);
    if (m) { member.visibility = m[1]; t = m[2]; }
    while (true) {
      var mod = t.match(/^\{(abstract|static)\}\s*(.*)$/i);
      if (!mod) break;
      if (mod[1].toLowerCase() === 'abstract') member.isAbstract = true;
      if (mod[1].toLowerCase() === 'static') member.isStatic = true;
      t = mod[2];
    }
    member.text = t;
    return member;
  }

  function buildClassLine(info) {
    var keyword;
    if (info.kind === 'abstract' || info.isAbstract && info.kind === 'class') keyword = 'abstract class';
    else if (info.kind === 'interface') keyword = 'interface';
    else if (info.kind === 'enum') keyword = 'enum';
    else keyword = 'class';
    const declarationName = info.declarationLabel == null ? info.name : info.declarationLabel;
    var line = keyword + ' ' + (/[\s"]/.test(declarationName) ? '"' + escapeQuoted(declarationName) + '"' : declarationName);
    if (info.declarationLabel != null) line += ' as ' + formatRelationEndpointId(info.name);
    if (info.stereotype) line += ' ' + info.stereotype;
    if (info.highlight) line += ' #' + String(info.highlight).replace(/^#/, '');
    if (info.texture) line += ' ' + info.texture;
    if (info.rawAfter) line += ' ' + info.rawAfter;
    if (info.members && info.members.length) {
      var memberLines = info.members.map(function (m) {
        var s = m.visibility || '';
        if (m.isAbstract) s += ' {abstract}';
        if (m.isStatic) s += ' {static}';
        s += ' ' + (m.text || '').trim();
        return s.trim();
      });
      // The renderer splits single-line bodies on every semicolon. Keep
      // quoted defaults in multiline bodies so adding a member cannot split
      // an existing string value into additional members.
      if (info.members.some(function (m) { return (m.text || '').indexOf(';') !== -1; })) {
        line += ' {\n  ' + memberLines.join('\n  ') + '\n}';
      } else {
        line += ' { ' + memberLines.join('; ') + ' }';
      }
    }
    return line;
  }

  function sequenceArgumentReferenceSpans(line) {
    const labelIndex = relationLabelIndex(line);
    if (labelIndex < 0 || !tokenizeRelationParts(line.slice(0, labelIndex)).some(isRelationOperatorToken)) return [];
    const call = line.slice(labelIndex + 1).match(/^\s*[A-Za-z_$][\w$]*\s*\(/);
    if (!call) return [];
    const offset = labelIndex + 1 + call[0].length;
    const tokens = Array.from(line.slice(offset).matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][\w$]*|[^\s]/g));
    const spans = [];
    let depth = 1;
    for (let index = 0; index < tokens.length && depth > 0; index++) {
      const token = tokens[index];
      if (token[0] === '(') depth++;
      if (token[0] === ')') depth--;
      const before = index ? tokens[index - 1][0] : '(';
      const after = tokens[index + 1] && tokens[index + 1][0];
      if (/^[A-Za-z_$][\w$]*$/.test(token[0]) && ['(', ',', '['].includes(before) && [')', ',', ']'].includes(after)) {
        spans.push({ value: token[0], start: offset + token.index, end: offset + token.index + token[0].length });
      }
    }
    return spans;
  }

  function parseSequenceHeadText(text, fallbackId) {
    var raw = String(text || '').trim();
    if (!raw) return null;
    if (raw.charAt(0) === ':') {
      return { id: fallbackId, label: raw.replace(/^:\s*/, ': ') };
    }
    var colonIdx = raw.indexOf(':');
    if (colonIdx !== -1) {
      var idPart = raw.substring(0, colonIdx).trim();
      var labelPart = raw.substring(colonIdx + 1).trim();
      if (!idPart && labelPart) return { id: fallbackId, label: ': ' + labelPart.replace(/^:\s*/, '') };
      if (idPart) {
        var parsedId = identifierFromInlineLabel(idPart);
        return { id: parsedId || fallbackId, label: labelPart || idPart };
      }
    }
    return { id: fallbackId, label: raw };
  }

  function identifierFromInlineLabel(label) {
    var raw = String(label || '').trim();
    if (!raw) return '';
    // Letters and digits of any script are identifier characters: `Zähler`
    // stays `Zähler`. Everything else becomes an underscore.
    var cleaned = raw.replace(/[^\p{L}\p{N}_]/gu, '_').replace(/^_+|_+$/g, '');
    if (!cleaned) return '';
    if (!/^[\p{L}_]/u.test(cleaned)) cleaned = '_' + cleaned;
    return cleaned;
  }

  // ArchUML grammar that needs the diagram type or the bundle's parsers, passed in as arguments.
  var textGrammar = (function () {
    function stripLayoutMetadata(text, type) {
      var lines = normalizeLineEndings(text).split('\n');
      var out = [];
      var inLayout = false;
      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        var trimmed = raw.trim();
        if (/^@layout\b/i.test(trimmed)) { inLayout = true; continue; }
        if (/^@endlayout\b/i.test(trimmed)) { inLayout = false; continue; }
        if (inLayout) continue;
        if (type === 'crc' && /^(?:responsibility|collaborator)\s*:/i.test(trimmed)) {
          out.push(raw);
          continue;
        }
        // Permissive @pos strip: tolerate any content inside the parens
        // (decimals, scientific notation, extra whitespace) so a hand-edited
        // source can't carry stale metadata through to the renderer. The
        // canonical writer only emits integer x/y, but a learner who types
        // `@pos( 10 , 20 )` or pastes scientific notation should still
        // render cleanly.
        out.push(raw.replace(/\s+@pos\([^)]*\)/gi, ''));
      }
      return out.join('\n');
    }

    function readLayoutRoutes(text, bundle) {
      if (!bundle.UMLShared || !bundle.UMLShared.extractLayoutMetadata) return {};
      return cloneRoutes(bundle.UMLShared.extractLayoutMetadata(text).layout.routes);
    }

    function routePointsToString(points, bundle) {
      if (bundle.UMLShared && bundle.UMLShared.layoutRoutePointsToString) {
        return bundle.UMLShared.layoutRoutePointsToString(points);
      }
      return (points || []).map(function (p) {
        return Number(p.x) + ',' + Number(p.y);
      }).join(' ');
    }

    function appendLayoutBlock(out, positions, routes, bundle) {
      var block = [];
      Object.keys(positions || {}).forEach(function (id) {
        var p = positions[id];
        block.push('node "' + id.replace(/"/g, '\\"') + '" x=' + Math.round(p.x) + ' y=' + Math.round(p.y || 0));
      });
      Object.keys(routes || {}).forEach(function (id) {
        var route = routes[id];
        if (!route || !route.points || route.points.length < 2) return;
        block.push('edge "' + id.replace(/"/g, '\\"') + '" points="' + routePointsToString(route.points, bundle) + '"');
      });
      if (!block.length) return;

      var insertAt = 0;
      while (insertAt < out.length && !out[insertAt].trim()) insertAt++;
      if (out[insertAt] && out[insertAt].trim() === '@startuml') insertAt++;
      out.splice.apply(out, [insertAt, 0].concat(['@layout schema=1 renderer="archuml-visual-editor"'], block, ['@endlayout']));
    }

    function declarationIdForLine(line, type, bundle) {
      var clean = line.trim();
      var m;
      m = clean.match(/^note\s+as\s+(\S+)/i);
      if (m) return unquoteId(m[1]);
      if (type === 'class') {
        // A class may itself be named Class or Interface. Its outgoing arrow
        // is a relation, not a declaration whose identifier is the operator.
        var tokens = tokenizeRelationParts(clean);
        if (isRelationOperatorToken(tokens[1]) ||
            (relationTokenLooksLikeMultiplicity(tokens[1]) && isRelationOperatorToken(tokens[2]))) return null;
        // The name ends at whitespace or at the body's brace: `class Foo{`.
        m = clean.match(/^(?:abstract\s+class|class|interface|enum)\s+("[^"]+"|[^\s{]+)(?:\s+as\s+([^\s{]+))?/i);
        return m ? unquoteId(m[2] || m[1]) : null;
      }
      if (type === 'sequence') {
        if (!/^(?:participant|actor)\s/i.test(clean)) return null;
        const participant = bundle.UMLSequenceDiagram.parse(stripLayoutMetadata(clean, type)).participants[0];
        return participant ? unquoteId(participant.id) : null;
      }
      if (type === 'state') {
        m = clean.match(/^(?:state|choice)\s+("[^"]+"|[^\s{]+)/i);
        return m ? unquoteId(m[1]) : null;
      }
      if (type === 'component') {
        const component = componentDeclaration(clean);
        if (component) return component.id;
        m = clean.match(/^(?:portin|portout|port|provide|require)\s+(?:"([^"]+)"|(\S+))(?:\s+as\s+(\S+))?/i);
        return m ? unquoteId(m[3] || m[1] || m[2]) : null;
      }
      if (type === 'deployment') {
        m = clean.match(/^node\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
        if (m) return unquoteId(m[2] || m[1]);
        m = clean.match(/^component\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
        if (m) return unquoteId(m[2] || m[1]);
        m = clean.match(/^artifact\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
        return m ? unquoteId(m[2] || m[1]) : null;
      }
      if (type === 'usecase') {
        m = clean.match(/^actor\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
        if (m) return unquoteId(m[2] || m[1]);
        m = clean.match(/^usecase\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
        if (m) return unquoteId(m[2] || m[1]);
        m = clean.match(/^rectangle\s+("[^"]+"|\S+)(?:\s+as\s+("[^"]+"|\S+))?/i);
        return m ? unquoteId(m[2] || m[1]) : null;
      }
      if (type === 'freeform') {
        m = clean.match(/^box(?:\s+[a-z]+)?\s+"(?:[^"\\]|\\.)*"\s+as\s+(\S+)/i);
        return m ? unquoteId(m[1]) : null;
      }
      if (type === 'crc') {
        m = clean.match(/^card\s+("(?:[^"\\]|\\.)*"|[^\s{]+)(?:\s+as\s+("(?:[^"\\]|\\.)*"|[^\s{]+))?/i);
        return m ? unquoteId(m[2] || m[1]) : null;
      }
      if (type === 'er') {
        m = clean.match(/^(entity|weak\s+entity|relationship|identifying\s+relationship)\s+("[^"]+"|\S+)/i);
        return m ? unquoteId(m[2]) : null;
      }
      if (type === 'gitgraph') {
        m = clean.match(/^\s*(\S+)(?:\s+merge\s+\S+|\s+"(?:[^"\\]|\\.)*"|\s*)$/);
        return m && !/^(branch|head|@startuml|@enduml)\b/i.test(m[1]) ? unquoteId(m[1]) : null;
      }
      if (type === 'venn') {
        m = clean.match(/^set\s+(?:"([^"]+)"|(.+?))(?:\s+#(?:[0-9a-fA-F]{3,8}|[A-Za-z][A-Za-z0-9]*))?\s*$/i);
        return m ? unquoteId(m[1] || m[2]) : null;
      }
      return null;
    }

    function writePositionsIntoSource(text, type, positions, routeOverrides, bundle) {
      var routes = routeOverrides || readLayoutRoutes(text, bundle);
      var lines = stripLayoutMetadata(text, type).split('\n');
      var remaining = Object.create(null);
      Object.keys(positions || {}).forEach(function (id) { remaining[id] = positions[id]; });
      var out = [];

      for (var i = 0; i < lines.length; i++) {
        var id = declarationIdForLine(lines[i], type, bundle);
        if (id && remaining[id]) {
          out.push(insertPos(lines[i], remaining[id]));
          delete remaining[id];
        } else {
          out.push(lines[i]);
        }
      }

      var leftover = Object.keys(remaining);
      var blockPositions = {};
      leftover.forEach(function (id) { blockPositions[id] = remaining[id]; });
      appendLayoutBlock(out, blockPositions, routes, bundle);

      return out.join('\n');
    }

    function ownedElementIds(text, type, parentId, bundle) {
      const parser = type === 'state' ? bundle.UMLStateDiagram : type === 'deployment' ? bundle.UMLDeploymentDiagram : null;
      if (!parser || !parser.parse) return [];
      const model = parser.parse(stripLayoutMetadata(text, type));
      const elements = model.states || model.elements || [];
      const owned = new Set([parentId]);
      let changed = true;
      while (changed) {
        changed = false;
        elements.forEach(function (element) {
          const parent = type === 'state' ? element.parent : element.parentId;
          if (parent && owned.has(parent) && !owned.has(element.name)) {
            owned.add(element.name);
            changed = true;
          }
        });
      }
      return Array.from(owned).filter(function (id) { return id !== parentId; });
    }

    // How the elements of a deployment document nest, read from its braces: each element by id (with
    // its label and parent), whether one is a nested node, and the nodes around one, nearest first.
    function deploymentNesting(text, type, bundle) {
      var model = bundle.UMLDeploymentDiagram.parse(stripLayoutMetadata(text, type));
      var byId = model.elementMap || {};
      function isNestedNode(id) { return !!(byId[id] && byId[id].kind === 'node' && byId[id].parentId); }
      function ancestorsOf(id) {
        var chain = [];
        for (var parent = byId[id] && byId[id].parentId; parent && byId[parent] && chain.indexOf(parent) === -1; parent = byId[parent].parentId) chain.push(parent);
        return chain;
      }
      return {
        elements: model.elements,
        byId: byId,
        label: function (id) { return byId[id] ? byId[id].label || id : id; },
        isNestedNode: isNestedNode,
        ancestorsOf: ancestorsOf
      };
    }

    // The declaration line of each lifeline of `ids` in the text without its layout, or null when one
    // of them has no declaration line to move.
    function sequenceLifelineDeclarations(text, ids, bundle) {
      var lines = stripLayoutMetadata(text, 'sequence').split('\n');
      var declLineByIds = {};
      var declLineIdxs = [];
      for (var i = 0; i < lines.length; i++) {
        var declId = declarationIdForLine(lines[i], 'sequence', bundle);
        if (declId && ids.indexOf(declId) !== -1) {
          declLineByIds[declId] = lines[i];
          declLineIdxs.push(i);
        }
      }
      if (declLineIdxs.length !== ids.length) return null; // missing decls — bail
      return { lines: lines, lineById: declLineByIds, indices: declLineIdxs };
    }

    function maskDeclarationNotes(lines, bundle) {
      const masked = lines.slice();
      for (let index = 0; index < lines.length; index++) {
        const noteEnd = bundle.UMLShared.parseNoteLine(lines[index].trim(), lines, index, []);
        if (noteEnd < index) continue;
        for (let noteLine = index; noteLine <= noteEnd && noteLine < lines.length; noteLine++) {
          // Keep offsets stable: callers splice the original source by the
          // boundaries found here, while note prose is never brace syntax.
          masked[noteLine] = ' '.repeat(lines[noteLine].length);
        }
        index = noteEnd;
      }
      return masked;
    }

    function declarationBraceRange(text, bundle) {
      text = maskDeclarationNotes(text.split('\n'), bundle).map(function (line) {
        return /^\s*'/.test(line) ? ' '.repeat(line.length) : line;
      }).join('\n');
      let start = -1;
      let depth = 0;
      let quote = '';
      for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quote) {
          if (char === '\\') { index++; continue; }
          if (char === quote) quote = '';
          continue;
        }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '{') { if (start < 0) start = index; depth++; }
        if (char === '}' && start >= 0 && --depth === 0) return { start: start, end: index };
      }
      return start < 0 ? null : { start: start, end: text.length };
    }

    function declarationEndIndex(lines, start, bundle) {
      const searchable = maskDeclarationNotes(lines, bundle);
      let depth = 0;
      let opened = false;
      let quoted = false;
      for (let i = start; i < lines.length; i++) {
        if (/^\s*'/.test(lines[i])) continue;
        for (let j = 0; j < searchable[i].length; j++) {
          const char = searchable[i][j];
          if (char === '\\' && quoted) { j++; continue; }
          if (char === '"') quoted = !quoted;
          if (!quoted && char === '{') { depth++; opened = true; }
          if (!quoted && char === '}') depth--;
        }
        if (!opened || depth <= 0) return i;
        if (/^\s*@enduml\b/.test(lines[i + 1] || '')) return i;
      }
      return lines.length - 1;
    }

    function sourceLinesWithoutNotes(text, type, bundle) {
      var lines = stripLayoutMetadata(text, type).split('\n');
      for (var i = 0; i < lines.length; i++) {
        var noteEnd = bundle.UMLShared.parseNoteLine(lines[i].trim(), lines, i, []);
        if (noteEnd < i) continue;
        for (var j = i; j <= noteEnd && j < lines.length; j++) lines[j] = '';
        i = noteEnd;
      }
      return lines;
    }

    function findDeclarationLineIndex(text, type, id, bundle) {
      var lines = sourceLinesWithoutNotes(text, type, bundle);
      for (var i = 0; i < lines.length; i++) {
        if (declarationIdForLine(lines[i], type, bundle) === id) return i;
      }
      return -1;
    }

    function getDeclarationLine(text, type, id, bundle) {
      var idx = findDeclarationLineIndex(text, type, id, bundle);
      if (idx === -1) return null;
      var lines = stripLayoutMetadata(text, type).split('\n');
      return lines.slice(idx, declarationEndIndex(lines, idx, bundle) + 1).join('\n');
    }

    function readLayoutPositions(text, type, bundle) {
      if (!bundle.UMLShared || !bundle.UMLShared.extractLayoutMetadata) return {};
      var layout = type === 'crc' ? bundle.UMLCRCDiagram.parse(text).layout : bundle.UMLShared.extractLayoutMetadata(text).layout;
      return clonePositions(layout.positions);
    }

    function relationLineIndices(text, type, bundle) {
      if (type === 'crc') return [];
      // Return indices of source lines that look like a relation (have a connector
      // operator) and aren't declarations themselves.
      var lines = stripLayoutMetadata(text, type).split('\n');
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (!t || /^@/.test(t) || /^layout\s+/i.test(t)) continue;
        if (declarationIdForLine(lines[i], type, bundle)) continue;
        if (/^(activate|deactivate|destroy|create|note\b|portin\b|portout\b|fork|endfork|if\s+|else|endif|\|)/i.test(t)) continue;
        if (type === 'sequence' && (/^\S+\s+->o\b/i.test(t) || /^o->\s+\S+/i.test(t))) {
          out.push(i);
          continue;
        }
        // Must contain a connector + endpoints. Use the same tolerant token
        // parser as the properties pane so variants such as o<--> and *--x
        // remain selectable even when the renderer exposes an ordinal route id.
        var labelIndex = relationLabelIndex(t);
        if (parseTokenizedRelationLine(labelIndex < 0 ? t : t.slice(0, labelIndex))) out.push(i);
      }
      return out;
    }

    // Keep source-indexed layout identities attached to the same surviving line.
    // Each edit replaces an inclusive range; insertions use end = start - 1.
    function rewriteSourceLines(text, type, edits, positions, routes, bundle) {
      const lines = stripLayoutMetadata(text, type).split('\n');
      const result = [];
      const lineMap = {};
      let cursor = 0;
      edits.sort(function (a, b) { return a.start - b.start; }).forEach(function (edit) {
        while (cursor < edit.start) { lineMap[cursor] = result.length; result.push(lines[cursor++]); }
        if (edit.replacement != null) {
          if (edit.end >= edit.start) lineMap[edit.start] = result.length;
          const replacement = String(edit.replacement).split('\n');
          let nextMatch = 1;
          for (let oldLine = edit.start + 1; oldLine <= edit.end; oldLine++) {
            const matching = replacement.findIndex(function (line, index) { return index >= nextMatch && line.trim() === lines[oldLine].trim(); });
            if (matching >= 0) {
              lineMap[oldLine] = result.length + matching;
              nextMatch = matching + 1;
            }
          }
          result.push.apply(result, replacement);
        }
        cursor = Math.max(cursor, edit.end + 1);
      });
      while (cursor < lines.length) { lineMap[cursor] = result.length; result.push(lines[cursor++]); }
      const oldRelations = relationLineIndices(text, type, bundle);
      const newRelations = relationLineIndices(result.join('\n'), type, bundle);
      function mappedKey(key, isRoute) {
        let match = key.match(/^(rel:|seqmsg:|note:|actbar:)(\d+)$/);
        if (match) return lineMap[Number(match[2])] == null ? null : match[1] + lineMap[Number(match[2])];
        if (!isRoute) return key;
        match = key.match(/^(edge[-:_])?(\d+)$/);
        if (!match) return key;
        const nextLine = lineMap[oldRelations[Number(match[2])]];
        const nextOrdinal = newRelations.indexOf(nextLine);
        return nextOrdinal < 0 ? null : (match[1] || '') + nextOrdinal;
      }
      const nextRoutes = {};
      routes = routes || readLayoutRoutes(text, bundle);
      Object.keys(routes).forEach(function (key) {
        const next = mappedKey(key, true);
        if (next != null) nextRoutes[next] = routes[key];
      });
      const nextPositions = {};
      positions = positions || readLayoutPositions(text, type, bundle);
      Object.keys(positions).forEach(function (key) {
        const label = key.indexOf('label:') === 0;
        const next = mappedKey(label ? key.slice(6) : key, label);
        if (next != null) nextPositions[(label ? 'label:' : '') + next] = positions[key];
      });
      return writePositionsIntoSource(result.join('\n'), type, nextPositions, nextRoutes, bundle);
    }

    // For multi-line declarations, replace the entire block (decl line + body) with a
    // single-line form (or new multi-line form). predicate(lines[i]) identifies the
    // decl line.
    function replaceBlockByMatch(text, type, predicate, newLine, bundle) {
      var lines = stripLayoutMetadata(text, type).split('\n');
      var searchable = sourceLinesWithoutNotes(text, type, bundle);
      for (var i = 0; i < lines.length; i++) {
        if (!predicate(searchable[i], i)) continue;
        return rewriteSourceLines(text, type, [{ start: i, end: declarationEndIndex(lines, i, bundle), replacement: newLine }], undefined, undefined, bundle);
      }
      return text;
    }

    function collectModelElements(text, type, bundle) {
      var lines = stripLayoutMetadata(text, type).split('\n');
      var elements = [];
      var seen = Object.create(null);
      var stateInitialCount = 0;
      var stateFinalCount = 0;

      if (type === 'crc') {
        return bundle.UMLCRCDiagram.parse(text).cards.map(function (card) {
          return { id: card.id, label: card.name, axis: 'xy' };
        });
      }
      if (type === 'component' && bundle.UMLComponentDiagram) {
        // The renderer's model of the text without its layout (`@pos` would end a name).
        const model = bundle.UMLComponentDiagram.parse(lines.join('\n'));
        model.components.forEach(function (component) {
          addElement(elements, seen, component.name, model.displayNameMap[component.name] || component.label || component.name,
            component.standalonePort ? 'port' : 'xy');
          if (!component.standalonePort) component.ports.forEach(function (port) {
            addElement(elements, seen, component.name + '.' + port.alias, port.name, 'port');
          });
        });
      }
      if (type === 'deployment' && bundle.UMLDeploymentDiagram) {
        var deployment = bundle.UMLDeploymentDiagram.parse(text);
        (deployment.elements || []).forEach(function (item) {
          addElement(elements, seen, item.name, item.label || item.name);
        });
      }
      if (type === 'sequence') {
        bundle.UMLSequenceDiagram.parse(lines.join('\n')).participants.forEach(function (participant) {
          const label = participant.isInstance && participant.id === participant.label
            ? participant.id + ': ' + participant.label
            : sequenceDisplay(participant.id, participant.label);
          addElement(elements, seen, participant.id, label, 'x');
        });
      }

      if (type === 'activity' &&
          bundle.UMLActivityDiagram && typeof bundle.UMLActivityDiagram.parse === 'function') {
        try {
          var activityParsed = bundle.UMLActivityDiagram.parse(stripLayoutMetadata(text, type));
          (activityParsed.nodes || []).forEach(function (node) {
            addElement(elements, seen, activityLayoutIdForNode(node), activityLabelForNode(node));
          });
          return elements;
        } catch (activityParseError) {
          // Fall through to the lightweight source scan below.
        }
      }

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line === '@startuml' || line === '@enduml' || /^layout\s+/i.test(line)) continue;
        var m;
        if (type !== 'gitgraph' && type !== 'folder-tree' && type !== 'er' && /^note\s+(left|right|top|bottom|over)\b/i.test(line)) {
          var noteLine = line.match(/^note\s+(left|right|top|bottom|over)\s+(?:of\s+)?(\S+)\s*:\s*(.+)$/i);
          var noteLabel = noteLine ? noteLine[3].trim() : 'Note';
          if (!noteLine) {
            for (var ni = i + 1; ni < lines.length; ni++) {
              var nt = lines[ni].trim();
              if (/^end\s*note$/i.test(nt)) break;
              if (nt) { noteLabel = nt; break; }
            }
          }
          addElement(elements, seen, 'note:' + i, noteLabel || 'Note', 'note');
          continue;
        }

        if (type === 'class') {
          m = line.match(/^(?:abstract\s+class|class|interface|enum)\s+("[^"]+"|[^\s{]+)(?:\s+as\s+([^\s{]+))?/i);
          if (m) addElement(elements, seen, m[2] || m[1], m[1]);
        } else if (type === 'sequence') {
          // Participants already come from the renderer's model; note prose
          // and declaration order must not invent different editable heads.
          continue;
        } else if (type === 'state') {
          m = line.match(/^state\s+("[^"]+"|[^\s{]+)/i);
          if (m) addElement(elements, seen, m[1], m[1]);
          var stateRel = parseRelationLine(line);
          if (stateRel && stateRel.source && stateRel.target && /->/.test(stateRel.op || '')) {
            if (stateRel.source === '[*]') {
              addElement(elements, seen, '__initial__' + stateInitialCount, 'Initial pseudostate');
              stateInitialCount++;
            } else {
              addElement(elements, seen, stateRel.source, stateRel.source);
            }
            if (stateRel.target === '[*]') {
              addElement(elements, seen, '__final__' + stateFinalCount, 'Final pseudostate');
              stateFinalCount++;
            } else {
              addElement(elements, seen, stateRel.target, stateRel.target);
            }
          }
        } else if (type === 'component') {
          // Components and their ports already come from the renderer model.
          continue;
        } else if (type === 'deployment') {
          m = line.match(/^node\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
          if (m) addElement(elements, seen, m[2] || m[1], m[1]);
          m = line.match(/^component\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
          if (m) addElement(elements, seen, m[2] || m[1], m[1]);
          m = line.match(/^artifact\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
          if (m) addElement(elements, seen, m[2] || m[1], m[1]);
        } else if (type === 'usecase') {
          m = line.match(/^actor\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
          if (m) addElement(elements, seen, m[2] || unquoteId(m[1]), unquoteId(m[1]));
          m = line.match(/^usecase\s+("[^"]+"|\S+)(?:\s+as\s+(\S+))?/i);
          if (m) addElement(elements, seen, m[2] || unquoteId(m[1]), unquoteId(m[1]));
          m = line.match(/^rectangle\s+("[^"]+"|\S+)(?:\s+as\s+("[^"]+"|\S+))?/i);
          if (m) addElement(elements, seen, m[2] || unquoteId(m[1]), unquoteId(m[1]));
        } else if (type === 'activity') {
          // A line like `"Receive Order" --> "Validate Payment"` declares two
          // movable activity nodes. Capture every quoted token, not just the
          // first — otherwise nodes that only appear as the target of a
          // transition (e.g. `"Validate Payment"` above, which never appears
          // again as the start of another transition) silently lose their
          // movable handle.
          var quotedRe = /"([^"]+)"/g;
          var quotedMatch;
          while ((quotedMatch = quotedRe.exec(line)) !== null) {
            addElement(elements, seen, quotedMatch[1], quotedMatch[1]);
          }
        } else if (type === 'freeform') {
          m = line.match(/^box(?:\s+[a-z]+)?\s+"((?:[^"\\]|\\.)*)"\s+as\s+(\S+)/i);
          if (m) addElement(elements, seen, m[2], m[1].replace(/\\n/g, '\n'));
        } else if (type === 'gitgraph') {
          m = line.match(/^branch\s+([^:\s]+)(?:\s+(?:from|at)\s+\S+)?\s*:?\s*$/i);
          if (m) {
            addElement(elements, seen, 'branch:' + m[1], m[1], 'branch-label');
            continue;
          }
          m = line.match(/^\s*(\S+)(?:\s+merge\s+\S+)?(?:\s+"((?:[^"\\]|\\.)*)")?\s*$/i);
          if (m && !/^(branch|head|@startuml|@enduml)\b/i.test(m[1])) addElement(elements, seen, m[1], m[1]);
        } else if (type === 'venn') {
          m = line.match(/^set\s+(?:"([^"]+)"|(.+?))(?:\s+#(?:[0-9a-fA-F]{3,8}|[A-Za-z][A-Za-z0-9]*))?\s*$/i);
          if (m) addElement(elements, seen, m[1] || m[2], m[1] || m[2]);
        } else if (type === 'er') {
          m = line.match(/^(entity|weak\s+entity|relationship|identifying\s+relationship)\s+("[^"]+"|\S+)/i);
          if (m) addElement(elements, seen, m[2], m[2]);
        }
      }
      return elements;
    }

    function existingIds(text, type, bundle) {
      var seen = Object.create(null);
      collectModelElements(text, type, bundle).forEach(function (e) {
        var id = String(e.id || '');
        if (id) seen[id] = true;
        if (id.indexOf('.') !== -1) seen[id.split('.')[0]] = true;
      });
      // Also pre-seed with raw declarations (e.g., aliases, rectangles) the visual
      // editor doesn't otherwise list — protects against accidental ID collisions.
      var lines = stripLayoutMetadata(text, type).split('\n');
      lines.forEach(function (line) {
        var m = line.match(/\bas\s+([A-Za-z_][\w-]*)/);
        if (m) seen[m[1]] = true;
      });
      const parser = type === 'state' ? bundle.UMLStateDiagram : type === 'deployment' ? bundle.UMLDeploymentDiagram : null;
      if (parser && parser.parse) {
        const model = parser.parse(stripLayoutMetadata(text, type));
        (model.states || model.elements || []).forEach(function (element) { if (element.name) seen[element.name] = true; });
      }
      return seen;
    }

    function generateUniqueId(text, type, base, bundle) {
      var taken = existingIds(text, type, bundle);
      var safe = String(base || 'New').replace(/[^A-Za-z0-9_]/g, '') || 'New';
      function isFree(id) { return !taken[id] && !isSequenceKeyword(type, id); }
      // Try base, base2, base3... so the first new element gets a clean name.
      if (isFree(safe)) return safe;
      var i = 2;
      while (!isFree(safe + i)) i++;
      return safe + i;
    }

    function buildElementLine(spec, id, opts, type) {
      opts = opts || {};
      // Pseudostates / activity special tokens are written by the relation, not as
      // a standalone declaration line. The caller checks `spec.pseudo` / `activityPseudo`.
      if (spec.activityPseudo) return null;
      if (spec.pseudo) return null;
      if (spec.activityDecision || spec.activityFork || spec.activityLane) return null;

      var label = opts.label || id;
      var stereotype = opts.stereotype || spec.fixedStereotype || '';
      var line;

      if (spec.keyword === 'card') {
        return buildCrcCardSource({ id: id, name: label, responsibilities: [], collaborators: [] });
      }

      if (spec.isNote) {
        // note as id "text"
        line = 'note as ' + id + ' "' + escapeQuoted(label) + '"';
      } else if (spec.isPort) {
        // portin/portout "Label" as id
        line = spec.portKind + ' "' + escapeQuoted(label) + '" as ' + id;
      } else if (spec.isInterface) {
        // provide/require "Label" as id
        line = spec.interfaceKind + ' "' + escapeQuoted(label) + '" as ' + id;
      } else if (spec.freeformShape) {
        line = 'box' + (spec.freeformShape && spec.freeformShape !== 'rect' ? ' ' + spec.freeformShape : '') +
          ' "' + escapeQuoted(label).replace(/\n/g, '\\n') + '" as ' + id;
      } else if (spec.keyword === 'usecase') {
        // A name with spaces cannot be an alias: the quoted name is the identity.
        line = 'usecase "' + escapeQuoted(label) + '"' + (/\s/.test(id) ? '' : ' as ' + id);
      } else if (spec.keyword === 'rectangle') {
        line = 'rectangle "' + escapeQuoted(label) + '"' + (label !== id ? ' as ' + formatRelationEndpointId(id, type) : '') + ' { }';
      } else if (spec.keyword === 'artifact') {
        line = 'artifact "' + escapeQuoted(label) + '" as ' + id;
      } else if (spec.keyword === 'set') {
        line = 'set ' + (/\s|"/.test(label) ? '"' + escapeQuoted(label) + '"' : label);
      } else if (spec.gitBranch) {
        line = 'branch ' + id + ':';
      } else if (spec.gitCommit) {
        line = '  ' + id + ' "' + escapeQuoted(label || 'Commit message') + '"';
      } else if (spec.folderTreeKind === 'folder') {
        line = String(label || id).replace(/\/+$/, '') + '/';
      } else if (spec.folderTreeKind === 'file') {
        line = String(label || id).replace(/\/+$/, '');
      } else if (spec.keyword === 'actor' && (type === 'sequence' || type === 'usecase')) {
        if (type === 'sequence') {
          line = 'actor ' + id + ': ' + label;
        } else if (id !== label && !/\s/.test(id)) {
          line = 'actor "' + escapeQuoted(label) + '" as ' + id;
        } else {
          line = 'actor ' + formatRelationEndpointId(id, type);
        }
      } else if (spec.keyword === 'participant') {
        line = 'participant ' + id + ': ' + label;
      } else if (spec.keyword === 'action') {
        line = '"' + escapeQuoted(label) + '"';
      } else if (spec.keyword === '(*)') {
        line = null;
      } else if ((spec.keyword === 'component' || spec.keyword === 'node') && label !== id) {
        line = spec.keyword + ' "' + escapeQuoted(label) + '" as ' + formatRelationEndpointId(id, type);
      } else if (spec.keyword) {
        line = spec.keyword + ' ' + formatRelationEndpointId(id, type);
      } else {
        line = id;
      }

      if (line && stereotype) {
        line = line.replace(/(\s*\{[^}]*\}|\s*$)$/, ' ' + stereotype + '$1');
      }
      if (line && opts.highlight) {
        line += ' #' + opts.highlight.replace(/^#/, '');
      }
      if (line && opts.texture) {
        line += ' ' + opts.texture;
      }

      if (opts.abstract && spec.id === 'class') {
        line = line.replace(/^class\b/, 'abstract class');
      }
      if (opts.dashed && spec.keyword === 'component') {
        line = line + ' dashed';
      }
      return line;
    }

    function addElementToSource(text, type, spec, opts, bundle) {
      opts = opts || {};
      // Activity (*) doesn't need its own line — caller usually creates an arrow
      // already containing it. Just preserve text.
      if (spec.activityPseudo) return text;
      // State pseudostates: same — they live inside transitions.
      if (spec.pseudo) return text;

      var positions = readLayoutPositions(text, type, bundle);
      var routes = readLayoutRoutes(text, bundle);
      var clean = stripLayoutMetadata(text, type);
      var lines = clean.split('\n');
      var declLine = buildElementLine(spec, opts.id, opts, type);
      if (declLine == null) return text;
      var insertAt = findInsertPointForDeclaration(lines);
      lines.splice(insertAt, 0, declLine);
      if (opts.position) {
        positions[opts.id] = { x: Math.round(opts.position.x), y: Math.round(opts.position.y) };
      }
      return writePositionsIntoSource(lines.join('\n'), type, positions, routes, bundle);
    }

    function buildRelationLine(spec, sourceId, targetId, opts, type) {
      opts = opts || {};
      var op = spec.op;
      // A new relation starts with its default label. An existing one states
      // its label, and an empty one stays empty.
      var label = opts.label != null ? opts.label : (spec.defaultLabel || '');
      if (type === 'sequence' && spec.sequenceSingle === 'lost') {
        return formatRelationEndpointId(sourceId, type) + ' ->o' + (label ? ' : ' + label : '');
      }
      if (type === 'sequence' && spec.sequenceSingle === 'found') {
        return 'o-> ' + formatRelationEndpointId(targetId, type) + (label ? ' : ' + label : '');
      }
      // Composition / aggregation navigability: combine '*--' or 'o--' with the
      // navigability variant.
      if (opts.navigability === 'navigable' && spec.id === 'compose') op = '*-->';
      if (opts.navigability === 'bidirectional' && spec.id === 'compose') op = '*<-->';
      if (opts.navigability === 'nonnav' && spec.id === 'compose') op = '*--x';
      if (opts.navigability === 'navigable' && spec.id === 'aggregate') op = 'o-->';
      if (opts.navigability === 'bidirectional' && spec.id === 'aggregate') op = 'o<-->';
      if (opts.navigability === 'nonnav' && spec.id === 'aggregate') op = 'o--x';
      if (/^(plain|assoc|biassoc)$/.test(spec.id || '')) {
        if (opts.navigability === 'navigable') op = '-->';
        if (opts.navigability === 'bidirectional') op = '<-->';
        if (opts.navigability === 'nonnav') op = '--x';
      }
      if (type === 'class' && /^(plain|assoc|biassoc|compose|aggregate)$/.test(spec.id || '')) {
        if (opts.sourceNavigability != null && opts.targetNavigability != null) {
          var diamond = spec.id === 'compose' ? '*' : (spec.id === 'aggregate' ? 'o' : '');
          var sourceMark = opts.sourceNavigability === 'navigable' ? '<' : (opts.sourceNavigability === 'nonnav' ? 'x' : '');
          var targetMark = opts.targetNavigability === 'navigable' ? '>' : (opts.targetNavigability === 'nonnav' ? 'x' : '');
          op = diamond + sourceMark + '--' + targetMark;
        }
      }

      // Freeform has more line styles than palette entries (`<..>`, `==`).
      // An edit that keeps the relation's kind keeps the style it was drawn in.
      if (type === 'freeform' && opts.op && freeformRelationKind(opts.op) === spec.id) op = opts.op;

      if (type === 'activity') {
        var actHead = opts.implicitSource ? op : formatActivityEndpointId(sourceId) + ' ' + op;
        var guard = opts.labelIsGuard ? label : opts.guard;
        var actLine = actHead + ' ' + (guard ? '[' + guard + '] ' : '') + formatActivityEndpointId(targetId);
        if (label && !opts.labelIsGuard) actLine += ' : ' + label;
        return actLine;
      }

      var src = formatRelationEndpointId(sourceId, type);
      var tgt = formatRelationEndpointId(targetId, type);
      if (opts.sourceMult) src = src + ' "' + escapeQuoted(opts.sourceMult) + '"';
      if (opts.targetMult) tgt = '"' + escapeQuoted(opts.targetMult) + '" ' + tgt;

      // For ER, the cardinality goes in quotes before the entity, like `Student "N" -- Borrows`.
      // We surface it via `sourceMult` / `targetMult` already, but the entity-quote
      // ordering differs: cardinality follows the entity name. Correct that for ER.
      if (type === 'er') {
        src = formatRelationEndpointId(sourceId, type) + (opts.sourceMult ? ' "' + escapeQuoted(opts.sourceMult) + '"' : '');
        tgt = (opts.targetMult ? '"' + escapeQuoted(opts.targetMult) + '" ' : '') + formatRelationEndpointId(targetId, type);
      }

      var line = src + ' ' + op + ' ' + tgt;
      if ((type === 'component' || type === 'deployment') && opts.dashed) {
        line += ' dashed';
      }
      var stereo = opts.stereotype || spec.stereotype || '';
      if (stereo && label) line += ' : ' + stereo + ' ' + label;
      else if (stereo) line += ' : ' + stereo;
      else if (label) line += ' : ' + label;
      return line;
    }

    function addRelationToSource(text, type, spec, sourceId, targetId, opts, bundle) {
      opts = opts || {};
      var positions = readLayoutPositions(text, type, bundle);
      var routes = readLayoutRoutes(text, bundle);
      var clean = stripLayoutMetadata(text, type);
      var lines = clean.split('\n');
      var requestedInsert = Number(opts.insertAtLine);
      var insertAt = Number.isFinite(requestedInsert)
        ? Math.max(0, Math.min(lines.length, Math.round(requestedInsert)))
        : findInsertPointForDeclaration(lines);
      var line = buildRelationLine(spec, sourceId, targetId, opts, type);
      if (type === 'sequence' && Number.isFinite(requestedInsert)) {
        clearSequenceMessageLayoutMetadata(positions, routes);
      }
      if (type === 'sequence' && spec.sequenceCreate) {
        lines.splice(insertAt, 0, 'create ' + targetId);
        insertAt++;
      }
      lines.splice(insertAt, 0, line);
      return writePositionsIntoSource(lines.join('\n'), type, positions, routes, bundle);
    }

    function appendRawLine(text, type, line, bundle) {
      var positions = readLayoutPositions(text, type, bundle);
      var routes = readLayoutRoutes(text, bundle);
      var clean = stripLayoutMetadata(text, type);
      var lines = clean.split('\n');
      lines.splice(findInsertPointForDeclaration(lines), 0, line);
      return writePositionsIntoSource(lines.join('\n'), type, positions, routes, bundle);
    }

    function parseBraceBody(line, bundle) {
      const text = String(line || '');
      const range = declarationBraceRange(text, bundle);
      return range ? text.slice(range.start + 1, range.end) : '';
    }

    function setBraceBody(line, body, multiline, bundle) {
      // Drop existing { ... } and append new body. If new body empty, drop entirely.
      const text = String(line || '');
      const range = declarationBraceRange(text, bundle);
      var stripped = range ? text.slice(0, range.start).trimEnd() : text;
      if (!body || !body.trim()) return stripped;
      if (multiline || /\n/.test(line)) return stripped + ' {\n' + body.trim() + '\n}';
      return stripped + ' { ' + body.trim() + ' }';
    }

    function bodyStatementRanges(body, groupNotes, bundle) {
      const statements = [];
      let start = 0;
      let depth = 0;
      let quoted = '';
      for (let index = 0; index <= body.length; index++) {
        if (groupNotes && index === start && !depth && !quoted && /^\s*note\b/.test(body.slice(start))) {
          const noteLines = body.slice(start).split('\n');
          const noteEnd = bundle.UMLShared.parseNoteLine(noteLines[0].trim(), noteLines, 0, []);
          if (noteEnd > 0) {
            const noteText = noteLines.slice(0, noteEnd + 1).join('\n');
            statements.push({ start: start, end: start + noteText.length, text: noteText });
            index = start + noteText.length;
            start = index + 1;
            continue;
          }
        }
        const char = body[index];
        if (!quoted && char === "'" && !body.slice(body.lastIndexOf('\n', index - 1) + 1, index).trim()) {
          // A line-leading apostrophe is a comment, not a member string.
          const newline = body.indexOf('\n', index);
          index = newline < 0 ? body.length - 1 : newline - 1;
          continue;
        }
        if (quoted && char === '\\') { index++; continue; }
        if (quoted && char === quoted) quoted = '';
        else if (!quoted && (char === '"' || char === "'")) quoted = char;
        if (!quoted && char === '{') depth++;
        if (!quoted && char === '}') depth--;
        if (index === body.length || (!quoted && depth === 0 && (char === ';' || char === '\n'))) {
          const statement = body.slice(start, index);
          if (statement.trim()) statements.push({ start: start, end: index, text: statement });
          start = index + 1;
        }
      }
      return statements;
    }

    function splitBodyStatements(body, bundle) {
      return bodyStatementRanges(body, undefined, bundle).map(function (statement) { return statement.text.trim(); });
    }

    function parseComponentBody(body, bundle) {
      // Body holds portin/portout/port and provide/require lines plus arbitrary
      // raw lines. Split by ; or \n.
      var pieces = splitBodyStatements(body || '', bundle);
      var ports = [];
      var raw = [];
      pieces.forEach(function (p) {
        var m = p.match(/^(portin|portout|port|provide|require)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+?))(?:\s+as\s+(\S+))?(?:\s+(dashed))?$/i);
        if (m) {
          ports.push({
            kind: m[1].toLowerCase(),
            label: m[2] || m[3],
            alias: m[4] || (m[2] || m[3]),
            dashed: !!m[5]
          });
        } else {
          raw.push(p);
        }
      });
      return { ports: ports, raw: raw };
    }

    // ArchUML splits a one-line body on ';' and a multi-line body on newlines,
    // so a rebuilt component keeps its declaration's form.
    function setComponentBody(declaration, parsed, bundle) {
      return setBraceBody(declaration, buildComponentBody(parsed, /\n/.test(declaration) ? '\n' : '; '), undefined, bundle);
    }

    function parseGenericElement(line, type, bundle) {
      var info = { name: '', label: '', stereotype: '', dashed: false, highlight: '', texture: '' };
      if (!line) return info;
      const bodyRange = declarationBraceRange(line, bundle);
      var t = (bodyRange ? line.slice(0, bodyRange.start) + line.slice(bodyRange.end + 1) : line).trim();
      if (bundle.UMLShared && bundle.UMLShared.parseHighlightColor) {
        var highlightInfo = bundle.UMLShared.parseHighlightColor(t);
        if (highlightInfo && (highlightInfo.highlight || highlightInfo.texture)) {
          t = highlightInfo.stripped;
          info.highlight = highlightInfo.highlight || '';
          info.texture = highlightInfo.texture || '';
        }
      }
      var st = t.match(/<<\s*([^>]+?)\s*>>/);
      if (st) info.stereotype = '<<' + st[1] + '>>';
      if (type === 'component') {
        const component = componentDeclaration(t);
        if (component) {
          info.name = component.id;
          info.label = component.label;
          info.dashed = /\bdashed\b/i.test(t.slice(component.headEnd));
          return info;
        }
      }
      if (type === 'sequence' && /^(?:participant|actor)\s/i.test(t)) {
        // Sequence `id as Class` runs in the opposite direction to the
        // generic `label as id` syntax. Use the renderer's declaration model.
        const participant = bundle.UMLSequenceDiagram.parse(t.replace(/\s*<<\s*[^>]+?\s*>>/, '')).participants[0];
        if (participant) {
          info.name = participant.id;
          info.label = participant.label;
        }
        return info;
      }
      var box = t.match(/^box(?:\s+([a-z]+))?\s+"((?:[^"\\]|\\.)*)"\s+as\s+(\S+)/i);
      if (box) {
        info.shape = (box[1] || 'rect').toLowerCase();
        info.label = box[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        info.name = box[3];
        return info;
      }
      var set = t.match(/^set\s+(?:"([^"]+)"|(.+?))\s*$/i);
      if (set) {
        info.name = unquoteId(set[1] || set[2]);
        info.label = info.name;
        return info;
      }
      var m = t.match(/^(actor|participant|state|node|component|usecase|artifact|entity|weak\s+entity|relationship|identifying\s+relationship|rectangle)\s+(.+)$/i);
      if (m) {
        var rest = m[2].trim();
        // pull body off
        rest = rest.replace(/\s*\{[\s\S]*\}\s*$/, '');
        rest = rest.replace(/\s*<<\s*[^>]+?\s*>>/, '');
        rest = rest.replace(/\s+dashed\b/i, function () { info.dashed = true; return ''; });
        // Patterns: "Label" as id   |   id: Label   |   "Label"   |   id
        var qm = rest.match(/^"((?:[^"\\]|\\.)*)"\s+as\s+("(?:[^"\\]|\\.)*"|\S+)$/);
        if (qm) { info.label = qm[1]; info.name = unquoteId(qm[2]); return info; }
        var asm = rest.match(/^(\S+)\s+as\s+(\S+)$/);
        if (asm) { info.label = unquoteId(asm[1]); info.name = asm[2]; return info; }
        var col = rest.match(/^(\S+)\s*:\s*(.+)$/);
        if (col) { info.name = col[1]; info.label = col[2].trim(); return info; }
        var quoted = rest.match(/^"((?:[^"\\]|\\.)*)"$/);
        if (quoted) { info.name = quoted[1]; info.label = quoted[1]; return info; }
        info.name = unquoteId(rest);
        info.label = info.name;
      }
      return info;
    }

    function parseSequenceModel(text, bundle) {
      var lines = stripLayoutMetadata(sequenceSourceWithScaffold(text), 'sequence').split('\n');
      var model = { participants: [], events: [] };
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var t = line.trim();
        if (!t || t === '@startuml' || t === '@enduml' || /^layout\s+/i.test(t)) continue;
        var kind = sequenceLineKind(t);
        if (!kind) continue;
        if (kind === 'Actor' || kind === 'Participant') {
          var parsed = parseGenericElement(line, 'sequence', bundle);
          model.participants.push({
            index: i,
            endIndex: i,
            kind: kind.toLowerCase(),
            id: parsed.name || declarationIdForLine(line, 'sequence', bundle) || '',
            label: parsed.label || parsed.name || '',
            line: line
          });
          continue;
        }
        var endIndex = i;
        if (/^note\b/i.test(t) && !/:/.test(t)) {
          for (var j = i + 1; j < lines.length; j++) {
            endIndex = j;
            if (/^end\s*note$/i.test(lines[j].trim())) break;
          }
        }
        model.events.push({
          index: i,
          endIndex: endIndex,
          kind: kind,
          line: lines.slice(i, endIndex + 1).join('\n')
        });
        i = endIndex;
      }
      return model;
    }

    function crcCardForId(text, id, bundle) {
      return bundle.UMLCRCDiagram.parse(text).cards.find(function (card) {
        return card.id === id;
      });
    }

    function componentPortForId(text, type, id, bundle) {
      if (type !== 'component' || id.lastIndexOf('.') < 0) return null;
      const owner = id.slice(0, id.lastIndexOf('.'));
      const declaration = getDeclarationLine(text, type, owner, bundle);
      if (!declaration) return null;
      const body = parseComponentBody(parseBraceBody(declaration, bundle), bundle);
      const index = body.ports.findIndex(function (port) { return owner + '.' + port.alias === id; });
      return index < 0 ? null : { owner: owner, declaration: declaration, body: body, index: index };
    }

    function idIsReferenceTo(candidate, id, text, type, bundle) {
      if (candidate === id) return true;
      if (type === 'venn') return candidate.toLowerCase() === id.toLowerCase();
      // Dotted class names are independent identities. Only component ports
      // belong to their dotted owner and follow an owner's rename/removal.
      if (type !== 'component' || candidate.indexOf(id + '.') !== 0) return false;
      const port = componentPortForId(text, 'component', candidate, bundle);
      return !!port && port.owner === id;
    }

    // Return only identifier spans: relation endpoints and directive targets.
    // Labels, comments, member names, and note prose are deliberately excluded.
    function referenceSpans(line, type, bundle) {
      if (/^\s*(?:@|'|\/\/)/.test(line) || declarationIdForLine(line, type, bundle)) return [];
      // Callout prose is never a model reference, even if it contains arrows.
      if (/^\s*callout\b/.test(line)) {
        const target = line.match(/^(\s*callout\s+(?:left|right|top|bottom)\s+of\s+element\s+)(\S+)(?=\s+:)/);
        return target ? [{ value: target[2], start: target[1].length, end: target[1].length + target[2].length }] : [];
      }
      const labelIndex = relationLabelIndex(line);
      if (type === 'venn') {
        const note = line.match(/^\s*note\s+(?:left|right|top|bottom|above|below)\s+of\s+/i);
        if (note || labelIndex >= 0) {
          const start = note ? note[0].length : 0;
          return vennReferenceSpans(line.slice(start, labelIndex < 0 ? line.length : labelIndex), start);
        }
      }
      const tokens = tokenizeRelationParts(labelIndex < 0 ? line : line.slice(0, labelIndex));
      const operator = tokens.findIndex(isRelationOperatorToken);
      if (operator >= 0) {
        return [parseRelationEndpointTokens(tokens.slice(0, operator), 'source'),
          parseRelationEndpointTokens(tokens.slice(operator + 1), 'target')]
          .filter(function (endpoint) { return endpoint.tokens.length; })
          .map(function (endpoint) {
            const first = endpoint.tokens[0];
            const last = endpoint.tokens[endpoint.tokens.length - 1];
            const id = type === 'component' ? endpoint.id.replace(/^\[([^\]]+)\]$/, '$1') : endpoint.id;
            return { value: id, quoted: endpoint.tokens.length === 1 && first.quoted,
              start: first.start, end: last.end };
          });
      }
      if (type === 'activity' && /^"(?:[^"\\]|\\.)+"$/.test(bundle.UMLShared.parseHighlightColor(line).stripped.trim())) {
        return tokens.slice(0, 1);
      }
      if (/^\s*(?:activate|deactivate|destroy|create)\b/i.test(line)) return tokens.slice(-1);
      if (type === 'state' && /^\s*(?:"(?:[^"\\]|\\.)*"|\S+)\s*:\s*(?:entry|exit|do)\s*\//i.test(line)) return tokens.slice(0, 1);
      if (/^\s*note\s+(?:left|right|top|bottom|over)\b/i.test(line)) {
        return tokens.slice(tokens.findIndex(function (token) { return /^(?:of|over)$/.test(token.value); }) + 1)
          .filter(function (token) { return !/^(?:note|left|right|top|bottom)$/.test(token.value); });
      }
      return [];
    }

    function renameDeclarationIdentifier(declaration, type, oldId, newId, bundle) {
      if (type === 'component') {
        const component = componentDeclaration(declaration);
        if (component) {
          const token = declaration.charAt(component.start) === '[' ? '[' + newId + ']' : formatRelationEndpointId(newId, type);
          return declaration.slice(0, component.start) + token + declaration.slice(component.end);
        }
      }
      if (type === 'sequence') {
        // A sequence declaration puts the id before either ':' or 'as'.
        // The generic alias grammar below puts it after 'as' instead.
        const prefix = declaration.match(/^\s*(?:participant|actor)\s+/i);
        if (!prefix || declaration.slice(prefix[0].length, prefix[0].length + oldId.length) !== oldId) return declaration;
        return declaration.slice(0, prefix[0].length) + newId + declaration.slice(prefix[0].length + oldId.length);
      }
      const range = declarationBraceRange(declaration, bundle);
      const headerEnd = range ? range.start : declaration.indexOf('\n');
      const header = headerEnd < 0 ? declaration : declaration.slice(0, headerEnd);
      const tokens = [];
      const re = /"(?:[^"\\]|\\.)*"|\S+/g;
      let match;
      while ((match = re.exec(header))) tokens.push({ text: match[0], start: match.index, end: re.lastIndex });
      const aliasIndex = tokens.findIndex(function (token) { return token.text === 'as'; });
      const token = aliasIndex >= 0 ? tokens[aliasIndex + 1] : tokens.find(function (candidate, index) { return index > 0 && unquoteId(candidate.text) === oldId; });
      if (!token) return declaration;
      // A use case without an alias is declared by its quoted name alone:
      // `usecase "Log In"`. An alias (`... as UC1`) is never quoted.
      const quotedByGrammar = aliasIndex < 0 && type === 'usecase' && /^\s*usecase\b/i.test(header);
      const renamed = quotedByGrammar ? '"' + escapeQuoted(newId) + '"' : formatRelationEndpointId(newId, type);
      return declaration.slice(0, token.start) + renamed + declaration.slice(token.end);
    }

    function declarationStatementRanges(declaration, type, bundle) {
      const statements = [];
      function collect(text, offset) {
        const range = declarationBraceRange(text, bundle);
        if (!range) { statements.push({ start: offset, end: offset + text.length, text: text }); return; }
        statements.push({ start: offset, end: offset + range.start, text: text.slice(0, range.start) });
        bodyStatementRanges(text.slice(range.start + 1, range.end), true, bundle).forEach(function (statement) {
          const start = offset + range.start + 1 + statement.start;
          if (declarationIdForLine(statement.text, type, bundle)) collect(statement.text, start);
          else statements.push({ start: start, end: offset + range.start + 1 + statement.end, text: statement.text });
        });
      }
      collect(declaration, 0);
      return statements;
    }

    function cloneDeclarationForDuplicate(source, type, declaration, oldId, newId, bundle) {
      const statements = declarationStatementRanges(declaration, type, bundle);
      const mapping = new Map([[oldId, newId]]);
      const taken = existingIds(source, type, bundle);
      taken[newId] = true;
      if (/^(state|deployment|usecase)$/.test(type)) {
        const owned = type === 'usecase' ? statements.map(function (statement) { return declarationIdForLine(statement.text, type, bundle); }) : ownedElementIds(source, type, oldId, bundle);
        owned.forEach(function (id) {
          if (!id || mapping.has(id)) return;
          let suffix = 2;
          let candidate = id;
          while (taken[candidate]) candidate = id + suffix++;
          taken[candidate] = true;
          mapping.set(id, candidate);
        });
      }
      function clonedReference(id) {
        if (mapping.has(id)) return mapping.get(id);
        if (idIsReferenceTo(id, oldId, source, type, bundle)) return newId + id.slice(oldId.length);
        return id;
      }
      let cloned = declaration;
      statements.reverse().forEach(function (statement) {
        const id = declarationIdForLine(statement.text, type, bundle);
        let changed = statement.text;
        if (id && mapping.has(id)) {
          changed = renameDeclarationIdentifier(changed, type, id, mapping.get(id), bundle);
        } else {
          const referenceLine = /^\s*note\b/.test(changed) ? changed.split('\n')[0] : changed;
          referenceSpans(referenceLine, type, bundle).reverse().forEach(function (span) {
            const next = clonedReference(span.value);
            if (next !== span.value) changed = changed.slice(0, span.start) + formatRelationEndpointId(next, type) + changed.slice(span.end);
          });
          if (type === 'usecase' && mapping.has(unquoteId(changed.trim()))) {
            changed = changed.replace(/\S[\s\S]*\S|\S/, formatRelationEndpointId(mapping.get(unquoteId(changed.trim())), type));
          }
        }
        cloned = cloned.slice(0, statement.start) + changed + cloned.slice(statement.end);
      });
      return cloned;
    }

    function sequenceParticipantRecords(text, bundle) {
      return parseSequenceModel(text, bundle).participants;
    }

    function sequenceDefaultPair(text, bundle) {
      var parts = sequenceParticipantRecords(text, bundle);
      if (parts.length >= 2) return { source: parts[0].id, target: parts[1].id };
      if (parts.length === 1) return { source: parts[0].id, target: parts[0].id };
      return { source: 'A', target: 'B' };
    }

    // A component's declaration with one more port or interface in its body.
    function componentDeclarationWithPort(line, spec, newPortId, label, bundle) {
      var body = parseBraceBody(line, bundle);
      var parsed = parseComponentBody(body, bundle);
      var kind = spec.isInterface ? spec.interfaceKind : spec.portKind;
      parsed.ports.push({ kind: kind, label: label, alias: newPortId, dashed: false });
      return setComponentBody(line, parsed, bundle);
    }

    function existingGitgraphBranchNames(text) {
      var seen = {};
      stripLayoutMetadata(text || '', 'gitgraph').split('\n').forEach(function (line) {
        var m = String(line || '').trim().match(/^branch\s+([^\s:]+)(?:\s+(?:from|at)\s+\S+)?\s*:?\s*$/i);
        if (m) seen[m[1]] = true;
      });
      return seen;
    }

    function uniqueGitgraphBranchName(text, base) {
      var taken = existingGitgraphBranchNames(text);
      var safe = String(base || 'branch').replace(/[^A-Za-z0-9_/-]/g, '') || 'branch';
      if (!taken[safe]) return safe;
      var i = 2;
      while (taken[safe + i]) i++;
      return safe + i;
    }

    // The row of a new branch of the framed git graph `source`: the first is main, a later one gets a
    // free name. Returns the row and the branch's name.
    function newGitgraphBranchRow(source) {
      var id = uniqueGitgraphBranchName(source, firstGitgraphBranchName(stripLayoutMetadata(source, 'gitgraph').split('\n')) ? 'branch' : 'main');
      return { line: 'branch ' + id + ':', id: id };
    }

    // The git graph framed, with a new branch after its rows. Returns the text and the branch's name.
    function addGitgraphBranchToSource(text, bundle) {
      var source = sourceWithScaffold(text);
      var row = newGitgraphBranchRow(source);
      return { text: appendRawLine(source, 'gitgraph', row.line, bundle), id: row.id };
    }

    // Where a new commit goes in the lines of a framed git graph: at the end of its first branch (a
    // graph without a branch starts branch main for it there). Returns the line it goes before (`at`),
    // the rows that go there, the commit's identifier, and its branch.
    function newGitgraphCommitRows(lines, bundle) {
      var type = 'gitgraph';
      var rows = [];
      var branchName = firstGitgraphBranchName(lines);
      var insertAt = findInsertPointForDeclaration(lines);
      if (!branchName) {
        branchName = 'main';
        rows.push('branch main:');
      } else {
        var branchIdx = -1;
        for (var i = 0; i < lines.length; i++) {
          if (String(lines[i] || '').trim().match(/^branch\s+/i)) { branchIdx = i; break; }
        }
        insertAt = branchIdx + 1;
        while (insertAt < lines.length &&
               !/^branch\b/i.test(String(lines[insertAt] || '').trim()) &&
               !/^head\b/i.test(String(lines[insertAt] || '').trim()) &&
               String(lines[insertAt] || '').trim() !== '@enduml') {
          insertAt++;
        }
      }
      var id = generateUniqueId(lines.slice(0, insertAt).concat(rows, lines.slice(insertAt)).join('\n'), type, 'C', bundle);
      rows.push('  ' + id + ' "Commit message"');
      return { at: insertAt, rows: rows, id: id, branch: branchName };
    }

    // The git graph framed, with a new commit at the end of its first branch. Returns the text, the
    // commit's identifier, and the branch.
    function addGitgraphCommitToSource(text, bundle) {
      var type = 'gitgraph';
      var positions = readLayoutPositions(text, type, bundle);
      var routes = readLayoutRoutes(text, bundle);
      var lines = stripLayoutMetadata(sourceWithScaffold(text), type).split('\n');
      var commit = newGitgraphCommitRows(lines, bundle);
      lines.splice.apply(lines, [commit.at, 0].concat(commit.rows));
      return { text: writePositionsIntoSource(lines.join('\n'), type, positions, routes, bundle), id: commit.id, branch: commit.branch };
    }

    // Why newId cannot become an element's identifier, or '' when it can.
    function identifierConflict(text, type, newId, bundle) {
      if (existingIds(text, type, bundle)[newId]) return '"' + newId + '" is already used. Pick a different identifier.';
      if (isSequenceKeyword(type, newId)) return '"' + newId + '" is a sequence-diagram keyword. Pick a different identifier.';
      return '';
    }

    function sequenceFragmentRanges(text, type, includeIncomplete, bundle) {
      var lines = sourceLinesWithoutNotes(text, type, bundle);
      var stack = [];
      var ranges = [];
      // A condition may be bracketed (`alt [ok]`) or bare (`loop each item`).
      var openRe = /^\s*(alt|opt|loop|par|break|critical|ref|neg)\b\s*(?:\[(.*?)\]|(\S.*?))?\s*$/i;
      var elseRe = /^\s*else\b\s*(?:\[(.*?)\]|(\S.*?))?\s*$/i;
      var endRe  = /^\s*end\s*$/i;
      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        var openMatch = raw.match(openRe);
        if (openMatch) {
          stack.push({
            id: 'frag:' + i,
            startIdx: i,
            kind: openMatch[1].toLowerCase(),
            condition: (openMatch[2] || openMatch[3] || '').trim(),
            branches: [],
            endIdx: -1
          });
          continue;
        }
        var elseMatch = raw.match(elseRe);
        if (elseMatch && stack.length) {
          stack[stack.length - 1].branches.push({
            lineIdx: i,
            condition: (elseMatch[1] || elseMatch[2] || '').trim()
          });
          continue;
        }
        if (endRe.test(raw) && stack.length) {
          var done = stack.pop();
          done.endIdx = i;
          ranges.push(done);
        }
      }
      // Editing operations require a complete source range. Diagnostics alone
      // inspect open drafts, without exposing negative end indexes to editing.
      return includeIncomplete ? ranges.concat(stack) : ranges;
    }

    function fragmentInfoForId(fragId, text, type, bundle) {
      var ranges = sequenceFragmentRanges(text, type, undefined, bundle);
      for (var i = 0; i < ranges.length; i++) {
        if (ranges[i].id === fragId) return ranges[i];
      }
      return null;
    }

    function statePseudoRelationLineIndex(text, type, id) {
      var info = statePseudoInfoForId(id);
      if (!info) return -1;
      var lines = stripLayoutMetadata(text, type).split('\n');
      var count = 0;
      for (var i = 0; i < lines.length; i++) {
        var rel = parseRelationLine(lines[i]);
        if (!rel || !rel.source || !rel.target) continue;
        var matches = info.kind === 'initial' ? rel.source === '[*]' : rel.target === '[*]';
        if (!matches) continue;
        if (count === info.ordinal) return i;
        count++;
      }
      return -1;
    }

    function virtualNoteLineRange(id, text, type) {
      var m = String(id || '').match(/^note:(\d+)$/);
      if (!m) return null;
      var start = Number(m[1]);
      var lines = stripLayoutMetadata(text, type).split('\n');
      if (start < 0 || start >= lines.length) return null;
      if (!/^note\s+(left|right|top|bottom|over)\b/i.test(lines[start].trim())) return null;
      var end = start;
      if (!/:/.test(lines[start])) {
        for (var i = start + 1; i < lines.length; i++) {
          end = i;
          if (/^end\s*note$/i.test(lines[i].trim())) break;
        }
      }
      return { start: start, end: end, lines: lines };
    }

    function replaceLineByMatch(text, type, predicate, newLine, bundle) {
      var lines = stripLayoutMetadata(text, type).split('\n');
      var searchable = sourceLinesWithoutNotes(text, type, bundle);
      for (var i = 0; i < lines.length; i++) {
        if (predicate(searchable[i], i)) {
          return rewriteSourceLines(text, type, [{ start: i, end: i, replacement: newLine }], undefined, undefined, bundle);
        }
      }
      return text;
    }

    function removeRelationLine(text, type, lineIndex, bundle) {
      var positions = readLayoutPositions(text, type, bundle);
      var routes = readLayoutRoutes(text, bundle);
      var clean = stripLayoutMetadata(text, type);
      var lines = clean.split('\n');
      if (lineIndex < 0 || lineIndex >= lines.length) return text;
      return rewriteSourceLines(text, type, [{ start: lineIndex, end: lineIndex }], positions, routes, bundle);
    }

    function rewriteUsecaseMembershipReferences(text, oldId, newId, bundle) {
      const lines = stripLayoutMetadata(text, 'usecase').split('\n');
      const edits = [];
      for (let index = 0; index < lines.length; index++) {
        if (!/^\s*rectangle\b/i.test(lines[index])) continue;
        const end = declarationEndIndex(lines, index, bundle);
        const declaration = lines.slice(index, end + 1).join('\n');
        const body = parseBraceBody(declaration, bundle);
        const changed = body.replace(/(^|[;\n])(\s*)("(?:[^"\\]|\\.)*"|[^\s;{}]+)(\s*)(?=[;\n]|$)/g, function (match, delimiter, before, token, after) {
          if (unquoteId(token) !== oldId) return match;
          return delimiter + before + (newId == null ? '' : formatRelationEndpointId(newId)) + after;
        });
        if (changed !== body) {
          const range = declarationBraceRange(declaration, bundle);
          edits.push({ start: index, end: end, replacement: declaration.slice(0, range.start + 1) + changed + declaration.slice(range.end) });
        }
        index = end;
      }
      return edits.length ? rewriteSourceLines(text, 'usecase', edits, undefined, undefined, bundle) : text;
    }

    function removeElementFromSource(text, type, id, bundle) {
      // Supported container children have global identities. Remove their
      // external references too, so parsing cannot recreate orphaned children.
      return ownedElementIds(text, type, id, bundle).concat([id]).reduce(function (source, ownedId) {
        return removeSingleElementFromSource(source, type, ownedId, text, bundle);
      }, text);
    }

    function removeSingleElementFromSource(text, type, id, referenceText, bundle) {
      if (type === 'crc') return replaceCrcCardInSource(text, id, null, bundle);
      if (type === 'usecase') text = rewriteUsecaseMembershipReferences(text, id, null, bundle);
      text = rewriteOwnedElementStatements(text, type, id, null, bundle);
      var positions = readLayoutPositions(text, type, bundle);
      var routes = readLayoutRoutes(text, bundle);
      var noteRange = virtualNoteLineRange(id, text, type);
      if (noteRange) {
        return rewriteSourceLines(text, type, [{ start: noteRange.start, end: noteRange.end }], positions, routes, bundle);
      }
      Object.keys(positions).forEach(function (key) { if (idIsReferenceTo(key, id, referenceText, type, bundle)) delete positions[key]; });
      Object.keys(routes).forEach(function (rid) {
        const endpoints = rid.match(/^edge:([^|]+)\|([^|]+)$/);
        if (endpoints && (idIsReferenceTo(endpoints[1], id, referenceText, type, bundle) || idIsReferenceTo(endpoints[2], id, referenceText, type, bundle))) delete routes[rid];
      });
      var clean = stripLayoutMetadata(text, type);
      var lines = clean.split('\n');
      if (type === 'state' && statePseudoInfoForId(id)) {
        var pseudoLineIdx = statePseudoRelationLineIndex(text, type, id);
        if (pseudoLineIdx !== -1) {
          var relIdxs = relationLineIndices(text, type, bundle);
          var routeOrdinal = relIdxs.indexOf(pseudoLineIdx);
          if (routeOrdinal !== -1) delete routes['edge-' + routeOrdinal];
          return rewriteSourceLines(text, type, [{ start: pseudoLineIdx, end: pseudoLineIdx }], positions, routes, bundle);
        }
      }
      const port = componentPortForId(text, type, id, bundle);
      // Connectors may name a port by its bare alias (`b_db --> db_in`).
      const portAlias = port ? port.body.ports[port.index].alias : null;
      if (port) {
        port.body.ports.splice(port.index, 1);
        text = replaceBlockByMatch(text, type, function (line) { return declarationIdForLine(line, type, bundle) === port.owner; }, setComponentBody(port.declaration, port.body, bundle), bundle);
        lines = stripLayoutMetadata(text, type).split('\n');
        routes = readLayoutRoutes(text, bundle);
      }
      const edits = [];
      let inNote = false;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var t = line.trim();
        if (t === '@startuml' || t === '@enduml' || /^layout\s+/i.test(t)) {
          continue;
        }
        if (inNote) { if (/^end\s*note$/i.test(t)) inNote = false; continue; }
        // Strip declarations whose id matches.
        var declId = declarationIdForLine(line, type, bundle);
        if (declId === id) {
          const end = declarationEndIndex(lines, i, bundle);
          edits.push({ start: i, end: end });
          i = end;
          continue;
        }
        const noteBlock = /^note\b/i.test(t) && t.indexOf(':') < 0;
        if (referenceSpans(line, type, bundle).some(function (span) { return idIsReferenceTo(span.value, id, referenceText, type, bundle) || (portAlias !== null && span.value === portAlias); })) {
          let end = i;
          if (noteBlock) while (end + 1 < lines.length && !/^\s*end\s*note\s*$/i.test(lines[end])) end++;
          edits.push({ start: i, end: end });
          i = end;
        } else if (noteBlock) inNote = true;
      }
      return rewriteSourceLines(text, type, edits, positions, routes, bundle);
    }

    function replaceCrcCardInSource(text, id, replacement, bundle) {
      var positions = readLayoutPositions(text, 'crc', bundle);
      var routes = readLayoutRoutes(text, bundle);
      var clean = stripLayoutMetadata(text, 'crc');
      var card = crcCardForId(clean, id, bundle);
      if (!card) return text;
      var lines = clean.split('\n');
      var replacementLines = replacement ? buildCrcCardSource(replacement).split('\n') : [];
      lines.splice.apply(lines, [card.startLine, card.endLine - card.startLine + 1].concat(replacementLines));
      if (!replacement || replacement.id !== id) {
        if (replacement && positions[id]) positions[replacement.id] = positions[id];
        delete positions[id];
      }
      return writePositionsIntoSource(lines.join('\n'), 'crc', positions, routes, bundle);
    }

    function rewriteOwnedElementStatements(text, type, oldId, newId, bundle) {
      if (type !== 'state' && type !== 'deployment') return text;
      function rewriteBody(declaration) {
        const range = declarationBraceRange(declaration, bundle);
        if (!range) return declaration;
        let body = declaration.slice(range.start + 1, range.end);
        bodyStatementRanges(body, true, bundle).reverse().forEach(function (statement) {
          const id = declarationIdForLine(statement.text, type, bundle);
          let changed = statement.text;
          if (id === oldId) {
            changed = newId == null ? '' : renameDeclarationIdentifier(changed, type, oldId, newId, bundle);
          } else if (id) {
            changed = rewriteBody(changed);
          } else {
            const referenceLine = /^\s*note\b/.test(changed) ? changed.split('\n')[0] : changed;
            const spans = referenceSpans(referenceLine, type, bundle).filter(function (span) { return idIsReferenceTo(span.value, oldId, text, type, bundle); });
            if (newId == null && spans.length) changed = '';
            else spans.reverse().forEach(function (span) {
              changed = changed.slice(0, span.start) + formatRelationEndpointId(newId + span.value.slice(oldId.length), type) + changed.slice(span.end);
            });
          }
          body = body.slice(0, statement.start) + changed + body.slice(statement.end);
        });
        return declaration.slice(0, range.start + 1) + body + declaration.slice(range.end);
      }
      const lines = stripLayoutMetadata(text, type).split('\n');
      const searchable = sourceLinesWithoutNotes(text, type, bundle);
      const edits = [];
      for (let index = 0; index < lines.length; index++) {
        if (!declarationIdForLine(searchable[index], type, bundle)) continue;
        const end = declarationEndIndex(lines, index, bundle);
        const declaration = lines.slice(index, end + 1).join('\n');
        const changed = rewriteBody(declaration);
        if (changed !== declaration) edits.push({ start: index, end: end, replacement: changed });
        index = end;
      }
      if (!edits.length) return text;
      if (newId == null) return rewriteSourceLines(text, type, edits, undefined, undefined, bundle);
      // Identifier changes retain source line numbers, including inline and
      // nested transitions whose saved route keys depend on their line/order.
      edits.reverse().forEach(function (edit) {
        lines.splice.apply(lines, [edit.start, edit.end - edit.start + 1].concat(edit.replacement.split('\n')));
      });
      return writePositionsIntoSource(lines.join('\n'), type, readLayoutPositions(text, type, bundle), readLayoutRoutes(text, bundle), bundle);
    }

    function renameClassMemberTypes(declaration, oldId, newId, bundle) {
      const range = declarationBraceRange(declaration, bundle);
      if (!range) return declaration;
      let result = declaration.slice(0, range.start + 1);
      let genericDepth = 0;
      let inType = false;
      for (let index = range.start + 1; index < range.end;) {
        const char = declaration[index];
        if (char === '"' || char === "'") {
          let end = index + 1;
          while (end < range.end) {
            if (declaration[end] === '\\') { end += 2; continue; }
            if (declaration[end++] === char) break;
          }
          const token = declaration.slice(index, end);
          result += inType && unquoteId(token) === oldId ? formatRelationEndpointId(newId) : token;
          index = end;
          continue;
        }
        if (char === ':') { inType = true; genericDepth = 0; }
        if (inType && (char === '<' || char === '[')) genericDepth++;
        if (inType && (char === '>' || char === ']')) genericDepth = Math.max(0, genericDepth - 1);
        if (/[;\n=)}]/.test(char) || (char === ',' && genericDepth === 0)) inType = false;
        if (inType && /[A-Za-z_$]/.test(char)) {
          const token = declaration.slice(index).match(/^[\w.$]+(?:::[\w.$]+)*/)[0];
          result += token === oldId ? formatRelationEndpointId(newId) : token;
          index += token.length;
          continue;
        }
        result += char;
        index++;
      }
      return result + declaration.slice(range.end);
    }

    function renameReferencesInRelations(text, type, oldId, newId, referenceText, bundle) {
      if (type === 'usecase') text = rewriteUsecaseMembershipReferences(text, oldId, newId, bundle);
      text = rewriteOwnedElementStatements(text, type, oldId, newId, bundle);
      var positions = readLayoutPositions(text, type, bundle);
      var routes = readLayoutRoutes(text, bundle);
      // Migrate positions/routes keyed by oldId → newId.
      Object.keys(positions).forEach(function (key) {
        if (!idIsReferenceTo(key, oldId, referenceText, type, bundle)) return;
        positions[newId + key.slice(oldId.length)] = positions[key];
        delete positions[key];
      });
      Object.keys(routes).forEach(function (rid) {
        const endpoints = rid.match(/^edge:([^|]+)\|([^|]+)$/);
        if (!endpoints) return;
        const next = 'edge:' + endpoints.slice(1).map(function (endpoint) {
          return idIsReferenceTo(endpoint, oldId, referenceText, type, bundle) ? newId + endpoint.slice(oldId.length) : endpoint;
        }).join('|');
        if (next !== rid) { routes[next] = routes[rid]; delete routes[rid]; }
      });
      var clean = stripLayoutMetadata(text, type);
      var lines = clean.split('\n');
      let inNote = false;
      for (var i = 0; i < lines.length; i++) {
        if (inNote) { if (/^\s*end\s*note\s*$/i.test(lines[i])) inNote = false; continue; }
        if (type === 'class' && /^\s*(?:abstract\s+class|class|interface|enum)\b/i.test(lines[i]) &&
            declarationIdForLine(lines[i], 'class', bundle)) {
          const end = declarationEndIndex(lines, i, bundle);
          const declaration = lines.slice(i, end + 1).join('\n');
          lines.splice.apply(lines, [i, end - i + 1].concat(renameClassMemberTypes(declaration, oldId, newId, bundle).split('\n')));
          i = end;
          continue;
        }
        const spans = referenceSpans(lines[i], type, bundle);
        // Argument references are renamed, but are not structural endpoints for
        // deletion or duplication. Quoted strings and method names stay literal.
        if (type === 'sequence' && spans.length && !/^\s*(?:note|callout)\b/i.test(lines[i])) {
          spans.push.apply(spans, sequenceArgumentReferenceSpans(lines[i]));
        }
        spans.reverse().forEach(function (span) {
          if (!idIsReferenceTo(span.value, oldId, referenceText, type, bundle)) return;
          const renamed = newId + span.value.slice(oldId.length);
          const token = span.quoted ? '"' + escapeQuoted(renamed) + '"' : formatRelationEndpointId(renamed, type);
          lines[i] = lines[i].slice(0, span.start) + token + lines[i].slice(span.end);
        });
        if (/^\s*note\b/i.test(lines[i]) && lines[i].indexOf(':') < 0) inNote = true;
      }
      return writePositionsIntoSource(lines.join('\n'), type, positions, routes, bundle);
    }

    function parseClassDeclaration(line, bundle) {
      var t = line.trim();
      var info = { kind: 'class', isAbstract: false, name: '', stereotype: '', highlight: '', texture: '', members: [], rawAfter: '', body: '' };
      const bodyRange = declarationBraceRange(t, bundle);
      if (bodyRange) {
        info.body = t.slice(bodyRange.start + 1, bodyRange.end);
        t = t.slice(0, bodyRange.start).trim();
      }
      var m = t.match(/^(abstract\s+class|class|interface|enum)\s+("[^"]+"|\S+)(.*)$/i);
      if (!m) return info;
      info.kind = /abstract/i.test(m[1]) ? 'abstract' : (m[1].toLowerCase() === 'class' ? 'class' : m[1].toLowerCase());
      info.isAbstract = /abstract/i.test(m[1]);
      info.name = unquoteId(m[2]);
      var rest = m[3] || '';
      const alias = rest.match(/^\s+as\s+("(?:[^"\\]|\\.)*"|\S+)/i);
      if (alias) {
        info.declarationLabel = info.name;
        info.name = unquoteId(alias[1]);
        rest = rest.slice(alias[0].length);
      }
      var stereo = rest.match(/<<\s*([^>]+?)\s*>>/);
      if (stereo) {
        info.stereotype = '<<' + stereo[1] + '>>';
        rest = rest.replace(/<<\s*[^>]+?\s*>>/, '');
      }
      var hl = rest.match(/\s+#([A-Za-z0-9]+)(?:\s+(hatched|crosshatch|dotted|grid|striped))?/i);
      if (hl) {
        info.highlight = hl[1];
        info.texture = hl[2] || '';
        rest = rest.replace(/\s+#[A-Za-z0-9]+(?:\s+(?:hatched|crosshatch|dotted|grid|striped))?/i, '');
      } else {
        var tex = rest.match(/\s+(hatched|crosshatch|dotted|grid|striped)\b/i);
        if (tex) {
          info.texture = tex[1].toLowerCase();
          rest = rest.replace(/\s+(hatched|crosshatch|dotted|grid|striped)\b/i, '');
        }
      }
      info.rawAfter = rest.trim();
      info.members = splitBodyStatements(info.body, bundle).map(parseMemberLine);
      return info;
    }

    return {
      stripLayoutMetadata: stripLayoutMetadata,
      readLayoutRoutes: readLayoutRoutes,
      declarationIdForLine: declarationIdForLine,
      writePositionsIntoSource: writePositionsIntoSource,
      ownedElementIds: ownedElementIds,
      deploymentNesting: deploymentNesting,
      sequenceLifelineDeclarations: sequenceLifelineDeclarations,
      declarationBraceRange: declarationBraceRange,
      declarationEndIndex: declarationEndIndex,
      sourceLinesWithoutNotes: sourceLinesWithoutNotes,
      getDeclarationLine: getDeclarationLine,
      readLayoutPositions: readLayoutPositions,
      relationLineIndices: relationLineIndices,
      rewriteSourceLines: rewriteSourceLines,
      replaceBlockByMatch: replaceBlockByMatch,
      collectModelElements: collectModelElements,
      existingIds: existingIds,
      generateUniqueId: generateUniqueId,
      buildElementLine: buildElementLine,
      addElementToSource: addElementToSource,
      buildRelationLine: buildRelationLine,
      addRelationToSource: addRelationToSource,
      appendRawLine: appendRawLine,
      parseBraceBody: parseBraceBody,
      setBraceBody: setBraceBody,
      bodyStatementRanges: bodyStatementRanges,
      splitBodyStatements: splitBodyStatements,
      parseComponentBody: parseComponentBody,
      setComponentBody: setComponentBody,
      parseGenericElement: parseGenericElement,
      parseSequenceModel: parseSequenceModel,
      crcCardForId: crcCardForId,
      componentPortForId: componentPortForId,
      idIsReferenceTo: idIsReferenceTo,
      referenceSpans: referenceSpans,
      renameDeclarationIdentifier: renameDeclarationIdentifier,
      cloneDeclarationForDuplicate: cloneDeclarationForDuplicate,
      sequenceDefaultPair: sequenceDefaultPair,
      componentDeclarationWithPort: componentDeclarationWithPort,
      newGitgraphBranchRow: newGitgraphBranchRow,
      addGitgraphBranchToSource: addGitgraphBranchToSource,
      newGitgraphCommitRows: newGitgraphCommitRows,
      addGitgraphCommitToSource: addGitgraphCommitToSource,
      identifierConflict: identifierConflict,
      sequenceFragmentRanges: sequenceFragmentRanges,
      fragmentInfoForId: fragmentInfoForId,
      statePseudoRelationLineIndex: statePseudoRelationLineIndex,
      virtualNoteLineRange: virtualNoteLineRange,
      replaceLineByMatch: replaceLineByMatch,
      removeRelationLine: removeRelationLine,
      rewriteUsecaseMembershipReferences: rewriteUsecaseMembershipReferences,
      removeElementFromSource: removeElementFromSource,
      removeSingleElementFromSource: removeSingleElementFromSource,
      replaceCrcCardInSource: replaceCrcCardInSource,
      rewriteOwnedElementStatements: rewriteOwnedElementStatements,
      renameClassMemberTypes: renameClassMemberTypes,
      renameReferencesInRelations: renameReferencesInRelations,
      parseClassDeclaration: parseClassDeclaration
    };
  })();

  // ---------- the text adapter's reading: contents() (spec §3.4; plan Task 17) ----------

  /** Defines `target[name]` as a value computed by `compute` when it is first read, and kept. */
  function defineLazy(target, name, compute) {
    var computed = false;
    var value;
    Object.defineProperty(target, name, {
      enumerable: true,
      get: function () {
        if (!computed) {
          value = compute();
          computed = true;
        }
        return value;
      }
    });
  }

  // The axis of spec §3.4 for each movement kind the grammar gives an element.
  var CONTENTS_AXIS = { xy: 'xy', x: 'order', port: 'port', note: 'note', 'branch-label': 'label', none: 'none' };

  // Each relation line's endpoints in the ids the renderer draws: connectors
  // may name a port by its bare alias, and every state [*] is its own
  // numbered pseudostate.
  function relationEndpointsAsDrawn(type, lines, relationIndices, bundle) {
    const portOwners = {};
    if (type === 'component') {
      bundle.UMLComponentDiagram.parse(lines.join('\n')).components.forEach(function (component) {
        (component.ports || []).forEach(function (port) { portOwners[port.alias] = component.name; });
      });
    }
    function componentEndpoint(token) {
      const id = String(token || '').replace(/^\[(.+)\]$/, '$1');
      return Object.prototype.hasOwnProperty.call(portOwners, id) ? portOwners[id] + '.' + id : id;
    }
    let initials = 0;
    let finals = 0;
    return relationIndices.map(function (lineIdx) {
      const info = parseRelationLine(lines[lineIdx]);
      normalizeRelationInfoForType(info, type, lines[lineIdx]);
      let source = info.source;
      let target = info.target;
      if (type === 'state') {
        if (source === '[*]') source = '__initial__' + initials++;
        if (target === '[*]') target = '__final__' + finals++;
      } else if (type === 'component') {
        source = componentEndpoint(source);
        target = componentEndpoint(target);
      }
      return { lineIdx: lineIdx, source: source, target: target, label: info.label || '' };
    });
  }

  // The parent of each element that has one, by id: a deployment element's node, a state's
  // composite state. A port's parent is its component, named before the dot of its id.
  function contentsParents(text, type, bundle) {
    var parents = {};
    if (type === 'deployment' && bundle.UMLDeploymentDiagram) {
      var byId = textGrammar.deploymentNesting(text, type, bundle).byId;
      Object.keys(byId).forEach(function (id) { if (byId[id].parentId) parents[id] = byId[id].parentId; });
    }
    if (type === 'state' && bundle.UMLStateDiagram) {
      (bundle.UMLStateDiagram.parse(textGrammar.stripLayoutMetadata(text, type)).states || []).forEach(function (state) {
        if (state.parent) parents[state.name] = state.parent;
      });
    }
    return parents;
  }

  // The members of an element as its source writes them: a class's attributes and methods, a CRC
  // card's responsibilities and collaborators, each numbered within its list.
  function contentsMembers(text, type, id, declaration, bundle) {
    if (type === 'crc') {
      var card = textGrammar.crcCardForId(text, id, bundle);
      if (!card) return [];
      return ['responsibilities', 'collaborators'].reduce(function (members, list) {
        return members.concat(card[list].map(function (entry, index) { return { list: list, index: index, text: entry }; }));
      }, []);
    }
    if (type !== 'class' || !declaration || !/^(?:abstract\s+class|class|interface|enum)\s/i.test(declaration.trim())) return [];
    var counts = { attributes: 0, methods: 0 };
    var body = textGrammar.parseClassDeclaration(declaration, bundle).body;
    return textGrammar.splitBodyStatements(body, bundle).map(function (statement) {
      var list = statement.indexOf('(') === -1 ? 'attributes' : 'methods';
      return { list: list, index: counts[list]++, text: statement.trim() };
    });
  }

  // The elements of spec §3.4, in the grammar's order. Each one's kind, members, and parent are
  // read when they are first asked for.
  function contentsElements(text, type, bundle) {
    var parents = null;
    return textGrammar.collectModelElements(text, type, bundle).map(function (model) {
      var element = { id: model.id };
      var declaration;
      var declarationRead = false;
      function ownDeclaration() {
        if (!declarationRead) {
          declaration = model.axis === 'port' || model.axis === 'note' || model.axis === 'branch-label'
            ? null
            : textGrammar.getDeclarationLine(text, type, model.id, bundle);
          declarationRead = true;
        }
        return declaration;
      }
      defineLazy(element, 'kind', function () {
        if (model.axis === 'port' || model.axis === 'note') return model.axis;
        if (model.axis === 'branch-label') return 'branch';
        if (type === 'crc') return 'card';
        var keyword = (ownDeclaration() || '').trim().match(/^(abstract\s+class|weak\s+entity|identifying\s+relationship|[A-Za-z]+)\b/);
        return keyword ? keyword[1].toLowerCase().replace(/\s+/g, ' ') : 'element';
      });
      element.label = model.label;
      element.name = model.label;
      element.axis = CONTENTS_AXIS[model.axis] || model.axis;
      defineLazy(element, 'parentId', function () {
        if (model.axis === 'port') return model.id.indexOf('.') === -1 ? null : model.id.slice(0, model.id.lastIndexOf('.'));
        parents = parents || contentsParents(text, type, bundle);
        return Object.prototype.hasOwnProperty.call(parents, model.id) ? parents[model.id] : null;
      });
      defineLazy(element, 'members', function () { return contentsMembers(text, type, model.id, ownDeclaration(), bundle); });
      return element;
    });
  }

  // The relations of spec §3.4: each relation line of the rendered document, its ends in the ids the
  // renderer draws, and its label. A sequence message's route id names its line; the scene resolves
  // the other route ids (rel:N, edge-N, usecase:N) against these lines.
  function contentsRelations(text, type, bundle) {
    var lines = textGrammar.stripLayoutMetadata(text, type).split('\n');
    var indices = textGrammar.relationLineIndices(text, type, bundle);
    return relationEndpointsAsDrawn(type, lines, indices, bundle).map(function (ends) {
      var info = normalizeRelationInfoForType(parseRelationLine(lines[ends.lineIdx]), type, lines[ends.lineIdx]);
      return {
        line: ends.lineIdx,
        routeId: type === 'sequence' ? 'seqmsg:' + ends.lineIdx : null,
        kind: info.kind,
        from: ends.source,
        to: ends.target,
        label: ends.label,
        text: ends.label
      };
    });
  }

  // The fragments of spec §3.4: the complete combined fragments of a sequence document, the first
  // branch on the opening line.
  function contentsFragments(text, type, bundle) {
    if (type !== 'sequence') return [];
    return textGrammar.sequenceFragmentRanges(text, type, false, bundle).map(function (range) {
      return {
        id: range.id,
        operator: range.kind,
        startLine: range.startIdx,
        endLine: range.endIdx,
        branches: [{ line: range.startIdx, guard: range.condition }].concat(range.branches.map(function (branch) {
          return { line: branch.lineIdx, guard: branch.condition };
        }))
      };
    });
  }

  // The activation bars of a sequence document: each `activate` line with the `deactivate` that
  // closes it, by lifeline, in the order they open. A bar left open is not listed.
  function contentsActivations(lines, type) {
    if (type !== 'sequence') return [];
    var open = {};
    var bars = [];
    lines.forEach(function (line, index) {
      var match = line.trim().match(/^(activate|deactivate)\s+(\S+)/i);
      if (!match) return;
      var lifeline = unquoteId(match[2]);
      if (match[1].toLowerCase() === 'activate') {
        (open[lifeline] = open[lifeline] || []).push(index);
      } else if (open[lifeline] && open[lifeline].length) {
        bars.push({ lifeline: lifeline, startLine: open[lifeline].pop(), endLine: index });
      }
    });
    return bars.sort(function (a, b) { return a.startLine - b.startLine; });
  }

  /**
   * What the document `text` of diagram type `type` means (spec §3.4, contents): its type and
   * revision, and its elements, relations, fragments, and activations, each read when it is first
   * asked for. A reading is of one revision and never changes; reading has no side effects.
   *
   * It also answers the grammar's questions the classic canvas still asks, all of this one
   * document (the text adapter's own; the C4 adapter has none): `lines`, the rendered document
   * (the lines a relation's `line`, a fragment's lines, and an anchor's `beforeLine` count);
   * `sequenceLines`, the same with a sequence's scaffold; the stored `layoutPositions` and
   * `layoutRoutes`; a deployment's `deploymentNesting`; `relationLines`, the relation lines' indices;
   * and the queries `declarationLine(id, type)`, `ownedElementIds(parentId, type)`, `uniqueId(base)`,
   * `crcCard(id)`, `virtualNoteRange(id)`, `fragment(id)`, `lifelineDeclarations(ids)`, and
   * `activityModel()`.
   */
  function readContents(text, type, bundle) {
    var reading = { type: type };
    defineLazy(reading, 'revision', function () { return revisionOf(text); });
    defineLazy(reading, 'elements', function () { return contentsElements(text, type, bundle); });
    defineLazy(reading, 'relations', function () { return contentsRelations(text, type, bundle); });
    defineLazy(reading, 'fragments', function () { return contentsFragments(text, type, bundle); });
    defineLazy(reading, 'activations', function () { return contentsActivations(reading.lines, type); });
    defineLazy(reading, 'lines', function () { return textGrammar.stripLayoutMetadata(text, type).split('\n'); });
    defineLazy(reading, 'sequenceLines', function () {
      return textGrammar.stripLayoutMetadata(sequenceSourceWithScaffold(text), type).split('\n');
    });
    defineLazy(reading, 'layoutPositions', function () { return textGrammar.readLayoutPositions(text, type, bundle); });
    defineLazy(reading, 'layoutRoutes', function () { return textGrammar.readLayoutRoutes(text, bundle); });
    defineLazy(reading, 'deploymentNesting', function () { return textGrammar.deploymentNesting(text, type, bundle); });
    defineLazy(reading, 'relationLines', function () { return textGrammar.relationLineIndices(text, type, bundle); });
    reading.declarationLine = function (id, ofType) { return textGrammar.getDeclarationLine(text, ofType || type, id, bundle); };
    reading.ownedElementIds = function (parentId, ofType) { return textGrammar.ownedElementIds(text, ofType || type, parentId, bundle); };
    reading.uniqueId = function (base) { return textGrammar.generateUniqueId(text, type, base, bundle); };
    reading.crcCard = function (id) { return textGrammar.crcCardForId(text, id, bundle); };
    reading.virtualNoteRange = function (id) { return textGrammar.virtualNoteLineRange(id, text, type); };
    reading.fragment = function (id) { return textGrammar.fragmentInfoForId(id, text, type, bundle); };
    reading.lifelineDeclarations = function (ids) { return textGrammar.sequenceLifelineDeclarations(text, ids, bundle); };
    reading.activityModel = function () { return bundle.UMLActivityDiagram.parse(textGrammar.stripLayoutMetadata(text, type)); };
    return reading;
  }

  return {
    layoutRouteStorageKey: layoutRouteStorageKey,
    textGrammar: textGrammar,
    unquoteId: unquoteId,
    sequenceSourceWithScaffold: sequenceSourceWithScaffold,
    sourceWithScaffold: sourceWithScaffold,
    escapeQuoted: escapeQuoted,
    formatRelationEndpointId: formatRelationEndpointId,
    componentDeclaration: componentDeclaration,
    findInsertPointForDeclaration: findInsertPointForDeclaration,
    clearSequenceMessageLayoutMetadata: clearSequenceMessageLayoutMetadata,
    buildCrcCardSource: buildCrcCardSource,
    parseMemberLine: parseMemberLine,
    buildClassLine: buildClassLine,
    parseSequenceHeadText: parseSequenceHeadText,
    relationLineOptions: relationLineOptions,
    relationOfLine: relationOfLine,
    routeIdForRelationInfo: routeIdForRelationInfo,
    clearRouteLayoutForRewire: clearRouteLayoutForRewire,
    invertedRouteId: invertedRouteId,
    reverseSavedRoute: reverseSavedRoute,
    moveRelationLabelPosition: moveRelationLabelPosition,
    sequenceLineKind: sequenceLineKind,
    parseRelationLine: parseRelationLine,
    normalizeRelationInfoForType: normalizeRelationInfoForType,
    applyLayoutDirective: applyLayoutDirective,
    readContents: readContents,
    normalizeLineEndings: normalizeLineEndings,
    firstGitgraphBranchName: firstGitgraphBranchName,
    activityLayoutIdForNode: activityLayoutIdForNode,
    activityLabelForNode: activityLabelForNode,
    relationLabelIndex: relationLabelIndex,
    parseTokenizedRelationLine: parseTokenizedRelationLine,
    clonePointsOf: clonePointsOf,
    statePseudoInfoForId: statePseudoInfoForId,
    identifierFromInlineLabel: identifierFromInlineLabel,
    relationEndpointsAsDrawn: relationEndpointsAsDrawn
  };
});
