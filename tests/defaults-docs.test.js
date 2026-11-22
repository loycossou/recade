import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetsText, codeDefaults, modelName, parseBlocks, syncShared } from '../tools/sync-shared.js';
import { SECOND_OPINION_MODELS } from '../src/models.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['README.md', 'docs/design.md', 'docs/delivery.md', 'commands/start.md', 'commands/slices.md', 'skills/writing-voice/SKILL.md'];
const read = (file) => readFileSync(join(repo, file), 'utf8');
const title = (word) => `${word[0].toUpperCase()}${word.slice(1)}`;
const sentences = (text) => text.split(/(?<=[.!?])\s+|\n/);
const MODEL_NAME = /\b(?:Opus|Sonnet|Fable|Haiku) \d+(?:\.\d+)?/g;
const MODEL_ID = /\bclaude-[a-z]+-\d+-\d+\b/g;
const BUDGET = /\b(D1|D2|D3|PLAN|STACK|BIBLE) (\d[\d,]*)/;

/**
 * Each sentence of the documents that states a default, checked against the defaults of the code. Returns one line per
 * mismatch, and one line per document where a check finds nothing to check, so a reworded sentence cannot pass unseen.
 * @param {ReturnType<typeof codeDefaults>} d
 * @param {Record<string, string>} texts the documents by path
 */
function problems(d, texts) {
  const out = [];
  const expectEach = (file, re, want, what) => {
    const found = [...texts[file].matchAll(re)].map((m) => m[1]);
    if (found.length === 0) out.push(`${file}: no sentence states ${what}`);
    for (const got of found) if (got !== want) out.push(`${file}: ${what} is ${got}, the code says ${want}`);
  };

  // models.writer
  for (const file of ['README.md', 'docs/design.md']) expectEach(file, /run on the latest (\w+) by default/g, title(d.writer), 'the writing model');
  expectEach('docs/design.md', /\(`(\w+)`, the default, or `\w+`\)/g, d.writer, 'models.writer');
  expectEach('commands/start.md', /\*\*(\w+)\*\* \(recommended\): the latest/g, title(d.writer), 'the recommended writing model');
  expectEach('commands/start.md', /ask again once, then save `(\w+)`/g, d.writer, 'the writing model saved by default');

  // slicing
  expectEach('docs/design.md', /^\| `(\w+)` \(default\) \|/gm, d.slicing, 'the slicing formula');
  expectEach('commands/slices.md', /ask again once, then use `(\w+)`/g, title(d.slicing), 'the slicing formula used by default');

  // word budgets
  for (const file of ['README.md', 'docs/design.md', 'skills/writing-voice/SKILL.md']) {
    const lines = sentences(texts[file]).filter((s) => /word budget/.test(s) && BUDGET.test(s));
    if (lines.length === 0) out.push(`${file}: no sentence states the word budgets`);
    for (const line of lines) {
      const stated = Object.fromEntries([...line.matchAll(new RegExp(BUDGET, 'g'))].map((m) => [m[1], Number(m[2].replaceAll(',', ''))]));
      if (budgetsText(stated) !== budgetsText(d.budgets)) out.push(`${file}: budgets ${budgetsText(stated)}, the code says ${budgetsText(d.budgets)}`);
    }
  }

  // the model of the second-opinion agent: the one of harness/models.yaml, or Fable, the other choice of models.second_opinion
  const ids = new Set([...Object.values(d.secondOpinionModel), SECOND_OPINION_MODELS.fable]);
  const shown = new Set([...ids].map(modelName));
  for (const file of ['README.md', 'docs/design.md', 'docs/delivery.md', 'commands/start.md']) {
    let seen = 0;
    for (const s of sentences(texts[file]).filter((x) => /second[-_ ]opinion/i.test(x))) {
      for (const [name] of s.matchAll(MODEL_NAME)) {
        seen++;
        if (!shown.has(name)) out.push(`${file}: the second opinion runs on ${name}, harness/models.yaml says ${[...shown].join(' or ')}`);
      }
      for (const [id] of s.matchAll(MODEL_ID)) if (!ids.has(id)) out.push(`${file}: the second opinion runs on ${id}, harness/models.yaml says ${[...ids].join(' or ')}`);
    }
    if (seen === 0) out.push(`${file}: no sentence names the model of the second opinion`);
  }
  return out;
}

const texts = Object.fromEntries(DOCS.map((f) => [f, read(f)]));

test('the documents state the defaults of the code', () => {
  assert.deepEqual(problems(codeDefaults(repo), texts), []);
});

test('the defaults table of the design is generated from the code and up to date', () => {
  const blocks = parseBlocks(texts['docs/design.md']).blocks.filter((b) => b.kind === 'generated' && b.name === 'defaults');
  assert.equal(blocks.length, 1, 'docs/design.md holds one generated:defaults block');
  const d = codeDefaults(repo);
  for (const value of [d.writer, d.slicing, d.secondOpinion, budgetsText(d.budgets), ...Object.values(d.secondOpinionModel)]) assert.ok(blocks[0].inner.includes(value), value);
  assert.ok(!syncShared(repo, { check: true }).changed.includes('docs/design.md'), 'Run npm run sync-shared');
});

test('a default changed in the code and not in the documents fails', () => {
  const d = codeDefaults(repo);
  const cases = [
    [{ ...d, writer: d.writer === 'opus' ? 'fable' : 'opus' }, /writing model|models\.writer/],
    [{ ...d, slicing: d.slicing === 'mixed' ? 'small' : 'mixed' }, /slicing formula/],
    [{ ...d, budgets: { ...d.budgets, D1: d.budgets.D1 + 1000 } }, /budgets/],
    [{ ...d, secondOpinionModel: { standard: 'claude-sonnet-9-1', sensitive: 'claude-sonnet-9-1' } }, /second opinion runs on/],
  ];
  for (const [changed, re] of cases) {
    const found = problems(changed, texts);
    assert.ok(found.length > 0 && found.every((p) => re.test(p)), found.join('\n'));
  }
});

test('modelName reads a Claude model id', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('sonnet'), 'sonnet');
});

test('every sentence that states the word budgets is checked, even right after another one', () => {
  const d = codeDefaults(repo);
  const line = texts['README.md'].split(/(?<=[.!?])\s+|\n/).find((s) => /word budget/.test(s) && /\bD1 \d/.test(s));
  // A short sentence right after a long one: a global regex would start its search past the end of it.
  assert.ok(line.search(/\bD1 \d/) > 30, line);
  const found = problems(d, { ...texts, 'README.md': `${line}\nThe word budget: D1 1.\n` });
  assert.equal(found.filter((p) => p.startsWith('README.md: budgets')).length, 1, found.join('\n'));
});
