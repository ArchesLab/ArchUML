(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4RenderParts = root.ArchUMLC4RenderParts || {};
    parts.markup = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Markup written as text, which the SVG drawing (c4-render.js) and the HTML interface card (c4-card.js) share:
  // escaping, numbers with at most two decimals, and elements from a tag, attributes, and content. Pure and DOM-free,
  // so the static prerender and the live page write the same markup.

  /** Escapes text for SVG or HTML content and attribute values, apostrophes included (spec §6.1). */
  function escapeSvgText(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  /** Attribute text from a map, in insertion order; null and undefined values are left out. */
  function attributes(map) {
    return Object.keys(map).filter(function (name) { return map[name] !== null && map[name] !== undefined; })
      .map(function (name) {
        var value = map[name];
        return ' ' + name + '="' + escapeSvgText(typeof value === 'number' ? round(value) : value) + '"';
      }).join('');
  }

  function element(tag, attrs, content) {
    return '<' + tag + attributes(attrs) + (content === undefined ? '/>' : '>' + content + '</' + tag + '>');
  }

  return { escapeSvgText: escapeSvgText, round: round, element: element };
});
