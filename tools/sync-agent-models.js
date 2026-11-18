#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontMatterLength } from '../src/frontmatter-lines.js';

const AGENTS = fileURLToPath(new URL('../agents/', import.meta.url));

/**
 * Copy `model` and `effort` from `models.json` into the front matter of every agent, by the agent's `tier`.
 * With `check`, nothing is written. Returns the agent files that were (or, with `check`, would be) changed.
 * Throws an Error with one line per agent that has no valid `tier`.
 * @param {string} [dir] the agents folder
 * @param {{check?: boolean}} [options]
 * @returns {string[]}
 */
export function syncAgents(dir = AGENTS, { check = false } = {}) {
  const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
  const changed = [];
  const errors = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const path = join(dir, file);
    const original = readFileSync(path, 'utf8');
    const lines = original.split('\n');
    const end = frontMatterLength(lines) - 1;
    if (end < 0) {
      errors.push(`${file}: no front matter`);
      continue;
    }
    const front = lines.slice(1, end);
    const tier = /^tier:\s*(.+?)\s*$/.exec(front.find((l) => /^tier:/.test(l)) ?? '')?.[1];
    if (tier === undefined || !Object.hasOwn(models, tier)) {
      errors.push(`${file}: unknown tier "${tier ?? ''}". Use ${Object.keys(models).join(' or ')}.`);
      continue;
    }
    for (const key of ['model', 'effort']) {
      const line = `${key}: ${models[tier][key]}`;
      const at = front.findIndex((l) => l.startsWith(`${key}:`));
      if (at >= 0) front[at] = line;
      else front.splice(front.findIndex((l) => l.startsWith('tier:')), 0, line);
    }
    const next = ['---', ...front, ...lines.slice(end)].join('\n');
    if (next === original) continue;
    changed.push(file);
    if (!check) writeFileSync(path, next);
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return changed;
}

const USAGE = 'Usage: node tools/sync-agent-models.js [--check] [--dir <agents folder>]';

function main(argv) {
  const check = argv.includes('--check');
  const at = argv.indexOf('--dir');
  const rest = argv.filter((a, i) => a !== '--check' && a !== '--dir' && (at < 0 || i !== at + 1));
  if (rest.length > 0 || (at >= 0 && (argv[at + 1] === undefined || argv[at + 1].startsWith('--')))) {
    console.error(USAGE);
    return 2;
  }
  const dir = at >= 0 ? resolve(argv[at + 1]) : AGENTS;
  try {
    const changed = syncAgents(dir, { check });
    if (changed.length === 0) {
      console.log('Agent models are in sync.');
      return 0;
    }
    if (check) {
      console.error(`Agents out of sync with models.json: ${changed.join(', ')}. Run node tools/sync-agent-models.js.`);
      return 1;
    }
    console.log(`Updated: ${changed.join(', ')}`);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
