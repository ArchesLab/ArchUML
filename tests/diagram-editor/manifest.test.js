'use strict';

// The diagram editor's script list (UML-view editing spec §2.2; plan Task 21): diagram-editor/manifest.json
// names every file of the module, by group, in load order. A page loads the files as classic scripts,
// and may load a group twice (the combined course page holds the UML editor and C4 editors, which load
// the module separately); a second load keeps every part and the global the first one published.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ARCHUML_ROOT = path.join(__dirname, '..', '..');
const MODULE_ROOT = path.join(ARCHUML_ROOT, 'diagram-editor');
const manifest = JSON.parse(fs.readFileSync(path.join(MODULE_ROOT, 'manifest.json'), 'utf8'));
const GROUPS = ['core', 'text'];
const PUBLISHED = ['ArchUMLDiagramEditor', 'ArchUMLDiagramEditorParts'];

const listed = () => GROUPS.flatMap((group) => manifest[group]);

/** Runs one manifest file as a classic script in `context`. */
function loadFile(context, file) {
  vm.runInContext(fs.readFileSync(path.join(ARCHUML_ROOT, file), 'utf8'), context, { filename: file });
}

/** Runs the files of `groups`, in manifest order, as classic scripts in `context`. */
function loadGroups(context, groups = GROUPS) {
  for (const group of groups) manifest[group].forEach((file) => loadFile(context, file));
  return context;
}

/** Every .js file under diagram-editor/, as a path relative to js/ArchUML. */
function moduleFiles(directory = MODULE_ROOT) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return moduleFiles(full);
    return entry.name.endsWith('.js') ? [path.relative(ARCHUML_ROOT, full).split(path.sep).join('/')] : [];
  });
}

test('the manifest is version 1 with the groups core and text, and de-mount.js comes last in core', () => {
  assert.equal(manifest.version, 1);
  assert.deepEqual(Object.keys(manifest).sort(), ['core', 'text', 'version']);
  assert.equal(manifest.core[manifest.core.length - 1], 'diagram-editor/de-mount.js');
});

test('every file is listed once and every listed file exists', () => {
  const files = listed();
  assert.deepEqual(files.filter((file, index) => files.indexOf(file) !== index), [], 'files listed more than once');
  assert.deepEqual(files.filter((file) => !fs.existsSync(path.join(ARCHUML_ROOT, file))), [], 'listed files that do not exist');
  assert.deepEqual(moduleFiles().filter((file) => !files.includes(file)).sort(), [], 'module files the manifest does not list');
});

test('loading every manifest file in order in a fresh vm context publishes ArchUMLDiagramEditor and ArchUMLDiagramEditorParts and no other global', () => {
  const context = vm.createContext({});
  const before = Object.keys(context);

  loadGroups(context);

  assert.deepEqual(Object.keys(context).filter((name) => !before.includes(name)).sort(), PUBLISHED);
  assert.equal(typeof context.ArchUMLDiagramEditor.createTextAdapter, 'function');
});

test('each file but de-mount.js registers one part of its own, and de-mount.js publishes ArchUMLDiagramEditor', () => {
  const context = vm.createContext({});
  const registeredBy = {};
  for (const group of GROUPS) {
    for (const file of manifest[group]) {
      const partsBefore = Object.keys(context.ArchUMLDiagramEditorParts || {});
      const hadEditor = 'ArchUMLDiagramEditor' in context;
      loadFile(context, file);
      registeredBy[file] = Object.keys(context.ArchUMLDiagramEditorParts || {}).filter((name) => !partsBefore.includes(name));
      if (!hadEditor && 'ArchUMLDiagramEditor' in context) registeredBy[file].push('(ArchUMLDiagramEditor)');
    }
  }

  for (const [file, names] of Object.entries(registeredBy)) {
    assert.equal(names.length, 1, `${file} registers ${names.join(', ') || 'nothing'}`);
  }
  assert.deepEqual(registeredBy['diagram-editor/de-mount.js'], ['(ArchUMLDiagramEditor)']);
  assert.deepEqual(registeredBy['diagram-editor/de-operations.js'], ['operations']);
  assert.deepEqual(registeredBy['diagram-editor/text/te-adapter.js'], ['text']);
});

test('loading every manifest file a second time in the same context keeps each part and ArchUMLDiagramEditor the objects the first load published', () => {
  const context = loadGroups(vm.createContext({}));
  const editor = context.ArchUMLDiagramEditor;
  const registry = context.ArchUMLDiagramEditorParts;
  const parts = { ...registry };

  loadGroups(context);

  assert.equal(context.ArchUMLDiagramEditor, editor, 'ArchUMLDiagramEditor is the first load\'s');
  assert.equal(context.ArchUMLDiagramEditorParts, registry, 'the registry is the first load\'s');
  assert.deepEqual(Object.keys(registry).sort(), Object.keys(parts).sort(), 'the second load adds no part');
  for (const [name, part] of Object.entries(parts)) {
    assert.equal(registry[name], part, `the part ${name} is the first load's`);
  }
});

test('a later load of the core group keeps the parts of both groups that an earlier load published', () => {
  const context = loadGroups(vm.createContext({}));
  const text = context.ArchUMLDiagramEditorParts.text;
  const editor = context.ArchUMLDiagramEditor;

  loadGroups(context, ['core']);

  assert.equal(context.ArchUMLDiagramEditorParts.text, text);
  assert.equal(context.ArchUMLDiagramEditor, editor);
});

test('every file loads through require in Node', () => {
  for (const file of listed()) {
    const exported = require(path.join(ARCHUML_ROOT, file));
    assert.equal(typeof exported, 'object', `${file} exports an object`);
    assert.notEqual(exported, null, `${file} exports an object`);
  }
});

test('ArchUMLDiagramEditor.createTextAdapter throws a named error when the text group is not loaded', () => {
  const context = loadGroups(vm.createContext({}), ['core']);

  assert.throws(
    () => context.ArchUMLDiagramEditor.createTextAdapter({ read: () => '', type: () => 'class', write() {}, bundle: {} }),
    (error) => error.name === 'DiagramEditorPartMissing' && /\btext\b/.test(error.message),
  );
});

test('ArchUMLDiagramEditor.createTextAdapter reads the text group when it is called, so a later load of the group serves it', () => {
  const context = loadGroups(vm.createContext({}), ['core']);
  loadGroups(context, ['text']);

  const adapter = context.ArchUMLDiagramEditor.createTextAdapter({ read: () => '@startuml\n@enduml', type: () => 'class', write() {}, bundle: {} });

  assert.equal(adapter.contents().type, 'class');
  assert.equal(adapter.contents().revision, context.ArchUMLDiagramEditorParts.operations.revisionOf('@startuml\n@enduml'));
});
