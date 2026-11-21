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
  const theme = merge(defaults, custom);
  const problem = themeProblem(theme);
  if (problem) throw new Error(`design/theme.json: ${problem}`);
  return theme;
}

/** The style keys of a theme and their values when the theme has none: the look of the bundled default. */
export const STYLE_DEFAULTS = Object.freeze({ h1Rule: 1.5, calloutBar: 3, headerSeparator: ' \u00b7 ', tableRules: 'grid' });
const TABLE_RULES = ['grid', 'horizontal'];
const HEX6 = /^[0-9A-Fa-f]{6}$/;

/**
 * What is wrong with the style keys of a theme, in one line, or null. `style.h1Rule` is the width in points of the
 * rule under an H1 (0 to 6, 0 removes it), `style.calloutBar` the width of the bar on the left of a callout (0 to 12,
 * 0 removes it), `style.headerSeparator` the text between the parts of the running header (at most 8 characters, no
 * line break), `style.tableRules` `grid` (rules around every cell) or `horizontal` (rules between rows only), and
 * `color.chartFill` the fill of the Gantt bars and the Mermaid boxes (6 hex digits; without it, `color.accent`).
 * @param {any} theme
 * @returns {string|null}
 */
export function themeProblem(theme) {
  const style = theme?.style ?? {};
  if (!isObject(style)) return 'style must be an object';
  const width = (key, max) => {
    if (style[key] === undefined) return null;
    const v = style[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? null : `style.${key} must be a number of points from 0 to ${max}`;
  };
  const problem = width('h1Rule', 6) ?? width('calloutBar', 12);
  if (problem) return problem;
  const sep = style.headerSeparator;
  if (sep !== undefined && (typeof sep !== 'string' || sep.length > 8 || /[\r\n\t\f\v\u2028\u2029]/.test(sep))) {
    return 'style.headerSeparator must be a text of at most 8 characters, without a line break';
  }
  if (style.tableRules !== undefined && !TABLE_RULES.includes(style.tableRules)) return `style.tableRules must be one of ${TABLE_RULES.join(', ')}`;
  const fill = theme?.color?.chartFill;
  if (fill !== undefined && !HEX6.test(String(fill))) return 'color.chartFill must be 6 hex digits, without #';
  return null;
}

/**
 * The style keys of a theme, with the default of each missing key. Throws on an invalid value.
 * @param {any} theme
 * @returns {{h1Rule:number, calloutBar:number, headerSeparator:string, tableRules:'grid'|'horizontal'}}
 */
export function themeStyle(theme) {
  const problem = themeProblem(theme);
  if (problem) throw new Error(`theme: ${problem}`);
  return { ...STYLE_DEFAULTS, ...(theme?.style ?? {}) };
}

/** The fill of the charts (Gantt bars, Mermaid boxes): `color.chartFill`, else `color.accent`. */
export const chartFill = (theme) => theme?.color?.chartFill ?? theme?.color?.accent ?? '17C79A';

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
