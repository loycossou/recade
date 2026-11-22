import { mkdirSync, readdirSync, copyFileSync, writeFileSync, appendFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { initState, saveState } from '../state.js';
import { assertParent, createWorkspace, workspaceDir } from '../workspace/layout.js';
import { scanAttachments, formatFinding } from '../style/attachments.js';
import { normalizeState } from './state.js';
import { fillTemplate, readTemplate, yamlQuoted, localToday } from './template.js';
import { emptyRegister } from './provisionals.js';

export { fillTemplate };

/** File types Recade can read. Anything else goes to the gap list. */
export const SUPPORTED = Object.freeze(['.md', '.markdown', '.txt', '.docx', '.pdf', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.svg']);

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const SKIPPED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Files above this size are copied but kept out of Git. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * A folder name from a project name: lower case, accents folded, other characters turned into hyphens.
 * @param {string} name
 * @returns {string} empty when the name holds no letter or digit
 */
export function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const isEmptyDir = (dir) => readdirSync(dir).length === 0;

/**
 * Every regular file under `dir` as sorted relative paths with forward slashes, and the symbolic links met
 * on the way (not followed). Office lock files (`~$*`) and OS litter are left out.
 */
function walkFiles(dir) {
  const files = [];
  const links = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) links.push(path);
      else if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && !SKIPPED_FILES.has(entry.name) && !entry.name.startsWith('~$')) {
        files.push(path);
      }
    }
  };
  walk('');
  return { files: files.sort(), links: links.sort() };
}

/** A path as a root-anchored `.gitignore` line. */
const ignoreLine = (rel) => `/intake/attachments/${rel.replace(/[\\*?[\]#!]/g, '\\$&').replace(/ +$/, (m) => m.replaceAll(' ', '\\ '))}`;

function gapsText(project, language, date, { unsupported, links, large, maxBytes, invisible = [] }) {
  const section = (title, intro, items) => (items.length === 0 ? [] : [`## ${title}`, '', intro, '', ...items.map((f) => `- ${f}`), '']);
  return [
    '---',
    'doc_id: GAPS',
    `title: "${yamlQuoted(project)}, intake gaps"`,
    `project: "${yamlQuoted(project)}"`,
    'version: "0.1"',
    `date: "${date}"`,
    'status: open',
    `language: "${language}"`,
    '---',
    '',
    ...section('Intake scan',
      'BLOCKING. These client files hold characters nobody can see, or that reorder text, or could not be checked at all. No agent reads a listed file until the characters are removed, the client gives a clean copy, or the owner accepts the finding.',
      invisible.map((f) => `BLOCKING: ${formatFinding(f)}`)),
    ...section('Unsupported files',
      'Recade cannot read these files. Convert each one to a supported type (md, txt, docx, pdf, xlsx, pptx, png, jpg, svg) and add it to `intake/attachments/`, or say what it holds.',
      unsupported),
    ...section('Skipped links',
      'These are symbolic links. They were not followed and not copied. Copy the real files into `intake/attachments/`.',
      links),
    ...section('Large files',
      `These files are over ${Math.round(maxBytes / (1024 * 1024))} MB. They are in \`intake/attachments/\` but listed in \`.gitignore\`, so Git does not store them. Keep a copy elsewhere.`,
      large),
  ].join('\n');
}

/**
 * Create the workspace of a new project, `<root>/<slug>-workspace` (see `createWorkspace`): the tree, `git init`,
 * `.gitignore`, a normalised `recade/state.yaml`
 * (phase 0, every gate open), the questionnaire and the provisional register. With `from`, the supported
 * files of that folder are copied into `intake/attachments/` under the same relative paths; the others are
 * not copied and are listed in `intake/gaps.md`, with the symbolic links skipped and the files over `maxBytes`
 * (those are copied but kept out of Git). If anything fails, what this call created is removed.
 * @param {string} name working name of the project; the result's `dir` is the workspace
 * @param {{root: string, mode: 'scratch'|'from-docs'|'adopt', from?: string, config: {voice: string, languages: object},
 *   exec: (cmd: string, args: string[]) => Promise<{code: number, stderr: string}>, today?: string, maxBytes?: number}} options
 * @returns {Promise<{dir: string, copied: string[], unsupported: string[], links: string[], large: string[], invisible: object[]}>}
 */
export async function createProject(name, { root, mode, from, config, exec, today = localToday(), maxBytes = MAX_BYTES }) {
  assertParent(root);
  const slug = slugify(name);
  if (slug === '') throw new Error(`Invalid project name: "${name}". Use at least one letter or digit.`);
  const dir = workspaceDir(root, slug);
  const existed = existsSync(dir);
  if (existed && !isEmptyDir(dir)) {
    throw new Error(`The folder ${dir} already exists and is not empty. Choose another name.`);
  }
  let found = { files: [], links: [] };
  if (from !== undefined) {
    try {
      if (!statSync(from).isDirectory()) throw new Error('not a folder');
      found = walkFiles(from);
    } catch (err) {
      throw new Error(`Cannot read the folder ${from}: ${String(err.message).split('\n')[0]}`);
    }
  }
  const initial = initState(dir, { mode }, config);
  // `started` is the first day of the project: the metric "time to first slice" counts from it.
  const state = normalizeState({ version: initial.version, kind: 'workspace', ...initial, started: today });
  const probe = await exec('git', ['--version']);
  if (probe.code !== 0) throw new Error('Git is not installed or not on the PATH. Install Git, then run this again.');

  try {
    return await build({ root, slug, dir, name, from, config, exec, today, maxBytes, found, state });
  } catch (err) {
    if (existed) for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    else rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

async function build({ root, slug, dir, name, from, config, exec, today, maxBytes, found, state }) {
  const language = config.languages.work;
  await createWorkspace(root, slug, { exec });
  saveState(dir, state);
  const values = { project: name, version: '0.1', date: today, language };
  writeFileSync(join(dir, 'intake', 'questionnaire.md'), fillTemplate(readTemplate('questionnaire.md'), values));
  writeFileSync(join(dir, 'intake', 'provisionals.md'), emptyRegister(fillTemplate(readTemplate('provisionals.md'), values)));

  const copied = [];
  const unsupported = [];
  const large = [];
  for (const rel of found.files) {
    if (!SUPPORTED.includes(extname(rel).toLowerCase())) {
      unsupported.push(rel);
      continue;
    }
    const target = join(dir, 'intake', 'attachments', rel);
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(join(from, rel), target);
    copied.push(rel);
    if (statSync(target).size > maxBytes) large.push(rel);
  }
  if (copied.length > 0) rmSync(join(dir, 'intake', 'attachments', '.gitkeep'), { force: true });
  const links = found.links;
  const invisible = scanAttachments(dir).findings;
  appendFileSync(join(dir, '.gitignore'), ['node_modules/', '.recade-cache/', 'intake/.provisionals.lock', 'decisions/.decisions.lock', 'spikes/', ...large.map(ignoreLine), ''].join('\n'));
  if (unsupported.length + links.length + large.length + invisible.filter((f) => f.severity === 'error').length > 0) {
    writeFileSync(join(dir, 'intake', 'gaps.md'), gapsText(name, language, today, { unsupported, links, large, maxBytes, invisible: invisible.filter((f) => f.severity === 'error') }));
  }
  await firstCommit(dir, exec);
  return { dir, copied, unsupported, links, large, invisible };
}

/**
 * Commit what was just created, so the workspace starts clean: every later Recade step commits its own files, and a
 * file that is dirty then was edited by someone else. Best effort: with no git identity a placeholder one is used for
 * this commit, and a failure leaves the files uncommitted.
 */
async function firstCommit(dir, exec) {
  const base = ['-C', dir, '-c', 'commit.gpgsign=false'];
  const tail = ['commit', '-q', '-m', 'chore: create the workspace'];
  try {
    const add = await exec('git', ['-C', dir, 'add', '-A']);
    if (add.code !== 0) return;
    const first = await exec('git', [...base, ...tail]);
    if (first.code !== 0) await exec('git', [...base, '-c', 'user.name=Recade', '-c', `user.email=${['noreply', 'recade.invalid'].join('@')}`, ...tail]);
  } catch {
    // the workspace is usable without its first commit
  }
}
