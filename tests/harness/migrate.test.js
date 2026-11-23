import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_LINE, genericOf, install, pluginVersion } from '../../src/harness/install.js';
import { formatMigrate as formatMigrateOf, migrate } from '../../src/harness/migrate.js';
import { checkRepos } from '../../src/workspace/repos.js';
import { cli, git, makeWorkspace, plugin } from './fixture-project.js';

const REF = 'v1.0.0';
const version = pluginVersion(plugin);
const md = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []);
const old = (kind, name) => `${genericOf(readFileSync(join(plugin, 'harness', kind, `${name}.md`), 'utf8'), version)}\n${SPEC_LINE}\n`;
const OLD_CODE_COMMANDS = ['slice', 'review', 'second-opinion', 'explain'];
const OLD_WS_COMMANDS = ['status', 'board', 'parallel', 'merge-order', 'retro', 'slice-write', 'slice-check', 'decision', 'inventory', 'design', 'amend'];

/**
 * A workspace of the old layout: the project commands only at the root, every agent, the slice commands and the protocol
 * in each code repository, the slice worktrees under repos/<repo>/.claude/worktrees/, and worktrees/ not kept out of git.
 * The team changed two files of api; one file of web is known by the install record only.
 */
async function oldLayout() {
  const ws = await makeWorkspace({ repos: ['api', 'web'] });
  writeFileSync(join(ws.dir, 'slices', 'S-02-orders.md'), '---\nid: S-02\ntitle: Orders\nlane: standard\nbranch: slice/S-02-orders\ntouches: [web:src/orders/**]\n---\n\n## Goal\n\nOrders.\n');
  install(ws.dir, { pluginRoot: plugin, target: 'workspace', ref: REF });
  for (const f of md(join(ws.dir, '.claude', 'commands'))) if (!OLD_WS_COMMANDS.includes(f.replace(/\.md$/, ''))) rmSync(join(ws.dir, '.claude', 'commands', f));
  rmSync(join(ws.dir, '.claude', 'agents', 'implementer.md'));
  writeFileSync(join(ws.dir, '.gitignore'), readFileSync(join(ws.dir, '.gitignore'), 'utf8').replace('worktrees/\n', ''));
  const exclude = join(ws.dir, '.git', 'info', 'exclude');
  writeFileSync(exclude, readFileSync(exclude, 'utf8').replace('worktrees/\n', ''));
  for (const name of ['api', 'web']) {
    const repo = ws.repo(name);
    install(repo, { pluginRoot: plugin, target: 'code', workspace: ws.dir, ref: REF });
    rmSync(join(repo, '.recade', 'installed.json'));
    mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
    for (const a of md(join(plugin, 'harness', 'agents'))) writeFileSync(join(repo, '.claude', 'agents', a), old('agents', a.replace(/\.md$/, '')));
    for (const c of OLD_CODE_COMMANDS) writeFileSync(join(repo, '.claude', 'commands', `${c}.md`), old('commands', c));
    writeFileSync(join(repo, '.claude', 'protocol.md'), `${genericOf(readFileSync(join(plugin, 'harness', 'protocol.md'), 'utf8'), version)}\n${SPEC_LINE}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '--no-verify', '-m', 'chore: harness of the old layout');
  }
  // The team's own text below the line, and a file whose generic part was edited.
  const api = ws.repo('api');
  writeFileSync(join(api, '.claude', 'agents', 'domain-reviewer.md'), `${old('agents', 'domain-reviewer')}\n## Domain grid\n\n- DG-01: no negative balance.\n`);
  writeFileSync(join(api, '.claude', 'agents', 'reviewer.md'), old('agents', 'reviewer').replace('## Writes', 'A line of ours.\n\n## Writes'));
  // A file of web that only the install record knows (written by a later install, then recorded).
  const known = join(ws.repo('web'), '.claude', 'agents', 'explorer.md');
  writeFileSync(known, readFileSync(known, 'utf8').replace(SPEC_LINE, `<!-- written by a newer install -->\n${SPEC_LINE}`));
  mkdirSync(join(ws.repo('web'), '.recade'), { recursive: true });
  writeFileSync(join(ws.repo('web'), '.recade', 'installed.json'), JSON.stringify({ version, files: { '.claude/agents/explorer.md': createHash('sha256').update(readFileSync(known)).digest('hex') } }));
  git(api, 'add', '.');
  git(api, 'commit', '-q', '--no-verify', '-m', 'chore: the team specialises');
  // The slice worktrees, where /parallel used to open them. The one of web has work in progress.
  const apiTree = join(api, '.claude', 'worktrees', 'S-01');
  git(api, 'worktree', 'add', '-q', '-b', 'slice/S-01-accounts', apiTree);
  const webTree = join(ws.repo('web'), '.claude', 'worktrees', 'S-02');
  git(ws.repo('web'), 'worktree', 'add', '-q', '-b', 'slice/S-02-orders', webTree);
  writeFileSync(join(webTree, 'wip.ts'), 'x\n');
  return { ws, apiTree, webTree };
}

test('migrate --dry-run says what it would do and changes nothing', async () => {
  const { ws, apiTree, webTree } = await oldLayout();
  assert.ok(checkRepos(ws.dir).findings.some((f) => f.repo === 'api' && f.problem === 'old layout'));
  const before = readFileSync(join(ws.dir, '.gitignore'), 'utf8');
  const r = await cli(ws.dir, ['harness', 'migrate', '--dry-run']);
  assert.equal(r.code, 1, 'a worktree would be refused');
  assert.match(r.stdout, /^Dry run: nothing was changed\./);
  assert.match(r.stdout, /would move {2}api S-01: .*\.claude\/worktrees\/S-01 -> .*worktrees\/api\/S-01/);
  assert.match(r.stdout, /refused {5}web S-02: .*uncommitted changes \(1 file: wip\.ts\)/);
  assert.match(r.stdout, /would remove api \.claude\/agents\/implementer\.md/);
  assert.match(r.stdout, /would remove api \.claude\/agents\/domain-reviewer\.md \(the text of an earlier version of Recade; the text of the team: would carry it to the copy of the workspace\)/);
  assert.match(r.stdout, /kept {8}api \.claude\/agents\/reviewer\.md: it differs from what Recade v/);
  assert.match(r.stdout, /Harness at the root of the workspace: would install it \(/);
  assert.match(r.stdout, /worktrees\/ would be added/);
  assert.equal(readFileSync(join(ws.dir, '.gitignore'), 'utf8'), before);
  assert.ok(existsSync(apiTree) && existsSync(webTree));
  assert.ok(existsSync(join(ws.repo('api'), '.claude', 'agents', 'implementer.md')));
  assert.equal(existsSync(join(ws.dir, '.claude', 'commands', 'slice.md')), false);
});

test('migrate moves the clean worktrees, installs the root, removes the copies that are Recade\'s, keeps the team\'s, and runs again to the end', async () => {
  const { ws, apiTree, webTree } = await oldLayout();
  const api = ws.repo('api');
  const web = ws.repo('web');
  const r = migrate(ws.dir, { pluginRoot: plugin, ref: REF });
  assert.deepEqual(r.errors, []);
  // The workspace root holds every command and every agent, and keeps worktrees/ out of git by its exclude file.
  assert.deepEqual(md(join(ws.dir, '.claude', 'commands')), md(join(plugin, 'harness', 'commands')));
  assert.deepEqual(md(join(ws.dir, '.claude', 'agents')), md(join(plugin, 'harness', 'agents')));
  assert.ok(readFileSync(join(ws.dir, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('worktrees/'));
  assert.equal(readFileSync(join(ws.dir, '.gitignore'), 'utf8').split('\n').includes('worktrees/'), false);
  // The clean worktree moved, on its branch, and the workspace does not see it.
  const moved = join(ws.dir, 'worktrees', 'api', 'S-01');
  assert.equal(existsSync(apiTree), false);
  assert.equal(git(moved, 'branch', '--show-current').stdout.trim(), 'slice/S-01-accounts');
  assert.ok(git(api, 'worktree', 'list').stdout.includes(realpathSync(moved)));
  assert.equal(git(ws.dir, 'status', '--porcelain', '--', 'worktrees').stdout, '');
  // The one with work in progress stays, named.
  const refused = r.moves.find((m) => m.repo === 'web');
  assert.equal(refused.status, 'refused');
  assert.match(refused.reason, /uncommitted changes \(1 file: wip\.ts\)/);
  assert.ok(existsSync(join(webTree, 'wip.ts')));
  // The pristine copies are gone; the team's stay, with the reason; the pointer replaces the old /slice.
  assert.deepEqual(md(join(api, '.claude', 'agents')), ['reviewer.md']);
  assert.ok(readFileSync(join(ws.dir, '.claude', 'agents', 'domain-reviewer.md'), 'utf8').split(SPEC_LINE)[1].includes('- DG-01: no negative balance.'), 'the text of the team is in the copy of the workspace');
  assert.match(r.kept.find((k) => k.file.endsWith('reviewer.md') && !k.file.includes('domain')).reason, /differs from what Recade v/);
  assert.equal(existsSync(join(api, '.claude', 'protocol.md')), false);
  assert.deepEqual(md(join(api, '.claude', 'commands')), ['slice.md']);
  assert.match(readFileSync(join(api, '.claude', 'commands', 'slice.md'), 'utf8'), /recade-pointer/);
  // web: everything was Recade's, the file known by the install record too.
  assert.equal(existsSync(join(web, '.claude', 'agents')), false);
  assert.ok(r.removed.some((x) => x.repo === 'web' && x.file === '.claude/agents/explorer.md'));
  // The guard, the settings and the git hooks of the code stay in each repository.
  for (const f of ['.claude/settings.json', '.claude/hooks/recade-guard.mjs', '.githooks/pre-commit']) assert.ok(existsSync(join(api, f)), f);

  // The owner commits the work in progress; the next run moves the last worktree.
  git(webTree, 'add', 'wip.ts');
  git(webTree, 'commit', '-q', '--no-verify', '-m', 'feat: wip');
  const second = await cli(ws.dir, ['harness', 'migrate', '--ref', REF]);
  assert.equal(second.code, 0, second.stdout);
  assert.match(second.stdout, /moved {7}web S-02/);
  assert.ok(existsSync(join(ws.dir, 'worktrees', 'web', 'S-02', 'wip.ts')));
  // A third run finds only the files the team changed, and moves nothing.
  const third = migrate(ws.dir, { pluginRoot: plugin, ref: REF });
  assert.deepEqual([third.moves, third.removed, third.pointers], [[], [], []]);
  assert.deepEqual(third.kept.map((k) => k.file).sort(), ['.claude/agents/reviewer.md']);
  assert.deepEqual(third.install.written.filter((w) => w.status !== 'unchanged'), []);
  // Once the team moved its text and deleted its copies, nothing of the old layout is left.
  rmSync(join(api, '.claude', 'agents', 'reviewer.md'));
  assert.match((await cli(ws.dir, ['harness', 'migrate', '--ref', REF])).stdout, /Nothing of the old layout is left\./);
  assert.equal(checkRepos(ws.dir).findings.some((f) => f.problem === 'old layout'), false);
  // The workspace verifies.
  const verified = await cli(ws.dir, ['harness', 'verify', '--target', 'workspace']);
  assert.doesNotMatch(verified.stdout, /old layout|worktrees\//, verified.stdout);
});

test('migrate runs from the workspace only, and refuses a locked worktree or a taken place', async () => {
  const { ws, apiTree } = await oldLayout();
  assert.equal((await cli(ws.repo('api'), ['harness', 'migrate', '--dry-run'])).code, 1);
  git(ws.repo('api'), 'worktree', 'lock', apiTree);
  let r = migrate(ws.dir, { pluginRoot: plugin, ref: REF, dryRun: true });
  assert.match(r.moves.find((m) => m.repo === 'api').reason, /locked/);
  git(ws.repo('api'), 'worktree', 'unlock', apiTree);
  mkdirSync(join(ws.dir, 'worktrees', 'api', 'S-01'), { recursive: true });
  r = migrate(ws.dir, { pluginRoot: plugin, ref: REF, dryRun: true });
  assert.match(r.moves.find((m) => m.repo === 'api').reason, /taken already/);
});

test('migrate removes a specialised file of an adopted repository only once its text is carried to the workspace, and keeps one edited above the line', async () => {
  const { writeOwnFile } = await import('../../src/project/adopt.js');
  const { specialise } = await import('../../src/harness/specialise.js');
  const ws = await makeWorkspace({ repos: ['api'] });
  const state = join(ws.dir, 'recade', 'state.yaml');
  writeFileSync(state, `${readFileSync(state, 'utf8')}mode: adopt\n`);
  const repo = ws.repo('api');
  // The install wrote it through the own-files policy, then `recade harness specialise` recorded the specialised text.
  writeOwnFile(repo, '.claude/agents/domain-reviewer.md', old('agents', 'domain-reviewer'));
  specialise(repo, 'agent', 'domain-reviewer', '## Domain grid\n\n- DG-01: no negative balance.', { adopt: true });
  // A file only Recade wrote goes, as before.
  writeOwnFile(repo, '.claude/agents/reviewer.md', old('agents', 'reviewer'));
  // A file edited above the line, with the text of the team below it, stays: its edit is not Recade's.
  writeOwnFile(repo, '.claude/agents/explorer.md', `${old('agents', 'explorer').replace('## Writes', 'A line of ours.\n\n## Writes')}\n## Ours\n\n- keep me.\n`);
  const dry = migrate(ws.dir, { pluginRoot: plugin, ref: REF, dryRun: true });
  assert.deepEqual(dry.removed.map((x) => x.file).sort(), ['.claude/agents/domain-reviewer.md', '.claude/agents/reviewer.md']);
  assert.match(dry.removed.find((x) => x.file.includes('domain')).note, /the text of the team: would carry it/);
  assert.deepEqual(dry.kept.map((k) => k.file), ['.claude/agents/explorer.md']);
  assert.ok(existsSync(join(repo, '.claude', 'agents', 'domain-reviewer.md')), 'the dry run removes nothing');
  const r = migrate(ws.dir, { pluginRoot: plugin, ref: REF });
  assert.deepEqual(r.errors, []);
  assert.equal(existsSync(join(repo, '.claude', 'agents', 'domain-reviewer.md')), false);
  assert.equal(existsSync(join(repo, '.claude', 'agents', 'reviewer.md')), false);
  assert.ok(existsSync(join(repo, '.claude', 'agents', 'explorer.md')), 'the file edited above the line stays');
  assert.match(r.removed.find((x) => x.file.includes('domain')).note, /the text of the team: carried to the copy of the workspace/);
  const copy = readFileSync(join(ws.dir, '.claude', 'agents', 'domain-reviewer.md'), 'utf8');
  assert.ok(copy.split(SPEC_LINE)[1].includes('- DG-01: no negative balance.'));
  // The kept file carried its text below the line too; a second run carries nothing twice.
  const explorer = readFileSync(join(ws.dir, '.claude', 'agents', 'explorer.md'), 'utf8');
  assert.ok(explorer.split(SPEC_LINE)[1].includes('- keep me.'));
  const again = migrate(ws.dir, { pluginRoot: plugin, ref: REF });
  assert.equal(again.kept[0].carried, 'already in the copy of the workspace');
  assert.equal(readFileSync(join(ws.dir, '.claude', 'agents', 'domain-reviewer.md'), 'utf8'), copy);
  assert.equal(readFileSync(join(ws.dir, '.claude', 'agents', 'explorer.md'), 'utf8'), explorer);
});

test('migrate removes a protocol copy only when the workspace protocol holds its text word for word', async () => {
  const { ws } = await oldLayout();
  const api = ws.repo('api');
  const web = ws.repo('web');
  const proto = (dir) => join(dir, '.claude', 'protocol.md');
  writeFileSync(proto(api), `${readFileSync(proto(api), 'utf8')}\n## Lanes of api\n\n- api: standard.\n`);
  writeFileSync(proto(web), `${readFileSync(proto(web), 'utf8')}\n## Lanes of web\n\n- web: standard.\n`);
  install(ws.dir, { pluginRoot: plugin, target: 'workspace', ref: REF });
  writeFileSync(proto(ws.dir), `${readFileSync(proto(ws.dir), 'utf8')}\n## Lanes of api\n\n- api: standard.\n`);
  const r = migrate(ws.dir, { pluginRoot: plugin, ref: REF, dryRun: true });
  assert.ok(r.removed.some((x) => x.repo === 'api' && x.file === '.claude/protocol.md'));
  const kept = r.kept.find((k) => k.repo === 'web' && k.file === '.claude/protocol.md');
  assert.match(kept.carried, /^not carried: .*compare it with the copy of the workspace/);
});

test('the template history knows every current template, and a fingerprint ignores the version and the model line', async () => {
  const { fingerprint, knownTexts } = await import('../../src/harness/history.js');
  const known = knownTexts(plugin);
  for (const kind of ['agents', 'commands', 'pointer']) {
    for (const f of md(join(plugin, 'harness', kind))) assert.ok(known.has(fingerprint(readFileSync(join(plugin, 'harness', kind, f), 'utf8'))), `${kind}/${f}: run node tools/harness-history.js`);
  }
  assert.ok(known.has(fingerprint(readFileSync(join(plugin, 'harness', 'protocol.md'), 'utf8'))), 'protocol.md: run node tools/harness-history.js');
  const text = old('agents', 'reviewer');
  assert.equal(fingerprint(text.replace(`v${version}:`, 'v0.0.1:')), fingerprint(text));
  assert.equal(fingerprint(text.replace(/^model: .*$/m, 'model: fable')), fingerprint(text));
  assert.equal(fingerprint(`${text}\n## Ours\n`), fingerprint(text), 'the text below the line does not count');
  assert.notEqual(fingerprint(text.replace('## Writes', 'A line of ours.\n\n## Writes')), fingerprint(text));
});

test('migrate moves the ledger of a moved worktree to the workspace, and never overwrites one there', async () => {
  const { ws, apiTree } = await oldLayout();
  const ledger = '# S-01\n\nStarted: 1\nFIX loops: 1\nPR: api #12\n';
  mkdirSync(join(apiTree, '.recade', 'slices', 'S-01'), { recursive: true });
  writeFileSync(join(apiTree, '.recade', 'slices', 'S-01', 'progress.md'), ledger);
  const dry = migrate(ws.dir, { pluginRoot: plugin, ref: REF, dryRun: true });
  assert.deepEqual(dry.ledgers.map((l) => `${l.slice} ${l.status}`), ['S-01 would move']);
  const r = migrate(ws.dir, { pluginRoot: plugin, ref: REF });
  assert.deepEqual(r.ledgers.map((l) => `${l.slice} ${l.status}`), ['S-01 moved']);
  // /slice resumes from the workspace: the ledger still holds its pull request, so no rebase rewrites it.
  const now = join(ws.dir, '.recade', 'slices', 'S-01', 'progress.md');
  assert.equal(readFileSync(now, 'utf8'), ledger);
  assert.match(readFileSync(now, 'utf8'), /^PR: api #12$/m);
  assert.equal(existsSync(join(ws.dir, 'worktrees', 'api', 'S-01', '.recade', 'slices', 'S-01', 'progress.md')), false);
  assert.match(formatMigrateOf(r), /moved {7}api S-01 ledger: /);

  // A newer ledger in the workspace is never overwritten by the one of a worktree moved later.
  const { ws: ws2, webTree } = await oldLayout();
  rmSync(join(webTree, 'wip.ts'));
  mkdirSync(join(webTree, '.recade', 'slices', 'S-02'), { recursive: true });
  writeFileSync(join(webTree, '.recade', 'slices', 'S-02', 'progress.md'), 'old\n');
  mkdirSync(join(ws2.dir, '.recade', 'slices', 'S-02'), { recursive: true });
  writeFileSync(join(ws2.dir, '.recade', 'slices', 'S-02', 'progress.md'), 'newer\n');
  const kept = migrate(ws2.dir, { pluginRoot: plugin, ref: REF });
  assert.deepEqual(kept.ledgers.map((l) => `${l.slice} ${l.status}`), ['S-02 kept']);
  assert.equal(readFileSync(join(ws2.dir, '.recade', 'slices', 'S-02', 'progress.md'), 'utf8'), 'newer\n');
  assert.equal(readFileSync(join(ws2.dir, 'worktrees', 'web', 'S-02', '.recade', 'slices', 'S-02', 'progress.md'), 'utf8'), 'old\n');
  assert.ok(kept.notes.some((n) => /ledger in the workspace already/.test(n)));
});

test('migrate moves only the slice worktrees, and leaves the others where they are, named', async () => {
  const { ws } = await oldLayout();
  const api = ws.repo('api');
  for (const name of ['agent-a1b2c3', 'merge-12', 'scratch']) git(api, 'worktree', 'add', '-q', '--detach', join(api, '.claude', 'worktrees', name));
  const r = migrate(ws.dir, { pluginRoot: plugin, ref: REF });
  assert.deepEqual(r.moves.map((m) => m.slice).sort(), ['S-01', 'S-02']);
  assert.deepEqual(r.left.map((x) => x.name).sort(), ['agent-a1b2c3', 'merge-12', 'scratch']);
  assert.match(r.left.find((x) => x.name === 'merge-12').reason, /rebase worktree of \/merge-order/);
  assert.match(r.left.find((x) => x.name === 'agent-a1b2c3').reason, /not a slice ID/);
  for (const name of ['agent-a1b2c3', 'merge-12', 'scratch']) {
    assert.ok(existsSync(join(api, '.claude', 'worktrees', name)), name);
    assert.equal(existsSync(join(ws.dir, 'worktrees', 'api', name)), false, name);
  }
  assert.match(formatMigrateOf(r), /left {8}api agent-a1b2c3: .* stays where it is: its name is not a slice ID/);
});
