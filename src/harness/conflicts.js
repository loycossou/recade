import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from '../state.js';
import { defaultExec } from './stamps.js';

/**
 * @typedef {{code: number, stdout: string, stderr: string}} ExecResult
 * @typedef {(cmd: string[], opts: {cwd: string}) => ExecResult} Exec
 * @typedef {{a: string, b: string, files: string[]}} Conflict
 */

/** `git merge-tree --write-tree` arrived in git 2.38. */
export const MIN_GIT = [2, 38];

export class GitTooOldError extends Error {
  constructor(found) {
    super(`git ${found} is too old: the conflict check needs git ${MIN_GIT.join('.')} or newer (git merge-tree --write-tree). Update git, then run it again.`);
    this.name = 'GitTooOldError';
  }
}

/** Throw a `GitTooOldError` when git is older than 2.38. */
function requireGit(repo, exec) {
  const r = exec(['git', '--version'], { cwd: repo });
  const m = /(\d+)\.(\d+)/.exec(r.stdout ?? '');
  if (r.code !== 0 || m === null) throw new Error(`Cannot run git: ${(r.stderr || r.stdout || 'no output').trim()}`);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) throw new GitTooOldError(`${major}.${minor}`);
}

/** The commit of a branch: the local branch first, then `origin/<name>`. Null when neither exists. */
function resolve(repo, name, exec) {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    const r = exec(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo });
    if (r.code === 0 && /^[0-9a-f]{40,64}$/.test(r.stdout.trim())) return r.stdout.trim();
  }
  return null;
}

/** The files two commits cannot merge on. Empty when the merge is clean. */
function mergeFiles(repo, a, b, exec) {
  const r = exec(['git', 'merge-tree', '--write-tree', '--name-only', '-z', a, b], { cwd: repo });
  if (r.code === 0) return [];
  if (r.code !== 1) throw new Error(`git merge-tree failed: ${(r.stderr || r.stdout || `exit ${r.code}`).trim()}`);
  // With -z: the tree id, then one NUL-ended name for each conflicted file, then an empty entry, then the messages.
  const parts = r.stdout.split('\0');
  const files = [];
  for (const part of parts.slice(1)) {
    if (part === '') break;
    if (!files.includes(part)) files.push(part);
  }
  return files;
}

/**
 * Merge every pair of open branches, and every branch against the base, without touching the work tree, and
 * list the pairs that conflict with the files they conflict on (spec 10.10). A branch is a name: the local
 * branch is used when it exists, otherwise `origin/<name>`. A name that resolves to neither is skipped and
 * named in `skipped`. The base must exist. Throws `GitTooOldError` before git 2.38.
 * With `label` (the name of a code repository of a workspace) every branch is reported as `<label>:<branch>`.
 * @param {string} repo
 * @param {{base?: string, branches: string[], exec?: Exec, label?: string}} options
 * @returns {{conflicts: Conflict[], checked: string[], skipped: string[]}}
 */
export function inspectConflicts(repo, { base = 'main', branches, exec = defaultExec, label }) {
  requireGit(repo, exec);
  const baseCommit = resolve(repo, base, exec);
  if (baseCommit === null) throw new Error(`The base branch "${base}" does not exist here, neither as a local branch nor as origin/${base}.`);
  const checked = [];
  const skipped = [];
  const commits = new Map();
  for (const name of [...new Set(branches)]) {
    if (name === base) continue;
    const commit = resolve(repo, name, exec);
    if (commit === null) skipped.push(name);
    else {
      checked.push(name);
      commits.set(name, commit);
    }
  }
  /** @type {Conflict[]} */
  const conflicts = [];
  for (const [i, a] of checked.entries()) {
    const against = mergeFiles(repo, commits.get(a), baseCommit, exec);
    if (against.length > 0) conflicts.push({ a, b: base, files: against });
    for (const b of checked.slice(i + 1)) {
      const files = mergeFiles(repo, commits.get(a), commits.get(b), exec);
      if (files.length > 0) conflicts.push({ a, b, files });
    }
  }
  if (label === undefined) return { conflicts, checked, skipped };
  const named = (name) => `${label}:${name}`;
  return {
    conflicts: conflicts.map((c) => ({ ...c, a: named(c.a), b: named(c.b) })),
    checked: checked.map(named),
    skipped: skipped.map(named),
  };
}

/**
 * The conflicts of every code repository of a workspace (spec 6.13): each repository is checked on its own, in
 * `repos/<name>/`, against its default branch (or `base`), and a branch is reported as `<repo>:<branch>`. Two repositories never conflict with each other.
 * `branches` limits the check to those names in every repository; without it each repository lists its own `slice/*`
 * branches. Throws, naming the repository, when a repository folder is missing or a check fails.
 * @param {string} ws the workspace folder
 * @param {{base?: string, branches?: string[], exec?: Exec}} [options]
 * @returns {{conflicts: Conflict[], checked: string[], skipped: string[]}}
 */
export function inspectWorkspaceConflicts(ws, { base, branches, exec = defaultExec } = {}) {
  const repos = loadState(ws)?.repos;
  const entries = (Array.isArray(repos) ? repos : []).filter((r) => r !== null && typeof r === 'object' && typeof r.name === 'string');
  const out = { conflicts: [], checked: [], skipped: [] };
  for (const entry of entries) {
    const dir = join(ws, 'repos', entry.name);
    if (!existsSync(join(dir, '.git'))) throw new Error(`${entry.name}: repos/${entry.name} is not a git repository here. Run: recade repo sync`);
    try {
      const own = base ?? (typeof entry.default_branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(entry.default_branch) ? entry.default_branch : 'main');
      const found = inspectConflicts(dir, { base: own, branches: branches ?? listSliceBranches(dir, exec), exec, label: entry.name });
      out.conflicts.push(...found.conflicts);
      out.checked.push(...found.checked);
      out.skipped.push(...found.skipped);
    } catch (err) {
      if (err instanceof GitTooOldError) throw err;
      throw new Error(`${entry.name}: ${String(err?.message ?? err).split('\n')[0]}`);
    }
  }
  return out;
}

/**
 * The conflicts between open slice branches and the base, as `[{a, b, files}]`. See `inspectConflicts`.
 * @param {string} repo
 * @param {{base?: string, branches: string[], exec?: Exec}} options
 * @returns {Conflict[]}
 */
export function checkConflicts(repo, options) {
  return inspectConflicts(repo, options).conflicts;
}

/**
 * Names of the slice branches (`slice/*`) that exist here, local or on origin, without duplicates.
 * @param {string} repo
 * @param {Exec} [exec]
 * @returns {string[]}
 */
export function listSliceBranches(repo, exec = defaultExec) {
  const r = exec(['git', 'for-each-ref', '--format=%(refname)', 'refs/heads/slice/', 'refs/remotes/origin/slice/'], { cwd: repo });
  if (r.code !== 0) throw new Error(`git for-each-ref failed: ${(r.stderr || '').trim()}`);
  const names = r.stdout.split('\n').map((l) => l.trim().replace(/^refs\/(heads|remotes\/origin)\//, '')).filter((n) => n.startsWith('slice/'));
  return [...new Set(names)].sort();
}
