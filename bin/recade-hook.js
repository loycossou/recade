#!/usr/bin/env node
// The hooks of the plugin. Zero dependencies: a plugin installed from GitHub may have no node_modules yet, so this file
// reads with plain Node and never imports `yaml`.
// - SessionStart (no argument): the welcome of a user who has not run /recade:start.
// - Stop (--stop): in a Recade workspace whose owner turned auto-push on, push the commits a step left behind.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../src/paths.js';
import { sessionStartOutput } from '../src/hook.js';
import { autoPushWorkspace } from '../src/stophook.js';

if (process.argv.includes('--stop')) {
  let event = null;
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    event = null;
  }
  const start = typeof event?.cwd === 'string' ? event.cwd : process.cwd();
  const ws = autoPushWorkspace(start, { exists: existsSync, read: (f) => readFileSync(f, 'utf8') });
  if (ws !== null) {
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'recade.js');
    const r = spawnSync(process.execPath, [cli, 'workspace', 'push'], { cwd: resolve(ws), encoding: 'utf8', timeout: 50_000 });
    const warning = String(r.stderr ?? '').split('\n').find((l) => l.startsWith('recade: warning: '));
    // A failed push is shown to the owner once per turn; the next turn tries again.
    if (warning !== undefined) process.stdout.write(`${JSON.stringify({ systemMessage: `Recade: ${warning.slice('recade: warning: '.length)}` })}\n`);
  }
  process.exit(0);
}

let text;
try {
  text = readFileSync(join(configDir(process.env), 'config.yaml'), 'utf8');
} catch {
  // No config file, or unreadable: the user is not started.
}

const output = sessionStartOutput(text);
if (output) process.stdout.write(`${output}\n`);
