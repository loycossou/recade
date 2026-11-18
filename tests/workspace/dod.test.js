import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createWorkspace } from '../../src/workspace/layout.js';
import { defaultExec as asyncExec } from '../../src/doctor.js';
import { defaultExec as syncExec } from '../../src/harness/stamps.js';
import { tickDod } from '../../src/project/slices.js';
import { run } from '../../src/cli.js';
import { git, makeIO } from '../harness/fixture-project.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'recade-dod-')));
const must = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const write = (ws, file, text) => {
  mkdirSync(join(ws, file, '..'), { recursive: true });
  writeFileSync(join(ws, file), text);
};
const subjects = (ws) => must(git(ws, 'log', '--format=%s')).stdout.trim().split('\n').reverse();

const SHEET = `---
id: S-01
title: Repayment schedule
lane: standard
touches: [api:src/**]
---

## Goal

A schedule.

## Definition of Done

| # | Command (counts tests) | Expected | Seen red first? | Done |
|---|---|---|---|---|
| 1 | \`npm test\` (4 tests) | green | yes | [ ] |
| 2 | \`npm run lint\` | clean | n/a | [ ] |
| 3 | \`npm run e2e\` (2 tests) | green | yes | [ ] |

## Guardrails

- A cell with [ ] outside the table stays as it is.
`;

async function workspace(extraState = {}) {
  const parent = join(tmp(), 'Projets Clients');
  mkdirSync(parent);
  const { dir } = await createWorkspace(parent, 'Ete', { exec: asyncExec });
  write(dir, 'recade/state.yaml', stringify({ version: 1, kind: 'workspace', repos: [{ name: 'api', path: 'repos/api' }], ...extraState }));
  write(dir, 'slices/S-01-schedule.md', SHEET);
  must(git(dir, 'config', 'user.name', 'ci'));
  must(git(dir, 'config', 'user.email', ['ci', 'example.invalid'].join('@')));
  must(git(dir, 'add', '-A'));
  must(git(dir, 'commit', '-q', '-m', 'chore: start'));
  return dir;
}

function recorder() {
  const pushes = [];
  const exec = (cmd, opts) => {
    if (cmd[0] === 'git' && cmd.includes('push')) {
      pushes.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd[0] === 'git' && cmd.includes('refs/remotes/origin/HEAD')) return { code: 0, stdout: 'origin/main\n', stderr: '' };
    return syncExec(cmd, opts);
  };
  return { exec, pushes };
}

test('tickDod ticks the row of the DoD table whose # is n, and nothing else', () => {
  const r = tickDod(SHEET, 2);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.match(r.text, /\| 2 \| `npm run lint` \| clean \| n\/a \| \[x\] \|/);
  assert.match(r.text, /\| 1 \|.*\[ \] \|/);
  assert.match(r.text, /\| 3 \|.*\[ \] \|/);
  assert.match(r.text, /A cell with \[ \] outside the table stays as it is\./);
  assert.equal(r.text.split('[x]').length - 1, 1);
});

test('tickDod on a row that is already ticked changes nothing, and a row that does not exist is refused', () => {
  const once = tickDod(SHEET, 1).text;
  const twice = tickDod(once, 1);
  assert.deepEqual([twice.ok, twice.changed, twice.text], [true, false, once]);
  const none = tickDod(SHEET, 9);
  assert.equal(none.ok, false);
  assert.match(none.message, /no row 9 in the Definition of Done/);
  assert.equal(tickDod('# nothing\n', 1).ok, false);
});

test('tickDod keeps CRLF line ends', () => {
  const r = tickDod(SHEET.replaceAll('\n', '\r\n'), 3);
  assert.equal(r.ok, true);
  assert.equal(/[^\r]\n/.test(r.text), false);
  assert.match(r.text, /\| 3 \|.*\[x\] \|\r\n/);
});

test('recade slices dod S-01 --tick 2 edits the sheet under the workspace lock, commits it and makes no push', async () => {
  const ws = await workspace({ workspace: { auto_push: true, auto_push_since: '2026-11-18' } });
  write(ws, 'intake/draft.md', 'owner work in progress\n');
  const rec = recorder();
  const t = makeIO(ws, { run: rec.exec });
  assert.equal(await run(['slices', 'dod', 'S-01', '--tick', '2'], t.io), 0, t.err.join(''));
  assert.match(t.out.join(''), /S-01: DoD row 2 ticked/);
  assert.match(readFileSync(join(ws, 'slices', 'S-01-schedule.md'), 'utf8'), /\| 2 \|.*\[x\] \|/);
  assert.equal(subjects(ws).at(-1), 'docs(slices): tick DoD row 2 of S-01');
  assert.deepEqual(must(git(ws, 'show', '--name-only', '--format=', 'HEAD')).stdout.trim().split('\n'), ['slices/S-01-schedule.md']);
  assert.match(must(git(ws, 'status', '--porcelain')).stdout, /\?\? intake\/draft\.md/);
  assert.deepEqual(rec.pushes, [], 'a tick is not an end of phase: no push');
});

test('several --tick options tick several rows in one commit, and a second run is a no-op with no commit', async () => {
  const ws = await workspace();
  const t = makeIO(ws, { run: syncExec });
  assert.equal(await run(['slices', 'dod', 'S-01', '--tick', '1', '--tick', '3'], t.io), 0, t.err.join(''));
  const text = readFileSync(join(ws, 'slices', 'S-01-schedule.md'), 'utf8');
  assert.equal(text.split('[x]').length - 1, 2);
  assert.equal(subjects(ws).at(-1), 'docs(slices): tick DoD rows 1, 3 of S-01');
  const before = subjects(ws).length;
  const again = makeIO(ws, { run: syncExec });
  assert.equal(await run(['slices', 'dod', 'S-01', '--tick', '1'], again.io), 0, again.err.join(''));
  assert.match(again.out.join(''), /already ticked/);
  assert.equal(subjects(ws).length, before);
});

test('slices dod refuses an unknown row or sheet with exit 1, a bad call with exit 2, and writes nothing', async () => {
  const ws = await workspace();
  const sheet = readFileSync(join(ws, 'slices', 'S-01-schedule.md'), 'utf8');
  const bad = makeIO(ws, { run: syncExec });
  assert.equal(await run(['slices', 'dod', 'S-01', '--tick', '9'], bad.io), 1);
  assert.match(bad.err.join(''), /no row 9/);
  const nosheet = makeIO(ws, { run: syncExec });
  assert.equal(await run(['slices', 'dod', 'S-07', '--tick', '1'], nosheet.io), 1);
  assert.match(nosheet.err.join(''), /No sheet for S-07/);
  for (const args of [['dod'], ['dod', 'S-01'], ['dod', 'S-01', '--tick'], ['dod', 'S-01', '--tick', 'one'], ['dod', 'S-01', '--tick', '0'], ['dod', 'one', '--tick', '1'], ['dod', 'S-01', '--untick', '1']]) {
    const t = makeIO(ws, { run: syncExec });
    assert.equal(await run(['slices', ...args], t.io), 2, args.join(' '));
  }
  assert.equal(readFileSync(join(ws, 'slices', 'S-01-schedule.md'), 'utf8'), sheet);
  assert.equal(subjects(ws).length, 1);
});

test('slices dod refuses when the sheet already has changes the step did not make', async () => {
  const ws = await workspace();
  write(ws, 'slices/S-01-schedule.md', `${SHEET}\nAn edit of the owner.\n`);
  const t = makeIO(ws, { run: syncExec });
  assert.equal(await run(['slices', 'dod', 'S-01', '--tick', '1'], t.io), 1);
  assert.match(t.err.join(''), /already has changes that this step did not make/);
  assert.match(t.err.join(''), /Commit it with `recade workspace commit --paths slices\/S-01-schedule\.md -m '<message>'` \(or restore it\), then run this command again\./);
  assert.doesNotMatch(readFileSync(join(ws, 'slices', 'S-01-schedule.md'), 'utf8'), /\[x\]/);
});
