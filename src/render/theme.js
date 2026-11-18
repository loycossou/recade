import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plugin root: the repository root. */
export const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const RENDER_DIR = join(PLUGIN_ROOT, 'render');
export const FONT_DIR = join(RENDER_DIR, 'fonts');

/**
 * A language code reduced to its lower-case primary subtag: `FR` and `fr-CA` give `fr`. Anything that is not a
 * language code (empty, a number, free text) gives `en`.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLanguage(value) {
  const m = /^([a-z]{2,3})(?:[-_][a-z0-9]+)*$/.exec(String(value ?? '').trim().toLowerCase());
  return m ? m[1] : 'en';
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge of plain objects: `over` wins, arrays and scalars are replaced. Returns a new object. */
function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Design tokens: the bundled defaults, deep-merged with `<projectRoot>/design/theme.json` when present.
 * @param {string|null} projectRoot
 * @returns {any}
 */
export function loadTheme(projectRoot) {
  const defaults = readJson(join(RENDER_DIR, 'themes', 'default.json'));
  if (!projectRoot) return defaults;
  const file = join(projectRoot, 'design', 'theme.json');
  if (!existsSync(file)) return defaults;
  let custom;
  try {
    custom = readJson(file);
  } catch (err) {
    const reason = String(err?.message ?? err).split('\n')[0];
    throw new Error(`design/theme.json is not valid JSON: ${reason}`);
  }
  if (!isObject(custom)) throw new Error('design/theme.json is not valid JSON: the top level must be an object');
  return merge(defaults, custom);
}

/**
 * Every user-visible label of a rendered document. The code is normalised (`FR`, `fr-CA` give `fr`); an unknown
 * language falls back to `en`.
 * @param {string} [lang]
 * @returns {Record<string,string>}
 */
export function loadLabels(lang) {
  const code = normalizeLanguage(lang);
  return readJson(join(RENDER_DIR, 'labels', `${existsSync(join(RENDER_DIR, 'labels', `${code}.json`)) ? code : 'en'}.json`));
}
