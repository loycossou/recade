import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

async function helpMarkdown() {
  const out = [];
  const code = await run(['help', '--markdown'], {
    stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, cwd: repo, env: {},
  });
  assert.equal(code, 0);
  return out.join('');
}

test('README command map matches recade help --markdown', async () => {
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  const start = readme.indexOf('<!-- commands:start -->');
  const end = readme.indexOf('<!-- commands:end -->');
  assert.ok(start >= 0 && end > start, 'README has both command markers');
  const block = readme.slice(start + '<!-- commands:start -->'.length, end);
  assert.equal(block.trim(), (await helpMarkdown()).trim());
});

test('help --markdown prints two tables with Command, What it does, Status', async () => {
  const text = await helpMarkdown();
  assert.equal(text.match(/^\| Command \| What it does \| Status \|$/gm).length, 2);
  assert.match(text, /^\| `\/recade:start` \| .+ \| available \|$/m);
  assert.match(text, /^\| `\/recade:new` \| .+ \| available \|$/m);
  assert.match(text, /^\| `\/recade:adopt` \| .+ \| available \|$/m);
  assert.match(text, /^\| `\/status` \| .+ \| available \|$/m);
  assert.match(text, /^\| `\/recade:harness` \| .+ \| available \|$/m);
});

test('help rejects unknown options', async () => {
  const err = [];
  const code = await run(['help', '--json'], {
    stdout: { write: () => {} }, stderr: { write: (s) => err.push(s) }, cwd: repo, env: {},
  });
  assert.equal(code, 2);
  assert.equal(err.join(''), 'Usage: recade help [--markdown]\n');
});

test('README is short, has the author line, and no raw e-mail address', () => {
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  assert.ok(readme.split('\n').length < 200);
  assert.ok(readme.includes('Loyc COSSOU · loycossou[at]gmail.com · https://github.com/loycossou'));
});
