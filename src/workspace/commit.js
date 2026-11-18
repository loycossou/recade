import { spawnSync } from 'node:child_process';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { loadState } from '../state.js';

/**
 * Commits of the workspace repository, and its automatic push.
 *
 * Recade commands commit documents and state straight on the workspace default branch, so several sessions that move
 * a status at the same moment must not mix their commits: every commit runs under `.recade/commit.lock`. The lock is
 * created exclusively and holds the pid, the host and the time. A lock younger than ten minutes is waited for; an older
 * one is reported and never removed by Recade, because a lock that looks dead may belong to a process that is only slow.
 * The one exception is a lock whose holder is a process of this very machine that no longer exists (a command that was
 * killed): that lock is removed, with one line of notice, and the command goes on.
 */

/** The lock file, relative to the workspace. */
export const LOCK_FILE = '.recade/commit.lock';
/** Age after which a held lock is reported as stale. */
export const STALE_MS = 10 * 60 * 1000;
/** How long a command waits for a lock that another command holds. */
export const WAIT_MS = 30 * 1000;
const POLL_MS = 25;
const PUSH_TIMEOUT_MS = 60 * 1000;

/** A refusal of the commit step. `exit` is the exit code the command ends with. */
export class CommitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommitError';
    this.exit = 1;
  }
}

/** The identity of a commit when git has none: a placeholder that is local to this commit. */
const PLACEHOLDER = Object.freeze(['-c', 'user.name=Recade', '-c', `user.email=${['noreply', 'recade.invalid'].join('@')}`]);

/**
 * Default runner for the commit and push calls: no shell, no terminal prompt (a push that asks for a password fails
 * instead of hanging), and a time limit on every call.
 */
export function defaultExec(cmd, { cwd }) {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: PUSH_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) return { code: 127, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error.message}\n` };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The line that tells what git said: the first `fatal:` or `error:` line, else the last non-empty one. */
const errorLine = (text) => {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[lines.length - 1] ?? '';
};

/** Run a command through the injected exec, sync or async; a throwing exec counts as exit 127. */
async function run(exec, cmd, ws) {
  try {
    const r = await exec(cmd, { cwd: ws });
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = (now) => +now();

/** A path is kept inside the workspace: relative, no `..` segment, not an option. */
function checkPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new CommitError('A workspace commit needs at least one path.');
  return paths.map((p) => {
    if (typeof p !== 'string' || p === '' || /[\0\n]/.test(p) || p.startsWith('/') || p.startsWith('-') || p.split('/').includes('..')) {
      throw new CommitError(`Not a workspace path: ${JSON.stringify(p)}. Use a path relative to the workspace.`);
    }
    return p.replace(/\/+$/, '');
  });
}

/** What the lock file says: `{pid, host, at}` with `at` in ms, or `at` from the file time when the content is unreadable. */
function readLock(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const at = Date.parse(data?.at);
    if (Number.isFinite(at)) return { pid: data.pid ?? 'unknown', host: typeof data.host === 'string' ? data.host : null, at };
  } catch {
    // fall through to the file time
  }
  try {
    return { pid: 'unknown', host: null, at: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/** Is a process of this machine alive? EPERM means it exists (another user's); only ESRCH means it is gone. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/** The holder of a lock is a process of this machine that is gone: nothing can be running under that lock. */
const deadHolder = (held) => held.host === hostname() && Number.isInteger(held.pid) && held.pid !== process.pid && !pidAlive(held.pid);

/**
 * Remove the lock of a dead holder. The file is moved aside first and read again, so a lock that another command
 * created between our read and our move is put back and not destroyed.
 */
function removeDead(path, held) {
  const aside = `${path}.dead-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // someone else removed it first
  }
  const again = readLock(aside);
  if (again === null || (again.pid === held.pid && again.at === held.at)) {
    rmSync(aside, { force: true });
    return;
  }
  try {
    linkSync(aside, path);
  } catch {
    // another lock was created meanwhile: the two holders cannot be told apart any more, the newer file wins
  }
  rmSync(aside, { force: true });
}

/** Take the lock, waiting for a fresh one. Returns once this call holds it. */
async function acquire(ws, { now, wait, notify }) {
  const path = join(ws, LOCK_FILE);
  mkdirSync(join(ws, '.recade'), { recursive: true });
  const deadline = Date.now() + wait;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, host: hostname(), at: new Date(stamp(now)).toISOString() })}\n`);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = readLock(path);
    if (held === null) continue; // released between the two calls: try again
    if (deadHolder(held)) {
      removeDead(path, held);
      notify?.(`removed ${LOCK_FILE}: the process that held it (pid ${held.pid}) is gone.`);
      continue;
    }
    const since = new Date(held.at).toISOString();
    if (stamp(now) - held.at > STALE_MS) {
      throw new CommitError(`stale lock, remove ${LOCK_FILE} if no Recade command runs (held by pid ${held.pid}${held.host === null ? '' : ` on ${held.host}`} since ${since}).`);
    }
    if (Date.now() >= deadline) {
      throw new CommitError(`Another Recade command holds ${LOCK_FILE} (pid ${held.pid}${held.host === null ? '' : ` on ${held.host}`} since ${since}). Run this command again in a moment.`);
    }
    await sleep(POLL_MS);
  }
}

/** The workspace default branch: what `origin/HEAD` says, else `main`. */
async function defaultBranch(ws, exec) {
  const r = await run(exec, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], ws);
  const name = r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : '';
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ? name : 'main';
}

/** The branch `HEAD` is on, or null when it is detached. */
async function currentBranch(ws, exec) {
  const r = await run(exec, ['git', 'symbolic-ref', '--short', 'HEAD'], ws);
  return r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
}

/** The files of `paths` that have changes in the working tree or the index (git status, so untracked files count). */
async function dirtyPaths(ws, paths, exec) {
  const r = await run(exec, ['git', 'status', '--porcelain', '-z', '--', ...paths], ws);
  if (r.code !== 0) throw new CommitError(`git could not read the status: ${errorLine(r.stderr) || `exit ${r.code}`}`);
  const out = [];
  const entries = r.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++; // a rename carries its source as the next entry
  }
  return out;
}

/** The files of `paths` that differ from HEAD in the index or the working tree, each untracked file listed by itself. */
async function changedFiles(ws, paths, exec) {
  const r = await run(exec, ['git', '-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths], ws);
  if (r.code !== 0) return [];
  const out = [];
  const entries = r.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return out;
}

/**
 * Put back the files of `paths` that changed since `before` (the files that were already changed then): a file of HEAD
 * is restored from HEAD, in the index and the working tree; a new file is unstaged and removed. Returns the files put back.
 */
async function rollback(ws, paths, before, exec) {
  const changed = (await changedFiles(ws, paths, exec)).filter((f) => !before.has(f));
  const known = [];
  const added = [];
  for (const f of changed) ((await run(exec, ['git', 'cat-file', '-e', `HEAD:${f}`], ws)).code === 0 ? known : added).push(f);
  if (known.length > 0) await run(exec, ['git', '--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...known], ws);
  if (added.length > 0) {
    await run(exec, ['git', '--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', '--', ...added], ws);
    for (const f of added) rmSync(join(ws, f), { force: true });
  }
  return changed;
}

/** What a refused commit says to change: the lines a hook printed on stdout (lint findings, index errors), five at most. */
const hookFindings = (stdout) => String(stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '').slice(0, 5);

/** The staged files that are not under any of `paths`. */
async function stagedOutside(ws, paths, exec) {
  const r = await run(exec, ['git', '-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '-z'], ws);
  if (r.code !== 0) throw new CommitError(`git could not read the index: ${errorLine(r.stderr) || `exit ${r.code}`}`);
  return r.stdout.split('\0').filter((f) => f !== '' && !paths.some((p) => f === p || f.startsWith(`${p}/`)));
}

/**
 * The refusals that come before a step: not on the default branch, staged changes outside `paths`, and (unless `own`
 * is false) changes in `paths` that the step did not make. Throws a CommitError; writes nothing.
 */
async function preflight(ws, paths, exec, { own = true } = {}) {
  // Commit and push must target the same branch: the default one.
  const branch = await currentBranch(ws, exec);
  const main = await defaultBranch(ws, exec);
  if (branch !== main) {
    throw new CommitError(`The workspace is ${branch === null ? 'on a detached HEAD' : `on branch ${branch}`}, and its default branch is ${main}. Recade commits and pushes on the default branch only: run git switch ${main}, then run this command again. Nothing was written.`);
  }
  const outside = await stagedOutside(ws, paths, exec);
  if (outside.length > 0) {
    throw new CommitError(`The index already holds staged changes outside this step: ${outside.join(', ')}. Commit or unstage them, then run this command again. Nothing was written.`);
  }
  if (!own) return;
  // The step commits what it changes. A path that already has changes was edited by someone else: never commit that.
  // A workspace with no commit yet has everything untracked, Recade's own first files included: nothing is foreign.
  const born = (await run(exec, ['git', 'rev-parse', '--verify', '-q', 'HEAD'], ws)).code === 0;
  const foreign = born ? await dirtyPaths(ws, paths, exec) : [];
  if (foreign.length > 0) {
    throw new CommitError(`${foreign.join(', ')} already ${foreign.length === 1 ? 'has' : 'have'} changes that this step did not make. Commit or restore ${foreign.length === 1 ? 'it' : 'them'}, then run this command again. Nothing was written.`);
  }
}

/**
 * The same refusals as `commitWorkspace`, without the lock and without writing: for a step whose work is too long to
 * hold the lock (it calls gh or clones). Run it first, do the work, then `commitWorkspace(..., {own: false})`.
 * @throws {CommitError}
 */
export async function checkWorkspace(ws, paths, { exec = defaultExec } = {}) {
  await preflight(ws, checkPaths(paths), exec);
}

/**
 * Commit `paths` of the workspace `ws` under `.recade/commit.lock`.
 *
 * Order: take the lock, run the refusals of `checkWorkspace` (not on the default branch, staged changes outside
 * `paths`, a path already changed by someone else), run `mutate` (the change that the commit records, so a read, a
 * change and a write cannot interleave with another session), stage only the files to commit, commit, release the
 * lock. Nothing to stage is not an error: `{committed: false}`.
 * @param {string} ws workspace folder
 * @param {string[]} paths relative to `ws`; a folder covers the files under it
 * @param {string|((value: any) => string|null)} message a function gets what `mutate` returned and may return null to skip the commit
 * @param {{exec?: Function, now?: () => Date|number, wait?: number, mutate?: () => any, own?: boolean, stage?: (value: any) => string[], notify?: (line: string) => void}} [options]
 *   `own: false` skips the check for changes that the step did not make (the caller ran `checkWorkspace` before its
 *   work, outside the lock). `stage` names the files to commit when `mutate` knows them only after it ran (default:
 *   `paths`); they must lie under `paths`. `notify` gets one line when a dead holder's lock was removed. When the step
 *   fails after `mutate` ran (git add or commit refused, a hook said no, `mutate` threw), the files it changed under the
 *   committed paths are put back as they were, so the next step does not find them as someone else's edit. `clean: true`
 *   says the paths were clean before the step's work (a caller that ran `checkWorkspace` and did the work outside the
 *   lock): all of their changes are then the step's.
 * @returns {Promise<{committed: boolean, sha: string|null, value: any}>}
 * @throws {CommitError} exit 1: bad path, lock stale or held, refusals above, git failed
 */
export async function commitWorkspace(ws, paths, message, { exec = defaultExec, now = () => new Date(), wait = WAIT_MS, mutate, own = true, stage, notify, clean = false } = {}) {
  const scope = checkPaths(paths);
  await acquire(ws, { now, wait, notify });
  try {
    await preflight(ws, scope, exec, { own });
    // What was already changed before the step: a failure puts back only what the step wrote. With no commit yet there
    // is no HEAD to put back from, so nothing is.
    const born = (await run(exec, ['git', 'rev-parse', '--verify', '-q', 'HEAD'], ws)).code === 0;
    const before = !born ? null : new Set(clean ? [] : await changedFiles(ws, scope, exec));
    let targets = scope;
    const undo = async (err) => {
      if (before === null) return err;
      const back = await rollback(ws, targets, before, exec);
      if (!(err instanceof CommitError) || back.length === 0) return err;
      return new CommitError(`${err.message.replace(/\.$/, '')}. Nothing was recorded: ${back.join(', ')} ${back.length === 1 ? 'is' : 'are'} back as before this step.`);
    };
    let value;
    try {
      value = mutate === undefined ? undefined : await mutate();
      const text = typeof message === 'function' ? message(value) : message;
      if (text === null || text === undefined) return { committed: false, sha: null, value };
      targets = stage === undefined ? scope : checkPaths(stage(value));
      if (!targets.every((t) => scope.some((p) => t === p || t.startsWith(`${p}/`)))) {
        targets = scope;
        throw new CommitError(`Files to commit outside this step: ${checkPaths(stage(value)).join(', ')}.`);
      }
      const add = await run(exec, ['git', 'add', '-A', '--', ...targets], ws);
      if (add.code !== 0) throw new CommitError(`git add failed: ${errorLine(add.stderr) || `exit ${add.code}`}`);
      const staged = await run(exec, ['git', 'diff', '--cached', '--quiet'], ws);
      if (staged.code === 0) return { committed: false, sha: null, value };
      const extra = await stagedOutside(ws, targets, exec);
      if (extra.length > 0) {
        await run(exec, ['git', 'restore', '--staged', '--', ...targets], ws);
        throw new CommitError(`The index holds staged changes outside this step: ${extra.join(', ')}. Commit or unstage them, then run this command again.`);
      }
      const base = ['git', '-c', 'commit.gpgsign=false'];
      const tail = ['commit', '-q', '-m', text];
      let c = await run(exec, [...base, ...tail], ws);
      if (c.code !== 0) c = await run(exec, [...base, ...PLACEHOLDER, ...tail], ws);
      if (c.code !== 0) {
        await run(exec, ['git', 'restore', '--staged', '--', ...targets], ws);
        // A hook prints what to change on stdout (style findings, index errors): the message carries it.
        const found = hookFindings(c.stdout);
        throw new CommitError(`git commit failed: ${errorLine(c.stderr) || `exit ${c.code}`}${found.length > 0 ? ` What to change: ${found.join('; ')}` : ''}`);
      }
    } catch (err) {
      throw await undo(err);
    }
    const head = await run(exec, ['git', 'rev-parse', 'HEAD'], ws);
    return { committed: true, sha: head.code === 0 ? head.stdout.trim() : null, value };
  } finally {
    rmSync(join(ws, LOCK_FILE), { force: true });
  }
}

/**
 * Push the workspace default branch to `origin`, when the owner agreed to it (`workspace.auto_push: true` in
 * `recade/state.yaml`). With auto-push off no git call is made at all. A failed push never throws: it comes back as
 * one `warning` line, and the next push carries the commits that were missed. A push refused because the remote moved
 * on is followed by a fetch: when the histories diverged, the warning gives the exact commands to catch up.
 * @param {string} ws workspace folder
 * @param {{exec?: Function}} [options]
 * @returns {Promise<{pushed: boolean, warning?: string}>}
 */
export async function pushWorkspace(ws, { exec = defaultExec } = {}) {
  let on = false;
  try {
    on = loadState(ws)?.workspace?.auto_push === true;
  } catch {
    on = false;
  }
  if (!on) return { pushed: false };
  const branch = await defaultBranch(ws, exec);
  const r = await run(exec, ['git', 'push', 'origin', branch], ws);
  if (r.code === 0) return { pushed: true };
  // A refusal for a remote that moved on (another machine, a commit on GitHub) never fixes itself: fetch, and when the
  // two histories diverged, say the exact command instead of failing the same way at every commit.
  if (/\b(rejected|non-fast-forward|fetch first)\b/i.test(`${r.stderr}\n${r.stdout}`)) {
    const fetched = await run(exec, ['git', 'fetch', '-q', 'origin', branch], ws);
    const ahead = fetched.code === 0 ? await run(exec, ['git', 'merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, 'HEAD'], ws) : null;
    if (ahead !== null && ahead.code === 1) {
      const dir = `'${ws.replaceAll("'", "'\\''")}'`;
      return { pushed: false, warning: `workspace push refused: the workspace and origin/${branch} have diverged (a commit from another machine or from GitHub), so nothing was pushed. Run: git -C ${dir} pull --rebase origin ${branch}, then git -C ${dir} push origin ${branch}` };
    }
  }
  return { pushed: false, warning: `workspace push failed: ${errorLine(r.stderr) || errorLine(r.stdout) || `exit ${r.code}`}` };
}
