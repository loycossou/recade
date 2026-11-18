import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FONT_DIR, PLUGIN_ROOT } from './theme.js';
import { chromiumStatus } from './browser.js';

/** @typedef {import('../doctor.js').Check} Check */

// Render dependencies are never imported statically here: a missing install must be reported, not crash.
export const RENDER_MODULES = ['docx', 'exceljs', 'marked', 'playwright'];
export const FONT_FILES = [
  'InterTight-Regular.ttf', 'InterTight-Italic.ttf', 'InterTight-SemiBold.ttf', 'InterTight-Bold.ttf', 'OFL.txt',
];

/** @returns {Check} */
function check(id, label, required, status, fix = null, detail = null) {
  return { id, label, required, status, fix: status === 'ok' ? null : fix, detail };
}

/** Resolve a module the way the plugin would load it, from the plugin root. Throws when absent. */
function defaultResolve(name, root) {
  return createRequire(join(root, 'package.json')).resolve(name);
}

/** Playwright's own Chromium path, or null when Playwright cannot be loaded. */
async function defaultExecutablePath() {
  try {
    const pw = await import('playwright');
    const chromium = pw.chromium ?? pw.default?.chromium;
    return chromium.executablePath();
  } catch {
    return null;
  }
}

/**
 * @param {{root?:string, resolve?:(name:string, root:string)=>string}} [opts]
 * @returns {Check}
 */
export function depsCheck({ root = PLUGIN_ROOT, resolve = defaultResolve } = {}) {
  const missing = [];
  for (const name of RENDER_MODULES) {
    try {
      resolve(name, root);
    } catch {
      missing.push(name);
    }
  }
  return check('render-deps', 'Render dependencies (docx, exceljs, marked, playwright)', true,
    missing.length === 0 ? 'ok' : 'missing', `npm ci --omit=dev --prefix "${root}"`,
    missing.length === 0 ? null : `Not found: ${missing.join(', ')}`);
}

/**
 * Chromium comes from RECADE_CHROMIUM when set, else from Playwright's own resolution.
 * @param {{root?:string, env?:Record<string,string|undefined>, executablePath?:()=>Promise<string|null>, exists?:(p:string)=>boolean}} [opts]
 * @returns {Promise<Check>}
 */
export async function chromiumCheck({
  root = PLUGIN_ROOT, env = process.env, executablePath = defaultExecutablePath, exists = existsSync,
} = {}) {
  let reported = null;
  if (!env.RECADE_CHROMIUM) {
    try {
      reported = await executablePath();
    } catch {
      reported = null;
    }
  }
  const status = chromiumStatus(env, { root, executablePath: () => reported, exists });
  return check('render-chromium', 'Chromium for PDF and diagrams', false, status.ok ? 'ok' : 'warn', status.fix, status.detail);
}

/**
 * @param {{root?:string, fontDir?:string, exists?:(p:string)=>boolean}} [opts]
 * @returns {Check}
 */
export function fontsCheck({ root = PLUGIN_ROOT, fontDir = FONT_DIR, exists = existsSync } = {}) {
  const missing = FONT_FILES.filter((f) => !exists(join(fontDir, f)));
  return check('render-fonts', 'Bundled Inter Tight fonts and licence', true,
    missing.length === 0 ? 'ok' : 'missing', `Restore render/fonts from the plugin repository (${root})`,
    missing.length === 0 ? null : `Missing: ${missing.join(', ')}`);
}

/**
 * Doctor checks for the render engine. `ctx.render` may carry resolvers for tests.
 * @type {Array<(ctx:any)=>Check|Promise<Check>>}
 */
export const renderChecks = [
  (ctx) => depsCheck(ctx?.render?.deps),
  (ctx) => chromiumCheck({ env: ctx?.env ?? process.env, ...ctx?.render?.chromium }),
  (ctx) => fontsCheck(ctx?.render?.fonts),
];
