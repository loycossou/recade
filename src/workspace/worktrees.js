import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { REPO_NAME, WORKSPACE_PREFIX, reposOf } from '../project/touches.js';
import { checkSlices } from '../project/slices.js';
import { loadState } from '../state.js';

/**
 * The slice worktrees of a workspace (docs/design.md, section 10.1). Every session starts at the root of the workspace,
 * and the worktree of a slice in a code repository is `<workspace>/worktrees/<repo>/<S-nn>`: a git worktree of
 * `repos/<repo>`, on the branch of the slice, kept out of git by the `.gitignore` of the workspace. The owner never
 * chooses a folder: `recade slices open <S-nn>` reads the `touches:` of the sheet and opens one worktree for each
 * repository it names. A `no-code` slice works in the workspace and opens none.
 *
 * Older projects kept the worktrees at `repos/<repo>/.claude/worktrees/<S-nn>`. `recade harness migrate` moves them.
 */

/** The folder of the slice worktrees, relative to the workspace. */
export const WORKTREES_DIR = 'worktrees';
/** The line of the workspace `.gitignore` that keeps the worktrees out of git. */
export const WORKTREES_IGNORE = 'worktrees/';
/** The old place of the worktrees, relative to a code repository. */
export const LEGACY_DIR = '.claude/worktrees';

const SLICE_ID = /^S-\d{2}[a-z]?$/;
const BRANCH = /^slice\/[A-Za-z0-9._-]+$/;

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The worktree of slice `id` in the code repository `repo`, relative to the workspace. */
export const worktreeRel = (repo, id) => `${WORKTREES_DIR}/${repo}/${id}`;
/** The worktree of slice `id` in the code repository `repo`, as a full path. */
export const worktreePath = (ws, repo, id) => join(ws, WORKTREES_DIR, repo, id);

/** Does the `.gitignore` text keep `worktrees/` of the workspace out of git? */
export function ignoresWorktrees(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).some((l) => ['worktrees/', '/worktrees/', 'worktrees', '/worktrees'].includes(l));
}

/** The worktrees git lists for the repository at `main`: `{path, branch}` with real paths, the main checkout first. */
export function listWorktrees(exec, main) {
  const r = exec(['git', 'worktree', 'list', '--porcelain'], { cwd: main });
  if (r.code !== 0) return null;
  const out = [];
  for (const block of r.stdout.split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    out.push({ path: real(path), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null, prunable: /^prunable/m.test(block) });
  }
  return out;
}

/**
 * Open the worktrees of one slice, one for each code repository its `touches:` name, on the branch of the sheet (the
 * same branch in each). An existing worktree on that branch is kept; a branch that exists without a worktree gets one;
 * otherwise the branch starts from the default branch of the repository. Nothing is removed or reset. A repository that
 * cannot be opened is reported with its reason, and the others are still opened.
 * @param {string} ws the workspace
 * @param {string} id `S-nn`
 * @param {{exec: (cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}}} options
 * @returns {{slice: string, lane: string, branch: string|null, worktrees: {repo: string, path: string, status: 'created'|'attached'|'exists'}[], errors: string[]}}
 */
export function openSlice(ws, id, { exec }) {
  const out = { slice: id, lane: '', branch: null, worktrees: [], errors: [] };
  if (!SLICE_ID.test(id)) {
    out.errors.push(`${id} is not a slice ID: use S-nn, such as S-04.`);
    return out;
  }
  const home = real(ws);
  const state = loadState(home) ?? {};
  if (state.kind !== 'workspace') {
    out.errors.push(`${home} is not a workspace: run recade slices open from the workspace of the project.`);
    return out;
  }
  const row = checkSlices(home).status.find((s) => s.id === id);
  if (row === undefined) {
    out.errors.push(`There is no sheet for ${id} in slices/. Write it first with /slice-write ${id}.`);
    return out;
  }
  out.lane = row.lane;
  if (row.lane === 'no-code') return out;
  const stem = basename(row.file).replace(/\.md$/, '');
  const branch = row.branch;
  if (!BRANCH.test(branch) || branch.toLowerCase() !== `slice/${stem}`.toLowerCase()) {
    out.errors.push(`The sheet of ${id} names the branch "${branch}", and the rule is slice/${stem}. Fix it with /slice-check ${id}.`);
    return out;
  }
  out.branch = branch;
  const entries = (Array.isArray(state.repos) ? state.repos : []).filter((e) => e !== null && typeof e === 'object' && typeof e.name === 'string');
  const registry = entries.map((e) => e.name).filter((n) => REPO_NAME.test(n) && n !== WORKSPACE_PREFIX);
  const repos = reposOf(row.touches, registry).filter((r) => registry.includes(r));
  if (repos.length === 0) {
    out.errors.push(`The touches: of ${id} name no code repository of the registry (${registry.join(', ') || 'empty'}), so there is no worktree to open.`);
    return out;
  }
  let ignore = '';
  try {
    ignore = readFileSync(join(home, '.gitignore'), 'utf8');
  } catch { /* no .gitignore */ }
  if (!ignoresWorktrees(ignore)) {
    out.errors.push(`The .gitignore of the workspace does not hold ${WORKTREES_IGNORE}, so the worktrees would be committed. Run /recade:harness (recade harness install --target workspace, or recade harness migrate for an older project).`);
    return out;
  }
  for (const repo of repos) {
    const main = join(home, 'repos', repo);
    const path = worktreePath(home, repo, id);
    const fail = (why) => out.errors.push(`${repo}: ${why}`);
    if (!existsSync(join(main, '.git'))) {
      fail(`repos/${repo} is not a git repository. Run: recade repo sync`);
      continue;
    }
    const trees = listWorktrees(exec, main);
    if (trees === null) {
      fail('git worktree list failed.');
      continue;
    }
    const here = trees.find((t) => t.path === real(path));
    if (here !== undefined) {
      if (here.branch === branch) out.worktrees.push({ repo, path, status: 'exists' });
      else fail(`${worktreeRel(repo, id)} is a worktree on ${here.branch ?? 'a detached HEAD'}, not on ${branch}. Nothing was changed.`);
      continue;
    }
    const elsewhere = trees.find((t) => t.branch === branch);
    if (elsewhere !== undefined) {
      fail(`the branch ${branch} is checked out at ${elsewhere.path}. Move that worktree with recade harness migrate, or remove it, then open the slice again.`);
      continue;
    }
    if (existsSync(path)) {
      fail(`${worktreeRel(repo, id)} exists and is not a worktree of ${repo}. Move it aside, then open the slice again.`);
      continue;
    }
    const known = exec(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: main }).code === 0;
    let add;
    if (known) add = ['git', 'worktree', 'add', path, branch];
    else {
      const entry = entries.find((e) => e.name === repo);
      const base = typeof entry?.default_branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(entry.default_branch) ? entry.default_branch : 'main';
      if (exec(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${base}^{commit}`], { cwd: main }).code !== 0) {
        fail(`the default branch ${base} has no commit yet, so the slice branch has nothing to start from.`);
        continue;
      }
      add = ['git', 'worktree', 'add', '-b', branch, path, base];
    }
    try {
      mkdirSync(join(home, WORKTREES_DIR, repo), { recursive: true });
    } catch (err) {
      fail(`the folder ${WORKTREES_DIR}/${repo} could not be made: ${String(err.message).split('\n')[0]}`);
      continue;
    }
    const r = exec(add, { cwd: main });
    if (r.code !== 0) {
      fail(`git worktree add failed: ${String(r.stderr).trim().split('\n')[0] || `exit ${r.code}`}`);
      continue;
    }
    out.worktrees.push({ repo, path, status: known ? 'attached' : 'created' });
  }
  return out;
}

/** Where the slices of each session at the root of the workspace are recorded: `.recade/sessions/<session id>`. */
export const SESSIONS_DIR = '.recade/sessions';
/** A session ID of Claude Code, as the hook input and the variable CLAUDE_CODE_SESSION_ID give it. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The slices a session runs, from its record: one slice ID per line, the one of /slice first. Empty when there is none. */
export function sessionSlices(ws, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return [];
  try {
    return [...new Set(readFileSync(join(real(ws), ...SESSIONS_DIR.split('/'), sessionId), 'utf8').split('\n').map((l) => l.trim()).filter((l) => SLICE_ID.test(l)))];
  } catch {
    return [];
  }
}

/**
 * Tie a session to a slice, once `recade slices open` has opened it: the guard then lets the agents of that session write
 * the worktrees of that slice, and no other. The session is the one of Claude Code that runs the command, named by the
 * variable CLAUDE_CODE_SESSION_ID of its shell; the command must run from inside the workspace it opens. `keep` adds the
 * slice to the ones the session runs already (/review, /merge-order: the slice of /slice stays), else it replaces them.
 * @param {string} ws the workspace
 * @param {string} id
 * @param {{sessionId?: string, from?: string, keep?: boolean}} options `from` is the folder the command runs from
 * @returns {{status: 'tied'|'added'|'kept'|'not tied', slices: string[], reason?: string}}
 */
export function tieSession(ws, id, { sessionId, from, keep = false }) {
  const home = real(ws);
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return { status: 'not tied', slices: [], reason: 'no session of Claude Code runs this command (CLAUDE_CODE_SESSION_ID is not set)' };
  }
  const rel = relative(home, real(from ?? home));
  if (rel === '..' || rel.startsWith(`..${'/'}`) || isAbsolute(rel)) {
    return { status: 'not tied', slices: [], reason: `the command runs from ${from}, outside the workspace ${home} it opens` };
  }
  const before = sessionSlices(home, sessionId);
  if (keep && before.includes(id)) return { status: 'kept', slices: before };
  const slices = keep ? [...before, id] : [id];
  try {
    mkdirSync(join(home, ...SESSIONS_DIR.split('/')), { recursive: true });
    writeFileSync(join(home, ...SESSIONS_DIR.split('/'), sessionId), `${slices.join('\n')}\n`);
  } catch (err) {
    return { status: 'not tied', slices: before, reason: `the record could not be written: ${String(err.message).split('\n')[0]}` };
  }
  return { status: keep && before.length > 0 ? 'added' : 'tied', slices };
}

/** The text the CLI prints for `openSlice`. */
export function formatOpen(result) {
  const lines = [];
  if (result.lane === 'no-code') lines.push(`${result.slice} is a no-code slice: it works in the workspace, and no worktree is opened.`);
  for (const w of result.worktrees) lines.push(`${w.status.padEnd(8)} ${w.repo}: ${w.path} on ${result.branch}`);
  for (const e of result.errors) lines.push(`error    ${e}`);
  if (result.errors.length > 0 && result.worktrees.length > 0) lines.push(`${result.slice} is half opened: do not start it until every repository has its worktree.`);
  const tie = result.session;
  if (tie?.status === 'tied') lines.push(`session  this session runs ${result.slice}: its agents write the worktrees of ${result.slice} only.`);
  else if (tie?.status === 'added' || tie?.status === 'kept') lines.push(`session  this session runs ${tie.slices.join(', ')}: ${result.slice} is added, the slice it ran stays.`);
  else if (tie?.status === 'not tied') lines.push(`session  this session is not tied to ${result.slice}: ${tie.reason}. Its agents write no worktree of it.`);
  return `${lines.join('\n')}\n`;
}

/**
 * The slice worktrees of the old layout in the code repositories of a workspace: the worktrees git lists under
 * `repos/<repo>/.claude/worktrees/` whose name is a slice ID (`S-nn`, with an optional letter). With `all`, the other
 * worktrees there are listed too, with `kind`: `merge` for a rebase worktree of /merge-order (`merge-*`), `other` for
 * anything else (a worktree of Claude Code itself, or one made by hand). The migration leaves those where they are.
 * @param {string} ws
 * @param {{exec: Function, all?: boolean}} options
 * @returns {{repo: string, path: string, name: string, branch: string|null, kind: 'slice'|'merge'|'other'}[]}
 */
export function legacyWorktrees(ws, { exec, all = false }) {
  const home = real(ws);
  const state = loadState(home) ?? {};
  const names = (Array.isArray(state.repos) ? state.repos : []).map((e) => e?.name).filter((n) => typeof n === 'string' && REPO_NAME.test(n) && n !== WORKSPACE_PREFIX);
  const out = [];
  for (const repo of names) {
    const main = join(home, 'repos', repo);
    if (!existsSync(join(main, '.git'))) continue;
    const old = real(join(main, ...LEGACY_DIR.split('/')));
    for (const t of listWorktrees(exec, main) ?? []) {
      if (t.path === real(main) || !t.path.startsWith(`${old}/`)) continue;
      const name = t.path.slice(old.length + 1);
      if (name.includes('/')) continue;
      const kind = SLICE_ID.test(name) ? 'slice' : name.startsWith('merge-') ? 'merge' : 'other';
      if (kind !== 'slice' && !all) continue;
      let isDir = false;
      try {
        isDir = statSync(t.path).isDirectory();
      } catch { /* gone */ }
      if (isDir) out.push({ repo, path: t.path, name, branch: t.branch, kind });
    }
  }
  return out;
}
