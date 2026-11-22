#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { DEFAULT_BUDGETS } from '../src/budgets.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { normalizeState } from '../src/project/state.js';

/**
 * Shared blocks: one source for a rule that many prompt files repeat.
 *
 * A source is `tools/shared/<name>.md`, one block per file. A prompt file holds the block between two markers:
 * `<!-- shared:<name> -->` and `<!-- /shared:<name> -->`. Inline, the text sits right between the markers, inside a
 * sentence or a line. On lines of its own, the opening marker ends its line and the closing marker starts its line.
 * A `generated:<name>` block works the same way, with a text built from the code (the defaults table of the design).
 * This tool rewrites every block from its source; `--check` only reports the drift.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SHARED_DIR = 'tools/shared';
/** The folders and files scanned for markers. */
export const SCANNED = ['commands', 'agents', 'harness', 'skills', 'templates', 'docs', 'README.md'];
const MARKER = /<!-- (\/?)(shared|generated):([a-z0-9]+(?:-[a-z0-9]+)*) -->/g;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/** The sources of the shared blocks, by name, without the final newline of the file. */
export function loadSources(root = ROOT) {
  const dir = join(root, SHARED_DIR);
  const sources = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    sources.set(file.slice(0, -3), readFileSync(join(dir, file), 'utf8').replace(/\r?\n$/, ''));
  }
  return sources;
}

/** Every Markdown file under the scanned paths, relative to `root`, with forward slashes. */
export function markdownFiles(root = ROOT) {
  const out = [];
  const walk = (abs) => {
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs).sort()) if (entry !== 'node_modules' && entry !== 'vendor') walk(join(abs, entry));
    } else if (abs.endsWith('.md')) {
      out.push(relative(root, abs).split('\\').join('/'));
    }
  };
  for (const path of SCANNED) walk(join(root, path));
  return out;
}

/** The text without its block markers, as a reader sees it: for checks that anchor a pattern at a line or a list item. */
export const stripMarkers = (text) => text.replace(/<!-- \/?(?:shared|generated):[a-z0-9]+(?:-[a-z0-9]+)* -->/g, '');

/** The display name of a model id: `claude-opus-5-5` is `Opus 5.5`. Another value is returned as it is. */
export function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  return m === null ? id : `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

/** The word budgets as the documents write them: `D1 10,000, D2 9,000`. */
export const budgetsText = (budgets) => Object.entries(budgets).map(([doc, words]) => `${doc} ${words.toLocaleString('en-US')}`).join(', ');

/** The defaults that the documents state, read from the code. */
export function codeDefaults(root = ROOT) {
  const state = normalizeState({});
  const models = parse(readFileSync(join(root, 'harness/models.yaml'), 'utf8'));
  const lanes = models.agents['second-opinion'];
  return {
    writer: DEFAULT_CONFIG.models.writer,
    slicing: state.slicing,
    secondOpinion: state.second_opinion,
    budgets: { ...DEFAULT_BUDGETS },
    secondOpinionModel: { standard: lanes.standard.model, sensitive: lanes.sensitive.model },
  };
}

function defaultsTable(root) {
  const d = codeDefaults(root);
  const so = d.secondOpinionModel;
  const model = so.standard === so.sensitive
    ? `\`${so.standard}\` (${modelName(so.standard)})`
    : `\`${so.standard}\` (${modelName(so.standard)}), \`${so.sensitive}\` (${modelName(so.sensitive)}) in the \`sensitive\` lane`;
  return [
    '| Setting | Default | Set in |',
    '|---|---|---|',
    `| \`models.writer\`, in the user config | \`${d.writer}\` | \`src/config.js\` |`,
    `| \`models.second_opinion\`, in the user config | \`${DEFAULT_CONFIG.models.second_opinion}\` (\`fable\` puts the project copy on Fable 5.2) | \`src/config.js\` |`,
    `| \`slicing\`, in \`recade/state.yaml\` | \`${d.slicing}\` | \`src/project/state.js\` |`,
    `| \`second_opinion\`, in \`recade/state.yaml\` | \`${d.secondOpinion}\` | \`src/project/state.js\` |`,
    `| \`budgets\`, in \`recade/state.yaml\`, in words | ${budgetsText(d.budgets)} | \`src/budgets.js\` |`,
    `| The model of the \`second-opinion\` agent | ${model} | \`harness/models.yaml\` |`,
  ].join('\n');
}

/** The builders of the `generated:` blocks. */
export const GENERATED = { defaults: defaultsTable };

/**
 * The blocks of one file. A block is `{kind, name, start, end, inner, inline}`: `start` and `end` bound the text between
 * its markers. An error is a string with the line of the marker.
 * @param {string} text
 */
export function parseBlocks(text) {
  const blocks = [];
  const errors = [];
  const front = FRONT_MATTER.exec(text)?.[0].length ?? 0;
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  let open = null;
  for (const m of text.matchAll(MARKER)) {
    const [marker, slash, kind, name] = m;
    const where = `line ${lineOf(m.index)}`;
    if (m.index < front) {
      errors.push(`${where}: marker ${kind}:${name} in the front matter`);
      continue;
    }
    if (slash === '') {
      if (open !== null) {
        errors.push(`${where}: ${kind}:${name} opens inside ${open.kind}:${open.name}, opened on line ${lineOf(open.index)}`);
        continue;
      }
      open = { kind, name, index: m.index, after: m.index + marker.length };
      continue;
    }
    if (open === null || open.kind !== kind || open.name !== name) {
      errors.push(`${where}: /${kind}:${name} closes ${open === null ? 'no block' : `${open.kind}:${open.name}`}`);
      continue;
    }
    const inner = text.slice(open.after, m.index);
    blocks.push({ kind, name, start: open.after, end: m.index, inner, inline: !inner.startsWith('\n') });
    open = null;
  }
  if (open !== null) errors.push(`line ${lineOf(open.index)}: ${open.kind}:${open.name} is never closed`);
  return { blocks, errors };
}

/** The text a block must hold, or null when its name has no source. */
function expected(block, sources, root) {
  let body;
  if (block.kind === 'shared') body = sources.get(block.name);
  else body = Object.hasOwn(GENERATED, block.name) ? GENERATED[block.name](root) : undefined;
  if (body === undefined) return null;
  return block.inline ? body : `\n${body}\n`;
}

/**
 * Rewrite every block of every scanned file from its source. With `check`, nothing is written.
 * @param {string} [root]
 * @param {{check?: boolean}} [options]
 * @returns {{changed: string[], errors: string[], uses: Map<string, string[]>}} `changed`: the files that differ (or
 *   differed); `uses`: for each shared block, the files that hold it.
 */
export function syncShared(root = ROOT, { check = false } = {}) {
  const sources = loadSources(root);
  const changed = [];
  const errors = [];
  const uses = new Map([...sources.keys()].map((n) => [n, []]));
  for (const [name, body] of sources) {
    if (!NAME.test(name)) errors.push(`${SHARED_DIR}/${name}.md: "${name}" is not a block name`);
    if (body.trim() === '') errors.push(`${SHARED_DIR}/${name}.md: empty source`);
    if (MARKER.test(body)) errors.push(`${SHARED_DIR}/${name}.md: a source holds no marker`);
    MARKER.lastIndex = 0;
  }
  for (const file of markdownFiles(root)) {
    if (file.startsWith(`${SHARED_DIR}/`)) continue;
    const text = readFileSync(join(root, file), 'utf8');
    const parsed = parseBlocks(text);
    errors.push(...parsed.errors.map((e) => `${file}: ${e}`));
    if (parsed.errors.length > 0) continue;
    let next = '';
    let at = 0;
    for (const block of parsed.blocks) {
      const want = expected(block, sources, root);
      if (want === null) {
        errors.push(`${file}: ${block.kind}:${block.name} has no source`);
        continue;
      }
      if (block.kind === 'shared') uses.get(block.name).push(file);
      if (!block.inline && !block.inner.endsWith('\n')) errors.push(`${file}: /${block.kind}:${block.name} must start its line, as its block starts on a line of its own`);
      next += text.slice(at, block.start) + want;
      at = block.end;
    }
    next += text.slice(at);
    if (next === text) continue;
    changed.push(file);
    if (!check) writeFileSync(join(root, file), next);
  }
  return { changed, errors, uses };
}

const USAGE = 'Usage: node tools/sync-shared.js [--check]';

function main(argv) {
  if (argv.some((a) => a !== '--check')) {
    console.error(USAGE);
    return 2;
  }
  const check = argv.includes('--check');
  const { changed, errors } = syncShared(ROOT, { check });
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    return 2;
  }
  if (changed.length === 0) {
    console.log('Shared blocks are in sync.');
    return 0;
  }
  if (check) {
    console.error(`Out of sync with ${SHARED_DIR} or the code defaults: ${changed.join(', ')}. Run node tools/sync-shared.js.`);
    return 1;
  }
  console.log(`Updated: ${changed.join(', ')}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
