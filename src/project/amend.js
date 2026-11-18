import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from '../files.js';
import { extractCitations } from '../index/extract.js';

/** @typedef {{file: string, line: number, id: string}} Impact */

const DELIVERABLES = 'docs/deliverables/';

/** The Markdown files of a project that can hold a citation: all but INDEX.md and the rendered deliverables. */
function sources(root) {
  return listFiles(root, { exts: ['.md'] }).filter((f) => f !== 'INDEX.md' && !f.startsWith(DELIVERABLES));
}

/**
 * Where the given IDs are cited. Every `.md` file under `root` is read, except `INDEX.md`, `docs/deliverables`,
 * `.git` and `node_modules`. Code blocks, inline code, front matter and definitions do not count as citations.
 * @param {string[]} ids IDs to look for, for example `['FR-LN-01', 'DEC-02']`
 * @param {string} root project folder
 * @param {{lots?: string[]}} [options] backlog lots of the project, so `<LOT>-NN` IDs are recognised
 * @returns {Impact[]} sorted by file, line and id
 */
export function impactOf(ids, root, options = {}) {
  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  const found = [];
  for (const file of sources(root)) {
    const md = readFileSync(join(root, file), 'utf8');
    for (const c of extractCitations(md, file, options)) {
      if (wanted.has(c.id)) found.push({ file, line: c.line, id: c.id });
    }
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return found.sort((a, b) => order(a.file, b.file) || a.line - b.line || order(a.id, b.id));
}
