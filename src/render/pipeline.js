import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { lintText } from '../style/lint.js';
import { checkRoot } from '../index/check.js';
import { loadState } from '../state.js';
import { parseDocument } from './parse.js';
import { loadTheme, loadLabels } from './theme.js';
import { chromiumStatus as defaultChromiumStatus, withBrowser as defaultWithBrowser } from './browser.js';
import { renderFigures } from './figures.js';
import { renderDocx } from './docx.js';
import { renderPdf } from './pdf.js';
import { renderPlanWorkbook } from './xlsx.js';

/** @typedef {{file:string,line:number,column:number,rule:string,severity:string,message:string}} Finding */

export const FORMATS = ['docx', 'pdf', 'xlsx'];
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
      if (!indexes.has(job.root)) indexes.set(job.root, checkRoot(job.root, { lots: lotsOf(job.root) }).findings);
      const cited = indexes.get(job.root).filter((f) => f.file === job.rel);
      findings.push(...cited);
      blocking.push(...cited.filter((f) => BLOCKING_RULES.has(f.rule)));
    }
    findings.push(...job.doc.warnings);
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
    if (format === 'docx') bytes = await renderDocx(job.doc, { theme, labels, figures });
    else if (format === 'pdf') {
      mark('pdf');
      bytes = await renderPdf(job.doc, { theme, labels, figures, browser: await browser.get() });
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
 * Render Markdown documents to DOCX, PDF and XLSX. Everything is checked and built in memory first; nothing is
 * written unless every document and every format succeeded. One browser serves the figures and the PDFs.
 * @param {string[]} paths absolute or relative to the working directory
 * @param {{formats?:string[], outDir?:string, check?:boolean, env?:Record<string,string|undefined>, cwd?:string,
 *   chromiumStatus?:typeof defaultChromiumStatus, withBrowser?:typeof defaultWithBrowser,
 *   rename?:typeof renameSync}} [options]
 * @returns {Promise<{outputs:string[], findings:Finding[]}>}
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
    const wanted = formats ?? ['docx', 'pdf', ...(doc.meta.doc_id === 'PLAN' ? ['xlsx'] : [])];
    if (wanted.includes('xlsx') && doc.meta.doc_id !== 'PLAN') {
      throw new RenderError(`${rel}: the xlsx format is for the delivery plan (doc_id PLAN), this document is ${doc.meta.doc_id}.`, { exitCode: 2, findings });
    }
    const base = join(outDir ? resolve(cwd, outDir) : join(root, 'docs', 'deliverables'), basename(file, extname(file)));
    for (const format of wanted) {
      const target = `${base}.${format}`;
      if (outputNames.has(target)) {
        throw new RenderError(`${rel} and ${outputNames.get(target)} would both write ${target}. Use --out for one of them.`, { exitCode: 2, findings });
      }
      outputNames.set(target, rel);
    }
    jobs.push({ file, root, rel, doc, wanted, base, text });
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

  // 3. Write.
  try {
    writeAll(files, options.rename);
  } catch (err) {
    err.findings = findings;
    throw err;
  }
  for (const root of new Set(jobs.map((j) => j.root))) ignoreCache(root);
  return { outputs: files.map((f) => f.file), findings };
}

/**
 * Render one Markdown document. Default formats: docx and pdf, plus xlsx for the PLAN document. Default output
 * folder: `<project root>/docs/deliverables`.
 * @param {string} path
 * @param {Parameters<typeof renderFiles>[1]} [options]
 */
export const renderFile = (path, options) => renderFiles([path], options);
