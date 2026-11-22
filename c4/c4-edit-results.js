(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'), require('./c4-yaml.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.editResults = factory(parts.schema, parts.yaml);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, yamlAdapter) {
  'use strict';

  // What every edit command returns (spec §4.9): `finished` text with its splices and the selection, or a refusal
  // `{ error, message }`; and the argument checks shared by the command families, each of which gives a refusal or
  // null.

  function refusal(error, message) {
    return { error, message };
  }

  function unknownElement(id) {
    return refusal('unknown-element', `There is no element ${JSON.stringify(id)}`);
  }

  function finished(text, edits, selection) {
    return { text: yamlAdapter.applyEdits(text, edits), edits, selection };
  }

  /** The element, or a refusal when it does not exist or its type has no `field`. */
  function elementWithField(design, elementId, field) {
    const element = design.model.elements.get(elementId);
    if (!element) return unknownElement(elementId);
    if (!schema.FIELDS[element.type].includes(field)) return refusal('invalid-field', `A ${element.type} has no ${field}`);
    return element;
  }

  function unknownFieldProblem(fields, allowed) {
    const unknown = Object.keys(fields).find((key) => !allowed.includes(key));
    return unknown === undefined ? null : refusal('invalid-field', `${JSON.stringify(unknown)} is not a field this command sets`);
  }

  function textProblem(field, value) {
    return isText(value) ? null : refusal(`invalid-${field}`, `The ${field} needs some text`);
  }

  function optionalTextProblem(field, value) {
    return value === undefined || value === null || typeof value === 'string' ? null : refusal('invalid-value', `${field} is a text`);
  }

  function invalidIndex(index) {
    return refusal('invalid-index', `There is no item at ${JSON.stringify(index)}`);
  }

  function isIndex(value, length, { orEnd = false } = {}) {
    return Number.isInteger(value) && value >= 0 && value < length + (orEnd ? 1 : 0);
  }

  function isText(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  function connectorProblem(connector) {
    if (connector === undefined || connector === null || schema.CONNECTORS.includes(connector)) return null;
    return refusal('invalid-connector', `A connector is one of ${schema.CONNECTORS.join(', ')}`);
  }

  return {
    refusal, unknownElement, finished, elementWithField, unknownFieldProblem, textProblem, optionalTextProblem,
    invalidIndex, isIndex, isText, connectorProblem,
  };
});
