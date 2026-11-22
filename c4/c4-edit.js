(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-yaml.js'), require('./c4-model.js'), require('./c4-edit-results.js'),
      require('./c4-edit-references.js'), require('./c4-edit-elements.js'), require('./c4-edit-sections.js'),
      require('./c4-edit-interfaces.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.edit = factory(parts.yaml, parts.model, parts.editResults, parts.editReferences, parts.editElements, parts.editSections,
      parts.editInterfaces);
  }
})(typeof self !== 'undefined' ? self : this, function (yamlAdapter, modelApi, resultsModule, referencesModule, elementsModule,
  sectionsModule, interfacesModule) {
  'use strict';

  // Editing commands (spec §4.9, §4.10, §4.11). Each command returns text splices against the design's text; the document
  // is never re-printed. A command made of several splices runs them one after another on the re-parsed text, and
  // its result is reported as disjoint splices against the original text.
  //
  // The commands live in three families, each in its own module (c4-edit-elements.js, c4-edit-sections.js,
  // c4-edit-interfaces.js); they share the splice machinery of c4-edit-splices.js, the results and argument checks of
  // c4-edit-results.js, and the reference sites of c4-edit-references.js. This facade dispatches a command by its
  // `op` and runs batches.

  const { refusal } = resultsModule;

  // ---- Commands ------------------------------------------------------------------------------

  // Every command by its `op`: each family module returns exactly its commands.
  const COMMANDS = Object.assign({}, elementsModule, sectionsModule, interfacesModule, { batch });

  /**
   * Applies `command` (`{ op, …fields }`) to `design` (`{ text, parsed, model }`). Returns `{ text, edits, selection }`
   * or `{ error, message }`; every command is refused with `{ error: 'yaml-errors' }` while the YAML has errors.
   */
  function apply(design, command) {
    if (design.parsed.errors.length > 0) return { error: 'yaml-errors' };
    const run = Object.prototype.hasOwnProperty.call(COMMANDS, command.op) ? COMMANDS[command.op] : null;
    if (!run) return refusal('unknown-command', `There is no edit command ${JSON.stringify(command.op)}`);
    return run(design, command);
  }

  // ---- Batches -------------------------------------------------------------------------------

  /**
   * Applies `commands` in order, each to the text the one before it produced, and returns one splice, the span
   * between the common start and the common end of the old and the new text, with the last command's selection; so a
   * gesture such as dropping a palette tile (add, then pin) is one undo step in every host. The first refusal is
   * returned as it is, without edits.
   */
  function batch(design, { commands }) {
    if (!Array.isArray(commands)) return refusal('invalid-batch', 'A batch needs a list of commands');
    let current = design;
    let selection = null;
    for (const command of commands) {
      const result = apply(current, command);
      if (result.error) return result;
      const parsed = yamlAdapter.parse(result.text);
      current = { text: result.text, parsed, model: modelApi.normalize(parsed, { source: 'file' }).model };
      selection = result.selection;
    }
    const edits = current.text === design.text ? [] : [yamlAdapter.differingSpan(design.text, current.text)];
    return { text: current.text, edits, selection };
  }

  return { apply, dependentsOf: referencesModule.dependentsOf, interfaceDependentsOf: referencesModule.interfaceDependentsOf };
});
