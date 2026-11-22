import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

export const MODES = ['scratch', 'from-docs', 'adopt'];

const statePath = (projectDir) => join(projectDir, 'recade', 'state.yaml');

/**
 * Build the initial project state. Voice and languages are copied from the user config.
 * @param {string} _projectDir
 * @param {{mode: 'scratch'|'from-docs'|'adopt'}} options
 * @param {{voice: string, languages: object}} config
 */
export function initState(_projectDir, { mode }, config) {
  if (!MODES.includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Use ${MODES.join(', ')}.`);
  }
  return {
    version: 1,
    mode,
    phase: 0,
    gates: {},
    next_action: null,
    voice: config.voice,
    languages: structuredClone(config.languages),
    lots: [],
    slicing: 'mixed',
  };
}

/**
 * Read `<projectDir>/recade/state.yaml`. Returns null when the file is absent.
 * Throws an Error when the file is not valid YAML.
 * @param {string} projectDir
 * @returns {object|null}
 */
export function loadState(projectDir) {
  const path = statePath(projectDir);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let data;
  try {
    data = parse(text);
  } catch {
    throw new Error(`state.yaml is not valid YAML. Fix or delete ${path}.`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`state.yaml is not valid YAML. Fix or delete ${path}.`);
  }
  return data;
}

/**
 * Write `<projectDir>/recade/state.yaml`, creating the directory when needed. The file is replaced in one step (a
 * temporary file, then a rename): another process that reads the state while this one writes sees the old text or the
 * new one, never an empty or half written file.
 * @param {string} projectDir
 * @param {object} state
 */
export function saveState(projectDir, state) {
  mkdirSync(join(projectDir, 'recade'), { recursive: true });
  const path = statePath(projectDir);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, stringify(state));
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is the day of the first delivered slice still to record? True when the project has a state and it holds no
 * `first_slice_done:` yet. A state that cannot be read says false: the slice moves all the same.
 * @param {string} projectDir
 */
export function firstSliceDue(projectDir) {
  try {
    const state = loadState(projectDir);
    return state !== null && !DATE.test(String(state.first_slice_done ?? ''));
  } catch {
    return false;
  }
}

/**
 * Record `first_slice_done: <date>` in the state, the first time a slice becomes done. Never overwrites a date
 * already there. Returns true when it wrote the state.
 * @param {string} projectDir
 * @param {string} date YYYY-MM-DD
 */
export function noteFirstSliceDone(projectDir, date) {
  if (typeof date !== 'string' || !DATE.test(date)) throw new Error(`Invalid date: ${date}. Use YYYY-MM-DD.`);
  if (!firstSliceDue(projectDir)) return false;
  saveState(projectDir, { ...loadState(projectDir), first_slice_done: date });
  return true;
}
