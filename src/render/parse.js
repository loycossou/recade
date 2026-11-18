import { marked } from 'marked';
import { buildIdPattern } from '../index/ids.js';
import { splitFrontMatter, validateMeta } from './frontmatter.js';
import { inlineRuns, mergeRuns, parseInlineText, plainText } from './inline.js';

/** @typedef {import('./inline.js').Run} Run */
/** @typedef {{file:string,line:number,column:number,rule:string,severity:'warn',message:string}} Finding */

const PAGEBREAK = /^<!--\s*pagebreak\s*-->$/i;
const WIDTHS = /^<!--\s*widths:\s*([^]*?)\s*-->$/i;
const CAPTION = /^<!--\s*caption:\s*([^]*?)\s*-->$/i;
const CALLOUT = /^\[!(NOTE|WARNING|DECISION)\][ \t]*(.*)$/i;
const FIGURE_KINDS = { '.html': 'html', '.svg': 'svg', '.png': 'png' };

const countLines = (s) => (s.match(/\n/g) ?? []).length;

/** Anchor slug: lowercase, accents removed, runs of non-alphanumerics become one dash. */
function slug(text) {
  const s = text
    .replace(/[œŒ]/g, 'oe')
    .replace(/[æÆ]/g, 'ae')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'section';
}

/** Largest-remainder normalisation of positive integers to a sum of exactly 100. */
function normaliseWidths(values) {
  const total = values.reduce((a, b) => a + b, 0);
  const exact = values.map((v) => (v * 100) / total);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - floors[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left-- <= 0) break;
    floors[i] += 1;
  }
  return floors;
}

/** Number of cells in a raw table row, counting unescaped pipes. */
function rawCellCount(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  let count = 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '|') count++;
  }
  return count;
}

class Converter {
  /**
   * @param {string} file
   * @param {{lots?: string[]}} options
   */
  constructor(file, options) {
    this.file = file;
    this.warnings = /** @type {Finding[]} */ ([]);
    this.anchors = new Set();
    this.figures = 0;
    this.idCell = buildIdPattern(options.lots ?? [], { global: false, anchored: true });
  }

  warn(line, rule, message) {
    this.warnings.push({ file: this.file, line, column: 1, rule, severity: 'warn', message });
  }

  /**
   * Convert block tokens. `first` is the 1-based file line of the first token.
   * @returns {any[]}
   */
  blocks(tokens, first) {
    const out = [];
    let line = first;
    let widths = null; // pending widths comment: {values, line}
    let caption = null; // pending caption comment, valid only for the very next token
    for (const t of tokens) {
      const pendingCaption = caption;
      caption = null;
      if (t.type === 'space') {
        line += countLines(t.raw);
        continue;
      }
      if (t.type === 'html') {
        const comment = t.raw.trim();
        let m;
        if (PAGEBREAK.test(comment)) out.push({ type: 'pagebreak', line });
        else if ((m = WIDTHS.exec(comment))) widths = { text: m[1], line };
        else if ((m = CAPTION.exec(comment))) caption = m[1];
        line += countLines(t.raw);
        continue;
      }
      const pendingWidths = t.type === 'table' ? widths : null;
      widths = null;
      this.block(t, line, out, { widths: pendingWidths, caption: pendingCaption });
      line += countLines(t.raw);
    }
    return out;
  }

  block(t, line, out, pending) {
    switch (t.type) {
      case 'heading':
        out.push(this.heading(t, line));
        break;
      case 'paragraph':
        out.push(...this.paragraph(t, line));
        break;
      case 'text': // block-level text outside a list item
        out.push({ type: 'paragraph', runs: inlineRuns(t.tokens ?? [{ type: 'text', text: t.text }]), line });
        break;
      case 'list':
        out.push(this.list(t, line));
        break;
      case 'table':
        out.push(this.table(t, line, pending.widths));
        break;
      case 'blockquote':
        out.push(this.callout(t, line));
        break;
      case 'code':
        out.push(this.code(t, line, pending.caption));
        break;
      default: // hr, def and anything else has no place in the IR
    }
  }

  heading(t, line) {
    const runs = inlineRuns(t.tokens);
    if (t.depth > 4) return { type: 'paragraph', runs: runs.map((r) => ({ ...r, bold: true })), line };
    const base = slug(plainText(runs));
    // Anchors are bookmark names: keep them unique, even against a heading that already reads "x-2".
    let anchor = base;
    for (let n = 2; this.anchors.has(anchor); n++) anchor = `${base}-${n}`;
    this.anchors.add(anchor);
    return { type: 'heading', level: t.depth, runs, anchor, line };
  }

  paragraph(t, line) {
    const parts = t.tokens.filter((x) => !(x.type === 'text' && x.text.trim() === ''));
    if (parts.length === 1 && parts[0].type === 'image') {
      return [this.imageFigure(parts[0], line)];
    }
    return [{ type: 'paragraph', runs: inlineRuns(t.tokens), line }];
  }

  nextFigure() {
    this.figures += 1;
    return { number: this.figures, id: `fig-${this.figures}` };
  }

  imageFigure(image, line) {
    const path = image.href;
    const ext = /\.[A-Za-z0-9]+$/.exec(path.split(/[?#]/)[0])?.[0].toLowerCase() ?? '';
    const kind = FIGURE_KINDS[ext];
    if (!kind) {
      throw new Error(`${this.file}:${line}: unsupported image "${path}" (figures must be .html, .svg or .png)`);
    }
    return { type: 'figure', ...this.nextFigure(), source: { kind, path }, caption: inlineRuns(image.tokens), line };
  }

  code(t, line, caption) {
    const lang = (t.lang ?? '').trim().split(/\s+/)[0];
    const text = t.text.replace(/\n+$/, '');
    if (lang === 'mermaid') {
      return {
        type: 'figure',
        ...this.nextFigure(),
        source: { kind: 'mermaid', text },
        caption: caption ? parseInlineText(caption) : [],
        line,
      };
    }
    return { type: 'code', lang, text, line };
  }

  list(t, line) {
    let at = 0;
    const items = t.items.map((item) => {
      const found = t.raw.indexOf(item.raw, at);
      const start = found === -1 ? at : found;
      at = start + item.raw.length;
      return this.listItem(item, line + countLines(t.raw.slice(0, start)));
    });
    return { type: 'list', ordered: t.ordered, items, line };
  }

  listItem(item, line) {
    const runs = [];
    let leading = true;
    const rest = [];
    let at = line;
    for (const t of item.tokens) {
      if (t.type === 'checkbox') {
        runs.push(...inlineRuns([t]));
      } else if (leading && (t.type === 'text' || t.type === 'paragraph')) {
        runs.push(...inlineRuns(t.tokens ?? []));
        leading = false;
      } else {
        rest.push([t, at]);
      }
      at += countLines(t.raw);
    }
    const children = [];
    for (const [t, start] of rest) {
      if (t.type === 'space') continue;
      if (t.type === 'text') {
        children.push({ type: 'paragraph', runs: inlineRuns(t.tokens ?? []), line: start });
      } else {
        children.push(...this.blocks([t], start));
      }
    }
    return { runs: mergeRuns(runs), children };
  }

  table(t, line, pendingWidths) {
    const cols = t.header.length;
    const header = t.header.map((c) => inlineRuns(c.tokens));
    const rawRows = t.raw.split('\n').slice(2);
    const rows = t.rows.map((row, i) => {
      const cells = row.map((c) => inlineRuns(c.tokens));
      const found = rawRows[i] === undefined ? cells.length : rawCellCount(rawRows[i]);
      if (found !== cols) {
        this.warn(
          line + 2 + i,
          'table-ragged',
          `Table row has ${found} cells, the header has ${cols}. ${found < cols ? 'Padded with empty cells.' : 'Extra cells dropped.'}`,
        );
      }
      while (cells.length < cols) cells.push([]);
      return cells.slice(0, cols);
    });
    const widths = pendingWidths ? this.widths(pendingWidths, cols) : null;
    const isIdTable = cols >= 2 && plainText(header[0]).replace(/[*_`]+/g, '').trim().toLowerCase() === 'id';
    const rowAnchors = rows.map((row) => {
      if (!isIdTable) return null;
      const id = plainText(row[0]).trim();
      return this.idCell.test(id) ? id : null;
    });
    return { type: 'table', header, rows, widths, rowAnchors, line };
  }

  widths(hint, cols) {
    const parts = hint.text.split(',').map((s) => s.trim());
    const values = parts.map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
    if (values.length !== cols || values.some((v) => Number.isNaN(v)) || values.reduce((a, b) => a + b, 0) === 0) {
      this.warn(
        hint.line,
        'table-widths',
        `Widths hint "${hint.text}" ignored: it needs ${cols} integers and a non-zero sum.`,
      );
      return null;
    }
    return normaliseWidths(values);
  }

  callout(t, line) {
    // Re-lex the quote body without its `>` markers so nested blocks get real tokens.
    const lines = t.raw.split('\n').map((l) => l.replace(/^ {0,3}> ?/, ''));
    let kind = 'note';
    let first = line;
    const marker = CALLOUT.exec(lines[0]);
    if (marker) {
      kind = marker[1].toLowerCase();
      lines[0] = marker[2];
      if (marker[2] === '') {
        lines.shift();
        first += 1;
      }
    }
    const tokens = marked.lexer(lines.join('\n'), { gfm: true });
    return { type: 'callout', kind, blocks: this.blocks(tokens, first), line };
  }
}

/**
 * Parse a Markdown document with front matter into the render IR.
 * @param {string} text
 * @param {string} file
 * @param {{lots?: string[]}} [options] backlog lots, as for the index
 * @returns {{meta: any, blocks: any[], file: string, warnings: Finding[]}}
 */
export function parseDocument(text, file, options = {}) {
  const { meta: rawMeta, body, bodyLine } = splitFrontMatter(text, file);
  const meta = validateMeta(rawMeta, file);
  const converter = new Converter(file, options);
  const tokens = marked.lexer(body, { gfm: true });
  const blocks = converter.blocks(tokens, bodyLine);
  return { meta, blocks, file, warnings: converter.warnings };
}
