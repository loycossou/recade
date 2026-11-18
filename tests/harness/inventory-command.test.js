import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AXES } from '../../src/project/fromcode.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = readFileSync(join(repo, 'harness', 'commands', 'inventory.md'), 'utf8');
const between = (from, to) => text.slice(text.indexOf(from), to === undefined ? undefined : text.indexOf(to));

test('the inventory command picks the reading tier by repository size before it gathers', () => {
  const gather = between('## Step 2. Gather', '## Step 3.');
  for (const part of ['under 50 files: read all of them', '50 to 500: read a sample', 'over 500: the entry points first, then one level down', 'at most 15 files for each capability',
    '`deferred`', 'Never state a fact about a file that was not read']) {
    assert.ok(gather.includes(part), part);
  }
  assert.ok(gather.indexOf('under 50 files') < gather.indexOf('Dispatch `explorer`'), 'the tier is picked before the first dispatch');
});

test('the inventory command asks along four dimensions and decides conventions one at a time', () => {
  const gather = between('## Step 2. Gather', '## Step 3.');
  for (const part of ['file anatomy', 'state and control flow', 'infrastructure', 'error handling', 'over 95 percent', 'fewer than 10 counter cases', 'recorded as a rule and its minority as a DONT, and nothing is asked',
    'A close split becomes one question to the owner', '`path:line`', 'a recommended option first and a safe default last', 'Ask one question, wait for the answer', 'Never ask two at once']) {
    assert.ok(gather.includes(part), part);
  }
});

test('the inventory command writes the deviations register with its four axes, evidence on each row and a refusal without it', () => {
  const write = between('## Step 3. Write');
  assert.ok(write.includes('H2 section "Deviations"'));
  assert.ok(write.includes('`ID | Axis | Deviation | Evidence | Severity | Effort`'));
  for (const axis of AXES) assert.ok(write.includes(axis), axis);
  for (const part of ['P0, P1, P2 or P3', 'S, M or L', 'A row with no evidence is refused', 'tell the owner which one you dropped']) assert.ok(write.includes(part), part);
  assert.equal(text.includes(String.fromCharCode(0x2014)), false);
});
