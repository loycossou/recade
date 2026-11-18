import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { addQuarantine, removeQuarantine, listQuarantine, checkQuarantine, dueForIncrement, QuarantineInputError } from '../../src/harness/quarantine.js';
import { run } from '../../src/cli.js';

const EM = String.fromCharCode(0x2014);
const NOW = () => new Date(2026, 2, 10, 12, 0, 0);

function sheet(id, increment) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['app'], branch: `slice/${id.toLowerCase()}-x`, format: 'small', lane: 'standard',
    implementer: 'implementer', increment, depends_on: [], blocks: [], external_prerequisite: 'none',
    provisionals_used: [], size: 'M', touches: [`src/${id.toLowerCase()}/**`],
  };
  return `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n`;
}

/** A fictional project: S-01 and S-02 in INC-1, S-03 in INC-2. `done` lists the slices the board says are done. */
function project({ done = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recade-quarantine-'));
  mkdirSync(join(root, 'recade'));
  mkdirSync(join(root, 'slices'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', languages: { work: 'en' } }));
  for (const [id, inc] of [['S-01', 'INC-1'], ['S-02', 'INC-1'], ['S-03', 'INC-2']]) writeFileSync(join(root, 'slices', `${id}-x.md`), sheet(id, inc));
  if (done.length > 0) {
    const rows = ['S-01', 'S-02', 'S-03'].map((id) => `| ${id} | ${done.includes(id) ? 'done' : 'todo'} | |`);
    writeFileSync(join(root, 'slices', 'STATUS.md'), `# Status\n\n| Slice | State | Note |\n|---|---|---|\n${rows.join('\n')}\n`);
  }
  return root;
}

const file = (root) => join(root, 'tests', 'quarantine.json');
const entries = (root) => JSON.parse(readFileSync(file(root), 'utf8'));

test('add writes the tracked file tests/quarantine.json with test, reason, since and slice', () => {
  const root = project();
  const entry = addQuarantine(root, { test: 'schedule export keeps the order of rows', reason: 'fails one run in ten on the shared runner', slice: 'S-01' }, { now: NOW });
  assert.deepEqual(entry, { test: 'schedule export keeps the order of rows', reason: 'fails one run in ten on the shared runner', since: '2026-03-10', slice: 'S-01' });
  assert.deepEqual(entries(root), [entry]);
  assert.equal(readFileSync(file(root), 'utf8').endsWith('\n'), true);
  addQuarantine(root, { test: 'login redirect', reason: 'timing', slice: 'S-03', since: '2026-02-01' }, { now: NOW });
  assert.deepEqual(entries(root).map((e) => e.test), ['schedule export keeps the order of rows', 'login redirect']);
  assert.deepEqual(listQuarantine(root).map((e) => e.since), ['2026-03-10', '2026-02-01']);
});

test('add refuses a duplicate, an unknown slice, a bad date and empty or multi-line text, and writes nothing', () => {
  const root = project();
  const base = { test: 'a test', reason: 'a reason', slice: 'S-01' };
  addQuarantine(root, base, { now: NOW });
  const before = readFileSync(file(root), 'utf8');
  for (const [patch, message] of [
    [{}, /already quarantined/],
    [{ test: 'other', slice: 'S-09' }, /S-09.*no sheet/],
    [{ test: 'other', slice: 'S-1' }, /Invalid slice/],
    [{ test: 'other', since: '2026-13-40' }, /Invalid date/],
    [{ test: 'other', since: 'yesterday' }, /Invalid date/],
    [{ test: '  ' }, /test name/i],
    [{ test: 'two\nlines' }, /one line/],
    [{ test: 'other', reason: '' }, /reason/i],
    [{ test: 'other', reason: 'a\nb' }, /one line/],
  ]) {
    assert.throws(() => addQuarantine(root, { ...base, ...patch }, { now: NOW }), (err) => err instanceof QuarantineInputError && message.test(err.message), JSON.stringify(patch));
  }
  assert.equal(readFileSync(file(root), 'utf8'), before);
});

test('remove deletes one entry by its test name and says when there is none', () => {
  const root = project();
  addQuarantine(root, { test: 'a', reason: 'r', slice: 'S-01' }, { now: NOW });
  addQuarantine(root, { test: 'b', reason: 'r', slice: 'S-01' }, { now: NOW });
  assert.equal(removeQuarantine(root, 'a').test, 'a');
  assert.deepEqual(entries(root).map((e) => e.test), ['b']);
  assert.throws(() => removeQuarantine(root, 'a'), (err) => err instanceof QuarantineInputError && /not quarantined/.test(err.message));
  removeQuarantine(root, 'b');
  assert.deepEqual(entries(root), []);
});

test('list is empty without a file, and a file that is not valid is an error, not silence', () => {
  const root = project();
  assert.deepEqual(listQuarantine(root), []);
  mkdirSync(join(root, 'tests'));
  writeFileSync(file(root), '{not json');
  assert.throws(() => listQuarantine(root), /tests\/quarantine\.json is not valid JSON/);
  writeFileSync(file(root), '{"a": 1}');
  assert.throws(() => listQuarantine(root), /must be a list/);
  writeFileSync(file(root), JSON.stringify([{ test: 'a', reason: 'r', since: '2026-01-01' }]));
  assert.throws(() => listQuarantine(root), /entry 1.*slice/);
});

test('check passes while the entry belongs to the current increment and fails once the increment is over', () => {
  const root = project();
  addQuarantine(root, { test: 'a', reason: 'r', slice: 'S-01' }, { now: NOW });
  addQuarantine(root, { test: 'later', reason: 'r', slice: 'S-03' }, { now: NOW });
  const now = checkQuarantine(root);
  assert.deepEqual(now, { ok: true, expired: [], current: 'INC-1', count: 2 });
  // INC-1 is finished: its slices are done, INC-2 is the current increment.
  const moved = project({ done: ['S-01', 'S-02'] });
  addQuarantine(moved, { test: 'a', reason: 'r', slice: 'S-01', since: '2026-03-01' }, { now: NOW });
  addQuarantine(moved, { test: 'later', reason: 'r', slice: 'S-03' }, { now: NOW });
  const after = checkQuarantine(moved);
  assert.equal(after.ok, false);
  assert.equal(after.current, 'INC-2');
  assert.deepEqual(after.expired.map((e) => [e.test, e.increment]), [['a', 'INC-1']]);
  assert.match(after.expired[0].why, /INC-1.*INC-2/);
  assert.equal(checkQuarantine(moved, { inc: 'INC-1' }).ok, true, 'an explicit increment is the one asked for');
});

test('check fails an entry whose slice has no sheet any more', () => {
  const root = project();
  addQuarantine(root, { test: 'a', reason: 'r', slice: 'S-02' }, { now: NOW });
  const data = entries(root);
  data[0].slice = 'S-77';
  writeFileSync(file(root), JSON.stringify(data));
  const result = checkQuarantine(root);
  assert.equal(result.ok, false);
  assert.match(result.expired[0].why, /S-77 has no sheet/);
});

test('dueForIncrement holds the entries of that increment and of the earlier ones, not of a later one', () => {
  const root = project();
  addQuarantine(root, { test: 'one', reason: 'r', slice: 'S-01' }, { now: NOW });
  addQuarantine(root, { test: 'two', reason: 'r', slice: 'S-03' }, { now: NOW });
  assert.deepEqual(dueForIncrement(root, 'INC-1').map((e) => e.test), ['one']);
  assert.deepEqual(dueForIncrement(root, 'INC-2').map((e) => e.test), ['one', 'two']);
});

// ---------------------------------------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------------------------------------

async function cli(argv, { cwd }) {
  const out = [];
  const err = [];
  const code = await run(argv, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {} });
  return { code, out: out.join(''), err: err.join('') };
}

test('recade quarantine add, list, check and remove work end to end with the exit codes 0, 1 and 2', async () => {
  const root = project({ done: ['S-01', 'S-02'] });
  const add = await cli(['quarantine', 'add', 'login redirect', '--reason', 'timing on the runner', '--slice', 'S-03'], { cwd: root });
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /Quarantined "login redirect" \(S-03, since \d{4}-\d{2}-\d{2}\)/);
  assert.match(add.out, /tests\/quarantine\.json/);
  assert.equal(add.out.includes(EM), false);
  const list = await cli(['quarantine', 'list'], { cwd: root });
  assert.equal(list.code, 0);
  assert.match(list.out, /login redirect/);
  assert.match(list.out, /S-03/);
  assert.match(list.out, /timing on the runner/);
  assert.deepEqual(JSON.parse((await cli(['quarantine', 'list', '--json'], { cwd: root })).out).map((e) => e.test), ['login redirect']);
  assert.equal((await cli(['quarantine', 'list', '--names'], { cwd: root })).out, 'login redirect\n');
  assert.equal((await cli(['quarantine', 'list', '--names'], { cwd: project() })).out, '');
  const ok = await cli(['quarantine', 'check'], { cwd: root });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /1 quarantined test/);
  // an old entry makes the check fail with exit 1 and names the test
  await cli(['quarantine', 'add', 'schedule order', '--reason', 'flaky', '--slice', 'S-01'], { cwd: root });
  const bad = await cli(['quarantine', 'check'], { cwd: root });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /schedule order/);
  assert.match(bad.err, /INC-1/);
  assert.equal((await cli(['quarantine', 'remove', 'schedule order'], { cwd: root })).code, 0);
  assert.equal((await cli(['quarantine', 'check'], { cwd: root })).code, 0);
  // input problems
  const dup = await cli(['quarantine', 'add', 'login redirect', '--reason', 'x', '--slice', 'S-03'], { cwd: root });
  assert.equal(dup.code, 1);
  assert.match(dup.err, /already quarantined/);
  assert.equal((await cli(['quarantine', 'remove', 'nothing'], { cwd: root })).code, 1);
  // usage errors
  for (const args of [['quarantine'], ['quarantine', 'add'], ['quarantine', 'add', 'x'], ['quarantine', 'add', 'x', '--reason', 'r'], ['quarantine', 'remove'], ['quarantine', 'bogus'], ['quarantine', 'list', '--bogus'], ['quarantine', 'check', '--inc', 'x']]) {
    const r = await cli(args, { cwd: root });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /Usage: recade quarantine/, args.join(' '));
  }
  const elsewhere = mkdtempSync(join(tmpdir(), 'recade-quarantine-none-'));
  const none = await cli(['quarantine', 'list'], { cwd: elsewhere });
  assert.equal(none.code, 1);
  assert.match(none.err, /No Recade project here/);
  assert.equal(existsSync(join(elsewhere, 'tests')), false);
  const viaProject = await cli(['quarantine', 'list', '--project', root], { cwd: elsewhere });
  assert.equal(viaProject.code, 0, viaProject.err);
});

test('a test name that looks like an option is taken as data after the verb', async () => {
  const root = project();
  const r = await cli(['quarantine', 'add', '--reason', 'r', '--slice', 'S-01', '--', '--weird name'], { cwd: root });
  assert.equal(r.code, 0, r.err);
  assert.equal(entries(root)[0].test, '--weird name');
});
