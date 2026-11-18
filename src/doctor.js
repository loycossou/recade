import { execFile } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderChecks } from './render/checks.js';

/**
 * @typedef {{id:string,label:string,required:boolean,status:'ok'|'missing'|'warn',fix:string|null,detail:string|null}} Check
 * @typedef {{code:number,stdout:string,stderr:string}} ExecResult
 * @typedef {{exec:(cmd:string,args:string[])=>Promise<ExecResult>, readFile:(path:string)=>Promise<string>, env:Record<string,string|undefined>, nodeVersion:string}} Context
 */

const MARKETPLACE = 'claude-plugins-official';
export const REQUIRED_PLUGINS = [
  'superpowers', 'frontend-design', 'code-review', 'code-simplifier', 'github', 'chrome-devtools-mcp',
];
export const OPTIONAL_PLUGINS = [`postman@${MARKETPLACE}`];
export const SKILL_MARKETPLACE = 'anthropics/skills';
const MIN_NODE_MAJOR = 20;

/**
 * Extra checks that later plans append. Each entry is `(ctx) => Check | Promise<Check>`
 * and runs after the built-in checks.
 * @type {Array<(ctx: Context) => Check | Promise<Check>>}
 */
export const checks = [...renderChecks];

/**
 * Run a command. Never throws: a missing binary gives code 127.
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} [timeout] milliseconds, 15000 by default
 * @returns {Promise<ExecResult>}
 */
export function defaultExec(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      let code = 1;
      if (err.code === 'ENOENT') code = 127;
      else if (typeof err.code === 'number') code = err.code;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** @returns {Promise<ExecResult>} */
async function safeExec(exec, cmd, args) {
  try {
    const r = await exec(cmd, args);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
  }
}

/** @returns {Check} */
function check(id, label, required, status, fix = null, detail = null) {
  return { id, label, required, status, fix: status === 'ok' ? null : fix, detail };
}

/** A JSON object read from `<HOME>/.claude/<rel>`, or `{}` when HOME is unset, or the file is missing or unparsable. */
async function readClaudeJson(readFile, env, ...rel) {
  if (!env.HOME) return {};
  try {
    const parsed = JSON.parse(await readFile(join(env.HOME, '.claude', ...rel)));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** True when the `Token scopes` line of `gh auth status` lists the `project` scope. */
function hasProjectScope(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = /token scopes:(.*)/i.exec(line);
    if (m && (m[1].match(/[\w:.-]+/g) ?? []).includes('project')) return true;
  }
  return false;
}

/** True when a marketplace map has an entry whose `source.repo` is exactly the skills repo. */
function listsSkillsRepo(known) {
  if (known === null || typeof known !== 'object') return false;
  return Object.values(known).some((entry) => entry?.source?.repo === SKILL_MARKETPLACE);
}

/**
 * Machine checks behind `/recade:setup`. Never throws.
 * @param {Context} ctx
 * @returns {Promise<Check[]>}
 */
export async function runChecks(ctx) {
  const { exec, readFile, env, nodeVersion } = ctx;
  const result = [];

  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  result.push(
    check('node', `Node ${MIN_NODE_MAJOR} or later`, true, major >= MIN_NODE_MAJOR ? 'ok' : 'missing',
      `Install Node ${MIN_NODE_MAJOR} or later from https://nodejs.org`, String(nodeVersion)),
  );

  const git = await safeExec(exec, 'git', ['--version']);
  result.push(check('git', 'git', true, git.code === 0 ? 'ok' : 'missing', 'Install git from https://git-scm.com'));

  const email = await safeExec(exec, 'git', ['config', '--global', 'user.email']);
  result.push(
    check('git-email', 'git user.email is set', false,
      email.code === 0 && email.stdout.trim() !== '' ? 'ok' : 'warn',
      'git config --global user.email <you>@users.noreply.github.com'),
  );

  const gh = await safeExec(exec, 'gh', ['--version']);
  result.push(check('gh', 'GitHub CLI', true, gh.code === 0 ? 'ok' : 'missing', 'Install the GitHub CLI from https://cli.github.com'));

  const auth = await safeExec(exec, 'gh', ['auth', 'status']);
  if (auth.code !== 0) {
    result.push(check('gh-auth', 'GitHub CLI signed in with the project scope', true, 'missing', 'gh auth login -s project'));
  } else {
    const scoped = hasProjectScope(`${auth.stdout}\n${auth.stderr}`);
    result.push(check('gh-auth', 'GitHub CLI signed in with the project scope', true, scoped ? 'ok' : 'missing', 'gh auth refresh -s project'));
  }

  const settings = await readClaudeJson(readFile, env, 'settings.json');
  const known = await readClaudeJson(readFile, env, 'plugins', 'known_marketplaces.json');
  const enabled = settings.enabledPlugins !== null && typeof settings.enabledPlugins === 'object'
    ? settings.enabledPlugins
    : {};
  const plugins = [
    ...REQUIRED_PLUGINS.map((n) => ({ full: `${n}@${MARKETPLACE}`, name: n, required: true })),
    ...OPTIONAL_PLUGINS.map((full) => ({ full, name: full.split('@')[0], required: false })),
  ];
  for (const p of plugins) {
    // `false` is a plugin that is installed and switched off: it needs enabling, not installing.
    const off = enabled[p.full] === false;
    result.push(
      check(`plugin:${p.name}`, `Plugin ${p.name}`, p.required, enabled[p.full] === true ? 'ok' : 'missing',
        off ? `claude plugin enable ${p.full}` : `claude plugin install ${p.full}`, off ? 'disabled' : null),
    );
  }

  result.push(
    check('skills-marketplace', `Skills marketplace ${SKILL_MARKETPLACE}`, false,
      listsSkillsRepo(settings.extraKnownMarketplaces) || listsSkillsRepo(known) ? 'ok' : 'warn',
      `claude plugin marketplace add ${SKILL_MARKETPLACE}`),
  );

  for (const extra of checks) {
    try {
      result.push(await extra(ctx));
    } catch (err) {
      result.push(check(extra.name || 'extra', `Check failed: ${err?.message ?? err}`, false, 'warn', null));
    }
  }
  return result;
}
