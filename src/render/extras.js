import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { EXTRAS } from '../deliverables.js';
import { loadState } from '../state.js';
import { projectName } from '../workspace/layout.js';
import { localToday } from '../project/template.js';
import { chromiumStatus as defaultChromiumStatus, withBrowser as defaultWithBrowser } from './browser.js';
import { splitFrontMatter } from './frontmatter.js';
import { parseDocument } from './parse.js';
import { loadTheme, loadLabels } from './theme.js';
import { allowRequest, insideProject } from './figures.js';
import { renderTablesWorkbook, stackMatrixSheets } from './xlsx.js';
import {
  CACHE_DIR, RenderError, buildOutputs, checkJobs, ignoreCache, lazyBrowser, lotsOf, oneLine, posix, writeAll,
} from './pipeline.js';

/** @typedef {import('./pipeline.js').Finding} Finding */

const DEC_FILE = /^DEC-(\d{2,})\.md$/;
const DECIDED = /^> Decided: (.*?)\. Option: (.*?)\. By: (.*?)\. Date: (.*?)\.$/;
const NONE_YET = 'none yet';

/**
 * True when `path` is a regular file inside the project. A link is not a file here, and a folder on the way that is a
 * link out of the project makes the file one that is not inside it: nothing outside the project is read or printed.
 */
const isFile = (path, root) => {
  try {
    return lstatSync(path).isFile() && insideProject(path, root);
  } catch {
    return false;
  }
};

/** The names in `dir` that match, in a stable order, regular files inside the project only. A missing folder gives none. */
function filesOf(dir, pattern, root) {
  let names;
  try {
    if (!insideProject(dir, root)) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => pattern.test(n) && isFile(join(dir, n), root)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** A table cell: one line, pipes escaped. */
const cell = (value) => String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim().replaceAll('|', '\\|');

/** The cells of a Markdown table row, `\|` read as a pipe. */
function rowCells(row) {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const out = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '|') { current += '|'; i += 1; } else if (text[i] === '|') { out.push(current.trim()); current = ''; } else current += text[i];
  }
  out.push(current.trim());
  return out;
}

/** The sub-sections of `lines` that start with a heading of `level` (fenced code skipped): `{title, lines}`. */
function sectionsOf(lines, level) {
  const mark = '#'.repeat(level);
  const heading = new RegExp(`^${mark} (.*)$`);
  const out = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : heading.exec(line);
    if (m) out.push({ title: m[1].trim(), lines: [] });
    else if (out.length > 0) out.at(-1).lines.push(line);
  }
  return out;
}

const paragraph = (lines) => lines.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('<!--')).join(' ');

/** The name of the project as the documents write it, else the one of the folder. */
function projectTitle(root) {
  for (const rel of ['docs/D1.md', 'docs/STACK.md', 'docs/D2.md']) {
    try {
      if (!isFile(join(root, rel), root)) continue;
      const project = splitFrontMatter(readFileSync(join(root, rel), 'utf8'), rel).meta.project;
      if (typeof project === 'string' && project.trim() !== '') return project.trim();
    } catch {
      // Try the next one.
    }
  }
  return projectName(root);
}

/** The first language of `languages.deliverables`, the one the documents are written in. */
function deliverableLanguage(root) {
  try {
    const first = loadState(root)?.languages?.deliverables;
    return String(Array.isArray(first) ? first[0] : first ?? 'en');
  } catch {
    return 'en';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The decision register

/**
 * @typedef {{id:string, question:string, status:string, document:string, due:string, options:{letter:string,label:string,items:string[][]}[],
 *   recommendation:string, chosen:string, decidedBy:string, date:string}} Decision
 */

function parseDecision(file, text, rel) {
  const { meta, body } = splitFrontMatter(text, rel);
  const lines = body.split('\n');
  const top = sectionsOf(lines.map((l) => (/^# /.test(l) ? '' : l)), 2);
  const section = (title) => top.find((s) => s.title.toLowerCase() === title)?.lines ?? [];
  const options = sectionsOf(section('options'), 3).flatMap(({ title, lines: rows }) => {
    const m = /^Option ([A-Z])(?::\s*(.*))?$/.exec(title);
    if (!m) return [];
    const items = rows.filter((r) => r.trim().startsWith('|')).map(rowCells).slice(2).filter((c) => c.length >= 2).map((c) => [c[0], c[1]]);
    return [{ letter: m[1], label: (m[2] ?? '').trim(), items }];
  });
  const box = lines.findIndex((l) => l.trim() === '> [!DECISION]');
  const decided = box >= 0 ? DECIDED.exec((lines[box + 1] ?? '').trim()) : null;
  const yes = decided !== null && decided[1].trim().toLowerCase() === 'yes';
  const id = String(meta.doc_id ?? basename(file, '.md')).trim();
  const question = paragraph(section('question')) || String(meta.title ?? id).trim();
  return {
    id,
    question,
    status: String(meta.status ?? 'open').trim(),
    document: String(meta.document ?? '').trim(),
    due: String(meta.due ?? '').trim(),
    options,
    recommendation: paragraph(section('recommendation and its price')),
    chosen: yes ? decided[2].trim() : NONE_YET,
    decidedBy: yes ? decided[3].trim() : '',
    date: yes ? decided[4].trim() : '',
  };
}

/**
 * Every `decisions/DEC-nn.md` of the project, in number order. A file that cannot be read gives one warning and is
 * left out.
 * @param {string} root
 * @returns {{entries: Decision[], warnings: string[]}}
 */
export function readDecisions(root) {
  const entries = [];
  const warnings = [];
  for (const name of filesOf(join(root, 'decisions'), DEC_FILE, root)) {
    const rel = `decisions/${name}`;
    try {
      entries.push(parseDecision(name, readFileSync(join(root, rel), 'utf8'), rel));
    } catch (err) {
      warnings.push(`${rel} skipped: ${oneLine(err)}`);
    }
  }
  return { entries, warnings };
}

const frontMatter = (meta) => `---\n${stringify(meta, { lineWidth: 0 }).trimEnd()}\n---\n`;

const registerMeta = (docId, title, { project, date, language }) => ({
  doc_id: docId, title: `${project}, ${title}`, project, version: '1.0', date, status: 'Register', language,
});

/**
 * The register as one Markdown document: a summary table, then one section for each decision. It is built in memory
 * and rendered, never saved in the project.
 * @param {Decision[]} entries
 * @param {{project:string, date:string, language:string}} meta
 */
export function decisionRegisterMarkdown(entries, meta) {
  const out = [frontMatter(registerMeta('DECISIONS', 'decision register', meta)), '## Summary', ''];
  out.push('| ID | Question | Document | Status | Chosen option | Date |', '|---|---|---|---|---|---|');
  for (const e of entries) out.push(`| ${[e.id, e.question, e.document, e.status, e.chosen, e.date].map(cell).join(' | ')} |`);
  for (const e of entries) {
    out.push('', `## ${cell(e.id)}: ${cell(e.question).replaceAll('\\|', '|')}`, '', '| Item | Value |', '|---|---|');
    const facts = [['Status', e.status], ['Document', e.document], ['Chosen option', e.chosen], ['Decided by', e.decidedBy], ['Date', e.date], ['Due', e.due]];
    for (const [k, v] of facts) if (v !== '') out.push(`| ${k} | ${cell(v)} |`);
    out.push('', `**Question.** ${e.question}`);
    if (e.options.length > 0) {
      const keys = [...new Set(e.options.flatMap((o) => o.items.map(([k]) => k)))];
      out.push('', '**Options.**', '', `| ${['Option', ...keys].map(cell).join(' | ')} |`, `|${'---|'.repeat(keys.length + 1)}`);
      for (const o of e.options) {
        const values = keys.map((k) => o.items.find(([name]) => name === k)?.[1] ?? '');
        out.push(`| ${[`${o.letter}${o.label ? `: ${o.label}` : ''}`, ...values].map(cell).join(' | ')} |`);
      }
    }
    if (e.recommendation !== '') out.push('', `**Recommendation.** ${e.recommendation}`);
  }
  return `${out.join('\n')}\n`;
}

/** The decision register as one sheet, one row for each decision. */
function decisionSheet(entries) {
  const columns = ['ID', 'Question', 'Document', 'Status', 'Options', 'Chosen option', 'Decided by', 'Date', 'Due', 'Recommendation'];
  const rows = entries.map((e) => [
    e.id, e.question, e.document, e.status, e.options.map((o) => `${o.letter}${o.label ? `: ${o.label}` : ''}`).join('; '),
    e.chosen, e.decidedBy, e.date, e.due, e.recommendation,
  ]);
  return { name: 'Decisions', columns, rows };
}

// ---------------------------------------------------------------------------------------------------------------
// The review register

/**
 * Every note of `docs/reviews/*.md`, in name order. A note that cannot be read gives one warning and is left out.
 * @param {string} root
 * @returns {{notes: {file:string, title:string, date:string, status:string, body:string}[], warnings: string[]}}
 */
export function readReviews(root) {
  const notes = [];
  const warnings = [];
  for (const name of filesOf(join(root, 'docs', 'reviews'), /\.md$/i, root)) {
    const rel = `docs/reviews/${name}`;
    try {
      const { meta, body } = splitFrontMatter(readFileSync(join(root, rel), 'utf8'), rel);
      const h1 = /^# (.*)$/m.exec(body)?.[1]?.trim();
      notes.push({
        file: rel,
        title: String(meta.title ?? h1 ?? basename(name, '.md')).trim(),
        date: String(meta.date ?? '').trim(),
        status: String(meta.status ?? '').trim(),
        body,
      });
    } catch (err) {
      warnings.push(`${rel} skipped: ${oneLine(err)}`);
    }
  }
  return { notes, warnings };
}

/** The body of a note one level down, its first level 1 heading (the title, said again by the section) dropped. */
function demote(body) {
  let fence = false;
  let dropped = false;
  const out = [];
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^(#{1,6}) (.*)$/.exec(line);
    if (!m) out.push(line);
    else if (m[1] === '#' && !dropped) dropped = true;
    else out.push(`${m[1].length < 6 ? '#' : ''}${m[1]} ${m[2]}`);
  }
  return out.join('\n').trim();
}

/**
 * The review notes as one Markdown document, one section for each note, built in memory and rendered, never saved.
 * @param {{title:string, body:string}[]} notes
 * @param {{project:string, date:string, language:string}} meta
 */
export function reviewRegisterMarkdown(notes, meta) {
  const out = [frontMatter(registerMeta('REVIEWS', 'review notes', meta))];
  for (const n of notes) out.push(`## ${n.title.replace(/\s+/g, ' ')}`, '', demote(n.body), '');
  return `${out.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// The design boards

/**
 * One board to a PDF. The page runs with JavaScript off and the network off, and only data URLs and files inside the
 * project are fetched: a board cannot embed a file from elsewhere on the machine, and nothing leaves it. A board is a
 * static page; one that needs a script to draw itself prints without it.
 */
export async function printBoard(browser, file, root) {
  const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
  try {
    await context.route('**/*', (route) => (allowRequest(route.request().url(), root) ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, format: 'A4', printBackground: true }));
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Render the extra deliverables the owner chose, into `docs/deliverables`. Every source is read, checked and built
 * in memory first, and nothing is written unless every output succeeded. A missing source is a warning, not a
 * failure. One browser serves the figures and every PDF, started only when something needs it.
 * - `stack`: STACK.docx, STACK.pdf and STACK-matrix.xlsx (one sheet for each table of section 5).
 * - `decisions`: DECISIONS.docx, DECISIONS.pdf and DECISIONS.xlsx, from a register built in memory.
 * - `design`: one `design-<board>.pdf` for each HTML board of `design/directions/`.
 * - `reviews`: REVIEWS.docx and REVIEWS.pdf, from the notes of `docs/reviews/`, built in memory.
 * @param {string} root project folder
 * @param {string[]} extras names among `stack`, `decisions`, `design`, `reviews`
 * @param {{check?:boolean, date?:string, env?:Record<string,string|undefined>, chromiumStatus?:typeof defaultChromiumStatus,
 *   withBrowser?:typeof defaultWithBrowser, rename?:(from:string, to:string)=>void}} [options]
 * @returns {Promise<{outputs:string[], findings:Finding[], warnings:string[]}>}
 * @throws {RenderError} with `warnings`
 */
export async function renderExtras(root, extras, options = {}) {
  const { check = true, env = process.env } = options;
  const unknown = extras.find((e) => !EXTRAS.includes(e));
  if (unknown !== undefined) throw new RenderError(`Unknown extra deliverable: ${unknown}. Use ${EXTRAS.join(', ')}.`, { exitCode: 2 });
  const chosen = EXTRAS.filter((e) => extras.includes(e));
  const statusOf = options.chromiumStatus ?? defaultChromiumStatus;
  const launch = options.withBrowser ?? ((fn) => defaultWithBrowser(fn, env));
  const outDir = join(root, 'docs', 'deliverables');
  const lots = lotsOf(root);
  const warnings = [];
  const findings = [];
  const fail = (err) => {
    const out = err instanceof RenderError ? err : new RenderError(oneLine(err), { findings });
    out.findings = findings;
    out.warnings = warnings;
    return out;
  };
  const missing = (what, name) => warnings.push(`no ${what}, nothing to render for ${name}.`);
  /** @type {{file:string, root:string, rel:string, doc:any, wanted:string[], base:string, text:string, docDir?:string}[]} */
  const real = [];
  const generated = [];
  const extraFiles = []; // built after the browser exists: {file, build(browser)} or {file, bytes}
  let cached = null;
  const meta = () => {
    cached ??= { project: projectTitle(root), date: options.date ?? localToday(), language: deliverableLanguage(root) };
    return cached;
  };
  const generatedJob = (name, text, docDir) => {
    const file = join(root, CACHE_DIR, 'extras', `${name}.md`);
    const rel = posix(relative(root, file));
    let doc;
    try {
      doc = parseDocument(text, rel, { lots });
    } catch (err) {
      throw fail(new RenderError(`${name}: ${oneLine(err)}`));
    }
    const job = { file, root, rel, doc, wanted: ['docx', 'pdf'], base: join(outDir, name), text, docDir };
    generated.push(job);
    return job;
  };

  // 1. Read and parse every source. Nothing is rendered yet.
  let theme;
  try {
    for (const name of chosen) {
      if (name === 'stack') {
        const file = join(root, 'docs', 'STACK.md');
        if (!isFile(file, root)) { missing('docs/STACK.md', name); continue; }
        const text = readFileSync(file, 'utf8');
        let doc;
        try {
          doc = parseDocument(text, 'docs/STACK.md', { lots });
        } catch (err) {
          throw fail(new RenderError(oneLine(err)));
        }
        real.push({ file, root, rel: 'docs/STACK.md', doc, wanted: ['docx', 'pdf'], base: join(outDir, 'STACK'), text });
        const matrix = stackMatrixSheets(doc);
        findings.push(...matrix.warnings);
        if (matrix.sheets.length > 0) {
          extraFiles.push({ file: join(outDir, 'STACK-matrix.xlsx'), build: async () => {
            theme ??= loadTheme(root);
            return renderTablesWorkbook({ meta: doc.meta, source: 'STACK.md', sheets: matrix.sheets }, { theme, labels: loadLabels(doc.meta.language) });
          } });
        }
      } else if (name === 'decisions') {
        const { entries, warnings: skipped } = readDecisions(root);
        warnings.push(...skipped);
        if (entries.length === 0) { if (skipped.length === 0) missing('decisions/DEC-*.md', name); continue; }
        const job = generatedJob('DECISIONS', decisionRegisterMarkdown(entries, meta()), join(root, 'decisions'));
        extraFiles.push({ file: join(outDir, 'DECISIONS.xlsx'), build: async () => {
          theme ??= loadTheme(root);
          return renderTablesWorkbook({ meta: job.doc.meta, source: 'decisions', sheets: [decisionSheet(entries)] }, { theme, labels: loadLabels(job.doc.meta.language) });
        } });
      } else if (name === 'reviews') {
        const { notes, warnings: skipped } = readReviews(root);
        warnings.push(...skipped);
        if (notes.length === 0) { if (skipped.length === 0) missing('docs/reviews/*.md', name); continue; }
        generatedJob('REVIEWS', reviewRegisterMarkdown(notes, meta()), join(root, 'docs', 'reviews'));
      } else {
        const dir = join(root, 'design', 'directions');
        const boards = filesOf(dir, /\.html$/i, root);
        if (boards.length === 0) { missing('design/directions/*.html', name); continue; }
        const seen = new Map();
        for (const board of boards) {
          const key = basename(board).replace(/\.html$/i, '').toLowerCase();
          if (seen.has(key)) {
            throw new RenderError(`design/directions holds ${seen.get(key)} and ${board}, which would both write design-${key}.pdf. Rename one.`);
          }
          seen.set(key, board);
          const file = join(dir, board);
          extraFiles.push({ file: join(outDir, `design-${basename(board).replace(/\.html$/i, '')}.pdf`), print: file });
        }
      }
    }
  } catch (err) {
    throw fail(err);
  }

  // 2. Check the sources the owner wrote. A register is built from files that were checked on their own.
  const { findings: found, blocking } = checkJobs(real, check);
  findings.push(...found, ...checkJobs(generated, false).findings);
  if (blocking.length > 0) {
    const n = blocking.length;
    throw fail(new RenderError(`Not rendered: ${n} ${n === 1 ? 'check' : 'checks'} failed. Fix ${n === 1 ? 'it' : 'them'}, or use --no-check.`));
  }

  // 3. Every output in memory. One browser, started only when something needs it.
  let needs = 'figures';
  const browser = lazyBrowser(launch, () => statusOf(env), () => needs);
  const files = [];
  try {
    for (const job of [...real, ...generated]) files.push(...await buildOutputs(job, { browser, mark: (what) => { needs = what; }, findings }));
    for (const item of extraFiles) {
      if (item.print) {
        needs = 'pdf';
        files.push({ file: item.file, bytes: await printBoard(await browser.get(), item.print, root) });
      } else {
        files.push({ file: item.file, bytes: await item.build() });
      }
    }
  } catch (err) {
    throw fail(err);
  } finally {
    await browser.close();
  }

  // 4. Write, all or nothing.
  try {
    writeAll(files, options.rename);
  } catch (err) {
    throw fail(err);
  }
  if (files.length > 0) ignoreCache(root);
  return { outputs: files.map((f) => f.file), findings, warnings };
}
