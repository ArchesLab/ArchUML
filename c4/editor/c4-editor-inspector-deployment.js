(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return { inspectorShared: require('./c4-editor-inspector-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorDeployment = factory(function () { return root.ArchUMLC4EditorParts; });
    // The deployment canvas's link form (UML-view editing plan Task 43): each editor makes its own from its kit.
    parts.umlFormFactories = parts.umlFormFactories || {};
    parts.umlFormFactories.link = parts.inspectorDeployment.createLinkForm;
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // The deployment forms (spec §4.8, §9.1), among the inspector's supplementary forms (c4-editor-inspector-records.js),
  // built from its kit: a deployment environment with its nodes, and a node with its kind, technology, instances,
  // what it hosts, its nested nodes, and its links to other nodes of the environment. The node collaborator fields
  // also make the link form of the deployment canvas (UML-view editing spec §5.4; createLinkForm): the same two
  // fields, the same hint, and the same problem when the description is missing, in an anchored form.

  // The words a link's fields share in the node form and the canvas's link form.
  const LINK_DESCRIPTION_HINT = 'Such as "forwards HTTPS requests to".';
  const missingLinkDescription = (sourceName, targetName) => `Error: Say what ${sourceName} does with ${targetName}, starting with a verb.`;

  const NODE_KINDS = [
    { value: 'device', label: 'Device (a computer or phone)' },
    { value: 'environment', label: 'Environment (a server, cluster, or runtime)' },
    { value: 'infrastructure', label: 'Infrastructure (a load balancer or firewall)' },
  ];

  /**
   * The deployment forms. `kit` is the inspector's shared context: the form kit, `state`, `dom`, `announce`, `actions`
   * (the shared commands; a node's Name field renames through `actions.renameNode`), and `splices`. Returns
   * `environmentForm(model, environmentId)` and `nodeForm(model, environmentId, nodeId)`.
   */
  function createDeploymentForms(kit) {
    const { state, dom, announce, actions, field, formSection, button, run, problem, lockReason, touchesLock, requestFocus, byKey,
      form, gone, group, checkboxGroup, splices } = kit;
    const { setOrDelete, textValue, elementChoices, onEnter } = editorParts().inspectorShared;

    function environmentForm(model, environmentId) {
      const environment = model.environments.get(environmentId);
      if (!environment) return gone('This deployment environment is no longer in the model.');
      const write = (key, label) => (value) => splices.write(label, [(parsed, yaml) => setOrDelete(yaml, parsed, environment.path, key, value)]);
      return form(`Deployment environment: ${environment.name}`, 'Deployment environment: where the containers run, such as Production', [
        formSection('environment-basics', 'Basics', dom.el('div', { class: 'c4-editor__fields' }, [
          field({ key: 'environment-name', label: 'Name', value: environment.name, path: environment.path.concat('name'),
            onCommit: (value) => (value.trim() === '' ? problem('environment-name', 'Error: An environment needs a name.')
              : write('name', `Rename ${environment.name}`)(value.trim())) }),
          field({ key: 'environment-description', label: 'Description', control: 'textarea', value: environment.description,
            path: environment.path.concat('description'), onCommit: (value) => write('description', `Describe ${environment.name}`)(textValue(value)) }),
          state.getView() === `deployment ${environment.id}` ? null
            : button('Show the deployment view', () => state.openView(`deployment ${environment.id}`), { 'data-c4-focus-key': 'environment-show' }),
        ])),
        formSection('environment-nodes', 'Nodes', [
          nodeButtons(environment, environment.rootNodeIds, `${environment.name} has no nodes yet.`),
          lockReason(environment.path.concat('nodes')) ? null : addNodeGroup(environment, null, 'New node', 'Add node'),
        ]),
      ]);
    }

    function nodeButtons(environment, nodeIds, emptyText) {
      if (nodeIds.length === 0) return dom.el('p', { class: 'c4-editor__field-hint', text: emptyText });
      return dom.el('ul', { class: 'c4-editor__plain-list' }, nodeIds.map((nodeId) => {
        const node = environment.nodes.get(nodeId);
        return dom.el('li', {}, button(node.name, () => state.select({ environmentId: environment.id, nodeId }),
          { 'data-c4-focus-key': `node-${nodeId}` }));
      }));
    }

    function addNodeGroup(environment, parent, label, buttonLabel) {
      const key = `${parent ? parent.id : environment.id}-new-node`;
      const nameField = field({ key: `${key}-name`, label: 'Name', value: '', path: environment.path, lintPath: null, onCommit: () => {} });
      const kindField = field({ key: `${key}-kind`, label: 'Kind', control: 'select', value: '', path: environment.path, lintPath: null,
        choices: [{ value: '', label: 'Not set' }].concat(NODE_KINDS), onCommit: () => {} });
      const add = () => {
        const name = byKey(`${key}-name`).value.trim();
        const kind = byKey(`${key}-kind`).value;
        if (name === '') return problem(`${key}-name`, 'Error: Name the node first.');
        if (run({ op: 'addNode', environmentId: environment.id, parentNodeId: parent ? parent.id : null, kind: kind || null, name },
          `Add the node ${name}`)) {
          state.select(parent ? { environmentId: environment.id, nodeId: parent.id } : { environmentId: environment.id });
          announce(`Added the node ${name}${parent ? ` inside ${parent.name}` : ''}.`);
          requestFocus(`${key}-name`);
        }
        return true;
      };
      nameField.querySelector('input').addEventListener('keydown', onEnter(add));
      return group(key, label, [nameField, kindField, button(buttonLabel, add)], 'c4-editor__list-add');
    }

    function nodeForm(model, environmentId, nodeId) {
      const environment = model.environments.get(environmentId);
      const node = environment ? environment.nodes.get(nodeId) : null;
      if (!node) return gone('This deployment node is no longer in the model.');
      const update = (key, label) => (value) => run({ op: 'updateNode', environmentId, nodeId, field: key, value }, label);
      const chain = [];
      for (let parent = node.parentId ? environment.nodes.get(node.parentId) : null; parent; parent = parent.parentId ? environment.nodes.get(parent.parentId) : null) {
        chain.unshift(parent.name);
      }
      const infrastructure = node.kind === 'infrastructure';
      return form(`Deployment node: ${node.name}`, `Deployment node in ${[environment.name].concat(chain).join(' › ')}`, [
        formSection('node-basics', 'Basics', dom.el('div', { class: 'c4-editor__fields' }, [
          field({ key: 'node-name', label: 'Name', value: node.name, path: node.path.concat('name'),
            onCommit: (value) => {
              if (value.trim() === '') {
                problem('node-name', 'Error: A node needs a name.');
                return;
              }
              // The shared rename, as the canvas's: a node still named as it was added takes the id of its first name.
              const result = actions.renameNode(environmentId, nodeId, value);
              if (!result.ok) problem('node-name', result.message);
            } }),
          field({ key: 'node-kind', label: 'Kind', control: 'select', value: node.kind || '', path: node.path.concat('kind'),
            choices: [{ value: '', label: 'Not set' }].concat(NODE_KINDS), onCommit: (value) => update('kind', `Change the kind of ${node.name}`)(value || null) }),
          field({ key: 'node-technology', label: 'Technology', value: node.technology, path: node.path.concat('technology'),
            hint: 'Such as Kubernetes, Docker, or PostgreSQL 16.', onCommit: (value) => update('technology', `Edit the technology of ${node.name}`)(textValue(value)) }),
          field({ key: 'node-instances', label: 'Instances', control: 'number', value: node.instances, path: node.path.concat('instances'),
            hint: 'How many copies run; leave it empty for one.',
            onCommit: (value) => {
              if (value.trim() === '') return update('instances', `Edit the instances of ${node.name}`)(null);
              const count = Number(value);
              if (!Number.isInteger(count) || count < 1) return problem('node-instances', 'Error: Instances is a whole number of at least 1.');
              return update('instances', `Edit the instances of ${node.name}`)(count);
            } }),
          field({ key: 'node-description', label: 'Description', control: 'textarea', value: node.description, path: node.path.concat('description'),
            onCommit: (value) => update('description', `Describe ${node.name}`)(textValue(value)) }),
          touchesLock(node.path) || state.isReadOnly() ? null : button(`Delete ${node.name}`, () => {
            const nested = countNested(environment, node);
            if (run({ op: 'removeNode', environmentId, nodeId }, `Delete ${node.name}`)) {
              state.select(node.parentId ? { environmentId, nodeId: node.parentId } : { environmentId });
              announce(`Deleted ${node.name}${nested > 0 ? ` and ${nested} nested ${nested === 1 ? 'node' : 'nodes'}` : ''}. You can undo this.`);
              requestFocus('title');
            }
          }, { 'data-c4-focus-key': 'node-delete' }),
        ])),
        formSection('node-hosts', 'Hosts', infrastructure
          ? dom.el('p', { class: 'c4-editor__field-hint', text: `${node.name} is infrastructure, such as a load balancer, so it hosts nothing.` })
          : hostsFields(model, environmentId, node)),
        formSection('node-nested', 'Nested nodes', infrastructure
          ? dom.el('p', { class: 'c4-editor__field-hint', text: `${node.name} is infrastructure, so it holds no nodes.` })
          : [nodeButtons(environment, node.childIds, `${node.name} holds no nodes yet.`),
            lockReason(node.path.concat('nodes')) ? null : addNodeGroup(environment, node, 'New nested node', 'Add nested node')]),
        formSection('node-collaborators', 'Node collaborators', nodeCollaborators(environment, node)),
      ]);
    }

    /** Hosts as two checkbox groups, software systems and containers (spec §9.1's multi-select); one `setHosts` per toggle. */
    function hostsFields(model, environmentId, node) {
      const path = node.path.concat('hosts');
      const toggle = (id, on) => {
        const next = on ? node.hosts.concat(id) : node.hosts.filter((hosted) => hosted !== id);
        const name = model.elements.get(id).name;
        return run({ op: 'setHosts', environmentId, nodeId: node.id, hosts: next }, `${on ? 'Host' : 'Stop hosting'} ${name} on ${node.name}`);
      };
      const ofType = (type) => [...model.elements.values()].filter((element) => element.type === type).map((element) => element.id);
      return [
        dom.el('p', { class: 'c4-editor__field-hint', text: `What runs on ${node.name}: a container, or a whole software system that another team runs.` }),
        checkboxGroup({ key: 'hosts-systems', label: 'Software systems', choices: elementChoices(model, ofType('system')), checked: node.hosts,
          path, onToggle: toggle, empty: 'The model has no software systems.' }),
        checkboxGroup({ key: 'hosts-containers', label: 'Containers', choices: elementChoices(model, ofType('container')), checked: node.hosts,
          path, onToggle: toggle, empty: 'The model has no containers yet.' }),
      ];
    }

    /**
     * Links to other nodes of the environment (spec §4.8), each with a description and technology, written with the
     * core's setNodeLink and removeNodeLink, which the deployment canvas uses too.
     */
    function nodeCollaborators(environment, node) {
      const mapPath = node.path.concat('collaborators');
      const reason = lockReason(mapPath);
      const authored = splices.dataAt(mapPath) || {};
      const linkTo = (targetNodeId, fields) => Object.assign({ environmentId: environment.id, nodeId: node.id, targetNodeId }, fields);
      // Empty text leaves a field out; a link with only a description is written as the shorthand `target: description`.
      const setLink = (targetNodeId, fields, label) => run(Object.assign({ op: 'setNodeLink' }, linkTo(targetNodeId, fields)), label);
      // Removing the last link deletes the whole `collaborators` key, so it must hold no lock at all.
      const last = Object.keys(authored).length === 1;
      const removable = (targetId) => !touchesLock(mapPath.concat(targetId)) && !(last && touchesLock(mapPath));
      const rows = Object.keys(authored).map((targetId, index) => {
        const target = environment.nodes.get(targetId);
        const link = node.relationships.find((relationship) => relationship.targetId === targetId);
        const targetName = target ? target.name : targetId;
        if (!link || Array.isArray(authored[targetId])) {
          return dom.el('li', { class: 'c4-editor__node-link', text: `To ${targetName}: edit this collaborator in the YAML.` });
        }
        const key = `node-link-${index}`;
        const current = () => ({ description: byKey(`${key}-description`).value.trim(), technology: byKey(`${key}-technology`).value.trim() });
        const commit = () => setLink(targetId,
          { description: current().description || null, technology: current().technology || null, replace: true },
          `Edit the collaborator of ${node.name} to ${targetName}`);
        return dom.el('li', { class: 'c4-editor__node-link' }, group(key, `To ${targetName}`, [
          field({ key: `${key}-description`, label: `Description of the link to ${targetName}`, value: link.description, path: link.path, onCommit: commit }),
          field({ key: `${key}-technology`, label: `Technology of the link to ${targetName}`, value: link.technology, path: link.path,
            lintPath: null, onCommit: commit }),
          removable(targetId) ? button(`Remove the collaborator to ${targetName}`, () => {
            if (run(Object.assign({ op: 'removeNodeLink' }, linkTo(targetId)), `Remove the collaborator of ${node.name} to ${targetName}`)) {
              announce(`Removed the collaborator to ${targetName}.`);
              requestFocus('node-link-new-target');
            }
          }) : null,
        ]));
      });
      const others = [...environment.nodes.values()].filter((other) => other.id !== node.id);
      return [
        reason ? dom.el('p', { class: 'c4-editor__lock-note', text: reason }) : null,
        rows.length > 0 ? dom.el('ul', { class: 'c4-editor__plain-list' }, rows)
          : dom.el('p', { class: 'c4-editor__field-hint', text: `${node.name} has no links to other nodes yet.` }),
        reason || others.length === 0 ? null : newNodeCollaborator(node, others, authored, setLink),
      ];
    }

    function newNodeCollaborator(node, others, authored, setLink) {
      const key = 'node-link-new';
      const add = () => {
        const targetId = byKey(`${key}-target`).value;
        const description = byKey(`${key}-description`).value.trim();
        const technology = byKey(`${key}-technology`).value.trim();
        if (targetId === '') return problem(`${key}-target`, 'Error: Choose the node it links to first.');
        const target = others.find((other) => other.id === targetId);
        if (targetId in authored) return problem(`${key}-target`, `Error: ${node.name} already links to ${target.name}; edit that link above.`);
        if (description === '') return problem(`${key}-description`, missingLinkDescription(node.name, target.name));
        if (setLink(targetId, { description, technology: technology || null }, `Link ${node.name} to ${target.name}`)) {
          announce(`Added the collaborator to ${target.name}.`);
          requestFocus(`${key}-target`);
        }
        return true;
      };
      const descriptionField = field({ key: `${key}-description`, label: 'Description', value: '', path: node.path, lintPath: null,
        hint: LINK_DESCRIPTION_HINT, onCommit: () => {} });
      descriptionField.querySelector('input').addEventListener('keydown', onEnter(add));
      return group(key, 'New node collaborator', [
        field({ key: `${key}-target`, label: 'Target node', control: 'select', value: '', path: node.path, lintPath: null,
          choices: [{ value: '', label: 'Choose the node…' }].concat(others.map((other) => ({ value: other.id, label: other.name }))), onCommit: () => {} }),
        descriptionField,
        field({ key: `${key}-technology`, label: 'Technology', value: '', path: node.path, lintPath: null, onCommit: () => {} }),
        button('Add node collaborator', add),
      ], 'c4-editor__list-add');
    }

    return { environmentForm, nodeForm };
  }

  /**
   * The link form of a deployment canvas (UML-view editing spec §5.4): `createLinkForm(kit)` gives this editor's
   * `open(initial, placement)`, which the C4 model adapter calls for a plan of the form `link`. `kit` is the canvas's
   * form kit (`dom`, `ids`, `actions` with `openAnchoredForm`). `initial`: `title`, `submitLabel`, `sourceName`,
   * `targetName`, the fields' `description` and `technology`, and `link` (what the view module needs back). The form
   * writes nothing: it resolves `{ link, description, technology }` when confirmed, with the description required,
   * and null when cancelled (Escape or Cancel), so the view module plans the change and the adapter makes it.
   */
  function createLinkForm(kit) {
    const { dom, ids, actions } = kit;
    return function openLinkForm(initial, placement = {}) {
      const id = (part) => ids(`link-form-${part}`);
      const field = (name, label, value, hint) => {
        const input = dom.el('input', { type: 'text', id: id(name), class: 'c4-editor__input', autocomplete: 'off', value: value || '' });
        const hintText = hint ? dom.el('p', { id: id(`${name}-hint`), class: 'c4-editor__field-hint', text: hint }) : null;
        const problemText = dom.el('p', { id: id(`${name}-problem`), class: 'c4-editor__field-problem c4-editor__field-problem--error', hidden: true });
        input.setAttribute('aria-describedby', [hintText && hintText.id, problemText.id].filter(Boolean).join(' '));
        const element = dom.el('div', { class: 'c4-editor__field' }, [
          dom.el('label', { for: input.id, class: 'c4-editor__field-label', text: label }), hintText, input, problemText]);
        return { element, input, problemText };
      };
      const description = field('description', 'Description', initial.description, LINK_DESCRIPTION_HINT);
      const technology = field('technology', 'Technology', initial.technology, 'Such as HTTPS or SQL/TCP.');
      const lead = dom.el('p', { class: 'c4-editor__form-lead', text: `A link from ${initial.sourceName} to ${initial.targetName}.` });
      const body = dom.el('div', { class: 'c4-editor__fields' }, [lead, description.element, technology.element]);
      return actions.openAnchoredForm({
        body, title: initial.title, placement, returnFocus: placement.returnFocus, initialFocus: description.input,
        submitLabel: initial.submitLabel,
        onSubmit() {
          const typed = description.input.value.trim();
          if (typed === '') {
            description.problemText.textContent = missingLinkDescription(initial.sourceName, initial.targetName).replace(/^Error: /, '');
            description.problemText.hidden = false;
            description.input.setAttribute('aria-invalid', 'true');
            description.input.focus();
            return { ok: false };
          }
          return { link: initial.link, description: typed, technology: technology.input.value.trim() };
        },
      });
    };
  }

  function countNested(environment, node) {
    return node.childIds.reduce((total, id) => total + 1 + countNested(environment, environment.nodes.get(id)), 0);
  }

  return { createDeploymentForms, createLinkForm };
});
