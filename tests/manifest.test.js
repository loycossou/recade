import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from '../src/files.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(join(repo, p), 'utf8'));

const pkg = readJson('package.json');
const plugin = readJson('.claude-plugin/plugin.json');
const market = readJson('.claude-plugin/marketplace.json');

test('versions match across package, plugin and marketplace', () => {
  assert.equal(pkg.version, '1.5.2');
  assert.equal(plugin.version, '1.5.2');
  assert.equal(market.plugins[0].version, '1.5.2');
});

test('plugin.json has name recade, MIT, author name and url, no email key anywhere', () => {
  assert.equal(plugin.name, 'recade');
  assert.equal(plugin.license, 'MIT');
  assert.equal(plugin.author.name, 'Loyc COSSOU');
  assert.equal(plugin.author.url, 'https://github.com/loycossou');
  const hasEmailKey = (value) =>
    value !== null &&
    typeof value === 'object' &&
    Object.entries(value).some(
      ([key, child]) => key.toLowerCase().includes('email') || hasEmailKey(child),
    );
  assert.equal(hasEmailKey(plugin), false);
  assert.equal(hasEmailKey(market), false);
});

test('marketplace lists exactly one plugin named recade with source "./"', () => {
  assert.equal(market.name, 'recade');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, 'recade');
  assert.equal(market.plugins[0].source, './');
});

test('no file in the repo contains a raw e-mail address', () => {
  const emailRe = /[\w.+-]+@[\w-]+\.[\w.]+/g;
  // The lock file is generated and quotes third-party maintainers' public addresses; the vendored Mermaid bundle
  // holds package@version strings that look like addresses (checked: it has no real address).
  const files = listFiles(repo, { exts: ['.md', '.json', '.js', '.yml', '.yaml'], ignore: ['package-lock.json', 'mermaid.min.js'] });
  assert.ok(files.length > 0);
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(join(repo, file), 'utf8');
    for (const match of text.match(emailRe) ?? []) {
      if (!match.endsWith('@users.noreply.github.com')) offenders.push(`${file}: ${match}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('marketplace has a one-sentence description in the voice of plugin.json', () => {
  const text = market.metadata?.description;
  assert.equal(typeof text, 'string');
  assert.equal(text, plugin.description);
  assert.equal((text.match(/[.!?](\s|$)/g) ?? []).length, 1);
  assert.equal(market.plugins[0].description, plugin.description);
});

test('CI runs on main and pull requests, reads contents only and guards names once', () => {
  const ci = readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /^permissions:\n {2}contents: read$/m);
  assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:$/m);
  assert.match(ci, /if: matrix\.node == 22 && github\.event_name == 'push' && github\.repository == 'loycossou\/recade'/);
  const guard = ci.slice(ci.indexOf('node bin/recade.js guard-names') - 120);
  assert.match(guard, /if: matrix\.node == 22/);
  assert.ok(ci.indexOf('Require the private name list') < ci.indexOf('guard-names'));
  assert.equal(/npm run e2e|tools\/e2e/.test(ci), false, 'npm test already runs the end-to-end driver, so CI does not run it a second time');
});
