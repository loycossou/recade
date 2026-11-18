import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * @typedef {{head: string, dirty: number, hash: string}} Fingerprint
 * @typedef {{name: string, cmd: string[], code: number, fingerprint: Fingerprint, at: string, stale?: true}} Stamp
 * @typedef {'green'|'red'|'stale'|'missing'} GateStatus
 */

const STATE_DIR = '.recade';
const GATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const git = (repo, args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Is a gate name safe to use as a file name and a key? */
export const isGateName = (name) => typeof name === 'string' && GATE_NAME.test(name) && name.length <= 64;

/**
 * The changed paths of `git status --porcelain`, with the status codes, leaving out `.recade/` (the stamps and
 * the gate logs live there and must not change the fingerprint they record).
 * @param {string} repo
 * @returns {{lines: string[], files: string[]}}
 */
function porcelain(repo) {
  const r = git(repo, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.', `:(exclude)${STATE_DIR}`]);
  if (r.status !== 0) throw new Error(`git status failed in ${repo}: ${(r.stderr ?? '').trim()}`);
  const parts = r.stdout.split('\0').filter((p) => p !== '');
  const lines = [];
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    lines.push(entry);
    files.push(entry.slice(3));
    // A rename or a copy is followed by the original path.
    if (/^[RC]/.test(entry) || /^.[RC]/.test(entry)) {
      i++;
      if (i < parts.length) lines.push(parts[i]);
    }
  }
  return { lines, files };
}

/** A hash of the content of a path, or a marker when it is gone or is not a plain file. */
function contentHash(repo, rel) {
  try {
    const full = join(repo, rel);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return `link:${createHash('sha256').update(readlinkSync(full)).digest('hex')}`;
    if (!st.isFile()) return 'dir';
    return createHash('sha256').update(readFileSync(full)).digest('hex');
  } catch {
    return 'gone';
  }
}

/**
 * The fingerprint of a working tree: `HEAD`, the count of porcelain lines, and a hash of those lines together with
 * the content of the files they name, so a second edit of an already modified file changes it too. `.recade/` is left out.
 * @param {string} repo the repository folder
 * @returns {Fingerprint}
 */
export function fingerprint(repo) {
  const headRun = git(repo, ['rev-parse', '--verify', '-q', 'HEAD']);
  const head = headRun.status === 0 ? headRun.stdout.trim() : 'none';
  const { lines, files } = porcelain(repo);
  const h = createHash('sha256');
  for (const l of lines) h.update(`${l}\n`);
  for (const f of files) h.update(`${f}:${contentHash(repo, f)}\n`);
  return { head, dirty: lines.length, hash: h.digest('hex') };
}

const sameFingerprint = (a, b) => a && b && a.head === b.head && a.dirty === b.dirty && a.hash === b.hash;

const stampsPath = (repo) => join(repo, STATE_DIR, 'stamps.json');

/** The stamps of a repository, `{}` when there is none or the file is unreadable. */
export function readStamps(repo) {
  try {
    const data = JSON.parse(readFileSync(stampsPath(repo), 'utf8'));
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** Default command runner: no shell, raw output kept. */
export function defaultExec(cmd, { cwd }) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { code: 127, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error.message}\n` };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Run a gate and record a stamp for the tree the command ran on. The raw output goes to `.recade/gates/<name>.log`.
 * A red run is stamped too (code not 0), so `checkGate` can say `red`. When the command changed the tree (the
 * fingerprint differs before and after), the stamp carries `stale: true` and `checkGate` says `stale`.
 * @param {string} name
 * @param {string[]} cmd command and arguments, run without a shell
 * @param {{repo: string, exec?: (cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}, now?: () => Date}} options
 * @returns {{code: number, stamp: Stamp}}
 */
export function runGate(name, cmd, { repo, exec = defaultExec, now = () => new Date() }) {
  if (!isGateName(name)) throw new Error(`Invalid gate name: ${JSON.stringify(name)}. Use letters, digits, dot, dash and underscore.`);
  if (!Array.isArray(cmd) || cmd.length === 0) throw new Error('A gate needs a command to run.');
  const before = fingerprint(repo);
  const result = exec(cmd, { cwd: repo });
  const dir = join(repo, STATE_DIR);
  mkdirSync(join(dir, 'gates'), { recursive: true });
  writeFileSync(join(dir, 'gates', `${name}.log`), `$ ${cmd.join(' ')}\n${result.stdout}${result.stderr}`);
  const after = fingerprint(repo);
  const stamp = { name, cmd, code: result.code, fingerprint: before, at: now().toISOString() };
  if (!sameFingerprint(before, after)) stamp.stale = true;
  const stamps = readStamps(repo);
  stamps[name] = stamp;
  mkdirSync(dirname(stampsPath(repo)), { recursive: true });
  writeFileSync(stampsPath(repo), `${JSON.stringify(stamps, null, 2)}\n`);
  return { code: result.code, stamp };
}

/**
 * The state of a gate for the current tree: `missing` (never run), `stale` (the tree changed since the stamp),
 * `red` (the stamp matches the tree and the run failed) or `green`.
 * @param {string} name
 * @param {{repo: string}} options
 * @returns {GateStatus}
 */
export function checkGate(name, { repo }) {
  const stamp = readStamps(repo)[name];
  if (!stamp || typeof stamp !== 'object') return 'missing';
  if (stamp.stale === true || !sameFingerprint(stamp.fingerprint, fingerprint(repo))) return 'stale';
  return stamp.code === 0 ? 'green' : 'red';
}
