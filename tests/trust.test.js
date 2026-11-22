import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintText } from '../src/style/lint.js';

// Trust mode: the sorting rule lives in one skill, and the commands and the stack analyst that need it cite it.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repo, path), 'utf8');
const SKILL = 'skills/decision-sorting/SKILL.md';

test('the decision-sorting skill holds the two modes, the three tests, the team close, the stack rule and the gate summary', () => {
  const text = read(SKILL);
  for (const part of [
    '`ask`, the default', 'A project without the key is `ask`', '`trust`: the team decides what is reversible and costs nothing',
    '**It costs money.**', 'a licence, a paid service or a hosting tier',
    '**It binds the client.**', 'the scope, a date, a legal term, or a promise to a third party',
    '**It cannot be undone cheaply.**', 'When in doubt, it goes to the owner.', '`supersedes:`',
    "recade decision close '<DEC-nn>' --choice '<letter>' --by team --why '<one line>'",
    'An agent never closes a DEC.',
    'when its finalists differ in money', 'or in lock-in', 'the analyst takes rank 1', 'the owner passes G2-stack',
    '**Decided by the team.**', '**What you must answer.**', '**Details on request.**',
    "recade decision team challenge '<TD-nn>' --reopen",
    'The owner says yes at every gate, G0 to G5.', 'no agent merges',
  ]) assert.ok(text.includes(part), part);
  assert.deepEqual(lintText(text, SKILL).filter((f) => f.severity === 'error'), []);
});

test('docs and bible read the mode, cite the skill, sort before they ask, close by the team and reopen a challenged DEC', () => {
  for (const file of ['commands/docs.md', 'commands/bible.md']) {
    const text = read(file);
    assert.ok(text.includes('`decisions` (the decisions mode: `ask` or `trust`)'), `${file}: reads the mode`);
    assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/skills/decision-sorting/SKILL.md'), `${file}: cites the skill`);
    const sort = text.indexOf('In trust mode, sort each open DEC first with the trust test of the skill');
    const ask = text.indexOf('Then ask the open DECs with `AskUserQuestion`');
    assert.ok(sort > 0 && sort < ask, `${file}: sorts before it asks`);
    assert.ok(text.includes("--by team --why '<one line>'"), `${file}: closes by the team`);
    assert.ok(text.includes("recade decision team challenge '<TD-nn>' --reopen"), `${file}: reopens`);
    assert.ok(text.includes('never to the trust test'), `${file}: a reopened DEC goes to the owner`);
    assert.ok(text.includes('use the short gate summary of the skill'), `${file}: short gate summary`);
    assert.ok(text.includes('"details on request"'), `${file}: details on request`);
  }
});

test('the stack in trust mode: docs passes the mode and the skill to the analyst, who asks only a layer that differs in money or lock-in', () => {
  const docs = read('commands/docs.md');
  assert.ok(docs.includes('for `stack-analyst`, the decisions mode (`ask` or `trust`) and the full path of `${CLAUDE_PLUGIN_ROOT}/skills/decision-sorting/SKILL.md`'));
  assert.ok(docs.includes('a layer is `owner` only when its finalists differ in money or in lock-in'));
  assert.ok(docs.includes('except the DECs of `STACK`'));
  const analyst = read('agents/stack-analyst.md');
  assert.ok(analyst.includes('"The stack in trust mode" of the `decision-sorting` skill'));
  assert.ok(analyst.includes('a layer is `owner` only when its finalists differ in money'));
  assert.ok(analyst.includes('A layer with no spike has no finalists: compare its top 3 ranked options instead.'));
  assert.ok(docs.includes('(for a layer with no spike, its top 3 ranked options)'));
  assert.ok(read(SKILL).includes('A layer with no spike has no finalists (in the short track, a layer whose leader is clear). Compare its top 3 ranked options instead'));
  assert.ok(analyst.includes('Never close a decision'), 'the analyst still never closes a DEC');
  assert.ok(read('skills/stack-selection/SKILL.md').includes('"The stack in trust mode" of the `decision-sorting` skill'));
});

test('new asks the mode as a closed choice and records it, status shows it', () => {
  const text = read('commands/new.md');
  for (const part of [
    '`Ask me every one`', '"ask: every open decision comes to you"', '`Trust the team`',
    'you get only the decisions that cost money, bind the client or cannot be undone',
    "recade state set decisions ask --project '<dir>'", "recade state set decisions trust --project '<dir>'",
    'the owner still passes every gate',
  ]) assert.ok(text.includes(part), part);
  assert.ok(text.indexOf('`Trust the team`') < text.indexOf('## Step 5. Analysis'), 'asked during the intake');
  assert.ok(text.includes('ask the decisions mode only when it has no `decisions:` line'), 'a resumed intake keeps the mode');
  assert.ok(text.includes('unless `<dir>/recade/state.yaml` already has a `decisions:` line (a resumed intake), ask once'), 'the question is skipped once answered');
  assert.ok(read('commands/status.md').includes('the decisions mode (`decisions`)'));
});

test('the README, the design document, the delivery chain and the changelog describe trust mode', () => {
  assert.ok(read('README.md').includes('recade state set decisions trust'));
  const design = read('docs/design.md');
  assert.ok(design.includes('**Trust the team.**') && design.includes('skills/decision-sorting/SKILL.md') && design.includes('--by team'));
  assert.ok(read('docs/delivery.md').includes('A project in trust mode (`decisions: trust`)'));
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.indexOf('### Trust the team') > changelog.indexOf('## Unreleased'));
  assert.ok(changelog.indexOf('### Trust the team') < changelog.indexOf('### One command to publish'));
});
