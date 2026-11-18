import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createProject } from '../../src/project/scaffold.js';
import { newDecision, closeDecision, listDecisions } from '../../src/project/decisions.js';
import { lintFiles } from '../../src/style/lint.js';
import { run } from '../../src/cli.js';

const CONFIG = {
  voice: 'randall-munroe',
  languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] },
};
const noGit = async () => ({ code: 0, stdout: '', stderr: '' });

async function project() {
  const r = await createProject('Fernhill Lending', {
    root: mkdtempSync(join(tmpdir(), 'recade-dec-')), mode: 'scratch', config: CONFIG, exec: noGit, today: '2026-11-13',
  });
  return r.dir;
}

const OPTIONS = [
  { label: 'Daily payouts', cost: '2 extra weeks (PROVISIONAL)', closes: 'Cash-flow complaints', risks: 'Bank fees | per transfer', calendar: 'Adds 2 weeks to M2', repo: 'D1 section 7, D2 section 8' },
  { label: 'Weekly payouts', cost: 'None', closes: 'Nothing new', risks: 'Slow money for small lenders', calendar: 'None', repo: 'D1 section 7' },
];
const FIELDS = {
  document: 'D1', question: 'How often do lenders get paid?', why: 'The ledger design depends on it.',
  known: 'Lenders ask for faster payouts', unknown: 'What the bank charges per transfer', options: OPTIONS,
  recommendation: 'Option B, weekly. It costs us nothing now.', changeMind: 'A bank fee under 10 cents per transfer.', due: '2026-12-01',
};
const file = (root, id) => readFileSync(join(root, 'decisions', `${id}.md`), 'utf8');

test('DEC ids increment, start at DEC-01 and are never reused', async () => {
  const root = await project();
  assert.equal(newDecision(root, FIELDS, { date: '2026-11-13' }), 'DEC-01');
  assert.equal(newDecision(root, { ...FIELDS, question: 'Which map vendor?' }), 'DEC-02');
  closeDecision(root, 'DEC-01', { choice: 'B', date: '2026-11-14' });
  assert.equal(newDecision(root, { ...FIELDS, question: 'Which e-mail vendor?' }), 'DEC-03');
  assert.deepEqual(readdirSync(join(root, 'decisions')).filter((f) => f.startsWith('DEC')).sort(), ['DEC-01.md', 'DEC-02.md', 'DEC-03.md']);
});

test('the file comes from the template and keeps the options, the recommendation and the due date', async () => {
  const root = await project();
  newDecision(root, FIELDS, { date: '2026-11-13' });
  const text = file(root, 'DEC-01');
  assert.match(text, /^---\ndoc_id: "DEC-01"\ntitle: "How often do lenders get paid\?"\nproject: "[^"]+"\nversion: "0\.1"\ndate: "2026-11-13"\nstatus: open\nlanguage: "en"\ndocument: "D1"\ndue: "2026-12-01"\n---\n/);
  assert.match(text, /^# DEC-01: How often do lenders get paid\?$/m);
  assert.match(text, /^## Question\n\nHow often do lenders get paid\?$/m);
  assert.match(text, /^## Why now\n\nThe ledger design depends on it\.$/m);
  assert.match(text, /^## Known and unknown\n\n\| Known \| Unknown \|\n\|---\|---\|\n\| Lenders ask for faster payouts \| What the bank charges per transfer \|$/m);
  assert.match(text, /^\| Calendar impact \| Adds 2 weeks to M2 \|$/m);
  assert.match(text, /^## What would change our mind\n\nA bank fee under 10 cents per transfer\.$/m);
  assert.match(text, /^## Repo changes per option\n\n- Option A: D1 section 7, D2 section 8\n- Option B: D1 section 7$/m);
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'DEC.md'), 'utf8');
  const headings = (t) => [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings(text), headings(template));
  assert.match(text, /^### Option A: Daily payouts$/m);
  assert.match(text, /^### Option B: Weekly payouts$/m);
  assert.match(text, /^\| Cost \| 2 extra weeks \(PROVISIONAL\) \|$/m);
  assert.match(text, /^\| Risks \| Bank fees \\\| per transfer \|$/m);
  assert.match(text, /^## Recommendation and its price\n\nOption B, weekly\./m);
  assert.match(text, /^> \[!DECISION\]\n> Decided: not yet\. Option: none\. By: nobody\. Date: none\.$/m);
  assert.equal(text.includes('{{'), false);
  assert.equal(text.includes('<!--'), false);
  assert.deepEqual(lintFiles(root, ['decisions']), []);
});

test('closing writes the choice and the date, flips the status, keeps the options', async () => {
  const root = await project();
  newDecision(root, FIELDS);
  closeDecision(root, 'DEC-01', { choice: 'b', date: '2026-11-20' });
  const text = file(root, 'DEC-01');
  assert.match(text, /^status: closed$/m);
  assert.match(text, /^> Decided: yes\. Option: B \(Weekly payouts\)\. By: owner\. Date: 2026-11-20\.$/m);
  assert.equal(text.includes('Decided: not yet'), false);
  assert.match(text, /^### Option A: Daily payouts$/m);
  assert.match(text, /^### Option B: Weekly payouts$/m);
  closeDecision(root, (newDecision(root, FIELDS)), { choice: 'daily payouts', date: '2026-11-21' });
  assert.match(file(root, 'DEC-02'), /Option: A \(Daily payouts\)/);
});

test('listing: all, open only, with the choice of closed ones', async () => {
  const root = await project();
  assert.deepEqual(listDecisions(root), []);
  newDecision(root, FIELDS);
  newDecision(root, { ...FIELDS, question: 'Which map vendor?', due: undefined });
  closeDecision(root, 'DEC-01', { choice: 'A', date: '2026-11-20' });
  assert.deepEqual(listDecisions(root), [
    { id: 'DEC-01', status: 'closed', document: 'D1', question: 'How often do lenders get paid?', due: '2026-12-01', choice: 'A (Daily payouts)' },
    { id: 'DEC-02', status: 'open', document: 'D1', question: 'Which map vendor?', due: '', choice: '' },
  ]);
  assert.deepEqual(listDecisions(root, { open: true }).map((d) => d.id), ['DEC-02']);
});

test('close refuses an unknown id, an unknown option, a closed decision and an empty choice', async () => {
  const root = await project();
  newDecision(root, FIELDS);
  assert.throws(() => closeDecision(root, 'DEC-09', { choice: 'A' }), /No decision DEC-09/);
  assert.throws(() => closeDecision(root, 'nope', { choice: 'A' }), /Invalid decision id/);
  assert.throws(() => closeDecision(root, 'DEC-01', { choice: 'C' }), /no option "C"\. Use A, B/);
  assert.throws(() => closeDecision(root, 'DEC-01', { choice: '  ' }), /needs the choice/);
  assert.throws(() => closeDecision(root, 'DEC-01', { choice: 'A', date: 'soon' }), /YYYY-MM-DD/);
  closeDecision(root, 'DEC-01', { choice: 'A' });
  assert.throws(() => closeDecision(root, 'DEC-01', { choice: 'B' }), /already closed/);
});

test('new validates its fields', async () => {
  const root = await project();
  assert.throws(() => newDecision(root, { ...FIELDS, question: ' ' }), /question is required/);
  assert.throws(() => newDecision(root, { ...FIELDS, recommendation: '' }), /recommendation is required/);
  assert.throws(() => newDecision(root, { ...FIELDS, options: [OPTIONS[0]] }), /two or three options/);
  assert.throws(() => newDecision(root, { ...FIELDS, options: [...OPTIONS, ...OPTIONS] }), /two or three options/);
  assert.throws(() => newDecision(root, { ...FIELDS, options: [OPTIONS[0], { ...OPTIONS[1], cost: '' }] }), /option B cost is required/);
  assert.throws(() => newDecision(root, { ...FIELDS, due: 'soon' }), /YYYY-MM-DD/);
  for (const key of ['why', 'known', 'unknown', 'changeMind']) {
    assert.throws(() => newDecision(root, { ...FIELDS, [key]: '' }), new RegExp(`${key} is required`));
  }
  assert.throws(() => newDecision(root, { ...FIELDS, document: 'D9' }), /document must be one of D1, D2, D3, STACK, PLAN, BIBLE/);
  assert.throws(() => newDecision(root, { ...FIELDS, options: [OPTIONS[0], { ...OPTIONS[1], calendar: '' }] }), /option B calendar is required/);
  assert.throws(() => newDecision(root, { ...FIELDS, options: [OPTIONS[0], { ...OPTIONS[1], repo: '' }] }), /option B repo is required/);
  assert.equal(existsSync(join(root, 'decisions', 'DEC-01.md')), false);
});

test('a held lock fails with a clear message, a stale lock is dropped', async () => {
  const root = await project();
  const lock = join(root, 'decisions', '.decisions.lock');
  writeFileSync(lock, '');
  assert.throws(() => newDecision(root, FIELDS, { lockTries: 2, lockWaitMs: 1 }), /locked by another command.*\.decisions\.lock/);
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  assert.equal(newDecision(root, FIELDS, { lockTries: 2, lockWaitMs: 1 }), 'DEC-01');
  assert.ok(!existsSync(lock));
});

const cliNew = (question) => [
  'decision', 'new', '--doc', 'D1', '--question', question, '--why', 'It blocks the ledger.', '--known', 'Lenders ask', '--unknown', 'The fee',
  '--options', JSON.stringify(OPTIONS), '--recommendation', 'Option B.', '--change-mind', 'A low fee.',
];

function makeIO(cwd) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {}, now: () => new Date(2026, 10, 20, 12) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('recade decision new, list and close', async () => {
  const root = await project();
  const t = makeIO(root);
  assert.equal(await run([
    ...cliNew('How often do lenders get paid?'), '--due', '2026-12-01',
  ], t.io), 0);
  assert.equal(t.stdout(), 'DEC-01\n');
  const l = makeIO(root);
  assert.equal(await run(['decision', 'list', '--open', '--json'], l.io), 0);
  assert.equal(JSON.parse(l.stdout())[0].id, 'DEC-01');
  const p = makeIO(root);
  assert.equal(await run(['decision', 'list'], p.io), 0);
  assert.match(p.stdout(), /^DEC-01\topen\tD1\tHow often do lenders get paid\?\t2026-12-01\t$/m);
  const c = makeIO(root);
  assert.equal(await run(['decision', 'close', 'DEC-01', '--choice', 'B'], c.io), 0);
  assert.equal(c.stdout(), 'DEC-01 closed on 2026-11-20.\n');
  assert.match(file(root, 'DEC-01'), /Option: B \(Weekly payouts\)\. By: owner\. Date: 2026-11-20\./);
  const again = makeIO(root);
  assert.equal(await run(['decision', 'close', 'DEC-01', '--choice', 'A'], again.io), 1);
  assert.match(again.stderr(), /already closed/);
});

test('recade decision: usage errors exit 2, bad JSON exits 2, no project exits 1', async () => {
  const root = await project();
  for (const args of [
    ['decision'], ['decision', 'nope'], ['decision', 'new', '--question', 'x'], ['decision', 'close', 'DEC-01'],
    ['decision', 'close', '--choice', 'A'], ['decision', 'list', '--bogus'], ['decision', 'new', '--question'],
  ]) {
    const t = makeIO(root);
    assert.equal(await run(args, t.io), 2, args.join(' '));
    assert.match(t.stderr(), /^Usage: recade decision/);
  }
  const t = makeIO(root);
  assert.equal(await run([...cliNew('x').slice(0, -6), '--options', '{nope', '--recommendation', 'y', '--change-mind', 'z'], t.io), 2);
  assert.match(t.stderr(), /--options must be a JSON array/);
  const usage = makeIO(root);
  await run(['decision', 'new'], usage.io);
  assert.match(usage.stderr(), /calendar, repo/);
  const none = makeIO(mkdtempSync(join(tmpdir(), 'recade-none-')));
  assert.equal(await run(['decision', 'list'], none.io), 1);
  assert.match(none.stderr(), /No Recade project here/);
});

test('--project <dir> points decision at a project from any folder', async () => {
  const root = await project();
  const elsewhere = makeIO(mkdtempSync(join(tmpdir(), 'recade-elsewhere-')));
  assert.equal(await run([...cliNew('Which map vendor?'), '--project', root], elsewhere.io), 0);
  assert.equal(elsewhere.stdout(), 'DEC-01\n');
});

test('two concurrent news from separate processes get distinct ids and leave no lock or temp file', async () => {
  const root = await project();
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'recade.js');
  const open = (n) => new Promise((resolve) => {
    execFile(process.execPath, [cli, ...cliNew(`Question ${n}?`), '--project', root], (err, stdout, stderr) => resolve({ err, stdout: stdout.trim(), stderr }));
  });
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(open));
  assert.ok(results.every((r) => r.err === null), results.map((r) => r.stderr).join(''));
  assert.deepEqual(results.map((r) => r.stdout).sort(), ['DEC-01', 'DEC-02', 'DEC-03', 'DEC-04', 'DEC-05', 'DEC-06']);
  assert.equal(listDecisions(root).length, 6);
  assert.deepEqual(readdirSync(join(root, 'decisions')).filter((f) => f.includes('lock') || f.includes('tmp')), []);
});
