import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishCheck, historyCheck, main } from '../tools/publish-check.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const EM = String.fromCharCode(0x2014);
/** Built from parts so that no address appears in this source. */
const MAIL = ['writer', 'example.invalid'].join(String.fromCharCode(64));

const PLUGIN = {
  name: 'recade', version: '1.0.0', description: 'A fictional plugin.', author: { name: 'Loyc COSSOU', url: 'https://github.com/loycossou' }, license: 'MIT',
};
const MARKET = { name: 'recade', owner: { name: 'Loyc COSSOU' }, plugins: [{ name: 'recade', source: './', version: '1.0.0' }] };
const PKG = { name: 'recade', version: '1.0.0', license: 'MIT', files: ['src'] };

/** The files of a clean fixture, by path. */
const clean = () => ({
  'README.md': '# Recade\n\nRun `/recade:start` first.\n',
  LICENSE: 'MIT License\n\nCopyright (c) 2026 Loyc COSSOU\n',
  'CHANGELOG.md': '# Changelog\n\n## 1.0.0 (2026-11-18)\n\n### Features\n\n- first release\n',
  '.gitignore': 'node_modules/\ndocs/superpowers/\ndocs/specs/\n.superpowers/\n.recade/plugin-root\n',
  'package.json': `${JSON.stringify(PKG, null, 2)}\n`,
  '.claude-plugin/plugin.json': `${JSON.stringify(PLUGIN, null, 2)}\n`,
  '.claude-plugin/marketplace.json': `${JSON.stringify(MARKET, null, 2)}\n`,
  'docs/design.md': '# Design\n\nShort sentences.\n',
  'src/index.js': 'export const answer = 42;\n',
});

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** A git repository in a temp dir with the clean files, changed by `files` (a value of null removes the file). Staged, not committed. */
function fixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recade-publish-'));
  git(root, 'init', '-q', '-b', 'main');
  for (const [path, text] of Object.entries({ ...clean(), ...files })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, 'add', '-f', '.');
  return root;
}

const check = (files, options) => {
  const root = fixture(files);
  try {
    return publishCheck(root, { names: [], ...options });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const rules = (result) => result.findings.map((f) => f.rule);

test('the clean fixture passes', () => {
  const result = check({});
  assert.deepEqual(result.findings, []);
  assert.ok(result.files >= 8);
});

test('an em dash in a published file fails and names the line', () => {
  const result = check({ 'docs/design.md': `# Design\n\nA line ${EM} with a dash.\n` });
  assert.deepEqual(rules(result), ['em-dash']);
  assert.equal(result.findings[0].file, 'docs/design.md');
  assert.equal(result.findings[0].line, 3);
});

test('the escaped em dash is not an em dash', () => {
  assert.deepEqual(check({ 'src/index.js': "export const dash = '\\u2014';\n" }).findings, []);
});

test('a raw e-mail address fails, a noreply address does not', () => {
  assert.deepEqual(rules(check({ 'docs/design.md': `Write to ${MAIL}\n` })), ['raw-email']);
  const noreply = ['1+x', 'users.noreply.github.com'].join(String.fromCharCode(64));
  assert.deepEqual(check({ 'docs/design.md': `Signed ${noreply}\n` }).findings, []);
});

test('a private name fails, case-insensitively and as a whole word, and the message does not repeat it', () => {
  const result = check({ 'docs/design.md': 'The client Zorblax asked.\n' }, { names: ['zorblax'] });
  assert.deepEqual(rules(result), ['private-name']);
  assert.ok(!JSON.stringify(result.findings).toLowerCase().includes('zorblax'));
  assert.deepEqual(check({ 'docs/design.md': 'Zorblaxes are fine.\n' }, { names: ['zorblax'] }).findings, []);
});

test('a file over 5 MB fails, except under render/vendor', () => {
  const big = 'x'.repeat(5 * 1024 * 1024 + 1);
  const result = check({ 'assets/big.txt': big });
  assert.deepEqual(rules(result), ['big-file']);
  assert.equal(result.findings[0].file, 'assets/big.txt');
  assert.deepEqual(check({ 'render/vendor/bundle.min.js': big }).findings, []);
});

test('a command that is not available fails when the README advertises it', () => {
  const commandMap = [
    { command: 'start', phase: 'plugin', summary: 'x' },
    { command: 'ghost', phase: 'plugin', summary: 'x', available: false },
    { command: 'phantom', phase: 'harness', summary: 'x', available: false },
  ];
  assert.deepEqual(check({ 'README.md': 'Run `/recade:start`.\n' }, { commandMap }).findings, []);
  assert.deepEqual(rules(check({ 'README.md': 'Try `/recade:ghost` soon.\n' }, { commandMap })), ['unavailable-command']);
  assert.deepEqual(rules(check({ 'README.md': 'Try `/phantom` in a project.\n' }, { commandMap })), ['unavailable-command']);
  assert.deepEqual(check({ 'README.md': 'See https://example.invalid/phantom and `/recade:phantom-less`.\n' }, { commandMap }).findings, []);
});

test('a missing or empty licence, or a licence field that is not MIT, fails', () => {
  assert.deepEqual(rules(check({ LICENSE: null })), ['licence']);
  assert.deepEqual(rules(check({ LICENSE: '\n' })), ['licence']);
  assert.deepEqual(rules(check({ 'package.json': JSON.stringify({ ...PKG, license: 'ISC' }) })), ['licence']);
  assert.deepEqual(rules(check({ '.claude-plugin/plugin.json': JSON.stringify({ ...PLUGIN, license: undefined }) })), ['licence']);
});

test('plugin.json with an e-mail key fails', () => {
  const plugin = { ...PLUGIN, author: { ...PLUGIN.author, email: 'none' } };
  assert.deepEqual(rules(check({ '.claude-plugin/plugin.json': JSON.stringify(plugin) })), ['plugin-email']);
});

test('a version mismatch between plugin.json, marketplace.json and package.json fails', () => {
  assert.deepEqual(rules(check({ '.claude-plugin/plugin.json': JSON.stringify({ ...PLUGIN, version: '1.0.1' }) })), ['version']);
  assert.deepEqual(rules(check({ '.claude-plugin/marketplace.json': JSON.stringify({ ...MARKET, plugins: [{ ...MARKET.plugins[0], version: '0.9.0' }] }) })), ['version']);
  // The changelog is read against the package version, so it complains too.
  assert.deepEqual(rules(check({ 'package.json': JSON.stringify({ ...PKG, version: '2.0.0' }) })).sort(), ['changelog', 'version']);
});

test('a CHANGELOG without a section for the version fails', () => {
  assert.deepEqual(rules(check({ 'CHANGELOG.md': '# Changelog\n\n## 0.9.0 (2026-01-01)\n\n- old\n' })), ['changelog']);
  assert.deepEqual(rules(check({ 'CHANGELOG.md': null })), ['changelog']);
});

test('docs/superpowers, .superpowers and the French spec fail when they are in the tree', () => {
  for (const path of ['docs/superpowers/plans/plan.md', '.superpowers/sdd/notes.md', 'docs/specs/2026-11-12-recade-design.md']) {
    const result = check({ [path]: 'private\n' });
    assert.deepEqual(rules(result), ['private-path'], path);
    assert.equal(result.findings[0].file, path);
  }
});

test('private paths that are ignored and untracked are not in the tree', () => {
  const root = fixture();
  try {
    for (const path of ['docs/superpowers/plan.md', '.superpowers/notes.md', 'docs/specs/spec.md']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), `a line ${EM} here\n`);
    }
    assert.deepEqual(publishCheck(root, { names: [] }).findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a private path that is in the index fails even when it is deleted from the disk', () => {
  const root = fixture({ 'docs/superpowers/plan.md': 'plan\n' });
  try {
    rmSync(join(root, 'docs', 'superpowers', 'plan.md'));
    const staged = publishCheck(root, { names: [] });
    assert.deepEqual(rules(staged), ['private-path']);
    assert.equal(staged.findings[0].file, 'docs/superpowers/plan.md');
    git(root, 'commit', '-q', '-m', 'docs: plan');
    assert.deepEqual(rules(publishCheck(root, { names: [] })), ['private-path']);
    git(root, 'rm', '-q', '--cached', 'docs/superpowers/plan.md');
    assert.deepEqual(publishCheck(root, { names: [] }).findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an em dash written as an entity fails', () => {
  // Built from parts so that this source holds no em dash entity itself.
  for (const entity of ['&m' + 'dash;', '&M' + 'DASH;', '&#' + '8212;', '&#x' + '2014;', '&#X' + '2014;', '&#x00' + '2014;', '&#000' + '8212;']) {
    const result = check({ 'docs/design.md': `A line ${entity} with a dash.\n` });
    assert.deepEqual(rules(result), ['em-dash'], entity);
    assert.equal(result.findings[0].line, 1);
  }
  assert.deepEqual(check({ 'docs/design.md': 'Not dashes: &ndash; &#8211; &#x2013; &#82120;\n' }).findings, []);
});

test('a tracked file that was deleted from the disk is not read', () => {
  const root = fixture();
  try {
    rmSync(join(root, 'src', 'index.js'));
    assert.deepEqual(publishCheck(root, { names: [] }).findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a folder that is not a git repository is an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-publish-'));
  try {
    assert.throws(() => publishCheck(root, { names: [] }), /not a Git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('historyCheck lists each commit that touched a private path, with the paths', () => {
  const root = fixture({ 'docs/superpowers/plan.md': 'plan\n' });
  try {
    git(root, 'commit', '-q', '-m', 'docs: add the plan');
    writeFileSync(join(root, 'docs', 'design.md'), '# Design\n\nMore.\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'docs: more design');
    git(root, 'rm', '-q', '-r', '--cached', 'docs/superpowers');
    git(root, 'commit', '-q', '-m', 'chore: untrack the plans');
    const { commits } = historyCheck(root);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map((c) => c.subject).sort(), ['chore: untrack the plans', 'docs: add the plan']);
    assert.ok(commits.every((c) => /^[0-9a-f]{40}$/.test(c.oid) && c.paths.length === 1 && c.paths[0] === 'docs/superpowers/plan.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('historyCheck is empty for a clean history', () => {
  const root = fixture();
  try {
    git(root, 'commit', '-q', '-m', 'docs: first');
    assert.deepEqual(historyCheck(root).commits, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function io(cwd, env = {}) {
  const out = [];
  const err = [];
  return { io: { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, out, err };
}

test('main: exit 0 and a summary on a clean tree, exit 1 with file:line rule lines on a fault', async () => {
  const good = fixture();
  const bad = fixture({ 'docs/design.md': `x ${EM} y\n` });
  try {
    const a = io(good);
    assert.equal(await main([], a.io), 0);
    assert.match(a.out.join(''), /^Publication check passed: \d+ files\./m);
    const b = io(bad);
    assert.equal(await main([], b.io), 1);
    assert.match(b.out.join(''), /^docs\/design\.md:1 em-dash /m);
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test('main: the private names come from the env or from --names, and a missing list is said, not failed, unless --require-names', async () => {
  const root = fixture({ 'docs/design.md': 'The client Zorblax asked.\n' });
  const list = join(root, '..', `names-${process.pid}.txt`);
  try {
    const none = io(root);
    assert.equal(await main([], none.io), 0);
    assert.match(none.out.join(''), /No private name list; names not checked\./);
    const required = io(root);
    assert.equal(await main(['--require-names'], required.io), 1);
    assert.match(required.err.join(''), /private name list/);
    const env = io(root, { RECADE_PRIVATE_NAMES: 'Zorblax, Other' });
    assert.equal(await main([], env.io), 1);
    assert.match(env.out.join(''), /private-name/);
    writeFileSync(list, '# names\nZorblax\n');
    const file = io(root);
    assert.equal(await main(['--names', list], file.io), 1);
    assert.match(file.out.join(''), /private-name/);
    const missing = io(root);
    assert.equal(await main(['--names', join(root, 'nope.txt')], missing.io), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(list, { force: true });
  }
});

test('main: --history exits 1 and lists the commits, exits 0 when the history is clean', async () => {
  const root = fixture({ 'docs/superpowers/plan.md': 'plan\n' });
  try {
    git(root, 'commit', '-q', '-m', 'docs: add the plan');
    const dirty = io(root);
    assert.equal(await main(['--history'], dirty.io), 1);
    assert.match(dirty.out.join(''), /^[0-9a-f]{12} docs: add the plan: docs\/superpowers\/plan\.md$/m);
    git(root, 'rm', '-q', '-r', '--cached', 'docs/superpowers');
    git(root, 'commit', '-q', '-m', 'chore: untrack');
    const still = io(root);
    assert.equal(await main(['--history'], still.io), 1);
    const fresh = fixture();
    try {
      git(fresh, 'commit', '-q', '-m', 'docs: first');
      const ok = io(fresh);
      assert.equal(await main(['--history'], ok.io), 0);
      assert.match(ok.out.join(''), /History is clean/);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: an unknown option is exit 2 with the usage', async () => {
  const a = io(repo);
  assert.equal(await main(['--nope'], a.io), 2);
  assert.match(a.err.join(''), /^Usage: publish-check/);
});

test('package.json has the publish-check script, and files lists what the plugin needs and nothing private', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['publish-check'], 'node tools/publish-check.js');
  assert.ok(Array.isArray(pkg.files));
  for (const need of ['bin', 'src', 'commands', 'agents', 'skills', 'templates', 'harness', 'render', 'hooks', '.claude-plugin', 'LICENSE', 'README.md', 'CHANGELOG.md']) {
    assert.ok(pkg.files.includes(need), `files has ${need}`);
  }
  for (const path of pkg.files) assert.ok(!/superpowers|specs|^tests$|^example$|^tools$/.test(path), path);
});
