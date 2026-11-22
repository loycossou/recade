import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { BACKLOG_FILE, SHORT_TRACK_CAP, checkSlices, readBacklog, renderStatus } from '../../src/project/slices.js';
import { MANIFEST, SPIKE_MIN, cleanSpikes, freeMemoryMb, recordBefore, spikeRoom } from '../../src/project/spikes.js';
import { DEFAULT_CONFIG, loadConfig, parsePreferences, saveConfig, setConfigValue, stackPreferences } from '../../src/config.js';
import { SHORT_SLICES, SHORT_SPIKES, SLICES, estimatePhases, projectFacts } from '../../src/estimate.js';
import { run } from '../../src/cli.js';

const root = new URL('../..', import.meta.url).pathname;
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const TIERS = JSON.parse(read('agents/models.json'));

const STORIES = Array.from({ length: 9 }, (_, i) => `GARD-0${i + 1}`);
const PLAN = `---\ndoc_id: PLAN\n---\n\n# Delivery plan\n\n## Backlog\n\n| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |\n|---|---|---|---|---|---|---|---|---|---|\n${STORIES.map((id) => `| ${id} | Core | Story ${id} | M | 2 | | 1 | Build | todo | |`).join('\n')}\n`;

function sheet(id, stories, front = {}) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['app'], branch: `slice/${id.toLowerCase()}`, format: 'small',
    lane: 'no-code', implementer: 'implementer', increment: 'INC-1', depends_on: [], blocks: [],
    external_prerequisite: 'none', provisionals_used: [], size: 'M', touches: [`src/${id.toLowerCase()}/**`], ...front,
  };
  return `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n\n## Goal\n\nOne sentence.\n\n## Scope\n\n${stories.map((s) => `- ${s} (the gist)`).join('\n')}\n\n## Definition of Done\n\n| # | Command (counts tests) | Expected | Seen red first? |\n|---|---|---|---|\n| 1 | \`make test\` (3 tests) | green | yes |\n`;
}

function project(state, sheets, backlog) {
  const dir = mkdtempSync(join(tmpdir(), 'recade-light-'));
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', lots: ['GARD'], gates: {}, ...state }));
  writeFileSync(join(dir, 'docs', 'PLAN.md'), PLAN);
  for (const [name, text] of Object.entries(sheets)) writeFileSync(join(dir, 'slices', name), text);
  if (backlog !== undefined) writeFileSync(join(dir, BACKLOG_FILE), backlog);
  return dir;
}

/** n sheets, S-01 the skeleton, story i in sheet i; the stories left over go to the backlog. */
function sheets(n) {
  const out = {};
  for (let i = 1; i <= n; i++) {
    const id = `S-0${i}`;
    out[`${id}-part.md`] = sheet(id, [STORIES[i - 1]], i === 1 ? { skeleton: true } : {});
  }
  return out;
}

const backlogOf = (stories) => `# Slice backlog\n\nThese slices are cut into sheets later.\n\n| Slice | Gist | Stories |\n|---|---|---|\n${stories.map((s, i) => `| later-${i + 1} | a later slice | ${s} (the gist) |`).join('\n')}\n`;

function makeIO(cwd, extra = {}) {
  const out = [];
  const err = [];
  return {
    io: { cwd, env: { HOME: cwd, RECADE_CONFIG_DIR: join(cwd, '.config') }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, ...extra },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

// ---- the cap of the short track

test('the short track caps the open sheets at 6, and the backlog covers the later stories', () => {
  assert.equal(SHORT_TRACK_CAP, 6);
  const six = project({ track: 'short' }, sheets(6), backlogOf(STORIES.slice(6)));
  assert.deepEqual(checkSlices(six).findings, []);
  const seven = project({ track: 'short' }, sheets(7), backlogOf(STORIES.slice(7)));
  const found = checkSlices(seven).findings;
  assert.deepEqual(found.map((f) => [f.rule, f.severity]), [['slice-cap', 'warn']]);
  assert.match(found[0].message, /6 open sheets at most.*there are 7.*slices\/BACKLOG\.md/);
});

test('the full track is unchanged: no cap, and a backlog file covers nothing', () => {
  const seven = project({}, sheets(7), backlogOf(STORIES.slice(7)));
  const rules = checkSlices(seven).findings.map((f) => f.rule);
  assert.ok(!rules.includes('slice-cap'));
  assert.deepEqual(rules, ['story-uncovered', 'story-uncovered']);
});

test('done sheets and S-00 do not count against the cap', () => {
  const many = { ...sheets(7), 'S-00-inventory.md': sheet('S-00', []) };
  const dir = project({ track: 'short' }, many, backlogOf(STORIES.slice(7)));
  writeFileSync(join(dir, 'slices', 'STATUS.md'), '| Slice | State | Note |\n|---|---|---|\n| S-01 | done | |\n');
  assert.deepEqual(checkSlices(dir).findings.map((f) => f.rule), []);
});

test('a story left out of both the sheets and the backlog is uncovered, and one in both is twice', () => {
  const missing = project({ track: 'short' }, sheets(6), backlogOf(STORIES.slice(7)));
  const lost = checkSlices(missing).findings;
  assert.deepEqual(lost.map((f) => f.rule), ['story-uncovered']);
  assert.match(lost[0].message, /GARD-07.*or in one row of slices\/BACKLOG\.md/);
  const both = project({ track: 'short' }, sheets(6), backlogOf(STORIES.slice(5)));
  const twice = checkSlices(both).findings;
  assert.deepEqual(twice.map((f) => f.rule), ['story-twice']);
  assert.match(twice[0].message, /GARD-06.*S-06, slices\/BACKLOG\.md \(later-1\)/);
});

test('the backlog is read from its first table with a Stories column, and STATUS.md counts its rows', async () => {
  const dir = project({ track: 'short' }, sheets(6), `# Slice backlog\n\n<!-- | not | a | table | -->\n\n${backlogOf(STORIES.slice(6)).split('\n').slice(4).join('\n')}`);
  const rows = readBacklog(dir);
  assert.deepEqual(rows.map((r) => [r.name, r.stories]), [['later-1', 'GARD-07 (the gist)'], ['later-2', 'GARD-08 (the gist)'], ['later-3', 'GARD-09 (the gist)']]);
  assert.equal(readBacklog(project({}, {})), null);
  assert.match(renderStatus([], rows), /## Backlog\n\n3 later slices wait in slices\/BACKLOG\.md/);
  assert.doesNotMatch(renderStatus([]), /## Backlog/);
  const t = makeIO(dir);
  assert.equal(await run(['slices', 'status'], t.io), 0, t.stderr());
  assert.match(readFileSync(join(dir, 'slices', 'STATUS.md'), 'utf8'), /3 later slices wait in slices\/BACKLOG\.md/);
  const moved = makeIO(dir);
  assert.equal(await run(['slices', 'status', '--set', 'S-01', 'done'], moved.io), 0, moved.stderr());
  assert.match(readFileSync(join(dir, 'slices', 'STATUS.md'), 'utf8'), /## Backlog/, 'a move keeps the backlog line');
});

// ---- the estimate

test('the short track estimate counts no spike and the capped sheets', () => {
  assert.deepEqual({ ...SHORT_SPIKES }, { low: 0, high: 0 });
  assert.ok(SHORT_SLICES.high <= SHORT_TRACK_CAP && SHORT_SLICES.high < SLICES.low);
  const dir = project({ track: 'short' }, {});
  const ctx = { writer: 'opus', tiers: TIERS };
  const phase = (state, id) => estimatePhases(projectFacts(dir, state), state, { ...ctx, phases: [id] }).phases[0];
  const spikes = phase({ track: 'short' }, 'docs').items.filter((i) => i.agent === 'spike-runner');
  assert.ok(spikes.every((i) => i.runs.low === 0 && i.runs.high === 0));
  const full = phase({ track: 'full' }, 'slices').dollars;
  const short = phase({ track: 'short' }, 'slices').dollars;
  assert.ok(short.high < full.high, 'the short track slices phase costs less');
});

// ---- the owner's stack preferences

test('stack.prefer ships php: symfony, and Laravel is never the default', () => {
  assert.deepEqual(DEFAULT_CONFIG.stack.prefer, { php: 'symfony' });
  assert.deepEqual(stackPreferences(DEFAULT_CONFIG), { php: 'symfony' });
  assert.ok(!JSON.stringify(DEFAULT_CONFIG).toLowerCase().includes('laravel'));
});

test('stack.prefer is set as a map or one language at a time, and none clears it', () => {
  let c = structuredClone(DEFAULT_CONFIG);
  c = setConfigValue(c, 'stack.prefer.python', 'django');
  assert.deepEqual(c.stack.prefer, { php: 'symfony', python: 'django' });
  c = setConfigValue(c, 'stack.prefer.php', 'none');
  assert.deepEqual(c.stack.prefer, { python: 'django' });
  c = setConfigValue(c, 'stack.prefer', 'php=symfony, ruby=rails');
  assert.deepEqual(c.stack.prefer, { php: 'symfony', ruby: 'rails' });
  c = setConfigValue(c, 'stack.prefer', 'none');
  assert.deepEqual(c.stack.prefer, {});
  assert.throws(() => parsePreferences('symfony'), /Write language=framework/);
  assert.throws(() => setConfigValue(c, 'stack.prefer.PHP!', 'x'), /Invalid language/);
  assert.deepEqual(stackPreferences({ stack: { prefer: { php: 'none', go: 'gin' } } }), { go: 'gin' });
});

test('a cleared map stays cleared after a save and a load, and the CLI reads and writes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-prefer-'));
  const env = { RECADE_CONFIG_DIR: dir };
  saveConfig(setConfigValue(structuredClone(DEFAULT_CONFIG), 'stack.prefer', 'none'), env);
  assert.deepEqual(loadConfig(env).config.stack.prefer, {});
  const out = [];
  const io = { cwd: dir, env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} } };
  assert.equal(await run(['config', 'set', 'stack.prefer.php', 'symfony'], io), 0);
  assert.equal(await run(['config', 'get', 'stack.prefer'], io), 0);
  assert.equal(out.join(''), 'php: symfony\n');
});

// ---- room for a spike

test('spikes check reads the free memory and disk, and says no below the threshold', async () => {
  assert.deepEqual({ ...SPIKE_MIN }, { memoryMb: 2048, diskMb: 5120 });
  assert.equal(freeMemoryMb({ meminfo: () => 'MemTotal: 8000000 kB\nMemAvailable:    3145728 kB\n' }), 3072);
  const mb = (n) => ({ bavail: n, bsize: 1024 * 1024 });
  const ok = spikeRoom('/x', { meminfo: () => 'MemAvailable: 4194304 kB', statfs: () => mb(20000), home: '/h' });
  assert.equal(ok.ok, true);
  const low = spikeRoom('/x', { meminfo: () => 'MemAvailable: 1048576 kB', statfs: (d) => mb(d === '/h' ? 3000 : 20000), home: '/h' });
  assert.equal(low.ok, false);
  assert.deepEqual(low.problems, ['Not enough free memory: 1024 MB, a spike needs 2048 MB.', 'Not enough free disk: 3000 MB, a spike needs 5120 MB.']);
  const dir = project({}, {});
  const t = makeIO(dir, { spikeSeams: { meminfo: () => 'MemAvailable: 1048576 kB', statfs: () => mb(20000) } });
  assert.equal(await run(['spikes', 'check'], t.io), 1);
  assert.match(t.stdout(), /Room for a spike: no\. Skip the spike/);
});

// ---- the cleanup

function spikeProject(manifest) {
  const dir = project({}, {});
  const folder = join(dir, 'spikes', 'framework-symfony');
  mkdirSync(join(folder, 'vendor'), { recursive: true });
  writeFileSync(join(folder, 'RESULT.md'), '# Result\n');
  writeFileSync(join(folder, MANIFEST), JSON.stringify(manifest));
  return { dir, folder };
}

test('spikes clean removes exactly what the manifest lists, and proves each item first', () => {
  const home = mkdtempSync(join(tmpdir(), 'recade-home-'));
  mkdirSync(join(home, '.cargo'), { recursive: true });
  mkdirSync(join(home, '.cache', 'mine'), { recursive: true });
  mkdirSync(join(home, 'projects', 'other'), { recursive: true });
  const { dir, folder } = spikeProject({
    containers: ['recade-spike-framework-symfony-db', 'postgres-of-the-owner'],
    images: ['recade-spike-framework-symfony:dev', 'php:8.4-cli', 'postgres:16', 'redis:7'],
    volumes: ['recade-spike-framework-symfony-data'],
    networks: ['--all'],
    processes: [{ pid: 4242, command: 'php -S 127.0.0.1:8000' }, { pid: 5151, command: 'symfony serve' }, { pid: 6161, command: 'node x' }, { pid: 7171, command: 'php -S 127.0.0.1:8000 -t public' }, { pid: 8181, command: 'node server.js' }],
    paths: ['vendor', 'RESULT.md', join(home, '.cargo'), join(home, '.rustup'), join(home, '.cache'), join(home, 'projects', 'other'), '~/projects/other', '../../docs', '/etc/hosts'],
  });
  const exec = (cmd) => (cmd.join(' ') === 'docker image ls -q --no-trunc' ? { code: 0, stdout: 'sha256:aaaa1111aaaa1111\nsha256:redis7redis7\n', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  recordBefore(dir, 'framework-symfony', { exec, home, now: () => 1_000_000 });
  mkdirSync(join(home, '.rustup'));
  const calls = [];
  const exec2 = (cmd) => {
    calls.push(cmd.join(' '));
    if (cmd.includes('inspect') && cmd.includes('php:8.4-cli')) return { code: 1, stdout: '', stderr: 'Error: No such image: php:8.4-cli' };
    if (cmd.includes('inspect') && cmd.includes('postgres:16')) return { code: 0, stdout: 'sha256:bbbb2222bbbb2222\n', stderr: '' };
    if (cmd.includes('inspect') && cmd.includes('redis:7')) return { code: 0, stdout: 'sha256:redis7redis7\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const killed = [];
  const procs = {
    4242: { command: 'php -S 127.0.0.1:8000', startedAt: 1_005_000 },
    5151: { command: 'vim notes.txt', startedAt: 1_005_000 },
    7171: { command: 'php -S 127.0.0.1:8000 -t public -v', startedAt: 1_005_000 },
    8181: { command: 'node server.js', startedAt: 500_000 },
  };
  const r = cleanSpikes(dir, { exec: exec2, kill: (pid) => killed.push(pid), procInfo: (pid) => procs[pid] ?? null, home });
  assert.deepEqual(calls, [
    'docker rm -f recade-spike-framework-symfony-db',
    'docker volume rm recade-spike-framework-symfony-data',
    'docker image rm recade-spike-framework-symfony:dev',
    'docker image inspect --format {{.Id}} php:8.4-cli',
    'docker image inspect --format {{.Id}} postgres:16',
    'docker image rm postgres:16',
    'docker image inspect --format {{.Id}} redis:7',
  ]);
  assert.deepEqual(killed, [4242], 'only the exact command line, started after the record');
  assert.deepEqual(r.removed.map((x) => `${x.kind} ${x.what}`), [
    'process 4242 (php -S 127.0.0.1:8000)', 'container recade-spike-framework-symfony-db', 'volume recade-spike-framework-symfony-data',
    'image recade-spike-framework-symfony:dev', 'image postgres:16', 'path vendor', `path ${join(home, '.rustup')}`,
  ]);
  assert.deepEqual(r.gone.map((x) => `${x.kind} ${x.what}`), ['process 6161 (node x)', 'image php:8.4-cli']);
  const kept = Object.fromEntries(r.kept.map((x) => [`${x.kind} ${x.what}`, x.why]));
  assert.deepEqual(Object.keys(kept), [
    'process 5151 (symfony serve)', 'process 7171 (php -S 127.0.0.1:8000 -t public)', 'process 8181 (node server.js)', 'container postgres-of-the-owner', 'network --all', 'image redis:7',
    'path RESULT.md', `path ${join(home, '.cargo')}`, `path ${join(home, '.cache')}`, `path ${join(home, 'projects', 'other')}`, 'path ~/projects/other', 'path ../../docs', 'path /etc/hosts',
  ]);
  assert.match(kept['process 8181 (node server.js)'], /started before the spike/);
  assert.match(kept['image redis:7'], /before the spike/);
  assert.match(kept[`path ${join(home, '.cargo')}`], /existed before the spike/);
  assert.match(kept['path ~/projects/other'], /never removed/);
  assert.equal(existsSync(join(folder, 'vendor')), false);
  assert.equal(existsSync(join(folder, 'RESULT.md')), true);
  assert.equal(existsSync(join(folder, MANIFEST)), true);
  assert.equal(existsSync(join(home, '.cargo')), true, 'a cache that was there before stays');
  assert.equal(existsSync(join(home, '.rustup')), false, 'a known cache the record proves new goes');
  assert.equal(existsSync(join(home, 'projects', 'other')), true, 'a sibling project is never removed');
  assert.equal(existsSync(join(home, '.cache', 'mine')), true, 'a cache the spike did not list stays');
  assert.equal(existsSync(join(dir, 'docs', 'PLAN.md')), true);
});

test('spikes clean never follows a link out of the spike folder, and removes the link itself', () => {
  const outside = mkdtempSync(join(tmpdir(), 'recade-outside-'));
  writeFileSync(join(outside, 'keep.txt'), 'mine\n');
  const { dir, folder } = spikeProject({ paths: ['link/keep.txt', 'via/keep.txt', 'link'] });
  symlinkSync(outside, join(folder, 'link'));
  symlinkSync(outside, join(folder, 'via'));
  const r = cleanSpikes(dir, { exec: () => ({ code: 0, stdout: '', stderr: '' }), procInfo: () => null, home: outside });
  assert.deepEqual(r.removed.map((x) => x.what), ['link']);
  assert.deepEqual(r.kept.map((x) => x.what), ['link/keep.txt', 'via/keep.txt']);
  assert.ok(r.kept.every((x) => /link that leads outside/.test(x.why)));
  assert.equal(existsSync(join(folder, 'link')), false, 'the link is gone');
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'mine\n', 'its target is untouched');
});

test('spikes clean keeps a process and an unnamed image when no record was taken before the spike', () => {
  const { dir } = spikeProject({ processes: [{ pid: 4242, command: 'php -S 127.0.0.1:8000' }], images: ['php:8.4-cli'] });
  const calls = [];
  const r = cleanSpikes(dir, { exec: (cmd) => (calls.push(cmd), { code: 0, stdout: '', stderr: '' }), kill: () => assert.fail('no kill'), procInfo: () => ({ command: 'php -S 127.0.0.1:8000', startedAt: Date.now() }) });
  assert.deepEqual(calls, []);
  assert.deepEqual(r.kept.map((x) => x.kind), ['process', 'image']);
  assert.ok(r.notes.some((n) => n.includes('no record of the machine before the spike')));
});

test('spikes check --spike records the machine and prints the environment of the runner', async () => {
  const dir = project({}, {});
  const mb = (n) => ({ bavail: n, bsize: 1024 * 1024 });
  const t = makeIO(dir, { run: () => ({ code: 0, stdout: 'sha256:abc123abc123\n', stderr: '' }), spikeSeams: { meminfo: () => 'MemAvailable: 4194304 kB', statfs: () => mb(20000), home: dir } });
  assert.equal(await run(['spikes', 'check', '--spike', 'framework-symfony'], t.io), 0, t.stderr());
  const rec = JSON.parse(readFileSync(join(dir, 'spikes', 'framework-symfony.before.json'), 'utf8'));
  assert.deepEqual(rec.images, ['sha256:abc123abc123']);
  assert.equal(rec.caches['.cargo'], false);
  assert.match(t.stdout(), /^export npm_config_cache='.*spikes\/framework-symfony\/\.recade-cache\/npm'$/m);
  assert.match(t.stdout(), /^export COMPOSER_CACHE_DIR=/m);
  const bad = makeIO(dir, { spikeSeams: { meminfo: () => 'MemAvailable: 4194304 kB', statfs: () => mb(20000) } });
  assert.equal(await run(['spikes', 'check', '--spike', '../x'], bad.io), 2);
});

test('spikes clean says when docker is missing, and skips a folder with no manifest or a broken one', async () => {
  const { dir } = spikeProject({ containers: ['recade-spike-a'], images: ['recade-spike-a:dev'] });
  mkdirSync(join(dir, 'spikes', 'db-sqlite'));
  mkdirSync(join(dir, 'spikes', 'db-postgres'));
  writeFileSync(join(dir, 'spikes', 'db-postgres', MANIFEST), '{ not json');
  const calls = [];
  const r = cleanSpikes(dir, { exec: (cmd) => (calls.push(cmd), { code: 127, stdout: '', stderr: 'spawn docker ENOENT' }), procInfo: () => null });
  assert.equal(calls.length, 1, 'docker is tried once');
  assert.deepEqual(r.kept.map((x) => x.why), ['docker not found', 'docker not found']);
  assert.ok(r.notes.some((n) => n.startsWith('spikes/db-postgres: MANIFEST.json is not valid JSON')));
  assert.ok(r.notes.some((n) => n === 'spikes/db-sqlite: no MANIFEST.json, so nothing was recorded and nothing was removed.'));
  const t = makeIO(dir, { run: () => ({ code: 0, stdout: '', stderr: '' }) });
  assert.equal(await run(['spikes', 'clean', '--spike', 'framework-symfony'], t.io), 0, t.stderr());
  assert.match(t.stdout(), /^Removed container recade-spike-a \(spikes\/framework-symfony\)\.$/m);
  assert.match(t.stdout(), /^Spikes cleaned: 2 items removed, 0 kept, from 1 manifest\.$/m);
  const bad = makeIO(dir);
  assert.equal(await run(['spikes', 'wipe'], bad.io), 2);
});

// ---- the rules in the prompts

test('the slicer, the slicing skill and /recade:slices hold the cap, the backlog and the next increment', () => {
  const slicer = read('agents/slicer.md');
  for (const part of ['plus at most 5 slices, 6 sheets in all', '`slices/BACKLOG.md`', '`Slice`, `Gist` and `Stories`', '`next`, short track only', 'Never edit or delete a sheet that exists', '`slice-cap`']) assert.ok(slicer.includes(part), part);
  const skill = read('skills/slicing/SKILL.md');
  for (const part of ['### The backlog of the short track', '`slice-cap` (warning)', 'the stage `next`', 'a story in a sheet and in the backlog is `story-twice`']) assert.ok(skill.includes(part), part);
  const cmd = read('commands/slices.md');
  for (const part of ['"Cut the next increment from the backlog now?"', 'with the stage `next`', 'G4 stays passed', '`slice-cap`', 'at most 5 slices (6 sheets)']) assert.ok(cmd.includes(part), part);
});

test('/recade:docs explains a spike, asks in the short track, checks the room and cleans up unasked', () => {
  const step = read('commands/docs.md').split('## Step 5.')[1].split('## Step 6.')[0];
  for (const part of ['A spike is a short real test of each finalist on this machine', '`No spikes, decide from the research (recommended)`', '`Run the spikes`', 'In the full track the spikes then run, with no question',
    "recade spikes check --spike '<layer>-<option>' --project '<dir>'", "recade spikes clean --project '<dir>'", 'without asking', 'never touches what a spike did not create', 'counts as a layer with no spike', 'recade config get stack.prefer']) assert.ok(step.includes(part), part);
  assert.ok(step.indexOf('recade spikes check') < step.indexOf('one after the other'), 'the check comes before the spikes');
  assert.ok(step.lastIndexOf('recade spikes clean') < step.indexOf("'<dir>/spikes'"), 'a last cleanup before the folder goes');
});

test('the spike runner keeps a manifest and the prefix, the analyst follows the owner preference', () => {
  const runner = read('agents/spike-runner.md');
  for (const part of ['MANIFEST.json', 'before you create it', '`recade-spike-<layer>-<option>-<what>`', 'Never list what you did not create', 'its ID was not on this machine when the spike began', 'Keep caches in the spike folder', 'exactly', 'never what it points to']) assert.ok(runner.includes(part), part);
  const analyst = read('agents/stack-analyst.md');
  for (const part of ['`stack.prefer`', "follows the owner's preference", 'never as the recommendation while the preferred one fits', 'Laravel is never the default PHP recommendation', 'the owner chose to decide from the research']) assert.ok(analyst.includes(part), part);
  const skill = read('skills/stack-selection/SKILL.md');
  for (const part of ['## Owner preferences', 'The shipped default is `php: symfony`', 'Laravel is never the default PHP recommendation', 'recade spikes check', 'recade spikes clean', 'only if the owner wants it']) assert.ok(skill.includes(part), part);
  assert.ok(read('skills/decision-sorting/SKILL.md').includes('The same holds for a layer whose spikes did not run'));
});
