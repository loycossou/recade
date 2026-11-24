import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontMatterLength } from '../frontmatter-lines.js';

export const START = '<!-- recade:generated:start -->';
export const END = '<!-- recade:generated:end -->';

/** Folders that are generated or vendored: never part of the layout. */
const SKIPPED_DIRS = new Set([
  '.git', '.recade', '.superpowers', 'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target',
  '.next', '.nuxt', '.svelte-kit', '.cache', '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.vscode',
]);

/** The rows of the harness tech sheet that become commands, as they are named in the table. */
const COMMANDS = ['Build', 'Test', 'Lint'];
const CONVENTIONS = 'Conventions';
/** A value that is still the template's example, not a decision of the team. */
const PLACEHOLDER = /^example:/i;
const SHEET_HEADING = /^#{1,6}\s+(?:\d+\.\s*)?harness tech(?:nical)? sheet\b/i;

const readRegular = (file) => {
  try {
    return lstatSync(file).isFile() ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
};

/**
 * The STACK.md the harness reads in `root`: `docs/STACK.md` of the workspace, in every mode (there is no `docs/recade/`).
 * @param {string} root workspace folder
 * @returns {{file: string, text: string}|null} the path relative to `root`, and the text; null when there is none
 */
export function findStack(root) {
  const own = readRegular(join(root, 'docs', 'STACK.md'));
  return own === null ? null : { file: 'docs/STACK.md', text: own };
}

/** The text of the STACK.md of `root` (see findStack), or null. */
export const readStack = (root) => findStack(root)?.text ?? null;

/** Split a table row on the pipes that are outside backticks, so a command such as `a | b` stays whole. */
function splitCells(text) {
  const cells = [];
  let cell = '';
  let ticks = false;
  for (const ch of text) {
    if (ch === '`') ticks = !ticks;
    if (ch === '|' && !ticks) {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** The rows of one table line, or null when the line is not a row of an `Item | Value` table. */
function rowOf(line) {
  const cells = line.match(/^\s*\|(.*)\|\s*$/) ? splitCells(line.trim().slice(1, -1)) : undefined;
  if (cells === undefined || cells.length < 2 || /^:?-+:?$/.test(cells[0])) return null;
  const value = cells[1].replace(/^`+|`+$/g, '').trim();
  return value !== '' && !PLACEHOLDER.test(value) ? [cells[0].toLowerCase(), value] : null;
}

/**
 * The `Item | Value` rows of the harness tech sheet of a STACK.md, with the backticks of the value removed.
 *
 * With a repository, the sheet may hold one table per code repository, each under a sub-heading that is the name of the
 * repository (`### api`): that table is read, and it replaces the shared one, it is not merged into it. A repository with
 * no table of its own reads the table right under the heading of the sheet, if there is one. Without a repository, only
 * that table is read, as before.
 * @param {string|null|undefined} stack
 * @param {string} [repo] the name of a code repository
 * @returns {Map<string, string>} empty when there is no sheet, or no table for that repository
 */
export function techSheet(stack, repo) {
  const shared = new Map();
  if (typeof stack !== 'string') return shared;
  const lines = stack.split(/\r?\n/);
  const start = lines.findIndex((l) => SHEET_HEADING.test(l));
  if (start === -1) return shared;
  const level = /^#+/.exec(lines[start])[0].length;
  /** @type {Map<string, Map<string, string>>} */
  const sections = new Map();
  let current = shared;
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      if (repo === undefined || heading[1].length <= level) break;
      const name = heading[2].replace(/`/g, '').trim().toLowerCase();
      if (!sections.has(name)) sections.set(name, new Map());
      current = sections.get(name);
      continue;
    }
    const row = rowOf(line);
    if (row !== null) current.set(row[0], row[1]);
  }
  return (repo === undefined ? undefined : sections.get(repo.toLowerCase())) ?? shared;
}

/**
 * The top two levels of the folders that Git tracks in `repo`, generated and vendored folders left out.
 * @param {string} repo
 * @returns {string[]|null} paths such as `src/` and `src/api/`, sorted; null when `repo` is not a Git repository
 */
function layout(repo) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const dirs = new Set();
  for (const file of r.stdout.split('\0')) {
    const parts = file.split('/').slice(0, -1);
    if (parts.length === 0 || SKIPPED_DIRS.has(parts[0])) continue;
    dirs.add(`${parts[0]}/`);
    if (parts.length > 1) dirs.add(`${parts[0]}/${parts[1]}/`);
  }
  return [...dirs].sort();
}

/**
 * The generated block, lines joined with `eol`, without a trailing newline.
 * `target` picks the shape: a code repository has the commands of its own table and points to the workspace, which holds
 * the documents (nothing private is named here, and no path of the machine); the workspace has no build to run and points
 * to the code repositories; with no target, the block of a project that is both, as before.
 */
function block(repo, stack, eol, stackFile, { target, name } = {}) {
  const sheet = techSheet(stack, target === 'code' ? name : undefined);
  const wanted = target === 'workspace' ? [] : [...COMMANDS, CONVENTIONS];
  const missing = wanted.filter((c) => !sheet.has(c.toLowerCase()));
  const lines = [START];
  if (target === 'workspace') {
    lines.push('## Repositories', '', 'The code lives in the code repositories under `repos/<name>/`. Their install, build, test and lint commands are in the stack sheet, section 12 of `docs/STACK.md`, one table for each repository.');
  } else {
    lines.push('## Commands', '');
    if (missing.length > 0) {
      lines.push(`<!-- TODO: fill the harness technical sheet (${target === 'code' ? stackFile : `last section of ${stackFile}`}), then run: recade claude-md refresh --write -->`);
    }
    for (const c of COMMANDS) lines.push(sheet.has(c.toLowerCase()) ? `- ${c}: \`${sheet.get(c.toLowerCase())}\`` : `- ${c}: TODO`);
    lines.push('', '## Conventions', '', sheet.get(CONVENTIONS.toLowerCase()) ?? 'TODO');
  }
  const dirs = layout(repo);
  lines.push('', '## Repository layout', '');
  if (dirs === null) lines.push('Not a git repository.');
  else if (dirs.length === 0) lines.push('No tracked folder yet.');
  else for (const d of dirs) lines.push(`- \`${d}\``);
  lines.push('', '## Pointers', '');
  if (target === 'code') {
    lines.push(
      '- The project documents (bible, slice sheets, decisions) are in the workspace of this project: `recade workspace root` prints its folder',
      `- Harness technical sheet of this repository: the table headed \`${name}\` in section 12 of the stack document of the workspace`,
      '- Slices are delivered from a session started at the root of the workspace, with `/slice <S-nn>`: the agents and the commands are there, and the worktree of a slice is `worktrees/<repo>/<S-nn>` of the workspace',
    );
  } else {
    lines.push(
      '- Project bible: `BIBLE.md`',
      `- Stack and harness technical sheet: \`${stackFile}\``,
      '- Slice table: `slices/STATUS.md`',
    );
  }
  lines.push(
    '- Harness protocol: `.claude/protocol.md`',
    '',
    'Rules written by hand go outside the two markers. Everything between them is regenerated by `recade claude-md refresh`.',
    END,
  );
  return { text: lines.join(eol), missing };
}

/** A line diff: `-` removed, `+` added, nothing for the lines that stay. Empty when the texts are equal. */
function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if (x.length === 0 && y.length === 0) return '';
  const lcs = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = ['--- CLAUDE.md', '+++ CLAUDE.md (refreshed)'];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(`  ${x[i]}`.replace(/\r$/, ''));
      i++;
      j++;
    } else if (j >= y.length || (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1])) out.push(`-${x[i++]}`.replace(/\r$/, ''));
    else out.push(`+${y[j++]}`.replace(/\r$/, ''));
  }
  return `${out.join('\n')}\n`;
}

const occurrences = (text, marker) => text.split(marker).length - 1;

/**
 * Refresh the generated block of `CLAUDE.md` in `repo`. Only the text between the two markers changes; the
 * rest stays byte for byte. Without markers the block is inserted once at the top (after a front matter).
 * The commands come from the harness tech sheet of `stack`; a missing sheet gives TODO lines, not an error.
 * The project state is accepted and never read: CLAUDE.md holds rules and pointers, never the state of the project.
 * Nothing is written to disk.
 * @param {string} repo project folder
 * @param {{stack?: string|null, state?: object, target?: 'workspace'|'code', repo?: string}} [input] `stack` is the text of
 *   docs/STACK.md (of the workspace, for a code repository); `target` and `repo` (the name of the code repository) pick the
 *   shape of the block, see `block`
 * @returns {{next: string, diff: string, missing: string[]}} the new file, the diff against the current one ('' when equal),
 *   and the tech sheet rows that are missing
 */
export function refresh(repo, { stack, target, repo: name } = {}) {
  stack = stack === undefined ? readStack(repo) : stack;
  const file = join(repo, 'CLAUDE.md');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const stackFile = target === 'code' ? 'the table of this repository in section 12 of the stack document of the workspace' : (findStack(repo)?.file ?? 'docs/STACK.md');
  const { text: generated, missing } = block(repo, stack, eol, stackFile, { target, name });
  const starts = occurrences(current, START);
  const ends = occurrences(current, END);
  let next;
  if (starts === 0 && ends === 0) {
    const lines = current.split('\n');
    const at = lines.slice(0, frontMatterLength(lines)).reduce((n, l) => n + l.length + 1, 0);
    next = `${current.slice(0, at)}${generated}${eol}${current.slice(at)}`;
  } else {
    const s = current.indexOf(START);
    const e = current.indexOf(END);
    if (starts !== 1 || ends !== 1 || e < s) {
      throw new Error(`CLAUDE.md needs exactly one ${START} followed by one ${END}. Fix the markers by hand, nothing was changed.`);
    }
    next = `${current.slice(0, s)}${generated}${current.slice(e + END.length)}`;
  }
  return { next, diff: next === current ? '' : lineDiff(current, next), missing };
}
