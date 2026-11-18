import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// In a workspace, `recade harness set --required-gates` run in a code repository writes the gates to that repository's
// `.claude/recade.yaml`, not to the state. /slice and /merge-order read them there, through `recade gate check` run in
// the repository, which lists the gates of `.claude/recade.yaml` first and the state only when the repository has none.

const plugin = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const command = (n) => readFileSync(join(plugin, 'harness', 'commands', `${n}.md`), 'utf8');

test('/slice reads the required gates of each repository from its own settings, not from the state', () => {
  const text = command('slice');
  assert.equal(/Read `[^\n]*harness\.required_gates`[^\n]*recade state show|state show --json`[^\n]*`harness\.required_gates`/.test(text), false, 'the state is not the source of the required gates');
  for (const part of ["recade gate check --project '<worktree>'", '`.claude/recade.yaml`', 'required gates of that repository']) assert.ok(text.includes(part), part);
});

test('/merge-order reads the required gates in the folder of the rebase, and hands them to the merge-keeper', () => {
  const text = command('merge-order');
  assert.equal(text.includes('`harness.required_gates` and `hotspots`'), false, 'the state is not the source of the required gates');
  for (const part of ["recade gate check --project '<folder>'", '`.claude/recade.yaml`']) assert.ok(text.includes(part), part);
});
