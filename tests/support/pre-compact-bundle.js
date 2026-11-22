'use strict';

// The renderer as it was before the pane-fitting compact layout: the bundle
// of d9f297b ("Add UML packages and stereotypes; keep fragment guards
// readable"), main's last commit before the compact layout was merged, and
// so an ancestor of every commit that has it. It draws everything the merge
// draws except the new compact layout, so tests can check both that compact
// beats "today's compact" and that every other drawing is unchanged,
// wherever HEAD is. (The feature branch's own base, a74ab60, would not do:
// main's later notation changes default drawings, which is not a compact
// regression.) A later intentional change to default drawings needs this
// pin moved to the commit before it.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PRE_COMPACT_COMMIT = 'd9f297b573c7518dad098ad723a779b6ba29f224';
const REPO = path.join(__dirname, '..', '..');

/** Writes that bundle to a fresh temporary file and returns its path. */
function writePreCompactBundle(prefix) {
  let source;
  try {
    source = execFileSync('git', ['-C', REPO, 'show', PRE_COMPACT_COMMIT + ':uml-bundle.js'],
      { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error('These tests compare against the pre-compact renderer of commit ' + PRE_COMPACT_COMMIT +
      ', which this clone does not have (a shallow clone?). Fetch the full history of ArchUML. ' +
      String(error.stderr || error.message).trim());
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'uml-bundle-pre-compact.js');
  fs.writeFileSync(file, source);
  return file;
}

module.exports = { PRE_COMPACT_COMMIT, writePreCompactBundle };
