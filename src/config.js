import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { configDir } from './paths.js';
import { SECOND_OPINION_CHOICES, WRITER_CHOICES, isSecondOpinionChoice, isWriterChoice } from './models.js';
import { DECK_CHOICES, parseExtras } from './deliverables.js';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  started: false,
  languages: Object.freeze({
    chat: 'en',
    work: 'en',
    deliverables: Object.freeze(['en']),
    code: 'en',
    product_ui: Object.freeze(['en']),
  }),
  github_owner: null,
  projects_root: '~/projects',
  voice: 'randall-munroe',
  models: Object.freeze({ writer: 'opus', second_opinion: 'opus' }),
  deliverables: Object.freeze({ extras: Object.freeze([]), pdf: false, deck: 'ask' }),
  // The owner's stack preferences: for each language, the framework the stack analyst puts first when it fits.
  stack: Object.freeze({ prefer: Object.freeze({ php: 'symfony' }) }),
});

const PREFER_KEY = /^[a-z][a-z0-9+#.-]*$/;
const PREFER_VALUE = /^[A-Za-z0-9][A-Za-z0-9 .+#/-]*$/;

/**
 * Parse `php=symfony,python=django` into a map of preferences. `none` (or an empty text) clears them all.
 * Throws an Error with a one-line message on invalid input.
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parsePreferences(raw) {
  const text = raw.trim();
  if (text === '' || text.toLowerCase() === 'none') return {};
  const out = {};
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const at = part.indexOf('=');
    const key = (at < 0 ? '' : part.slice(0, at)).trim().toLowerCase();
    const value = (at < 0 ? '' : part.slice(at + 1)).trim();
    if (!PREFER_KEY.test(key) || !PREFER_VALUE.test(value)) {
      throw new Error(`Invalid preference: ${part}. Write language=framework, for example php=symfony,python=django, or none.`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * The owner's stack preferences of a config, one map of language to framework. A value `none` is no preference.
 * @param {object} config
 * @returns {Record<string, string>}
 */
export function stackPreferences(config) {
  const prefer = config?.stack?.prefer;
  if (!isMapping(prefer)) return {};
  return Object.fromEntries(Object.entries(prefer).filter(([k, v]) => PREFER_KEY.test(k) && typeof v === 'string' && PREFER_VALUE.test(v.trim()) && v.trim().toLowerCase() !== 'none').map(([k, v]) => [k, v.trim()]));
}

const LANGUAGE_CODE = /^[a-z]{2}$/;
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const LIST_KEYS = new Set(['languages.deliverables', 'languages.product_ui']);
const LANGUAGE_KEYS = new Set([
  'languages.chat',
  'languages.work',
  'languages.deliverables',
  'languages.code',
  'languages.product_ui',
]);

/** @param {Record<string,string|undefined>} env */
export function configPath(env) {
  return join(configDir(env), 'config.yaml');
}

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isMapping(v) && isMapping(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}

/**
 * Read the user config. A missing file gives the defaults without a warning.
 * @param {Record<string,string|undefined>} env
 * @returns {{config: object, warnings: string[]}}
 */
export function loadConfig(env) {
  const path = configPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { config: structuredClone(DEFAULT_CONFIG), warnings: [] };
    throw err;
  }
  let data;
  try {
    data = parse(text);
  } catch {
    data = undefined;
  }
  if (data === null) return { config: structuredClone(DEFAULT_CONFIG), warnings: [] };
  if (!isMapping(data)) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warnings: [`config.yaml is not valid YAML; using defaults. Fix or delete ${path}.`],
    };
  }
  const config = merge(DEFAULT_CONFIG, data);
  // The preferences of the file replace the shipped ones: a cleared map stays cleared.
  if (isMapping(data.stack) && isMapping(data.stack.prefer)) config.stack.prefer = structuredClone(data.stack.prefer);
  return { config, warnings: [] };
}

/**
 * Write the user config, creating the directory when needed.
 * @param {object} config
 * @param {Record<string,string|undefined>} env
 */
export function saveConfig(config, env) {
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(configPath(env), stringify(config));
}

function splitList(raw) {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Return a copy of `config` with the dotted `key` set from the raw CLI string.
 * Throws an Error with a one-line message on invalid input.
 * @param {object} config
 * @param {string} key
 * @param {string} raw
 * @returns {object}
 */
export function setConfigValue(config, key, raw) {
  const path = key.split('.');
  if (key === 'stack.prefer' || key.startsWith('stack.prefer.')) return setPreference(config, path.slice(2).join('.'), raw);
  let defaultValue = DEFAULT_CONFIG;
  for (const part of path) {
    if (!isMapping(defaultValue) || !Object.hasOwn(defaultValue, part)) {
      throw new Error(`Unknown key: ${key}`);
    }
    defaultValue = defaultValue[part];
  }
  if (key === 'version') throw new Error('version cannot be changed.');
  if (isMapping(defaultValue)) {
    throw new Error(`${key} has sub-keys. Set one of them, for example ${key}.chat.`);
  }

  let value;
  if (key === 'deliverables.extras') {
    value = parseExtras(raw);
  } else if (LIST_KEYS.has(key)) {
    value = splitList(raw);
    if (value.length === 0) throw new Error(`${key} needs at least one language code.`);
  } else if (typeof defaultValue === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw new Error(`${key} must be true or false.`);
    value = raw === 'true';
  } else {
    value = raw.trim();
    if (key === 'voice' && value === '') throw new Error('voice cannot be empty.');
    if (key === 'models.writer' && !isWriterChoice(value)) throw new Error(`models.writer must be ${WRITER_CHOICES.join(' or ')}.`);
    if (key === 'deliverables.deck' && !DECK_CHOICES.includes(value)) throw new Error(`deliverables.deck must be ${DECK_CHOICES.join(', ')}.`);
    if (key === 'models.second_opinion' && !isSecondOpinionChoice(value)) throw new Error(`models.second_opinion must be ${SECOND_OPINION_CHOICES.join(' or ')}.`);
  }
  if (LANGUAGE_KEYS.has(key)) {
    const tags = LIST_KEYS.has(key);
    for (const code of [].concat(value)) {
      if (!(tags ? LANGUAGE_TAG : LANGUAGE_CODE).test(code)) {
        throw new Error(tags
          ? `Invalid language code: ${code}. Use a language tag such as en, fr or pt-BR.`
          : `Invalid language code: ${code}. Use two lowercase letters, for example en.`);
      }
    }
  }

  const next = structuredClone(config);
  let target = next;
  for (const part of path.slice(0, -1)) {
    if (!isMapping(target[part])) target[part] = {};
    target = target[part];
  }
  target[path.at(-1)] = value;
  return next;
}

/**
 * `stack.prefer` takes the whole map (`php=symfony,python=django`, or `none`). `stack.prefer.<language>` takes one
 * framework, and `none` removes that language.
 */
function setPreference(config, language, raw) {
  const next = structuredClone(config);
  if (!isMapping(next.stack)) next.stack = {};
  if (language === '') {
    next.stack.prefer = parsePreferences(raw);
    return next;
  }
  const lang = language.toLowerCase();
  if (!PREFER_KEY.test(lang)) throw new Error(`Invalid language: ${language}. Use lower-case letters, for example php.`);
  const prefer = isMapping(next.stack.prefer) ? { ...next.stack.prefer } : {};
  if (raw.trim().toLowerCase() === 'none' || raw.trim() === '') delete prefer[lang];
  else Object.assign(prefer, parsePreferences(`${lang}=${raw}`));
  next.stack.prefer = prefer;
  return next;
}
