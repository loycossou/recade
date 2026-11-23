import { readStack, techSheet } from './claudemd.js';

export { readStack };

/**
 * Fills the CI templates of the harness (`harness/ci/ci.yml`, `harness/dependabot.yml`) from the harness
 * technical sheet of `docs/STACK.md`. Pure: text in, text out. The install (Task 11) writes the result.
 *
 * A token `__RECADE_NAME__` is replaced by the command of the sheet row it maps to (see ROWS). A row that is
 * empty, still the template's example, or absent becomes a step that fails and names the row, so a gate never
 * passes by silence, and the row is listed in `missing`. A row that says "none" or "not applicable" becomes a
 * visible no-op, the team having decided.
 */

/** Token name to the item of the tech sheet it reads. The setup block and the ecosystem are handled apart. */
const ROWS = {
  INSTALL: 'Install',
  LINT: 'Lint',
  TYPECHECK: 'Typecheck',
  BUILD: 'Build',
  TEST: 'Test',
  CONTRACT: 'Contract tests',
  E2E_SETUP: 'E2E setup',
  E2E: 'E2E tests',
  CONFIRMATION: 'Confirmation tests',
  ACCESSIBILITY: 'Accessibility tests',
  PERFORMANCE: 'Performance budget',
  SAST: 'SAST',
  AUDIT: 'Dependency audit',
  SBOM: 'SBOM',
  SECRETS: 'Secret scan',
};

/** Runtime name to its setup action and its Dependabot ecosystem. */
const RUNTIMES = {
  node: { uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', tag: 'v4.4.0', input: 'node-version', ecosystem: 'npm' },
  python: { uses: 'actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065', tag: 'v5.6.0', input: 'python-version', ecosystem: 'pip' },
  go: { uses: 'actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff', tag: 'v5.6.0', input: 'go-version', ecosystem: 'gomod' },
  java: { uses: 'actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3', tag: 'v4.9.1', input: 'java-version', ecosystem: 'maven', extra: { distribution: 'temurin' } },
};

/** Ecosystems an explicit `Dependency ecosystem` row may name (the Dependabot package-ecosystem values). */
const ECOSYSTEMS = new Set(['npm', 'pip', 'gomod', 'maven', 'gradle', 'cargo', 'bundler', 'composer', 'nuget', 'pub', 'mix', 'docker', 'terraform']);

const TOKEN = /__RECADE_([A-Z0-9_]+)__/g;
const NOT_APPLICABLE = /^(?:none|n\/a|not applicable)\b/i;
const VERSION = /^[0-9][0-9A-Za-z._-]{0,31}$/;

/** The sheet rows, with the markdown escape of a pipe undone inside a command. */
function sheetOf(stack, repo) {
  const rows = techSheet(stack, repo);
  for (const [k, v] of rows) rows.set(k, v.replace(/\\\|/g, '|'));
  return rows;
}

/** One shell line for a row: the command, a visible no-op, or a failure naming the row. */
function commandFor(item, sheet, missing, stackName) {
  const value = sheet.get(item.toLowerCase());
  if (value === undefined) {
    missing.push(item);
    return `echo "The row ${item} of the harness technical sheet is not filled. Fill it in ${stackName}, then install the harness again." >&2 && exit 1`;
  }
  if (NOT_APPLICABLE.test(value)) return `echo "${item}: not applicable for this project."`;
  if (/\$\{\{/.test(value)) throw new Error(`The row ${item} holds a GitHub expression. Use a plain command: expressions are not allowed in a sheet value.`);
  if (/[\r\n\0]/.test(value)) throw new Error(`The row ${item} must be one line.`);
  return value;
}

/**
 * The command of the quarantine job. The row is optional: a project may list flaky tests and have no way to run them
 * apart yet, and that job never blocks. Without the row the step says so, and the list is still reported.
 */
function quarantineCommand(sheet, missing, stackName) {
  if (!sheet.has('quarantine tests')) return 'echo "Quarantine tests: no command in the harness technical sheet. The quarantined tests are listed above and none is run."';
  return commandFor('Quarantine tests', sheet, missing, stackName);
}

/**
 * The quarantine job runs the end to end tests that fail alone, so it needs the browsers like the e2e job does.
 * Refuse a template where its run step has no `__RECADE_E2E_SETUP__` step before it, in the same job.
 */
function assertQuarantineSetup(template) {
  const lines = template.split('\n');
  const run = lines.findIndex((l) => /__RECADE_QUARANTINE__/.test(l));
  if (run < 0) return;
  let start = run;
  while (start > 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[start])) start--;
  if (!lines.slice(start, run).some((l) => /__RECADE_E2E_SETUP__/.test(l))) {
    throw new Error('The quarantine job of the CI template must install the browsers (__RECADE_E2E_SETUP__) before it runs the quarantined tests.');
  }
}

/** Parsed runtime of the sheet, or undefined when the row is missing. Throws on an unknown runtime or a bad version. */
function runtimeOf(sheet) {
  const value = sheet.get('runtime');
  if (value === undefined) return undefined;
  const [name, version, ...extra] = value.trim().split(/\s+/);
  const known = RUNTIMES[name?.toLowerCase()];
  if (known === undefined || extra.length > 0 || !VERSION.test(version ?? '')) {
    throw new Error(`The Runtime row must be one of ${Object.keys(RUNTIMES).join(', ')} followed by a version, such as "node 22". Got: ${value}`);
  }
  return { ...known, version };
}

/** The steps that set the toolchain up, as lines (no indentation). */
function setupLines(runtime, stackName) {
  if (runtime === undefined) {
    return [
      '- name: Set up the toolchain',
      '  run: |',
      `    echo "The row Runtime of the harness technical sheet is not filled. Fill it in ${stackName}, then install the harness again." >&2 && exit 1`,
    ];
  }
  const lines = [`- uses: ${runtime.uses} # ${runtime.tag}`, '  with:', `    ${runtime.input}: "${runtime.version}"`];
  for (const [k, v] of Object.entries(runtime.extra ?? {})) lines.push(`    ${k}: ${v}`);
  return lines;
}

/**
 * @param {string} template contents of harness/ci/ci.yml
 * @param {string|null|undefined} stack contents of docs/STACK.md
 * @param {string} [stackName] how the messages name the stack document
 * @param {string} [repo] the code repository whose table of the sheet is read (see techSheet)
 * @returns {{text: string, missing: string[]}} the workflow, and the sheet rows that were not filled
 */
export function fillCi(template, stack, stackName = 'docs/STACK.md', repo = undefined) {
  const sheet = sheetOf(stack, repo);
  const missing = [];
  const runtime = runtimeOf(sheet);
  if (runtime === undefined) missing.push('Runtime');
  assertQuarantineSetup(template);
  const out = [];
  for (const line of template.split('\n')) {
    const block = line.match(/^(\s*)#\s*__RECADE_SETUP__\s*$/);
    if (block) {
      out.push(...setupLines(runtime, stackName).map((l) => `${block[1]}${l}`));
      continue;
    }
    out.push(
      line.replace(TOKEN, (_, name) => {
        if (name === 'SBOM_UPLOAD') return NOT_APPLICABLE.test(sheet.get('sbom') ?? '') ? 'false' : 'true';
        if (name === 'QUARANTINE') return quarantineCommand(sheet, missing, stackName);
        if (!(name in ROWS)) throw new Error(`Unknown placeholder __RECADE_${name}__ in the CI template.`);
        return commandFor(ROWS[name], sheet, missing, stackName);
      }),
    );
  }
  return { text: out.join('\n'), missing: [...new Set(missing)] };
}

/**
 * @param {string} template contents of harness/dependabot.yml
 * @param {string|null|undefined} stack contents of docs/STACK.md
 * @returns {{text: string}}
 */
export function fillDependabot(template, stack, stackName = 'docs/STACK.md', repo = undefined) {
  const sheet = sheetOf(stack, repo);
  let ecosystem = sheet.get('dependency ecosystem');
  if (ecosystem === undefined) ecosystem = runtimeOf(sheet)?.ecosystem;
  if (ecosystem === undefined || !ECOSYSTEMS.has(ecosystem)) {
    throw new Error(`No usable dependency ecosystem: fill the Runtime or the Dependency ecosystem row of the harness technical sheet in ${stackName} (one of ${[...ECOSYSTEMS].join(', ')}). Got: ${ecosystem ?? 'nothing'}`);
  }
  return { text: template.replace(/__RECADE_ECOSYSTEM__/g, ecosystem) };
}
