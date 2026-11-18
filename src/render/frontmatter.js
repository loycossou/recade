import { parseDocument as parseYaml } from 'yaml';
import { normalizeLanguage } from './theme.js';

export { normalizeLanguage };

const REQUIRED = ['doc_id', 'title', 'project', 'version', 'date', 'status'];
const DOC_ID = /^[A-Z0-9-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /^---[ \t]*$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Split a Markdown file into its YAML front matter and its body.
 * `bodyLine` is the 1-based line of the first body line in the original text.
 * @param {string} text
 * @param {string} [file]
 * @returns {{meta: Record<string, any>, body: string, bodyLine: number}}
 */
export function splitFrontMatter(text, file = 'document') {
  const source = text.replace(/^\uFEFF/, '');
  const open = OPENING.exec(source);
  if (!open) throw new Error(`${file}: missing front matter`);
  const lines = source.slice(open[0].length).split('\n');
  const end = lines.findIndex((l) => CLOSING.test(l.replace(/\r$/, '')));
  if (end === -1) throw new Error(`${file}: missing front matter`);
  const yaml = lines.slice(0, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  const doc = parseYaml(yaml);
  if (doc.errors.length > 0) throw new Error(`${file}: invalid front matter: ${doc.errors[0].message}`);
  const meta = doc.toJS() ?? {};
  if (!isObject(meta)) throw new Error(`${file}: front matter must be a mapping`);
  // `version: 1.0` is read as the number 1: keep the text as it was written.
  const asWritten = (scalar, fallback) =>
    scalar && typeof scalar.value === 'number' && typeof scalar.source === 'string' ? scalar.source : fallback;
  if ('version' in meta) meta.version = asWritten(doc.get('version', true), meta.version);
  const revisions = doc.get('revisions', true);
  if (revisions && Array.isArray(revisions.items) && Array.isArray(meta.revisions)) {
    revisions.items.forEach((item, i) => {
      if (item && typeof item.get === 'function' && isObject(meta.revisions[i]) && 'version' in meta.revisions[i]) {
        meta.revisions[i].version = asWritten(item.get('version', true), meta.revisions[i].version);
      }
    });
  }
  return { meta, body, bodyLine: end + 3 };
}

const text = (v) => (v === undefined || v === null ? undefined : String(v).trim());

function isoDate(value, file, where) {
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : text(value);
  const valid =
    s !== undefined &&
    DATE.test(s) &&
    (() => {
      const [y, m, d] = s.split('-').map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
    })();
  if (!valid) throw new Error(`${file}: front matter ${where} must be a date as YYYY-MM-DD, got "${s ?? ''}"`);
  return s;
}

const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Check the front matter keys and return a normalised Meta.
 * @param {Record<string, any>} meta
 * @param {string} file
 * @returns {{doc_id:string,title:string,project:string,version:string,date:string,status:string,author?:string,approver?:string,org?:string,companions:string[],classification?:string,language:string,revisions:{version:string,date:string,author?:string,change?:string}[],approvals:{role:string,name?:string,date?:string}[]}}
 */
export function validateMeta(meta, file) {
  for (const key of REQUIRED) {
    const v = meta[key];
    if (v === undefined || v === null || String(v).trim() === '') throw new Error(`${file}: front matter needs ${key}`);
  }
  const docId = text(meta.doc_id);
  if (!DOC_ID.test(docId)) throw new Error(`${file}: front matter doc_id must match [A-Z0-9-]+, got "${docId}"`);
  const out = {
    doc_id: docId,
    title: text(meta.title),
    project: text(meta.project),
    version: text(meta.version),
    date: isoDate(meta.date, file, 'date'),
    status: text(meta.status),
  };
  for (const key of ['author', 'approver', 'org', 'classification']) {
    const v = text(meta[key]);
    if (v) out[key] = v;
  }
  out.companions = list(meta.companions).map((c) => String(c).trim());
  out.language = normalizeLanguage(meta.language);
  out.revisions = list(meta.revisions).map((r, i) => {
    if (!isObject(r)) throw new Error(`${file}: front matter revisions[${i}] must be a mapping`);
    return { version: text(r.version) ?? '', date: isoDate(r.date, file, `revisions[${i}].date`), author: text(r.author) ?? '', change: text(r.change) ?? '' };
  });
  out.approvals = list(meta.approvals).map((a, i) => {
    if (!isObject(a)) throw new Error(`${file}: front matter approvals[${i}] must be a mapping`);
    const date = a.date === undefined || a.date === null || a.date === '' ? '' : isoDate(a.date, file, `approvals[${i}].date`);
    return { role: text(a.role) ?? '', name: text(a.name) ?? '', date };
  });
  return out;
}
