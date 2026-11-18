import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { frontMatterLength } from '../frontmatter-lines.js';

/** @typedef {{file:string,line:number,column:number,rule:string,severity:'error'|'warn',message:string}} Finding */

/** The H2 sections of a doctrine, in order (spec section 6). */
export const DOCTRINE_SECTIONS = [
  'Why this profile for this project',
  'Convictions (each with its source)',
  'Working rules (imperative, verifiable)',
  'Review checklist',
  'What they refuse',
  'How they settle a disagreement',
  'Limits (what not to ask them)',
];

const FRONT_KEYS = ['role', 'inspired_by', 'model', 'effort'];
const MIN_SOURCES = 3;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const IDENTITY = /\b(?:I am|I['\u2019]m|Je suis)\b/i;

const isText = (v) => typeof v === 'string' && v.trim() !== '';

/** True when `value` is a real calendar date written YYYY-MM-DD (or a valid Date object). */
function isDate(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  const m = typeof value === 'string' ? DATE.exec(value) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const isHttpUrl = (value) => {
  if (!isText(value)) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** Blank out HTML comments, keeping every newline so line numbers stay true. */
const blankComments = (text) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * Check one doctrine file (spec section 6): front matter, sources, sections, and no claim of identity.
 * @param {string} text the file content
 * @param {string} file the file path, used in the findings and to match `role`
 * @returns {Finding[]}
 */
export function validateDoctrine(text, file) {
  /** @type {Finding[]} */
  const findings = [];
  const add = (rule, line, message, severity = 'error') => findings.push({ file, line, column: 1, rule, severity, message });
  const lines = text.split('\n');
  const fmLen = frontMatterLength(lines);
  if (fmLen === 0) {
    add('doctrine-front', 1, 'The file must open with a front matter block (role, inspired_by, model, effort, sources).');
  }
  let meta = null;
  if (fmLen > 0) {
    try {
      meta = parse(lines.slice(1, fmLen - 1).join('\n'));
    } catch {
      add('doctrine-front', 1, 'The front matter is not valid YAML.');
    }
    if (meta === null && findings.length === 0) meta = {};
    else if (meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
      add('doctrine-front', 1, 'The front matter must be a YAML mapping.');
      meta = null;
    }
  }
  const lineOf = (key) => {
    const at = lines.slice(0, Math.max(fmLen, 1)).findIndex((l) => l.startsWith(`${key}:`));
    return at >= 0 ? at + 1 : 1;
  };
  if (meta) {
    for (const key of FRONT_KEYS) {
      if (!isText(meta[key])) add('doctrine-front', lineOf(key), `The front matter key \`${key}\` is missing or empty.`);
    }
    const expected = basename(file).replace(/\.md$/, '');
    if (isText(meta.role) && meta.role !== expected) {
      add('doctrine-role', lineOf('role'), `The role \`${meta.role}\` does not match the file name \`${expected}.md\`.`);
    }
    const at = lineOf('sources');
    const sources = Array.isArray(meta.sources) ? meta.sources : [];
    if (sources.length < MIN_SOURCES) {
      add('doctrine-sources', at, `A doctrine needs at least ${MIN_SOURCES} sources. This one lists ${sources.length}.`);
    }
    sources.forEach((s, i) => {
      const n = i + 1;
      if (s === null || typeof s !== 'object') {
        add('doctrine-source', at, `Source ${n} must have a title, a url and an accessed date.`);
        return;
      }
      if (!isText(s.title)) add('doctrine-source', at, `Source ${n} has no title.`);
      if (!isHttpUrl(s.url)) add('doctrine-source', at, `Source ${n} needs an http or https url.`);
      if (!isDate(s.accessed)) add('doctrine-source', at, `Source ${n} has a bad accessed date. Use a real date as YYYY-MM-DD.`);
    });
  }
  const clean = blankComments(text).split('\n');
  const headings = new Set();
  let fenced = false;
  for (let i = Math.max(fmLen, 0); i < clean.length; i++) {
    const line = clean[i];
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) headings.add(h[1]);
  }
  for (const section of DOCTRINE_SECTIONS) {
    if (!headings.has(section)) add('doctrine-section', Math.max(fmLen, 1), `The section "## ${section}" is missing.`);
  }
  for (let i = 0; i < clean.length; i++) {
    const inFront = i < fmLen;
    if (!inFront && !/^\s*>/.test(clean[i]) && IDENTITY.test(clean[i])) {
      add('doctrine-identity', i + 1, 'A doctrine says "inspired by", never "I am", "I\u2019m" or "Je suis". Remove the claim of identity.');
    }
    if (clean[i].includes('{{')) add('doctrine-placeholder', i + 1, 'A template placeholder is still in the file. Fill it.');
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * Check every `team/*.md` of a project except `team/roster.md`.
 * @param {string} root the project folder
 * @returns {Finding[]}
 */
export function checkTeam(root) {
  const dir = join(root, 'team');
  const names = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'roster.md').sort()
    : [];
  if (names.length === 0) {
    return [{
      file: 'team', line: 1, column: 1, rule: 'team-empty', severity: 'error',
      message: 'There is no doctrine in team/. Write one team/<role>.md per role.',
    }];
  }
  return names.flatMap((name) => validateDoctrine(readFileSync(join(dir, name), 'utf8'), `team/${name}`));
}
