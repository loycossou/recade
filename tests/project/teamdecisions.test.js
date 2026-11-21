import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../../src/project/scaffold.js';
import { newDecision, listDecisions } from '../../src/project/decisions.js';
import { addTeamDecision, challengeTeamDecision, listTeamDecisions } from '../../src/project/teamdecisions.js';
import { lintFiles } from '../../src/style/lint.js';
import { run } from '../../src/cli.js';

const CONFIG = {
  voice: 'randall-munroe',
  languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] },
};
const noGit = async () => ({ code: 0, stdout: '', stderr: '' });

async function project() {
  const r = await createProject('Fernhill Lending', {
    root: mkdtempSync(join(tmpdir(), 'recade-team-')), mode: 'scratch', config: CONFIG, exec: noGit, today: '2026-11-13',
  });
  return r.dir;
}

const FIELDS = { document: 'D1', question: 'Which date format on the statements?', decided: 'ISO dates (2026-11-13)', why: 'Reversible, and the lenders read both.' };
const register = (root) => readFileSync(join(root, 'decisions', 'TEAM.md'), 'utf8');

function makeIO(cwd) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {}, now: () => new Date(2026, 10, 20, 12) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('the first team decision creates the register, with ids TD-01, TD-02 that are never reused', async () => {
  const root = await project();
  assert.deepEqual(listTeamDecisions(root), []);
  assert.equal(addTeamDecision(root, FIELDS, { date: '2026-11-13' }), 'TD-01');
  assert.equal(addTeamDecision(root, { ...FIELDS, document: 'D2', question: 'Which log format?', decided: 'JSON lines' }, { date: '2026-11-13' }), 'TD-02');
  const text = register(root);
  assert.match(text, /^---\ndoc_id: "TEAM-DECISIONS"\ntitle: "Decided by the team"\nproject: "[^"]+"\nversion: "0\.1"\ndate: "2026-11-13"\nstatus: Register\nlanguage: "en"\n---\n/);
  assert.match(text, /^# Decided by the team$/m);
  assert.match(text, /^\| Ref \| Document \| Question \| Decided \| Why \| Status \|$/m);
  assert.match(text, /^\| TD-01 \| D1 \| Which date format on the statements\? \| ISO dates \(2026-11-13\) \| Reversible, and the lenders read both\. \| decided \|$/m);
  assert.deepEqual(listTeamDecisions(root).map((d) => [d.id, d.document, d.status, d.dec]), [['TD-01', 'D1', 'decided', ''], ['TD-02', 'D2', 'decided', '']]);
});

test('a team decision never takes a DEC id, and a DEC list does not see the register', async () => {
  const root = await project();
  addTeamDecision(root, FIELDS);
  assert.deepEqual(listDecisions(root), []);
  assert.deepEqual(readdirSync(join(root, 'decisions')).filter((f) => f.startsWith('DEC')), []);
});

test('a cell is one line, and a pipe or a newline in it survives the round trip', async () => {
  const root = await project();
  addTeamDecision(root, { ...FIELDS, question: 'A | B?\nOr C?', why: 'Because | reason' });
  const [d] = listTeamDecisions(root);
  assert.equal(d.question, 'A | B? Or C?');
  assert.equal(d.why, 'Because | reason');
});

test('every field is required, and the document must be one of the documents', async () => {
  const root = await project();
  for (const key of ['question', 'decided', 'why']) assert.throws(() => addTeamDecision(root, { ...FIELDS, [key]: ' ' }), new RegExp(`${key} is required`));
  assert.throws(() => addTeamDecision(root, { ...FIELDS, document: 'D9' }), /document must be one of/);
  assert.throws(() => addTeamDecision(root, { ...FIELDS, document: 'design-direction' }), /document must be one of/);
});

test('a challenged team decision points to the DEC that replaces it, once', async () => {
  const root = await project();
  addTeamDecision(root, FIELDS);
  const dec = newDecision(root, {
    document: 'D1', question: 'Which date format on the statements?', why: 'The owner challenged it.', known: 'Lenders read both', unknown: 'Which they prefer',
    options: [
      { label: 'ISO dates', cost: 'None', closes: 'Ambiguity', risks: 'Looks technical', calendar: 'None', repo: 'D1' },
      { label: 'Local dates', cost: 'None', closes: 'Nothing new', risks: 'Ambiguity', calendar: 'None', repo: 'D1' },
    ],
    recommendation: 'ISO. No cost.', changeMind: 'Lenders complain.',
  });
  challengeTeamDecision(root, 'TD-01', { dec });
  assert.deepEqual(listTeamDecisions(root).map((d) => [d.status, d.dec]), [['challenged', dec]]);
  assert.match(register(root), new RegExp(`\\| challenged \\(${dec}\\) \\|$`, 'm'));
  assert.throws(() => challengeTeamDecision(root, 'TD-01', { dec }), /already challenged/);
  assert.throws(() => challengeTeamDecision(root, 'TD-09', { dec }), /No team decision TD-09/);
  assert.throws(() => challengeTeamDecision(root, 'TD-01x', { dec }), /Invalid team decision id/);
});

test('a challenge needs a DEC that exists', async () => {
  const root = await project();
  addTeamDecision(root, FIELDS);
  assert.throws(() => challengeTeamDecision(root, 'TD-01', { dec: 'DEC-07' }), /No decision DEC-07/);
  assert.throws(() => challengeTeamDecision(root, 'TD-01', { dec: 'nope' }), /Invalid decision id/);
});

test('the register passes the style linter', async () => {
  const root = await project();
  addTeamDecision(root, FIELDS);
  assert.deepEqual(lintFiles(root, ['decisions/TEAM.md']).filter((f) => f.severity === 'error'), []);
});

test('recade decision team add, list and challenge', async () => {
  const root = await project();
  const a = makeIO(root);
  assert.equal(await run(['decision', 'team', 'add', '--doc', 'D1', '--question', FIELDS.question, '--decided', FIELDS.decided, '--why', FIELDS.why], a.io), 0);
  assert.equal(a.stdout(), 'TD-01\n');
  const l = makeIO(root);
  assert.equal(await run(['decision', 'team', 'list'], l.io), 0);
  assert.match(l.stdout(), /^TD-01\tdecided\tD1\tWhich date format on the statements\?\tISO dates \(2026-11-13\)\tReversible, and the lenders read both\.$/m);
  const j = makeIO(root);
  assert.equal(await run(['decision', 'team', 'list', '--json'], j.io), 0);
  assert.equal(JSON.parse(j.stdout())[0].id, 'TD-01');
  const n = makeIO(root);
  assert.equal(await run(['decision', 'new', '--doc', 'D1', '--question', 'Which date format?', '--why', 'w', '--known', 'k', '--unknown', 'u',
    '--options', JSON.stringify([
      { label: 'ISO', cost: 'c', closes: 'x', risks: 'r', calendar: 'none', repo: 'D1' },
      { label: 'Local', cost: 'c', closes: 'x', risks: 'r', calendar: 'none', repo: 'D1' },
    ]), '--recommendation', 'ISO', '--change-mind', 'a complaint'], n.io), 0);
  const c = makeIO(root);
  assert.equal(await run(['decision', 'team', 'challenge', 'TD-01', '--dec', 'DEC-01'], c.io), 0);
  assert.match(c.stdout(), /TD-01 challenged: DEC-01 replaces it\./);
  const open = makeIO(root);
  await run(['decision', 'team', 'list', '--json'], open.io);
  assert.equal(JSON.parse(open.stdout())[0].status, 'challenged');
});

test('recade decision team: usage errors exit 2, a refused change exits 1', async () => {
  const root = await project();
  for (const args of [
    ['decision', 'team'], ['decision', 'team', 'nope'], ['decision', 'team', 'add', '--doc', 'D1'], ['decision', 'team', 'challenge', 'TD-01'],
    ['decision', 'team', 'challenge', '--dec', 'DEC-01'], ['decision', 'team', 'list', '--bogus'],
  ]) {
    const t = makeIO(root);
    assert.equal(await run(args, t.io), 2, args.join(' '));
    assert.match(t.stderr(), /^Usage: recade decision/);
  }
  const t = makeIO(root);
  assert.equal(await run(['decision', 'team', 'challenge', 'TD-01', '--dec', 'DEC-01'], t.io), 1);
  assert.match(t.stderr(), /No team decision TD-01/);
});
