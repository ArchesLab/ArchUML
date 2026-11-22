(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./te-read.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.textSequence) parts.textSequence = factory(parts.textRead);
  }
})(typeof self !== 'undefined' ? self : this, function (readPart) {
  // The sequence rewrites (UML-view editing spec §3.4: message.move, fragment.*, activation.*; plan Task 15).
  //
  // Moved from the inline script of _includes/uml-editor.html without a changed statement (plan Task 21, spec
  // §3.6); every function reads only its arguments: the text, the diagram type, the operation, and the bundle.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var sequenceSourceWithScaffold = readPart.sequenceSourceWithScaffold;
  var clearSequenceMessageLayoutMetadata = readPart.clearSequenceMessageLayoutMetadata;
  var sequenceLineKind = readPart.sequenceLineKind;
  var parseRelationLine = readPart.parseRelationLine;
  var normalizeRelationInfoForType = readPart.normalizeRelationInfoForType;
  var textGrammar = readPart.textGrammar;

  // ─── The sequence family (spec §3.4; plan Task 15) ───────────────────────
  // Fragments have id `frag:<openLineIdx>`. The open line is the line in the
  // (cleaned) source that begins with `alt|opt|loop|par|break|critical|ref|neg`.
  // The matching `end` is paired by depth.
  var SEQUENCE_FRAGMENT_KINDS = ['alt', 'opt', 'loop', 'par', 'break', 'critical', 'ref', 'neg'];

  function sequenceMessageLineIndices(lines) {
    var out = [];
    (lines || []).forEach(function (line, idx) {
      if (/message$/i.test(sequenceLineKind(line))) out.push(idx);
    });
    return out;
  }

  function sequenceMessageBlockForLine(lines, lineIdx) {
    var start = lineIdx;
    var end = lineIdx;
    var info = parseRelationLine(lines[lineIdx] || '');
    normalizeRelationInfoForType(info, 'sequence', lines[lineIdx] || '');
    if (info && /^<<\s*create\s*>>$/i.test(info.label || '') && lineIdx > 0 && /^create\b/i.test(String(lines[lineIdx - 1] || '').trim())) {
      start = lineIdx - 1;
    }
    return { start: start, end: end };
  }

  function clampSlot(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }

  function endumlLineIndex(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (/^@enduml\b/i.test(String(lines[i]).trim())) return i;
    }
    return lines.length;
  }

  // The refusals of the sequence rewrites. Where today's commands said nothing, they say nothing.
  var MESSAGE_UNMATCHED = { code: 'message/unmatched', summary: 'Message not found in the source', message: null };
  var MESSAGE_UNMOVED = { code: 'message/unmoved', summary: 'The message is already there', message: null };
  var FRAGMENT_OPERATOR_UNKNOWN = { code: 'fragment/operator', summary: 'Not a fragment kind', message: null };
  var FRAGMENT_UNMATCHED = { code: 'fragment/unmatched', summary: 'Fragment not found in the source', message: null };
  var FRAGMENT_UNMOVED = { code: 'fragment/unmoved', summary: 'The fragment is already there', message: null };
  var FRAGMENT_NOT_LOCATED = { code: 'fragment/unmatched', summary: 'Fragment not found in the source', message: 'Could not locate that fragment.' };
  var FRAGMENT_FIRST = { code: 'fragment/first', summary: 'Already first', message: 'Fragment is already first.' };
  var FRAGMENT_FIRST_IN_PARENT = { code: 'fragment/first', summary: 'Already first inside its parent', message: 'Fragment is already first inside its parent.' };
  var FRAGMENT_LAST = { code: 'fragment/last', summary: 'Already last', message: 'Fragment is already last.' };
  var FRAGMENT_LAST_IN_PARENT = { code: 'fragment/last', summary: 'Already last inside its parent', message: 'Fragment is already last inside its parent.' };
  var ACTIVATION_UNMATCHED = { code: 'activation/unmatched', summary: 'Activation not found in the source', message: null };
  var ACTIVATION_WITHOUT_LIFELINE = { code: 'activation/lifeline', summary: 'No lifeline to activate', message: null };

  // message.move: the message `ref` (a relation reference, with a `create` line above it) goes before
  // the line `at.beforeLine` of the framed document; its stored label place and bends are dropped.
  // A message that would land where it is stays, and nothing is written.
  function rewriteMessageMove(text, type, operation, bundle) {
    var g = textGrammar;
    if (operation.ref.line === -1) return { refusal: MESSAGE_UNMATCHED };
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    clearSequenceMessageLayoutMetadata(positions, routes);
    var lines = g.stripLayoutMetadata(sequenceSourceWithScaffold(text), type).split('\n');
    var block = sequenceMessageBlockForLine(lines, operation.ref.line);
    var insertAt = Math.max(0, Math.min(lines.length, Math.round(Number(operation.at.beforeLine))));
    if (insertAt >= block.start && insertAt <= block.end + 1) return { refusal: MESSAGE_UNMOVED };
    var chunk = lines.splice(block.start, block.end - block.start + 1);
    if (insertAt > block.start) insertAt -= chunk.length;
    lines.splice.apply(lines, [insertAt, 0].concat(chunk));
    var routeOffset = operation.ref.line - block.start;
    var nextLineIdx = insertAt + routeOffset;
    return {
      text: g.writePositionsIntoSource(lines.join('\n'), 'sequence', positions, routes, bundle),
      select: { id: 'seqmsg:' + nextLineIdx, kind: 'route' },
      message: 'Moved sequence message.'
    };
  }

  // fragment.add with `wrap`: the lines `fromLine` to `toLine` of the document go one indent deeper
  // into a new `operator` fragment whose opener carries `guard.text`; an alt or par around more than
  // one line gets one `else` placeholder before the last of them. Nothing stays selected.
  function rewriteFragmentWrap(text, type, operation, bundle) {
    var g = textGrammar;
    var kind = operation.operator;
    var condition = operation.guard.text;
    var first = operation.wrap.fromLine;
    var last = operation.wrap.toLine;
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    var clean = g.stripLayoutMetadata(text, type);
    var lines = clean.split('\n');

    var opener = condition ? (kind + ' [' + condition + ']') : kind;

    // Indent the wrapped range two spaces and inject `else` between first and last
    // for alt and par.
    var wrapped = [];
    for (var i = first; i <= last; i++) {
      wrapped.push('  ' + lines[i]);
    }
    // For alt/par with multiple selected lines, insert one `else` placeholder
    // between the first and the last selected line indices (relative to
    // wrapped, not absolute line numbers).
    if ((kind === 'alt' || kind === 'par') && last > first) {
      // Relative positions of first and last within `wrapped`:
      var lastRel = last - first;
      // Insert `else` directly before the last wrapped line.
      wrapped.splice(lastRel, 0, kind === 'alt' ? 'else [otherwise]' : 'else');
    }
    var newLines = lines.slice(0, first)
      .concat([opener])
      .concat(wrapped)
      .concat(['end'])
      .concat(lines.slice(last + 1));
    return { text: g.writePositionsIntoSource(newLines.join('\n'), type, positions, routes, bundle), select: null, message: null };
  }

  // fragment.update: the fragment `ref` gets the kind `operator` (null keeps its kind) and the guard
  // `guard.text` (a null guard keeps it), on its opener; or, when `guard.branch` names the line of
  // one of its `else` lines, that branch gets the guard. The command selects the fragment itself.
  function rewriteFragmentUpdate(text, type, operation, bundle) {
    var g = textGrammar;
    if (operation.operator !== null && SEQUENCE_FRAGMENT_KINDS.indexOf(operation.operator) === -1) return { refusal: FRAGMENT_OPERATOR_UNKNOWN };
    var info = g.fragmentInfoForId(operation.ref, text, type, bundle);
    if (!info) return { refusal: FRAGMENT_UNMATCHED };
    var guard = operation.guard;
    var onBranch = guard !== null && guard.branch !== null;
    var lineIdx = onBranch ? guard.branch : info.startIdx;
    var word = onBranch ? 'else' : (operation.operator || info.kind);
    var condition = guard !== null ? guard.text : info.condition;
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    var lines = g.stripLayoutMetadata(text, type).split('\n');
    var indent = (lines[lineIdx].match(/^\s*/) || [''])[0];
    lines[lineIdx] = indent + word + (condition ? ' [' + condition + ']' : '');
    return {
      text: g.writePositionsIntoSource(lines.join('\n'), 'sequence', positions, routes, bundle),
      select: undefined,
      message: guard === null ? 'Changed fragment kind to ' + word + '.' : null
    };
  }

  // fragment.addBranch: a new last branch of the fragment `ref`, its `else` line (with `guard.text`)
  // just before the fragment's `end`, at the opener's indent.
  function rewriteFragmentAddBranch(text, type, operation, bundle) {
    var g = textGrammar;
    var info = g.fragmentInfoForId(operation.ref, text, type, bundle);
    if (!info || info.endIdx === -1) return { refusal: FRAGMENT_UNMATCHED };
    var trimmed = operation.guard.text;
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    var lines = g.stripLayoutMetadata(text, type).split('\n');
    var openIndent = (lines[info.startIdx].match(/^\s*/) || [''])[0];
    var branch = openIndent + 'else' + (trimmed ? ' [' + trimmed + ']' : '');
    return {
      text: g.rewriteSourceLines(text, 'sequence', [{ start: info.endIdx, end: info.endIdx - 1, replacement: branch }], positions, routes, bundle),
      select: { id: operation.ref, kind: 'fragment' },
      message: 'Added else branch.'
    };
  }

  /**
   * fragment.unwrap: delete a fragment, keeping the messages inside but removing the wrapper
   * (`open` / `else` / `end` lines). Inner messages are dedented by one level. Nothing stays selected.
   */
  function rewriteFragmentUnwrap(text, type, operation, bundle) {
    var g = textGrammar;
    var info = g.fragmentInfoForId(operation.ref, text, type, bundle);
    if (!info || info.endIdx === -1) return { refusal: FRAGMENT_UNMATCHED };
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    var lines = g.stripLayoutMetadata(text, type).split('\n');
    var openIndent = (lines[info.startIdx].match(/^\s*/) || [''])[0];
    var dedent = '  '; // fragments always indent by 2
    var dropLines = {};
    dropLines[info.startIdx] = true;
    dropLines[info.endIdx] = true;
    info.branches.forEach(function (b) { dropLines[b.lineIdx] = true; });
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      if (dropLines[i]) continue;
      if (i > info.startIdx && i < info.endIdx) {
        var cur = lines[i];
        if (cur.indexOf(openIndent + dedent) === 0) {
          cur = openIndent + cur.substring((openIndent + dedent).length);
        } else if (cur.indexOf(dedent) === 0) {
          cur = cur.substring(dedent.length);
        }
        out.push(cur);
      } else {
        out.push(lines[i]);
      }
    }
    return {
      text: g.writePositionsIntoSource(out.join('\n'), 'sequence', positions, routes, bundle),
      select: null,
      message: 'Removed fragment wrapper, kept inner messages.'
    };
  }

  /**
   * fragment.move by `at.step`: move a fragment block earlier (step < 0) or later within its sibling
   * order. The block moves past the previous / next sibling — a top-level message, another fragment,
   * or a note. Lifeline directives (activate/deactivate/create/destroy) are treated as part of the
   * adjacent block they hug. A fragment that cannot move says why.
   */
  function moveFragmentByStep(text, type, operation, bundle) {
    var g = textGrammar;
    var fragId = operation.ref;
    var delta = operation.at.step;
    var info = g.fragmentInfoForId(fragId, text, type, bundle);
    if (!info || info.endIdx === -1) {
      return { refusal: FRAGMENT_NOT_LOCATED };
    }
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    var lines = g.stripLayoutMetadata(text, type).split('\n');
    var blockStart = info.startIdx, blockEnd = info.endIdx;

    // Find the line one position before / after the block to swap with. Skip
    // blank lines so visual ordering matches user expectation.
    function nextNonBlank(idx, dir) {
      idx += dir;
      while (idx >= 0 && idx < lines.length && lines[idx].trim() === '') idx += dir;
      return idx;
    }

    if (delta < 0) {
      var prevIdx = nextNonBlank(blockStart, -1);
      if (prevIdx < 0) {
        return { refusal: FRAGMENT_FIRST };
      }
      // If the previous line is the END of an outer fragment, refuse — can't
      // hop out of the parent fragment via reorder.
      if (/^\s*end\s*$/i.test(lines[prevIdx])) {
        return { refusal: FRAGMENT_FIRST_IN_PARENT };
      }
      // Prev line might be a fragment_end of a sibling fragment — find the
      // matching opener and move the entire sibling block.
      var prevBlockStart = prevIdx, prevBlockEnd = prevIdx;
      if (/^\s*end\s*$/i.test(lines[prevIdx])) {
        // (handled above)
      } else if (/^\s*(alt|opt|loop|par|break|critical|ref|neg)\b/i.test(lines[prevIdx])) {
        // We landed on the sibling opener — keep as start, find its end.
        var depth = 0;
        for (var i = prevIdx; i < lines.length; i++) {
          if (/^\s*(alt|opt|loop|par|break|critical|ref|neg)\b/i.test(lines[i])) depth++;
          if (/^\s*end\s*$/i.test(lines[i])) { depth--; if (!depth) { prevBlockEnd = i; break; } }
        }
      } else {
        // Plain line — back up one since it's the END of the previous block.
        // For most cases, the prev line is a single line (message/note/lifeline-event).
        // For multi-line notes, walk back to find the `note ...` opener.
        if (/^\s*end\s*note$/i.test(lines[prevIdx])) {
          for (var nj = prevIdx - 1; nj >= 0; nj--) {
            if (/^\s*note\s+(left|right|over)\b/i.test(lines[nj])) { prevBlockStart = nj; break; }
          }
        } else {
          prevBlockStart = prevIdx;
          prevBlockEnd = prevIdx;
        }
      }
      var fragChunk = lines.splice(blockStart, blockEnd - blockStart + 1);
      lines.splice.apply(lines, [prevBlockStart, 0].concat(fragChunk));
      return {
        text: g.writePositionsIntoSource(lines.join('\n'), 'sequence', positions, routes, bundle),
        select: { id: 'frag:' + prevBlockStart, kind: 'fragment' },
        message: 'Moved fragment earlier.'
      };
    } else {
      var nextIdx = nextNonBlank(blockEnd, +1);
      if (nextIdx >= lines.length || /^\s*@enduml\b/i.test(lines[nextIdx])) {
        return { refusal: FRAGMENT_LAST };
      }
      if (/^\s*else\b/i.test(lines[nextIdx]) || /^\s*end\s*$/i.test(lines[nextIdx])) {
        return { refusal: FRAGMENT_LAST_IN_PARENT };
      }
      var nextBlockStart = nextIdx, nextBlockEnd = nextIdx;
      if (/^\s*(alt|opt|loop|par|break|critical|ref|neg)\b/i.test(lines[nextIdx])) {
        var d = 0;
        for (var k = nextIdx; k < lines.length; k++) {
          if (/^\s*(alt|opt|loop|par|break|critical|ref|neg)\b/i.test(lines[k])) d++;
          if (/^\s*end\s*$/i.test(lines[k])) { d--; if (!d) { nextBlockEnd = k; break; } }
        }
      } else if (/^\s*note\s+(left|right|over)\b/i.test(lines[nextIdx]) && !/:/.test(lines[nextIdx])) {
        for (var nk = nextIdx + 1; nk < lines.length; nk++) {
          if (/^\s*end\s*note$/i.test(lines[nk])) { nextBlockEnd = nk; break; }
        }
      }
      var nextChunk = lines.splice(nextBlockStart, nextBlockEnd - nextBlockStart + 1);
      // After splicing the next chunk out, `blockStart` / `blockEnd` are unchanged
      // because the removed chunk is AFTER the fragment block. Insert the
      // chunk before the fragment block start.
      lines.splice.apply(lines, [blockStart, 0].concat(nextChunk));
      var newFragStart = blockStart + nextChunk.length;
      return {
        text: g.writePositionsIntoSource(lines.join('\n'), 'sequence', positions, routes, bundle),
        select: { id: 'frag:' + newFragStart, kind: 'fragment' },
        message: 'Moved fragment later.'
      };
    }
  }

  /**
   * fragment.move before `at.beforeLine`: move a fragment block (opener + branches + nested content
   * + end) so that it lands BEFORE that line of the framed document. A block that would land inside
   * itself or where it is stays, and nothing is written.
   */
  function moveFragmentToLine(text, type, operation, bundle) {
    var g = textGrammar;
    var info = g.fragmentInfoForId(operation.ref, text, type, bundle);
    if (!info || info.endIdx === -1) return { refusal: FRAGMENT_UNMATCHED };
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    clearSequenceMessageLayoutMetadata(positions, routes);
    var lines = g.stripLayoutMetadata(sequenceSourceWithScaffold(text), type).split('\n');
    var blockStart = info.startIdx;
    var blockEnd = info.endIdx;
    var insertAt = Math.max(0, Math.min(lines.length, Math.round(Number(operation.at.beforeLine))));
    if (insertAt >= blockStart && insertAt <= blockEnd + 1) return { refusal: FRAGMENT_UNMOVED };
    var chunk = lines.splice(blockStart, blockEnd - blockStart + 1);
    if (insertAt > blockStart) insertAt -= chunk.length;
    lines.splice.apply(lines, [insertAt, 0].concat(chunk));
    return {
      text: g.writePositionsIntoSource(lines.join('\n'), 'sequence', positions, routes, bundle),
      select: { id: 'frag:' + insertAt, kind: 'fragment' },
      message: 'Moved fragment.'
    };
  }

  // fragment.move: `at` is a step past one sibling (`{ step }`, from Properties) or a line to go before
  // (`{ beforeLine }`, a drag); the two move a block differently, as today.
  function rewriteFragmentMove(text, type, operation, bundle) {
    return operation.at.step !== undefined
      ? moveFragmentByStep(text, type, operation, bundle)
      : moveFragmentToLine(text, type, operation, bundle);
  }

  /**
   * activation.set: rewrite the bar `ref`'s `activate` / `deactivate` lines so it starts at message
   * slot `slots.start` and ends at `slots.end` (a null end = open-ended, no `deactivate`), and select
   * it. A slot counts the messages above the line: slot 0 is above the first message. A bar whose
   * start line is no longer an `activate` is not found, and nothing is written.
   */
  function rewriteActivationSet(text, type, operation, bundle) {
    var g = textGrammar;
    var bar = operation.ref;
    var newStartSlot = operation.slots.start;
    var newEndSlot = operation.slots.end;
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    clearSequenceMessageLayoutMetadata(positions, routes);
    var lines = g.stripLayoutMetadata(sequenceSourceWithScaffold(text), type).split('\n');
    var startIdx = bar.startLine;
    if (!/^\s*activate\b/i.test(lines[startIdx] || '')) return { refusal: ACTIVATION_UNMATCHED };
    var hasDeact = bar.endLine != null && /^\s*deactivate\b/i.test(lines[bar.endLine] || '');
    var actText = lines[startIdx];
    var targetId = operation.lifeline || actText.trim().replace(/^activate\s+/i, '');
    var deactText = hasDeact ? lines[bar.endLine] : ('deactivate ' + targetId);

    // Remove the existing directive line(s); message rows shift but keep order.
    var removeIdxs = [startIdx];
    if (hasDeact) removeIdxs.push(bar.endLine);
    removeIdxs.sort(function (a, b) { return b - a; }).forEach(function (idx) {
      if (idx >= 0 && idx < lines.length) lines.splice(idx, 1);
    });

    var msgRows = sequenceMessageLineIndices(lines);
    var endIdx = endumlLineIndex(lines);
    function slotToBefore(slot) {
      slot = clampSlot(slot, 0, msgRows.length);
      return slot < msgRows.length ? msgRows[slot] : endIdx;
    }

    var sStart = clampSlot(newStartSlot, 0, msgRows.length);
    var keepDeact = hasDeact || (newEndSlot != null);
    var beforeStart = slotToBefore(sStart);
    lines.splice(beforeStart, 0, actText);
    var newStartIdx = beforeStart;
    if (keepDeact) {
      var sEnd = clampSlot(newEndSlot != null ? newEndSlot : msgRows.length, sStart, msgRows.length);
      var beforeEnd = slotToBefore(sEnd);
      // The activate insert at beforeStart shifted later indices by one.
      var insEnd = beforeEnd + (beforeEnd >= beforeStart ? 1 : 0);
      insEnd = Math.max(newStartIdx + 1, Math.min(insEnd, lines.length));
      lines.splice(insEnd, 0, deactText);
    }

    return {
      text: g.writePositionsIntoSource(lines.join('\n'), 'sequence', positions, routes, bundle),
      select: { id: 'actbar:' + newStartIdx, kind: 'activation' },
      message: null
    };
  }

  /**
   * activation.add: a new activation bar on the lifeline `lifeline` spanning message slots
   * [`slots.start`, `slots.end`], selected. Used by the Activate tool (click / drag-to-span).
   */
  function rewriteActivationAdd(text, type, operation, bundle) {
    var g = textGrammar;
    var targetId = operation.lifeline;
    if (!targetId) return { refusal: ACTIVATION_WITHOUT_LIFELINE };
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    clearSequenceMessageLayoutMetadata(positions, routes);
    var lines = g.stripLayoutMetadata(sequenceSourceWithScaffold(text), type).split('\n');
    var msgRows = sequenceMessageLineIndices(lines);
    var endIdx = endumlLineIndex(lines);
    function slotToBefore(slot) {
      slot = clampSlot(slot, 0, msgRows.length);
      return slot < msgRows.length ? msgRows[slot] : endIdx;
    }
    var sStart = clampSlot(operation.slots.start, 0, msgRows.length);
    var sEnd = clampSlot(operation.slots.end, sStart, msgRows.length);
    var beforeStart = slotToBefore(sStart);
    lines.splice(beforeStart, 0, 'activate ' + targetId);
    var beforeEnd = slotToBefore(sEnd);
    var insEnd = beforeEnd + (beforeEnd >= beforeStart ? 1 : 0);
    insEnd = Math.max(beforeStart + 1, Math.min(insEnd, lines.length));
    lines.splice(insEnd, 0, 'deactivate ' + targetId);
    return {
      text: g.writePositionsIntoSource(lines.join('\n'), 'sequence', positions, routes, bundle),
      select: { id: 'actbar:' + beforeStart, kind: 'activation' },
      message: 'Added activation for "' + targetId + '". Drag its top or bottom edge to change when it starts and stops.'
    };
  }

  return {
    rewriteMessageMove: rewriteMessageMove,
    rewriteFragmentWrap: rewriteFragmentWrap,
    rewriteFragmentUpdate: rewriteFragmentUpdate,
    rewriteFragmentAddBranch: rewriteFragmentAddBranch,
    rewriteFragmentUnwrap: rewriteFragmentUnwrap,
    rewriteFragmentMove: rewriteFragmentMove,
    rewriteActivationSet: rewriteActivationSet,
    rewriteActivationAdd: rewriteActivationAdd,
    SEQUENCE_FRAGMENT_KINDS: SEQUENCE_FRAGMENT_KINDS,
    sequenceMessageLineIndices: sequenceMessageLineIndices,
    sequenceMessageBlockForLine: sequenceMessageBlockForLine,
    clampSlot: clampSlot
  };
});
