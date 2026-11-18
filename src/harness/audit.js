import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { REPO_NAME, WORKSPACE_PREFIX, parseTouch, registryNames } from '../project/touches.js';
import { loadState } from '../state.js';
import { workspaceOf } from '../project/state.js';
import { matchGlob, parseWrites } from './guard.js';

/*
 * The structural barrier behind the guard (spec 6.10): the guard reads command lines and is a deny list, so a slice
 * session takes a snapshot of every place it must not change when it starts, and audits it before the gate. A change
 * there is BLOCKING, however it was made.
 * Watched: the main checkout of every registered code repository, every worktree that is not on the branch of the
 * slice, and the workspace (HEAD and uncommitted files), except the workspace paths the slice may write.
 */

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The paths of `git status --porcelain -z` (both sides of a rename), each with a hash of its content. */
function dirtyFiles(dir) {
  const out = git(dir, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (out === null) return null;
  const files = {};
  const parts = out.split('\0').filter((x) => x !== '');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const paths = [parts[i].slice(3)];
    if (code[0] === 'R' || code[0] === 'C') paths.push(parts[++i]);
    for (const p of paths) {
      const file = join(dir, p);
      let hash = 'missing';
      try {
        hash = statSync(file).isFile() ? createHash('sha1').update(readFileSync(file)).digest('hex') : 'folder';
      } catch {
        // Deleted.
      }
      files[p] = `${code} ${hash}`;
    }
  }
  return files;
}

/** The checkouts of the repository at `main`: the main checkout first, then each worktree, with its branch. */
function checkouts(main) {
  const out = git(main, ['worktree', 'list', '--porcelain']);
  if (out === null) return [];
  const list = [];
  for (const block of out.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    list.push({ path: real(path), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null });
  }
  return list;
}

/** The `workspace:` Writes lines of the agents of the session repository and of the plugin, with `<S-nn>` filled. */
function workspaceWrites(sessionRoot, pluginRoot, slice) {
  const globs = new Set(['slices/STATUS.md', `slices/${slice}-*.md`]);
  for (const dir of [join(sessionRoot, '.claude', 'agents'), pluginRoot ? join(pluginRoot, 'harness', 'agents') : null]) {
    if (dir === null || !existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      for (const line of parseWrites(readFileSync(join(dir, f), 'utf8')) ?? []) {
        const { repo, glob } = parseTouch(line);
        const filled = glob.replaceAll('<S-nn>', slice);
        if (repo === WORKSPACE_PREFIX && !filled.includes('<')) globs.add(filled);
      }
    }
  }
  return [...globs];
}

/**
 * Record what the slice must not change.
 * @param {string} ws the workspace
 * @param {{slice: string, sessionRoot: string, pluginRoot?: string, now?: () => Date}} options `slice` is `S-nn`
 * @returns {object} the snapshot, as JSON-ready data
 */
export function takeSnapshot(ws, { slice, sessionRoot, pluginRoot, now = () => new Date() }) {
  const home = real(ws);
  const branch = new RegExp(`^slice/${slice.toLowerCase()}(-|$)`, 'i');
  const repos = [];
  for (const name of registryNames(loadState(home)).filter((n) => REPO_NAME.test(n) && n !== WORKSPACE_PREFIX)) {
    const main = join(home, 'repos', name);
    if (!existsSync(join(main, '.git'))) continue;
    for (const c of checkouts(main)) {
      if (c.path !== real(main) && c.branch !== null && branch.test(c.branch)) continue;
      repos.push({ repo: name, path: c.path, main: c.path === real(main), branch: c.branch, head: (git(c.path, ['rev-parse', 'HEAD']) ?? '').trim(), files: dirtyFiles(c.path) ?? {} });
    }
  }
  return {
    version: 1, slice, taken: now().toISOString(), workspace: home,
    allowed: workspaceWrites(sessionRoot, pluginRoot, slice),
    head: (git(home, ['rev-parse', 'HEAD']) ?? '').trim(), files: dirtyFiles(home) ?? {},
    repos,
  };
}

/**
 * Compare the places of a snapshot with what they hold now.
 * @param {object} snap a snapshot from `takeSnapshot`
 * @param {{sessionRoot: string, pluginRoot?: string}} options
 * @returns {{findings: {where: string, what: string}[]}}
 */
export function audit(snap, { sessionRoot, pluginRoot }) {
  const now = takeSnapshot(snap.workspace, { slice: snap.slice, sessionRoot, pluginRoot });
  const findings = [];
  const add = (where, what) => findings.push({ where, what });
  const changed = (before, after) => {
    const out = [];
    for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[p] !== after[p]) out.push(p);
    return out.sort();
  };
  const byPath = new Map(now.repos.map((r) => [r.path, r]));
  for (const was of snap.repos) {
    const is = byPath.get(was.path);
    const label = `${was.repo} ${was.main ? 'main checkout' : `worktree ${was.path}`}`;
    if (!is) {
      add(was.repo, `${label} is gone`);
      continue;
    }
    if (is.head !== was.head) add(was.repo, `${label}: HEAD moved from ${was.head.slice(0, 12)} to ${is.head.slice(0, 12)}`);
    for (const p of changed(was.files, is.files)) add(was.repo, `${label}: ${p} changed`);
  }
  const known = new Set(snap.repos.map((r) => r.path));
  for (const r of now.repos) if (!known.has(r.path)) add(r.repo, `new checkout ${r.path} (branch ${r.branch ?? 'detached'})`);
  const allowed = (p) => snap.allowed.some((g) => matchGlob(g, p));
  const touched = new Set(changed(snap.files, now.files));
  if (now.head !== snap.head) {
    const diff = git(snap.workspace, ['diff', '--name-only', snap.head, now.head]);
    if (diff === null) add('workspace', `HEAD moved from ${snap.head.slice(0, 12)} to ${now.head.slice(0, 12)} and the change cannot be read`);
    else for (const p of diff.split('\n').filter((x) => x !== '')) touched.add(p);
  }
  for (const p of [...touched].sort()) if (!allowed(p)) add('workspace', `${p} changed`);
  return { findings };
}

/** The default snapshot file of a slice: `.recade/guard-snapshot-<S-nn>.json` of the main repository of `dir`. */
export function snapshotFile(dir, slice) {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const main = common === null ? dir : basename(common.trim()) === '.git' ? dirname(common.trim()) : dir;
  return join(real(main), '.recade', `guard-snapshot-${slice}.json`);
}

const AUDIT_USAGE = 'Usage: recade guard snapshot [--slice S-nn] [--out <file>] [--replace] | recade guard audit --since <snapshot file> (run from the slice session)';

/**
 * `recade guard snapshot` and `recade guard audit`. Exit codes: 0 done or no change outside the slice, 1 a BLOCKING
 * change, 2 usage or a snapshot that cannot be read.
 * @param {string[]} args the words after `guard`
 * @param {{stdout: {write: Function}, stderr: {write: Function}, cwd: string}} io
 * @param {{pluginRoot?: string}} options
 * @returns {Promise<number>}
 */
export async function auditCommand(args, io, { pluginRoot } = {}) {
  const [sub, ...rest] = args;
  const values = {};
  let replace = false;
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (sub === 'snapshot' && key === '--replace' && !replace) {
      replace = true;
      i--;
      continue;
    }
    const allowed = sub === 'snapshot' ? ['--slice', '--out'] : ['--since'];
    if (!allowed.includes(key) || rest[i + 1] === undefined || key in values) {
      io.stderr.write(`${AUDIT_USAGE}\n`);
      return 2;
    }
    values[key] = rest[i + 1];
  }
  const ws = workspaceOf(io.cwd);
  const top = git(io.cwd, ['rev-parse', '--show-toplevel'])?.trim() ?? null;
  if (ws === null || top === null) {
    io.stderr.write('recade guard: run this from a slice session in a code repository of a workspace.\n');
    return 2;
  }
  if (sub === 'snapshot') {
    const branch = git(top, ['symbolic-ref', '--short', '-q', 'HEAD'])?.trim() ?? '';
    const slice = values['--slice'] ?? /^slice\/(s-\d+[a-z]?)(?:-|$)/i.exec(branch)?.[1]?.toUpperCase();
    if (!slice || !/^S-\d+[A-Z]?$/.test(slice)) {
      io.stderr.write('recade guard snapshot: the branch is not slice/S-nn-..., so name the slice with --slice S-nn.\n');
      return 2;
    }
    const file = values['--out'] ? resolve(io.cwd, values['--out']) : snapshotFile(top, slice);
    // The snapshot is the evidence of the audit: a new one would hide what changed since the first. Only the owner's
    // explicit choice replaces it.
    if (existsSync(file) && !replace) {
      io.stderr.write(`recade guard snapshot: ${file} already exists, and a new snapshot would hide what changed since it was taken. Run recade guard audit --since '${file}' first; replace it only when the owner says so, with --replace.\n`);
      return 2;
    }
    const snap = takeSnapshot(ws.dir, { slice, sessionRoot: top, pluginRoot });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
    io.stdout.write(`Snapshot of ${snap.repos.length} checkouts and the workspace for ${slice}:\n${file}\n`);
    return 0;
  }
  if (sub !== 'audit' || values['--since'] === undefined) {
    io.stderr.write(`${AUDIT_USAGE}\n`);
    return 2;
  }
  let snap;
  try {
    snap = JSON.parse(readFileSync(resolve(io.cwd, values['--since']), 'utf8'));
    if (snap?.version !== 1 || typeof snap.workspace !== 'string' || !Array.isArray(snap.repos)) throw new Error('not a snapshot of recade guard');
  } catch (err) {
    io.stderr.write(`recade guard audit: cannot read the snapshot: ${String(err?.message ?? err).split('\n')[0]}\n`);
    return 2;
  }
  const { findings } = audit(snap, { sessionRoot: top, pluginRoot });
  if (findings.length === 0) {
    io.stdout.write(`No change outside ${snap.slice} since ${snap.taken}.\n`);
    return 0;
  }
  for (const f of findings) io.stdout.write(`BLOCKING: ${f.where} ${f.what}\n`);
  io.stdout.write(`${findings.length} change(s) outside ${snap.slice} since ${snap.taken}. Tell the owner; do not undo them yourself.\n`);
  return 1;
}
