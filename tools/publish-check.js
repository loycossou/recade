#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_MAP } from '../src/cli.js';
import { scanForNames } from '../src/guard.js';
import { defaultExec } from '../src/harness/stamps.js';

/**
 * Publication checks (Task 8). It answers one question: is what Git would publish fit to be public?
 * The published files are the tracked ones and the untracked ones that no ignore rule hides, so a path listed in
 * `.gitignore` is out of the tree until someone tracks it. `--history` asks the other question: did a private path
 * ever enter a commit of the branch.
 */

const USAGE = 'Usage: publish-check [--names <file>] [--require-names] [--history]';
const EM_DASH = String.fromCharCode(0x2014);
/** The em dash as an HTML entity: named, decimal or hexadecimal, with the semicolon optional as in HTML. */
const EM_DASH_ENTITY = /&\u006ddash(?![a-z0-9])|&#0*8212(?![0-9])|&#x0*2014(?![0-9a-f])/i;
const MAX_BYTES = 5 * 1024 * 1024;
const LOCAL = /[\w.+-]/;
const DOMAIN = /[\w-]+\.[\w.]+/y;

/** Paths that stay out of the public repository: working notes, plans and the French spec. */
export const PRIVATE_PATHS = ['docs/superpowers', '.superpowers', 'docs/specs'];

/** Files that quote third-party text: the lock file holds maintainers' public addresses, the Mermaid bundle holds package@version strings. */
const THIRD_PARTY = (path) => path === 'package-lock.json' || path.startsWith('render/vendor/');

const PRIVATE_MESSAGE = 'Private working file in the tree. Untrack it with `git rm -r --cached` and list it in .gitignore.';
const isPrivate = (path) => PRIVATE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
const finding = (file, line, rule, message) => ({ file, line, rule, message });

function git(root, exec, args) {
  const r = exec(['git', '-C', root, ...args], { cwd: root });
  if (r.code !== 0) {
    const reason = /not a git repository/i.test(r.stderr) ? 'not a Git repository' : `git ${args[0]} failed: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`;
    throw new Error(`${root}: ${reason}`);
  }
  return r.stdout;
}

/**
 * The files Git would publish: tracked or not ignored. Paths are relative with forward slashes. `files` are the ones
 * still on the disk, whose content is read. `gone` are tracked paths deleted from the disk: they are still in the
 * index, so a commit would carry them, and the private-path rule applies to them.
 */
function publishedFiles(root, exec) {
  const out = git(root, exec, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const files = new Set();
  const gone = new Set();
  for (const path of out.split('\0')) {
    if (path === '') continue;
    (existsSync(join(root, path)) ? files : gone).add(path);
  }
  return { files: [...files].sort(), gone: [...gone].sort() };
}

/**
 * The e-mail addresses of a line, found from each at sign outwards so that a long minified line costs a linear scan
 * (a pattern that starts at every word character backtracks without end on such a line).
 */
function emailsIn(line) {
  const found = [];
  for (let at = line.indexOf('@'); at !== -1; at = line.indexOf('@', at + 1)) {
    let start = at;
    while (start > 0 && at - start < 256 && LOCAL.test(line[start - 1])) start--;
    if (start === at) continue;
    DOMAIN.lastIndex = 0;
    const m = DOMAIN.exec(line.slice(at + 1, at + 257));
    if (m !== null) found.push(line.slice(start, at + 1 + m[0].length));
  }
  return found;
}

const isText = (buffer) => !buffer.subarray(0, 8192).includes(0);

function readJson(root, path, findings) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch (err) {
    findings.push(finding(path, 1, 'json', `Cannot read ${path} as JSON: ${err.message}`));
    return null;
  }
}

const hasEmailKey = (value) => value !== null && typeof value === 'object'
  && Object.entries(value).some(([key, child]) => key.toLowerCase().includes('email') || hasEmailKey(child));

/** One line each for `/recade:name` (plugin commands) and `/name` (harness commands) of every command that is not available. */
function unavailableMentions(readme, commandMap) {
  const found = [];
  const lines = readme.split('\n');
  for (const entry of commandMap.filter((c) => c.available === false)) {
    const name = entry.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = entry.phase === 'plugin'
      ? new RegExp(`(?<![\\w/.:-])/recade:${name}(?![\\w-])`)
      : new RegExp(`(?<![\\w/.:-])/${name}(?![\\w/.:-])`);
    lines.forEach((text, i) => {
      if (re.test(text)) found.push({ line: i + 1, command: entry.phase === 'plugin' ? `/recade:${entry.command}` : `/${entry.command}` });
    });
  }
  return found;
}

/**
 * Check the tree that Git would publish.
 * @param {string} root a Git repository
 * @param {{names?: string[], commandMap?: {command: string, phase: string, available?: boolean}[], exec?: Function}} [options]
 * @returns {{files: number, findings: {file: string, line: number, rule: string, message: string}[]}}
 * @throws {Error} when `root` is not a Git repository
 */
export function publishCheck(root, { names = [], commandMap = COMMAND_MAP, exec = defaultExec } = {}) {
  const { files, gone } = publishedFiles(root, exec);
  const findings = [];
  for (const path of gone) {
    if (isPrivate(path)) findings.push(finding(path, 1, 'private-path', PRIVATE_MESSAGE));
  }
  const texts = [];

  for (const path of files) {
    if (isPrivate(path)) {
      findings.push(finding(path, 1, 'private-path', PRIVATE_MESSAGE));
    }
    const size = statSync(join(root, path)).size;
    if (size > MAX_BYTES && !path.startsWith('render/vendor/')) {
      findings.push(finding(path, 1, 'big-file', `File is ${(size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB outside render/vendor.`));
    }
    const buffer = readFileSync(join(root, path));
    if (!isText(buffer)) continue;
    const text = buffer.toString('utf8');
    texts.push({ path, text });
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.includes(EM_DASH) || EM_DASH_ENTITY.test(line)) findings.push(finding(path, i + 1, 'em-dash', 'Em dash. Use a comma, a colon, parentheses or a full stop.'));
      if (THIRD_PARTY(path)) return;
      for (const match of emailsIn(line)) {
        if (!match.endsWith('@users.noreply.github.com')) findings.push(finding(path, i + 1, 'raw-email', 'Raw e-mail address. Write it as name[at]domain.'));
      }
    });
  }

  if (names.length > 0) {
    for (const f of scanForNames(texts.filter((t) => !THIRD_PARTY(t.path)), names)) {
      findings.push(finding(f.file, f.line, f.rule, f.message));
    }
  }

  const present = new Set(files);
  const licenceText = present.has('LICENSE') ? readFileSync(join(root, 'LICENSE'), 'utf8').trim() : '';
  if (licenceText === '') findings.push(finding('LICENSE', 1, 'licence', 'LICENSE is missing or empty.'));

  const plugin = present.has('.claude-plugin/plugin.json') ? readJson(root, '.claude-plugin/plugin.json', findings) : null;
  const market = present.has('.claude-plugin/marketplace.json') ? readJson(root, '.claude-plugin/marketplace.json', findings) : null;
  const pkg = present.has('package.json') ? readJson(root, 'package.json', findings) : null;
  if (plugin === null && !present.has('.claude-plugin/plugin.json')) findings.push(finding('.claude-plugin/plugin.json', 1, 'plugin', 'plugin.json is missing.'));
  if (market === null && !present.has('.claude-plugin/marketplace.json')) findings.push(finding('.claude-plugin/marketplace.json', 1, 'plugin', 'marketplace.json is missing.'));
  if (pkg === null && !present.has('package.json')) findings.push(finding('package.json', 1, 'plugin', 'package.json is missing.'));

  if (plugin !== null && hasEmailKey(plugin)) {
    findings.push(finding('.claude-plugin/plugin.json', 1, 'plugin-email', 'plugin.json carries an e-mail field. The contact goes in the README only.'));
  }
  for (const [path, data] of [['.claude-plugin/plugin.json', plugin], ['package.json', pkg]]) {
    if (data !== null && data.license !== 'MIT') findings.push(finding(path, 1, 'licence', 'The license field must be "MIT".'));
  }

  const versions = [
    ['.claude-plugin/plugin.json', plugin?.version],
    ['.claude-plugin/marketplace.json', market?.plugins?.[0]?.version],
    ['package.json', pkg?.version],
  ].filter(([path]) => present.has(path));
  if (new Set(versions.map(([, v]) => v)).size > 1) {
    findings.push(finding(versions[0][0], 1, 'version', `Versions differ: ${versions.map(([p, v]) => `${p} ${v ?? 'none'}`).join(', ')}.`));
  }

  const version = pkg?.version;
  if (typeof version === 'string') {
    const changelog = present.has('CHANGELOG.md') ? readFileSync(join(root, 'CHANGELOG.md'), 'utf8') : null;
    const has = changelog !== null && changelog.split('\n').some((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
    if (!has) findings.push(finding('CHANGELOG.md', 1, 'changelog', `CHANGELOG.md has no section "## ${version}". Write it with recade release-notes.`));
  }

  if (present.has('README.md')) {
    for (const m of unavailableMentions(readFileSync(join(root, 'README.md'), 'utf8'), commandMap)) {
      findings.push(finding('README.md', m.line, 'unavailable-command', `${m.command} is not available yet and the README advertises it.`));
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { files: files.length, findings };
}

/**
 * The commits of the current branch that touched a private path, oldest last, with the private paths each touched.
 * @returns {{commits: {oid: string, subject: string, paths: string[]}[]}}
 */
export function historyCheck(root, { exec = defaultExec } = {}) {
  const out = git(root, exec, ['log', '--name-only', '-z', '--format=%x1e%H%x1f%s%x1f', 'HEAD', '--', ...PRIVATE_PATHS]);
  const commits = [];
  for (const block of out.split('\x1e')) {
    if (block.trim() === '') continue;
    const [oid, subject, rest = ''] = block.split('\x1f');
    const paths = [...new Set(rest.split('\0').map((p) => p.trim()).filter((p) => p !== '' && isPrivate(p)))].sort();
    commits.push({ oid: oid.trim(), subject: subject.trim(), paths });
  }
  return { commits };
}

/**
 * @param {string[]} argv
 * @param {{cwd: string, env: Record<string, string|undefined>, stdout: {write: Function}, stderr: {write: Function}, run?: Function}} io
 * @returns {Promise<number>} 0 clean, 1 findings, 2 usage or tool error
 */
export async function main(argv, io) {
  let namesFile;
  let requireNames = false;
  let history = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--history') history = true;
    else if (arg === '--require-names') requireNames = true;
    else if (arg === '--names' && argv[i + 1] !== undefined) namesFile = argv[++i];
    else {
      io.stderr.write(`${USAGE}\n`);
      return 2;
    }
  }
  const exec = io.run ?? defaultExec;
  try {
    if (history) {
      const { commits } = historyCheck(io.cwd, { exec });
      if (commits.length === 0) {
        io.stdout.write('History is clean: no commit of this branch touched a private path.\n');
        return 0;
      }
      for (const c of commits) io.stdout.write(`${c.oid.slice(0, 12)} ${c.subject}: ${c.paths.join(', ')}\n`);
      io.stdout.write(`${commits.length} commit${commits.length === 1 ? '' : 's'} touched ${PRIVATE_PATHS.join(', ')}. Publish a clean history (a fresh root commit or a filtered branch) instead of pushing this one.\n`);
      return 1;
    }

    let names = [];
    let haveList = false;
    if (namesFile !== undefined) {
      try {
        names = readFileSync(resolve(io.cwd, namesFile), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
      } catch (err) {
        io.stderr.write(`Cannot read name list ${namesFile}: ${err.message}\n`);
        return 2;
      }
      haveList = true;
    } else if (io.env.RECADE_PRIVATE_NAMES) {
      names = io.env.RECADE_PRIVATE_NAMES.split(',').map((n) => n.trim()).filter(Boolean);
      haveList = names.length > 0;
    }
    if (!haveList || names.length === 0) {
      if (requireNames) {
        io.stderr.write('No private name list. Set RECADE_PRIVATE_NAMES or pass --names <file>.\n');
        return 1;
      }
      io.stdout.write('No private name list; names not checked.\n');
    }

    const { files, findings } = publishCheck(io.cwd, { names, exec });
    for (const f of findings) io.stdout.write(`${f.file}:${f.line} ${f.rule} ${f.message}\n`);
    if (findings.length > 0) {
      io.stdout.write(`${findings.length} problem${findings.length === 1 ? '' : 's'} in ${files} files.\n`);
      return 1;
    }
    io.stdout.write(`Publication check passed: ${files} files.\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`${String(err.message).split('\n')[0]}\n`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
