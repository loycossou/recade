import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumStatus, withBrowser } from '../../src/render/browser.js';
import { renderFigures, writeAtomic, RENDER_CACHE_VERSION, MERMAID_VERSION } from '../../src/render/figures.js';
import { loadTheme } from '../../src/render/theme.js';

const DOC_DIR = fileURLToPath(new URL('../fixtures/render/fernhill/docs/', import.meta.url));
const status = chromiumStatus();
const skip = status.ok ? false : `Chromium is not installed (${status.fix})`;
if (skip) console.log(`# figures tests needing Chromium are skipped: ${skip}`);

const theme = loadTheme(null);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const widthOf = (png) => png.readUInt32BE(16);
const heightOf = (png) => png.readUInt32BE(20);

function figure(n, source, line = 1) {
  return { type: 'figure', id: `fig-${n}`, source, caption: [], number: n, line };
}
const doc = (...blocks) => ({ meta: {}, blocks, file: 'docs/D1.md', warnings: [] });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'recade-figures-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('an HTML figure is captured at the .fig element, twice its CSS width', { skip }, async () => {
  const t = tmp();
  try {
    const d = doc(figure(1, { kind: 'html', path: 'figures/context.html' }));
    const out = await withBrowser((browser) => renderFigures(d, { browser, cacheDir: t.dir, docDir: DOC_DIR, theme }));
    const fig = out.get('fig-1');
    assert.ok(fig.png.subarray(0, 8).equals(PNG_MAGIC));
    // .fig is 480px content + 2 * 16px padding + 2 * 2px border = 516px.
    assert.equal(widthOf(fig.png), 516 * 2);
    assert.equal(fig.width, widthOf(fig.png));
    assert.equal(fig.height, heightOf(fig.png));
  } finally {
    t.done();
  }
});

test('a Mermaid flowchart renders to a PNG', { skip }, async () => {
  const t = tmp();
  try {
    const d = doc(figure(1, { kind: 'mermaid', text: 'flowchart LR\n  A[Member] --> B[Tool shelf]' }));
    const out = await withBrowser((browser) => renderFigures(d, { browser, cacheDir: t.dir, docDir: DOC_DIR, theme }));
    const fig = out.get('fig-1');
    assert.ok(fig.png.subarray(0, 8).equals(PNG_MAGIC));
    assert.ok(fig.width > 100 && fig.height > 50, `${fig.width}x${fig.height}`);
  } finally {
    t.done();
  }
});

test('a wide Mermaid flowchart is captured at its real width, not shrunk to the 1200 pixel viewport', { skip }, async () => {
  const t = tmp();
  try {
    const nodes = Array.from({ length: 25 }, (_, i) => `N${i}[Step number ${i}]`);
    const wide = doc(figure(1, { kind: 'mermaid', text: `flowchart LR\n  ${nodes.join(' --> ')}` }));
    const narrow = doc(figure(2, { kind: 'mermaid', text: 'flowchart LR\n  A[Member] --> B[Tool shelf]' }));
    const out = await withBrowser((browser) => renderFigures(doc(...wide.blocks, ...narrow.blocks), { browser, cacheDir: t.dir, docDir: DOC_DIR, theme }));
    const fig = out.get('fig-1');
    // 25 boxes of 100 pixels or more cannot fit 1200 pixels: the picture is wider than the old viewport, twice over at scale 2.
    assert.ok(fig.width / 2 > 1500, `${fig.width / 2} CSS pixels`);
    assert.ok(fig.width / 2 <= 3200 + 32, `${fig.width / 2} CSS pixels, capped`);
    assert.ok(out.get('fig-2').width / 2 < 600, 'a small figure keeps its natural size');
  } finally {
    t.done();
  }
});

test('an inline SVG figure renders to a PNG', { skip }, async () => {
  const t = tmp();
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80"><rect width="200" height="80" fill="#17C79A"/></svg>';
    const d = doc(figure(1, { kind: 'svg', text: svg }));
    const out = await withBrowser((browser) => renderFigures(d, { browser, cacheDir: t.dir, docDir: DOC_DIR, theme }));
    assert.ok(out.get('fig-1').width >= 400);
  } finally {
    t.done();
  }
});

test('a Mermaid syntax error names the file, the line and the figure', { skip }, async () => {
  const t = tmp();
  try {
    const d = doc(figure(1, { kind: 'mermaid', text: 'flowchart LR\n  A --> --> B ]]' }, 12));
    await assert.rejects(
      withBrowser((browser) => renderFigures(d, { browser, cacheDir: t.dir, docDir: DOC_DIR, theme })),
      (err) => {
        assert.match(err.message, /^docs\/D1\.md:12: Mermaid figure fig-1: \S/);
        assert.doesNotMatch(err.message, /\n/);
        return true;
      },
    );
  } finally {
    t.done();
  }
});

test('a second call with the same cache directory does not launch the browser', { skip }, async () => {
  const t = tmp();
  try {
    let launches = 0;
    const counting = (fn, env) => { launches += 1; return withBrowser(fn, env); };
    const d = doc(
      figure(1, { kind: 'html', path: 'figures/context.html' }),
      figure(2, { kind: 'mermaid', text: 'flowchart LR\n  A --> B' }),
    );
    const ctx = { cacheDir: t.dir, docDir: DOC_DIR, theme, withBrowser: counting };
    const first = await renderFigures(d, ctx);
    assert.equal(launches, 1);
    assert.equal(readdirSync(t.dir).filter((f) => f.endsWith('.png')).length, 2);
    const second = await renderFigures(d, ctx);
    assert.equal(launches, 1);
    assert.ok(second.get('fig-1').png.equals(first.get('fig-1').png));
    assert.equal(second.get('fig-2').width, first.get('fig-2').width);
    // A changed theme is a different cache key.
    const other = { ...theme, color: { ...theme.color, accent: 'FF0000' } };
    await renderFigures(d, { ...ctx, theme: other });
    assert.equal(launches, 2);
  } finally {
    t.done();
  }
});

test('the browser is launched once for several figures, and closed afterwards', { skip }, async () => {
  const t = tmp();
  try {
    let launches = 0;
    let captured;
    const counting = (fn, env) => withBrowser((browser) => { launches += 1; captured = browser; return fn(browser); }, env);
    const d = doc(
      figure(1, { kind: 'mermaid', text: 'flowchart LR\n  A --> B' }),
      figure(2, { kind: 'mermaid', text: 'flowchart LR\n  C --> D' }),
    );
    await renderFigures(d, { cacheDir: t.dir, docDir: DOC_DIR, theme, withBrowser: counting });
    assert.equal(launches, 1);
    assert.equal(captured.isConnected(), false);
  } finally {
    t.done();
  }
});

test('withBrowser closes the browser when the callback throws', { skip }, async () => {
  let captured;
  await assert.rejects(withBrowser(async (browser) => { captured = browser; throw new Error('boom'); }), /boom/);
  assert.equal(captured.isConnected(), false);
});

test('PNG figures are read as is and never need the browser', async () => {
  const t = tmp();
  try {
    // A 1x1 transparent PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    writeFileSync(join(t.dir, 'dot.png'), png);
    const d = doc(figure(1, { kind: 'png', path: 'dot.png' }));
    const never = () => { throw new Error('browser must not be used'); };
    const out = await renderFigures(d, { cacheDir: join(t.dir, 'cache'), docDir: t.dir, theme, withBrowser: never });
    assert.ok(out.get('fig-1').png.equals(png));
    assert.equal(out.get('fig-1').width, 1);
    assert.equal(out.get('fig-1').height, 1);
  } finally {
    t.done();
  }
});

test('figures nested in callouts and lists are rendered', async () => {
  const t = tmp();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    writeFileSync(join(t.dir, 'dot.png'), png);
    const inner = figure(2, { kind: 'png', path: 'dot.png' });
    const d = doc(
      figure(1, { kind: 'png', path: 'dot.png' }),
      { type: 'callout', kind: 'note', blocks: [inner], line: 3 },
    );
    const out = await renderFigures(d, { cacheDir: t.dir, docDir: t.dir, theme });
    assert.deepEqual([...out.keys()], ['fig-1', 'fig-2']);
  } finally {
    t.done();
  }
});

test('a missing figure file names the document, the line and the path', async () => {
  const t = tmp();
  try {
    const d = doc(figure(1, { kind: 'png', path: 'nope.png' }, 7));
    await assert.rejects(
      renderFigures(d, { cacheDir: t.dir, docDir: t.dir, theme }),
      /^Error: docs\/D1\.md:7: figure fig-1: cannot read nope\.png/,
    );
  } finally {
    t.done();
  }
});

test('withBrowser throws the install hint when RECADE_CHROMIUM points at a missing file', async () => {
  const env = { ...process.env, RECADE_CHROMIUM: join(tmpdir(), 'recade-no-such-chromium') };
  await assert.rejects(withBrowser(async () => 'never', env), /^Error: Chromium is not installed\. Run: npx .*playwright install chromium/);
  assert.equal(chromiumStatus(env).ok, false);
});

// ---------------------------------------------------------------------------------------------------------------
// Final review fixes. A stub browser keeps most of these independent of Chromium.

const DOT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function stubBrowser() {
  const log = { contexts: 0, routes: 0, evaluated: [], launches: 0 };
  const page = {
    goto: async () => {},
    setContent: async () => {},
    addStyleTag: async () => {},
    addScriptTag: async () => {},
    evaluate: async (fn) => { log.evaluated.push(String(fn)); return null; },
    $: async () => null,
    locator: () => ({ screenshot: async () => DOT }),
  };
  const browser = {
    newContext: async () => {
      log.contexts += 1;
      return { route: async () => { log.routes += 1; }, newPage: async () => page, close: async () => {} };
    },
  };
  return { log, browser, withBrowser: async (fn) => { log.launches += 1; return fn(browser); } };
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="8"><rect width="20" height="8"/></svg>';

test('changing the cache version string invalidates the figure cache', async () => {
  const t = tmp();
  try {
    const stub = stubBrowser();
    const d = doc(figure(1, { kind: 'svg', text: SVG }));
    const ctx = { cacheDir: t.dir, docDir: t.dir, theme, withBrowser: stub.withBrowser };
    await renderFigures(d, { ...ctx, cacheVersion: 'v1' });
    assert.equal(stub.log.launches, 1);
    await renderFigures(d, { ...ctx, cacheVersion: 'v1' });
    assert.equal(stub.log.launches, 1);
    await renderFigures(d, { ...ctx, cacheVersion: 'v2' });
    assert.equal(stub.log.launches, 2);
    assert.equal(readdirSync(t.dir).filter((f) => f.endsWith('.png')).length, 2);
  } finally {
    t.done();
  }
});

test('the default cache version names the plugin release and the vendored Mermaid', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(RENDER_CACHE_VERSION, `${pkg.version}+mermaid-${MERMAID_VERSION}`);
  assert.ok(readFileSync(new URL('../../render/vendor/README.md', import.meta.url), 'utf8').includes(`Mermaid ${MERMAID_VERSION}`));
});

test('Mermaid fonts are loaded before mermaid.render', async () => {
  const t = tmp();
  try {
    const stub = stubBrowser();
    const d = doc(figure(1, { kind: 'mermaid', text: 'flowchart LR\n  A --> B' }));
    await renderFigures(d, { cacheDir: t.dir, docDir: t.dir, theme, withBrowser: stub.withBrowser });
    const load = stub.log.evaluated.findIndex((src) => src.includes('fonts.load'));
    const render = stub.log.evaluated.findIndex((src) => src.includes('mermaid.render'));
    assert.ok(load >= 0 && render > load, `${load} ${render}`);
    assert.match(stub.log.evaluated[load], /\[400, 600, 700\]/);
    assert.match(stub.log.evaluated[load], /16px "Inter Tight"/);
  } finally {
    t.done();
  }
});

test('a figure path outside the project root throws a located error', async () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, 'project', 'docs'), { recursive: true });
    writeFileSync(join(t.dir, 'secret.png'), DOT);
    const d = doc(figure(1, { kind: 'png', path: '../../secret.png' }, 9));
    const ctx = { cacheDir: join(t.dir, 'cache'), docDir: join(t.dir, 'project', 'docs'), theme };
    await assert.rejects(renderFigures(d, { ...ctx, projectRoot: join(t.dir, 'project') }), /^Error: docs\/D1\.md:9: figure path is outside the project$/);
    // Inside the project root the same file is fine.
    const ok = await renderFigures(d, { ...ctx, projectRoot: t.dir });
    assert.equal(ok.get('fig-1').width, 1);
    // The default root is the document folder.
    await assert.rejects(renderFigures(d, ctx), /figure path is outside the project/);
  } finally {
    t.done();
  }
});

test('a figure that is a symbolic link leaving the project is refused', async () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, 'project'));
    writeFileSync(join(t.dir, 'secret.png'), DOT);
    symlinkSync(join(t.dir, 'secret.png'), join(t.dir, 'project', 'link.png'));
    const d = doc(figure(1, { kind: 'png', path: 'link.png' }, 4));
    await assert.rejects(
      renderFigures(d, { cacheDir: join(t.dir, 'cache'), docDir: join(t.dir, 'project'), theme }),
      /^Error: docs\/D1\.md:4: figure path is outside the project$/,
    );
  } finally {
    t.done();
  }
});

test('a PNG figure with a short body, a bad signature or no IHDR is not a valid PNG', async () => {
  const t = tmp();
  try {
    const bad = {
      'short.png': DOT.subarray(0, 20),
      'text.png': Buffer.from('this is certainly not a picture, just text padding bytes'),
      'noihdr.png': Buffer.concat([DOT.subarray(0, 12), Buffer.from('XXXX'), DOT.subarray(16)]),
    };
    for (const [name, bytes] of Object.entries(bad)) {
      writeFileSync(join(t.dir, name), bytes);
      const d = doc(figure(1, { kind: 'png', path: name }, 5));
      await assert.rejects(
        renderFigures(d, { cacheDir: join(t.dir, 'cache'), docDir: t.dir, theme }),
        new RegExp(`^Error: docs/D1\\.md:5: ${name.replace('.', '\\.')} is not a valid PNG$`),
      );
    }
  } finally {
    t.done();
  }
});

test('writeAtomic leaves no temporary file when the rename fails', () => {
  const t = tmp();
  try {
    const target = join(t.dir, 'target.png');
    mkdirSync(join(target, 'occupied'), { recursive: true });
    assert.throws(() => writeAtomic(target, DOT));
    assert.deepEqual(readdirSync(t.dir), ['target.png']);
    writeAtomic(join(t.dir, 'fine.png'), DOT);
    assert.deepEqual(readdirSync(t.dir).sort(), ['fine.png', 'target.png']);
  } finally {
    t.done();
  }
});

test('every figure page routes requests so that only file: and data: get through', async () => {
  const t = tmp();
  try {
    const stub = stubBrowser();
    await renderFigures(doc(figure(1, { kind: 'svg', text: SVG })), { cacheDir: t.dir, docDir: t.dir, theme, withBrowser: stub.withBrowser });
    assert.ok(stub.log.contexts > 0);
    assert.equal(stub.log.routes, stub.log.contexts);
  } finally {
    t.done();
  }
});

test('an HTML figure that loads a remote image still renders, and the request never leaves', { skip }, async () => {
  const t = tmp();
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'image/png' }); res.end(DOT); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    writeFileSync(join(t.dir, 'remote.html'), `<!doctype html><html><body><div class="fig" style="width:100px;height:40px"><img src="http://127.0.0.1:${port}/leak.png"><script>fetch('http://127.0.0.1:${port}/fetch').catch(() => {});</script></div></body></html>`);
    const d = doc(figure(1, { kind: 'html', path: 'remote.html' }));
    const out = await withBrowser((browser) => renderFigures(d, { browser, cacheDir: join(t.dir, 'cache'), docDir: t.dir, theme }));
    assert.equal(out.get('fig-1').width, 200);
    assert.deepEqual(hits, []);
  } finally {
    server.close();
    t.done();
  }
});
