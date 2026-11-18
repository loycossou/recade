import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { AdoptError, ownFile, writeOwnFile } from './adopt.js';
import { scan } from './inventory.js';
import { readTemplate } from './template.js';
import { loadState } from '../state.js';
import { listRepos } from '../workspace/repos.js';

/**
 * Documents from the code of the adopted repositories (spec sections 4.1 and 6.15, plan 5b task 9). It runs on the
 * workspace: `fromCode` reads every repository of the registry under `repos/<name>/`, lists the documents to write in
 * `docs/` of the workspace (RULES, INVARIANTS and CONTRACTS, or D1 to D3 with `full`), copies the documents each
 * repository already holds under `docs/source/<repo>/` (never rewriting them, one index for all) and checks the shape of
 * what the code reader wrote. A path a document cites for code is relative to the workspace, so it starts with
 * `repos/<name>/`. The checks (`readingTier`, `decideConvention`, `checkRules`, `checkInvariants`, `checkRegister`) are pure.
 */

/** The folder of the copies of the existing documents; each repository has its own folder below it. */
export const SOURCE_DIR = 'docs/source';
/** The folder of the copies of the documents of the repository `name`. */
export const sourceDir = (name) => `${SOURCE_DIR}/${name}`;
const INDEX = `${SOURCE_DIR}/INDEX.md`;
/** Largest existing document that is copied, in bytes. A larger one is a gap: it is read in place. */
export const MAX_SOURCE_BYTES = 512 * 1024;

export const RULES_SECTIONS = Object.freeze(['Golden files', 'Rules', 'DONTs']);
export const INVARIANT_SECTIONS = Object.freeze(['Requirements', 'Invariants']);
export const CONTRACT_SECTIONS = Object.freeze(['Interfaces', 'Data shapes', 'Integrations']);
/** The four axes of the deviations register. */
export const AXES = Object.freeze(['unwritten reasoning', 'practice', 'missing capability', 'technical choice']);
const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
const EFFORTS = ['S', 'M', 'L'];
/** Where the deviations register may live, in the order it is looked for. */
export const REGISTER_FILES = Object.freeze(['docs/inventory.md']);

const RULES_DOC = 'docs/RULES.md';
const INVARIANTS_DOC = 'docs/INVARIANTS.md';
const CONTRACTS_DOC = 'docs/CONTRACTS.md';

// ---- reading tier and conventions ----

/**
 * How much of the code is read, by the number of source files: under 50 all of it, 50 to 500 a sample, over 500
 * the entry points first and one level down, at most 15 files for each capability. Unread files are listed as `deferred`.
 * @param {number} files
 * @returns {{tier: 'all'|'sample'|'entry-points', files: number, maxFilesPerCapability: number|null}}
 */
export function readingTier(files) {
  if (files < 50) return { tier: 'all', files, maxFilesPerCapability: null };
  if (files <= 500) return { tier: 'sample', files, maxFilesPerCapability: null };
  return { tier: 'entry-points', files, maxFilesPerCapability: 15 };
}

/**
 * One convention seen in the code: `rule` when the pattern is followed by over 95 percent, or when fewer than 10 files
 * go against it and it still holds at least 80 percent (the minority becomes a DONT, no question asked). Anything
 * else, a tie or a close split included, is `ask`: one owner question with file:line evidence.
 * @param {{followers: number, counter: number}} counts files that follow the pattern, files that do not
 * @returns {'rule'|'ask'}
 */
export function decideConvention({ followers, counter }) {
  const total = followers + counter;
  if (total === 0 || followers <= counter) return 'ask';
  const ratio = followers / total;
  if (ratio > 0.95) return 'rule';
  return counter < 10 && ratio >= 0.8 ? 'rule' : 'ask';
}

// ---- pure shape checks ----

/** The level 2 sections of a Markdown text: title and body, in order. */
function sectionsOf(text) {
  const out = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = { title: m[1], lines: [] };
      out.push(current);
    } else if (current !== null) current.lines.push(line);
  }
  return out.map((s) => ({ title: s.title, body: s.lines.join('\n') }));
}

const sameTitle = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Gaps for the sections `wanted` of `text`: each missing one, and the order when all are there. */
function sectionGaps(text, wanted, file) {
  const found = sectionsOf(text);
  const gaps = [];
  const at = wanted.map((w) => found.findIndex((s) => sameTitle(s.title, w)));
  wanted.forEach((w, i) => {
    if (at[i] < 0) gaps.push(`${file}: the section "${w}" is missing.`);
  });
  if (at.every((i) => i >= 0) && at.some((v, i) => i > 0 && v < at[i - 1])) gaps.push(`${file}: the sections must come in this order: ${wanted.join(', ')}.`);
  return gaps;
}

/**
 * RULES.md: the sections "Golden files" (exemplar files, each `- \`path\`: one line on why`), "Rules" and "DONTs", in that order.
 * @param {string} text
 * @param {{file?: string, exists?: (path: string) => boolean}} [options] `exists` also checks that each exemplar is a real file
 * @returns {string[]} one line per gap
 */
export function checkRules(text, { file = RULES_DOC, exists } = {}) {
  const gaps = sectionGaps(text, RULES_SECTIONS, file);
  const golden = sectionsOf(text).find((s) => sameTitle(s.title, RULES_SECTIONS[0]));
  if (golden !== undefined) {
    const items = golden.body.split(/\r?\n/).filter((l) => /^\s*[-*]\s/.test(l));
    if (items.length === 0) gaps.push(`${file}: the section "Golden files" lists no exemplar.`);
    for (const item of items) {
      const m = /^\s*[-*]\s+`([^`]+)`\s*:\s*\S/.exec(item);
      if (m === null) gaps.push(`${file}: Golden files entry without a path and a reason: "${item.trim().slice(0, 80)}".`);
      else if (exists !== undefined && !exists(m[1])) gaps.push(`${file}: exemplar ${m[1]} does not exist.`);
    }
  }
  return gaps;
}

/** Is `line` past the end of `path`? False when the number of lines is not known. */
const beyond = (lines, path, line) => {
  const n = lines === undefined ? null : lines(path);
  return n !== null && n !== undefined && line > n;
};

const ENFORCED = /^enforced:\s*(.*?)\s*$/im;

/**
 * INVARIANTS.md: sections "Requirements" and "Invariants". Each behaviour is a `### REQ-nn` requirement ("WHEN ... THEN ...")
 * or a `### INV-nn` invariant, and each has `enforced: test <path> | code <path:line> | no`.
 * @param {string} text
 * @param {{file?: string, exists?: (path: string) => boolean, lines?: (path: string) => number|null}} [options] `lines` gives the number of lines of a file, to check that a line is inside it
 * @returns {{gaps: string[], unenforced: string[], entries: {id: string, kind: 'REQ'|'INV', enforced: string|null}[]}}
 *   `unenforced` lists the invariants with `enforced: no`: each also becomes a row of the deviations register
 */
export function checkInvariants(text, { file = INVARIANTS_DOC, exists, lines } = {}) {
  const gaps = sectionGaps(text, INVARIANT_SECTIONS, file);
  const entries = [];
  const unenforced = [];
  const parts = String(text).split(/^###\s+/m).slice(1);
  for (const part of parts) {
    const partLines = part.split(/\r?\n/);
    const heading = partLines[0].trim();
    const body = partLines.slice(1).join('\n').replace(/^##\s[\s\S]*/m, '');
    const idm = /^(REQ|INV)-\d+/.exec(heading);
    if (idm === null) {
      gaps.push(`${file}: the heading "${heading.slice(0, 60)}" is neither a REQ-nn requirement nor an INV-nn invariant.`);
      continue;
    }
    const id = idm[0];
    const kind = idm[1];
    const em = ENFORCED.exec(body);
    const statement = body.replace(ENFORCED, '').trim();
    if (kind === 'REQ' && !/\bWHEN\b[\s\S]+\bTHEN\b[\s\S]*\S/.test(statement)) gaps.push(`${file}: ${id} is not a "WHEN ... THEN ..." requirement.`);
    if (kind === 'INV' && statement === '') gaps.push(`${file}: ${id} has no statement.`);
    if (em === null) {
      gaps.push(`${file}: ${id} has no "enforced:" line (test <path>, code <path:line> or no).`);
      entries.push({ id, kind, enforced: null });
      continue;
    }
    const value = em[1];
    entries.push({ id, kind, enforced: value });
    if (/^no$/i.test(value)) {
      if (kind === 'INV') unenforced.push(id);
    } else if (/^test\s+\S+$/.test(value)) {
      const path = value.replace(/^test\s+/, '');
      if (exists !== undefined && !exists(path)) gaps.push(`${file}: ${id} names the test ${path}, which does not exist.`);
    } else if (/^code\s+\S+$/.test(value)) {
      const m = /^code\s+(\S+):(\d+)$/.exec(value);
      if (m === null || Number(m[2]) < 1) gaps.push(`${file}: ${id}: "enforced: code" needs path:line, with a line of 1 or more.`);
      else if (exists !== undefined && !exists(m[1])) gaps.push(`${file}: ${id} names the file ${m[1]}, which does not exist.`);
      else if (beyond(lines, m[1], Number(m[2]))) gaps.push(`${file}: ${id} names ${m[1]}:${m[2]}, which is beyond the end of the file.`);
    } else {
      gaps.push(`${file}: ${id} has an invalid "enforced:" value "${value.slice(0, 60)}" (test <path>, code <path:line> or no).`);
    }
  }
  return { gaps, unenforced, entries };
}

const REF = /([\w@.][\w@./-]*):(\d+)/g;

/**
 * The deviations register: the table under `## Deviations` with the columns ID, Axis, Deviation, Evidence, Severity, Effort.
 * A row with no evidence (`path:line`) is refused, as is a row with an unknown axis, severity or effort.
 * @param {string} text
 * @param {{file?: string, exists?: (path: string) => boolean, lines?: (path: string) => number|null}} [options]
 * @returns {{found: boolean, rows: {id: string, axis: string, deviation: string, evidence: string[], severity: string, effort: string}[], gaps: string[]}}
 */
export function checkRegister(text, { file = 'docs/inventory.md', exists, lines } = {}) {
  const section = sectionsOf(text).find((s) => sameTitle(s.title, 'Deviations'));
  const result = { found: section !== undefined, rows: [], gaps: [] };
  if (section === undefined) return result;
  let header = false;
  for (const line of section.body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (/^id$/i.test(cells[0])) {
      header = true;
      const wanted = ['id', 'axis', 'deviation', 'evidence', 'severity', 'effort'];
      if (cells.length !== 6 || wanted.some((w, i) => cells[i].toLowerCase() !== w)) result.gaps.push(`${file}: the Deviations table needs the columns ID, Axis, Deviation, Evidence, Severity, Effort.`);
      continue;
    }
    if (!header) {
      result.gaps.push(`${file}: the Deviations table has no header row.`);
      header = true;
    }
    if (cells.length !== 6) {
      result.gaps.push(`${file}: a deviation row has ${cells.length} cells, it needs 6: "${t.slice(0, 60)}".`);
      continue;
    }
    const [id, axis, deviation, evidenceCell, severity, effort] = cells;
    const problems = [];
    if (!/^DEV-\d+$/.test(id)) problems.push('the ID is not DEV-nn');
    if (!AXES.includes(axis.toLowerCase())) problems.push(`unknown axis "${axis}" (use ${AXES.join(', ')})`);
    if (deviation === '') problems.push('no description');
    const refs = [...evidenceCell.replaceAll('`', '').matchAll(REF)].map((m) => `${m[1]}:${m[2]}`);
    if (refs.length === 0) problems.push('no evidence (file:line), the row is refused');
    else {
      for (const r of refs) {
        const [path, line] = [r.replace(/:\d+$/, ''), Number(r.replace(/^.*:/, ''))];
        if (line < 1) problems.push(`evidence ${r} has a line below 1`);
        else if (exists !== undefined && !exists(path)) problems.push(`evidence ${r} does not exist`);
        else if (beyond(lines, path, line)) problems.push(`evidence ${r} is beyond the end of the file`);
      }
    }
    if (!SEVERITIES.includes(severity)) problems.push(`unknown severity "${severity}" (use ${SEVERITIES.join(', ')})`);
    if (!EFFORTS.includes(effort)) problems.push(`unknown effort "${effort}" (use ${EFFORTS.join(', ')})`);
    if (problems.length > 0) result.gaps.push(`${file}: deviation ${id || '(no id)'}: ${problems.join('; ')}.`);
    else result.rows.push({ id, axis: axis.toLowerCase(), deviation, evidence: refs, severity, effort });
  }
  if (!header) result.gaps.push(`${file}: the Deviations table has no header row.`);
  return result;
}

// ---- files of the repository ----

const WALK_SKIP = new Set(['.git', 'node_modules', 'vendor', 'target', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.venv', 'venv', '__pycache__', '.tox', '.gradle', '.idea', '.cache', 'bower_components', '.recade', 'recade']);
const NOT_SOURCE = /\.(md|mdx|rst|adoc|txt|lock|map|svg|png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|eot|jar|class|so|dll|exe|wasm)$/i;
const LOCKS = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock', 'bun.lockb', 'uv.lock']);
const MAX_WALK = 50000;

/** The number of source files: no document, lock file, image, vendored or generated folder, no symbolic link. */
function countSourceFiles(repo) {
  let n = 0;
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(repo, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (n >= MAX_WALK) return;
      if (e.isSymbolicLink()) continue;
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!WALK_SKIP.has(e.name)) walk(path);
      } else if (e.isFile() && !NOT_SOURCE.test(e.name) && !LOCKS.has(e.name)) n++;
    }
  };
  walk('');
  return n;
}

const safeRead = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const NOT_INGESTED = /^(CHANGELOG|CODE_OF_CONDUCT|CLAUDE|AGENTS)(\.[A-Za-z]+)?$/;

/** Is this document of the code repository `repo` one to copy? Not one Recade created there, not a changelog or an agent instruction file. */
const ingestible = (repo, path) => !NOT_INGESTED.test(posix.basename(path)) && !ownFile(repo, path);

/** The IDs already given, from the index, as a map source path to {id, copy}. */
function readIndex(repo) {
  const out = new Map();
  const text = safeRead(join(repo, INDEX));
  if (text === null) return out;
  for (const m of text.matchAll(/^\|\s*(SRC-\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([0-9a-f]{64})\s*\|/gm)) {
    const removed = / \(removed\)$/.test(m[2]);
    out.set(m[2].replace(/ \(removed\)$/, ''), { id: m[1], copy: m[3], sha256: m[4], removed });
  }
  return out;
}

const indexText = (sources, removed = []) => [
  '---',
  'doc_id: SOURCE-INDEX',
  'title: "Documents found in the repository"',
  'status: generated',
  '---',
  '',
  '# Documents found in the repository',
  '',
  'Copies of the documents the repository already held when it was adopted. Recade never edits an original. Each document of Recade cites a copy by its ID. An ID is never given again: a document that disappeared keeps its row, marked removed.',
  '',
  '| ID | Source | Copy | sha256 |',
  '|---|---|---|---|',
  ...[...sources.map((s) => ({ ...s, label: s.path })), ...removed.map((s) => ({ ...s, label: `${s.path} (removed)` }))]
    .sort((a, b) => a.id.localeCompare(b.id)).map((s) => `| ${s.id} | ${s.label} | ${s.copy} | ${s.sha256} |`),
  '',
].join('\n');

/**
 * Copy the existing documents of each repository under `docs/source/<repo>/` of the workspace and keep the one index.
 * The originals are only read. `found` is a list of `{name, dir, docs}`: the repository, its folder, its documents.
 * A source is named by its path in the workspace (`repos/<name>/<path>`), so an ID is never shared by two repositories.
 * @returns {{sources: {id: string, repo: string, path: string, copy: string, sha256: string}[], removed: string[], gaps: string[]}}
 */
function ingest(ws, found) {
  const known = readIndex(ws);
  let next = Math.max(0, ...[...known.values()].map((v) => Number(v.id.slice(4)))) + 1;
  const sources = [];
  const gaps = [];
  for (const { name, dir, docs } of found) {
    for (const rel of docs) {
      const path = `repos/${name}/${rel}`;
      const abs = join(dir, rel);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_SOURCE_BYTES) {
        gaps.push(`${path} is too large to copy (over ${MAX_SOURCE_BYTES / 1024} KB): read it in place.`);
        continue;
      }
      const data = readFileSync(abs);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const copy = `${sourceDir(name)}/${rel}`;
      const id = known.get(path)?.id ?? `SRC-${String(next++).padStart(2, '0')}`;
      sources.push({ id, repo: name, path, copy, sha256 });
      const target = join(ws, copy);
      const present = existsSync(target);
      if (present && readFileSync(target).equals(data)) {
        if (!ownFile(ws, copy)) gaps.push(`${copy} exists and is not recorded as a Recade copy: kept as it is.`);
        continue;
      }
      if (present && !ownFile(ws, copy)) {
        gaps.push(`${copy} was edited since Recade copied it, or is not a Recade copy: kept as it is, ${path} is not copied again.`);
        continue;
      }
      try {
        writeOwnFile(ws, copy, data);
      } catch (err) {
        if (!(err instanceof AdoptError)) throw err;
        gaps.push(`${copy}: ${err.message}`);
      }
    }
  }
  sources.sort((a, b) => a.id.localeCompare(b.id));
  const now = new Set(sources.map((x) => x.path));
  const removed = [...known].filter(([path]) => !now.has(path)).map(([path, v]) => ({ id: v.id, path, copy: v.copy, sha256: v.sha256 }));
  const text = indexText(sources, removed);
  if ((sources.length > 0 || removed.length > 0) && safeRead(join(ws, INDEX)) !== text) {
    try {
      writeOwnFile(ws, INDEX, text);
    } catch (err) {
      if (!(err instanceof AdoptError)) throw err;
      gaps.push(`${INDEX}: ${err.message}`);
    }
  }
  return { sources, removed: removed.map((x) => x.id), gaps };
}

/** The `## ` titles of a template. */
const templateSections = (name) => readTemplate(name).split('\n').filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim());

/**
 * The documents to write from the code, the existing documents ingested, and the gaps found in what is already written.
 * `ws` is the workspace. Without `full` the targets are `docs/RULES.md`, `INVARIANTS.md` and `CONTRACTS.md`; with `full`,
 * `docs/D1.md`, `D2.md` and `D3.md`. Existing documents of each registered repository are copied under
 * `docs/source/<repo>/` with an ID (`SRC-nn`) and never rewritten; each target must cite them by ID.
 * A gap is a file that exists and breaks a shape, a source that could not be copied, a repository of the registry whose
 * folder is missing, or a target that cites no source.
 * @param {string} ws
 * @param {{full?: boolean, exec?: (cmd: string, args: string[]) => Promise<{code: number, stdout?: string}>, fileCount?: number}} [options]
 *   `fileCount` replaces the count of source files (tests)
 * @returns {Promise<{targets: {doc: string, sections: string[], exists: boolean, cites: string[]}[], sources: {id: string, repo: string, path: string, copy: string, sha256: string}[],
 *   gaps: string[], reading: ReturnType<typeof readingTier>, register: {file: string, rows: object[]}|null, repos: string[]}>}
 */
export async function fromCode(ws, { full = false, exec, fileCount } = {}) {
  const gaps = [];
  const found = [];
  let state = null;
  try {
    state = loadState(ws);
  } catch {
    state = null;
  }
  const registered = state === null ? [] : listRepos(ws);
  if (registered.length === 0) gaps.push('There is no code repository in the registry: add one with recade repo add, or adopt again.');
  let files = 0;
  for (const { name } of registered) {
    const dir = join(ws, 'repos', name);
    let isDir = false;
    try {
      isDir = lstatSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      gaps.push(`The repository ${name} is in the registry but repos/${name} is missing: run recade repo sync.`);
      continue;
    }
    const inventory = await scan(dir, exec === undefined ? {} : { exec });
    found.push({ name, dir, docs: inventory.docs.filter((d) => ingestible(dir, d)) });
    files += countSourceFiles(dir);
  }
  const { sources, removed, gaps: copyGaps } = ingest(ws, found);
  gaps.push(...copyGaps);
  const ids = sources.map((s) => s.id);
  const exists = (p) => !p.split('/').includes('..') && !p.startsWith('/') && existsSync(join(ws, p));
  const counts = new Map();
  const lines = (p) => {
    if (!counts.has(p)) {
      const text = exists(p) ? safeRead(join(ws, p)) : null;
      counts.set(p, text === null || text.length > 2 * 1024 * 1024 ? null : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    }
    return counts.get(p);
  };

  const wanted = full
    ? ['D1.md', 'D2.md', 'D3.md'].map((n) => ({ doc: `docs/${n}`, sections: templateSections(n) }))
    : [
      { doc: RULES_DOC, sections: [...RULES_SECTIONS] },
      { doc: INVARIANTS_DOC, sections: [...INVARIANT_SECTIONS] },
      { doc: CONTRACTS_DOC, sections: [...CONTRACT_SECTIONS] },
    ];
  const targets = wanted.map((t) => ({ ...t, exists: existsSync(join(ws, t.doc)), cites: ids }));

  for (const t of targets.filter((x) => x.exists)) {
    const text = safeRead(join(ws, t.doc)) ?? '';
    const cited = [...new Set(text.match(/\bSRC-\d+\b/g) ?? [])];
    for (const c of cited.filter((c) => !ids.includes(c))) gaps.push(removed.includes(c) ? `${t.doc} cites ${c}, whose document was removed (${INDEX} keeps its row).` : `${t.doc} cites ${c}, which is not in ${INDEX}.`);
    if (ids.length > 0 && cited.length === 0) gaps.push(`${t.doc} cites no source document (${ids[0]}${ids.length > 1 ? ` to ${ids[ids.length - 1]}` : ''} exist in ${INDEX}).`);
  }

  // The shapes of the files the code reader writes, whichever mode: they are checked when they exist.
  const rules = safeRead(join(ws, RULES_DOC));
  if (rules !== null) gaps.push(...checkRules(rules, { file: RULES_DOC, exists }));
  let unenforced = [];
  const invariants = safeRead(join(ws, INVARIANTS_DOC));
  if (invariants !== null) {
    const r = checkInvariants(invariants, { file: INVARIANTS_DOC, exists, lines });
    gaps.push(...r.gaps);
    unenforced = r.unenforced;
  }
  let register = null;
  for (const file of REGISTER_FILES) {
    const text = safeRead(join(ws, file));
    if (text === null) continue;
    const r = checkRegister(text, { file, exists, lines });
    if (!r.found) continue;
    gaps.push(...r.gaps);
    register = { file, rows: r.rows };
    break;
  }
  const started = targets.some((t) => t.exists);
  if (register === null && started) gaps.push(`There is no deviations register: add a "## Deviations" section to ${REGISTER_FILES[0]}.`);
  for (const id of unenforced) {
    if (!(register?.rows ?? []).some((row) => new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`).test(row.deviation))) gaps.push(`${INVARIANTS_DOC}: ${id} is enforced: no and has no row in the deviations register.`);
  }

  return { targets, sources, gaps, reading: readingTier(fileCount ?? files), register, repos: registered.map((r) => r.name) };
}
