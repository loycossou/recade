import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontMatterLength } from '../frontmatter-lines.js';

const TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));

/** Read a template from the plugin's `templates/` folder. */
export const readTemplate = (name) => readFileSync(join(TEMPLATES, name), 'utf8');

export const yamlQuoted = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Today as YYYY-MM-DD, in local time. */
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const KEY = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Replace `{{key}}` in a template with the matching value. A key with no value is left as it is,
 * so a missing answer shows up in the document instead of vanishing. In the front matter, a value
 * that sits inside a double-quoted YAML string gets its backslashes and double quotes escaped; the
 * body is never escaped.
 * @param {string} text
 * @param {Record<string, string|number>} values
 * @returns {string}
 */
export function fillTemplate(text, values) {
  const has = (key) => Object.hasOwn(values, key) && values[key] !== undefined && values[key] !== null;
  const lines = text.split('\n');
  const front = frontMatterLength(lines);
  return lines
    .map((line, i) =>
      line.replace(KEY, (whole, key, offset) => {
        if (!has(key)) return whole;
        const value = String(values[key]);
        if (i >= front) return value;
        const quotes = (line.slice(0, offset).match(/"/g) ?? []).length;
        return quotes % 2 === 1 ? yamlQuoted(value) : value;
      }),
    )
    .join('\n');
}
