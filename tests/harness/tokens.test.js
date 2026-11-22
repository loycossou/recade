import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { readTranscriptUsage, findTranscripts, recordCost, readCost } from '../../src/harness/cost.js';
import { run } from '../../src/cli.js';

// All transcripts here are synthetic: ids, models and numbers are invented.

const usage = (input, output, cacheWrite = 0, cacheRead = 0) => ({
  input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
});

/** One assistant line of a transcript. */
function assistant(id, model, u, extra = {}) {
  return JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:00:00.000Z', ...extra, message: { id, model, role: 'assistant', usage: u } });
}

function transcriptDir() {
  return mkdtempSync(join(tmpdir(), 'recade-tokens-'));
}

/** A session file plus subagent files, in the layout Claude Code writes. */
function session(dir, id, mainLines, subagents = {}) {
  writeFileSync(join(dir, `${id}.jsonl`), `${mainLines.join('\n')}\n`);
  if (Object.keys(subagents).length > 0) {
    mkdirSync(join(dir, id, 'subagents'), { recursive: true });
    for (const [agent, lines] of Object.entries(subagents)) writeFileSync(join(dir, id, 'subagents', `agent-${agent}.jsonl`), `${lines.join('\n')}\n`);
  }
  return join(dir, `${id}.jsonl`);
}

const row = (r) => [r.agent, r.model, r.input, r.output, r.cacheCreation, r.cacheRead];

test('a message written on several lines is counted once, whatever number of lines carries it', () => {
  const dir = transcriptDir();
  const p = session(dir, 's1', [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    assistant('msg_1', 'model-a', usage(10, 100, 1000, 5000)),
    assistant('msg_1', 'model-a', usage(10, 100, 1000, 5000)),
    assistant('msg_1', 'model-a', usage(10, 100, 1000, 5000)),
    assistant('msg_2', 'model-a', usage(2, 50, 0, 6000)),
  ]);
  const r = readTranscriptUsage(p);
  assert.equal(r.ok, true);
  assert.deepEqual(r.total, { input: 12, output: 150, cacheCreation: 1000, cacheRead: 11000 });
  assert.equal(r.tokens, 12162);
  assert.equal(r.messages, 2);
  assert.deepEqual(r.rows.map(row), [['main', 'model-a', 12, 150, 1000, 11000]]);
});

test('when the lines of one message disagree, the fullest one (most output) is the one counted', () => {
  const dir = transcriptDir();
  const p = session(dir, 's1', [
    assistant('msg_1', 'model-a', usage(10, 3, 0, 0)),
    assistant('msg_1', 'model-a', usage(10, 80, 0, 0)),
    assistant('msg_1', 'model-a', usage(10, 40, 0, 0)),
  ]);
  assert.equal(readTranscriptUsage(p).total.output, 80);
});

test('usage is summed per model', () => {
  const dir = transcriptDir();
  const p = session(dir, 's1', [
    assistant('m1', 'model-a', usage(1, 10)),
    assistant('m2', 'model-b', usage(2, 20)),
    assistant('m3', 'model-a', usage(3, 30)),
  ]);
  assert.deepEqual(readTranscriptUsage(p).rows.map(row), [['main', 'model-a', 4, 40, 0, 0], ['main', 'model-b', 2, 20, 0, 0]]);
});

test('subagent files next to the session are included, per agent id, with the agent type when the meta file has one', () => {
  const dir = transcriptDir();
  const p = session(dir, 's1', [assistant('m1', 'model-a', usage(1, 10))], {
    a111: [assistant('x1', 'model-b', usage(5, 50, 100, 200), { isSidechain: true, agentId: 'a111' }), assistant('x1', 'model-b', usage(5, 50, 100, 200), { isSidechain: true, agentId: 'a111' })],
    a222: [assistant('y1', 'model-c', usage(7, 70), { isSidechain: true, agentId: 'a222' })],
  });
  writeFileSync(join(dir, 's1', 'subagents', 'agent-a111.meta.json'), JSON.stringify({ agentType: 'implementer', description: 'private words that must not be copied' }));
  const r = readTranscriptUsage(p);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map(row), [['main', 'model-a', 1, 10, 0, 0], ['a111', 'model-b', 5, 50, 100, 200], ['a222', 'model-c', 7, 70, 0, 0]]);
  assert.equal(r.rows.find((x) => x.agent === 'a111').type, 'implementer');
  assert.equal(r.rows.find((x) => x.agent === 'a222').type, undefined);
  assert.equal(JSON.stringify(r).includes('private words'), false);
  assert.equal(r.tokens, 11 + 355 + 77);
});

test('the same message id in two files is counted once', () => {
  const dir = transcriptDir();
  const p = session(dir, 's1', [assistant('shared', 'model-a', usage(1, 10))], { a1: [assistant('shared', 'model-a', usage(1, 10))] });
  assert.equal(readTranscriptUsage(p).tokens, 11);
});

test('bad lines, other line types and lines without a usable usage are skipped, not fatal', () => {
  const dir = transcriptDir();
  const p = session(dir, 's1', [
    'not json at all',
    '{"type":"assistant"',
    JSON.stringify({ type: 'assistant', message: { id: 'no_usage', model: 'model-a' } }),
    JSON.stringify({ type: 'assistant', message: { id: 'bad', model: 'model-a', usage: usage(-1, 'x') } }),
    JSON.stringify({ type: 'assistant', message: { model: 'model-a', usage: usage(9, 9) } }),
    JSON.stringify({ type: 'system', message: { id: 'sys', model: 'model-a', usage: usage(9, 9) } }),
    assistant('synthetic', '<synthetic>', usage(0, 0)),
    assistant('ok', 'model-a', usage(1, 2)),
  ]);
  const r = readTranscriptUsage(p);
  assert.equal(r.ok, true);
  assert.equal(r.tokens, 3);
  assert.ok(r.skipped >= 4);
  assert.deepEqual(r.rows.map((x) => x.model), ['model-a']);
});

test('older transcripts without the cache fields still count their input and output', () => {
  const dir = transcriptDir();
  const p = session(dir, 's1', [assistant('m1', 'model-a', { input_tokens: 4, output_tokens: 6 })]);
  assert.equal(readTranscriptUsage(p).tokens, 10);
});

test('since keeps only the lines at or after that moment and skips lines with no usable timestamp, because they cannot be placed in the window', () => {
  const dir = transcriptDir();
  const p = session(dir, 's1', [
    assistant('old', 'model-a', usage(100, 100), { timestamp: '2026-03-01T00:00:00.000Z' }),
    assistant('new', 'model-a', usage(1, 1), { timestamp: '2026-04-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { id: 'untimed', model: 'model-a', usage: usage(50, 50) } }),
  ]);
  assert.equal(readTranscriptUsage(p, { since: Date.parse('2026-03-15T00:00:00Z') }).tokens, 2);
  assert.equal(readTranscriptUsage(p).tokens, 302);
});

test('every failure gives ok false with a reason, never a throw and never a number', () => {
  const dir = transcriptDir();
  assert.deepEqual(Object.keys(readTranscriptUsage(join(dir, 'missing.jsonl'))).sort(), ['ok', 'reason']);
  assert.equal(readTranscriptUsage(join(dir, 'missing.jsonl')).ok, false);
  const empty = session(dir, 'empty', []);
  assert.equal(readTranscriptUsage(empty).ok, false);
  const noUsage = session(dir, 'nou', [JSON.stringify({ type: 'user', message: { content: 'x' } })]);
  assert.match(readTranscriptUsage(noUsage).reason, /no usage/i);
  for (const bad of [undefined, null, '', 42, {}]) assert.equal(readTranscriptUsage(bad).ok, false);
  const throwing = { readFileSync() { throw new Error('boom'); }, readdirSync() { throw new Error('boom'); } };
  const r = readTranscriptUsage(join(dir, 'empty.jsonl'), { fs: throwing });
  assert.equal(r.ok, false);
  assert.match(r.reason, /boom/);
});

test('a subagent file that cannot be read makes the whole answer not recorded, because a partial figure would be a guess', () => {
  const dir = transcriptDir();
  const p = session(dir, 's1', [assistant('m1', 'model-a', usage(1, 1))], { a1: [assistant('x', 'model-a', usage(1, 1))] });
  const fs = { ...realFs, readFileSync: (f, ...rest) => { if (String(f).includes('agent-a1')) throw new Error('denied'); return realFs.readFileSync(f, ...rest); } };
  const r = readTranscriptUsage(p, { fs });
  assert.equal(r.ok, false);
  assert.match(r.reason, /denied/);
});

test('findTranscripts lists the session files of the project folder of a working directory, newest first, from a moment on', () => {
  const config = mkdtempSync(join(tmpdir(), 'recade-claude-'));
  const cwd = '/work/my.project/wt';
  const folder = join(config, 'projects', '-work-my-project-wt');
  mkdirSync(folder, { recursive: true });
  const older = join(folder, 'aaa.jsonl');
  const newer = join(folder, 'bbb.jsonl');
  writeFileSync(older, '{}\n');
  writeFileSync(newer, '{}\n');
  writeFileSync(join(folder, 'notes.txt'), 'x');
  utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  utimesSync(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
  assert.deepEqual(findTranscripts(cwd, { configDir: config }).map((c) => c.file), [newer, older]);
  assert.deepEqual(findTranscripts(cwd, { configDir: config, since: Date.parse('2026-01-15T00:00:00Z') }).map((c) => c.file), [newer]);
  assert.deepEqual(findTranscripts('/work/other', { configDir: config }), []);
  assert.deepEqual(findTranscripts(cwd, { configDir: join(config, 'nope') }), []);
});

// ---------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------

const NOW = () => new Date('2026-04-01T10:00:00Z');

test('each record holds the tokens of its own window and readCost sums them, saying when a record has none', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-tokens-rec-'));
  const row1 = { agent: 'main', model: 'model-a', input: 1, output: 2, cacheCreation: 3, cacheRead: 4 };
  const row2 = { agent: 'a1', type: 'implementer', model: 'model-b', input: 5, output: 6, cacheCreation: 0, cacheRead: 0 };
  const rec = recordCost(root, { slice: 'S-01', minutes: 5, fixLoops: 0, tokens: 10, usage: [row1] }, { now: NOW });
  assert.equal(rec.tokens, 10);
  assert.equal(rec.usage.length, 1);
  recordCost(root, { slice: 'S-01', minutes: 9, fixLoops: 1, tokens: 11, usage: [row2] }, { now: NOW });
  let c = readCost(root).bySlice.get('S-01');
  assert.equal(c.minutes, 9);
  assert.equal(c.tokens, 21);
  assert.deepEqual([c.tokenRecords, c.records], [2, 2]);
  assert.deepEqual(c.usage, [row1, row2]);
  recordCost(root, { slice: 'S-01', minutes: 12, fixLoops: 1 }, { now: () => new Date('2026-04-02T10:00:00Z') });
  c = readCost(root).bySlice.get('S-01');
  assert.equal(c.minutes, 12);
  assert.equal(c.tokens, 21, 'the windows that were recorded still count');
  assert.deepEqual([c.tokenRecords, c.records], [2, 3], 'the record without tokens is visible as such');
  assert.equal(c.lastAt, '2026-04-02T10:00:00.000Z');
});

test('recordCost refuses usage rows that are not whole numbers', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-tokens-bad-'));
  assert.throws(() => recordCost(root, { slice: 'S-01', minutes: 1, fixLoops: 0, tokens: 1, usage: [{ agent: 'main', model: 'm', input: 1.5, output: 0, cacheCreation: 0, cacheRead: 0 }] }), /whole number/);
  assert.throws(() => recordCost(root, { slice: 'S-01', minutes: 1, fixLoops: 0, tokens: 1, usage: 'x' }), /usage/);
});

test('a record whose usage is damaged still counts for its minutes and tokens, without the usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-tokens-dmg-'));
  mkdirSync(join(root, '.recade'));
  writeFileSync(join(root, '.recade', 'cost.jsonl'), `${JSON.stringify({ slice: 'S-01', minutes: 1, fix_loops: 0, tokens: 7, usage: 'oops', at: 'x' })}\n`);
  const c = readCost(root).bySlice.get('S-01');
  assert.equal(c.tokens, 7);
  assert.equal(c.usage, null);
});

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

async function cli(args, { cwd, env = {} }) {
  const out = [];
  const err = [];
  const code = await run(args, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env });
  return { code, out: out.join(''), err: err.join('') };
}

function project() {
  const root = mkdtempSync(join(tmpdir(), 'recade-tokens-cli-'));
  mkdirSync(join(root, 'recade'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', languages: { work: 'en' } }));
  return root;
}

const lastRecord = (root) => JSON.parse(readFileSync(join(root, '.recade', 'cost.jsonl'), 'utf8').trimEnd().split('\n').pop());

test('recade cost record --transcript fills the tokens from the transcript and keeps the per model rows', async () => {
  const root = project();
  const dir = transcriptDir();
  const p = session(dir, 's1', [assistant('m1', 'model-a', usage(1, 10, 100, 1000)), assistant('m1', 'model-a', usage(1, 10, 100, 1000))], { a1: [assistant('x1', 'model-b', usage(2, 20))] });
  const r = await cli(['cost', 'record', 'S-01', '--minutes', '3', '--fix-loops', '0', '--transcript', p], { cwd: root });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Recorded S-01: 3 min, 0 FIX loops, 1133 tokens \(2 agents\)\./);
  const rec = lastRecord(root);
  assert.equal(rec.tokens, 1133);
  assert.deepEqual(rec.usage.map((u) => [u.agent, u.model]), [['main', 'model-a'], ['a1', 'model-b']]);
});

test('recade cost record --transcript with an unreadable transcript records the minutes and says tokens: not recorded', async () => {
  const root = project();
  const r = await cli(['cost', 'record', 'S-01', '--minutes', '3', '--fix-loops', '0', '--transcript', join(transcriptDir(), 'gone.jsonl')], { cwd: root });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /tokens: not recorded/);
  const rec = lastRecord(root);
  assert.equal(rec.minutes, 3);
  assert.equal('tokens' in rec, false);
  assert.equal('usage' in rec, false);
});

/** A Claude config folder with the project folder of `dir` and the given sessions in it. */
function configWith(dir, sessions) {
  const config = mkdtempSync(join(tmpdir(), 'recade-claude-'));
  const folder = join(config, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  for (const [id, lines] of Object.entries(sessions)) session(folder, id, lines);
  return { config, folder };
}

test('recade cost record --transcript auto finds the session of the folder the command was started in, not the --project folder', async () => {
  const root = project();
  const worktree = mkdtempSync(join(tmpdir(), 'recade-worktree-'));
  const { config } = configWith(worktree, { abc: [assistant('m1', 'model-a', usage(1, 2))] });
  const env = { CLAUDE_CONFIG_DIR: config };
  const r = await cli(['cost', 'record', 'S-01', '--minutes', '1', '--fix-loops', '0', '--transcript', 'auto', '--project', root], { cwd: worktree, env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /3 tokens/);
  assert.equal(lastRecord(root).tokens, 3);
  const both = configWith(worktree, {});
  mkdirSync(join(both.config, 'projects', root.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
  session(join(both.config, 'projects', root.replace(/[^A-Za-z0-9]/g, '-')), 'other', [assistant('o1', 'model-a', usage(900, 900))]);
  const none = await cli(['cost', 'record', 'S-02', '--minutes', '1', '--fix-loops', '0', '--transcript', 'auto', '--project', root], { cwd: worktree, env: { CLAUDE_CONFIG_DIR: both.config } });
  assert.equal(none.code, 0);
  assert.match(none.out, /tokens: not recorded/, 'a session of the project folder is not the slice session');
});

test('--session-dir names the folder whose sessions are searched', async () => {
  const root = project();
  const sessionDir = mkdtempSync(join(tmpdir(), 'recade-sessdir-'));
  const { config } = configWith(sessionDir, { abc: [assistant('m1', 'model-a', usage(4, 5))] });
  const r = await cli(['cost', 'record', 'S-01', '--minutes', '1', '--fix-loops', '0', '--transcript', 'auto', '--session-dir', sessionDir, '--project', root], { cwd: tmpdir(), env: { CLAUDE_CONFIG_DIR: config } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /9 tokens/);
});

test('--transcript auto with several sessions written since --since records not recorded and lists the candidates, never guessing', async () => {
  const root = project();
  const dir = mkdtempSync(join(tmpdir(), 'recade-two-'));
  const { config, folder } = configWith(dir, { one: [assistant('a', 'model-a', usage(1, 1))], two: [assistant('b', 'model-a', usage(2, 2))] });
  const env = { CLAUDE_CONFIG_DIR: config };
  const r = await cli(['cost', 'record', 'S-01', '--minutes', '1', '--fix-loops', '0', '--transcript', 'auto', '--session-dir', dir, '--since', '1', '--project', root], { cwd: tmpdir(), env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /tokens: not recorded \(2 sessions were written since/);
  assert.match(r.out, /one\.jsonl/);
  assert.match(r.out, /two\.jsonl/);
  assert.equal('tokens' in lastRecord(root), false);
  const old = new Date('2026-01-01T00:00:00Z');
  utimesSync(join(folder, 'one.jsonl'), old, old);
  const ok = await cli(['cost', 'record', 'S-02', '--minutes', '1', '--fix-loops', '0', '--transcript', 'auto', '--session-dir', dir, '--since', String(Date.parse('2026-02-01T00:00:00Z')), '--project', root], { cwd: tmpdir(), env });
  assert.match(ok.out, /4 tokens/);
});

test('a second record of the slice counts only what happened after the first: windows add up, a failed read does not carry an older figure', async () => {
  const root = project();
  const dir = transcriptDir();
  const T = (hour) => `2026-04-01T${hour}:00:00.000Z`;
  const p = session(dir, 's1', [assistant('a', 'model-a', usage(1, 1), { timestamp: T('10') }), assistant('b', 'model-a', usage(2, 2), { timestamp: T('11') })]);
  const record = async (extra, now) => {
    const out = [];
    const err = [];
    const code = await run(['cost', 'record', 'S-01', '--minutes', '1', '--fix-loops', '0', '--project', root, ...extra], { stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, cwd: tmpdir(), env: {}, now: () => new Date(now) });
    assert.equal(code, 0, err.join(''));
    return out.join('');
  };
  const since = String(Date.parse(T('09')));
  assert.match(await record(['--transcript', p, '--since', since], '2026-04-01T11:30:00.000Z'), /6 tokens/);
  writeFileSync(p, `${readFileSync(p, 'utf8')}${assistant('c', 'model-a', usage(10, 10), { timestamp: T('12') })}\n`);
  assert.match(await record(['--transcript', p, '--since', since], '2026-04-01T12:30:00.000Z'), /20 tokens/);
  assert.match(await record(['--transcript', join(dir, 'gone.jsonl')], '2026-04-01T13:00:00.000Z'), /tokens: not recorded/);
  const c = readCost(root).bySlice.get('S-01');
  assert.equal(c.tokens, 26);
  assert.deepEqual([c.tokenRecords, c.records], [2, 3]);
});

test('recade cost record --since limits the transcript to what happened after the slice started', async () => {
  const root = project();
  const dir = transcriptDir();
  const p = session(dir, 's1', [assistant('o', 'model-a', usage(100, 100), { timestamp: '2026-03-01T00:00:00.000Z' }), assistant('n', 'model-a', usage(1, 1), { timestamp: '2026-04-01T00:00:00.000Z' })]);
  const since = String(Date.parse('2026-03-15T00:00:00Z'));
  const r = await cli(['cost', 'record', 'S-01', '--minutes', '1', '--fix-loops', '0', '--transcript', p, '--since', since], { cwd: root });
  assert.equal(r.code, 0, r.err);
  assert.equal(lastRecord(root).tokens, 2);
});

test('--transcript cannot be combined with --tokens, and --since needs --transcript: exit 2', async () => {
  const root = project();
  for (const extra of [['--transcript', 'x', '--tokens', '5'], ['--since', '5'], ['--session-dir', 'x'], ['--transcript', 'auto', '--session-dir'], ['--transcript'], ['--transcript', 'x', '--since', 'abc']]) {
    const r = await cli(['cost', 'record', 'S-01', '--minutes', '1', '--fix-loops', '0', ...extra], { cwd: root });
    assert.equal(r.code, 2, extra.join(' '));
    assert.match(r.err, /Usage: recade cost record/);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------------------------

const EM = String.fromCharCode(0x2014);
const slice = readFileSync(new URL('../../harness/commands/slice.md', import.meta.url), 'utf8');
const retroCmd = readFileSync(new URL('../../harness/commands/retro.md', import.meta.url), 'utf8');

test('/slice Step 13 passes the session transcript to the cost record and says how to find it', () => {
  const step = slice.slice(slice.indexOf('## Step 13. End'), slice.indexOf('## Step 14.'));
  assert.match(step, /--transcript '<transcript>'/);
  assert.match(step, /--since <Started>/);
  assert.match(step, /--session-dir '<home>'/);
  assert.match(step, /`<home>` is the folder this session was started in/);
  assert.match(step, /several sessions|more than one session/i);
  assert.match(step, /`transcript_path`/);
  assert.match(step, /`auto`/);
  assert.match(step, /--transcript/);
  assert.match(step, /tokens: not recorded/);
  assert.match(step, /never type a token figure yourself/i);
  assert.equal(step.includes(EM), false);
});

test('/slice only passes --transcript when the CLI help says it has it', () => {
  const three = slice.slice(slice.indexOf('## Step 3.'), slice.indexOf('## Step 4.'));
  assert.match(three, /`--transcript`/);
});

test('/retro shows the tokens of each slice and by agent model, and says what the figure is', () => {
  assert.match(retroCmd, /tokens of each slice/);
  assert.match(retroCmd, /by agent model/);
  assert.match(retroCmd, /cache/);
  assert.equal(retroCmd.includes(EM), false);
});
