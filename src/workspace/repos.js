import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadState, saveState } from '../state.js';
import { frontMatterLength } from '../frontmatter-lines.js';
import { checkSlices } from '../project/slices.js';
import { LAUNCHER } from '../harness/install.js';
import { checkLink, linkRepo } from './layout.js';

/** A repository name: lowercase words joined by single hyphens. It is also the folder name under `repos/`. */
export const REPO_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const VISIBILITIES = Object.freeze(['private', 'public', 'internal']);

/** A glob that already names its repository (`api:src/**`, `workspace:slices/**`). */
const PREFIXED = /^[a-z0-9]+(-[a-z0-9]+)*:/;
const SHEET = /^(S-\d{2}[a-z]?)-.+\.md$/;

const oneLine = (text) => String(text ?? '').trim().split('\n')[0];
/** The line of a git message that says what went wrong: the first `fatal:` or `error:` line, else the last line. */
const errorLine = (text) => {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[lines.length - 1] ?? '';
};
/** Schemes whose user name is not a secret: an ssh user (`ssh://git@host/x`). */
const SSH_SCHEMES = new Set(['ssh', 'git+ssh', 'ssh+git']);

/**
 * A remote URL without its secret: the whole user part of an http(s) or other URL (`https://bob:token@host`,
 * `https://token@host`), the password of an ssh URL (the ssh user is kept). A path, an scp form (`git@host:x`) and
 * `none` are returned as they are. Recade records, prints and commits only this form.
 * @param {string} url
 * @returns {string}
 */
export function stripCredentials(url) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)@/.exec(String(url));
  if (m === null) return url;
  const user = SSH_SCHEMES.has(m[1].toLowerCase()) ? m[2].split(':')[0] : '';
  return `${m[1]}://${user === '' ? '' : `${user}@`}${url.slice(m[0].length)}`;
}

/** Every URL of a text (a git error line) without its secret. */
const redact = (text) => String(text ?? '').replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"]+/g, (u) => stripCredentials(u));

/** Names a repository may not have: `workspace:` is the prefix of the workspace itself in `touches:` and `## Writes`. */
const RESERVED = Object.freeze(['workspace']);
const usableName = (name) => typeof name === 'string' && REPO_NAME.test(name) && !RESERVED.includes(name);
/** The identity of the initial commit when git has none: a placeholder that is local to this commit. */
const PLACEHOLDER = Object.freeze(['-c', 'user.name=Recade', '-c', `user.email=${['noreply', 'recade.invalid'].join('@')}`]);
const repoDir = (ws, name) => join(ws, 'repos', name);

/** The registry of `ws`: the `repos` list of its `recade/state.yaml`. */
export function listRepos(ws) {
  const repos = loadState(ws)?.repos;
  return Array.isArray(repos) ? repos.filter((r) => r !== null && typeof r === 'object') : [];
}

/** Run a command through the injected exec; a throwing exec counts as exit 127. */
async function run(exec, cmd, args) {
  try {
    const r = await exec(cmd, args);
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
  }
}

/**
 * Add a code repository at `repos/<name>`: `git init -b main` (`{new: true}`) or `git clone` (`{clone: url}`, a URL or
 * a local path, passed as one argument after `--`). It writes the link, records the entry in `recade/state.yaml`, and,
 * when the registry goes from one repository to two, prefixes the unprefixed `touches:` globs of the slices that are
 * not done with the name of the first repository.
 * `remote` is `none` for a new repository; for a clone of a URL it is the URL; for a clone of a local folder it is the
 * folder's own `origin` (set as the clone's origin too), else `none` with no origin in the clone; `spec.remote` overrides
 * it (adopt). A remote is recorded without its secret (`stripCredentials`), and a clone URL that holds a password or a
 * token is refused unless `spec.remote` names what to record.
 * @param {string} ws the workspace folder
 * @param {string} name
 * @param {{new: true, role?: string, visibility?: string}|{clone: string, remote?: string, role?: string, visibility?: string}} spec
 * @param {{exec: (cmd: string, args: string[]) => Promise<{code: number, stdout?: string, stderr?: string}>, cwd?: string}} options
 *   `cwd` is the folder a relative local clone source is read from (default: the process folder)
 * @returns {Promise<{name: string, path: string, remote: string, default_branch: string, role: string, visibility: string, prefixed: {sheet: string, before: string[], after: string[]}[], prefixedHotspots: {before: string, after: string}[]}>}
 *   the entry, and the changes made by this call when it was the second repository (else empty lists): `prefixed` for the
 *   slice sheets, `prefixedHotspots` for the hotspots of state.yaml
 */
export async function addRepo(ws, name, spec, { exec, cwd = process.cwd() }) {
  if (typeof name === 'string' && RESERVED.includes(name)) throw new Error(`"${name}" is reserved: it is the prefix of the workspace in touches. Choose another name.`);
  if (!usableName(name)) {
    throw new Error(`"${name}" is not a repository name. Use lowercase words joined by hyphens, for example api or web-app.`);
  }
  if (listRepos(ws).some((r) => r.name === name)) throw new Error(`The repository ${name} is already in the registry.`);
  const cloning = typeof spec?.clone === 'string';
  if (cloning === (spec?.new === true)) throw new Error('Give exactly one of --new or --clone <url>.');
  if (cloning && (spec.clone.trim() === '' || /[\0\r\n]/.test(spec.clone))) throw new Error('The clone source is empty or is not one line.');
  if (cloning && spec.remote === undefined && stripCredentials(spec.clone) !== spec.clone) {
    throw new Error(`The clone URL holds a password or a token (${stripCredentials(spec.clone)} without it). Recade records and commits the remote, so it refuses the URL: give git the credential through a credential helper or an SSH key, then add ${stripCredentials(spec.clone)}.`);
  }
  const role = String(spec.role ?? '').trim();
  const visibility = spec.visibility ?? 'private';
  if (/[\r\n]/.test(role)) throw new Error('The role is one line.');
  if (!VISIBILITIES.includes(visibility)) throw new Error(`The visibility is one of ${VISIBILITIES.join(', ')}.`);

  const dir = repoDir(ws, name);
  const existed = existsSync(dir);
  if (existed && readdirSync(dir).length > 0) throw new Error(`The folder ${dir} already exists and is not empty. Choose another name.`);
  const undo = () => rmSync(dir, { recursive: true, force: true });

  let defaultBranch = 'main';
  let remote = 'none';
  if (cloning) {
    // A local path that exists is made absolute, so the registry still works from another folder.
    const local = resolve(cwd, spec.clone);
    const source = !spec.clone.startsWith('-') && existsSync(local) ? local : spec.clone;
    const r = await run(exec, 'git', ['clone', '--', source, dir]);
    if (r.code !== 0) {
      undo();
      throw new Error(`git clone failed: ${redact(errorLine(r.stderr)) || `exit ${r.code}`}`);
    }
    if (spec.remote !== undefined) remote = stripCredentials(spec.remote);
    else if (source === local) {
      // A local folder is no remote: the registry is committed, and a path of this machine means nothing elsewhere.
      // The clone takes the folder's own origin when it has one, else it has no remote at all.
      const origin = await run(exec, 'git', ['-C', local, 'config', '--get', 'remote.origin.url']);
      let url = origin.code === 0 ? oneLine(origin.stdout) : '';
      const near = url === '' ? '' : resolve(local, url);
      if (url !== '' && !isAbsolute(url) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) && existsSync(near)) url = near;
      const set = url === ''
        ? await run(exec, 'git', ['-C', dir, 'remote', 'remove', 'origin'])
        : await run(exec, 'git', ['-C', dir, 'remote', 'set-url', 'origin', url]);
      if (set.code !== 0) {
        undo();
        throw new Error(`The origin of the clone could not be set: ${redact(errorLine(set.stderr)) || `exit ${set.code}`}`);
      }
      remote = url === '' ? 'none' : stripCredentials(url);
    } else remote = stripCredentials(source);
    const head = await run(exec, 'git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
    if (head.code === 0 && oneLine(head.stdout) !== '') defaultBranch = oneLine(head.stdout);
  } else {
    mkdirSync(dir, { recursive: true });
    const r = await run(exec, 'git', ['-C', dir, 'init', '-b', 'main']);
    if (r.code !== 0) {
      undo();
      throw new Error(`git init failed: ${errorLine(r.stderr) || `exit ${r.code}`}`);
    }
    // A first commit, so the branch exists and slice worktrees can start from it.
    const commit = ['-C', dir, '-c', 'commit.gpgsign=false'];
    const tail = ['commit', '-q', '--allow-empty', '-m', 'chore: initial commit'];
    let c = await run(exec, 'git', [...commit, ...tail]);
    if (c.code !== 0) c = await run(exec, 'git', [...commit, ...PLACEHOLDER, ...tail]);
    if (c.code !== 0) {
      undo();
      throw new Error(`The initial commit failed: ${errorLine(c.stderr) || `exit ${c.code}`}. Set user.name and user.email in git, then try again.`);
    }
  }
  try {
    linkRepo(ws, dir);
  } catch (err) {
    undo();
    throw err;
  }
  const entry = { name, path: `repos/${name}`, remote, default_branch: defaultBranch, role, visibility };
  // The state is read again here: git ran for a while, and anything saved meanwhile must be kept.
  const fresh = loadState(ws) ?? {};
  const repos = listRepos(ws);
  if (repos.some((r) => r.name === name)) throw new Error(`The repository ${name} is already in the registry.`);
  const second = repos.length === 1;
  const hotspots = Array.isArray(fresh.hotspots) ? fresh.hotspots : [];
  const prefixedHotspots = [];
  const nextHotspots = second ? hotspots.map((h) => {
    const after = typeof h === 'string' ? prefixItem(h, repos[0].name) : h;
    if (after !== h) prefixedHotspots.push({ before: h, after });
    return after;
  }) : hotspots;
  saveState(ws, { ...fresh, ...(Array.isArray(fresh.hotspots) ? { hotspots: nextHotspots } : {}), repos: [...repos, entry] });
  const prefixed = second ? prefixTouches(ws, repos[0].name) : [];
  return { ...entry, prefixed, prefixedHotspots };
}

/** Does `dir` hold the Recade git hooks (`.githooks/pre-commit` written by `recade harness install`)? */
const recadeHooks = (dir) => {
  try {
    return readFileSync(join(dir, '.githooks', 'pre-commit'), 'utf8').includes('Recade harness');
  } catch {
    return false;
  }
};
/** `core.hooksPath` of `dir`, '' when it is not set. It is local git config, so a fresh clone never has it. */
const hooksPathOf = (dir) => {
  const r = spawnSync('git', ['-C', dir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};
/** The Recade hooks are there and git does not run them (no hooksPath at all: one the owner set is the owner's). */
const hooksOff = (dir) => recadeHooks(dir) && hooksPathOf(dir) === '';

/**
 * What is wrong with each registered repository, seen from the workspace.
 * Problems: `missing` (no folder), `not a git repository`, `link missing`, `link points elsewhere` (the link names a
 * workspace that was moved or is another one, or one that does not hold this repository), `no harness` (no guard
 * launcher in the repository), `invalid entry` (the name is not a repository name, so it is not looked at),
 * `git hooks off` (the Recade git hooks are installed and `core.hooksPath` is not set, as on a fresh clone; reported
 * for the workspace too, under the name `workspace`).
 * @param {string} ws
 * @returns {{findings: {repo: string, problem: string}[]}}
 */
export function checkRepos(ws) {
  const findings = [];
  if (hooksOff(ws)) findings.push({ repo: 'workspace', problem: 'git hooks off' });
  for (const entry of listRepos(ws)) {
    const repo = String(entry.name);
    if (!usableName(repo)) {
      findings.push({ repo, problem: 'invalid entry' });
      continue;
    }
    const dir = repoDir(ws, repo);
    if (!existsSync(dir)) {
      findings.push({ repo, problem: 'missing' });
      continue;
    }
    const link = checkLink(dir);
    if (!link.ok && link.reason === 'not a git repository') {
      findings.push({ repo, problem: 'not a git repository' });
      continue;
    }
    if (!link.ok) findings.push({ repo, problem: link.reason === 'link missing' ? 'link missing' : 'link points elsewhere' });
    if (!existsSync(join(dir, LAUNCHER))) findings.push({ repo, problem: 'no harness' });
    if (hooksOff(dir)) findings.push({ repo, problem: 'git hooks off' });
  }
  return { findings };
}

/**
 * Make the workspace and the repositories of its registry usable on this machine: write `.recade/plugin-root` of the
 * workspace, clone the repositories whose folder is missing, write the link and `.recade/plugin-root` of every
 * repository, turn the Recade git hooks on where they are off, then run `git worktree repair` on the slice worktrees of each. A repository with no remote cannot be cloned: it is skipped
 * with a reason, like a folder that is not a git repository or a clone that fails. Nothing here stops at the first problem.
 * @param {string} ws
 * @param {{exec: (cmd: string, args: string[]) => Promise<{code: number, stdout?: string, stderr?: string}>, pluginRoot?: string}} options
 *   `pluginRoot` is the plugin folder of this machine; without it `.recade/plugin-root` is left as it is
 * @returns {Promise<{cloned: string[], linked: string[], repaired: string[], hooked: string[], skipped: {repo: string, reason: string}[]}>}
 *   `repaired` lists the repositories where `git worktree repair` ran on their slice worktrees (moved workspace);
 *   `hooked` the checkouts (`workspace` or a repository name) where `core.hooksPath` was set to `.githooks`, as
 *   `recade harness install` does, because the Recade hooks were there and git did not run them
 */
export async function syncRepos(ws, { exec, pluginRoot }) {
  const cloned = [];
  const linked = [];
  const repaired = [];
  const hooked = [];
  const skipped = [];
  const hooksOn = async (dir, name) => {
    if (!hooksOff(dir)) return;
    const r = await run(exec, 'git', ['-C', dir, 'config', 'core.hooksPath', '.githooks']);
    if (r.code === 0) hooked.push(name);
    else skipped.push({ repo: name, reason: `core.hooksPath was not set: ${errorLine(r.stderr) || `exit ${r.code}`}` });
  };
  // The workspace itself: its plugin root (the guard of a fresh clone fails closed without it) and its git hooks.
  if (typeof pluginRoot === 'string' && isAbsolute(pluginRoot)) {
    mkdirSync(join(ws, '.recade'), { recursive: true });
    writeFileSync(join(ws, '.recade', 'plugin-root'), `${pluginRoot}\n`);
  }
  await hooksOn(ws, 'workspace');
  for (const entry of listRepos(ws)) {
    const repo = String(entry.name);
    if (!usableName(repo)) {
      skipped.push({ repo, reason: 'the registry entry has no valid name' });
      continue;
    }
    const dir = repoDir(ws, repo);
    if (!existsSync(dir)) {
      const remote = typeof entry.remote === 'string' ? entry.remote.trim() : '';
      if (remote === '' || remote === 'none' || /[\0\r\n]/.test(remote)) {
        skipped.push({ repo, reason: 'it has no remote, so there is nothing to clone: copy the folder to repos/' + repo });
        continue;
      }
      const r = await run(exec, 'git', ['clone', '--', remote, dir]);
      if (r.code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        skipped.push({ repo, reason: `git clone failed: ${redact(errorLine(r.stderr)) || `exit ${r.code}`}` });
        continue;
      }
      cloned.push(repo);
    }
    try {
      linkRepo(ws, dir);
    } catch {
      skipped.push({ repo, reason: `repos/${repo} is not a git repository` });
      continue;
    }
    if (typeof pluginRoot === 'string' && isAbsolute(pluginRoot)) writeFileSync(join(dir, '.recade', 'plugin-root'), `${pluginRoot}\n`);
    linked.push(repo);
    await hooksOn(dir, repo);
    // A moved workspace leaves the slice worktrees pointing at the old path: git records absolute paths.
    const trees = join(dir, '.claude', 'worktrees');
    // Only folders that hold a `.git` file are worktrees: a stray folder or file would make the repair fail for good.
    const isTree = (p) => {
      try {
        return statSync(p).isDirectory() && statSync(join(p, '.git')).isFile();
      } catch {
        return false;
      }
    };
    const paths = existsSync(trees) ? readdirSync(trees).sort().map((n) => join(trees, n)).filter(isTree) : [];
    if (paths.length > 0) {
      const r = await run(exec, 'git', ['-C', dir, 'worktree', 'repair', ...paths]);
      if (r.code === 0) repaired.push(repo);
      else skipped.push({ repo, reason: `git worktree repair failed: ${errorLine(r.stderr) || `exit ${r.code}`}` });
    }
  }
  return { cloned, linked, repaired, hooked, skipped };
}

/** Split the inside of an inline list on the commas that are not inside braces. */
function splitInline(text) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth = Math.max(0, depth - 1);
    else if (text[i] === ',' && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out;
}

/** `src/**` gives `api:src/**`, keeping the quotes and the trailing comment of the item. A prefixed item is returned as it is. */
function prefixItem(raw, first) {
  const m = /^(["']?)(.*?)\1(\s+#.*)?$/.exec(raw.trim());
  if (m === null || m[2] === '' || PREFIXED.test(m[2])) return raw;
  return `${m[1]}${first}:${m[2]}${m[1]}${m[3] ?? ''}`;
}

/** The front matter of a sheet with every unprefixed `touches:` item prefixed. Returns the new text, or null when nothing changes. */
function prefixSheet(text, first) {
  const lines = text.split('\n');
  const end = frontMatterLength(lines);
  if (end === 0) return null;
  const at = lines.findIndex((l, i) => i > 0 && i < end - 1 && /^touches:/.test(l));
  if (at === -1) return null;
  const cr = (l) => (l.endsWith('\r') ? '\r' : '');
  const inline = lines[at].replace(/\r$/, '').slice('touches:'.length).trim();
  if (inline.startsWith('[')) {
    const m = /^\[(.*)\]\s*(#.*)?$/.exec(inline);
    if (m === null) return null;
    const items = splitInline(m[1]).map((x) => {
      const lead = /^\s*/.exec(x)[0];
      return lead + prefixItem(x.slice(lead.length), first);
    });
    lines[at] = `touches: [${items.join(',')}]${m[2] ? ` ${m[2]}` : ''}${cr(lines[at])}`;
  } else if (inline !== '' && !inline.startsWith('#')) {
    // The scalar form: `touches: src/a/**`.
    lines[at] = `touches: ${prefixItem(inline, first)}${cr(lines[at])}`;
  } else {
    for (let i = at + 1; i < end - 1; i++) {
      const m = /^(\s*-\s+)(.*?)(\r?)$/.exec(lines[i]);
      if (m) lines[i] = `${m[1]}${prefixItem(m[2], first)}${m[3]}`;
      else if (/^\S/.test(lines[i])) break;
    }
  }
  const next = lines.join('\n');
  return next === text ? null : next;
}

const touchesOf = (text) => {
  const lines = text.split('\n');
  const end = frontMatterLength(lines);
  const at = end === 0 ? -1 : lines.findIndex((l, i) => i > 0 && i < end - 1 && /^touches:/.test(l));
  if (at === -1) return [];
  const unquote = (s) => s.trim().replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2');
  const inline = lines[at].replace(/\r$/, '').slice('touches:'.length).trim();
  if (inline.startsWith('[')) return splitInline(inline.replace(/^\[|\]\s*(#.*)?$/g, '')).map(unquote).filter((s) => s !== '');
  if (inline !== '' && !inline.startsWith('#')) return [unquote(inline)].filter((x) => x !== '');
  const out = [];
  for (let i = at + 1; i < end - 1; i++) {
    const m = /^\s*-\s+(.*?)\r?$/.exec(lines[i]);
    if (m) out.push(unquote(m[1]));
    else if (/^\S/.test(lines[i])) break;
  }
  return out.filter((s) => s !== '');
};

/**
 * Prefix with `firstRepo:` the `touches:` globs that have no prefix, in every slice sheet whose status is not `done`.
 * The sheets are rewritten in place, quotes and comments kept. A glob that already has a prefix is not touched.
 * @param {string} ws
 * @param {string} firstRepo
 * @returns {{sheet: string, before: string[], after: string[]}[]} one entry per sheet that changed; `sheet` is `slices/<file>`
 */
export function prefixTouches(ws, firstRepo) {
  if (!usableName(firstRepo)) throw new Error(`"${firstRepo}" is not a repository name.`);
  let done = new Set();
  try {
    done = new Set(checkSlices(ws).status.filter((r) => r.status === 'done').map((r) => r.id));
  } catch {
    done = new Set();
  }
  const dir = join(ws, 'slices');
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => SHEET.test(n)).sort() : [];
  const changes = [];
  for (const name of names) {
    if (done.has(SHEET.exec(name)[1])) continue;
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8');
    const next = prefixSheet(text, firstRepo);
    if (next === null) continue;
    writeFileSync(path, next);
    changes.push({ sheet: `slices/${name}`, before: touchesOf(text), after: touchesOf(next) });
  }
  return changes;
}
