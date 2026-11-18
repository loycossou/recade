import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The documents say what the code does: the main-session-only commands, when the code repositories are created, what
// adopt writes in a code repository, when publish-check checks names, and the gate order of an adopted project.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8');

test('adopt.md defines <dir>, may commit in the workspace with git, and says how --project is used', () => {
  const text = read('commands/adopt.md');
  const tools = /^allowed-tools: (.*)$/m.exec(text)[1];
  assert.ok(tools.includes('Bash(git:*)'), 'the git add and commit of the steps are granted');
  assert.ok(text.includes('From Step 4 on, `<dir>` is the workspace folder: the folder `recade workspace root` prints'));
  assert.equal(text.includes('There is no `--project` of the other commands here'), false);
});

test('new.md creates the code repositories after G2, as docs.md and harness.md do', () => {
  const text = read('commands/new.md');
  assert.equal(text.includes('after the stack gate'), false);
  assert.ok(text.includes('The code repositories are created later, after G2 (`/recade:docs`)'));
});

test('design.md lists the six main-session-only commands, recade workspace commit included', () => {
  const text = read('docs/design.md');
  assert.equal(text.includes('`recade repo sync`, `recade repo add` and `recade harness specialise` (which writes'), false);
  assert.equal(text.includes('the guard refuses all three'), false);
  assert.ok(text.includes('`recade repo sync`, `recade repo add`, `recade harness specialise` (which writes the specialisation of an agent or command file), `recade workspace commit`'));
  assert.ok(text.includes('`recade workspace commit`, `recade workspace auto-push` or `recade guard snapshot`: the guard refuses all six'));
});

test('CHANGELOG says what adopt writes in a code repository, as README and adopt.md do', () => {
  const text = read('CHANGELOG.md');
  assert.equal(text.includes('nothing else is written in the code repository'), false);
  assert.ok(text.includes('`.gitignore` gets appended lines, `CLAUDE.md` a generated block, and `dependabot.yml` is written only when absent'));
});

test('README and design.md say that publish-check checks private names only with a list', () => {
  for (const rel of ['README.md', 'docs/design.md']) {
    const text = read(rel);
    assert.equal(/no private name,|a private name, a file over/.test(text), false, rel);
    assert.ok(text.includes('`--require-names`'), rel);
  }
});

test('status.md gives the gate order of an adopted project too', () => {
  assert.ok(read('commands/status.md').includes('In mode `adopt` the first gate is `G0-inventory` instead of `G0`'));
});

test('the prompts say what the final guard and sync fixes do: snapshot --replace, the rm and reset floor, a fresh clone, repo add --clone', () => {
  const slice = read('harness/commands/slice.md');
  assert.ok(slice.includes("On `Take a new snapshot`, run `recade guard snapshot --slice '<S-nn>' --replace`: without `--replace` the command refuses to overwrite the snapshot file."));
  assert.ok(slice.includes('`recade guard snapshot` refuses to overwrite an existing snapshot (exit 2); only the owner\'s explicit choice adds `--replace`.'));
  const protocol = read('harness/protocol.md');
  assert.ok(protocol.includes('the guard reads the words after the shell removes quotes and backslashes'));
  assert.ok(protocol.includes('For an agent, the guard refuses `rm -r` and `find -delete` whose target is or holds the workspace, its `repos/`, its `.git` or a registered repository, and `git clean` or `git reset --hard` run in the workspace or in another registered repository.'));
  const resume = read('commands/resume.md');
  const fresh = resume.indexOf("On a fresh clone of the workspace on another machine, the guard has no plugin root yet: run `recade repo sync --project '<dir>'` first.");
  assert.ok(fresh > 0 && fresh < resume.indexOf('recade config get languages.chat'), 'the sync comes before the first config get');
  assert.ok(resume.includes('`recade repo check` names a repository whose git hooks are off.'));
  for (const rel of ['docs/design.md', 'README.md']) {
    const text = read(rel);
    assert.ok(text.includes("A local folder is cloned; the registry records the folder's own `origin`, or `none` when it has none. A URL with a password or a token is refused."), rel);
  }
});
