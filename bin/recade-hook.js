#!/usr/bin/env node
// SessionStart hook. Zero dependencies: a plugin installed from GitHub has no node_modules,
// so this file reads the config with plain Node and never imports `yaml`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../src/paths.js';
import { sessionStartOutput } from '../src/hook.js';

let text;
try {
  text = readFileSync(join(configDir(process.env), 'config.yaml'), 'utf8');
} catch {
  // No config file, or unreadable: the user is not started.
}

const output = sessionStartOutput(text);
if (output) process.stdout.write(`${output}\n`);
