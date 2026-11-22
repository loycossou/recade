import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { frontMatterLength } from '../frontmatter-lines.js';
import { SECOND_OPINION_MODELS } from '../models.js';

/** @typedef {{model: string, effort: string}} Lane */
/** @typedef {{agents: Record<string, {standard: Lane, sensitive: Lane}>, families: Record<string, string[]>, second_opinion?: {same_family?: 'error'|'warn'}}} Models */

const LANES = ['standard', 'sensitive'];
const EFFORTS = ['low', 'medium', 'high'];
const KEYS = ['model', 'effort', 'sensitive_model', 'sensitive_effort'];
const SAME_FAMILY = ['error', 'warn'];

/**
 * The family a model id or alias belongs to, or undefined when `families` does not list it.
 * @param {Models} models
 * @param {string} model
 * @returns {string|undefined}
 */
export function familyOf(models, model) {
  return Object.keys(models.families ?? {}).find((family) => models.families[family].includes(model));
}

/**
 * Check a parsed `models.yaml`. Returns one line per problem, so an empty list means the table is valid.
 * Rules: both lanes for every agent, no Haiku, no unknown model, efforts low (test-runner only), medium or high,
 * and the second opinion from another family than the reviewer in each lane, unless `second_opinion.same_family` is
 * `warn` (then `modelWarnings` reports it instead).
 * @param {Models} models
 * @returns {string[]}
 */
export function validateModels(models) {
  const problems = [];
  if (models === null || typeof models !== 'object' || models.agents === null || typeof models.agents !== 'object') {
    return ['agents: missing'];
  }
  for (const [name, lanes] of Object.entries(models.agents)) {
    for (const lane of LANES) {
      const entry = lanes?.[lane];
      if (entry === undefined || entry === null || typeof entry.model !== 'string' || typeof entry.effort !== 'string') {
        problems.push(`${name}: lane ${lane} needs a model and an effort`);
        continue;
      }
      if (/haiku/i.test(entry.model)) problems.push(`${name} ${lane}: haiku is not allowed, the floor is sonnet medium`);
      else if (familyOf(models, entry.model) === undefined) problems.push(`${name} ${lane}: model ${entry.model} is in no family`);
      if (!EFFORTS.includes(entry.effort)) problems.push(`${name} ${lane}: effort ${entry.effort} is not allowed, use medium or high`);
      else if (entry.effort === 'low' && name !== 'test-runner') problems.push(`${name} ${lane}: effort low is only for test-runner`);
    }
  }
  const sameFamily = models.second_opinion?.same_family ?? 'error';
  if (!SAME_FAMILY.includes(sameFamily)) problems.push(`second_opinion.same_family: ${sameFamily} is not allowed, use error or warn`);
  else if (sameFamily === 'error') problems.push(...sameFamilyLanes(models));
  return problems;
}

/**
 * One line per lane where the second opinion shares the reviewer's family.
 * @param {Models} models
 * @returns {string[]}
 */
function sameFamilyLanes(models) {
  const lines = [];
  for (const lane of LANES) {
    const second = models.agents?.['second-opinion']?.[lane]?.model;
    const reviewer = models.agents?.reviewer?.[lane]?.model;
    if (second === undefined || reviewer === undefined) continue;
    const family = familyOf(models, second);
    if (family !== undefined && family === familyOf(models, reviewer)) {
      lines.push(`second-opinion ${lane}: same model family (${family}) as the reviewer`);
    }
  }
  return lines;
}

/**
 * What a valid table allows but should be said: the second opinion in the reviewer's family when
 * `second_opinion.same_family` is `warn`. Returns one line per lane, empty when there is nothing to say.
 * @param {Models} models
 * @returns {string[]}
 */
export function modelWarnings(models) {
  if (models?.second_opinion?.same_family !== 'warn') return [];
  return sameFamilyLanes(models).map((l) => `${l}, allowed by second_opinion.same_family: warn`);
}

/**
 * Read and validate `models.yaml`.
 * @param {string} path
 * @returns {Models}
 * @throws {Error} with one line per problem
 */
export function loadModels(path) {
  let models;
  try {
    models = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${String(err.message).split('\n')[0]}`);
  }
  const problems = validateModels(models);
  if (problems.length > 0) throw new Error(`${path}:\n${problems.join('\n')}`);
  return models;
}

/**
 * The agents that run with other values in the sensitive lane, as `syncAgents` writes them in `sensitive_model` and
 * `sensitive_effort`. `/slice` dispatches these agents with those values when the slice is in the sensitive lane.
 * @param {Models} models
 * @returns {{agent: string, model: string, effort: string}[]}
 */
export function sensitiveLane(models) {
  return Object.entries(models.agents)
    .filter(([, e]) => e.sensitive.model !== e.standard.model || e.sensitive.effort !== e.standard.effort)
    .map(([agent, e]) => ({ agent, model: e.sensitive.model, effort: e.sensitive.effort }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

/**
 * Write `model` and `effort` (standard lane) into the front matter of every `<agent>.md` in `dir`, plus
 * `sensitive_model` and `sensitive_effort` when the sensitive lane differs. Stale sensitive keys are removed.
 * With `check`, nothing is written. A folder with no agent files is fine.
 * @param {string} dir the agents folder
 * @param {Models} models
 * @param {{check?: boolean}} [options]
 * @returns {{changed: string[]}} the files that were (or, with `check`, would be) changed
 * @throws {Error} with one line per file that has no front matter or no entry in `models`
 */
export function syncAgents(dir, models, { check = false } = {}) {
  const changed = [];
  const errors = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const path = join(dir, file);
    const name = basename(file, '.md');
    const original = readFileSync(path, 'utf8');
    const lines = original.split('\n');
    const end = frontMatterLength(lines) - 1;
    if (end < 0) {
      errors.push(`${file}: no front matter`);
      continue;
    }
    const entry = models.agents[name];
    if (entry === undefined) {
      errors.push(`${file}: no agent "${name}" in models.yaml`);
      continue;
    }
    const wanted = [`model: ${entry.standard.model}`, `effort: ${entry.standard.effort}`];
    if (entry.sensitive.model !== entry.standard.model || entry.sensitive.effort !== entry.standard.effort) {
      wanted.push(`sensitive_model: ${entry.sensitive.model}`, `sensitive_effort: ${entry.sensitive.effort}`);
    }
    const front = lines.slice(1, end);
    const isManaged = (l) => KEYS.some((k) => l.startsWith(`${k}:`));
    const first = front.findIndex(isManaged);
    const kept = front.filter((l) => !isManaged(l));
    kept.splice(first < 0 ? kept.length : first, 0, ...wanted);
    const next = ['---', ...kept, ...lines.slice(end)].join('\n');
    if (next === original) continue;
    changed.push(file);
    if (!check) writeFileSync(path, next);
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return { changed };
}

/**
 * The table with the owner's choice for the second opinion (`models.second_opinion` of the user config): `fable` puts
 * both lanes of `second-opinion` on Fable 5.2, another family than the reviewer, so the family check passes with no
 * warning; `opus`, or no choice, returns the table as it is. The effort stays.
 * @param {Models} models
 * @param {string|undefined} choice
 * @returns {Models}
 */
export function withSecondOpinion(models, choice) {
  if (choice !== 'fable' || models?.agents?.['second-opinion'] === undefined) return models;
  const next = structuredClone(models);
  for (const lane of LANES) next.agents['second-opinion'][lane].model = SECOND_OPINION_MODELS.fable;
  return next;
}

/**
 * The second-opinion choice an installed copy holds: `fable` when `<dir>/second-opinion.md` runs on Fable 5.2,
 * `opus` otherwise (also when the file is missing). Verify reads the project copy, which CI reads too, not the user
 * config of one machine.
 * @param {string} dir the agents folder of a project
 * @returns {'opus'|'fable'}
 */
export function secondOpinionOf(dir) {
  const path = join(dir, 'second-opinion.md');
  if (!existsSync(path)) return 'opus';
  const lines = readFileSync(path, 'utf8').split('\n');
  const front = lines.slice(1, Math.max(1, frontMatterLength(lines) - 1));
  const model = /^model:\s*(\S+)\s*$/.exec(front.find((l) => l.startsWith('model:')) ?? '')?.[1];
  return model === SECOND_OPINION_MODELS.fable ? 'fable' : 'opus';
}

/**
 * The text of an agent file with the `model:` line of its front matter set to `model`. A text with no front matter or
 * no `model:` line is returned as it is.
 * @param {string} text
 * @param {string} model
 * @returns {string}
 */
export function withModelLine(text, model) {
  const lines = text.split('\n');
  const end = frontMatterLength(lines) - 1;
  const at = lines.findIndex((l, i) => i > 0 && i < end && l.startsWith('model:'));
  if (at < 0) return text;
  lines[at] = `model: ${model}`;
  return lines.join('\n');
}
