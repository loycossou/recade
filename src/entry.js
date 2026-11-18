import { readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml',
  'build.gradle', 'composer.json', 'Gemfile', 'src',
];
const DOC_EXTS = new Set(['.docx', '.pdf', '.xlsx', '.pptx', '.md']);

/**
 * How a project starts: `adopt` an existing code base, `from-docs` when documents
 * are present, `new` otherwise.
 * @param {string} dir
 * @param {{readdir?: (dir: string) => string[], exists?: (path: string) => boolean}} [fs]
 * @returns {'adopt'|'from-docs'|'new'}
 */
export function detectEntryMode(dir, { readdir = readdirSync, exists = existsSync } = {}) {
  if (exists(join(dir, '.git')) && PROJECT_MARKERS.some((m) => exists(join(dir, m)))) {
    return 'adopt';
  }
  let names;
  try {
    names = readdir(dir);
  } catch {
    return 'new';
  }
  const hasDocs = names.some((name) => {
    const lower = name.toLowerCase();
    return DOC_EXTS.has(extname(lower)) && lower !== 'readme.md';
  });
  return hasDocs ? 'from-docs' : 'new';
}
