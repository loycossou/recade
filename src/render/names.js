import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { splitFrontMatter } from './frontmatter.js';

/** Letters that NFKD does not split into a base letter and a mark. */
const LETTERS = { ß: 'ss', ẞ: 'Ss', æ: 'ae', Æ: 'Ae', œ: 'oe', Œ: 'Oe', ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th', ı: 'i' };
const MAX_LENGTH = 60;
/** A language copy of a source: `D1.fr`, `PLAN.pt-BR`. */
const COPY = /^(.+?)\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/;

/**
 * The short words a title keeps in lower case after its first word: articles, prepositions and conjunctions of the
 * languages Recade writes in (English, French, Spanish, Portuguese, Italian, German), and the elided `d` and `l`.
 */
const SMALL = new Set([
  'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with', 'from', 'as', 'vs',
  'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'ou', 'au', 'aux', 'en', 'pour', 'par', 'sur', 'un', 'une', 'avec', 'sans', 'dans',
  'del', 'el', 'los', 'las', 'y', 'o', 'e', 'con', 'para', 'por', 'una', 'do', 'da', 'dos', 'das', 'os', 'em', 'no', 'na', 'um', 'uma', 'com',
  'di', 'della', 'il', 'lo', 'gli', 'per',
  'der', 'die', 'das', 'und', 'oder', 'von', 'zu', 'im', 'mit', 'fur',
]);

/**
 * A title as a file name part: accents dropped (`é` to `e`, `ß` to `ss`), every run of other characters a hyphen,
 * the first letter of each word upper case, the rest as written. A short word after the first (`de`, `of`, `und`)
 * stays in lower case when it is written so. At most 60 characters, cut at a hyphen. A title in
 * a script with no Latin letters gives an empty string.
 * @param {string} title
 */
export function slugTitle(title) {
  const plain = String(title ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x00-\x7F]/g, (c) => LETTERS[c] ?? ' ');
  const words = plain.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => (i > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
  let out = '';
  for (const word of words) {
    const next = out === '' ? word : `${out}-${word}`;
    if (next.length > MAX_LENGTH) break;
    out = next;
  }
  return out === '' && words.length > 0 ? words[0].slice(0, MAX_LENGTH) : out;
}

/**
 * The title of a document without the project name: the templates write `<project>, <document title>`. A title that
 * does not start with the project keeps what follows its first comma, or all of it when it has none.
 * @param {{title?:unknown, project?:unknown}} meta
 */
export function documentTitle(meta) {
  const title = String(meta?.title ?? '').trim();
  const project = String(meta?.project ?? '').trim();
  if (project !== '' && title.toLowerCase().startsWith(project.toLowerCase())) {
    const rest = title.slice(project.length);
    if (/^[\s,:;|-]/.test(rest)) return rest.replace(/^[\s,:;|-]+/, '').trim();
  }
  const comma = title.indexOf(', ');
  return comma === -1 ? title : title.slice(comma + 2).trim();
}

/** `<id>_<Title>`, or `<id>` alone when the title gives nothing. */
export const deliverableName = (id, meta) => {
  const slug = slugTitle(documentTitle(meta));
  return slug === '' ? id : `${id}_${slug}`;
};

/** The front matter of a Markdown file, or null when it cannot be read. */
function metaOf(file) {
  try {
    return splitFrontMatter(readFileSync(file, 'utf8'), basename(file)).meta;
  } catch {
    return null;
  }
}

/**
 * The file name, without extension, of what a source renders to. `docs/D1.md` titled "Fernhill, Functional
 * Specifications" gives `D1_Functional-Specifications`; `docs/D1.fr.md` gives the French title. A language copy whose
 * name would be the one of its source (`D1.md` next to it) keeps its language at the end: `D1_Plan.fr`.
 * @param {string} file the Markdown source
 * @param {object} meta its front matter
 */
export function sourceDeliverableName(file, meta) {
  const stem = basename(file, extname(file));
  const copy = COPY.exec(stem);
  const id = copy ? copy[1] : stem;
  const name = deliverableName(id, meta);
  if (!copy) return name;
  const original = join(dirname(file), `${id}${extname(file)}`);
  const other = existsSync(original) ? metaOf(original) : null;
  return other && deliverableName(id, other) === name ? `${name}.${copy[2]}` : name;
}

/** The names a source rendered to before the files were named after their titles: `D1.docx`, `D1.pdf`. */
export const oldNames = (file, exts = ['docx', 'pdf']) => exts.map((ext) => `${basename(file, extname(file))}.${ext}`);
