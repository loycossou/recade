#!/usr/bin/env node
// The guard of the plugin, run by its PreToolUse hook (hooks/hooks.json) in every session where the plugin is on.
// It decides only inside a Recade project: a folder with recade/state.yaml above it, or a code repository linked to a
// workspace (.recade/workspace). Anywhere else it allows everything and costs one walk up the folders. Inside a
// project, a guard that cannot run refuses write tools and Bash (fail closed). Zero dependencies: only node: builtins
// and the decision code of the plugin (src/harness/guard.js), which has none either.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recadeProject } from '../src/hookscope.js';
import { installAllowed, installCommand } from '../src/guardrescue.js';

const GUARDED = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch {
  stdin = '';
}
let event = null;
try {
  event = JSON.parse(stdin);
} catch {
  event = null;
}
const cwd = typeof event?.cwd === 'string' && existsSync(event.cwd) ? event.cwd : process.cwd();
const project = typeof process.env.CLAUDE_PROJECT_DIR === 'string' && process.env.CLAUDE_PROJECT_DIR !== '' ? process.env.CLAUDE_PROJECT_DIR : null;
const scope = recadeProject(project ?? cwd, { exists: existsSync }) ?? (project === null ? null : recadeProject(cwd, { exists: existsSync }));
if (scope === null) process.exit(0);

let out = '';
try {
  const { handleHook } = await import(new URL('../src/harness/guard.js', import.meta.url).href);
  out = await handleHook(stdin, { cwd, pluginRoot });
} catch (err) {
  const tool = typeof event?.tool_name === 'string' ? event.tool_name : null;
  // The repair goes through: the install of the dependencies of the plugin, and nothing else.
  const repair = tool === 'Bash' && installAllowed(event?.tool_input?.command, pluginRoot);
  if (!repair && (tool === null || GUARDED.has(tool))) {
    const message = String(err?.message ?? err).split('\n')[0];
    out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `The Recade guard cannot start (${message}), so write tools and Bash are refused in this project. If the plugin folder lacks its dependencies, this one command is allowed and repairs it: ${installCommand(pluginRoot)}` } });
  }
}
if (out !== '') process.stdout.write(`${out}\n`);
