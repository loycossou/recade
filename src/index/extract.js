import { buildIdPattern, idSource } from './ids.js';
import { frontMatterLength } from '../frontmatter-lines.js';

/**
 * @typedef {{id:string,file:string,line:number,title:string}} Definition
 * @typedef {{id:string,file:string,line:number,column:number,gist:string|null,mirror?:true}} Citation
 * @typedef {{anchor:string,file:string,line:number,column:number}} LineAnchor
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?\1(?!`)/g;
const ANCHOR_RE = /\S+\.md:\d+/g;
const MIRROR = /^\s*<!--\s*mirror\s*-->\s*$/i;

const blank = (s) => ' '.repeat(s.length);
const lotsOf = (options) => (options && options.lots) || [];

/**
 * Yield the lines outside fenced code blocks and front matter, with their 1-based numbers. `idTable` is
 * true for the rows of a table whose header row starts with `ID`: only those rows define IDs. A table
 * preceded by a `<!-- mirror -->` comment (blank lines allowed) is a mirror of definitions made
 * elsewhere: its ID cells are citations.
 * @param {string} md
 * @returns {{text:string,line:number,idTable:boolean,mirror:boolean}[]}
 */
function proseLines(md) {
  const out = [];
  let fence = null;
  let inTable = false;
  let idTable = false;
  let mirror = false; // a mirror comment waits for the next table
  let mirrorTable = false; // the current table is a mirror
  const all = md.split(/\r?\n/);
  const skip = frontMatterLength(all);
  all.forEach((text, i) => {
    if (i < skip) return;
    const m = FENCE.exec(text);
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && text.trim() === m[1]) fence = null;
      return;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      inTable = false;
      return;
    }
    const cells = tableCells(text);
    if (!cells) {
      inTable = false;
      idTable = false;
      mirrorTable = false;
      if (MIRROR.test(text)) mirror = true;
      else if (text.trim() !== '') mirror = false;
    } else if (!inTable) {
      // The first row of a table is its header.
      inTable = true;
      mirrorTable = mirror;
      idTable = !mirror && cells.length >= 2 && stripEmphasis(cells[0].raw).toLowerCase() === 'id';
      mirror = false;
    }
    out.push({ text, line: i + 1, idTable, mirror: mirrorTable });
  });
  return out;
}

/** Split a table row into cells, with the offset of each cell in the line. */
function tableCells(text) {
  const first = text.search(/\S/);
  if (first === -1 || text[first] !== '|') return null;
  const cells = [];
  let start = first + 1;
  for (let i = first + 1; i <= text.length; i++) {
    if (i === text.length || (text[i] === '|' && text[i - 1] !== '\\')) {
      cells.push({ raw: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  if (cells.length > 0 && cells[cells.length - 1].raw.trim() === '') cells.pop();
  return cells;
}

const stripEmphasis = (s) => s.replace(/\\\|/g, '|').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

/** Match a first cell that is exactly one ID, bold or in backticks. */
function cellId(raw, anchored) {
  const bare = raw.trim().replace(/^(\*\*|__|`)(.*)\1$/, '$2').trim();
  return anchored.test(bare) ? bare : null;
}

/**
 * Find definition sites on a line. Returns the id, title and the span of the ID.
 * @returns {{id:string,title:string,start:number,end:number}|null}
 */
function definitionOf(text, anchored, heading, idTable) {
  const cells = tableCells(text);
  if (cells) {
    if (!idTable || cells.length < 2) return null;
    const id = cellId(cells[0].raw, anchored);
    if (id) {
      return { id, title: stripEmphasis(cells[1].raw), start: cells[0].offset, end: cells[0].offset + cells[0].raw.length };
    }
    return null;
  }
  const h = heading.exec(text);
  if (h) {
    return { id: h[2], title: stripEmphasis(h[3].replace(/^-\s*/, '')), start: h[1].length, end: h[1].length + h[2].length };
  }
  return null;
}

function patterns(options) {
  const lots = lotsOf(options);
  const anchored = buildIdPattern(lots, { global: false, anchored: true });
  const heading = new RegExp(`^(#{1,4}\\s+)(${idSource(lots)})(?::|\\s|$)\\s*(.*)$`);
  return { anchored, heading, any: buildIdPattern(lots) };
}

/**
 * Definitions: a row whose first cell is one ID in a table whose header starts with `ID`, or a heading
 * `# ID title` (levels 1 to 4, optional colon after the ID).
 * @param {string} md
 * @param {string} file
 * @param {{lots?: string[]}} [options]
 * @returns {Definition[]}
 */
export function extractDefinitions(md, file, options = {}) {
  const { anchored, heading } = patterns(options);
  const defs = [];
  for (const { text, line, idTable } of proseLines(md)) {
    const d = definitionOf(text, anchored, heading, idTable);
    if (d) defs.push({ id: d.id, file, line, title: d.title });
  }
  return defs;
}

/** Blank out inline code spans, URLs and definition cells, keeping columns. */
function mask(text, anchored, heading, idTable) {
  let masked = text.replace(CODE_SPAN, blank).replace(URL_RE, blank);
  const d = definitionOf(masked, anchored, heading, idTable);
  if (d) masked = masked.slice(0, d.start) + blank(masked.slice(d.start, d.end)) + masked.slice(d.end);
  return masked;
}

/** Text of the parenthesis that follows position `from`, or null. */
function gistAfter(masked, original, from) {
  const m = /^\s?\(/.exec(masked.slice(from));
  if (!m) return null;
  const open = from + m[0].length;
  let depth = 1;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')' && --depth === 0) return original.slice(open, i).trim() || null;
  }
  return null;
}

const GIST_WORDS_BEFORE = 6;

/**
 * The gist written before an ID that stands alone in parentheses: `upload a proof of income (FR-EX-01)`.
 * It is the last few words of the clause that ends at the parenthesis.
 */
function gistBefore(masked, original, start, end) {
  if (!/^\s*\)/.test(masked.slice(end))) return null;
  const head = /\(\s*$/.exec(masked.slice(0, start));
  if (!head) return null;
  let clause = original.slice(0, head.index);
  const cut = [...clause.matchAll(/[.!?;:](?=\s|$)|\|/g)].pop();
  if (cut) clause = clause.slice(cut.index + 1);
  clause = clause.replace(/^\s*(?:[-*+>]\s+|\d+[.)]\s+|#+\s+)/, '');
  const words = clause.trim().split(/\s+/).filter(Boolean);
  return words.length ? words.slice(-GIST_WORDS_BEFORE).join(' ') : null;
}

/** The gist of the citation at `start..end`, written after the ID or, failing that, before it. */
function gistAt(masked, original, start, end) {
  return gistAfter(masked, original, end) ?? gistBefore(masked, original, start, end);
}

/**
 * Citations of IDs in prose. Code blocks, inline code, URLs and definition cells are skipped.
 * @param {string} md
 * @param {string} file
 * @param {{lots?: string[]}} [options]
 * @returns {Citation[]}
 */
export function extractCitations(md, file, options = {}) {
  const { anchored, heading, any } = patterns(options);
  const cites = [];
  for (const { text, line, idTable, mirror } of proseLines(md)) {
    const masked = mask(text, anchored, heading, idTable);
    for (const m of masked.matchAll(any)) {
      cites.push({
        id: m[0],
        file,
        line,
        column: m.index + 1,
        gist: gistAt(masked, text, m.index, m.index + m[0].length),
        ...(mirror ? { mirror: true } : {}),
      });
    }
  }
  return cites;
}

/**
 * References of the form `file.md:42`. The whole text is scanned, code spans
 * and fenced blocks included, because a line number goes stale wherever it sits.
 * @param {string} md
 * @param {string} file
 * @returns {LineAnchor[]}
 */
export function extractLineAnchors(md, file) {
  const found = [];
  md.split(/\r?\n/).forEach((text, i) => {
    for (const m of text.matchAll(ANCHOR_RE)) {
      const anchor = m[0].replace(/^[(`\[<"'*_]+/, '');
      found.push({ anchor, file, line: i + 1, column: m.index + (m[0].length - anchor.length) + 1 });
    }
  });
  return found;
}
