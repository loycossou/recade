import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectName } from '../workspace/layout.js';
import { fillTemplate, localToday, readTemplate } from './template.js';
import { withLock as lockFile, writeAtomic } from './lockfile.js';

const FILE = ['intake', 'provisionals.md'];
const LOCK = ['intake', '.provisionals.lock'];
const ID = /^PRV-(\d{2,})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXAMPLE_NOTE = '<!-- replace the example rows -->';

const OPEN_COLUMNS = ['id', 'what', 'why', 'assumption', 'owner', 'due'];
const CLOSED_COLUMNS = ['id', 'what', 'value', 'closedOn', 'replacedIn'];

/** A table cell: one line, pipes escaped. */
const cell = (value) => String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim().replaceAll('|', '\\|');

/** Cells of a table row, unescaped. */
function cells(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll('\\|', '|'));
}

const rowLine = (values) => `| ${values.map(cell).join(' | ')} |`;

/** Where the table of the `## <heading>` section sits: first line and line count, or null. */
function tableRange(lines, heading) {
  const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (at === -1) return null;
  let start = -1;
  for (let i = at + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
    if (lines[i].startsWith('|')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = start;
  while (end < lines.length && lines[end].startsWith('|')) end++;
  return { start, end };
}

/** Records of one table, as objects keyed by `columns`. The header and the separator are skipped. */
function readRows(lines, heading, columns, status) {
  const range = tableRange(lines, heading);
  if (range === null) return [];
  return lines.slice(range.start + 2, range.end).map((line) => {
    const values = cells(line);
    const record = { status };
    columns.forEach((c, i) => { record[c] = values[i] ?? ''; });
    return record;
  });
}

/** Replace the data rows of one table. */
function writeRows(lines, heading, rows) {
  const range = tableRange(lines, heading);
  if (range === null) throw new Error(`intake/provisionals.md has no "## ${heading}" table.`);
  lines.splice(range.start + 2, range.end - range.start - 2, ...rows.map(rowLine));
}

/**
 * The register template with its example rows removed.
 * @param {string} text a filled `provisionals.md` template
 * @returns {string}
 */
export function emptyRegister(text) {
  const lines = text.split('\n').filter((l, i, all) => !(l === EXAMPLE_NOTE || (l === '' && all[i - 1] === EXAMPLE_NOTE)));
  for (const heading of ['Open', 'Closed']) writeRows(lines, heading, []);
  return lines.join('\n');
}

function load(root) {
  const path = join(root, ...FILE);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    text = emptyRegister(fillTemplate(readTemplate('provisionals.md'), {
      project: projectName(root), version: '0.1', date: localToday(), language: 'en',
    }));
  }
  const lines = text.split('\n');
  const open = readRows(lines, 'Open', OPEN_COLUMNS, 'open');
  const closed = readRows(lines, 'Closed', CLOSED_COLUMNS, 'closed');
  return { path, lines, open, closed };
}

function save({ path, lines }, open, closed) {
  writeRows(lines, 'Open', open.map((r) => OPEN_COLUMNS.map((c) => r[c])));
  writeRows(lines, 'Closed', closed.map((r) => CLOSED_COLUMNS.map((c) => r[c])));
  writeAtomic(path, lines.join('\n'));
}

const withLock = (root, lock, fn) => lockFile(root, LOCK, lock, fn, 'The provisional register');

const required = (fields, key) => {
  const value = fields?.[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required.`);
  return value.trim();
};

/**
 * Record a provisional value as open and return its id (PRV-01, PRV-02, ...). Ids are never reused,
 * closed records count.
 * @param {string} root project folder
 * @param {{what: string, why: string, assumption: string, owner: string, due?: string}} fields
 * @param {{lockTries?: number, lockWaitMs?: number}} [lock]
 * @returns {string}
 */
export function openProvisional(root, fields, lock = {}) {
  const record = {
    what: required(fields, 'what'),
    why: required(fields, 'why'),
    assumption: required(fields, 'assumption'),
    owner: required(fields, 'owner'),
    due: (fields.due ?? '').trim(),
  };
  if (record.due !== '' && !DATE.test(record.due)) throw new Error('due must be YYYY-MM-DD.');
  return withLock(root, lock, () => {
    const reg = load(root);
    const last = [...reg.open, ...reg.closed].reduce((m, r) => Math.max(m, Number(ID.exec(r.id)?.[1] ?? 0)), 0);
    const id = `PRV-${String(last + 1).padStart(2, '0')}`;
    save(reg, [...reg.open, { id, ...record }], reg.closed);
    return id;
  });
}

/**
 * Close an open provisional with the real value. The record moves to the Closed table.
 * @param {string} root project folder
 * @param {string} id PRV-nn
 * @param {{value: string, replacedIn?: string, date?: string, lockTries?: number, lockWaitMs?: number}} close
 */
export function closeProvisional(root, id, { value, replacedIn = '', date = localToday(), ...lock } = {}) {
  if (!ID.test(id)) throw new Error(`Invalid provisional id: ${id}. Use PRV-01 style.`);
  const real = typeof value === 'string' ? value.trim() : '';
  if (real === '') throw new Error('A closed provisional needs the real value.');
  if (!DATE.test(date)) throw new Error('date must be YYYY-MM-DD.');
  withLock(root, lock, () => {
    const reg = load(root);
    const found = reg.open.find((r) => r.id === id);
    if (!found) throw new Error(`No open provisional ${id}.`);
    const closed = { id, what: found.what, value: real, closedOn: date, replacedIn: replacedIn.trim() };
    save(reg, reg.open.filter((r) => r !== found), [...reg.closed, closed]);
  });
}

/**
 * Every provisional, open ones first in file order then closed ones, or only the open ones.
 * @param {string} root project folder
 * @param {{open?: boolean}} [options]
 */
export function listProvisionals(root, { open = false } = {}) {
  const { open: o, closed } = load(root);
  return open ? o : [...o, ...closed].sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
}
