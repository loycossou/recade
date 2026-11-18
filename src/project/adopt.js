import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { initState, saveState } from '../state.js';
import { install } from '../harness/install.js';
import { assertParent, createWorkspace, workspaceDir } from '../workspace/layout.js';
import { REPO_NAME, addRepo, stripCredentials } from '../workspace/repos.js';
import { normalizeState } from './state.js';
import { slugify } from './scaffold.js';

/** Where Recade records the files it created in an adopted repository. */
export const CREATED_FILE = '.recade/created.json';

const STATE_FILE = 'recade/state.yaml';

/** Folders Recade may write into, and the pattern of its own workflow files (spec section 4.1). */
const OWN_FOLDERS = ['recade', 'docs', 'slices', '.recade', '.claude', '.githooks'];
const OWN_WORKFLOW = /^\.github\/workflows\/recade[^/]*\.ya?ml$/;
/**
 * Files outside those folders that Recade may create when they are absent (an existing one is never rewritten, since
 * it is not recorded): the dependency updates the harness installs, and the `.gitignore` that keeps `.recade/` out of git.
 */
const OWN_WHEN_ABSENT = new Map([['.github/dependabot.yml', '.github'], ['.gitignore', '.']]);

/**
 * What a code repository may already hold, in the order they are reported. Adopt leaves them as they are: Recade
 * writes the harness beside them (`recade.yml`, merged settings) or between the generated markers of CLAUDE.md.
 */
const EXISTING_CANDIDATES = ['.claude', 'CLAUDE.md', '.githooks', '.github/workflows/ci.yml'];

const MAX_LISTED = 20;

/** A refusal the owner can read: what was wrong, and the dirty files when that was the reason. */
export class AdoptError extends Error {
  /**
   * @param {string} message
   * @param {{dirty?: string[], branch?: string|null, defaultBranch?: string|null, reasons?: string[], needsDefaultBranch?: boolean, candidates?: string[]}} [info]
   */
  constructor(message, {
    dirty = [], branch = null, defaultBranch = null, reasons = [message], needsDefaultBranch = false, candidates = [],
  } = {}) {
    super(message);
    this.name = 'AdoptError';
    this.dirty = dirty;
    this.branch = branch;
    this.defaultBranch = defaultBranch;
    this.reasons = reasons;
    this.needsDefaultBranch = needsDefaultBranch;
    this.candidates = candidates;
  }
}

/** `rel` as a clean relative path with forward slashes, or null when it is empty, absolute or leaves the folder. */
function cleanRel(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.includes('\\') || isAbsolute(rel) || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  if (parts.includes('..')) return null;
  const out = posix.normalize(rel);
  return out === '.' || out.startsWith('../') ? null : out.replace(/\/$/, '');
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * The allowed top of `clean` (`recade`, `docs`, ..., or `.github/workflows` for a Recade workflow file), as a
 * relative path, or null when Recade may not write there.
 */
function allowedTop(clean) {
  const [first, ...rest] = clean.split('/');
  if (OWN_FOLDERS.includes(first) && rest.length > 0) return first;
  if (OWN_WHEN_ABSENT.has(clean)) return OWN_WHEN_ABSENT.get(clean);
  return OWN_WORKFLOW.test(clean) ? '.github/workflows' : null;
}

/** Files that only the Recade CLI rewrites (`recade state pass`), so their content is not compared with the record. */
const MANAGED = new Set([STATE_FILE]);

/** The records of `.recade/created.json` as a map path to sha256. Entries outside the allow-list or without a hash are dropped. */
function readRecords(repo) {
  const out = new Map();
  let data;
  try {
    data = JSON.parse(readFileSync(join(repo, CREATED_FILE), 'utf8'));
  } catch {
    return out;
  }
  if (data === null || typeof data !== 'object' || !Array.isArray(data.files)) return out;
  for (const entry of data.files) {
    if (entry === null || typeof entry !== 'object' || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) continue;
    const rel = cleanRel(entry.path);
    if (rel !== null && allowedTop(rel) !== null) out.set(rel, entry.sha256);
  }
  return out;
}

/**
 * The files Recade recorded as created in `repo`, with their paths checked against the allow-list. A missing
 * or unreadable record gives an empty list.
 * @param {string} repo
 * @returns {string[]}
 */
export function readCreated(repo) {
  return [...readRecords(repo).keys()];
}

/** Why `rel` is not an own file: 'unrecorded', 'changed', or null when it is one. */
function ownState(repo, rel) {
  const hash = readRecords(repo).get(rel);
  if (hash === undefined) return 'unrecorded';
  let stat;
  try {
    stat = lstatSync(join(repo, rel));
  } catch {
    return 'unrecorded';
  }
  if (!stat.isFile()) return 'unrecorded';
  if (MANAGED.has(rel)) return null;
  return sha256(readFileSync(join(repo, rel))) === hash ? null : 'changed';
}

/**
 * Did Recade create `path` (relative to `repo`)? True only for a regular file recorded in `.recade/created.json`
 * with its sha256, inside Recade's own folders, and that still holds what Recade wrote (the state file, which
 * the Recade CLI rewrites, is only checked for being recorded). A file the owner edited is theirs.
 * @param {string} repo
 * @param {string} path
 * @returns {boolean}
 */
export function ownFile(repo, path) {
  const rel = cleanRel(path);
  return rel !== null && ownState(repo, rel) === null;
}

function record(repo, rel, content) {
  const records = readRecords(repo);
  const hash = sha256(content);
  if (records.get(rel) === hash) return;
  records.set(rel, hash);
  mkdirSync(join(repo, '.recade'), { recursive: true });
  const files = [...records].map(([path, hash]) => ({ path, sha256: hash }));
  writeFileSync(join(repo, CREATED_FILE), `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}

/** The real path of the deepest folder of `target` that exists. */
function realAncestor(target) {
  let dir = target;
  for (;;) {
    try {
      return realpathSync(dir);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return dir;
      dir = parent;
    }
  }
}

/**
 * Refuse a path whose folders, once symbolic links are followed, do not stay inside `top` of the real repository
 * (so `docs -> src` or `.recade -> .git` never lead out of the allowed folder). Missing folders are fine.
 */
function assertInside(repo, clean, top) {
  const root = realpathSync(repo);
  const allowed = join(root, ...top.split('/'));
  const ancestor = realAncestor(dirname(join(repo, ...clean.split('/'))));
  const ok = ancestor === root || ancestor === allowed || ancestor.startsWith(allowed + sep) || allowed.startsWith(ancestor + sep);
  if (!ok) throw new AdoptError(`Refused: ${clean} leads outside ${top}/ through a symbolic link.`);
}

/**
 * Write a file under Recade's own folders. A file that already exists is rewritten only when it is an own file:
 * recorded in `.recade/created.json` with the sha256 of what Recade wrote and unchanged since (the state file
 * is the exception: the Recade CLI rewrites it). Any other file, an own file the owner edited, a symbolic link, a
 * folder, a path whose folders lead out of `recade/`, `docs/`, `slices/`, `.recade/`, `.claude/`, `.githooks/`
 * or `.github/workflows/recade*.yml` through a symbolic link, and any other path is refused with an AdoptError.
 * What is written is recorded with its hash.
 * @param {string} repo
 * @param {string} rel path relative to `repo`, forward slashes
 * @param {string} content
 * @param {{keepEdits?: boolean}} [options] `keepEdits` lets a recorded file be rewritten although its content changed since
 *   (the harness files carry the team's own text below a line, which the install merges and keeps). A file that is not
 *   recorded is refused in every case.
 * @returns {'created'|'updated'|'unchanged'}
 */
export function writeOwnFile(repo, rel, content, { keepEdits = false } = {}) {
  const clean = cleanRel(rel);
  if (clean === null) throw new AdoptError(`Refused: ${JSON.stringify(rel)} is not a path inside the repository.`);
  const top = allowedTop(clean);
  if (top === null) {
    throw new AdoptError(`Refused: ${clean} is outside the folders Recade writes to (${OWN_FOLDERS.join(', ')}, .github/workflows/recade*.yml).`);
  }
  assertInside(repo, clean, top);
  assertInside(repo, CREATED_FILE, '.recade');
  const target = join(repo, ...clean.split('/'));
  let stat = null;
  try {
    stat = lstatSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stat === null) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: 'wx' });
    record(repo, clean, content);
    return 'created';
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new AdoptError(`Refused: ${clean} is not a regular file Recade can write.`);
  const why = ownState(repo, clean);
  if (why === 'unrecorded') throw new AdoptError(`Refused: ${clean} exists and was not created by Recade. Recade never edits it.`);
  if (why === 'changed' && !keepEdits) throw new AdoptError(`Refused: ${clean} was changed since Recade wrote it. Recade does not overwrite your edits.`);
  if (readFileSync(target, 'utf8') === content) {
    record(repo, clean, content);
    return 'unchanged';
  }
  writeFileSync(target, content);
  record(repo, clean, content);
  return 'updated';
}

/**
 * A git call in `repo`. `--no-optional-locks` keeps `git status` and the like from refreshing `.git/index`: the original
 * folder is only read, so even its index (stale file stats after a checkout or a copy) must stay as it was.
 */
async function git(exec, repo, args) {
  try {
    const r = await exec('git', ['--no-optional-locks', '-C', repo, ...args]);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
  }
}

/** The paths `git status --porcelain -z` reports: the new name of a rename, sorted. */
function parseStatus(text) {
  const out = [];
  const entries = text.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C' || e[1] === 'R' || e[1] === 'C') i++;
  }
  return out.sort();
}

const localBranch = async (exec, repo, name) =>
  (await git(exec, repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code === 0;

/**
 * The default branch from what the repository says: origin/HEAD, then main or master (when only one exists),
 * then init.defaultBranch when that branch exists. Returns `{name}`, or `{name: null, candidates}` when nothing
 * says (or when main and master both exist and origin/HEAD does not choose).
 */
async function defaultBranchOf(exec, repo) {
  const origin = await git(exec, repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (origin.code === 0 && origin.stdout.trim().startsWith('origin/')) return { name: origin.stdout.trim().slice('origin/'.length) };
  const both = [];
  for (const name of ['main', 'master']) if (await localBranch(exec, repo, name)) both.push(name);
  if (both.length === 1) return { name: both[0] };
  if (both.length === 0) {
    const configured = await git(exec, repo, ['config', '--get', 'init.defaultBranch']);
    const name = configured.code === 0 ? configured.stdout.trim() : '';
    if (name !== '' && await localBranch(exec, repo, name)) return { name };
  }
  const listed = await git(exec, repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const local = listed.code === 0 ? listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  return { name: null, candidates: both.length > 1 ? both : local, ambiguous: both.length > 1 };
}

/**
 * Can adopt start in `repo`? It must be the root of a Git repository, on its default branch, with no
 * uncommitted work. Files Recade created itself do not count as work. Nothing is written, stashed or reset.
 * When nothing says which branch is the default (no origin/HEAD, no main or master, no init.defaultBranch, or
 * both main and master), the result has `needsDefaultBranch: true` and the candidates, and the owner's answer
 * is passed back as `defaultBranch`.
 * The commits must also be pushed: with a remote, the branch needs an upstream and `git rev-list @{u}..HEAD` must be
 * empty (the clone is made from the remote, so a commit that is only local would be lost). `remote` is the URL of
 * `origin` (else of the first remote), null when there is none; `unpushed` is the number of commits not pushed.
 * @param {string} repo
 * @param {{exec: (cmd: string, args: string[]) => Promise<{code: number, stdout?: string, stderr?: string}>, defaultBranch?: string}} options
 * @returns {Promise<{ok: boolean, dirty: string[], branch: string|null, defaultBranch: string|null, reasons: string[], remote: string|null, unpushed: number, needsDefaultBranch?: boolean, candidates?: string[]}>}
 */
export async function preflight(repo, { exec, defaultBranch }) {
  const result = { ok: false, dirty: [], branch: null, defaultBranch: 'main', reasons: [], remote: null, unpushed: 0 };
  const top = await git(exec, repo, ['rev-parse', '--show-toplevel']);
  if (top.code === 127 && /ENOENT|not found/i.test(top.stderr)) {
    result.reasons.push('Git is not installed or not on the PATH. Install Git, then run this again.');
    return result;
  }
  if (top.code !== 0) {
    result.reasons.push(`${repo} is not a Git repository. Run adopt in the root folder of the project's repository.`);
    return result;
  }
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  if (real(top.stdout.trim()) !== real(repo)) {
    result.reasons.push(`${repo} is inside the repository ${top.stdout.trim()}. Run adopt from the root of the repository.`);
    return result;
  }

  const found = typeof defaultBranch === 'string' && defaultBranch !== '' ? { name: defaultBranch } : await defaultBranchOf(exec, repo);
  result.defaultBranch = found.name;
  if (found.name === null) {
    result.needsDefaultBranch = true;
    result.candidates = found.candidates;
  }
  const head = await git(exec, repo, ['symbolic-ref', '--short', 'HEAD']);
  if (head.code === 0) result.branch = head.stdout.trim();

  const status = await git(exec, repo, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (status.code !== 0) {
    result.reasons.push(`git status failed: ${status.stderr.trim().split('\n')[0] || `exit ${status.code}`}`);
    return result;
  }
  result.dirty = parseStatus(status.stdout).filter((p) => p !== CREATED_FILE && !ownFile(repo, p));
  if (result.dirty.length > 0) {
    const shown = result.dirty.slice(0, MAX_LISTED).join(', ');
    const more = result.dirty.length > MAX_LISTED ? ` and ${result.dirty.length - MAX_LISTED} more` : '';
    result.reasons.push(`The repository has uncommitted changes in ${result.dirty.length} file${result.dirty.length === 1 ? '' : 's'}: ${shown}${more}. Commit or set them aside yourself, then run adopt again. Recade changes none of them.`);
  }
  if (found.name === null) {
    const list = result.candidates.length > 0 ? ` Branches here: ${result.candidates.join(', ')}.` : '';
    result.reasons.push(found.ambiguous
      ? `Cannot tell the default branch: both main and master exist and origin/HEAD does not say which one.${list} Ask the owner, then run again with --default-branch <name>.`
      : `Cannot tell the default branch: there is no origin/HEAD, no main or master branch and no init.defaultBranch.${list} Ask the owner, then run again with --default-branch <name>.`);
  } else if (result.branch === null) {
    result.reasons.push(`HEAD is detached. Check out ${result.defaultBranch}, then run adopt again.`);
  } else if (result.branch !== result.defaultBranch) {
    result.reasons.push(`The current branch is ${result.branch}, not the default branch ${result.defaultBranch}. Check out ${result.defaultBranch}, then run adopt again.`);
  }
  const remote = await remoteOf(exec, repo);
  // The URL may carry a token (`https://x-access-token:...@`): what is reported and recorded never does.
  result.remote = remote === null ? null : stripCredentials(remote.url);
  if (remote !== null && result.branch !== null) {
    const upstream = await git(exec, repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstream.code !== 0) {
      result.reasons.push(`The branch ${result.branch} has no upstream branch while the repository has a remote (${result.remote}), so Recade cannot tell what is pushed. Push it (git push -u ${remote.name} ${result.branch}), then run adopt again.`);
    } else {
      // The clone is made from this remote, so the commits are counted against the same branch of it, whatever the upstream is.
      const cloned = `${remote.name}/${result.branch}`;
      const known = (await git(exec, repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${cloned}`])).code === 0;
      const against = known ? cloned : upstream.stdout.trim();
      const ahead = await git(exec, repo, ['rev-list', '--count', `${known ? `refs/remotes/${cloned}` : '@{u}'}..HEAD`]);
      const count = ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) : 0;
      if (Number.isInteger(count) && count > 0) {
        result.unpushed = count;
        result.reasons.push(`${count} commit${count === 1 ? ' is' : 's are'} not pushed to ${against}. The workspace clones the remote, so push them first (git push), then run adopt again.`);
      }
    }
  }
  result.ok = result.reasons.length === 0;
  return result;
}

/**
 * The remote the clone is made from: `origin`, else the first remote; null when the repository has none. A URL that is a
 * relative folder (`../api.git`) is made absolute against `repo`, the original: it means nothing from anywhere else.
 */
async function remoteOf(exec, repo) {
  const listed = await git(exec, repo, ['remote']);
  const names = listed.code === 0 ? listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const name = names.includes('origin') ? 'origin' : names[0];
  if (name === undefined) return null;
  // The URL as configured, not as `url.<base>.insteadOf` rewrites it on this machine.
  const got = await git(exec, repo, ['config', '--get', `remote.${name}.url`]);
  if (got.code !== 0 || got.stdout.trim() === '') return null;
  let url = got.stdout.trim();
  const local = resolve(repo, url);
  if (!isAbsolute(url) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) && !url.startsWith('-') && existsSync(local)) url = local;
  return { name, url };
}

const lstatExists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Does the folder `rel` hold a file that Recade did not create? */
function hasForeignFile(repo, rel) {
  let entries;
  try {
    entries = readdirSync(join(repo, rel), { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => {
    const path = `${rel}/${e.name}`;
    return e.isDirectory() ? hasForeignFile(repo, path) : !ownFile(repo, path);
  });
}

/** The existing files and folders adopt keeps as they are. */
function keptOf(repo) {
  return EXISTING_CANDIDATES.filter((rel) => {
    const path = join(repo, rel);
    if (!existsSync(path)) return false;
    return lstatSync(path).isDirectory() ? hasForeignFile(repo, rel) : !ownFile(repo, rel);
  });
}

/**
 * What a clone does not carry from the original: branches that exist only there, the stashes, and the files git ignores.
 * They are reported, never a reason to refuse. Read only.
 */
async function notCarried(exec, folder, remote) {
  const heads = await git(exec, folder, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const current = await git(exec, folder, ['symbolic-ref', '--short', 'HEAD']);
  const branches = [];
  for (const b of heads.code === 0 ? heads.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []) {
    if (b === current.stdout.trim()) continue;
    const there = remote !== null && (await git(exec, folder, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${b}`])).code === 0;
    if (!there) branches.push(b);
  }
  const stash = await git(exec, folder, ['stash', 'list']);
  const ignored = await git(exec, folder, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']);
  return {
    branches,
    stashes: stash.code === 0 ? stash.stdout.split('\n').filter((l) => l.trim() !== '').length : 0,
    ignored: ignored.code === 0 ? ignored.stdout.split('\n').filter((l) => l.trim() !== '').length : 0,
  };
}

/**
 * Install warnings that only say the stack and the team are not written yet. Adopt installs the harness first, so that the
 * guard and the link exist from the start, and `/recade:harness` installs again when they do: they are not news at this point.
 */
const LATER = [/has no value for/, /^No doctrine in /, /dependabot\.yml was not written/];

/** The first line of a git error, for a message. */
const firstLine = (text) => String(text ?? '').trim().split('\n').find((l) => l.trim() !== '') ?? '';

/** A kebab-case repository name from the folder or URL of a source (`.git` and trailing slashes dropped). */
function nameOf(source, cwd = process.cwd()) {
  // A local folder is named by its own folder, so `.` and `../api` work.
  const from = localFolder(String(source), cwd) ? resolve(cwd, String(source)) : String(source);
  return slugify(basename(from.replace(/[\\/]+$/, '')).replace(/\.git$/, ''));
}

/** The real path of `p`, or of its nearest folder that exists with the rest put back (the parent may not exist yet). */
function realOf(p) {
  let rest = '';
  for (let d = resolve(p); ; d = dirname(d)) {
    try {
      return join(realpathSync(d), rest);
    } catch {
      if (dirname(d) === d) return resolve(p);
      rest = join(basename(d), rest);
    }
  }
}

/** Is the path `inner` the folder `outer` or somewhere under it, links resolved? */
function insideReal(outer, inner) {
  const a = realOf(outer);
  const b = realOf(inner);
  return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

/** Is `source` a local folder (else it is a URL to clone as it is)? */
function localFolder(source, cwd) {
  try {
    return !source.startsWith('-') && lstatSync(resolve(cwd, source)).isDirectory();
  } catch {
    return false;
  }
}

/** The commit that starts the workspace, so every later step finds it clean. A failure leaves the files uncommitted. */
async function firstCommit(dir, exec) {
  const base = ['-C', dir, '-c', 'commit.gpgsign=false'];
  const tail = ['commit', '-q', '-m', 'chore: create the workspace'];
  try {
    if ((await exec('git', ['-C', dir, 'add', '-A'])).code !== 0) return;
    const first = await exec('git', [...base, ...tail]);
    if (first.code !== 0) await exec('git', [...base, '-c', 'user.name=Recade', '-c', `user.email=${['noreply', 'recade.invalid'].join('@')}`, ...tail]);
  } catch {
    // the workspace is usable without its first commit
  }
}

/**
 * Adopt existing code repositories into a new workspace (spec 6.8 and 6.15). Every local source is checked first
 * (`preflight`: clean tree, default branch, nothing unpushed); when any is refused, nothing is created. Then it creates
 * `<parent>/<slug>-workspace` with an adopt state (`kind: workspace`, `mode: adopt`, the gates of plan 3 with `G0`
 * replaced by `G0-inventory`), clones each repository into `repos/<name>/` and registers it, installs the code target
 * of the harness in each one through the own-files policy, and makes the first commit of the workspace.
 * The clone comes from the `origin` URL of the original; an original with no remote is cloned from its path, noted as
 * `remote: none` with a warning, and its clone keeps no `origin`. A source that is not a local folder is a URL: it is
 * cloned as it is. The original folders are only read, never written. If anything fails after the workspace was created,
 * the workspace is removed.
 * @param {{parent: string, repos: {source: string, name?: string}[], name?: string, full?: boolean, defaultBranch?: string, cwd?: string,
 *   exec: (cmd: string, args: string[], timeout?: number) => Promise<{code: number, stdout?: string, stderr?: string}>,
 *   config: {voice: string, languages: object}, pluginRoot: string}} options
 *   `name` is the project name (default: the name of the first repository); `cwd` is the folder relative paths are read from.
 * @returns {Promise<{dir: string, repos: {name: string, path: string, remote: string, default_branch: string, kept: string[], written: number, warnings: string[], notCarried: {branches: string[], stashes: number, ignored: number}}[], warnings: string[]}>}
 *   `notCarried` says what the clone leaves behind (local-only branches, stashes, ignored files); it is also one warning line
 * @throws {AdoptError} for a refusal the owner can act on
 */
export async function initAdopt({ parent, repos, name, full = false, defaultBranch, cwd = process.cwd(), exec, config, pluginRoot } = {}) {
  if (config === undefined || config === null) throw new Error('initAdopt needs the user config (voice and languages).');
  if (typeof pluginRoot !== 'string' || pluginRoot === '') throw new Error('initAdopt needs the plugin folder (pluginRoot).');
  if (typeof parent !== 'string' || parent === '') throw new AdoptError('Refused: give the parent folder of the workspace.');
  if (!Array.isArray(repos) || repos.length === 0) throw new AdoptError('Refused: give at least one repository to adopt.');

  const entries = repos.map((r) => ({ source: r.source, name: r.name ?? nameOf(r.source, cwd) }));
  const problems = [];
  for (const e of entries) {
    if (!REPO_NAME.test(e.name)) problems.push(`"${e.name}" is not a repository name for ${e.source}. Use lowercase words joined by hyphens, for example api or web-app, and give it with --repo-name.`);
  }
  for (const n of new Set(entries.map((e) => e.name))) {
    if (entries.filter((e) => e.name === n).length > 1) problems.push(`Two repositories are named ${n}. Give each one its own name.`);
  }
  const slug = slugify(name ?? entries[0].name);
  if (slug === '') problems.push(`"${name}" is not a project name. Use at least one letter or digit.`);
  if (problems.length > 0) throw new AdoptError(`Refused: ${problems.join(' ')}`, { reasons: problems });

  const parentAbs = resolve(cwd, parent);
  try {
    assertParent(parentAbs);
  } catch (err) {
    throw new AdoptError(`Refused: ${err.message}`);
  }
  // The workspace never lives in a repository it adopts: the original would not stay as it is.
  for (const e of entries) {
    if (!localFolder(e.source, cwd)) continue;
    const folder = resolve(cwd, e.source);
    if (insideReal(folder, parentAbs)) {
      throw new AdoptError(`Refused: the parent folder ${parentAbs} is inside the repository ${folder}. The workspace is a new folder outside every repository it adopts. Choose another parent folder.`);
    }
  }

  const ws = workspaceDir(parentAbs, slug);
  if (existsSync(ws) && readdirSync(ws).length > 0) {
    throw new AdoptError(`Refused: the folder ${ws} already exists and is not empty. Choose another project name or parent folder.`);
  }

  // The preflight of every original, before anything is created.
  const reasons = [];
  const dirty = [];
  let ask = false;
  const candidates = [];
  let branch = null;
  let defaultName = null;
  const plan = [];
  for (const e of entries) {
    if (!localFolder(e.source, cwd)) {
      plan.push({ ...e, clone: e.source, notCarried: { branches: [], stashes: 0, ignored: 0 } });
      continue;
    }
    const folder = resolve(cwd, e.source);
    const check = await preflight(folder, { exec, defaultBranch });
    if (!check.ok) {
      const tag = entries.length > 1 ? `${e.name}: ` : '';
      reasons.push(...check.reasons.map((r) => `${tag}${r}`));
      dirty.push(...check.dirty);
      ask = ask || check.needsDefaultBranch === true;
      candidates.push(...(check.candidates ?? []));
      branch = branch ?? check.branch;
      defaultName = defaultName ?? check.defaultBranch;
      continue;
    }
    const origin = await remoteOf(exec, folder);
    const left = await notCarried(exec, folder, origin?.name ?? null);
    // The clone is made from the full URL (it may need its token); the registry gets it without the secret.
    plan.push({ ...e, clone: check.remote === null ? folder : (origin?.url ?? check.remote), remote: check.remote ?? 'none', notCarried: left });
  }
  if (reasons.length > 0) {
    throw new AdoptError(reasons.join(' '), { dirty, branch, defaultBranch: defaultName, reasons, needsDefaultBranch: ask, candidates });
  }

  const created = !existsSync(ws);
  // The parent folders this call is about to create, outermost first: they go too when it fails.
  const madeParents = [];
  for (let d = resolve(cwd, parent); !existsSync(d) && dirname(d) !== d; d = dirname(d)) madeParents.unshift(d);
  const warnings = [];
  const out = [];
  try {
    await createWorkspace(resolve(cwd, parent), slug, { exec });
    const initial = initState(ws, { mode: 'adopt' }, config);
    saveState(ws, normalizeState({ version: initial.version, kind: 'workspace', ...initial, full: full === true }));
    for (const p of plan) {
      const entry = await addRepo(ws, p.name, { clone: p.clone, ...(p.remote === undefined ? {} : { remote: p.remote }) }, { exec: (cmd, args) => exec(cmd, args, 120000), cwd });
      const dir = join(ws, 'repos', p.name);
      if (p.remote === 'none') {
        // The clone of a local folder would keep that folder as `origin`: a repository the owner never asked Recade to push to.
        const dropped = await git(exec, dir, ['remote', 'remove', 'origin']);
        if (dropped.code !== 0) warnings.push(`${p.name}: the clone still names the original folder as origin (${firstLine(dropped.stderr)}). Remove it: git -C repos/${p.name} remote remove origin`);
        warnings.push(`${p.name} has no remote, so it was cloned from its folder and the registry says remote: none. Push it to a remote when you want the team to share it, then run recade repo sync on other machines.`);
      }
      const result = install(dir, { pluginRoot, target: 'code', workspace: ws });
      out.push({
        name: entry.name, path: entry.path, remote: entry.remote, default_branch: entry.default_branch,
        kept: keptOf(dir), written: result.written.filter((w) => w.status === 'created' || w.status === 'updated').length,
        warnings: result.warnings.filter((w) => !LATER.some((re) => re.test(w))), notCarried: p.notCarried,
      });
      const n = p.notCarried;
      const parts = [
        ...(n.branches.length > 0 ? [`the local-only branch${n.branches.length === 1 ? '' : 'es'} ${n.branches.slice(0, 20).join(', ')}${n.branches.length > 20 ? ' and more' : ''}`] : []),
        ...(n.stashes > 0 ? [`${n.stashes} stash${n.stashes === 1 ? '' : 'es'}`] : []),
        ...(n.ignored > 0 ? [`${n.ignored} ignored file${n.ignored === 1 ? '' : 's'} or folder${n.ignored === 1 ? '' : 's'} (build output, local settings, secrets)`] : []),
      ];
      if (parts.length > 0) warnings.push(`Not carried into the clone of ${p.name}: ${parts.join('; ')}. They stay in the original folder, which is not touched: keep it until you have what you need from it.`);
    }
    await firstCommit(ws, exec);
  } catch (err) {
    if (created) rmSync(ws, { recursive: true, force: true });
    else for (const entry of readdirSync(ws)) rmSync(join(ws, entry), { recursive: true, force: true });
    for (const d of madeParents.reverse()) {
      try {
        rmdirSync(d);
      } catch {
        break;
      }
    }
    throw err;
  }
  return { dir: ws, repos: out, warnings };
}
