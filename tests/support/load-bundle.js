'use strict';

// Loads uml-bundle.js into a vm sandbox with a stub document, the same way
// the bundle runs in a web worker: no layout engine, no real DOM. Canvas text
// measurement returns 8 units per character so widths are predictable, unless
// `measureText(text, font)` is given (a test can change it to stand for a web
// font that finished loading).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUNDLE_PATH = path.join(__dirname, '..', '..', 'uml-bundle.js');

function defaultMeasureText(text) {
  return { width: String(text || '').length * 8 };
}

function stubElement(measureText) {
  return {
    style: {},
    appendChild() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelectorAll() { return []; },
    getContext() {
      return { font: '', measureText(text) { return measureText(text, this.font); } };
    },
  };
}

function loadBundle({ measureText = defaultMeasureText } = {}) {
  const source = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const document = {
    createElement: () => stubElement(measureText),
    querySelectorAll() { return []; },
    addEventListener() {},
    documentElement: {},
    readyState: 'complete',
  };
  const sandbox = {
    document,
    MutationObserver: class { observe() {} },
    console,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    requestAnimationFrame(callback) { return setTimeout(callback, 0); },
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'uml-bundle.js' });
  return sandbox.window;
}

module.exports = { loadBundle };
