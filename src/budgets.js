import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontMatterLength } from './frontmatter-lines.js';
import { loadState } from './state.js';

/** Word budgets of the project documents, code blocks excluded. A project overrides them with `budgets:` in `recade/state.yaml`. */
export const DEFAULT_BUDGETS = Object.freeze({ D1: 10000, D2: 9000, D3: 7000, PLAN: 7000, STACK: 6000, BIBLE: 8000 });

/** Where each budgeted document lives, relative to the project folder. */
export const BUDGET_FILES = Object.freeze({
  D1: 'docs/D1.md', D2: 'docs/D2.md', D3: 'docs/D3.md', PLAN: 'docs/PLAN.md', STACK: 'docs/STACK.md', BIBLE: 'BIBLE.md',
});

/** Over the budget is a warning. Over this share of it, an error. */
export const ERROR_RATIO = 1.5;

/**
 * The budgets of a project: the defaults, then the `budgets:` key of its state. Throws on an unknown document or on a value
 * that is not a whole number of words, 1 or more.
 * @param {object|null} [state]
 * @returns {Record<string, number>}
 */
export function budgetsOf(state) {
  const set = state?.budgets;
  if (set === undefined || set === null) return { ...DEFAULT_BUDGETS };
  if (typeof set !== 'object' || Array.isArray(set)) throw new Error('budgets in recade/state.yaml must be a map of document to words.');
  for (const [doc, words] of Object.entries(set)) {
    if (!Object.hasOwn(DEFAULT_BUDGETS, doc)) throw new Error(`budgets.${doc} is not a document. Use ${Object.keys(DEFAULT_BUDGETS).join(', ')}.`);
    if (!Number.isInteger(words) || words < 1) throw new Error(`budgets.${doc} must be a whole number of words, 1 or more.`);
  }
  return { ...DEFAULT_BUDGETS, ...set };
}

/**
 * Words of a Markdown document: the front matter, the fenced code blocks, the HTML comments and the table rules are left
 * out, and so is a token with no letter and no digit (a pipe, a dash, a heading mark). A word in a table row counts for
 * half: a table packs many short cells, and a PLAN or a D3 is mostly tables. A fence that is never closed is not code: the
 * rest of the document counts as prose. A fence may be indented, as in a list.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  const lines = text.split(/\r\n|\r|\n/);
  let fence = null;
  const prose = [];
  for (const line of lines.slice(frontMatterLength(lines))) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (m !== null && m[1][0] === fence.char && m[1].length >= fence.len && line.trim() === m[1]) fence = null;
      else fence.lines.push(line);
      continue;
    }
    if (m !== null) {
      fence = { char: m[1][0], len: m[1].length, lines: [] };
      continue;
    }
    prose.push(line);
  }
  if (fence !== null) prose.push(...fence.lines);
  const words = (text) => text.split(/[\s|]+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  const body = prose.join('\n').replace(/<!--[\s\S]*?-->/g, ' ');
  let table = 0;
  let plain = 0;
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('|')) table += words(line);
    else plain += words(line);
  }
  return Math.round(plain + table / 2);
}

/**
 * @typedef {{doc: string, file: string, words: number, budget: number, percent: number, level: 'ok'|'warn'|'error'}} SizeFinding
 */

/**
 * Measure the documents of a project against their budgets. A document that does not exist yet is skipped.
 * @param {string} root project folder
 * @param {string[]} [docs] document keys (D1, D2, D3, PLAN, STACK, BIBLE); all of them by default
 * @returns {SizeFinding[]}
 */
export function checkSizes(root, docs = Object.keys(DEFAULT_BUDGETS)) {
  const budgets = budgetsOf(loadState(root));
  const out = [];
  for (const doc of docs) {
    if (!Object.hasOwn(BUDGET_FILES, doc)) throw new Error(`${doc} has no budget. Use ${Object.keys(BUDGET_FILES).join(', ')}.`);
    const path = join(root, BUDGET_FILES[doc]);
    if (!existsSync(path)) continue;
    const words = countWords(readFileSync(path, 'utf8'));
    const budget = budgets[doc];
    const level = words > budget * ERROR_RATIO ? 'error' : words > budget ? 'warn' : 'ok';
    out.push({ doc, file: BUDGET_FILES[doc], words, budget, percent: Math.round((words / budget) * 100), level });
  }
  return out;
}
