import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleHook, decide } from '../../src/harness/guard.js';
import { SPEC_LINE, install } from '../../src/harness/install.js';
import { specialise } from '../../src/harness/specialise.js';
import { cli, makeWorkspace, plugin } from './fixture-project.js';

const REF = 'v1.0.0';
const GRID = '## Domain grid\n\n- DG-01: a loan never has a negative balance. Source: BIBLE-R-04.\n';
const tmpFile = (text) => {
  const file = join(mkdtempSync(join(tmpdir(), 'recade-spec-')), 'text.md');
  writeFileSync(file, text);
  return file;
};

async function withCode() {
  const ws = await makeWorkspace({ repos: ['api', 'web'] });
  install(ws.dir, { pluginRoot: plugin, target: 'workspace', ref: REF });
  for (const name of ['api', 'web']) install(ws.repo(name), { pluginRoot: plugin, target: 'code', workspace: ws.dir, ref: REF });
  return ws;
}

test('specialise adds the text below the specialisation line, once, and a reinstall keeps it', async () => {
  const ws = await withCode();
  // Every agent lives in the workspace: that is where the team specialises it.
  const file = join(ws.dir, '.claude', 'agents', 'domain-reviewer.md');
  const before = readFileSync(file, 'utf8');
  assert.ok(before.endsWith(`${SPEC_LINE}\n`));
  assert.equal(specialise(ws.dir, 'agent', 'domain-reviewer', GRID).status, 'updated');
  const after = readFileSync(file, 'utf8');
  assert.ok(after.startsWith(before.slice(0, before.indexOf(SPEC_LINE))), 'the generic part above the line is untouched');
  assert.ok(after.endsWith(`${SPEC_LINE}\n\n${GRID}`));
  assert.equal(specialise(ws.dir, 'agent', 'domain-reviewer', GRID).status, 'unchanged');
  assert.equal(readFileSync(file, 'utf8'), after);
  install(ws.dir, { pluginRoot: plugin, target: 'workspace', ref: REF });
  assert.ok(readFileSync(file, 'utf8').includes('DG-01'), 'a re-install keeps the text');
  // A second text is appended after the first.
  specialise(ws.dir, 'agent', 'domain-reviewer', '## More\n\n- Another check.\n');
  assert.match(readFileSync(file, 'utf8'), /DG-01[\s\S]*## More/);
  // A code repository holds no agent to specialise.
  assert.throws(() => specialise(ws.repo('api'), 'agent', 'domain-reviewer', GRID), /No agent domain-reviewer/);
});

test('specialise works on a command of the workspace, and refuses a bad kind, a bad name, a missing file, a file with no line and a bad text', async () => {
  const ws = await withCode();
  specialise(ws.dir, 'command', 'status', 'Show the open DECs too.\n');
  assert.ok(readFileSync(join(ws.dir, '.claude', 'commands', 'status.md'), 'utf8').endsWith(`${SPEC_LINE}\n\nShow the open DECs too.\n`));
  assert.throws(() => specialise(ws.dir, 'hook', 'status', 'x'), /agent or command/);
  assert.throws(() => specialise(ws.dir, 'agent', 'Bad Name', 'x'), /The name of an agent is/);
  assert.throws(() => specialise(ws.dir, 'command', 'Bad Name', 'x'), /The name of a command is/);
  for (const name of ['../x', 'Status', 'a b', '', '-x']) assert.throws(() => specialise(ws.dir, 'command', name, 'x'), /name/, name);
  assert.throws(() => specialise(ws.repo('api'), 'agent', 'domain-reviewer', 'x'), /No agent domain-reviewer/);
  const bare = join(ws.dir, '.claude', 'agents', 'reviewer.md');
  writeFileSync(bare, 'no line here\n');
  assert.throws(() => specialise(ws.dir, 'agent', 'reviewer', 'x'), /specialisation line/);
  assert.equal(readFileSync(bare, 'utf8'), 'no line here\n');
  for (const text of ['', '   \n', `x\n${SPEC_LINE}\ny`, 'x\n<!-- recade-harness v9.9.9: specialise below the line -->\n', 'a\0b']) {
    assert.throws(() => specialise(ws.dir, 'agent', 'implementer', text), /text|line|header/, JSON.stringify(text));
  }
});

test('recade harness specialise: from the workspace with --target workspace, the pointer of a code repository, and the usage errors', async () => {
  const ws = await withCode();
  const text = tmpFile(GRID);
  const ok = await cli(ws.dir, ['harness', 'specialise', 'agent', 'domain-reviewer', '--file', text, '--target', 'workspace', '--project', ws.dir]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^updated .*domain-reviewer\.md/s);
  assert.ok(readFileSync(join(ws.dir, '.claude', 'agents', 'domain-reviewer.md'), 'utf8').includes('DG-01'));
  // A code repository has no agent, only the pointer command.
  assert.equal((await cli(ws.dir, ['harness', 'specialise', 'agent', 'domain-reviewer', '--file', text, '--target', 'code', '--repo', 'api'])).code, 1, 'no agent in a code repository');
  const pointer = await cli(ws.repo('web'), ['harness', 'specialise', 'command', 'slice', '--file', text]);
  assert.equal(pointer.code, 0, pointer.stderr);
  assert.ok(readFileSync(join(ws.repo('web'), '.claude', 'commands', 'slice.md'), 'utf8').includes('DG-01'), 'inside a repository it is that repository');
  const wsCmd = await cli(ws.dir, ['harness', 'specialise', 'command', 'status', '--file', text, '--target', 'workspace']);
  assert.equal(wsCmd.code, 0, wsCmd.stderr);
  assert.equal((await cli(ws.dir, ['harness', 'specialise', 'agent', 'domain-reviewer', '--file', join(ws.dir, 'nope.md'), '--target', 'workspace'])).code, 1, 'a missing text file');
  for (const args of [['agent', 'x'], ['agent', 'x', '--file'], ['hook', 'x', '--file', text], ['agent', '--file', text], ['agent', 'x', 'y', '--file', text], ['agent', 'x', '--file', text, '--bogus']]) {
    const r = await cli(ws.dir, ['harness', 'specialise', ...args]);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /Usage: recade harness .*specialise <agent\|command> <name> --file <path>/);
  }
});

test('no agent runs recade harness specialise: the guard refuses it, and keeps refusing agent file edits, while the main session may run it', async () => {
  const ws = await withCode();
  const cliPath = join(plugin, 'bin', 'recade.js');
  const text = tmpFile(GRID);
  const command = `node ${cliPath} harness specialise agent reviewer --file ${text}`;
  const A = ws.dir;
  const bash = (agent, c) => handleHook(JSON.stringify({ cwd: A, ...(agent ? { agent_type: agent } : {}), tool_name: 'Bash', tool_input: { command: c } }), { pluginRoot: plugin });
  for (const agent of ['implementer', 'general-purpose']) {
    const out = JSON.parse(await bash(agent, command));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', agent);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /specialise/);
  }
  assert.equal(await bash(null, command), '', 'the main session runs it');
  // A restricted agent of a plain project is refused too.
  const allow = { globs: ['docs/**'], unresolved: [] };
  const r = decide({ agentType: 'doc-writer', tool: 'Bash', input: { command }, allow, root: '/p' });
  assert.equal(r.allow, false);
  // The agent files stay protected from the write tools.
  const write = JSON.parse(await handleHook(JSON.stringify({ cwd: A, tool_name: 'Edit', tool_input: { file_path: join(A, '.claude', 'agents', 'reviewer.md'), old_string: 'a', new_string: 'b' } }), { pluginRoot: plugin }));
  assert.equal(write.hookSpecificOutput.permissionDecision, 'deny');
});
