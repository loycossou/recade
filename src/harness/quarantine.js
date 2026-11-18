import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSlices } from '../project/slices.js';
import { registryNames } from '../project/touches.js';
import { loadState } from '../state.js';

/**
 * Flaky tests. A test that fails without a change of the code is not deleted and not left to turn the build red
 * for nothing: it is listed in the tracked file `tests/quarantine.json`, so CI sees it, and it runs in its own
 * non-blocking job that still reports. It has to be fixed before the increment of its slice closes (spec 12).
 *
 * @typedef {{test: string, reason: string, since: string, slice: string}} Entry
 */

const FILE = ['tests', 'quarantine.json'];
const SLICE_ID = /^S-\d{2}[a-z]?$/;
const INC_ID = /^INC-(\d+)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A problem with what the owner asked for (a duplicate, an unknown slice), not a tool failure. */
export class QuarantineInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuarantineInputError';
  }
}

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function line(value, what) {
  if (typeof value !== 'string' || value.trim() === '') throw new QuarantineInputError(`The ${what} must not be empty.`);
  if (/[\r\n\0]/.test(value)) throw new QuarantineInputError(`The ${what} must be one line.`);
  if (value.length > 300) throw new QuarantineInputError(`The ${what} is too long (300 characters at most).`);
  return value.trim();
}

function validDate(value) {
  const m = DATE.exec(value ?? '');
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * The entries of `tests/quarantine.json`. A missing file is an empty list. A file that is not valid is an error:
 * a quarantine nobody can read would let a flaky test hide.
 * @param {string} root project folder
 * @returns {Entry[]}
 */
export function listQuarantine(root) {
  let text;
  try {
    text = readFileSync(join(root, ...FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('tests/quarantine.json is not valid JSON.');
  }
  if (!Array.isArray(data)) throw new Error('tests/quarantine.json must be a list of {test, reason, since, slice}.');
  return data.map((e, i) => {
    const bad = (key) => new Error(`tests/quarantine.json entry ${i + 1}: "${key}" is missing or not valid.`);
    if (e === null || typeof e !== 'object') throw bad('test');
    if (typeof e.test !== 'string' || e.test.trim() === '') throw bad('test');
    if (typeof e.reason !== 'string' || e.reason.trim() === '') throw bad('reason');
    if (!validDate(e.since)) throw bad('since');
    if (typeof e.slice !== 'string' || !SLICE_ID.test(e.slice)) throw bad('slice');
    return { test: e.test, reason: e.reason, since: e.since, slice: e.slice };
  });
}

function save(root, entries) {
  mkdirSync(join(root, FILE[0]), { recursive: true });
  writeFileSync(join(root, ...FILE), `${JSON.stringify(entries, null, 2)}\n`);
}

/** The increment of each slice, from the sheets: `S-03` to `INC-2`. */
function incrementsOf(root) {
  const { status } = checkSlices(root);
  return { map: new Map(status.map((s) => [s.id, String(s.increment).trim().toUpperCase()])), status };
}

const incNumber = (inc) => {
  const m = INC_ID.exec(inc ?? '');
  return m === null ? null : Number(m[1]);
};

/**
 * Put a test in quarantine.
 * @param {string} root project folder: the one whose sheets name the slices
 * @param {{test: string, reason: string, slice: string, since?: string}} input `slice` is the slice whose increment owns the fix
 * @param {{now?: () => Date, dir?: string}} [options] `dir` holds `tests/quarantine.json`: the code repository (or its worktree) in a workspace, `root` otherwise
 * @returns {Entry}
 */
export function addQuarantine(root, input, { now = () => new Date(), dir = root } = {}) {
  const test = line(input?.test, 'test name');
  const reason = line(input?.reason, 'reason');
  if (typeof input?.slice !== 'string' || !SLICE_ID.test(input.slice)) throw new QuarantineInputError(`Invalid slice: ${JSON.stringify(input?.slice)}. Use S-03 style.`);
  const since = input.since ?? localDate(now());
  if (!validDate(since)) throw new QuarantineInputError(`Invalid date: ${JSON.stringify(since)}. Use YYYY-MM-DD.`);
  const entries = listQuarantine(dir);
  if (entries.some((e) => e.test === test)) throw new QuarantineInputError(`"${test}" is already quarantined.`);
  if (!incrementsOf(root).map.has(input.slice)) throw new QuarantineInputError(`${input.slice} has no sheet in slices/. Name the slice whose increment owns the fix.`);
  const entry = { test, reason, since, slice: input.slice };
  save(dir, [...entries, entry]);
  return entry;
}

/**
 * Take a test out of quarantine, because it was fixed.
 * @returns {Entry} the entry removed
 */
export function removeQuarantine(root, test) {
  const entries = listQuarantine(root);
  const at = entries.findIndex((e) => e.test === test);
  if (at < 0) throw new QuarantineInputError(`"${test}" is not quarantined.`);
  const [gone] = entries.splice(at, 1);
  save(root, entries);
  return gone;
}

/**
 * The increment in progress: the lowest one that still has a slice not done, or the last one when all are done.
 * @returns {string|null}
 */
function currentIncrement(status) {
  const numbers = (list) => list.map((s) => incNumber(String(s.increment).trim().toUpperCase())).filter((n) => n !== null);
  const open = numbers(status.filter((s) => s.status !== 'done'));
  const all = numbers(status);
  if (all.length === 0) return null;
  return `INC-${open.length > 0 ? Math.min(...open) : Math.max(...all)}`;
}

/**
 * Does any quarantined test outlive its increment? An entry is expired when the increment of its slice is older
 * than the current one, or when its slice has no sheet. The CI fails on it, so a flaky test cannot stay for ever.
 * @param {string} root project folder
 * @param {{inc?: string}} [options] the increment to judge against, by default the one in progress
 * @returns {{ok: boolean, expired: (Entry & {increment: string|null, why: string})[], current: string|null, count: number}}
 */
export function checkQuarantine(root, { inc, dir = root } = {}) {
  const entries = listQuarantine(dir ?? root);
  // No sheets to read (a CI checkout of a code repository): the file is valid, and the increments are judged in the workspace.
  if (root === null) return { ok: true, expired: [], current: null, count: entries.length, standalone: true };
  const { map, status } = incrementsOf(root);
  const current = inc ?? currentIncrement(status);
  const now = incNumber(current);
  const expired = [];
  for (const e of entries) {
    const increment = map.get(e.slice) ?? null;
    if (increment === null) {
      expired.push({ ...e, increment, why: `${e.slice} has no sheet any more, so no increment owns the fix.` });
      continue;
    }
    const n = incNumber(increment);
    if (now !== null && n !== null && n < now) expired.push({ ...e, increment, why: `quarantined in ${increment}, and ${current} is the increment now.` });
  }
  return { ok: expired.length === 0, expired, current, count: entries.length };
}

/**
 * The quarantined tests that stop an increment from closing: those of its slices and of the earlier increments,
 * and those whose slice is unknown. A test of a later increment does not.
 * @returns {Entry[]}
 */
export function dueForIncrement(root, inc) {
  const { map } = incrementsOf(root);
  const limit = incNumber(inc);
  return listQuarantine(root).filter((e) => {
    const n = incNumber(map.get(e.slice));
    return n === null || limit === null || n <= limit;
  });
}


/**
 * The code repositories of a workspace that have a folder, each with the folder that holds its `tests/quarantine.json`.
 * A project with no registry is one repository with no name (the project folder).
 * @returns {{repo: string|null, dir: string}[]}
 */
export function quarantineDirs(root) {
  const names = registryNames(loadState(root) ?? {});
  if (names.length === 0) return [{ repo: null, dir: root }];
  return names.filter((n) => existsSync(join(root, 'repos', n))).map((n) => ({ repo: n, dir: join(root, 'repos', n) }));
}

/** The quarantined tests of every code repository of the workspace, each with its `repo`. */
export function listAllQuarantine(root) {
  return quarantineDirs(root).flatMap(({ repo, dir }) => listQuarantine(dir).map((e) => ({ ...e, repo })));
}

/** `dueForIncrement` across the repositories of the workspace. */
export function dueForIncrementAll(root, inc) {
  const { map } = incrementsOf(root);
  const limit = incNumber(inc);
  return listAllQuarantine(root).filter((e) => {
    const n = incNumber(map.get(e.slice));
    return n === null || limit === null || n <= limit;
  });
}
