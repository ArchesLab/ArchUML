(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.card = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The interface card in the editor (spec §9.5 "Interface views on the canvas"). The renderer writes the card as
  // semantic HTML (spec §6.6); `attach` adds what only the editor needs, the way the overlay adds the listbox to a
  // drawing (Ruling 12): one native "Edit <operation>" button in each operation's syntactic block, and the marks of
  // the selected operation (a thicker dashed outline and a "Selected" text badge on its syntactic and semantic
  // blocks). `destroy` gives the card back as the renderer wrote it, so the static figure and its print are the same.
  //
  // The card's hooks (spec §6.6 item 8): `data-c4-panel="syntax" | "semantics"` on the groups and
  // `data-c4-operation` on each operation's syntactic block. A semantic block is found by the same hook when the
  // renderer puts it there, else as the group of the Semantic view labelled "<operation id>: <syntax>".

  const SELECTED_CLASS = 'c4-editor__card-block--selected';

  /**
   * Adds the editor's controls to `article`, the rendered `article.c4-interface`. `options`: `dom` (the editor's DOM
   * utilities) and `onEdit(operationId, button)`, called when an operation's Edit button is pressed. Returns
   * `{ editButton(operationId), markSelected(operationId), destroy() }`: the operation's Edit button (or null);
   * marking an operation (null clears the marks), which returns its marked blocks, semantic block first; and the
   * function that removes everything `attach` added.
   */
  function attach(article, options) {
    const { dom, onEdit } = options;
    const buttons = new Map();
    let marked = [];

    syntacticBlocks(article).forEach((block) => {
      const operationId = block.getAttribute('data-c4-operation');
      if (buttons.has(operationId)) return;
      const button = dom.el('button', {
        type: 'button',
        class: 'c4-editor__button c4-editor__card-edit',
        on: { click: (event) => onEdit(operationId, event.currentTarget) },
      }, `Edit ${operationId}`);
      appendTo(block, button);
      buttons.set(operationId, button);
    });

    function clearMarks() {
      marked.forEach(({ block, badge }) => {
        block.classList.remove(SELECTED_CLASS);
        badge.remove();
      });
      marked = [];
    }

    return {
      editButton: (operationId) => buttons.get(operationId) || null,
      markSelected(operationId) {
        clearMarks();
        if (operationId === null) return [];
        const blocks = [semanticBlock(article, operationId), syntacticBlock(article, operationId)].filter(Boolean);
        marked = blocks.map((block) => {
          block.classList.add(SELECTED_CLASS);
          const badge = dom.el('span', { class: 'c4-editor__badge c4-editor__selected-badge', text: 'Selected' });
          prependTo(block, badge);
          return { block, badge };
        });
        return blocks;
      },
      destroy() {
        clearMarks();
        buttons.forEach((button) => button.remove());
        buttons.clear();
      },
    };
  }

  // ---- Placing the editor's nodes ----------------------------------------------------------------------------------

  // Elements whose children are restricted (a `<dl>` holds only `dt`, `dd`, and `div` groups): the editor's nodes go
  // beside such a block instead of inside it, so the card stays valid HTML.
  const LIST_LIKE = new Set(['DL', 'UL', 'OL', 'TABLE']);

  function appendTo(block, node) {
    if (LIST_LIKE.has(block.tagName)) block.after(node);
    else block.append(node);
  }

  function prependTo(block, node) {
    if (LIST_LIKE.has(block.tagName)) block.before(node);
    else block.prepend(node);
  }

  // ---- The card's operation blocks (DOM queries over the renderer's hooks) ---------------------------------------

  function semanticsPanel(article) {
    return article.querySelector('[data-c4-panel="semantics"]');
  }

  /** The syntactic blocks of the card's operations: `[data-c4-operation]` outside the Semantic view. */
  function syntacticBlocks(article) {
    const semantics = semanticsPanel(article);
    return [...article.querySelectorAll('[data-c4-operation]')].filter((block) => !(semantics && semantics.contains(block)));
  }

  function syntacticBlock(article, operationId) {
    return syntacticBlocks(article).find((block) => block.getAttribute('data-c4-operation') === operationId) || null;
  }

  /** The operation's group in the Semantic view: by the operation hook, else by its label "<id>: <syntax>". */
  function semanticBlock(article, operationId) {
    const semantics = semanticsPanel(article);
    if (!semantics) return null;
    const hooked = [...semantics.querySelectorAll('[data-c4-operation]')]
      .find((block) => block.getAttribute('data-c4-operation') === operationId);
    if (hooked) return hooked;
    return [...semantics.querySelectorAll('[role="group"]')].find((group) => {
      const label = labelOf(group);
      return label === operationId || label.startsWith(`${operationId}:`);
    }) || null;
  }

  function labelOf(group) {
    const labelledBy = group.getAttribute('aria-labelledby');
    const label = labelledBy ? group.ownerDocument.getElementById(labelledBy.split(/\s+/)[0]) : null;
    return (label ? label.textContent : group.getAttribute('aria-label') || '').trim();
  }

  return { attach: attach };
});
