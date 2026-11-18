import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { depsCheck, chromiumCheck, fontsCheck, renderChecks, FONT_FILES } from '../../src/render/checks.js';
import { checks as doctorChecks, runChecks } from '../../src/doctor.js';

const ROOT = '/opt/recade';

test('render deps: ok when every module resolves', () => {
  const c = depsCheck({ root: ROOT, resolve: (name) => `/x/${name}` });
  assert.equal(c.id, 'render-deps');
  assert.equal(c.required, true);
  assert.equal(c.status, 'ok');
  assert.equal(c.fix, null);
});

test('render deps: missing when a module cannot be resolved, fix names the plugin root', () => {
  const resolve = (name) => {
    if (name === 'docx') throw new Error('Cannot find module');
    return `/x/${name}`;
  };
  const c = depsCheck({ root: ROOT, resolve });
  assert.equal(c.status, 'missing');
  assert.equal(c.fix, `npm ci --omit=dev --prefix "${ROOT}"`);
  assert.match(c.detail, /docx/);
  assert.doesNotMatch(c.detail, /exceljs/);
});

test('render deps: the four modules are checked', () => {
  const seen = [];
  depsCheck({ root: ROOT, resolve: (n) => { seen.push(n); return n; } });
  assert.deepEqual(seen.sort(), ['docx', 'exceljs', 'marked', 'playwright']);
});

test('render chromium: warn when Playwright reports no executable', async () => {
  const c = await chromiumCheck({ root: ROOT, env: {}, executablePath: async () => null, exists: () => false });
  assert.equal(c.id, 'render-chromium');
  assert.equal(c.required, false);
  assert.equal(c.status, 'warn');
  assert.equal(c.fix, `npx --prefix "${ROOT}" playwright install chromium`);
});

test('render chromium: warn when the reported path does not exist, and when playwright cannot load', async () => {
  const gone = await chromiumCheck({ root: ROOT, env: {}, executablePath: async () => '/nope/chrome', exists: () => false });
  assert.equal(gone.status, 'warn');
  const broken = await chromiumCheck({
    root: ROOT, env: {}, exists: () => true,
    executablePath: async () => { throw new Error('Cannot find package'); },
  });
  assert.equal(broken.status, 'warn');
});

test('render chromium: ok when the executable exists, or RECADE_CHROMIUM points to one', async () => {
  const ok = await chromiumCheck({ root: ROOT, env: {}, executablePath: async () => '/p/chrome', exists: (p) => p === '/p/chrome' });
  assert.equal(ok.status, 'ok');
  const env = { RECADE_CHROMIUM: '/custom/chrome' };
  const viaEnv = await chromiumCheck({ root: ROOT, env, executablePath: async () => null, exists: (p) => p === '/custom/chrome' });
  assert.equal(viaEnv.status, 'ok');
  const badEnv = await chromiumCheck({ root: ROOT, env, executablePath: async () => '/p/chrome', exists: (p) => p === '/p/chrome' });
  assert.equal(badEnv.status, 'warn');
});

test('render fonts: ok when files exist, missing when one is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-fonts-'));
  try {
    for (const f of FONT_FILES) writeFileSync(join(dir, f), 'x');
    assert.equal(fontsCheck({ root: ROOT, fontDir: dir }).status, 'ok');
    rmSync(join(dir, 'InterTight-Bold.ttf'));
    const c = fontsCheck({ root: ROOT, fontDir: dir });
    assert.equal(c.id, 'render-fonts');
    assert.equal(c.required, true);
    assert.equal(c.status, 'missing');
    assert.match(c.detail, /InterTight-Bold\.ttf/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the shipped fonts and OFL.txt are all present', () => {
  assert.equal(fontsCheck({}).status, 'ok');
});

test('render checks are registered in the doctor and run through runChecks', async () => {
  for (const c of renderChecks) assert.ok(doctorChecks.includes(c));
  assert.equal(renderChecks.length, 3);
  const ctx = {
    exec: async () => ({ code: 127, stdout: '', stderr: '' }),
    readFile: async () => { throw new Error('none'); },
    env: {},
    nodeVersion: '22.0.0',
  };
  const result = await runChecks(ctx);
  const ids = result.map((c) => c.id);
  for (const id of ['render-deps', 'render-chromium', 'render-fonts']) assert.ok(ids.includes(id), id);
});
