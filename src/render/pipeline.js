import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { lintText } from '../style/lint.js';
import { checkRoot } from '../index/check.js';
import { loadState } from '../state.js';
import { parseDocument } from './parse.js';
import { loadTheme, loadLabels } from './theme.js';
import { chromiumStatus as defaultChromiumStatus, withBrowser as defaultWithBrowser } from './browser.js';
import { renderFigures } from './figures.js';
import { figureFindings } from './figurecheck.js';
import { renderDocx } from './docx.js';
import { renderPdf } from './pdf.js';
import { renderPlanWorkbook } from './xlsx.js';
import { oldNames, sourceDeliverableName } from './names.js';
import { renderDossier, indexOutputs, dossierEntry } from './dossier.js';
import { normalizeLanguage } from './theme.js';
import { loadStory, storyFileOf } from './story.js';

/** @typedef {{file:string,line:number,column:number,rule:string,severity:string,message:string}} Finding */

export const FORMATS = ['docx', 'pdf', 'xlsx', 'html'];
const LOT_NAME = /^[A-Z][A-Z0-9]*$/;
/** Index findings that stop a render. The others are printed. */
const BLOCKING_RULES = new Set(['unknown-id', 'duplicate-id', 'line-anchor', 'translation-extra-id']);
export const CACHE_DIR = '.recade-cache';

/** A failed render. `exitCode` is 1 (a check, a figure or Chromium) or 2 (usage). `findings` were found on the way. */
export class RenderError extends Error {
  /** @param {string} message @param {{exitCode?:1|2, findings?:Finding[]}} [opts] */
  constructor(message, { exitCode = 1, findings = [] } = {}) {
    super(message);
    this.name = 'RenderError';
    this.exitCode = exitCode;
    this.findings = findings;
  }
}

export const oneLine = (err) => String(err?.message ?? err).split('\n')[0].trim();
export const posix = (p) => p.split(sep).join('/');

/** The nearest ancestor of `file` holding `recade/state.yaml`, else the folder of the file. */
export function findProjectRoot(file) {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(dir, 'recade', 'state.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(file);
    dir = parent;
  }
}

/** Lot names recorded in the project state, or `[]` (an unreadable state is not a render problem). */
export function lotsOf(root) {
  try {
    const lots = loadState(root)?.lots;
    return Array.isArray(lots) ? lots.filter((l) => typeof l === 'string' && LOT_NAME.test(l)) : [];
  } catch {
    return [];
  }
}

/**
 * One browser for the whole run, launched on first use and closed by `close()`. `launch` is the withBrowser shape:
 * it runs a callback with the browser and closes it afterwards, so the callback is parked until `close()`.
 */
export function lazyBrowser(launch, status, what) {
  let session = null;
  let release;
  const gate = new Promise((r) => { release = r; });
  const get = () => {
    if (!session) {
      const probe = status();
      if (!probe.ok) {
        const reason = what() === 'pdf' ? 'to build the PDF' : 'to draw the figures';
        return Promise.reject(new RenderError(`Chromium is not installed, it is needed ${reason}. Run: ${probe.fix}`));
      }
      let settle;
      const browser = new Promise((res, rej) => { settle = { res, rej }; });
      const done = Promise.resolve()
        .then(() => launch(async (b) => { settle.res(b); await gate; }))
        .catch((err) => settle.rej(new RenderError(`Chromium failed to start: ${oneLine(err)}. Run: ${probe.fix}`)));
      session = { browser, done };
    }
    return session.browser;
  };
  return { get, close: async () => { release(); if (session) await session.done; } };
}

/** The topmost folder of `dir` that does not exist yet, or null when `dir` exists. */
function topmostMissing(dir) {
  let missing = null;
  for (let d = dir; !existsSync(d); d = dirname(d)) {
    missing = d;
    if (dirname(d) === d) break;
  }
  return missing;
}

/**
 * Write every output, all or nothing. Temp files go next to their targets; then, one target at a time, an existing
 * file moves to a backup name and the temp file takes its place. Any failure puts every backup back, removes the
 * outputs already placed and the folders this run created. On success the backups go.
 */
export function writeAll(outputs, rename = renameSync) {
  for (const { file } of outputs) {
    if (existsSync(file) && statSync(file).isDirectory()) {
      throw new RenderError(`Cannot write ${file}: it is a folder. Move it or use --out.`);
    }
  }
  const created = [];
  const temps = [];
  const placed = [];
  const backups = new Map();
  try {
    for (const { file, bytes } of outputs) {
      const top = topmostMissing(dirname(file));
      if (top && !created.includes(top)) created.push(top);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      temps.push(tmp);
      writeFileSync(tmp, bytes);
    }
    outputs.forEach(({ file }, i) => {
      if (existsSync(file)) {
        const backup = `${file}.${process.pid}.bak`;
        rename(file, backup);
        backups.set(file, backup);
      }
      rename(temps[i], file);
      placed.push(file);
    });
  } catch (err) {
    for (const file of placed) rmSync(file, { force: true });
    for (const [file, backup] of backups) {
      try { renameSync(backup, file); } catch { /* nothing more to do */ }
    }
    for (const tmp of temps) rmSync(tmp, { force: true });
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    throw new RenderError(`Cannot write the outputs: ${oneLine(err)}`);
  }
  for (const backup of backups.values()) rmSync(backup, { force: true });
}

/** Add `.recade-cache/` to the project's .gitignore when there is one and it lacks the entry. Never creates it. */
export function ignoreCache(root) {
  const file = join(root, '.gitignore');
  try {
    if (!existsSync(file) || !existsSync(join(root, CACHE_DIR))) return;
    const text = readFileSync(file, 'utf8');
    if (text.split(/\r?\n/).some((l) => ['.recade-cache', '.recade-cache/', '/.recade-cache', '/.recade-cache/'].includes(l.trim()))) return;
    appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${CACHE_DIR}/\n`);
  } catch {
    // A read-only .gitignore is not a reason to fail a render.
  }
}

/**
 * Files Recade wrote before that this run leaves as they were: the old names of the sources (`D1.docx`, `D1.pdf`),
 * and the PDF of a job that no longer asks for one. Nothing is deleted: the owner may have written a file of that name.
 * `candidates` are absolute paths; the ones that exist and were not written now are returned, in order, once each.
 * @param {string[]} candidates
 * @param {string[]} written
 */
export function leftOver(candidates, written) {
  const now = new Set(written);
  return [...new Set(candidates)].filter((f) => !now.has(f) && existsSync(f) && statSync(f).isFile());
}

/** The file, in each folder of deliverables, that lists what Recade rendered there, by source. */
export const RENDERED = '.recade-rendered.json';

/** The record of a folder of deliverables: `{ <source>: { current: [names], left: [names] } }`. Empty when missing or broken. */
export function readRendered(dir) {
  try {
    const data = JSON.parse(readFileSync(join(dir, RENDERED), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

const stem = (name) => basename(name, extname(name));
const RENDERED_EXTS = new Set(FORMATS.map((f) => `.${f}`));

/**
 * The files of an older render of this job that carry another name: a title changed, so `<ID>_<OldTitle>.*` stays.
 * Only a file Recade can prove it wrote counts: one listed for this source in the record of the folder, or, from a
 * render before the record, a dossier whose embedded entry names this source (or, with no source, the same document
 * and language) with the files of the same base beside it. Nothing is deleted: they are reported as left.
 * @param {{rel: string, base: string}} job
 * @param {Record<string, any>} record the record of the folder
 * @param {{doc?: string, language?: string}|null} fresh the entry of the dossier this render wrote, if any
 * @returns {string[]} absolute paths
 */
export function renamedLeftovers(job, record, fresh) {
  const dir = dirname(job.base);
  const current = basename(job.base);
  const prev = record[job.rel] ?? {};
  const names = new Set([...(Array.isArray(prev.current) ? prev.current : []), ...(Array.isArray(prev.left) ? prev.left : [])]
    .filter((n) => typeof n === 'string' && n === basename(n) && stem(n) !== current));
  const id = current.split('_')[0];
  if (fresh && existsSync(dir)) {
    const all = readdirSync(dir);
    for (const name of all) {
      if (extname(name) !== '.html' || stem(name) === current || !name.startsWith(`${id}_`)) continue;
      let entry = null;
      try { entry = dossierEntry(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
      if (!entry) continue;
      const same = entry.source !== undefined
        ? entry.source === job.rel
        : entry.doc === fresh.doc && normalizeLanguage(entry.language) === normalizeLanguage(fresh.language);
      if (!same) continue;
      for (const sibling of all) if (stem(sibling) === stem(name) && RENDERED_EXTS.has(extname(sibling))) names.add(sibling);
    }
  }
  return [...names].sort().map((n) => join(dir, n)).filter((f) => existsSync(f) && statSync(f).isFile());
}

/** Write the record of each folder of deliverables after a render: the names each source has now, and those it left. */
export function writeRendered(jobs, leftByJob) {
  const byDir = new Map();
  for (const job of jobs) {
    const dir = dirname(job.base);
    if (!byDir.has(dir)) byDir.set(dir, readRendered(dir));
    const record = byDir.get(dir);
    const current = basename(job.base);
    const kept = (record[job.rel]?.current ?? []).filter((n) => typeof n === 'string' && stem(n) === current && existsSync(join(dir, n)));
    const now = [...new Set([...kept, ...job.wanted.map((f) => `${current}.${f}`)])].sort();
    record[job.rel] = { current: now, left: (leftByJob.get(job) ?? []).map((f) => basename(f)) };
  }
  for (const [dir, record] of byDir) {
    if (!existsSync(dir)) continue;
    const sorted = Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
    writeFileSync(join(dir, RENDERED), `${JSON.stringify(sorted, null, 2)}\n`);
  }
}

/** The old names and the unwanted PDF of a job, for leftOver. `pdfCheck` is false when the formats were given. */
export function staleCandidates(job, pdfCheck) {
  const dir = dirname(job.base);
  return [
    ...(job.oldNames ?? []).map((name) => join(dir, name)),
    ...(pdfCheck && !job.wanted.includes('pdf') ? [`${job.base}.pdf`] : []),
  ];
}

/**
 * Lint and index findings of the jobs, with the parser warnings. `blocking` holds the ones that stop a render.
 * Nothing is checked when `check` is false: only the parser warnings are returned.
 * @returns {{findings: Finding[], blocking: Finding[]}}
 */
export function checkJobs(jobs, check = true) {
  const findings = [];
  const blocking = [];
  const indexes = new Map();
  for (const job of jobs) {
    if (check) {
      const lint = lintText(job.text, job.rel);
      findings.push(...lint);
      blocking.push(...lint.filter((f) => f.severity === 'error'));
      if (job.storyText) {
        const storyLint = lintText(job.storyText, job.storyRel);
        findings.push(...storyLint);
        blocking.push(...storyLint.filter((f) => f.severity === 'error'));
      }
      if (!indexes.has(job.root)) indexes.set(job.root, checkRoot(job.root, { lots: lotsOf(job.root) }).findings);
      const cited = indexes.get(job.root).filter((f) => f.file === job.rel);
      findings.push(...cited);
      blocking.push(...cited.filter((f) => BLOCKING_RULES.has(f.rule)));
    }
    findings.push(...job.doc.warnings, ...figureFindings(job.doc), ...(job.storyWarnings ?? []));
  }
  return { findings, blocking };
}

/**
 * Every output of one document, in memory: the figures once, then one buffer for each format of `job.wanted`.
 * `ctx.browser` is a lazyBrowser, `ctx.mark('figures' | 'pdf')` tells it what the browser is for (the message when
 * Chromium is missing), `ctx.findings` gets the workbook warnings. `job.docDir` is the folder figure paths are read
 * from, the folder of the file by default.
 * @returns {Promise<{file: string, bytes: Buffer}[]>}
 */
export async function buildOutputs(job, { browser, mark, findings }) {
  const theme = loadTheme(job.root);
  const labels = loadLabels(job.doc.meta.language);
  const lots = lotsOf(job.root);
  const figures = job.wanted.some((f) => f !== 'xlsx')
    ? await renderFigures(job.doc, {
      withBrowser: async (fn) => { mark('figures'); return fn(await browser.get()); },
      cacheDir: join(job.root, CACHE_DIR, 'figures'),
      docDir: job.docDir ?? dirname(job.file),
      projectRoot: job.root,
      theme,
    })
    : new Map();
  const files = [];
  for (const format of job.wanted) {
    let bytes;
    if (format === 'docx') bytes = await renderDocx(job.doc, { theme, labels, figures, lots, story: job.story });
    else if (format === 'html') {
      const dossier = renderDossier(job.doc, { theme, labels, figures, lots, story: job.story, storyRel: job.storyRel, source: job.rel });
      bytes = Buffer.from(dossier.html);
      findings.push(...dossier.warnings);
    }
    else if (format === 'pdf') {
      mark('pdf');
      bytes = await renderPdf(job.doc, { theme, labels, figures, lots, browser: await browser.get() });
    } else {
      const sheet = await renderPlanWorkbook(job.doc, { theme, labels });
      bytes = sheet.buffer;
      findings.push(...sheet.warnings);
    }
    files.push({ file: `${job.base}.${format}`, bytes });
  }
  return files;
}

/**
 * Render Markdown documents to DOCX and XLSX, and to PDF on request. Everything is checked and built in memory first;
 * nothing is written unless every document and every format succeeded. One browser serves the figures and the PDFs.
 * Each output is named after its source and its title: `D1_Functional-Specifications.docx` (see names.js).
 * `pdf` adds the PDF to the default formats (`deliverables.pdf` of the user config); `formats` replaces them.
 * `stale` lists the files of an older render this one left as they were (old names, a PDF no longer asked for).
 * @param {string[]} paths absolute or relative to the working directory
 * @param {{formats?:string[], pdf?:boolean, outDir?:string, check?:boolean, env?:Record<string,string|undefined>,
 *   cwd?:string, chromiumStatus?:typeof defaultChromiumStatus, withBrowser?:typeof defaultWithBrowser,
 *   rename?:typeof renameSync}} [options]
 * @returns {Promise<{outputs:string[], findings:Finding[], stale:string[]}>}
 * @throws {RenderError}
 */
export async function renderFiles(paths, options = {}) {
  const { outDir, check = true, env = process.env, cwd = process.cwd() } = options;
  const formats = options.formats ? [...new Set(options.formats)] : undefined;
  const statusOf = options.chromiumStatus ?? defaultChromiumStatus;
  const launch = options.withBrowser ?? ((fn) => defaultWithBrowser(fn, env));
  if (formats) {
    if (formats.length === 0) throw new RenderError('Missing value for --format. Example: --format docx,pdf', { exitCode: 2 });
    const unknown = formats.find((f) => !FORMATS.includes(f));
    if (unknown) throw new RenderError(`Unknown format: ${unknown}. Use ${FORMATS.join(', ')}.`, { exitCode: 2 });
  }

  // 1. Read, parse and check every document. Nothing is rendered yet.
  const jobs = [];
  const findings = [];
  const outputNames = new Map();
  for (const path of paths) {
    const file = resolve(cwd, path);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new RenderError(`Cannot read ${path}: ${oneLine(err)}`, { exitCode: 2 });
    }
    const root = findProjectRoot(file);
    const rel = posix(relative(root, file));
    let doc;
    try {
      doc = parseDocument(text, rel, { lots: lotsOf(root) });
    } catch (err) {
      throw new RenderError(oneLine(err), { findings });
    }
    const wanted = formats ?? ['docx', ...(options.pdf ? ['pdf'] : []), ...(doc.meta.doc_id === 'PLAN' ? ['xlsx'] : [])];
    if (!formats) wanted.push('html');
    if (wanted.includes('xlsx') && doc.meta.doc_id !== 'PLAN') {
      throw new RenderError(`${rel}: the xlsx format is for the delivery plan (doc_id PLAN), this document is ${doc.meta.doc_id}.`, { exitCode: 2, findings });
    }
    const base = join(outDir ? resolve(cwd, outDir) : join(root, 'docs', 'deliverables'), sourceDeliverableName(file, doc.meta));
    for (const format of wanted) {
      const target = `${base}.${format}`;
      if (outputNames.has(target)) {
        throw new RenderError(`${rel} and ${outputNames.get(target)} would both write ${target}. Use --out for one of them.`, { exitCode: 2, findings });
      }
      outputNames.set(target, rel);
    }
    const old = oldNames(file, doc.meta.doc_id === 'PLAN' ? ['docx', 'pdf', 'xlsx'] : ['docx', 'pdf']);
    const story = loadStory(file, posix(relative(root, storyFileOf(file))));
    jobs.push({
      file, root, rel, doc, wanted, base, text, oldNames: old,
      story: story.story, storyText: story.text, storyRel: posix(relative(root, story.file)), storyWarnings: story.warnings,
    });
  }

  const { findings: found, blocking } = checkJobs(jobs, check);
  findings.push(...found);
  if (blocking.length > 0) {
    const n = blocking.length;
    throw new RenderError(`Not rendered: ${n} ${n === 1 ? 'check' : 'checks'} failed. Fix ${n === 1 ? 'it' : 'them'}, or use --no-check.`, { findings });
  }

  // 2. Figures once per document, then every output in memory. One browser, started only when something needs it.
  let needs = 'figures';
  const browser = lazyBrowser(launch, () => statusOf(env), () => needs);
  const files = [];
  try {
    for (const job of jobs) {
      files.push(...await buildOutputs(job, { browser, mark: (what) => { needs = what; }, findings }));
    }
  } catch (err) {
    if (err instanceof RenderError) { err.findings = findings; throw err; }
    throw new RenderError(oneLine(err), { findings });
  } finally {
    await browser.close();
  }
  // The files of a previous name of each document: reported as left, and never in the index.
  const leftByJob = new Map();
  for (const job of jobs) {
    const html = files.find((f) => f.file === `${job.base}.html`);
    leftByJob.set(job, renamedLeftovers(job, readRendered(dirname(job.base)), html ? dossierEntry(String(html.bytes)) : null));
  }
  const exclude = new Set([...leftByJob.values()].flat());
  const written = new Set(files.map((f) => f.file));
  for (const dir of new Set(jobs.map((j) => dirname(j.base)))) {
    // What an earlier render already left, for a document not rendered this time, stays out of the index too.
    for (const entry of Object.values(readRendered(dir))) {
      for (const n of Array.isArray(entry?.left) ? entry.left : []) {
        if (typeof n === 'string' && n === basename(n) && !written.has(join(dir, n)) && existsSync(join(dir, n))) exclude.add(join(dir, n));
      }
    }
  }
  // The index page of the dossiers, in each folder that got one, built from the current documents only.
  if (jobs.length) files.push(...indexOutputs(files, { theme: loadTheme(jobs[0].root), exclude }));

  // 3. Write.
  try {
    writeAll(files, options.rename);
  } catch (err) {
    err.findings = findings;
    throw err;
  }
  for (const root of new Set(jobs.map((j) => j.root))) ignoreCache(root);
  try {
    writeRendered(jobs, leftByJob);
  } catch {
    // The record only helps the next render tell an old name; a folder that refuses it changes nothing written.
  }
  const outputs = files.map((f) => f.file);
  return { outputs, findings, stale: leftOver([...jobs.flatMap((j) => staleCandidates(j, !formats)), ...exclude], outputs) };
}

/**
 * Render one Markdown document. Default formats: docx, plus xlsx for the PLAN document, plus pdf with `pdf`.
 * Default output folder: `<project root>/docs/deliverables`.
 * @param {string} path
 * @param {Parameters<typeof renderFiles>[1]} [options]
 */
export const renderFile = (path, options) => renderFiles([path], options);
