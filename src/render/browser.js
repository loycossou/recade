import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PLUGIN_ROOT } from './theme.js';

/** @typedef {{ok:boolean, path:string|null, fix:string, detail:string|null}} ChromiumStatus */

// Playwright is loaded inside functions only: a missing install must be reported, not crash at import time.
const require = createRequire(import.meta.url);

export const chromiumFix = (root = PLUGIN_ROOT) => `npx --prefix "${root}" playwright install chromium`;

/** Playwright's own Chromium path, or null when Playwright cannot be loaded. */
function defaultExecutablePath() {
  try {
    return require('playwright').chromium.executablePath();
  } catch {
    return null;
  }
}

/**
 * Chromium comes from RECADE_CHROMIUM (absolute path to an executable) when set, else from Playwright's own
 * resolution. Never a hard-coded path.
 * @param {Record<string,string|undefined>} [env]
 * @param {{root?:string, executablePath?:()=>string|null, exists?:(p:string)=>boolean}} [opts]
 * @returns {ChromiumStatus}
 */
export function chromiumStatus(env = process.env, { root = PLUGIN_ROOT, executablePath = defaultExecutablePath, exists = existsSync } = {}) {
  let path = env.RECADE_CHROMIUM || null;
  if (!path) {
    try {
      path = executablePath() || null;
    } catch {
      path = null;
    }
  }
  const ok = Boolean(path) && exists(path);
  return {
    ok,
    path,
    fix: chromiumFix(root),
    detail: ok ? path : (path ? `Not found: ${path}` : 'No Chromium executable reported'),
  };
}

/**
 * Launch headless Chromium once, run `fn`, and always close the browser.
 * @template T
 * @param {(browser:import('playwright').Browser)=>Promise<T>} fn
 * @param {Record<string,string|undefined>} [env]
 * @returns {Promise<T>}
 */
export async function withBrowser(fn, env = process.env) {
  const status = chromiumStatus(env);
  if (!status.ok) throw new Error(`Chromium is not installed. Run: ${status.fix}`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: env.RECADE_CHROMIUM || undefined });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}
