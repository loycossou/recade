import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FONT_DIR, PLUGIN_ROOT, RENDER_DIR } from './theme.js';
import { mermaidSource, mermaidThemeVariables } from './palette.js';
import { withBrowser as defaultWithBrowser } from './browser.js';

/** @typedef {{png:Buffer, width:number, height:number}} FigureImage */

/** Mermaid is vendored (render/vendor), so it needs no install and cannot drift from the cache key. */
const MERMAID_JS = join(RENDER_DIR, 'vendor', 'mermaid.min.js');
const VIEWPORT_WIDTH = 1200;
/** The widest a figure is captured, in CSS pixels. A wider one is shrunk to it. Under it, a figure keeps its real width. */
const MAX_FIGURE_WIDTH = 3200;
const SCALE = 2;
const FIGURE_CSS = join(RENDER_DIR, 'figure.css');

/** Version of the vendored Mermaid in render/vendor. Bump it together with the file. */
export const MERMAID_VERSION = '12.3.0';

/** Bump it when the way a Mermaid figure is prepared changes (palette, classDefs): the cache key carries it. */
const FIGURE_LOOK = 3;

/**
 * Part of every figure cache key: the plugin version and the vendored Mermaid version. A new release or a new
 * Mermaid drops the figures drawn by the old one.
 */
export const RENDER_CACHE_VERSION = `${JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version}+mermaid-${MERMAID_VERSION}`;

const FONT_FACES = [
  { file: 'InterTight-Regular.ttf', weight: 400, style: 'normal' },
  { file: 'InterTight-Italic.ttf', weight: 400, style: 'italic' },
  { file: 'InterTight-SemiBold.ttf', weight: 600, style: 'normal' },
  { file: 'InterTight-Bold.ttf', weight: 700, style: 'normal' },
];

let fontCss;
/**
 * @font-face rules for the bundled Inter Tight, as data: URLs. Pages loaded with setContent have an about:blank
 * origin and cannot read file:// fonts, so the bytes travel inside the stylesheet.
 */
export function fontFaceCss() {
  fontCss ??= FONT_FACES.map(({ file, weight, style }) => {
    const data = readFileSync(join(FONT_DIR, file)).toString('base64');
    return `@font-face{font-family:"Inter Tight";font-weight:${weight};font-style:${style};src:url(data:font/ttf;base64,${data}) format("truetype");}`;
  }).join('\n');
  return fontCss;
}

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
};

/** Every figure block of a document, nested ones included, in document order. */
export function collectFigures(blocks, out = []) {
  for (const block of blocks ?? []) {
    if (block.type === 'figure') out.push(block);
    else if (block.type === 'callout') collectFigures(block.blocks, out);
    else if (block.type === 'list') for (const item of block.items) collectFigures(item.children, out);
  }
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Pixel size from the IHDR chunk, or null when the bytes are not a PNG (signature, IHDR, length, size). */
function pngSize(png) {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const within = (root, file) => {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** True when `file` is inside `root`, symbolic links followed (a link that leaves the project does not count). */
export function insideProject(file, root) {
  const base = resolve(root);
  if (!within(base, file)) return false;
  try {
    return within(realpathSync(base), realpathSync(file));
  } catch {
    return true; // not there yet: the read reports it
  }
}

/**
 * Whether a page of the renderer may fetch `url`: a data URL, or a file inside the project (links followed).
 * Everything else, a file elsewhere on the machine included, is refused.
 */
export function allowRequest(url, projectRoot) {
  if (/^data:/i.test(url)) return true;
  if (!/^file:/i.test(url)) return false;
  try {
    return insideProject(fileURLToPath(url), projectRoot);
  } catch {
    return false;
  }
}

/** Source bytes of a figure: inline text, or the file next to the document. */
function readSource(fig, doc, docDir, projectRoot) {
  const { source } = fig;
  if (source.text !== undefined && !source.path) return { bytes: Buffer.from(source.text), file: null };
  const file = resolve(docDir, source.path);
  if (!insideProject(file, projectRoot)) throw new Error(`${doc.file}:${fig.line}: figure path is outside the project`);
  try {
    return { bytes: readFileSync(file), file };
  } catch {
    throw new Error(`${doc.file}:${fig.line}: figure ${fig.id}: cannot read ${source.path}`);
  }
}

async function newPage(browser, projectRoot) {
  const context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: 800 }, deviceScaleFactor: SCALE });
  // A figure is a picture of local content: nothing may leave the machine, and no file outside the project may
  // come in, whatever an HTML figure asks for.
  await context.route('**/*', (route) => (allowRequest(route.request().url(), projectRoot) ? route.continue() : route.abort()));
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

async function capture(locator) {
  return locator.screenshot({ type: 'png' });
}

async function ready(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function renderHtml(browser, file, projectRoot) {
  const { page, close } = await newPage(browser, projectRoot);
  try {
    await page.goto(pathToFileURL(file).href);
    await page.addStyleTag({ content: fontFaceCss() });
    await ready(page);
    const target = (await page.$('.fig')) ?? (await page.$('body'));
    return await capture(target);
  } finally {
    await close();
  }
}

async function renderSvg(browser, svg, projectRoot) {
  const { page, close } = await newPage(browser, projectRoot);
  try {
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div class="figure-frame" id="frame"></div></body></html>');
    await page.addStyleTag({ content: `${fontFaceCss()}\n${readFileSync(FIGURE_CSS, 'utf8')}` });
    await page.evaluate((markup) => { document.getElementById('frame').innerHTML = markup; }, svg);
    await ready(page);
    return await capture(page.locator('#frame'));
  } finally {
    await close();
  }
}

async function renderMermaid(browser, fig, doc, theme, projectRoot) {
  const { page, close } = await newPage(browser, projectRoot);
  try {
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div class="figure-frame" id="frame"></div></body></html>');
    await page.addStyleTag({ content: `${fontFaceCss()}\n${readFileSync(FIGURE_CSS, 'utf8')}` });
    await page.addScriptTag({ path: MERMAID_JS });
    const family = `"${theme.font?.family ?? 'Inter Tight'}", ${theme.font?.fallback ?? 'Arial'}, sans-serif`;
    // Layout is measured at render time: the weights must be loaded first or the boxes are sized for a fallback.
    await page.evaluate(() => Promise.all([400, 600, 700].map((w) => document.fonts.load(`${w} 16px "Inter Tight"`))).then(() => undefined));
    const result = await page.evaluate(async ({ text, id, vars }) => {
      /* eslint-disable no-undef */
      try {
        // useMaxWidth false: the SVG gets its real size in pixels, so a figure is captured at its natural size and not
        // squeezed into the 300 pixels a width of 100% resolves to in a shrink-to-fit frame.
        const fixed = { useMaxWidth: false };
        window.mermaid.initialize({
          startOnLoad: false, theme: 'base', securityLevel: 'strict', suppressErrorRendering: true, themeVariables: vars,
          flowchart: fixed, sequence: fixed, state: fixed, gantt: fixed, er: fixed, class: fixed, journey: fixed, timeline: fixed, pie: fixed, mindmap: fixed,
        });
        const { svg } = await window.mermaid.render(`mermaid-${id}`, text);
        document.getElementById('frame').innerHTML = svg;
        // The drawing's own width: the frame shrinks it to the viewport, so read it from the viewBox.
        const drawn = document.querySelector('#frame svg');
        return { failure: null, width: drawn?.viewBox?.baseVal?.width || Number.parseFloat(drawn?.getAttribute('width')) || 0 };
      } catch (err) {
        return { failure: String(err?.message ?? err), width: 0 };
      }
    }, {
      text: mermaidSource(fig.source.text, theme),
      id: fig.id,
      vars: mermaidThemeVariables(theme, family),
    });
    if (result?.failure) {
      const message = result.failure.replace(/\s+/g, ' ').trim() || 'render failed';
      throw new Error(`${doc.file}:${fig.line}: Mermaid figure ${fig.id}: ${message}`);
    }
    // A wide diagram is captured at its real width (up to MAX_FIGURE_WIDTH), not shrunk to the viewport: the page then
    // scales it to the text width, and its text is as sharp as it can be.
    const wanted = Math.min(MAX_FIGURE_WIDTH, Math.ceil(result?.width ?? 0) + 64);
    if (wanted > VIEWPORT_WIDTH) await page.setViewportSize({ width: wanted, height: 800 });
    await ready(page);
    return await capture(page.locator('#frame'));
  } finally {
    await close();
  }
}

/** Write through a temporary file; a failed write or rename leaves no temporary file behind. */
export function writeAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Render every figure of a document to a PNG. PNG figures are read as is; figures already in the cache never
 * touch the browser. The browser comes from `ctx.browser` when given, else is launched lazily, once, through
 * `ctx.withBrowser` (default: the real one) and only when some figure needs it.
 * @param {{meta:any, blocks:any[], file:string}} doc
 * @param {{browser?:import('playwright').Browser, cacheDir:string, docDir:string, projectRoot?:string, theme:any,
 *   cacheVersion?:string, withBrowser?:typeof defaultWithBrowser}} ctx
 * @returns {Promise<Map<string, FigureImage>>}
 */
export async function renderFigures(doc, ctx) {
  const { cacheDir, docDir, theme } = ctx;
  const projectRoot = ctx.projectRoot ?? docDir;
  const launch = ctx.withBrowser ?? defaultWithBrowser;
  const themeJson = JSON.stringify(theme);
  // Everything that changes the pixels: the release, the stylesheet, the scale and the viewport. Assets linked from
  // an HTML figure are not part of the key.
  const settings = [ctx.cacheVersion ?? RENDER_CACHE_VERSION, readFileSync(FIGURE_CSS, 'utf8'), SCALE, VIEWPORT_WIDTH, FIGURE_LOOK].join('\n');
  const results = new Map();
  const pending = [];

  for (const fig of collectFigures(doc.blocks)) {
    const { kind } = fig.source;
    const { bytes, file } = readSource(fig, doc, docDir, projectRoot);
    if (kind === 'png') {
      const size = pngSize(bytes);
      if (!size) throw new Error(`${doc.file}:${fig.line}: ${fig.source.path} is not a valid PNG`);
      results.set(fig.id, { png: bytes, ...size });
      continue;
    }
    const cacheFile = join(cacheDir, `${sha256(kind, bytes, themeJson, settings)}.png`);
    if (existsSync(cacheFile)) {
      const png = readFileSync(cacheFile);
      const size = pngSize(png);
      if (size) {
        results.set(fig.id, { png, ...size });
        continue;
      }
    }
    pending.push({ fig, bytes, file, cacheFile });
  }

  if (pending.length > 0) {
    mkdirSync(cacheDir, { recursive: true });
    const run = async (browser) => {
      for (const { fig, bytes, file, cacheFile } of pending) {
        let png;
        if (fig.source.kind === 'html') png = await renderHtml(browser, file, projectRoot);
        else if (fig.source.kind === 'svg') png = await renderSvg(browser, bytes.toString('utf8'), projectRoot);
        else png = await renderMermaid(browser, { ...fig, source: { ...fig.source, text: bytes.toString('utf8') } }, doc, theme, projectRoot);
        writeAtomic(cacheFile, png);
        results.set(fig.id, { png, ...pngSize(png) });
      }
    };
    if (ctx.browser) await run(ctx.browser);
    else await launch(run);
  }

  // Keep document order, whatever the cache did.
  const ordered = new Map();
  for (const fig of collectFigures(doc.blocks)) ordered.set(fig.id, results.get(fig.id));
  return ordered;
}
