import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { configDir } from './paths.js';
import { WRITER_CHOICES, isWriterChoice } from './models.js';
import { parseExtras } from './deliverables.js';

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
  models: Object.freeze({ writer: 'fable' }),
  deliverables: Object.freeze({ extras: Object.freeze([]) }),
});

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
  return { config: merge(DEFAULT_CONFIG, data), warnings: [] };
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
