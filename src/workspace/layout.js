import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { saveState } from '../state.js';

/** The tracked folders of a workspace. Folders that stay empty get a `.gitkeep`. */
export const WORKSPACE_TREE = Object.freeze([
  'recade', 'intake/attachments', 'team', 'design', 'decisions', 'retros', 'docs/figures', 'docs/deliverables', 'docs/source', 'slices',
]);

/** What the workspace `.gitignore` holds: the heavy outputs, the drafts and the per-machine state. */
export const IGNORED = Object.freeze(['artifacts/', 'tmp/', '.recade/']);

/**
 * The folders that hold code checkouts: the code repositories and the slice worktrees. They are kept out of the git of
 * the workspace by `.git/info/exclude`, which only git reads, and not by `.gitignore`: a tool run inside a checkout
 * that honours the `.gitignore` files of the folders above it (a dependency scanner, a search) would otherwise skip
 * the whole checkout as ignored.
 */
export const LOCAL_ONLY = Object.freeze(['repos/', 'worktrees/']);

/** The lines that mean the same as `entry` (`repos/`) in an ignore file. */
const sameLines = (entry) => {
  const bare = entry.replace(/\/$/, '');
  return [entry, `/${entry}`, bare, `/${bare}`];
};

/** The `info/exclude` file of the git of `ws`, or null when `ws` has no `.git`. A `.git` file (a worktree) is followed. */
export function excludeFile(ws) {
  const dotGit = join(ws, '.git');
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return join(dotGit, 'info', 'exclude');
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  if (m === null) return null;
  const gitdir = resolve(ws, m[1].trim());
  // A linked worktree shares the info/exclude of its main repository.
  let common = gitdir;
  try {
    common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
  } catch { /* not a linked worktree */ }
  return join(common, 'info', 'exclude');
}

/** Does `text` (an ignore file) hold `entry`, in any of its forms? */
export const holds = (text, entry) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).some((l) => sameLines(entry).includes(l));

/**
 * Keep the code checkouts (`LOCAL_ONLY`) out of the git of the workspace through `.git/info/exclude`. Lines are only
 * added to the exclude file. With `drop`, their lines also leave the `.gitignore` of the workspace (older workspaces
 * had them there): only the harness install does it, since that file is tracked and the install is committed.
 * Returns what it did, or null when `ws` is not a git checkout.
 * @param {string} ws
 * @param {{drop?: boolean}} [options]
 * @returns {{excluded: string[], dropped: string[]} | null}
 */
export function keepLocal(ws, { drop = false } = {}) {
  const file = excludeFile(ws);
  if (file === null) return null;
  // Anchored to the root (`/repos/`): a bare `repos/` would also hide `recade/repos/`, the settings of the code
  // repositories. An older bare line is rewritten anchored.
  let before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const anchored = before.split('\n').map((l) => {
    const hit = LOCAL_ONLY.find((e) => [e, e.replace(/\/$/, '')].includes(l.trim()));
    return hit === undefined ? l : `/${hit}`;
  }).join('\n');
  if (anchored !== before) {
    writeFileSync(file, anchored);
    before = anchored;
  }
  const excluded = LOCAL_ONLY.filter((e) => !holds(before, e));
  if (excluded.length > 0) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${before === '' || before.endsWith('\n') ? '' : '\n'}${excluded.map((e) => `/${e}`).join('\n')}\n`);
  }
  const dropped = [];
  const ignorePath = join(ws, '.gitignore');
  if (drop && existsSync(ignorePath)) {
    const text = readFileSync(ignorePath, 'utf8');
    const kept = text.split('\n').filter((l) => {
      const hit = LOCAL_ONLY.find((e) => sameLines(e).includes(l.trim()));
      if (hit !== undefined) dropped.push(l.trim());
      return hit === undefined;
    });
    if (dropped.length > 0) writeFileSync(ignorePath, kept.join('\n'));
  }
  return { excluded, dropped };
}

/** Is `entry` kept out of the git of `ws`, by its exclude file or by its `.gitignore`? */
export function keptOut(ws, entry) {
  const file = excludeFile(ws);
  const read = (f) => (f !== null && existsSync(f) ? readFileSync(f, 'utf8') : '');
  return holds(read(file), entry) || holds(read(join(ws, '.gitignore')), entry);
}

/** Where a code repository records its workspace: a per-machine file with one line, the workspace path. */
export const LINK_FILE = '.recade/workspace';

/** What to run when a link is missing or stale. */
export const SYNC_ADVICE = 'recade repo sync';

const oneLine = (text) => String(text ?? '').trim().split('\n')[0];
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The folder `createWorkspace` makes for `slug`. */
export const workspaceDir = (parent, slug) => join(parent, `${slug}-workspace`);

/** The project name a workspace folder stands for: its name without the `-workspace` suffix. */
export const projectName = (dir) => basename(dir).replace(/-workspace$/, '');

/**
 * Refuse a parent folder that is, or sits under, a file: the nearest folder that exists on the way must be a folder.
 * A parent that does not exist yet is fine (it is created). Shared by `recade new` and `recade adopt init`.
 * @param {string} parent absolute path
 * @throws {Error} with a message the owner can act on
 */
export function assertParent(parent) {
  for (let d = resolve(parent); ; d = dirname(d)) {
    let st = null;
    try {
      st = statSync(d);
    } catch {
      if (dirname(d) === d) return;
      continue;
    }
    if (!st.isDirectory()) throw new Error(`The parent folder ${parent} is ${d === resolve(parent) ? 'a file, not a folder' : `under ${d}, which is a file, not a folder`}. Choose a folder.`);
    return;
  }
}

/**
 * Create `<parent>/<slug>-workspace`: the tree, `git init -b main`, the `.gitignore` of the three ignored entries, the
 * `.git/info/exclude` of the code checkouts, and
 * a first `recade/state.yaml` that says `kind: workspace`. Refuses an existing folder that is not empty. If anything
 * fails, what this call created is removed.
 * @param {string} parent
 * @param {string} slug
 * @param {{exec: (cmd: string, args: string[]) => Promise<{code: number, stderr?: string}>}} options
 * @returns {Promise<{dir: string}>}
 */
export async function createWorkspace(parent, slug, { exec }) {
  assertParent(parent);
  const dir = workspaceDir(parent, slug);
  const existed = existsSync(dir);
  if (existed && readdirSync(dir).length > 0) {
    throw new Error(`The folder ${dir} already exists and is not empty. Choose another name.`);
  }
  try {
    for (const d of WORKSPACE_TREE) mkdirSync(join(dir, d), { recursive: true });
    const git = await exec('git', ['-C', dir, 'init', '-b', 'main']);
    if (git.code !== 0) throw new Error(`git init failed: ${oneLine(git.stderr) || `exit ${git.code}`}`);
    saveState(dir, { version: 1, kind: 'workspace' });
    writeFileSync(join(dir, '.gitignore'), `${IGNORED.join('\n')}\n`);
    keepLocal(dir);
    for (const d of WORKSPACE_TREE) {
      if (readdirSync(join(dir, d)).length === 0) writeFileSync(join(dir, d, '.gitkeep'), '');
    }
  } catch (err) {
    if (existed) for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    else rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir };
}

/** Is `dir` the root of a workspace: a `recade/state.yaml` that says `kind: workspace`? */
function isWorkspaceDir(dir) {
  try {
    return parse(readFileSync(join(dir, 'recade', 'state.yaml'), 'utf8'))?.kind === 'workspace';
  } catch {
    return false;
  }
}

/**
 * The main repository of the git folder at `dir`: `dir` itself, or, for a worktree, the repository its `.git` file
 * leads to. Null when `dir` has no `.git` or the main repository cannot be told.
 */
function mainRepoOf(dir) {
  const dotGit = join(dir, '.git');
  let text;
  try {
    if (statSync(dotGit).isDirectory()) return dir;
    text = readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (match === null) return null;
  const gitdir = resolve(dir, match[1].trim());
  let common = gitdir;
  try {
    common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
  } catch {
    return null;
  }
  return basename(common) === '.git' ? dirname(common) : null;
}

/** The nearest folder from `cwd` upwards that holds a `.git`, or null. */
function gitTop(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The main code repository of the git folder `top`, or null when `top` is null, is no git folder, or is a workspace:
 * a folder that is not yet a repository but sits inside a workspace resolves to the workspace's own `.git`, and a
 * workspace is never a code repository to link.
 */
function codeRepoOf(top) {
  const main = top === null ? null : mainRepoOf(top);
  return main === null || isWorkspaceDir(main) ? null : main;
}

/** The line of the link file of the main repository `main`, or null when it is absent or empty. */
function readLink(main) {
  try {
    return readFileSync(join(main, LINK_FILE), 'utf8').split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * The workspace of `cwd`.
 * - `self`: `cwd` is in a workspace (its `recade/state.yaml` says `kind: workspace`).
 * - `link`: `cwd` is in a code repository or a worktree whose main repository has `.recade/workspace` naming a workspace.
 * A git folder that is not a workspace never inherits the workspace around it: without its own link, the answer is null.
 * @param {string} cwd
 * @returns {{dir: string, via: 'self'|'link'}|null}
 */
export function findWorkspace(cwd) {
  let dir = real(cwd);
  for (;;) {
    if (isWorkspaceDir(dir)) return { dir, via: 'self' };
    if (existsSync(join(dir, '.git'))) {
      const main = mainRepoOf(dir);
      const link = main === null ? null : readLink(main);
      return link !== null && isWorkspaceDir(link) ? { dir: real(link), via: 'link' } : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Record the workspace in the main repository of `repoDir` (a code repository or one of its worktrees), and keep
 * `.recade/` out of git through `.git/info/exclude`, so no tracked file changes.
 * @param {string} ws the workspace folder
 * @param {string} repoDir
 */
export function linkRepo(ws, repoDir) {
  const top = gitTop(repoDir);
  const main = codeRepoOf(top);
  if (main === null) throw new Error(`${repoDir} is not a git repository.`);
  mkdirSync(join(main, '.recade'), { recursive: true });
  writeFileSync(join(main, LINK_FILE), `${real(ws)}\n`);
  const exclude = join(main, '.git', 'info', 'exclude');
  if (existsSync(join(main, '.git', 'info'))) {
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!text.split(/\r?\n/).includes('/.recade/')) appendFileSync(exclude, `${text === '' || text.endsWith('\n') ? '' : '\n'}/.recade/\n`);
  }
}

/**
 * Is the link of `repoDir` good? It is when it names a workspace whose `repos/<name>` is the main repository of `repoDir`.
 * Reasons: `not a git repository`, `link missing`, `workspace moved` (the named folder is gone or is no workspace),
 * `link points elsewhere` (a workspace that does not hold this repository in `repos/`). The advice is `SYNC_ADVICE`.
 * @param {string} repoDir a code repository, a folder of it, or one of its worktrees
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function checkLink(repoDir) {
  const top = gitTop(repoDir);
  const main = codeRepoOf(top);
  if (main === null) return { ok: false, reason: 'not a git repository' };
  const link = readLink(main);
  if (link === null) return { ok: false, reason: 'link missing' };
  if (!isWorkspaceDir(link)) return { ok: false, reason: 'workspace moved' };
  if (real(join(link, 'repos', basename(main))) !== real(main)) return { ok: false, reason: 'link points elsewhere' };
  return { ok: true };
}
