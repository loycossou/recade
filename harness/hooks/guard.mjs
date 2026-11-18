#!/usr/bin/env node
// PreToolUse guard of the Recade harness. Prints a deny decision, or nothing to allow.
// Only `node:` builtins here. The decision code lives in the plugin: src/harness/guard.js.
// A project runs it through its launcher, .claude/hooks/recade-guard.mjs, which reads the plugin folder from
// .recade/plugin-root and calls runGuard. Run directly, it takes the plugin folder from RECADE_PLUGIN_ROOT when that
// folder has the decision code, else its own folder. When the decision code cannot load or fails, write tools and Bash
// are refused (fail closed) and the error goes to .recade/guard.log.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GUARDED = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

/**
 * The decision for one hook call: the deny JSON, or '' to allow. Throws when the decision code cannot load or fails.
 * @param {string} stdin the hook input
 * @param {{pluginRoot: string, start?: string}} options
 * @returns {Promise<string>}
 */
export async function runGuard(stdin, { pluginRoot, start = process.cwd() }) {
  const { handleHook } = await import(pathToFileURL(join(pluginRoot, 'src', 'harness', 'guard.js')).href);
  return handleHook(stdin, { cwd: start, pluginRoot });
}

const isMain = typeof process.argv[1] === 'string' && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const stdin = Buffer.concat(chunks).toString('utf8');
  let event = null;
  try {
    event = JSON.parse(stdin);
  } catch {
    // The handler reports malformed input.
  }
  const start = typeof event?.cwd === 'string' && existsSync(event.cwd) ? event.cwd : process.cwd();
  const own = fileURLToPath(new URL('../../', import.meta.url));
  const env = process.env.RECADE_PLUGIN_ROOT;
  const pluginRoot = env && existsSync(join(env, 'src', 'harness', 'guard.js')) ? env : own;
  let out;
  try {
    out = await runGuard(stdin, { pluginRoot, start });
  } catch (err) {
    const message = String(err?.message ?? err).split('\n')[0];
    try {
      mkdirSync(join(start, '.recade'), { recursive: true });
      appendFileSync(join(start, '.recade', 'guard.log'), `${new Date().toISOString()} guard error, call refused: ${message}\n`);
    } catch {
      // The decision below still holds.
    }
    const tool = typeof event?.tool_name === 'string' ? event.tool_name : null;
    out = tool !== null && !GUARDED.has(tool) ? '' : JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `The Recade guard failed (${message}), so write tools and Bash are refused. Run /recade:harness again in this project.` },
    });
  }
  if (out !== '') process.stdout.write(`${out}\n`);
}
