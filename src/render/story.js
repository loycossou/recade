import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parse } from 'yaml';
import { parseInlineText, plainText } from './inline.js';

/**
 * The companion of a document: a short summary layer written by the author of the document, read by the HTML dossier
 * and by the Word cover. It lives next to the document, as `<name>.story.yaml` (`docs/D1.story.yaml` for
 * `docs/D1.md`, `docs/D1.fr.story.yaml` for `docs/D1.fr.md`). It is optional: without it the dossier renders from the
 * Markdown alone, with a plainer header.
 *
 * Keys, all optional:
 * - `kicker`: a few words above the title.
 * - `lede`: one sentence under the title.
 * - `facts`: key numbers or dates, each `{ label, value }`.
 * - `recap`: short numbered statements that hold the whole document.
 * - `decisions`: the decisions that matter, each `{ decision, why }`.
 * - `sections`: one entry for a main section, `{ section, image, before_after, stats }`. `section` is the number of the
 *   heading (`2` for "## 2. Context") or its text. `image` is an everyday analogy, `before_after` rows of
 *   `{ before, after }`, `stats` tiles of `{ value, label }`.
 *
 * Every text takes inline Markdown: bold, italic, code, and IDs, drawn as in the document.
 */

/** The size limits of a companion. Over a limit is a warning, never an error: the summary layer stays cheap. */
export const STORY_LIMITS = Object.freeze({
  kicker: 8, lede: 40, facts: 6, factWords: 8, recap: 12, recapMin: 3, recapWords: 40, decisions: 8, decisionWords: 40,
  image: 80, beforeAfter: 8, cellWords: 25, stats: 6, statWords: 8, total: 600,
});

const KEYS = ['kicker', 'lede', 'facts', 'recap', 'decisions', 'sections'];
const SECTION_KEYS = ['section', 'image', 'before_after', 'stats'];

/** The companion file of a document file: `D1.md` gives `D1.story.yaml` in the same folder. */
export function storyFileOf(file) {
  return join(dirname(file), `${basename(file, extname(file))}.story.yaml`);
}

const words = (text) => (String(text).trim().match(/\S+/g) ?? []).length;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' || typeof v === 'number';

/**
 * Parse the text of a companion. Never throws: a problem is a warning, and what cannot be read is left out.
 * @param {string} text
 * @param {string} rel the path shown in the findings
 * @returns {{story: Story|null, warnings: Finding[]}}
 *
 * @typedef {import('./inline.js').Run} Run
 * @typedef {{file:string,line:number,column:number,rule:string,severity:'warn',message:string}} Finding
 * @typedef {{kicker?: Run[], lede?: Run[], facts: {label: Run[], value: Run[]}[], recap: Run[][],
 *   decisions: {decision: Run[], why: Run[]}[], sections: StorySection[], words: number}} Story
 * @typedef {{key: string, image?: Run[], beforeAfter: {before: Run[], after: Run[]}[], stats: {value: Run[], label: Run[]}[]}} StorySection
 */
export function parseStory(text, rel) {
  const warnings = [];
  const warn = (rule, message) => warnings.push({ file: rel, line: 1, column: 1, rule, severity: 'warn', message });
  let raw;
  try {
    raw = parse(text);
  } catch (err) {
    warn('story-invalid', `The companion is not valid YAML: ${String(err?.message ?? err).split('\n')[0]} The dossier is rendered without it.`);
    return { story: null, warnings };
  }
  if (raw === null || raw === undefined) return { story: null, warnings };
  if (!isObject(raw)) {
    warn('story-invalid', 'The companion must be a set of keys (kicker, lede, facts, recap, decisions, sections). The dossier is rendered without it.');
    return { story: null, warnings };
  }
  let total = 0;
  const textOf = (value, where, limit) => {
    if (!isText(value) || String(value).trim() === '') {
      warn('story-invalid', `${where} must be a text. It is left out.`);
      return null;
    }
    const n = words(value);
    total += n;
    if (limit && n > limit) warn('story-size', `${where} has ${n} words, keep it under ${limit}.`);
    return parseInlineText(String(value).trim());
  };
  const listOf = (value, where, max) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      warn('story-invalid', `${where} must be a list. It is left out.`);
      return [];
    }
    if (max && value.length > max) warn('story-size', `${where} has ${value.length} entries, keep it to ${max} at most.`);
    return value;
  };
  const pairOf = (value, where, [a, b], limit) => {
    if (!isObject(value)) {
      warn('story-invalid', `${where} must have the keys ${a} and ${b}. It is left out.`);
      return null;
    }
    const first = textOf(value[a], `${where} ${a}`, limit);
    const second = textOf(value[b], `${where} ${b}`, limit);
    return first && second ? { [a]: first, [b]: second } : null;
  };

  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) warn('story-unknown-key', `Unknown key "${key}". The keys are ${KEYS.join(', ')}.`);
  }
  const L = STORY_LIMITS;
  const story = { facts: [], recap: [], decisions: [], sections: [], words: 0 };
  if (raw.kicker !== undefined) story.kicker = textOf(raw.kicker, 'kicker', L.kicker) ?? undefined;
  if (raw.lede !== undefined) story.lede = textOf(raw.lede, 'lede', L.lede) ?? undefined;
  story.facts = listOf(raw.facts, 'facts', L.facts).map((f, i) => pairOf(f, `facts ${i + 1}`, ['label', 'value'], L.factWords)).filter(Boolean);
  story.recap = listOf(raw.recap, 'recap', L.recap).map((r, i) => textOf(r, `recap ${i + 1}`, L.recapWords)).filter(Boolean);
  if (story.recap.length > 0 && story.recap.length < L.recapMin) warn('story-size', `recap has ${story.recap.length} entries, give at least ${L.recapMin}.`);
  story.decisions = listOf(raw.decisions, 'decisions', L.decisions).map((d, i) => pairOf(d, `decisions ${i + 1}`, ['decision', 'why'], L.decisionWords)).filter(Boolean);
  const seen = new Set();
  for (const [i, s] of listOf(raw.sections, 'sections').entries()) {
    const where = `sections ${i + 1}`;
    if (!isObject(s) || !isText(s.section) || String(s.section).trim() === '') {
      warn('story-invalid', `${where} needs a section: the number of the heading, or its text. It is left out.`);
      continue;
    }
    for (const key of Object.keys(s)) {
      if (!SECTION_KEYS.includes(key)) warn('story-unknown-key', `Unknown key "${key}" in ${where}. The keys are ${SECTION_KEYS.join(', ')}.`);
    }
    const key = String(s.section).trim();
    if (seen.has(key.toLowerCase())) warn('story-invalid', `${where}: the section ${key} is given twice. The first one is kept.`);
    seen.add(key.toLowerCase());
    const section = {
      key,
      image: s.image === undefined ? undefined : textOf(s.image, `${where} image`, L.image) ?? undefined,
      beforeAfter: listOf(s.before_after, `${where} before_after`, L.beforeAfter)
        .map((r, j) => pairOf(r, `${where} before_after ${j + 1}`, ['before', 'after'], L.cellWords)).filter(Boolean),
      stats: listOf(s.stats, `${where} stats`, L.stats).map((t, j) => pairOf(t, `${where} stats ${j + 1}`, ['value', 'label'], L.statWords)).filter(Boolean),
    };
    story.sections.push(section);
  }
  story.words = total;
  if (total > L.total) warn('story-size', `The companion has ${total} words, keep it under ${L.total}: it is a summary, not a second document.`);
  return { story, warnings };
}

/**
 * Read the companion of a document file when it exists.
 * @param {string} file the document file
 * @param {string} rel the path of the companion shown in the findings
 * @returns {{story: Story|null, warnings: Finding[], text: string|null, file: string}}
 */
export function loadStory(file, rel) {
  const storyFile = storyFileOf(file);
  if (!existsSync(storyFile)) return { story: null, warnings: [], text: null, file: storyFile };
  let text;
  try {
    text = readFileSync(storyFile, 'utf8');
  } catch (err) {
    const warnings = [{ file: rel, line: 1, column: 1, rule: 'story-invalid', severity: 'warn', message: `Cannot read the companion: ${String(err?.message ?? err).split('\n')[0]}` }];
    return { story: null, warnings, text: null, file: storyFile };
  }
  return { ...parseStory(text, rel), text, file: storyFile };
}

/** The number of a heading ("2" for "2. Context", "A" for "Annex A. Glossary") and its text without the number. */
export function headingParts(text) {
  const t = text.trim();
  let m = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/.exec(t);
  if (m) return { number: m[1], title: m[2] };
  m = /^(?:annex|annexe|appendix)\s+([A-Z])[.:]?\s+(.+)$/i.exec(t);
  if (m) return { number: m[1].toUpperCase(), title: m[2] };
  return { number: null, title: t };
}

/**
 * The companion section for each main heading of a document, and a warning for each companion section that no
 * heading matches. A key matches the number of the heading or its whole text, case and spaces ignored.
 * @param {Story|null} story
 * @param {{text: string}[]} headings the main headings, in order
 * @param {string} rel the companion path shown in the findings
 * @returns {{bySection: (StorySection|null)[], warnings: Finding[]}}
 */
export function matchSections(story, headings, rel) {
  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  const keys = headings.map((h) => {
    const { number, title } = headingParts(h.text);
    return { number: number ? norm(number) : null, text: norm(h.text), bare: norm(title) };
  });
  const bySection = headings.map(() => null);
  const warnings = [];
  for (const section of story?.sections ?? []) {
    const k = norm(section.key);
    const at = keys.findIndex((h) => h.number === k || h.text === k || h.bare === k);
    if (at < 0) {
      warnings.push({ file: rel, line: 1, column: 1, rule: 'story-section', severity: 'warn', message: `The companion names the section "${section.key}", which is not a main heading of the document. It is left out.` });
    } else if (bySection[at] === null) bySection[at] = section;
  }
  return { bySection, warnings };
}

/** Plain text of companion runs (for titles and attributes). */
export const storyText = (runs) => plainText(runs ?? []);
