'use strict';

// The `UMLC4Diagram` stub inside uml-bundle.js registers the `c4` type and lazy-loads the C4 scripts. It embeds its
// own copy of the manifest's load order (the bundle cannot read JSON), so this test keeps the two equal (spec §3.1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./helpers.js');

const ARCHUML_ROOT = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ARCHUML_ROOT, 'c4', 'manifest.json'), 'utf8'));
const CONTAINER_VIEW = 'view: containers of registration\n' + fixture('course-registration.yml');

/** A classic-script context without a DOM (the document is still loading, so nothing renders) with the bundle loaded. */
function bundleContext() {
  const context = {
    document: { readyState: 'loading', addEventListener() {}, documentElement: {} },
    MutationObserver: class { observe() {} },
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ARCHUML_ROOT, 'uml-bundle.js'), 'utf8'), context, { filename: 'uml-bundle.js' });
  return context;
}

function loadManifestScripts(context) {
  manifest.core.concat(manifest.render).forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(ARCHUML_ROOT, file), 'utf8'), context, { filename: file });
  });
}

test("the stub's embedded script list equals manifest.json (core, then render)", () => {
  const context = bundleContext();
  assert.deepEqual(Array.from(context.UMLC4Diagram.CORE_SCRIPTS), manifest.core.concat(manifest.render));
});

test('parse returns null without the core and a design with it', () => {
  const context = bundleContext();
  assert.equal(context.UMLC4Diagram.parse(CONTAINER_VIEW), null);

  loadManifestScripts(context);
  context.text = CONTAINER_VIEW;
  const projected = vm.runInContext(
    'var design = UMLC4Diagram.parse(text);' +
    '({ text: design.text, ids: ArchUMLC4.project(design, "containers of registration").nodes.map(function (n) { return n.id; }) })',
    context);
  assert.equal(projected.text, CONTAINER_VIEW);
  assert.deepEqual(Array.from(projected.ids).sort(), ['api', 'billing', 'db', 'student', 'web']);
});
