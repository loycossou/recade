import { buildIdPattern } from '../index/ids.js';

/** @typedef {import('./inline.js').Run} Run */

/** The share of the text width of the ID column of a table, in percent, when the author gave no widths. */
const ID_COLUMN_PERCENT = 13;

const plainOf = (runs) => (runs ?? []).map((r) => r.text).join('').replace(/[*_`]+/g, '').trim().toLowerCase();

/** True when the first column of a table is an ID column (its header reads `ID`) and the table has another column. */
export function isIdHeader(header) {
  return Array.isArray(header) && header.length >= 2 && plainOf(header[0]) === 'id';
}

/**
 * Column index of the key cells of a table, the ones that name the row: the first column, or the second one when the
 * first is the ID column. -1 for a table of one column.
 */
export function keyColumn(header, count) {
  const at = isIdHeader(header) ? 1 : 0;
  return count > 1 && count > at ? at : -1;
}

/**
 * Column widths for a table without a `<!-- widths -->` hint. A table without an ID column keeps equal columns (null).
 * With one, the ID column is narrow and the others share the rest in proportion to how much they hold: the average
 * length of their text, kept between 8 and 60 characters and never under their longest word, so no column is squeezed
 * shut or swallows the table.
 * @param {import('./inline.js').Run[][]|null} header
 * @param {number} count
 * @param {import('./inline.js').Run[][][]} [rows]
 * @returns {number[]|null}
 */
export function defaultWidths(header, count, rows = []) {
  if (!isIdHeader(header) || count < 2) return null;
  const text = (runs) => (runs ?? []).map((r) => r.text).join('');
  const weights = Array.from({ length: count - 1 }, (_, k) => {
    const cells = [header[k + 1], ...rows.map((r) => r[k + 1])].map(text);
    const average = cells.reduce((sum, c) => sum + c.length, 0) / cells.length;
    // A column is never narrower than its longest word (up to 26 characters, with room for the cell padding), so a word is not cut in two.
    const word = Math.min(26, Math.ceil(Math.max(...cells.map((c) => Math.max(0, ...c.split(/\s+/).map((w) => w.length)))) * 1.15) + 3);
    return Math.min(60, Math.max(8, average, word));
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const rest = 100 - ID_COLUMN_PERCENT;
  return [ID_COLUMN_PERCENT, ...weights.map((w) => Math.round((w / total) * rest * 100) / 100)];
}

/**
 * Splits a text into pieces, the IDs apart from the words: `[{text, id}]`. An ID is small and muted in the document, so
 * the renderers draw it differently from the sentence around it. The IDs are the ones the index knows, the backlog IDs
 * of the project's `lots` included; the bare milestone form `M1` is not muted in a sentence (it is muted in an ID column).
 * @param {string} text
 * @param {string[]} [lots] backlog lots of the project
 * @returns {{text:string, id:boolean}[]}
 */
export function splitIds(text, lots = []) {
  const out = [];
  let at = 0;
  for (const m of String(text).matchAll(buildIdPattern(lots, { milestones: false }))) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), id: false });
    out.push({ text: m[0], id: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), id: false });
  return out;
}

/** What a provisional run shows: the word PROVISIONAL in the document language, a PRV citation as written. */
export const provisionalText = (run, labels) => (run.text === 'PROVISIONAL' ? (labels.provisional ?? run.text) : run.text);

/** The words between a figure label and its number, and between the number and the caption: `Figure 3: ...`. */
export const captionSeparator = (labels) => labels.captionSeparator ?? ': ';

/**
 * Display text of a fixed term of the PLAN (a sheet title or a column title): the document language's word when the
 * labels have one, else the text as written. The Markdown keeps the English term, because the workbook is read by it.
 * @param {string} text
 * @param {Record<string,any>} labels
 */
export function planTerm(text, labels) {
  const map = labels.planTerms;
  if (!map) return text;
  const hit = Object.keys(map).find((k) => k.toLowerCase() === String(text).trim().toLowerCase());
  return hit ? map[hit] : text;
}
