#!/usr/bin/env node
// Recade harness: the launcher of the guard, run by the PreToolUse hook of .claude/settings.json.
// Written whole by `recade harness install`: do not edit it, a re-install replaces it.
// It holds no path of any machine. It finds the plugin folder in .recade/plugin-root (written at install, one per
// machine, never committed), in the project, in the folders above, or in the main checkout of the repository, and runs
// the guard of that plugin. When the guard is missing or cannot run, write tools and Bash are refused (fail closed),
// except the few commands that reinstall the harness from a real Recade plugin folder. Read, Glob and Grep never reach this hook.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GUARDED = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);
/**
 * The words of a simple command on one line: double- or single-quoted, or bare, split on spaces and tabs. Null when it
 * holds a line break or anything a shell would expand or chain.
 */
function words(command) {
  if (/[\n\r]/.test(command)) return null;
  const out = [];
  const re = /[ \t]*(?:"([^"\\$\x60\n\r]*)"|'([^'\n\r]*)'|([^ \t\n\r\v\f'"\\$\x60;&|<>(){}*?[\]~!#]+))(?=[ \t]|$)/y;
  let at = 0;
  const text = command.replace(/^[ \t]+|[ \t]+$/g, '');
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (m === null) return null;
    out.push(m[1] ?? m[2] ?? m[3]);
    at = re.lastIndex;
  }
  return out;
}

/** A plugin folder a reinstall may run: absolute, no backslash, outside the project, with the Recade CLI, guard and package. */
function pluginFolder(dir, project) {
  if (typeof dir !== 'string' || !dir.startsWith('/') || dir.includes('\\')) return false;
  const abs = resolve(dir);
  if (project !== null && (abs === project || abs.startsWith(`${project}/`))) return false;
  try {
    if (!existsSync(join(abs, 'bin', 'recade.js')) || !existsSync(join(abs, 'harness', 'hooks', 'guard.mjs'))) return false;
    return JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'))?.name === 'recade';
  } catch {
    return false;
  }
}

const SUBCOMMANDS = [['version'], ['harness', 'install'], ['harness', 'verify'], ['state', 'show'], ['state', 'can-start']];
/**
 * What the main session may also run when only `.recade/plugin-root` is missing (a fresh clone on another machine):
 * the resume steps that read the setup and `repo sync`, which writes the plugin root again. Never for an agent.
 */
const RESUME = [['repo', 'sync'], ['repo', 'check'], ['repo', 'list'], ['config', 'get']];

/**
 * Are these the words after a subcommand, and nothing else? `version` takes none; the others take `--project /abs`.
 * `harness install` also takes `--ref`, `--force`; `harness install` and `harness verify` take `--target workspace|code`
 * and `--repo <name>` (a kebab-case repository name). Each option comes at most once.
 */
function optionsFit(sub, rest) {
  if (sub[0] === 'version') return rest.length === 0;
  if (sub[0] === 'config') return rest.length === 1 && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(rest[0]);
  const install = sub[1] === 'install';
  const harness = sub[0] === 'harness';
  const seen = new Set();
  const value = (i) => (typeof rest[i + 1] === 'string' ? rest[i + 1] : null);
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (seen.has(w)) return false;
    seen.add(w);
    const v = value(i);
    if (w === '--project' && v !== null && v.startsWith('/') && !v.includes('\\')) i++;
    else if (install && w === '--ref' && v !== null && /^[A-Za-z0-9][\w.\/-]*$/.test(v)) i++;
    else if (harness && w === '--target' && (v === 'workspace' || v === 'code')) i++;
    else if (harness && w === '--repo' && v !== null && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) i++;
    else if (install && w === '--force') continue;
    else if (!install && w === '--json' && sub.join(' ') !== 'repo sync') continue;
    else return false;
  }
  return true;
}

/**
 * Is this Bash command one of the few that reinstall the harness? Each path must name a real Recade plugin folder.
 * `resume` adds the commands of `RESUME`: the main session, when only the plugin root is missing.
 */
function recovery(command, cwd, resume = false) {
  const w = words(command);
  if (w === null || w.length === 0) return false;
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  const project = top.status === 0 ? resolve(top.stdout.trim()) : null;
  if (w[0] === 'node' && typeof w[1] === 'string' && w[1].endsWith('/bin/recade.js')) {
    if (!pluginFolder(w[1].slice(0, -'/bin/recade.js'.length), project)) return false;
    const rest = w.slice(2);
    return [...SUBCOMMANDS, ...(resume ? RESUME : [])].some((sub) => sub.every((x, i) => rest[i] === x) && optionsFit(sub, rest.slice(sub.length)));
  }
  if (w.length === 5 && w[0] === 'npm' && w[1] === 'ci' && w[2] === '--omit=dev' && w[3] === '--prefix') return pluginFolder(w[4], project);
  if (w[0] === 'git') {
    const rest = w[1] === '-C' && typeof w[2] === 'string' && w[2].startsWith('/') ? w.slice(3) : w.slice(1);
    return rest.length === 2 && rest[0] === 'rev-parse' && rest[1] === '--show-toplevel';
  }
  return false;
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

/** The plugin folder written in .recade/plugin-root that holds a guard, or null. */
function pluginRoot(start) {
  const dirs = [];
  if (process.env.CLAUDE_PROJECT_DIR) dirs.push(resolve(process.env.CLAUDE_PROJECT_DIR));
  for (let d = resolve(start); ; d = dirname(d)) {
    dirs.push(d);
    if (dirname(d) === d) break;
  }
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: start, encoding: 'utf8' });
  if (common.status === 0) dirs.push(dirname(resolve(start, common.stdout.trim())));
  for (const d of dirs) {
    const file = join(d, '.recade', 'plugin-root');
    if (!existsSync(file)) continue;
    const root = readFileSync(file, 'utf8').split('\n')[0].trim();
    if (root !== '' && existsSync(join(root, 'harness', 'hooks', 'guard.mjs'))) return root;
  }
  return installedPlugin();
}

/**
 * The folder of the Recade plugin as Claude Code installed it, from its record of installed plugins, or null. The
 * fallback of a fresh clone of a workspace (a cloud session), which has no `.recade/plugin-root`, the file each machine
 * writes for itself: with the plugin installed there, the guard runs instead of refusing every write.
 */
function installedPlugin() {
  const home = process.env.CLAUDE_CONFIG_DIR || (process.env.HOME ? join(process.env.HOME, '.claude') : null);
  if (home === null) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(join(home, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return null;
  }
  const found = [];
  for (const [key, entries] of Object.entries(record?.plugins ?? {})) {
    if (!key.startsWith('recade@') || !Array.isArray(entries)) continue;
    for (const e of entries) {
      const path = typeof e?.installPath === 'string' ? e.installPath : '';
      if (path !== '' && existsSync(join(path, 'harness', 'hooks', 'guard.mjs'))) found.push({ path, at: String(e.lastUpdated ?? e.installedAt ?? '') });
    }
  }
  found.sort((a, b) => b.at.localeCompare(a.at));
  return found[0]?.path ?? null;
}

/** The deny decision of a guard that cannot run, or '' for a tool it does not hold or a reinstall command. */
function failClosed(event, why, cwd = process.cwd(), { rootMissing = false } = {}) {
  const tool = typeof event?.tool_name === 'string' ? event.tool_name : null;
  if (tool !== null && !GUARDED.has(tool)) return '';
  const command = String(event?.tool_input?.command ?? '');
  const agent = event?.agent_type ?? event?.subagent_type;
  const main = typeof agent !== 'string' || agent === '';
  if (tool === 'Bash' && recovery(command, cwd, rootMissing && main)) return '';
  const reason = `The Recade guard cannot run (${why}), so write tools and Bash are refused. Run /recade:harness again in this project, or \`recade harness install\` from a terminal. On a fresh clone of a workspace, the main session may run \`recade repo sync\`, which writes the plugin root again.`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

let stdin = '';
let event = null;
let out;
try {
  stdin = await readStdin();
  try {
    event = JSON.parse(stdin);
  } catch {
    event = null;
  }
  const cwd = typeof event?.cwd === 'string' && existsSync(event.cwd) ? event.cwd : process.cwd();
  const root = pluginRoot(cwd);
  if (root === null) out = failClosed(event, '.recade/plugin-root is missing or points to no plugin folder with harness/hooks/guard.mjs, and no Recade plugin is installed on this machine', cwd, { rootMissing: true });
  else {
    try {
      const { runGuard } = await import(pathToFileURL(join(root, 'harness', 'hooks', 'guard.mjs')).href);
      out = await runGuard(stdin, { pluginRoot: root, start: cwd });
    } catch (err) {
      out = failClosed(event, `the guard of ${root} failed: ${String(err?.message ?? err).split('\n')[0]}`, cwd);
    }
  }
} catch (err) {
  out = failClosed(event, String(err?.message ?? err).split('\n')[0]);
}
if (out !== '') process.stdout.write(`${out}\n`);
