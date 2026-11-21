import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectName } from '../workspace/layout.js';
import { loadState } from '../state.js';
import { withLock as lockFile, writeAtomic } from './lockfile.js';
import { localToday } from './template.js';

// The register of what the team decided itself: one line for each question that is reversible, technical or a convention.
// The owner reads it as one list at the gate. A line the owner challenges points to the DEC that replaces it.

const DIR = 'decisions';
const FILE = 'TEAM.md';
const LOCK = [DIR, '.decisions.lock'];
const ID = /^TD-\d{2,}$/;
const DEC_ID = /^DEC-\d{2,}$/;
// A question of the art direction is recorded under D1: the DEC that a challenge opens takes one of the DEC documents.
const DOCUMENTS = ['D1', 'D2', 'D3', 'STACK', 'PLAN', 'BIBLE'];
const HEAD = ['Ref', 'Document', 'Question', 'Decided', 'Why', 'Status'];

const withLock = (root, lock, fn) => lockFile(root, LOCK, lock, fn, 'The decisions folder');
const line = (value) => String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
const cell = (value) => line(value).replaceAll('|', '\\|');
const pathOf = (root) => join(root, DIR, FILE);

const required = (value, name) => {
  const text = typeof value === 'string' ? line(value) : '';
  if (text === '') throw new Error(`${name} is required.`);
  return text;
};

/** The cells of a table row, the escaped pipes put back. */
function splitRow(text) {
  const cells = [];
  let current = '';
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      current += '|';
      i++;
    } else if (text[i] === '|') {
      cells.push(current.trim());
      current = '';
    } else current += text[i];
  }
  return cells;
}

/** The entries of the register, in id order. A missing register has none. */
function read(root) {
  const path = pathOf(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((l) => {
    if (!l.startsWith('| TD-')) return [];
    const [id, document, question, decided, why, status] = splitRow(l);
    const m = /^challenged \((DEC-\d{2,})\)$/.exec(status ?? '');
    return [{ id, document, question, decided, why, status: m ? 'challenged' : status, dec: m ? m[1] : '' }];
  });
}

function write(root, entries, date) {
  const language = loadState(root)?.languages?.work ?? 'en';
  const rows = entries.map((e) => `| ${[e.id, e.document, e.question, e.decided, e.why, e.status === 'challenged' ? `challenged (${e.dec})` : e.status].map(cell).join(' | ')} |`);
  const text = [
    '---', 'doc_id: "TEAM-DECISIONS"', 'title: "Decided by the team"', `project: "${projectName(root).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    'version: "0.1"', `date: "${date}"`, 'status: Register', `language: "${language}"`, '---', '',
    '# Decided by the team', '',
    'Each line is a question the team decided itself, because it is reversible, a technical detail or a convention. The owner reads this list once and challenges any line: a challenged line becomes a DEC.', '',
    `| ${HEAD.join(' | ')} |`, `|${HEAD.map(() => '---').join('|')}|`, ...rows, '',
  ].join('\n');
  mkdirSync(join(root, DIR), { recursive: true });
  writeAtomic(pathOf(root), text);
}

/**
 * Record a question the team decided itself. Returns its id (TD-01, TD-02, ...). Ids are never reused.
 * @param {string} root project folder
 * @param {{document: string, question: string, decided: string, why: string}} fields
 * @param {{date?: string, lockTries?: number, lockWaitMs?: number}} [extra]
 * @returns {string}
 */
export function addTeamDecision(root, fields, { date = localToday(), ...lock } = {}) {
  const question = required(fields?.question, 'question');
  const decided = required(fields?.decided, 'decided');
  const why = required(fields?.why, 'why');
  const document = typeof fields?.document === 'string' ? fields.document.trim() : '';
  if (!DOCUMENTS.includes(document)) throw new Error(`document must be one of ${DOCUMENTS.join(', ')}.`);
  return withLock(root, lock, () => {
    const entries = read(root);
    const id = `TD-${String(Math.max(0, ...entries.map((e) => Number(e.id.slice(3)))) + 1).padStart(2, '0')}`;
    write(root, [...entries, { id, document, question, decided, why, status: 'decided', dec: '' }], date);
    return id;
  });
}

/**
 * Mark a team decision as challenged by the owner: the DEC `dec` replaces it.
 * @param {string} root project folder
 * @param {string} id TD-nn
 * @param {{dec: string, date?: string, lockTries?: number, lockWaitMs?: number}} change
 */
export function challengeTeamDecision(root, id, { dec, date = localToday(), ...lock } = {}) {
  if (!ID.test(id)) throw new Error(`Invalid team decision id: ${id}. Use TD-01 style.`);
  if (!DEC_ID.test(dec ?? '')) throw new Error(`Invalid decision id: ${dec}. Use DEC-01 style.`);
  withLock(root, lock, () => {
    const entries = read(root);
    const entry = entries.find((e) => e.id === id);
    if (entry === undefined) throw new Error(`No team decision ${id}.`);
    if (entry.status === 'challenged') throw new Error(`${id} is already challenged.`);
    if (!existsSync(join(root, DIR, `${dec}.md`))) throw new Error(`No decision ${dec}.`);
    entry.status = 'challenged';
    entry.dec = dec;
    write(root, entries, date);
  });
}

/**
 * Every team decision in id order.
 * @param {string} root project folder
 * @returns {{id: string, document: string, question: string, decided: string, why: string, status: string, dec: string}[]}
 */
export function listTeamDecisions(root) {
  return read(root);
}
