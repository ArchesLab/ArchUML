#!/usr/bin/env node
'use strict';

// Command line front end of the C4 core (spec §7.3):
//   node cli.js <check|describe|views|uml|schema> <file> [--view <selector>] [--interfaces] [--panels syntax|all] [--json] [--strict] [--disable rule,…]

const fs = require('node:fs');
const core = require('./c4-core.js');

const EXIT = { ok: 0, errors: 1, strictWarnings: 2, usage: 64, unreadable: 66 };
const COMMANDS = ['check', 'describe', 'views', 'uml', 'schema'];
const PANELS = ['syntax', 'all'];
const USAGE = `Usage: node cli.js <${COMMANDS.join('|')}> <file> [--view <selector>] [--interfaces] [--panels syntax|all] [--json] [--strict] [--disable rule,…]`;

class UsageError extends Error {}

function panelsOf(value) {
  if (!PANELS.includes(value)) throw new UsageError(`--panels must be ${PANELS.join(' or ')}`);
  return value;
}

function parseArguments(argv) {
  const options = { json: false, strict: false, interfaces: false, view: null, panels: 'all', disable: [] };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--json' || argument === '--strict' || argument === '--interfaces') {
      options[argument.slice(2)] = true;
    } else if (argument === '--view' || argument === '--disable' || argument === '--panels') {
      if (index + 1 >= argv.length) throw new UsageError(`${argument} needs a value`);
      const value = argv[++index];
      if (argument === '--view') options.view = value;
      else if (argument === '--panels') options.panels = panelsOf(value);
      else options.disable = value.split(',').filter(Boolean);
    } else if (argument.startsWith('--')) {
      throw new UsageError(`Unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  const [command, file] = positional;
  if (!COMMANDS.includes(command)) throw new UsageError(command ? `Unknown command ${command}` : 'Missing command');
  if (command !== 'schema' && !file) throw new UsageError(`${command} needs a file`);
  return { command, file, options };
}

function countsOf(diagnostics) {
  const counts = { error: 0, warning: 0, info: 0 };
  diagnostics.forEach((found) => { counts[found.severity]++; });
  return counts;
}

function diagnosticLine(file, found) {
  const position = found.range ? `:${found.range.start.line}:${found.range.start.col}` : '';
  return `${file}${position} ${found.severity} ${found.rule} ${found.message}`;
}

function diagnosticLines(file, diagnostics) {
  return diagnostics.map((found) => diagnosticLine(file, found)).join('\n') + (diagnostics.length ? '\n' : '');
}

function result(code, out = '', err = '') {
  return { code, out, err };
}

function checkReport(file, diagnostics, options) {
  const counts = countsOf(diagnostics);
  const code = counts.error > 0 ? EXIT.errors : options.strict && counts.warning > 0 ? EXIT.strictWarnings : EXIT.ok;
  const out = options.json
    ? `${JSON.stringify({ valid: counts.error === 0, counts, diagnostics }, null, 2)}\n`
    : diagnosticLines(file, diagnostics);
  return result(code, out);
}

function describeText({ brief, sections }) {
  const body = sections.map(({ heading, items }) => `\n${heading}\n${items.map((item) => `- ${item}`).join('\n')}`).join('\n');
  return `${brief}\n${body}${sections.length ? '\n' : ''}`;
}

/** Projects the requested (or default) view; a selector that does not resolve is reported as the view's diagnostics. */
function projectRequested(design, file, options) {
  const view = core.project(design, options.view || core.defaultView(design));
  return view.diagnostics.some((found) => found.severity === 'error')
    ? { failure: result(EXIT.errors, '', diagnosticLines(file, view.diagnostics)) }
    : { view };
}

function viewCommand(command, design, file, options) {
  if (command === 'views') {
    const views = core.listViews(design, { interfaces: options.interfaces });
    return result(EXIT.ok, options.json ? `${JSON.stringify(views, null, 2)}\n` : views.map((view) => `${view.selector}\n`).join(''));
  }
  const { view, failure } = projectRequested(design, file, options);
  if (failure) return failure;
  if (command === 'describe') {
    const description = core.describe(view, { panels: options.panels });
    return result(EXIT.ok, options.json ? `${JSON.stringify(description, null, 2)}\n` : describeText(description));
  }
  if (!view.notation.startsWith('uml-')) {
    return result(EXIT.usage, '', `The ${view.key} view is drawn in C4 notation and has no ArchUML text; choose a code, dynamic, or deployment view\n`);
  }
  return result(EXIT.ok, `${core.toUml(view).text}\n`);
}

/** Runs one command line; returns `{ code, out, err }` and leaves printing and exiting to the caller. */
function run(argv, readFile = (file) => fs.readFileSync(file, 'utf8')) {
  let request;
  try {
    request = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return result(EXIT.usage, '', `${error.message}\n${USAGE}\n`);
  }
  const { command, file, options } = request;
  if (command === 'schema') return result(EXIT.ok, `${JSON.stringify(core.toJsonSchema(), null, 2)}\n`);
  let text;
  try {
    text = readFile(file);
  } catch (error) {
    return result(EXIT.unreadable, '', `Cannot read ${file}: ${error.message}\n`);
  }
  const design = core.load(text, { source: 'file' });
  const diagnostics = core.check(design, { disable: options.disable });
  if (command === 'check') return checkReport(file, diagnostics, options);
  if (design.model === null || diagnostics.some((found) => found.severity === 'error')) {
    return result(EXIT.errors, '', diagnosticLines(file, diagnostics));
  }
  return viewCommand(command, design, file, options);
}

if (require.main === module) {
  const { code, out, err } = run(process.argv.slice(2));
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}

module.exports = { run };
