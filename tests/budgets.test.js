import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BUDGETS, budgetsOf, checkSizes, countWords } from '../src/budgets.js';
import { run } from '../src/cli.js';

const words = (n) => Array.from({ length: n }, () => 'word').join(' ');

function project(state = '', docs = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recade-budget-'));
  mkdirSync(join(root, 'recade'));
  writeFileSync(join(root, 'recade', 'state.yaml'), `version: 1\nmode: scratch\ngates: {}\n${state}`);
  mkdirSync(join(root, 'docs'));
  for (const [file, text] of Object.entries(docs)) writeFileSync(join(root, file), text);
  return root;
}

function makeIO(cwd) {
  const out = [];
  const err = [];
  return { io: { cwd, env: { HOME: cwd }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, stdout: () => out.join(''), stderr: () => err.join('') };
}

test('the default budgets are the ones of the design', () => {
  assert.deepEqual({ ...DEFAULT_BUDGETS }, { D1: 10000, D2: 9000, D3: 7000, PLAN: 7000, STACK: 6000, BIBLE: 8000 });
});

test('countWords leaves out front matter, code blocks, comments, table rules and bare marks', () => {
  const text = ['---', 'title: "a b c d"', '---', '', '# Heading one', '', '<!-- a long comment of many words -->', '', 'Two words', '',
    '```js', 'const many = 1; const words = 2;', '```', '', '| ID | Name |', '|---|---|', '| FR-01 | Upload |', '', '- item', '> quote here'].join('\n');
  // Heading one (2) + Two words (2) + the table (4 words, counted for half: 2) + item (1) + quote here (2)
  assert.equal(countWords(text), 9);
});

test('countWords: a fence that is never closed counts as prose, and a fence indented in a list is code', () => {
  assert.equal(countWords('One two\n\n```\nthree four\nfive'), 5);
  assert.equal(countWords('- item\n\n  ```js\n  many code words here\n  ```\n\n- more'), 2);
  assert.equal(countWords('~~~\ncode\n~~~\nafter'), 1);
});

test('countWords: a word in a table row counts for half, rounded', () => {
  assert.equal(countWords('| a | b |\n|---|---|\n| c | d |'), 2);
  assert.equal(countWords('| a | b | c |'), 2);
  assert.equal(countWords(`${words(10)}\n| a | b |`), 11);
});

test('budgetsOf takes the defaults, then the budgets key of the state', () => {
  assert.deepEqual(budgetsOf(null), { ...DEFAULT_BUDGETS });
  assert.deepEqual(budgetsOf({ budgets: { D1: 12000 } }), { ...DEFAULT_BUDGETS, D1: 12000 });
});

test('budgetsOf refuses an unknown document and a value that is not a whole number of words', () => {
  assert.throws(() => budgetsOf({ budgets: { D9: 100 } }), /budgets\.D9 is not a document/);
  for (const bad of [0, -5, 12.5, '9000', null]) assert.throws(() => budgetsOf({ budgets: { D1: bad } }), /budgets\.D1 must be a whole number/, String(bad));
  assert.throws(() => budgetsOf({ budgets: [1] }), /map of document to words/);
});

test('checkSizes: under the budget is ok, over it a warning, over 150% an error, a missing file is skipped', () => {
  const root = project('budgets:\n  D1: 100\n  D2: 100\n  D3: 100\n', {
    'docs/D1.md': words(100), 'docs/D2.md': words(101), 'docs/D3.md': words(151),
  });
  const found = checkSizes(root);
  assert.deepEqual(found.map((f) => [f.doc, f.words, f.budget, f.percent, f.level]), [
    ['D1', 100, 100, 100, 'ok'], ['D2', 101, 100, 101, 'warn'], ['D3', 151, 100, 151, 'error'],
  ]);
  assert.equal(checkSizes(root, ['D2'])[0].file, 'docs/D2.md');
  assert.deepEqual(checkSizes(root, ['PLAN']), []);
  assert.equal(checkSizes(root).find((f) => f.doc === 'D2').level, 'warn');
  assert.throws(() => checkSizes(root, ['D9']), /D9 has no budget/);
});

test('exactly 150% is a warning, one word more is an error', () => {
  const root = project('budgets:\n  D1: 10\n  D2: 10\n', { 'docs/D1.md': words(15), 'docs/D2.md': words(16) });
  assert.deepEqual(checkSizes(root).map((f) => f.level), ['warn', 'error']);
});

test('recade docs size prints words against the budget and exits 1 only on an error', async () => {
  const root = project('budgets:\n  D1: 10\n  D2: 10\n  D3: 10\n', { 'docs/D1.md': words(8), 'docs/D2.md': words(12), 'docs/D3.md': words(20) });
  const t = makeIO(root);
  assert.equal(await run(['docs', 'size'], t.io), 1);
  assert.match(t.stdout(), /^ok docs\/D1\.md: 8 words, budget 10 \(80%\)\.$/m);
  assert.match(t.stdout(), /^warn docs\/D2\.md: 12 words, budget 10 \(120%\)\. Over budget: cut, do not summarise the cut\.$/m);
  assert.match(t.stdout(), /^error docs\/D3\.md: 20 words, budget 10 \(200%\)\. Over 150% of the budget: revise it, cut, do not summarise the cut\.$/m);
  const warnOnly = makeIO(root);
  assert.equal(await run(['docs', 'size', 'D1', 'D2'], warnOnly.io), 0);
  assert.doesNotMatch(warnOnly.stdout(), /D3/);
  const json = makeIO(root);
  assert.equal(await run(['docs', 'size', '--json', '--project', root], json.io), 1);
  assert.equal(JSON.parse(json.stdout()).find((f) => f.doc === 'D3').level, 'error');
});

test('recade docs size with no document says so, and a bad key is a usage error', async () => {
  const root = project();
  const t = makeIO(root);
  assert.equal(await run(['docs', 'size'], t.io), 0);
  assert.match(t.stdout(), /No document to measure yet/);
  for (const args of [['docs'], ['docs', 'nope'], ['docs', 'size', 'D9'], ['docs', 'size', '--bogus']]) {
    const u = makeIO(root);
    assert.equal(await run(args, u.io), 2, args.join(' '));
    assert.match(u.stderr(), /^Usage: recade docs/);
  }
  const none = makeIO(mkdtempSync(join(tmpdir(), 'recade-none-')));
  assert.equal(await run(['docs', 'size'], none.io), 1);
  assert.match(none.stderr(), /No Recade project here/);
});

test('recade docs size refuses a bad budgets key with exit 2', async () => {
  const root = project('budgets:\n  D1: lots\n', { 'docs/D1.md': words(5) });
  const t = makeIO(root);
  assert.equal(await run(['docs', 'size'], t.io), 2);
  assert.match(t.stderr(), /budgets\.D1 must be a whole number/);
});

test('recade docs budgets prints the budgets in force, one line each', async () => {
  const root = project('budgets:\n  D1: 12000\n');
  const t = makeIO(root);
  assert.equal(await run(['docs', 'budgets'], t.io), 0);
  assert.equal(t.stdout(), 'D1 12000 words (project)\nD2 9000 words (default)\nD3 7000 words (default)\nPLAN 7000 words (default)\nSTACK 6000 words (default)\nBIBLE 8000 words (default)\n');
  const json = makeIO(root);
  assert.equal(await run(['docs', 'budgets', '--json'], json.io), 0);
  assert.deepEqual(JSON.parse(json.stdout()), { D1: 12000, D2: 9000, D3: 7000, PLAN: 7000, STACK: 6000, BIBLE: 8000 });
});

test('recade state set budgets merges documents, and refuses a bad one', async () => {
  const root = project('budgets:\n  D1: 12000\n');
  const t = makeIO(root);
  assert.equal(await run(['state', 'set', 'budgets', 'D2=11000, PLAN=8000'], t.io), 0);
  const b = makeIO(root);
  await run(['docs', 'budgets', '--json'], b.io);
  assert.deepEqual(JSON.parse(b.stdout()), { D1: 12000, D2: 11000, D3: 7000, PLAN: 8000, STACK: 6000, BIBLE: 8000 });
  for (const bad of ['D9=100', 'D1=lots', 'D1', 'D1=0', 'D1=1.5']) {
    const e = makeIO(root);
    assert.equal(await run(['state', 'set', 'budgets', bad], e.io), 2, bad);
  }
});
