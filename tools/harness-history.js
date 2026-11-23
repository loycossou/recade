#!/usr/bin/env node
// Writes harness/history.json: the fingerprint of every version of the harness templates (agents, commands, protocol,
// pointer) found in the git history, merged with the fingerprints the file holds already, so none is ever lost.
// `--check` only says whether every current template is in the file (the test runs the same check).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HISTORY_FILE, fingerprint, knownTexts } from '../src/harness/history.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATHS = ['harness/agents', 'harness/commands', 'harness/protocol.md', 'harness/pointer'];

/** The current templates, as [path, text]. */
export function currentTemplates(pluginRoot) {
  const out = [];
  for (const p of PATHS) {
    const full = join(pluginRoot, p);
    if (!existsSync(full)) continue;
    if (p.endsWith('.md')) out.push([p, readFileSync(full, 'utf8')]);
    else for (const f of readdirSync(full).filter((x) => x.endsWith('.md')).sort()) out.push([`${p}/${f}`, readFileSync(join(full, f), 'utf8')]);
  }
  return out;
}

function fromGit(pluginRoot) {
  const git = (...args) => execFileSync('git', ['-C', pluginRoot, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const blobs = new Set();
  for (const line of git('log', '--all', '--format=', '--raw', '--no-abbrev', '--', ...PATHS).split('\n')) {
    const blob = line.split(/\s+/)[3];
    if (blob && !/^0+$/.test(blob)) blobs.add(blob);
  }
  return [...blobs].map((b) => fingerprint(git('cat-file', '-p', b)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const known = knownTexts(root);
  const missing = currentTemplates(root).filter(([, t]) => !known.has(fingerprint(t))).map(([p]) => p);
  if (process.argv.includes('--check')) {
    if (missing.length > 0) {
      console.error(`${HISTORY_FILE} misses the current text of: ${missing.join(', ')}. Run node tools/harness-history.js.`);
      process.exit(1);
    }
    console.log(`${HISTORY_FILE}: every current template is there.`);
  } else {
    const all = new Set([...known, ...currentTemplates(root).map(([, t]) => fingerprint(t))]);
    try {
      for (const f of fromGit(root)) all.add(f);
    } catch {
      console.error('No git history here: only the current templates were added.');
    }
    writeFileSync(join(root, HISTORY_FILE), `${JSON.stringify({ texts: [...all].sort() }, null, 2)}\n`);
    console.log(`${HISTORY_FILE}: ${all.size} texts.`);
  }
}
