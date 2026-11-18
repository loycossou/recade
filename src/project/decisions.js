import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectName } from '../workspace/layout.js';
import { frontMatterLength } from '../frontmatter-lines.js';
import { loadState } from '../state.js';
import { withLock as lockFile, writeAtomic } from './lockfile.js';
import { fillTemplate, localToday, readTemplate } from './template.js';

const DIR = 'decisions';
const LOCK = [DIR, '.decisions.lock'];
const FILE = /^DEC-(\d{2,})\.md$/;
const ID = /^DEC-\d{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LETTERS = 'ABC';
const DOCUMENTS = ['D1', 'D2', 'D3', 'STACK', 'PLAN', 'BIBLE'];
const OPEN_BOX = '> Decided: not yet. Option: none. By: nobody. Date: none.';

const withLock = (root, lock, fn) => lockFile(root, LOCK, lock, fn, 'The decisions folder');

/** A table cell: one line, pipes escaped. */
const cell = (value) => String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim().replaceAll('|', '\\|');
const line = (value) => String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();

const required = (value, name) => {
  const text = typeof value === 'string' ? line(value) : '';
  if (text === '') throw new Error(`${name} is required.`);
  return text;
};

/** The options of a new decision, checked: two or three, each with a label, a cost, what it closes, its risks, its calendar impact and its repo changes. */
function checkOptions(options) {
  if (!Array.isArray(options) || options.length < 2 || options.length > LETTERS.length) {
    throw new Error('A decision has two or three options.');
  }
  return options.map((o, i) => ({
    label: required(o?.label, `option ${LETTERS[i]} label`),
    cost: required(o?.cost, `option ${LETTERS[i]} cost`),
    closes: required(o?.closes, `option ${LETTERS[i]} closes`),
    risks: required(o?.risks, `option ${LETTERS[i]} risks`),
    calendar: required(o?.calendar, `option ${LETTERS[i]} calendar`),
    repo: required(o?.repo, `option ${LETTERS[i]} repo`),
  }));
}

/** The numbers of the DEC files in `decisions/`. Closed ones count, so an id is never reused. */
function usedNumbers(root) {
  const dir = join(root, DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => FILE.exec(f)?.[1]).filter(Boolean).map(Number);
}

const pathOf = (root, id) => join(root, DIR, `${id}.md`);

function body(fields, options) {
  const out = ['', '## Question', '', fields.question, '', '## Why now', '', fields.why, ''];
  out.push('## Known and unknown', '', '| Known | Unknown |', '|---|---|', `| ${cell(fields.known)} | ${cell(fields.unknown)} |`, '');
  out.push('## Options', '');
  options.forEach((o, i) => {
    out.push(
      `### Option ${LETTERS[i]}: ${line(o.label)}`, '',
      '| Item | Value |', '|---|---|',
      `| Cost | ${cell(o.cost)} |`, `| What it closes | ${cell(o.closes)} |`, `| Risks | ${cell(o.risks)} |`,
      `| Calendar impact | ${cell(o.calendar)} |`, '',
    );
  });
  out.push('## Recommendation and its price', '', fields.recommendation, '');
  out.push('## What would change our mind', '', fields.changeMind, '');
  out.push('## Repo changes per option', '', ...options.map((o, i) => `- Option ${LETTERS[i]}: ${line(o.repo)}`), '');
  out.push('## Decision', '', '> [!DECISION]', OPEN_BOX, '');
  return out.join('\n');
}

/**
 * Open a decision: write `decisions/DEC-nn.md` from the DEC template and return its id (DEC-01, DEC-02, ...).
 * Ids are never reused.
 * @param {string} root project folder
 * @param {{document: string, question: string, why: string, known: string, unknown: string, options: {label: string, cost: string, closes: string, risks: string, calendar: string, repo: string}[], recommendation: string, changeMind: string, due?: string}} fields
 * @param {{date?: string, lockTries?: number, lockWaitMs?: number}} [extra]
 * @returns {string}
 */
export function newDecision(root, fields, { date = localToday(), ...lock } = {}) {
  const question = required(fields?.question, 'question');
  const options = checkOptions(fields?.options);
  const recommendation = required(fields?.recommendation, 'recommendation');
  const due = typeof fields?.due === 'string' ? fields.due.trim() : '';
  if (due !== '' && !DATE.test(due)) throw new Error('due must be YYYY-MM-DD.');
  const why = required(fields?.why, 'why');
  const known = required(fields?.known, 'known');
  const unknown = required(fields?.unknown, 'unknown');
  const changeMind = required(fields?.changeMind, 'changeMind');
  const document = typeof fields?.document === 'string' ? fields.document.trim() : '';
  if (!DOCUMENTS.includes(document)) throw new Error(`document must be one of ${DOCUMENTS.join(', ')}.`);
  return withLock(root, lock, () => {
    mkdirSync(join(root, DIR), { recursive: true });
    const id = `DEC-${String(Math.max(0, ...usedNumbers(root)) + 1).padStart(2, '0')}`;
    const language = loadState(root)?.languages?.work ?? 'en';
    const filled = fillTemplate(readTemplate('DEC.md'), {
      doc_id: id, title: question, project: projectName(root), version: '0.1', date, language,
    }).split('\n');
    const head = filled.slice(0, frontMatterLength(filled));
    head.splice(head.length - 1, 0, `document: "${document}"`);
    if (due !== '') head.splice(head.length - 1, 0, `due: "${due}"`);
    const h1 = `# ${id}: ${question}`;
    writeAtomic(pathOf(root, id), `${head.join('\n')}\n\n${h1}\n${body({ question, why, known, unknown, recommendation, changeMind }, options)}`);
    return id;
  });
}

/** Read one decision file back: status, question, options and the decision box. */
function parse(root, id) {
  const path = pathOf(root, id);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No decision ${id}.`);
    throw err;
  }
  const lines = text.split('\n');
  const front = lines.slice(0, frontMatterLength(lines)).join('\n');
  const status = /^status:\s*(\S+)/m.exec(front)?.[1] ?? 'open';
  const document = /^document:\s*"?([^"\n]*)"?\s*$/m.exec(front)?.[1] ?? '';
  const due = /^due:\s*"?([^"\n]*)"?\s*$/m.exec(front)?.[1] ?? '';
  const q = lines.findIndex((l) => l === '## Question');
  const question = q >= 0 ? lines.slice(q + 1).find((l) => l.trim() !== '') ?? '' : '';
  const options = lines.flatMap((l) => {
    const m = /^### Option ([A-C]): (.*)$/.exec(l);
    return m ? [{ letter: m[1], label: m[2].trim() }] : [];
  });
  const box = lines.findIndex((l) => l.trim() === '> [!DECISION]');
  const decided = box >= 0 ? /^> Decided: (.*?)\. Option: (.*?)\. By: (.*?)\. Date: (.*?)\.$/.exec(lines[box + 1] ?? '') : null;
  return { path, text, lines, status, due, document, question: question.trim(), options, box, decided };
}

/**
 * Close an open decision with the owner's choice. `choice` is an option letter (A, B, C) or an option label.
 * The Decision box records the option, the owner and the date, and the status becomes `closed`.
 * @param {string} root project folder
 * @param {string} id DEC-nn
 * @param {{choice: string, date?: string, lockTries?: number, lockWaitMs?: number}} close
 */
export function closeDecision(root, id, { choice, date = localToday(), ...lock } = {}) {
  if (!ID.test(id)) throw new Error(`Invalid decision id: ${id}. Use DEC-01 style.`);
  const picked = typeof choice === 'string' ? line(choice) : '';
  if (picked === '') throw new Error('A closed decision needs the choice.');
  if (!DATE.test(date)) throw new Error('date must be YYYY-MM-DD.');
  withLock(root, lock, () => {
    const dec = parse(root, id);
    if (dec.status === 'closed') throw new Error(`${id} is already closed.`);
    const option = dec.options.find((o) => o.letter === picked.toUpperCase() || o.label.toLowerCase() === picked.toLowerCase());
    if (!option) {
      throw new Error(`${id} has no option "${picked}". Use ${dec.options.map((o) => o.letter).join(', ')} or an option label.`);
    }
    if (dec.box < 0) throw new Error(`${id} has no Decision box.`);
    const lines = [...dec.lines];
    lines[dec.box + 1] = `> Decided: yes. Option: ${option.letter} (${option.label}). By: owner. Date: ${date}.`;
    const front = frontMatterLength(lines);
    const at = lines.findIndex((l, i) => i < front && /^status:/.test(l));
    if (at >= 0) lines[at] = 'status: closed';
    writeAtomic(dec.path, lines.join('\n'));
  });
}

/**
 * Every decision in id order, or only the open ones.
 * @param {string} root project folder
 * @param {{open?: boolean}} [options]
 * @returns {{id: string, status: string, document: string, question: string, due: string, choice: string}[]}
 */
export function listDecisions(root, { open = false } = {}) {
  const all = usedNumbers(root).sort((a, b) => a - b).map((n) => {
    const id = `DEC-${String(n).padStart(2, '0')}`;
    const dec = parse(root, id);
    const choice = dec.status === 'closed' && dec.decided ? dec.decided[2] : '';
    return { id, status: dec.status, document: dec.document, question: dec.question, due: dec.due, choice };
  });
  return open ? all.filter((d) => d.status !== 'closed') : all;
}
