import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Document, parseDocument } from 'yaml';
import { writeOwnFile } from '../project/adopt.js';

/**
 * The harness installs at two places: the workspace (the home of the project) and each code repository. This says
 * which files of the plugin template go where. Nothing here touches the disk, but the per-repository settings below.
 *
 * - `workspace`: every command and every agent, the protocol, the guard, the git hooks of the documents (style, ID
 *   index) and the CI of the documents. Every session starts at the root of the workspace, so this is the one entry
 *   point: `/slice <S-nn>` is typed there, and the owner never chooses a folder.
 * - `code`: what belongs to the code itself: the git hooks of the code (style of the staged files, gates), its CI, the
 *   guard (a session opened by hand in the repository stays held) and one pointer command, `/slice`, that tells the
 *   owner to work from the workspace. No agent, no protocol and no second copy of a command.
 *
 * An install with no target (a project that is both, as before the workspace) takes the whole harness.
 */

export const TARGET_NAMES = Object.freeze(['workspace', 'code']);

/** The pointer command of a code repository, in `harness/pointer/`. It is installed as `.claude/commands/<name>.md`. */
export const POINTER_COMMANDS = Object.freeze(['slice']);
/** The line that tells a pointer command from the real command of the same name. */
export const POINTER_MARK = '<!-- recade-pointer -->';

export const TARGETS = Object.freeze({
  workspace: Object.freeze({
    /** Every command of `harness/commands/` (null: all of them, a test checks the folder). */
    commands: null,
    /** Every agent of `harness/agents/`. */
    agents: null,
    /** The template of the pre-commit hook, in `harness/githooks/`. It is installed as `.githooks/pre-commit`. */
    preCommit: 'pre-commit-workspace',
    protocol: true,
  }),
  code: Object.freeze({
    commands: Object.freeze([]),
    agents: Object.freeze([]),
    pointers: POINTER_COMMANDS,
    preCommit: 'pre-commit',
    protocol: false,
  }),
});

/** The CI workflow of the workspace. The workflows of a code repository are `workflowFiles()` of install.js. */
export const WORKSPACE_WORKFLOW = '.github/workflows/workspace.yml';

/**
 * The files of the template one target installs, from the lists of the plugin folder.
 * @param {string|undefined} target `workspace`, `code`, or undefined for the whole harness
 * @param {{commands: string[], agents: string[]}} available the names found in `harness/commands/` and `harness/agents/`
 * @returns {{commands: string[], agents: string[], pointers: string[], protocol: boolean, preCommit: string}}
 */
export function selectFor(target, available) {
  if (target === undefined) return { commands: available.commands, agents: available.agents, pointers: [], protocol: true, preCommit: TARGETS.code.preCommit };
  const t = TARGETS[target];
  const keep = (names, wanted) => (wanted === null ? [...names] : names.filter((n) => wanted.includes(n)));
  return { commands: keep(available.commands, t.commands), agents: keep(available.agents, t.agents), pointers: [...(t.pointers ?? [])], protocol: t.protocol, preCommit: t.preCommit };
}

/** The template of the pre-commit hook for a target (the whole harness takes the code one). */
export const preCommitTemplate = (target) => (target === undefined ? TARGETS.code.preCommit : TARGETS[target].preCommit);

/* ---------- threshold files ---------- */

/** The files that hold a linter, formatter or type-check threshold. The install proposes them and never adds them. */
const THRESHOLD_FILES = [
  /^\.eslintrc(\..+)?$/, /^eslint\.config\..+$/, /^\.prettierrc(\..+)?$/, /^prettier\.config\..+$/, /^biome\.jsonc?$/,
  /^\.stylelintrc(\..+)?$/, /^tsconfig.*\.json$/, /^\.golangci\.ya?ml$/, /^ruff\.toml$/, /^pyproject\.toml$/,
];

/**
 * The files of the top folder of a code repository that look like a threshold file, sorted.
 * @param {string} dir
 * @returns {string[]}
 */
export function thresholdCandidates(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => THRESHOLD_FILES.some((re) => re.test(f)) && statSync(join(dir, f), { throwIfNoEntry: false })?.isFile()).sort();
}

/* ---------- the settings of one code repository ---------- */

/** The settings of a code repository, tracked in it: `harness: {required_gates, threshold_files}`. */
export const REPO_SETTINGS = '.claude/recade.yaml';

const isNames = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * The settings of the code repository `dir`: `{required_gates?, threshold_files?}`. A missing file gives `{}`. A file that does
 * not parse, or whose keys have the wrong shape, gives `{error: true, message}` and nothing else: the caller fails closed.
 * @param {string} dir
 * @returns {{required_gates?: string[], threshold_files?: string[], error?: true, message?: string}}
 */
export function readRepoSettings(dir) {
  const file = join(dir, REPO_SETTINGS);
  if (!existsSync(file)) return {};
  const bad = (message) => ({ error: true, message: `${REPO_SETTINGS}: ${message}` });
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) return bad(doc.errors[0].message.split('\n')[0]);
  const data = doc.toJS();
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) return bad('it must hold a map.');
  const harness = data.harness;
  if (harness === undefined || harness === null) return {};
  if (typeof harness !== 'object' || Array.isArray(harness)) return bad('harness must be a map.');
  const out = {};
  for (const key of ['required_gates', 'threshold_files']) {
    if (harness[key] === undefined) continue;
    if (!isNames(harness[key])) return bad(`harness.${key} must be a list of names.`);
    out[key] = harness[key];
  }
  return out;
}

/**
 * Set `required_gates` and/or `threshold_files` in the settings of the code repository `dir`, and keep every other key.
 * The lists are written in flow style, which is what the guard reads without a YAML parser. With `own`, the file goes
 * through the own-files policy of an adopted repository (recorded in `.recade/created.json`).
 * @param {string} dir
 * @param {{required_gates?: string[], threshold_files?: string[]}} patch
 * @param {{own?: boolean}} [options]
 */
export function writeRepoSettings(dir, patch, { own = false } = {}) {
  const file = join(dir, REPO_SETTINGS);
  const doc = existsSync(file) ? parseDocument(readFileSync(file, 'utf8')) : new Document({});
  if (doc.errors.length > 0) throw new Error(`${REPO_SETTINGS} does not parse: ${doc.errors[0].message.split('\n')[0]}`);
  if (doc.contents === null) doc.contents = doc.createNode({});
  for (const [key, names] of Object.entries(patch)) {
    const seq = doc.createNode(names);
    seq.flow = true;
    doc.setIn(['harness', key], seq);
  }
  const text = doc.toString({ flowCollectionPadding: false });
  if (own) writeOwnFile(dir, REPO_SETTINGS, text, { keepEdits: true });
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
