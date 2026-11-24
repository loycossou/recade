import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { lintFiles } from '../style/lint.js';
import { registryNames, reposOf } from '../project/touches.js';
import { loadState } from '../state.js';
import { findStack, techSheet } from './claudemd.js';
import { handleHook, parseWrites } from './guard.js';
import { LOCAL_ONLY, SYNC_ADVICE, checkLink, findWorkspace, keptOut } from '../workspace/layout.js';
import { LAUNCHER, LOCAL_HOOK_MARK, SPEC_LINE, isAdopt, recadeFilesIn } from './install.js';
import { loadModels, modelWarnings, secondOpinionOf, sensitiveLane, syncAgents, withSecondOpinion } from './models.js';
import { checkGate, defaultExec, fingerprint, runGate } from './stamps.js';
import { legacyWorktrees } from '../workspace/worktrees.js';
import { preCommitTemplate, selectFor } from './targets.js';

/**
 * `recade harness verify`: proves that an installed harness loads and that its guards stop what they must.
 * Every check is its own function and adds findings. An `error` fails the verification, a `warn` does not.
 *
 * The guard probes go through the hook command written in `.claude/settings.json`, the way Claude Code runs it, so a
 * settings file that points nowhere, a plugin folder that moved or a guard that allows everything is caught.
 * The git hooks and the stamps are tried in a throwaway repository, never in the project.
 */

/** @typedef {{severity: 'error'|'warn', check: string, message: string}} Finding */

const EM_DASH = '\u2014';
const NOT_APPLICABLE = /^(?:none|n\/a|not applicable)\b/i;

const read = (file) => readFileSync(file, 'utf8');
const mdFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []);

/**
 * The front matter of a Markdown file as an object, or null when there is none. Read as YAML; when it is not strict YAML
 * (a description with a colon is fine for Claude Code), read line by line as `key: value`.
 */
export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (m === null) return null;
  try {
    const data = parse(m[1]);
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Not strict YAML: read the lines.
  }
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

const DENY_EXIT = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'exit 2' } });

/**
 * Run the hook command of the settings the way Claude Code does: in the project folder, with CLAUDE_PROJECT_DIR and the
 * environment of the settings, and no RECADE_PLUGIN_ROOT of this shell. An exit code 2 blocks the call, as a deny.
 */
function spawnHook(root, pluginRoot, event) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete env.RECADE_PLUGIN_ROOT;
  const r = spawnSync(process.execPath, [join(pluginRoot, 'bin', 'recade-guard.js')], { cwd: root, input: JSON.stringify(event), encoding: 'utf8', timeout: 30000, env });
  return r.status === 2 ? DENY_EXIT : (r.stdout ?? '');
}

const denied = (out) => {
  try {
    return JSON.parse(out)?.hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
};

/** Git in the throwaway repository, with an identity and no hooks of the machine. */
const gitIn = (cwd, args) => spawnSync('git', ['-c', 'user.name=recade', '-c', 'user.email=recade', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(cwd, '.nohooks')}`, ...args], { cwd, encoding: 'utf8' });

/**
 * @param {string} root the project folder
 * @param {{pluginRoot: string, target?: 'workspace'|'code', runHook?: (event: object) => string|null, only?: string[]}} options
 *   `target` is what the install was given (none: the whole harness in one folder). `runHook` replaces the guard (tests
 *   use it to simulate a guard that lets everything through), `only` runs the named checks only.
 * @returns {Promise<{findings: Finding[], checks: string[]}>}
 */
export async function verify(root, { pluginRoot, target, runHook, only } = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const checks = [];
  const want = (name) => only === undefined || only.includes(name);
  const add = (severity, check, message) => findings.push({ severity, check, message });
  const claude = join(root, '.claude');
  const harness = join(pluginRoot, 'harness');
  const agentsDir = join(claude, 'agents');
  const commandsDir = join(claude, 'commands');
  // An adopted repository keeps its own ci.yml and dependabot.yml: Recade's CI is recade.yml and is checked in its place.
  // A code repository is adopted when its workspace is; the workspace is Recade's own.
  const workspaceDir = target === 'code' ? findWorkspace(root)?.dir ?? null : null;
  const adopt = target === 'workspace' ? false : isAdopt(workspaceDir ?? root);
  const forWorkspace = target === 'workspace';
  const stem = (f) => f.replace(/\.md$/, '');

  // The settings of the project are optional now: the guard is a hook of the plugin. They are read for what may switch it off.
  let settings = null;
  let settingsError = null;
  if (existsSync(join(claude, 'settings.json'))) {
    try {
      settings = JSON.parse(read(join(claude, 'settings.json')));
    } catch (err) {
      settingsError = `.claude/settings.json does not parse: ${err.message}`;
    }
  }
  // A code repository holds no agent: the guard reads the agents of the plugin there.
  const writesDir = target === 'code' ? join(harness, 'agents') : agentsDir;
  const agentWrites = new Map(mdFiles(writesDir).map((f) => [f.replace(/\.md$/, ''), parseWrites(read(join(writesDir, f)))]).filter(([, w]) => w !== null));

  /* layout */
  if (want('layout')) {
    checks.push('layout');
    const chosen = selectFor(target, { agents: mdFiles(join(harness, 'agents')).map(stem), commands: mdFiles(join(harness, 'commands')).map(stem) });
    const wantAgents = chosen.agents.map((a) => `${a}.md`);
    const wantCommands = chosen.commands.map((c) => `${c}.md`);
    for (const f of wantAgents) if (!existsSync(join(agentsDir, f))) add('error', 'layout', `.claude/agents/${f} is missing. Run: recade harness install`);
    for (const f of wantCommands) if (!existsSync(join(commandsDir, f))) add('error', 'layout', `.claude/commands/${f} is missing. Run: recade harness install`);
    for (const f of [...(chosen.protocol ? ['.claude/protocol.md'] : []), '.recade/plugin-root']) {
      if (!existsSync(join(root, f))) add('error', 'layout', `${f} is missing. Run: recade harness install`);
    }
    if (target === 'code') {
      const link = checkLink(root);
      if (!link.ok) add('error', 'layout', `The link of this repository to its workspace is not good: ${link.reason}. Run: ${SYNC_ADVICE}`);
      const old = recadeFilesIn(root);
      if (old.length > 0) add('warn', 'layout', `Files of an older Recade are still in this repository (${old.length} file${old.length === 1 ? '' : 's'}, such as ${old[0]}). Run: recade repo clean ${basename(root)}, which removes them through a pull request.`);
    }
    if (forWorkspace) {
      for (const entry of LOCAL_ONLY.filter((e) => !keptOut(root, e))) add('error', 'layout', `The workspace does not keep ${entry} out of git (neither .git/info/exclude nor .gitignore holds it), so the code checkouts would be committed. Run: recade harness install`);
      if (legacyWorktrees(root, { exec: defaultExec }).length > 0) add('warn', 'layout', 'Slice worktrees of the old layout are still under repos/<repo>/.claude/worktrees/. Run: recade harness migrate --dry-run');
    }
    const scan = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name)) : []);
    for (const file of [...scan(claude), ...(adopt || forWorkspace ? [] : scan(join(root, '.github')))]) {
      if (/__RECADE_[A-Z0-9_]+__/.test(read(file))) add('error', 'layout', `${file.slice(root.length + 1)} still holds a placeholder. Run: recade harness install`);
    }
  }

  /* agents */
  if (want('agents')) {
    checks.push('agents');
    for (const f of mdFiles(agentsDir)) {
      const text = read(join(agentsDir, f));
      const name = f.replace(/\.md$/, '');
      const fm = frontMatter(text);
      if (fm === null) {
        add('error', 'agents', `${f}: the front matter does not parse.`);
        continue;
      }
      if (fm.name !== name) add('error', 'agents', `${f}: name is ${JSON.stringify(fm.name)}, it must be ${name}.`);
      for (const key of ['description', 'tools', 'model', 'effort']) if (typeof fm[key] !== 'string' || fm[key].trim() === '') add('error', 'agents', `${f}: front matter has no ${key}.`);
      if (!text.includes('.claude/protocol.md')) add('error', 'agents', `${f}: it does not name .claude/protocol.md.`);
      if (parseWrites(text) === null) add('error', 'agents', `${f}: it has no ## Writes section, so the guard cannot hold its paths.`);
      if (!text.includes(SPEC_LINE)) add('warn', 'agents', `${f}: no specialisation line, a re-install will not keep your text.`);
    }
  }

  /* commands */
  if (want('commands')) {
    checks.push('commands');
    for (const f of mdFiles(commandsDir)) {
      const text = read(join(commandsDir, f));
      const fm = frontMatter(text);
      if (fm === null) {
        add('error', 'commands', `${f}: the front matter does not parse.`);
        continue;
      }
      if (typeof fm.description !== 'string' || fm.description.length < 10) add('error', 'commands', `${f}: no description.`);
      const tools = typeof fm['allowed-tools'] === 'string' ? fm['allowed-tools'] : '';
      if (tools === '') add('error', 'commands', `${f}: no allowed-tools.`);
      if (/Bash\((?:gh|\*)[:)]|Bash\(git push/.test(tools)) add('error', 'commands', `${f}: allowed-tools lets the command run gh, any shell or git push.`);
      if (!text.includes('RECADE_PLUGIN_ROOT')) add('error', 'commands', `${f}: it does not find the plugin folder (RECADE_PLUGIN_ROOT).`);
    }
  }

  /* models */
  if (want('models')) {
    checks.push('models');
    if (existsSync(agentsDir)) {
      try {
        // The second-opinion choice is read from the copy (CI has no user config): opus, or fable, another family.
        const models = withSecondOpinion(loadModels(join(harness, 'models.yaml')), secondOpinionOf(agentsDir));
        for (const w of modelWarnings(models)) add('warn', 'models', `${w}.`);
        const { changed } = syncAgents(agentsDir, models, { check: true });
        if (changed.length > 0) add('error', 'models', `Agents out of sync with models.yaml: ${changed.join(', ')}. Run: recade harness models --dir .claude/agents`);
        const slice = join(commandsDir, 'slice.md');
        if (target !== 'code' && sensitiveLane(models).length > 0 && existsSync(slice) && !read(slice).includes('sensitive_model')) {
          add('error', 'models', '.claude/commands/slice.md does not dispatch with sensitive_model and sensitive_effort in the sensitive lane. Run: recade harness install');
        }
      } catch (err) {
        add('error', 'models', err.message.replace(/\n/g, '; '));
      }
    }
  }

  /* settings */
  if (want('settings')) {
    checks.push('settings');
    if (settingsError !== null) add('error', 'settings', settingsError);
    const pluginHooks = (() => {
      try {
        return JSON.parse(read(join(pluginRoot, 'hooks', 'hooks.json')));
      } catch {
        return null;
      }
    })();
    if (!(pluginHooks?.hooks?.PreToolUse ?? []).some((e) => (e.hooks ?? []).some((h) => String(h.command).includes('recade-guard.js')))) add('error', 'settings', 'The plugin has no PreToolUse hook that runs bin/recade-guard.js, so no guard runs. Update the plugin.');
    for (const [file, data] of [['.claude/settings.json', settings], ['.claude/settings.local.json', (() => {
      try {
        return existsSync(join(claude, 'settings.local.json')) ? JSON.parse(read(join(claude, 'settings.local.json'))) : null;
      } catch (err) {
        add('error', 'settings', `.claude/settings.local.json does not parse: ${err.message}`);
        return null;
      }
    })()]]) {
      if (data === null || typeof data !== 'object') continue;
      if (data.disableAllHooks === true) add('error', 'settings', `disableAllHooks is true in ${file}: no hook runs, so the guard is off.`);
      if ((data.hooks?.PreToolUse ?? []).some((e) => (e.hooks ?? []).some((h) => String(h.command).includes(LAUNCHER)))) add('warn', 'settings', `${file} still runs the guard launcher of an older Recade. Run: recade harness install, which takes it out.`);
    }
    const recorded = existsSync(join(root, '.recade', 'plugin-root')) ? read(join(root, '.recade', 'plugin-root')).split('\n')[0].trim() : '';
    if (recorded !== '' && (!existsSync(join(recorded, 'harness', 'githooks', 'local')) || !existsSync(join(recorded, 'bin', 'recade.js')))) {
      add('error', 'settings', `.recade/plugin-root points to ${recorded}, which is not a Recade plugin folder of this version: the git hooks do nothing. Run: recade repo sync`);
    }
  }

  /* git */
  if (want('git')) {
    checks.push('git');
    const hooksPath = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
    if (hooksPath.status === 0 && hooksPath.stdout.trim() !== '') add('error', 'git', `core.hooksPath is ${hooksPath.stdout.trim()}, so the local git hooks of Recade do not run. Run: git config --unset core.hooksPath, then recade repo sync`);
    const gitPath = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' });
    const dir = gitPath.status === 0 ? resolve(root, gitPath.stdout.trim()) : null;
    const stub = read(join(harness, 'githooks', 'local'));
    for (const name of ['pre-commit', 'commit-msg']) {
      const file = dir === null ? null : join(dir, name);
      if (file === null || !existsSync(file)) {
        add('error', 'git', `The local git hook ${name} is missing. Run: recade repo sync`);
        continue;
      }
      // Git skips a hook that is not executable, without a word.
      if ((statSync(file).mode & 0o111) === 0) add('error', 'git', `The local git hook ${name} is not executable, so git skips it. Run: recade repo sync`);
      const expected = stub.replaceAll('__HOOK__', name).replaceAll('__TEMPLATE__', name === 'pre-commit' ? preCommitTemplate(target) : name);
      if (read(file) !== expected) add(read(file).includes(LOCAL_HOOK_MARK) ? 'error' : 'warn', 'git', read(file).includes(LOCAL_HOOK_MARK) ? `The local git hook ${name} differs from the Recade one. Run: recade repo sync` : `The git hook ${name} is your own, so the Recade ${name} does not run.`);
    }
  }

  /* guard */
  if (want('guard')) {
    checks.push('guard');
    // The first call goes through the hook command of the settings, as Claude Code runs it. The others call the same
    // guard in this process, which is faster and gives the same answer once the first call proved the wiring.
    let wired = false;
    const hook = async (event) => {
      if (runHook !== undefined) return runHook(event);
      if (!wired) {
        wired = true;
        return spawnHook(root, pluginRoot, event);
      }
      return handleHook(JSON.stringify(event), { cwd: root, pluginRoot });
    };
    const probe = async (label, event, expectDeny) => {
      const out = await hook({ cwd: root, hook_event_name: 'PreToolUse', ...event });
      if (out === null) {
        add('error', 'guard', `${label}: the hook could not be run.`);
        return;
      }
      if (expectDeny && !denied(out)) add('error', 'guard', `${label}: the guard did not refuse it.`);
      if (!expectDeny && denied(out)) add('error', 'guard', `${label}: the guard refused a harmless call.`);
    };
    await probe('gh pr merge', { tool_name: 'Bash', tool_input: { command: 'gh pr merge 12 --squash' } }, true);
    await probe('gh pr merge by an agent', { tool_name: 'Bash', agent_type: 'reviewer', tool_input: { command: 'gh -R acme/app pr merge 12' } }, true);
    await probe('push to main', { tool_name: 'Bash', agent_type: 'implementer', tool_input: { command: 'git push origin main' } }, true);
    await probe('commit with --no-verify', { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m "feat: x"' } }, true);
    await probe('hooks path switched off', { tool_name: 'Bash', tool_input: { command: 'git -c core.hooksPath=/dev/null commit -m "feat: x"' } }, true);
    await probe('write to the stamps', { tool_name: 'Write', tool_input: { file_path: join(root, '.recade', 'stamps.json'), content: '{}' } }, true);
    const limited = [...agentWrites].find(([, w]) => w.length > 0 && !w.some((g) => g.includes('<') || g.startsWith('**')));
    const none = [...agentWrites].find(([, w]) => w.length === 0);
    if (limited === undefined) add('error', 'guard', 'No agent has a Writes list to try the path guard on.');
    else await probe(`write outside the paths of ${limited[0]}`, { tool_name: 'Write', agent_type: limited[0], tool_input: { file_path: join(root, 'zz-recade-verify', 'outside.txt'), content: 'x' } }, true);
    if (none !== undefined) await probe(`write by ${none[0]}, which writes nothing`, { tool_name: 'Write', agent_type: none[0], tool_input: { file_path: join(root, 'zz-recade-verify', 'outside.txt'), content: 'x' } }, true);
    await probe('a harmless command', { tool_name: 'Bash', tool_input: { command: 'git status' } }, false);
  }

  /* git hooks and stamps, in a throwaway repository */
  if (want('pre-commit') || want('stamps')) {
    if (want('pre-commit')) checks.push('pre-commit');
    if (want('stamps')) checks.push('stamps');
    const preCommit = join(harness, 'githooks', preCommitTemplate(target));
    const commitMsg = join(harness, 'githooks', 'commit-msg');
    const scratch = mkdtempSync(join(tmpdir(), 'recade-verify-'));
    try {
      gitIn(scratch, ['init', '-q', '-b', 'main']);
      const env = { ...process.env, RECADE_PLUGIN_ROOT: pluginRoot };
      const sh = (file, args) => spawnSync('sh', [file, ...args], { cwd: scratch, encoding: 'utf8', env });
      if (existsSync(preCommit)) {
        writeFileSync(join(scratch, 'ok.md'), '# Notes\n\nPlain text.\n');
        gitIn(scratch, ['add', 'ok.md']);
        const good = sh(preCommit, []);
        if (good.status !== 0) add('error', 'pre-commit', `pre-commit refuses a clean file: ${(good.stderr || good.stdout).trim().split('\n')[0]}`);
        writeFileSync(join(scratch, 'bad.md'), `# Notes\n\nOne ${EM_DASH} two.\n`);
        gitIn(scratch, ['add', 'bad.md']);
        const bad = sh(preCommit, []);
        if (bad.status === 0) add('error', 'pre-commit', 'pre-commit accepts a file with an em dash.');
        gitIn(scratch, ['reset', '-q']);
        // A required gate with no stamp must stop the commit. The hook of the workspace runs no gate: its documents have none.
        if (!forWorkspace) {
          mkdirSync(join(scratch, 'recade'), { recursive: true });
          writeFileSync(join(scratch, 'recade', 'state.yaml'), 'version: 1\nharness:\n  required_gates: [verify-gate]\n');
          gitIn(scratch, ['add', 'ok.md', 'recade/state.yaml']);
          if (sh(preCommit, []).status === 0) add('error', 'pre-commit', 'pre-commit lets a commit through when a required gate has no green stamp.');
          gitIn(scratch, ['reset', '-q']);
          rmSync(join(scratch, 'recade'), { recursive: true, force: true });
        }
      }
      if (existsSync(commitMsg)) {
        writeFileSync(join(scratch, 'good.txt'), 'feat: add a thing\n');
        writeFileSync(join(scratch, 'bad.txt'), `feat: add a thing ${EM_DASH} and another\n`);
        if (sh(commitMsg, ['good.txt']).status !== 0) add('error', 'pre-commit', 'commit-msg refuses a conventional message.');
        if (sh(commitMsg, ['bad.txt']).status === 0) add('error', 'pre-commit', 'commit-msg accepts a message with an em dash.');
      }
      // Stamps: green for the tree they ran on, stale after one more edit.
      writeFileSync(join(scratch, 'a.txt'), 'one\n');
      gitIn(scratch, ['add', 'a.txt']);
      gitIn(scratch, ['commit', '-q', '-m', 'chore: start']);
      const { code } = runGate('verify-probe', [process.execPath, '-e', 'process.exit(0)'], { repo: scratch });
      if (code !== 0 || checkGate('verify-probe', { repo: scratch }) !== 'green') add('error', 'stamps', 'A gate run did not give a green stamp.');
      writeFileSync(join(scratch, 'a.txt'), 'two\n');
      if (checkGate('verify-probe', { repo: scratch }) !== 'stale') add('error', 'stamps', 'A stamp stayed green after the tree changed.');
      try {
        fingerprint(root);
      } catch (err) {
        add('error', 'stamps', `The fingerprint of the project cannot be taken: ${err.message}`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /* style */
  if (want('style')) {
    checks.push('style');
    if (existsSync(claude)) {
      for (const f of lintFiles(root, ['.claude']).filter((x) => x.severity === 'error')) add('error', 'style', `${f.file}:${f.line} ${f.rule} ${f.message}`);
    }
  }

  /* ci */
  if (want('ci')) {
    checks.push('ci');
    const files = forWorkspace || adopt ? [] : ['.github/workflows/ci.yml', '.github/dependabot.yml'];
    for (const f of files) {
      const path = join(root, f);
      if (!existsSync(path)) continue;
      const doc = parseDocument(read(path));
      if (doc.errors.length > 0) add('error', 'ci', `${f} is not valid YAML: ${doc.errors[0].message}`);
      for (const m of read(path).matchAll(/No command is set for (.+?) yet/g)) add('warn', 'ci', `${f}: no command is set for ${m[1]}, so CI fails on it. Write the command in ${f}.`);
    }
    // The sheet and the slices are in the workspace for a code repository: its own table of the sheet, and the sensitive
    // slices that touch it.
    const home = target === 'code' ? workspaceDir : root;
    const name = target === 'code' ? basename(root) : undefined;
    const stack = home === null ? null : findStack(home);
    const slicesDir = home === null ? '' : join(home, 'slices');
    if (stack !== null && existsSync(slicesDir)) {
      const confirmation = techSheet(stack.text, name).get('confirmation tests');
      const registry = target === 'code' ? registryNames(loadState(home)) : [];
      const sensitive = readdirSync(slicesDir).filter((f) => /^S-.*\.md$/.test(f)).map((f) => [f, frontMatter(read(join(slicesDir, f)))]).filter(([, fm]) => fm?.lane === 'sensitive'
        && (target !== 'code' || reposOf(Array.isArray(fm.touches) ? fm.touches.map(String) : [], registry).includes(name))).map(([f]) => f);
      const where = target === 'code' ? `the table of ${name} in ${stack.file} of the workspace` : stack.file;
      if (confirmation !== undefined && NOT_APPLICABLE.test(confirmation) && sensitive.length > 0) {
        add('error', 'ci', `Confirmation tests is "not applicable" in ${where}, and ${sensitive.length} slice${sensitive.length === 1 ? ' is' : 's are'} in the sensitive lane (${sensitive.slice(0, 3).map((f) => f.replace(/\.md$/, '')).join(', ')}). A sensitive action needs a confirmation test: give the row a command.`);
      }
    }
  }

  return { findings, checks };
}

/** One line per finding, then the verdict line. */
export function formatVerify({ findings, checks }) {
  const lines = findings.map((f) => `${f.severity} ${f.check}: ${f.message}`);
  const errors = findings.filter((f) => f.severity === 'error').length;
  lines.push(errors === 0 ? `Harness verified: ${checks.join(', ')}.` : `Harness verification failed: ${errors} error${errors === 1 ? '' : 's'}.`);
  return `${lines.join('\n')}\n`;
}
