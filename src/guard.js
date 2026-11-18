/** @typedef {{file:string,line:number,column:number,rule:string,severity:'error'|'warn',message:string}} Finding */

const MESSAGE = 'Private name in a public file. Remove or replace it.';

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Flag every whole-word, case-insensitive occurrence of a private name.
 * The message never repeats the name, so logs stay clean.
 * @param {{path: string, text: string}[]} files
 * @param {string[]} names
 * @returns {Finding[]}
 */
export function scanForNames(files, names) {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return [];
  const body = clean.map(escapeRegExp).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, 'giu');
  const findings = [];
  for (const { path, text } of files) {
    text.split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        findings.push({
          file: path,
          line: i + 1,
          column: m.index + 1,
          rule: 'private-name',
          severity: 'error',
          message: MESSAGE,
        });
      }
    });
  }
  return findings;
}
