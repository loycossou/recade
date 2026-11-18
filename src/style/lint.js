import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from '../files.js';
import { RULES, IGNORE_MARKER, SCANNED_EXTS, codePointOf } from './rules.js';

/** @typedef {{file:string,line:number,column:number,rule:string,severity:'error'|'warn',message:string,codePoint?:string}} Finding */

/** `&#x202E;`, `&#X202e;`, `&#8238;`, with any number of leading zeros. The semicolon is optional because HTML decodes without it. */
const CHAR_REFERENCE = /&#(?:[xX]0*([0-9a-fA-F]{1,6})|0*([0-9]{1,7}));?/g;

const INVISIBLE_RULES = RULES.filter((r) => r.invisible);
const INVISIBLE_TESTS = INVISIBLE_RULES.map((rule) => ({ rule, re: new RegExp(rule.pattern.source) }));

const SURROGATE_HIGH = /[\uD800-\uDBFF]/;

/**
 * The scan behind `lintText` and `scanInvisible`. Lines end at CRLF, LF or a lone CR. A column counts code points, so a
 * character outside the BMP counts once. With a `limit`, at most that many findings are built (the first by position)
 * while every match is still counted, so a hostile file of millions of hidden characters costs time but not memory.
 * @returns {{findings: Finding[], total: number, errors: number}}
 */
function scanText(text, file, { rules = RULES, honorIgnore = true, limit = Infinity, references = false } = {}) {
  const findings = [];
  let total = 0;
  let errors = 0;
  text.split(/\r\n|\r|\n/).forEach((lineText, i) => {
    if (honorIgnore && lineText.includes(IGNORE_MARKER)) return;
    let codePoints = null;
    const column = (index) => {
      if (!SURROGATE_HIGH.test(lineText)) return index + 1;
      if (codePoints === null) {
        // Code points before each UTF-16 index, computed once for the line.
        codePoints = new Uint32Array(lineText.length + 1);
        let n = 0;
        for (let k = 0; k < lineText.length; k++) {
          codePoints[k] = n;
          const c = lineText.charCodeAt(k);
          const high = c >= 0xd800 && c <= 0xdbff && k + 1 < lineText.length && lineText.charCodeAt(k + 1) >= 0xdc00 && lineText.charCodeAt(k + 1) <= 0xdfff;
          if (high) {
            codePoints[k + 1] = n;
            k++;
          }
          n++;
        }
        codePoints[lineText.length] = n;
      }
      return codePoints[index] + 1;
    };
    const line = [];
    for (const rule of rules) {
      let perRule = 0;
      for (const m of lineText.matchAll(rule.pattern)) {
        if (rule.applies !== undefined && !rule.applies(m, i + 1)) continue;
        total++;
        if (rule.severity === 'error') errors++;
        if (++perRule > limit || findings.length + line.length >= limit) continue;
        const finding = {
          file,
          line: i + 1,
          column: column(m.index),
          rule: rule.id,
          severity: rule.severity,
          message: typeof rule.message === 'function' ? rule.message(m) : rule.message,
        };
        if (rule.invisible) finding.codePoint = codePointOf(m[0]);
        line.push(finding);
      }
    }
    if (references) {
      for (const m of lineText.matchAll(CHAR_REFERENCE)) {
        const cp = m[1] !== undefined ? Number.parseInt(m[1], 16) : Number.parseInt(m[2], 10);
        if (!(cp > 0 && cp <= 0x10ffff)) continue;
        const char = String.fromCodePoint(cp);
        // `lineNo` 0: a reference is never the BOM at the start of a file.
        const hit = INVISIBLE_TESTS.find(({ rule: r, re }) => re.test(char) && (r.applies === undefined || r.applies({ 0: char, index: 0 }, 0)));
        if (hit === undefined) continue;
        const rule = hit.rule;
        total++;
        if (rule.severity === 'error') errors++;
        if (findings.length + line.length >= limit) continue;
        line.push({
          file, line: i + 1, column: column(m.index), rule: rule.id, severity: rule.severity,
          message: `Character reference ${m[0]} decodes to a hidden character. ${typeof rule.message === 'function' ? rule.message({ 0: char }) : rule.message}`,
          codePoint: codePointOf(char),
        });
      }
    }
    line.sort((a, b) => a.column - b.column);
    findings.push(...line);
  });
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return { findings, total, errors };
}

/**
 * Lint one text, line by line. Lines carrying the ignore marker are skipped (unless `honorIgnore` is false).
 * A finding of an invisible-Unicode rule also carries the `codePoint` (`U+202E`).
 * @param {string} text
 * @param {string} file
 * @param {{rules?: typeof RULES, honorIgnore?: boolean}} [options]
 * @returns {Finding[]}
 */
export function lintText(text, file, { rules = RULES, honorIgnore = true } = {}) {
  return scanText(text, file, { rules, honorIgnore }).findings;
}

/**
 * Only the invisible-Unicode findings of a text. A client's file cannot exempt itself, so the ignore marker does not
 * count here. With `references`, numeric character references (`&#x202E;`) to hidden characters are decoded and reported
 * at the reference (for html and xml). With `limit`, only the first findings are built, and `total` and `errors` (on the returned array) count
 * every match.
 * @param {string} text
 * @param {string} file
 * @param {{limit?: number, references?: boolean}} [options]
 * @returns {Finding[] & {total?: number, errors?: number}}
 */
export function scanInvisible(text, file, { limit, references = false } = {}) {
  const r = scanText(text, file, { rules: INVISIBLE_RULES, honorIgnore: false, limit, references });
  return Object.assign(r.findings, { total: r.total, errors: r.errors });
}

/**
 * Lint files and directories. Paths are relative to root; findings are too.
 * Directories are walked for known text extensions. tests/fixtures/ and generated lock files are skipped.
 * @param {string} root
 * @param {string[]} paths
 * @returns {Finding[]}
 */
export function lintFiles(root, paths) {
  const findings = [];
  for (const p of paths) {
    const base = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const isDir = statSync(join(root, base)).isDirectory();
    const rels = isDir
      ? listFiles(join(root, base), { exts: SCANNED_EXTS }).map((r) =>
          base === '' || base === '.' ? r : `${base}/${r}`,
        )
      : [base];
    for (const rel of rels) {
      if (rel === 'package-lock.json' || rel.endsWith('/package-lock.json')) continue;
      if (rel === 'tests/fixtures' || rel.startsWith('tests/fixtures/')) continue;
      findings.push(...lintText(readFileSync(join(root, rel), 'utf8'), rel));
    }
  }
  return findings;
}
