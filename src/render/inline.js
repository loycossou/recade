import { marked } from 'marked';
import { ID_PATTERN } from '../index/ids.js';

/** @typedef {{text:string,bold?:boolean,italic?:boolean,code?:boolean,link?:string,provisional?:boolean}} Run */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const PROVISIONAL_WORD = /\bPROVISIONAL\b/g;

/** Decode the HTML entities that marked leaves in text tokens. */
export function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (all, dec, hex, name) => {
    if (name) return NAMED[name] ?? all;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
  });
}

/** Spans of `PROVISIONAL` and of `PRV-<nn>` citations in a text, as [start, end] pairs in order. */
function provisionalSpans(text) {
  const spans = [];
  for (const m of text.matchAll(PROVISIONAL_WORD)) spans.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(ID_PATTERN)) {
    if (m[0].startsWith('PRV-')) spans.push([m.index, m.index + m[0].length]);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** Make runs from a piece of text, splitting out the provisional markers. */
function textRuns(text, style) {
  if (text === '') return [];
  const runs = [];
  let at = 0;
  for (const [start, end] of provisionalSpans(text)) {
    if (start < at) continue;
    if (start > at) runs.push({ text: text.slice(at, start), ...style });
    runs.push({ text: text.slice(start, end), ...style, provisional: true });
    at = end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), ...style });
  return runs;
}

const sameStyle = (a, b) =>
  !!a.bold === !!b.bold &&
  !!a.italic === !!b.italic &&
  !!a.code === !!b.code &&
  a.link === b.link &&
  !!a.provisional === !!b.provisional;

/** Join neighbouring runs that carry the same style. */
export function mergeRuns(runs) {
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

function walk(tokens, style, out) {
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'escape':
        if (t.tokens && t.tokens.length > 0) walk(t.tokens, style, out);
        else out.push(...textRuns(decodeEntities(t.text), style));
        break;
      case 'strong':
        walk(t.tokens, { ...style, bold: true }, out);
        break;
      case 'em':
        walk(t.tokens, { ...style, italic: true }, out);
        break;
      case 'del':
        walk(t.tokens, style, out);
        break;
      case 'codespan':
        out.push({ text: t.text, ...style, code: true }); // code text is literal: marked leaves it raw
        break;
      case 'link':
        walk(t.tokens, { ...style, link: t.href }, out);
        break;
      case 'image':
        walk(t.tokens ?? [], style, out);
        break;
      case 'br':
        out.push({ text: '\n', ...style });
        break;
      case 'html':
        if (/^<br\s*\/?>$/i.test(t.raw.trim())) out.push({ text: '\n', ...style });
        break;
      case 'checkbox':
        out.push({ text: t.checked ? '[x] ' : '[ ] ', ...style });
        break;
      default:
        if (t.tokens) walk(t.tokens, style, out);
        else if (typeof t.text === 'string') out.push(...textRuns(decodeEntities(t.text), style));
    }
  }
}

/**
 * Convert marked inline tokens to runs. Falsy flags are left out.
 * @param {any[]} tokens
 * @returns {Run[]}
 */
export function inlineRuns(tokens) {
  const out = [];
  walk(tokens ?? [], {}, out);
  return mergeRuns(out);
}

/** Runs of an inline Markdown string. */
export function parseInlineText(src) {
  return inlineRuns(marked.Lexer.lexInline(src, { gfm: true }));
}

/** The text of runs, without any formatting. */
export const plainText = (runs) => runs.map((r) => r.text).join('');
