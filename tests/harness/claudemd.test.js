import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli.js';
import { refresh, techSheet, START, END } from '../../src/harness/claudemd.js';
import { cli, makeWorkspace, perRepoStack } from './fixture-project.js';

const sh = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

const SHEET = [
  '## 12. Harness technical sheet',
  '',
  '<!-- Read by the harness agents. -->',
  '',
  '| Item | Value |',
  '|---|---|',
  '| Build | `npm run build` |',
  '| Test | `npm test` |',
  '| Lint | `npm run lint` |',
  '| Format | `npm run format` |',
  '| Conventions | one file per route |',
  '',
].join('\n');
const STACK = `---\ndoc_id: STACK\n---\n\n## 11. Conditions\n\n- none\n\n${SHEET}`;

/** A project repository: tracked files in nested folders, vendored and generated folders, state.yaml. */
function makeProject({ stack = STACK, claude } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'recade-claudemd-'));
  sh(repo, 'init', '-q', '-b', 'main');
  for (const f of ['recade/state.yaml', 'src/api/routes/a.js', 'src/ui/b.js', 'tests/unit/c.js', 'docs/STACK.md', 'node_modules/x/index.js', 'dist/app.js', 'vendor/lib/l.js', 'README.md']) {
    if (f === 'docs/STACK.md' && stack === null) continue;
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), f === 'docs/STACK.md' ? stack : 'x\n');
  }
  writeFileSync(join(repo, 'recade/state.yaml'), 'mode: new\ngates: {}\n');
  if (claude !== undefined) writeFileSync(join(repo, 'CLAUDE.md'), claude);
  sh(repo, 'add', '-f', '.');
  sh(repo, 'commit', '-q', '-m', 'chore: start');
  return repo;
}

const generated = (text) => text.slice(text.indexOf(START), text.indexOf(END) + END.length);

test('inserts the generated block once at the top when markers are missing, hand rules follow untouched', () => {
  const hand = '# Fernhill rules\n\n- Never log card numbers.\n';
  const repo = makeProject({ claude: hand });
  const { next, diff } = refresh(repo, { stack: STACK, state: {} });
  assert.ok(next.startsWith(START));
  assert.ok(next.endsWith(`${END}\n${hand}`));
  assert.equal(next.split(START).length, 2);
  assert.match(diff, /^\+/m);
  // A second refresh on the result changes nothing.
  writeFileSync(join(repo, 'CLAUDE.md'), next);
  const again = refresh(repo, { stack: STACK, state: {} });
  assert.equal(again.next, next);
  assert.equal(again.diff, '');
});

test('inserts the block after a front matter, and builds the file when CLAUDE.md is absent', () => {
  const repo = makeProject({ claude: '---\nname: x\n---\n# Rules\n' });
  const { next } = refresh(repo, { stack: STACK, state: {} });
  assert.ok(next.startsWith('---\nname: x\n---\n' + START));
  assert.ok(next.endsWith('# Rules\n'));
  const bare = makeProject();
  const made = refresh(bare, { stack: STACK, state: {} }).next;
  assert.ok(made.startsWith(START) && made.endsWith(`${END}\n`));
});

test('the block holds the tech sheet commands, the layout and the pointers', () => {
  const repo = makeProject();
  const block = generated(refresh(repo, { stack: STACK, state: {} }).next);
  assert.match(block, /Build: `npm run build`/);
  assert.match(block, /Test: `npm test`/);
  assert.match(block, /Lint: `npm run lint`/);
  assert.match(block, /`src\/`/);
  assert.match(block, /`src\/api\/`/);
  assert.match(block, /`tests\/unit\/`/);
  assert.doesNotMatch(block, /routes/);
  for (const skipped of ['node_modules', 'dist', 'vendor']) assert.doesNotMatch(block, new RegExp(skipped));
  assert.match(block, /## Conventions\n\none file per route\n/);
  assert.match(block, /`BIBLE\.md`/);
  assert.match(block, /`slices\/STATUS\.md`/);
  assert.match(block, /`\.claude\/protocol\.md`/);
});

test('hand rules are byte-identical and the generated block is replaced, CRLF kept', () => {
  const repo = makeProject();
  const before = '# Rules\r\n\r\n- Keep this.\r\n\r\n';
  const after = '\r\n## Mine\r\n- And this, with trailing spaces   \r\n';
  const old = `${START}\r\nold build: stale\r\n${END}`;
  writeFileSync(join(repo, 'CLAUDE.md'), before + old + after);
  const { next, diff } = refresh(repo, { stack: STACK, state: {} });
  assert.ok(next.startsWith(before + START));
  assert.ok(next.endsWith(END + after));
  assert.doesNotMatch(next, /old build/);
  assert.doesNotMatch(generated(next), /[^\r]\n/);
  assert.match(diff, /^-old build: stale/m);
  assert.match(diff, /^\+- Build: `npm run build`/m);
});

test('state words and percentages are never emitted, and the state is not read', () => {
  const repo = makeProject();
  const state = { phase: 5, gates: { G4: { passed: '2026-11-13' } }, slices_done: 12, progress: '80%' };
  const { next } = refresh(repo, { stack: STACK, state });
  const block = generated(next);
  assert.doesNotMatch(block, /\bdone\b|\bstatus: |\d\s*%|G4|gate-|ready-to-merge/i);
  assert.equal(block, generated(refresh(repo, { stack: STACK, state: {} }).next));
});

test('a missing STACK.md or tech sheet gives a TODO block, not an error', () => {
  const repo = makeProject();
  for (const stack of [null, '# Nothing\n', STACK.replace('| Lint | `npm run lint` |\n', '')]) {
    const { next, missing } = refresh(repo, { stack, state: {} });
    assert.match(generated(next), /<!-- TODO: /);
    assert.ok(missing.length > 0);
  }
  const { next, missing } = refresh(repo, { stack: STACK.replace('| Lint | `npm run lint` |\n', ''), state: {} });
  assert.deepEqual(missing, ['Lint']);
  assert.match(generated(next), /Build: `npm run build`/);
  assert.match(generated(next), /Lint: TODO/);
});

test('broken markers are an error, never a silent rewrite', () => {
  const repo = makeProject();
  for (const text of [`${START}\nno end\n`, `${END}\n${START}\n`, `${START}\n${END}\n${START}\n${END}\n`]) {
    writeFileSync(join(repo, 'CLAUDE.md'), text);
    assert.throws(() => refresh(repo, { stack: STACK, state: {} }), /marker/i);
  }
});

function makeIO(cwd) {
  const out = [];
  const err = [];
  return { io: { cwd, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, out: () => out.join(''), err: () => err.join('') };
}

test('recade claude-md refresh prints the diff without writing, --write applies it', async () => {
  const repo = makeProject({ claude: '# Mine\n' });
  const dry = makeIO(repo);
  assert.equal(await run(['claude-md', 'refresh'], dry.io), 0);
  assert.match(dry.out(), /^\+<!-- recade:generated:start -->/m);
  assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), '# Mine\n');
  const wr = makeIO(repo);
  assert.equal(await run(['claude-md', 'refresh', '--write'], wr.io), 0);
  const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
  assert.ok(text.startsWith(START) && text.endsWith('# Mine\n'));
  assert.equal(readFileSync(join(repo, 'recade/state.yaml'), 'utf8'), 'mode: new\ngates: {}\n');
  const again = makeIO(repo);
  assert.equal(await run(['claude-md', 'refresh'], again.io), 0);
  assert.match(again.out(), /up to date/i);
});

test('recade claude-md works from another folder with --project, and rejects bad usage', async () => {
  const repo = makeProject();
  const elsewhere = mkdtempSync(join(tmpdir(), 'recade-claudemd-away-'));
  const t = makeIO(elsewhere);
  assert.equal(await run(['claude-md', 'refresh', '--write', '--project', repo], t.io), 0);
  assert.ok(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').startsWith(START));
  for (const argv of [['claude-md'], ['claude-md', 'nope'], ['claude-md', 'refresh', '--force']]) {
    const b = makeIO(repo);
    assert.equal(await run(argv, b.io), 2);
    assert.match(b.err(), /^Usage: recade claude-md refresh/);
  }
  const none = makeIO(elsewhere);
  assert.equal(await run(['claude-md', 'refresh'], none.io), 1);
  assert.match(none.err(), /No Recade project/);
});

test('a project without STACK.md still refreshes, with a note on stderr', async () => {
  const repo = makeProject({ stack: null });
  const t = makeIO(repo);
  assert.equal(await run(['claude-md', 'refresh', '--write'], t.io), 0);
  assert.match(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), /TODO/);
  assert.match(t.err(), /tech sheet/i);
});

test('Conventions is TODO when missing or still an example, and any Example: row becomes TODO', () => {
  const repo = makeProject();
  const noConv = STACK.replace('| Conventions | one file per route |\n', '');
  const a = refresh(repo, { stack: noConv, state: {} });
  assert.match(generated(a.next), /## Conventions\n\nTODO\n/);
  assert.deepEqual(a.missing, ['Conventions']);
  const example = STACK.replace('one file per route', 'Example: one file per route').replace('`npm run lint`', 'Example: the linter');
  const b = refresh(repo, { stack: example, state: {} });
  assert.match(generated(b.next), /## Conventions\n\nTODO\n/);
  assert.match(generated(b.next), /Lint: TODO/);
  assert.deepEqual(b.missing, ['Lint', 'Conventions']);
});

test('a pipe inside backticks stays in the value', () => {
  const repo = makeProject();
  const piped = STACK.replace('`npm test`', '`npm test | tee out.log`');
  assert.ok(generated(refresh(repo, { stack: piped, state: {} }).next).includes('- Test: `npm test | tee out.log`'));
});

test('skipped folders are skipped at the top level only, and a non-git folder says so', () => {
  const repo = makeProject();
  mkdirSync(join(repo, 'src/build'), { recursive: true });
  writeFileSync(join(repo, 'src/build/step.js'), 'x\n');
  sh(repo, 'add', '.');
  assert.match(generated(refresh(repo, { stack: STACK, state: {} }).next), /`src\/build\/`/);
  const bare = mkdtempSync(join(tmpdir(), 'recade-claudemd-nogit-'));
  const out = generated(refresh(bare, { stack: STACK, state: {} }).next);
  assert.match(out, /Not a git repository\./);
  assert.doesNotMatch(out, /No tracked folder/);
});

test('techSheet(stack, repo) reads the table headed ### <repo> of section 12', () => {
  const stack = perRepoStack({ api: { Test: 'npm run test:api' }, web: { Test: 'pnpm test:web', Lint: 'pnpm lint' } });
  assert.equal(techSheet(stack, 'api').get('test'), 'npm run test:api');
  assert.equal(techSheet(stack, 'web').get('test'), 'pnpm test:web');
  assert.equal(techSheet(stack, 'web').get('lint'), 'pnpm lint');
  assert.equal(techSheet(stack, 'api').get('lint'), 'npm run lint');
  assert.equal(techSheet(stack, 'api').has('lint') && techSheet(stack, 'api').get('build'), 'npm run build');
  // The table of section 13 is never mixed in, and the rows of one repository never leak into another.
  assert.equal(techSheet(stack, 'web').get('lint') === 'not this one', false);
  // No table for that repository, and none shared: nothing is read (the CI then names the rows to fill).
  assert.equal(techSheet(stack, 'tools').size, 0);
  assert.equal(techSheet(stack).size, 0, 'without a repository the old reading stands: the table right under the heading');
});

test('techSheet(stack, repo) falls back to the single table under the heading, and the heading match is exact', () => {
  assert.equal(techSheet(STACK, 'api').get('test'), 'npm test');
  assert.equal(techSheet(STACK).get('test'), 'npm test');
  const shared = `${STACK}\n### api\n\n| Item | Value |\n|---|---|\n| Test | \`go test ./...\` |\n`;
  assert.equal(techSheet(shared, 'api').get('test'), 'go test ./...');
  assert.equal(techSheet(shared, 'api').get('build'), undefined, 'a repository table replaces the shared one, it does not merge');
  assert.equal(techSheet(shared, 'web').get('test'), 'npm test');
  const lookalike = `${STACK}\n### api-gateway\n\n| Item | Value |\n|---|---|\n| Test | \`x\` |\n`;
  assert.equal(techSheet(lookalike, 'api').get('test'), 'npm test');
});

test('refresh for a code repository: commands from its table, pointers to the workspace, no private document named', async () => {
  const ws = await makeWorkspace({ repos: ['api', 'web'], stack: perRepoStack({ api: { Test: 'npm run test:api', Conventions: 'one route per file' }, web: { Test: 'pnpm test:web' } }) });
  const api = ws.repo('api');
  mkdirSync(join(api, 'src', 'orders'), { recursive: true });
  writeFileSync(join(api, 'src', 'orders', 'a.js'), 'x\n');
  sh(api, 'add', '.');
  const stack = readFileSync(join(ws.dir, 'docs', 'STACK.md'), 'utf8');
  const { next, missing } = refresh(api, { stack, target: 'code', repo: 'api' });
  const block = generated(next);
  assert.deepEqual(missing, []);
  assert.match(block, /Test: `npm run test:api`/);
  assert.match(block, /## Conventions\n\none route per file\n/);
  assert.match(block, /`src\/orders\/`/);
  assert.doesNotMatch(block, /BIBLE\.md|slices\/STATUS\.md|docs\/STACK\.md/);
  assert.match(block, /`\.claude\/protocol\.md`/);
  assert.match(block, /recade workspace root/);
  assert.equal(block.includes(ws.dir), false, 'no path of this machine is committed');
  const web = generated(refresh(ws.repo('web'), { stack, target: 'code', repo: 'web' }).next);
  assert.match(web, /Test: `pnpm test:web`/);
});

test('refresh for the workspace: no build commands to fill, the code lives in the repositories', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  const { next, missing } = refresh(ws.dir, { stack: null, target: 'workspace' });
  const block = generated(next);
  assert.deepEqual(missing, []);
  assert.doesNotMatch(block, /TODO/);
  assert.match(block, /repos\/<name>\/CLAUDE\.md/);
  assert.match(block, /`BIBLE\.md`/);
  assert.match(block, /`slices\/STATUS\.md`/);
});

test('recade claude-md refresh inside a code repository writes nothing: the CLAUDE.md of a code repository is the project\'s own', async () => {
  const ws = await makeWorkspace({ repos: ['api'], stack: perRepoStack({ api: { Test: 'npm run test:api' } }) });
  const out = await cli(ws.repo('api'), ['claude-md', 'refresh', '--write']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /is the project's own: Recade does not write it/);
  assert.equal(existsSync(join(ws.repo('api'), 'CLAUDE.md')), false, 'no CLAUDE.md was written in the code repository');
  writeFileSync(join(ws.repo('api'), 'CLAUDE.md'), '# Notes of the team\n');
  assert.equal((await cli(ws.repo('api'), ['claude-md', 'refresh', '--target', 'code', '--write'])).code, 0);
  assert.equal(readFileSync(join(ws.repo('api'), 'CLAUDE.md'), 'utf8'), '# Notes of the team\n', 'a CLAUDE.md of the team is left as it is');
  assert.equal(existsSync(join(ws.dir, 'CLAUDE.md')), false, 'the workspace file was not touched');
});
