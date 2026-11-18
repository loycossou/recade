import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const ALWAYS_IGNORED = ['.git', 'node_modules', '.superpowers'];

/**
 * List files under root, as sorted relative paths with forward slashes.
 * A directory or file is skipped when its name matches an entry of `ignore`
 * or one of the always-ignored names. With `exts`, only those extensions are kept.
 * @param {string} root
 * @param {{exts?: string[], ignore?: string[]}} [options]
 * @returns {string[]}
 */
export function listFiles(root, { exts = [], ignore = [] } = {}) {
  const skip = new Set([...ALWAYS_IGNORED, ...ignore]);
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile() && (exts.length === 0 || exts.includes(extname(entry.name)))) {
        found.push(rel);
      }
    }
  };
  walk('', '');
  return found.sort();
}
