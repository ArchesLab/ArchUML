(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./c4-markup.js'));
  } else {
    var parts = root.ArchUMLC4RenderParts = root.ArchUMLC4RenderParts || {};
    parts.card = factory(root, parts.markup);
  }
})(typeof self !== 'undefined' ? self : this, function (root, markup) {
  'use strict';

  // The interface description card (spec §6.6, J11), which `ArchUMLC4Render` draws for an `interface-card` view.
  // The card is semantic HTML, not an image: an article named by the interface, then labelled groups for the
  // syntactic view, the semantic view, the data types, and the shared vocabulary. The markup is built as text so the
  // static prerender and the live page write the same card; its text inherits the page's size and its colours come
  // from the site's stylesheet (css/uml-diagram.css), so it carries classes and no presentation attributes.

  var element = markup.element;
  var escapeSvgText = markup.escapeSvgText;

  var SYNTACTIC_COLUMNS = ['Field', 'Type', 'Required', 'Allowed values', 'Constraints'];
  var SEMANTIC_COLUMNS = ['Meaning', 'Unit or format', 'Example'];

  /** `text` as a sentence: it gains a full stop unless it already ends in one (as `describe()` writes them). */
  function sentence(text) {
    return /[.!?]$/.test(text) ? text : text + '.';
  }

  function textElement(tag, attrs, text) {
    return element(tag, attrs, escapeSvgText(text));
  }

  /** A `<p>` that starts with a term ("Purpose:") followed by its text. */
  function termParagraph(term, text) {
    return element('p', {}, element('span', { class: 'c4-interface-term' }, escapeSvgText(term + ':')) + ' ' + escapeSvgText(text));
  }

  /** A term followed by a list of its items (each item already markup). */
  function termList(term, itemsMarkup) {
    return textElement('p', { class: 'c4-interface-term' }, term + ':') +
      element('ul', {}, itemsMarkup.map(function (item) { return element('li', {}, item); }).join(''));
  }

  /**
   * A `role="group"` element of the card named by its visible label, which gets the id `labelId`. Labels and the
   * card's name are not paragraphs: chapter pages reset every paragraph to the body size, and labels are larger
   * (spec §6.6 item 6). `kind` is 'panel'
   * (a top-level group) or 'block' (a group inside one); `hooks` are its data attributes.
   */
  function labelledGroup(kind, hooks, labelId, label, content) {
    return element('div', Object.assign({ class: 'c4-interface-' + kind, role: 'group', 'aria-labelledby': labelId }, hooks),
      textElement('div', { class: 'c4-interface-' + kind + '-label', id: labelId }, label) + content);
  }

  function errorText(error) {
    return sentence(error.name + (error.code ? ' (' + error.code + ')' : '') + ': ' + error.when);
  }

  function operationLabel(operation) {
    return operation.syntax === null ? operation.id : operation.id + ': ' + operation.syntax;
  }

  /** "Planner Web App (submit-plan)": a client or handler with the operations it uses, or the whole interface. */
  function withOperations(name, operationIds) {
    return name + ' (' + (operationIds.length ? operationIds.join(', ') : 'the whole interface') + ')';
  }

  function cardHeader(card, ids) {
    var lines = [
      textElement('p', { class: 'c4-interface-type' }, card.typeLabel),
      textElement('p', {}, 'Provided by ' + card.provider.name + ' (' + card.provider.typeLabel + ')'),
    ];
    if (card.description) lines.push(textElement('p', {}, card.description));
    if (card.usedBy.length) {
      lines.push(textElement('p', {}, 'Used by ' + card.usedBy.map(function (user) { return withOperations(user.name, user.operationIds); }).join('; ')));
    }
    card.handledBy.forEach(function (handler) {
      lines.push(textElement('p', {}, 'Handled inside ' + card.provider.name + ' by ' + withOperations(handler.name, handler.operationIds)));
    });
    return element('header', { class: 'c4-interface-header' }, textElement('div', { class: 'c4-interface-name', id: ids('name') }, card.name) + lines.join(''));
  }

  /** A type use (`{typeText}` or the inline map `{typeName}`) as text; an operation without one says "none". */
  function typeUseText(use) {
    return use === null ? 'none' : (use.typeText || use.typeName);
  }

  function definition(term, descriptionMarkup) {
    return textElement('dt', {}, term) + element('dd', {}, descriptionMarkup);
  }

  function syntacticBlock(operation) {
    return element('div', { class: 'c4-interface-block', 'data-c4-operation': operation.id }, element('dl', {},
      definition('Operation', escapeSvgText(operation.id)) +
      definition('Syntax', operation.syntax === null ? 'none' : element('code', {}, escapeSvgText(operation.syntax))) +
      definition('Input', escapeSvgText(typeUseText(operation.input))) +
      definition('Output', escapeSvgText(typeUseText(operation.output)))));
  }

  function syntacticPanel(card, ids) {
    var content = (card.documentFormat ? textElement('p', {}, 'Document format: the types below.') : '') +
      card.operations.map(syntacticBlock).join('');
    return labelledGroup('panel', { 'data-c4-panel': 'syntax' }, ids('syntax'), 'Syntactic view', content);
  }

  function exampleMarkup(example) {
    return 'Input ' + element('code', {}, escapeSvgText(example.inputText)) + ' → Output ' +
      element('code', {}, escapeSvgText(example.outputText)) + '.' + (example.note ? ' ' + escapeSvgText(sentence(example.note)) : '');
  }

  function realizesText(realized) {
    return (realized.kind ? realized.kind.toUpperCase() + ' ' : '') + realized.text + ' (' + realized.ownerName + ')';
  }

  function sentences(texts) {
    return texts.map(function (text) { return escapeSvgText(sentence(text)); });
  }

  /** The interface-level restrictions and errors, printed once before the operations. */
  function allOperationsBlock(all, ids) {
    var content = (all.restrictions.length ? termList('Usage restrictions', sentences(all.restrictions)) : '') +
      (all.errors.length ? termList('Errors', all.errors.map(function (error) { return escapeSvgText(errorText(error)); })) : '');
    return labelledGroup('block', {}, ids('all'), 'All operations', content);
  }

  /** One operation's semantics; a missing purpose or error list is written out (spec §6.6 item 3). */
  function semanticBlock(operation, index, ids) {
    var parts = [operation.purpose ? termParagraph('Purpose', sentence(operation.purpose)) : termParagraph('Purpose', 'not stated.')];
    if (operation.sideEffects.length) parts.push(termList('Side effects', sentences(operation.sideEffects)));
    if (operation.restrictions.length) parts.push(termList('Usage restrictions', sentences(operation.restrictions)));
    parts.push(operation.errors.length
      ? termList('Errors', operation.errors.map(function (error) { return escapeSvgText(errorText(error)); }))
      : termParagraph('Errors', 'none stated.'));
    if (operation.examples.length) parts.push(termList('Examples', operation.examples.map(exampleMarkup)));
    if (operation.realizes.length) parts.push(termParagraph('Realizes', operation.realizes.map(realizesText).join('; ') + '.'));
    return labelledGroup('block', {}, ids('operation-' + (index + 1)), operationLabel(operation), parts.join(''));
  }

  function semanticPanel(card, ids) {
    var content;
    if (card.shorthand) {
      content = textElement('p', {}, 'Semantic view: not described yet.');
    } else {
      var hasAll = card.all.restrictions.length > 0 || card.all.errors.length > 0;
      content = (hasAll ? allOperationsBlock(card.all, ids) : '') +
        card.operations.map(function (operation, index) { return semanticBlock(operation, index, ids); }).join('');
    }
    return labelledGroup('panel', { 'data-c4-panel': 'semantics' }, ids('semantics'), 'Semantic view', content);
  }

  /** A field's cells in column order: the syntactic five, then, unless only the syntax is shown, the semantic three. */
  function fieldCells(field, syntaxOnly) {
    var syntactic = [
      field.typeText,
      field.required ? 'required' : 'optional',
      field.values ? field.values.map(function (allowed) { return allowed.value; }).join(', ') : '',
      field.constraints.join('; '),
    ];
    if (syntaxOnly) return syntactic;
    // Allowed values are listed in the syntactic columns; their meanings follow the field's own meaning.
    var meanings = (field.meaning ? [field.meaning] : []).concat((field.values || []).filter(function (allowed) { return allowed.meaning; })
      .map(function (allowed) { return allowed.value + ': ' + allowed.meaning; }));
    return syntactic.concat([
      meanings.join('; '),
      [field.unit, field.format].filter(Boolean).join('; '),
      field.example === null ? '' : String(field.example),
    ]);
  }

  function fieldRow(field, syntaxOnly) {
    var name = field.inPath ? field.name + ' (in the path)' : field.name;
    return element('tr', {}, textElement('th', { scope: 'row' }, name) +
      fieldCells(field, syntaxOnly).map(function (cell) { return textElement('td', {}, cell); }).join(''));
  }

  /** The two-level header: Syntactic view over its five columns and, unless only the syntax is shown, Semantic view. */
  function typeTableHead(syntaxOnly) {
    var groups = [[SYNTACTIC_COLUMNS, 'Syntactic view']].concat(syntaxOnly ? [] : [[SEMANTIC_COLUMNS, 'Semantic view']]);
    return element('colgroup', { span: SYNTACTIC_COLUMNS.length }, '') +
      (syntaxOnly ? '' : element('colgroup', { span: SEMANTIC_COLUMNS.length }, '')) +
      element('thead', {},
        element('tr', {}, groups.map(function (group) { return textElement('th', { scope: 'colgroup', colspan: group[0].length }, group[1]); }).join('')) +
        element('tr', {}, groups.map(function (group) {
          return group[0].map(function (column) { return textElement('th', { scope: 'col' }, column); }).join('');
        }).join('')));
  }

  /** One type or inline map as a table in a keyboard-scrollable region named by its caption (WCAG 1.4.10). */
  function typeTable(type, index, syntaxOnly, ids) {
    var captionId = ids('type-' + (index + 1));
    var caption = type.description && !syntaxOnly ? type.name + ': ' + sentence(type.description) : type.name;
    return element('div', { class: 'c4-interface-table-scroll', role: 'region', tabindex: '0', 'aria-labelledby': captionId },
      element('table', { class: 'c4-interface-table' },
        textElement('caption', { id: captionId }, caption) + typeTableHead(syntaxOnly) +
        element('tbody', {}, type.fields.map(function (field) { return fieldRow(field, syntaxOnly); }).join(''))));
  }

  function typesPanel(card, syntaxOnly, ids) {
    var content = card.types.length
      ? card.types.map(function (type, index) { return typeTable(type, index, syntaxOnly, ids); }).join('')
      : textElement('p', {}, 'No data types.');
    return labelledGroup('panel', { 'data-c4-panel': 'types' }, ids('types'), 'Data types', content);
  }

  function vocabularyPanel(card, ids) {
    var content = card.vocabulary.length
      ? element('dl', {}, card.vocabulary.map(function (entry) {
        return definition(entry.term, escapeSvgText(entry.meaning + (entry.shared ? ' (shared by the whole model)' : '')));
      }).join(''))
      : textElement('p', {}, 'No shared vocabulary.');
    return labelledGroup('panel', {}, ids('vocabulary'), 'Shared vocabulary', content);
  }

  /** The id maker of one card: every id starts with `prefix`, so several cards can share a page. */
  function cardIds(prefix) {
    return function (name) { return prefix + '-' + name; };
  }

  /**
   * The escaped HTML of an `interface-card` ViewModel's card (spec §6.6), built without a DOM. `options.panels`:
   * 'syntax' shows the header, the syntactic view, and the data tables without their semantic columns, with no
   * absence lines; anything else shows the whole card. `options.idPrefix` starts every id the card writes.
   */
  function cardMarkup(viewModel, options) {
    var card = viewModel.card;
    var syntaxOnly = Boolean(options && options.panels === 'syntax');
    var ids = cardIds((options && options.idPrefix) || 'c4-card');
    var panels = [syntacticPanel(card, ids)]
      .concat(syntaxOnly ? [] : [semanticPanel(card, ids)], [typesPanel(card, syntaxOnly, ids)], syntaxOnly ? [] : [vocabularyPanel(card, ids)]);
    return element('article', { class: 'c4-interface', 'data-c4-interface': card.id, 'aria-labelledby': ids('name') },
      cardHeader(card, ids) + panels.join(''));
  }

  /**
   * The id prefix of the card drawn into `container`, which depends only on the page, never on how many cards were
   * drawn before: the container's own id when it has one; else `c4-card-<interface id>` (`-syntax` when only the
   * syntax is shown), numbered `-2`, `-3`, … while another element of the page already holds the card's ids.
   */
  function cardIdPrefix(container, viewModel, panels) {
    if (container.id) return container.id;
    var base = 'c4-card-' + viewModel.card.id + (panels === 'syntax' ? '-syntax' : '');
    var holder = function (prefix) { return container.ownerDocument.getElementById(cardIds(prefix)('name')); };
    var taken = function (prefix) { var element = holder(prefix); return Boolean(element) && !container.contains(element); };
    var prefix = base;
    for (var number = 2; taken(prefix); number++) prefix = base + '-' + number;
    return prefix;
  }

  /**
   * Writes the card of an `interface-card` ViewModel into `container` (spec §6.6): the container is marked
   * `data-c4-notation="interface-card"` and loses the image role and label the figure builder gave it, because the
   * card is text. `options.panels` is as for `cardMarkup`; the card's ids start with `cardIdPrefix`. Returns
   * `{ cardHtml }`.
   */
  function renderCard(container, viewModel, options) {
    var shared = root.UMLShared;
    var panels = options && options.panels;
    shared.prepareDiagramContainer(container, 'c4');
    container.classList.add('uml-c4-diagram-container');
    container.removeAttribute('role');
    container.removeAttribute('aria-label');
    container.setAttribute('data-c4-notation', 'interface-card');
    var cardHtml = cardMarkup(viewModel, { panels: panels, idPrefix: cardIdPrefix(container, viewModel, panels) });
    container.innerHTML = cardHtml;
    return { cardHtml: cardHtml };
  }

  return { cardMarkup: cardMarkup, renderCard: renderCard };
});
