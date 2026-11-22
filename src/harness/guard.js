import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REPO_NAME, WORKSPACE_PREFIX, parseTouch, registryNames, reposOf } from '../project/touches.js';
import { PROTECTED_BRANCHES, checkBash, checkRefWrites, checkRestrictedShell, tokenize } from './shellscan.js';

export { PROTECTED_BRANCHES, checkBash, checkRefWrites, tokenize };

/*
 * The decision function of the PreToolUse hook, and the small I/O layer around it. Only `node:` builtins and
 * `src/project/touches.js` (which imports nothing) at import time, so `harness/hooks/guard.mjs` can load it from the
 * plugin folder without any dependency installed. A session in a workspace or in one of its code repositories loads
 * the workspace code (and its YAML reader) when the hook runs; if that fails, the call is refused (fail closed).
 */

/** @typedef {{globs: string[], unresolved: string[]}} Allow `unresolved` holds one reason per glob that could not be resolved. */
/** @typedef {{allow: boolean, reason?: string}} Decision */

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SLICE_BRANCH = /^slice\/(s-\d+[a-z]?)(?:-|$)/i;

/* ---------- globs ---------- */

const escapeRe = (s) => s.replace(/[.+^$()|\\[\]{}]/g, '\\$&');

/**
 * Turn a path glob into a RegExp. `**` crosses folders, `*` and `?` stay inside one segment, `{a,b}` is a choice.
 * A glob that starts with `*` matches at any depth, so `*.test.*` matches `src/a/b.test.js`. A trailing `/` means the whole folder.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let g = glob.trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let out = g.startsWith('*') ? '(?:.*/)?' : '';
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '\\' && i + 1 < g.length) out += escapeRe(g[++i]);
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      braces++;
      out += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      out += ')';
    } else if (c === ',' && braces > 0) out += '|';
    else out += escapeRe(c);
  }
  return new RegExp(`^${out}$`);
}

/** Does a project-relative path match a glob? */
export const matchGlob = (glob, path) => globToRegExp(glob).test(path);

/** A path made relative to the project and written with `/`, or null when it is outside it. */
export function toProjectPath(root, file) {
  if (typeof file !== 'string' || file === '') return null;
  const rel = relative(root, isAbsolute(file) ? resolve(file) : resolve(root, file));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/* ---------- agent Writes ---------- */

/**
 * The paths an agent file allows under `## Writes`: the single backticked item of each bullet. A section that says
 * "None" gives an empty list. Returns null when the file has no `## Writes` section.
 * @param {string} markdown
 * @returns {string[]|null}
 */
export function parseWrites(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Writes\s*$/.test(l));
  if (start === -1) return null;
  const globs = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const m = /^\s*[-*]\s+`([^`]+)`/.exec(lines[i]);
    if (m) globs.push(m[1].trim());
  }
  return globs;
}

/** The `touches:` globs of a sheet's front matter, read without a YAML parser. Null when the key is absent. */
export function parseTouches(sheetText) {
  const lines = sheetText.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? '')) return null;
  const end = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  const front = end === -1 ? lines.slice(1) : lines.slice(1, end);
  const at = front.findIndex((l) => /^touches:/.test(l));
  if (at === -1) return null;
  const unquote = (s) => s.trim().replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2');
  const inline = front[at].slice('touches:'.length).trim();
  if (inline.startsWith('[')) {
    return inline.replace(/^\[|\]\s*(#.*)?$/g, '').split(',').map(unquote).filter((s) => s !== '');
  }
  const out = [];
  for (let i = at + 1; i < front.length; i++) {
    const m = /^\s+-\s+(.*)$/.exec(front[i]);
    if (m) out.push(unquote(m[1]));
    else if (/^\S/.test(front[i])) break;
  }
  return out.filter((s) => s !== '');
}

/**
 * Replace the placeholders of the Writes globs. `<S-nn>` comes from the branch name, `<touches>` from the sheet of
 * that slice, `<conflicted-files>` from git. A glob whose placeholder cannot be resolved is not allowed and
 * its reason is listed in `unresolved`: the write is refused with it.
 * @param {string[]} globs
 * @param {{branch: () => string|null, touches: (id: string) => string[]|null, conflicted: () => string[]|null}} ctx
 * @returns {Allow}
 */
export function resolveGlobs(globs, ctx) {
  const out = [];
  const unresolved = [];
  const safe = (fn, ...a) => {
    try {
      return fn(...a);
    } catch {
      return null;
    }
  };
  let sliceId;
  const slice = () => {
    if (sliceId === undefined) {
      const branch = safe(ctx.branch);
      const m = branch ? SLICE_BRANCH.exec(branch) : null;
      sliceId = m ? m[1].toUpperCase() : null;
    }
    return sliceId;
  };
  for (const glob of globs) {
    if (glob === '<touches>') {
      const id = slice();
      if (id === null) {
        unresolved.push('<touches> cannot be resolved: the branch is not slice/S-nn-...');
        continue;
      }
      const list = safe(ctx.touches, id);
      if (!list || list.length === 0) unresolved.push(`<touches> cannot be resolved: the sheet of ${id} was not found or its touches: list is empty`);
      else out.push(...list);
    } else if (glob === '<conflicted-files>') {
      const list = safe(ctx.conflicted);
      if (list === null) unresolved.push('<conflicted-files> cannot be resolved: git could not list the conflicted files');
      else if (list.length === 0) unresolved.push('<conflicted-files> is empty: git lists no conflicted file');
      else out.push(...list.map((f) => f.replace(/[*?{}[\]]/g, '\\$&')));
    } else if (glob.includes('<S-nn>')) {
      const id = slice();
      if (id === null) unresolved.push(`${glob} cannot be resolved: the branch is not slice/S-nn-...`);
      else out.push(glob.replaceAll('<S-nn>', id));
    } else out.push(glob);
  }
  return { globs: out, unresolved };
}

/* ---------- decision ---------- */

/** The path a write tool targets, from its input. */
export const targetOf = (input) => input?.file_path ?? input?.notebook_path ?? input?.path;

/** The strings a write tool would put in a file. */
function writtenText(input) {
  const parts = [input?.content, input?.new_string, input?.old_string, input?.new_source];
  for (const e of Array.isArray(input?.edits) ? input.edits : []) parts.push(e?.new_string, e?.old_string);
  return parts.filter((x) => typeof x === 'string').join('\n');
}

/**
 * Why a write to this path is refused for every agent whatever the project state says, or null: the stamps, the guard
 * log, the plugin folder record and the workspace link under `.recade/` (the rest of `.recade/`, such as the ledger of a
 * slice, is free), the git hooks and git internals (`.git/info/exclude` excepted), the hook launcher in `.claude/hooks/`,
 * the agents and commands in `.claude/agents/` and `.claude/commands/`, the harness settings of a code repository in
 * `.claude/recade.yaml`, the permission and hook settings, and the harness keys of the project state.
 * @param {string} abs absolute path
 * @param {string|null} rel project-relative path, or null outside the project
 * @param {string} tool
 * @param {object} input
 * @returns {string|null}
 */
export function protectedWrite(abs, rel, tool, input) {
  const human = 'Only a human changes it.';
  if (/\/\.claude\/settings[^/]*\.json$/.test(abs.split(sep).join('/'))) return `Permissions and hooks live in ${basename(abs)}. ${human}`;
  // A file or folder named .git, wherever it is, makes git read the folder around it as another checkout: only git
  // itself writes there. `.git/info/exclude` of the project stays open.
  if (/(^|\/)\.git[. ]*(\/|$)/i.test(abs.split(sep).join('/')) && rel !== '.git/info/exclude') {
    return `${rel ?? abs} is a .git file or folder, or lies inside one. Only git itself writes there. ${human}`;
  }
  // A file with more than one hard link is another file too: writing it would change that one.
  try {
    const st = lstatSync(abs);
    if (st.isFile() && st.nlink > 1) return `${rel ?? abs} has more than one hard link, so writing it would change another file. ${human}`;
  } catch {
    // A new file.
  }
  if (rel === null) return null;
  if (rel === '.recade' || /^\.recade\/(stamps|guard\.log$|plugin-root$|workspace$|guard-snapshot|sessions(\/|$)|installed\.json$)/.test(rel)) {
    return `${rel} holds the gate stamps, the guard log, the plugin folder, the workspace link, the install record or the slice of a session. Only \`recade gate run\`, the guard, the install and \`recade repo sync\` write there.`;
  }
  if (rel === '.claude/hooks' || rel.startsWith('.claude/hooks/')) return `${rel} launches the guard of the harness. ${human}`;
  if (/^\.claude\/(agents|commands)(\/|$)/.test(rel)) return `${rel} is an agent or a command of the harness. Only \`recade harness install\` or a human changes it.`;
  if (rel === '.claude/recade.yaml') return `.claude/recade.yaml holds the harness settings of this repository (required gates, thresholds). ${human}`;
  if (rel === '.git/info/exclude') return null;
  if (rel === '.githooks' || rel.startsWith('.githooks/') || rel === '.git' || rel.startsWith('.git/')) return `${rel} is a git hook or git internals. ${human}`;
  if (rel === 'recade/state.yaml') {
    if (tool === 'Write') return `recade/state.yaml is changed with \`recade state\`, never rewritten whole. ${human}`;
    if (/harness|required_gates|threshold_files/.test(writtenText(input))) return `The harness keys of recade/state.yaml (required gates, thresholds) are not edited by an agent. ${human}`;
  }
  return null;
}

/**
 * Decide on one tool call.
 * - Write, Edit, MultiEdit, NotebookEdit: refused for the fixed protected paths (stamps, git hooks, settings, harness
 *   keys of the state), for a file listed in `deny.thresholdFiles` (every write when `deny.thresholdError` is set), and
 *   refused outside the `allow` globs of a known agent. `allow` is null when the agent is unknown or absent.
 * - Bash: refused when the command matches the deny list (merge, push to main, --no-verify and the ways around the
 *   hooks, deleting tests, editing a threshold or a harness file) for every agent; for a known agent also when it
 *   writes outside its Writes by redirect, `tee`, `sed -i`, `cp`, `mv` or `git apply`.
 * - Any other tool is allowed.
 * @param {{agentType?: string|null, tool: string, input: object, allow: Allow|null, deny?: {thresholdFiles?: string[], thresholdError?: boolean, currentBranch?: string|null}, root?: string}} args
 * @returns {Decision}
 */
export function decide({ agentType = null, tool, input, allow, deny = {}, root = process.cwd() }) {
  if (tool === 'Bash') {
    const command = String(input?.command ?? '');
    // An agent never moves the default branch, nor the branch of another slice: only the one it works on.
    const refs = agentType === null ? null : checkRefWrites(command, {
      own: typeof deny.currentBranch === 'string' && SLICE_BRANCH.test(deny.currentBranch) ? [deny.currentBranch] : [],
      currentBranch: deny.currentBranch ?? null, branchAt: deny.branchAt,
    });
    const reason = checkBash(command, deny) ?? refs ?? (allow ? checkRestrictedShell(command, allow, root, matchGlob, () => null, null, 0, agentType ?? 'the agent') : null);
    return reason ? { allow: false, reason } : { allow: true };
  }
  if (!WRITE_TOOLS.has(tool)) return { allow: true };
  const given = targetOf(input);
  // Symbolic links are resolved first, so a link cannot point a write at a protected file.
  const target = typeof given === 'string' && given !== '' ? realPath(resolve(root, given)) : given;
  const rel = toProjectPath(realPath(root), target);
  const fixed = typeof target === 'string' && target !== '' ? protectedWrite(target, rel, tool, input) : null;
  if (fixed) return { allow: false, reason: fixed };
  if (deny.thresholdError) {
    return { allow: false, reason: 'recade/state.yaml lists threshold files that could not be read, so no write is allowed until a human fixes it.' };
  }
  for (const file of deny.thresholdFiles ?? []) {
    const f = file.replace(/^\.\//, '');
    if (rel === f || (rel === null && typeof target === 'string' && basename(target) === f && !f.includes('/'))) {
      return { allow: false, reason: `${f} holds a threshold. Only a human changes thresholds.` };
    }
  }
  if (allow === null || allow === undefined) return { allow: true };
  const who = agentType ?? 'this agent';
  if (rel === null && typeof target === 'string' && target !== '' && realPath(target) === realPath(root)) {
    return { allow: false, reason: `${target} is the whole checkout: ${who} writes or removes only ${allow.globs.join(', ') || 'no file'} in it.` };
  }
  if (rel === null) return { allow: false, reason: `${who} writes only inside the project. ${target ?? '(no path)'} is outside it.` };
  if (allow.globs.some((g) => matchGlob(g, rel))) return { allow: true };
  const why = allow.unresolved.length > 0 ? ` ${allow.unresolved.join('. ')}.` : '';
  const list = allow.globs.length > 0 ? allow.globs.join(', ') : 'no file';
  return { allow: false, reason: `${who} may write ${list}, not ${rel}.${why}` };
}

/* ---------- hook I/O ---------- */

/**
 * The branch checked out in a folder given to `git -C`, read from `cwd`: its name, null when HEAD is detached, undefined
 * when the folder does not exist (the scan then refuses a merge there, since it cannot say where it lands).
 */
const branchAtFrom = (cwd) => (folder) => {
  const abs = resolve(cwd, folder);
  if (!existsSync(abs)) return undefined;
  return run(abs, ['symbolic-ref', '--short', '-q', 'HEAD']);
};

const run = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** The nearest existing folder of a path. */
function existingDir(abs) {
  let d = dirname(abs);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return d;
}

/**
 * The folder a write is judged in: the worktree that holds the target when it is a linked worktree of the same
 * repository as the session (same git common folder), such as a merge or a slice worktree. Anything else (a nested
 * `git init`, another repository, no repository) is judged from the session root.
 */
export function targetRoot(abs, sessionRoot) {
  const d = existingDir(abs);
  const top = run(d, ['rev-parse', '--show-toplevel']);
  if (top === null) return sessionRoot;
  const common = (cwd) => run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const mine = common(sessionRoot);
  return mine !== null && common(d) === mine ? top : sessionRoot;
}

/** A path with its symbolic links resolved: the path itself when it exists, else its nearest existing folder. */
export function realPath(abs) {
  try {
    if (existsSync(abs)) return realpathSync(abs);
    const d = existingDir(abs);
    return join(realpathSync(d), relative(d, abs));
  } catch {
    return abs;
  }
}

/** Append one line to `.recade/guard.log`. Never throws. */
export function logGuard(root, message) {
  try {
    mkdirSync(join(root, '.recade'), { recursive: true });
    appendFileSync(join(root, '.recade', 'guard.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Nothing more to do: the guard must never break a session.
  }
}

/** The text of an agent file: the project copy first, then the plugin copy. Null when neither exists. */
function agentFile(name, root, pluginRoot) {
  const dirs = [join(root, '.claude', 'agents'), pluginRoot ? join(pluginRoot, 'harness', 'agents') : null];
  for (const dir of dirs) {
    if (dir === null) continue;
    const file = join(dir, `${name}.md`);
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  return null;
}

/**
 * The threshold files a project state lists under `harness.threshold_files`, read without a YAML parser. `error` is true
 * when the key is there but its value cannot be read (a form this reader does not know), so the caller refuses writes.
 * @param {string} text the text of recade/state.yaml
 * @returns {{files: string[], error: boolean}}
 */
export function readThresholdFiles(text) {
  if (!/threshold_files/.test(text)) return { files: [], error: false };
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s+threshold_files:/.test(l));
  if (at === -1) return { files: [], error: true };
  const indent = /^(\s*)/.exec(lines[at])[1].length;
  const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, '$2');
  const inline = lines[at].slice(lines[at].indexOf(':') + 1).replace(/\s+#.*$/, '').trim();
  if (inline.startsWith('[')) {
    if (!inline.endsWith(']')) return { files: [], error: true };
    return { files: inline.slice(1, -1).split(',').map(unquote).filter((x) => x !== ''), error: false };
  }
  if (inline !== '' && inline !== 'null' && inline !== '~') return { files: [], error: true };
  const files = [];
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^(\s*)-\s+(.*?)\s*(?:#.*)?$/.exec(lines[i]);
    if (m && m[1].length >= indent) files.push(unquote(m[2]));
    else if (lines[i].trim() !== '' && !lines[i].trim().startsWith('#')) break;
  }
  return { files: files.filter((x) => x !== ''), error: false };
}

/** The threshold files of a project, and whether the state could not be read. */
function thresholdsOf(root, files = [join('recade', 'state.yaml')]) {
  const out = { files: [], error: false };
  for (const name of files) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    try {
      const read = readThresholdFiles(readFileSync(file, 'utf8'));
      out.files.push(...read.files);
      out.error ||= read.error;
    } catch {
      out.error = true;
    }
  }
  return out;
}

/** Where the threshold files of a folder of a workspace are listed: the project state, and the settings of a code repository. */
const WORKSPACE_THRESHOLDS = [join('recade', 'state.yaml'), join('.claude', 'recade.yaml')];

/**
 * Handle one PreToolUse hook call. Returns the text to print: the deny decision as JSON, or '' to allow.
 * Throws on malformed input or an internal error: the caller refuses write tools and Bash, and logs.
 * @param {string} stdin
 * @param {{cwd?: string, pluginRoot?: string}} [options]
 * @returns {Promise<string>}
 */
export async function handleHook(stdin, { cwd = process.cwd(), pluginRoot, home = homedir(), tmp = [tmpdir(), '/tmp'], env = process.env } = {}) {
  const event = JSON.parse(stdin);
  if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new Error('The hook input is not an object.');
  if (typeof event.tool_name !== 'string' || event.tool_name === '') throw new Error('The hook input names no tool.');
  const dir = typeof event.cwd === 'string' && event.cwd !== '' ? event.cwd : cwd;
  const tool = String(event.tool_name ?? '');
  const input = event.tool_input ?? {};
  let sessionRoot = run(dir, ['rev-parse', '--show-toplevel']) ?? dir;
  // A session started at the root of a workspace stays a workspace session when its shell moved into a slice worktree:
  // Claude Code names the folder the session started in.
  const project = typeof env?.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR !== '' ? realPath(resolve(env.CLAUDE_PROJECT_DIR)) : null;
  if (project !== null && mayBeWorkspace(project) && inside(project, realPath(sessionRoot))) sessionRoot = project;
  const rawType = event.agent_type ?? event.subagent_type;
  const kind = sessionKind(sessionRoot);
  if (kind !== null) {
    const sessionId = typeof event.session_id === 'string' && SESSION_ID.test(event.session_id) ? event.session_id : null;
    const out = await handleWorkspaceHook({ kind, dir, cwdGiven: dir === event.cwd, tool, input, agentType: typeof rawType === 'string' && rawType !== '' ? rawType : null, sessionRoot, sessionId, pluginRoot, home, temps: tmp });
    if (out !== null) return out;
  }
  // A write belongs to the repository of its target: a merge worktree or a slice worktree may sit beside the session
  // folder, with its own branch and its own conflicts.
  const target = WRITE_TOOLS.has(tool) ? targetOf(input) : undefined;
  const root = typeof target === 'string' && target !== '' ? targetRoot(resolve(dir, target), sessionRoot) : sessionRoot;
  const rawAgent = event.agent_type ?? event.subagent_type;
  const agentType = typeof rawAgent === 'string' && rawAgent !== '' ? rawAgent : null;
  const branch = run(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const thresholds = thresholdsOf(root);
  let allow = null;
  const name = agentType === null ? null : agentType.slice(agentType.lastIndexOf(':') + 1);
  if (name !== null && /^[a-z0-9][a-z0-9-]*$/.test(name) && (WRITE_TOOLS.has(tool) || tool === 'Bash')) {
    const text = agentFile(name, root, pluginRoot);
    const writes = text === null ? null : parseWrites(text);
    if (writes !== null) {
      allow = resolveGlobs(writes, {
        branch: () => branch,
        touches: (id) => {
          const dirSlices = join(root, 'slices');
          if (!existsSync(dirSlices)) return null;
          const sheet = readdirSync(dirSlices).find((f) => f.toUpperCase().startsWith(`${id}-`) && f.endsWith('.md'));
          return sheet ? parseTouches(readFileSync(join(dirSlices, sheet), 'utf8')) : null;
        },
        conflicted: () => {
          const out = run(root, ['diff', '--name-only', '--diff-filter=U']);
          return out === null ? null : out.split('\n').filter((l) => l !== '');
        },
      });
    }
  }
  const isTracked = (path) => run(dir, ['ls-files', '--error-unmatch', '--', path]) !== null;
  const decision = decide({ agentType, tool, input, allow, deny: { thresholdFiles: thresholds.files, thresholdError: thresholds.error, currentBranch: branch, isTracked, branchAt: branchAtFrom(dir) }, root });
  if (decision.allow) return '';
  logGuard(root, `deny ${tool} ${agentType ?? '-'}: ${decision.reason}`);
  return denyJson(decision.reason);
}

/** The deny decision of the hook, as Claude Code reads it. */
const denyJson = (reason) => JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});


/* ---------- workspace: one guard for the code repositories and the workspace (spec 6.10) ---------- */

/** A `recade/state.yaml` that says `kind: workspace`, read without a YAML parser. The parser confirms it later. */
const KIND_WORKSPACE = /^kind:[ \t]*(["']?)workspace\1[ \t]*(#.*)?$/m;
const mayBeWorkspace = (dir) => {
  try {
    return KIND_WORKSPACE.test(readFileSync(join(dir, 'recade', 'state.yaml'), 'utf8'));
  } catch {
    return false;
  }
};

/** The folder of the main repository of the git folder at `dir`, or null. */
function mainRepo(dir) {
  const common = run(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common !== null && basename(common) === '.git' ? dirname(common) : null;
}

/** The folder of the slice worktrees in a workspace. */
const WORKTREES = 'worktrees';

/** Is `path` inside `dir` (or `dir` itself)? Both are real paths. */
const inside = (dir, path) => {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * The kind of session the guard judges, from the session folder (the top of its git folder):
 * - `workspace` when it is a workspace;
 * - `code` when it is a code repository of a workspace, or one of its worktrees: its main repository has a link
 *   (`.recade/workspace`) or the harness settings of a code repository (`.claude/recade.yaml`), or a folder above it is
 *   a workspace (also a folder that git cannot read there, such as a worktree of a moved workspace). Its link must
 *   then be good, or every write is refused;
 * - null for a project that is not a workspace, judged as before.
 * @param {string} sessionRoot
 * @returns {'workspace'|'code'|null}
 */
export function sessionKind(sessionRoot) {
  if (mayBeWorkspace(sessionRoot)) return 'workspace';
  const main = mainRepo(sessionRoot);
  const markers = [join(sessionRoot, '.claude', 'recade.yaml')];
  if (main !== null) markers.push(join(main, '.recade', 'workspace'), join(main, '.claude', 'recade.yaml'));
  if (markers.some((m) => existsSync(m))) return 'code';
  // A folder above the session (or above its main repository) that is a workspace. This also holds a worktree whose
  // git folder is gone, such as the worktree of a moved workspace, which git no longer reads.
  for (const start of main === null ? [sessionRoot] : [sessionRoot, main]) {
    for (let d = dirname(resolve(start)); ; d = dirname(d)) {
      if (mayBeWorkspace(d)) return 'code';
      if (dirname(d) === d) break;
    }
  }
  return null;
}

/**
 * The root a path belongs to, from `git rev-parse --git-common-dir` of its nearest existing folder:
 * - `repo` when that is the git folder of `repos/<name>` of a repository of the registry (its main checkout or a worktree);
 * - `workspace` when it is the git folder of the workspace, outside `repos/`;
 * - `outside` for anything else: another repository (also one under `repos/` that the registry does not hold), a path
 *   under `repos/` that is no registered repository, or a folder outside the workspace.
 * Symbolic links are resolved first. `root` is the top of the checkout that holds the path.
 * @param {string} abs an absolute path
 * @param {{ws: string, registry: string[]}} ctx the workspace (a real path) and the names of its registry
 * @returns {{kind: 'repo', name: string, root: string}|{kind: 'workspace', root: string}|{kind: 'outside'}}
 */
export function rootOf(abs, { ws, registry }) {
  const target = realPath(abs);
  const home = realPath(ws);
  let d;
  try {
    d = statSync(target).isDirectory() ? target : existingDir(target);
  } catch {
    d = existingDir(target);
  }
  // The code repositories and the slice worktrees sit inside the workspace folder, but belong to other repositories.
  const inRepos = (root) => {
    const rel = toProjectPath(root, target);
    return rel !== null && /^(repos|worktrees)(\/|$)/.test(rel);
  };
  const top = run(d, ['rev-parse', '--show-toplevel']);
  const common = run(d, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (top === null || common === null) {
    // A workspace whose git folder cannot be read is still the workspace for the paths under it.
    return inside(home, target) && !inRepos(home) && !existsSync(join(home, '.git')) ? { kind: 'workspace', root: home } : { kind: 'outside' };
  }
  const git = realPath(common);
  const root = realPath(top);
  if (basename(git) !== '.git') return { kind: 'outside' };
  const main = dirname(git);
  // A checkout counts only when it is the main checkout or a worktree its repository lists: a planted `.git` file
  // in a folder of the project does not make that folder a root.
  if (root !== main && !listedWorktrees(main).includes(root)) return { kind: 'outside' };
  if (main === home) return inRepos(root) ? { kind: 'outside' } : { kind: 'workspace', root };
  const name = basename(main);
  if (registry.includes(name) && REPO_NAME.test(name) && name !== WORKSPACE_PREFIX && physicallyAt(home, name, main)) return { kind: 'repo', name, root };
  return { kind: 'outside' };
}

/** The worktrees git lists for the main repository `main`, as real paths. */
function listedWorktrees(main) {
  const out = run(main, ['worktree', 'list', '--porcelain']);
  if (out === null) return [];
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => realPath(l.slice('worktree '.length)));
}

/**
 * Does the main repository `main` (a real path) sit at `<ws>/repos/<name>` itself, with no symbolic link on the way?
 * A link under `repos/` to a repository elsewhere does not put that repository in the workspace.
 */
export function physicallyAt(ws, name, main) {
  const home = realPath(ws);
  const lexical = join(home, 'repos', name);
  try {
    if (lstatSync(join(home, 'repos')).isSymbolicLink() || lstatSync(lexical).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return realPath(lexical) === main && realPath(main) === main;
}

/**
 * The Writes lines of an agent in a workspace, each tied to where it holds: `repo` is the prefix of the line
 * (`workspace` for the workspace, a repository name), or null for an unprefixed line. `<touches>` gives the touches of
 * the slice, each with its own repository (an unprefixed touch counts for the only repository of a one-entry registry).
 * A placeholder that cannot be resolved, or a touch that names no repository of the registry, is listed in `unresolved`.
 * `sliceRepos` are the repositories the sheet of the slice touches, when the slice is known.
 * @param {string[]} lines
 * `<S-nn>` is the slice of the session: the one whose sheet names the branch (`ctx.sliceOf`), else the one in the name of a
 * `slice/S-nn-...` branch. With no slice (a session started in the workspace) it stands for any slice when `ctx.anySlice` is set.
 * `ctx.slice`, when given, is the slice of the session itself (a session at the root of the workspace that runs
 * `/slice`): it wins over the branch. `ctx.noSlice` is the reason given when no slice is known.
 * A `<conflicted-files>` entry carries `conflicted: true`.
 * @param {{branch: () => string|null, touches: (id: string) => string[]|null, conflicted: () => string[]|null, registry?: string[], sliceOf?: (branch: string) => string|string[]|null, anySlice?: boolean, slice?: string|null, noSlice?: string}} ctx
 * @returns {{entries: {repo: string|null, glob: string, conflicted?: true}[], unresolved: string[], sliceRepos: string[]}}
 */
export function resolveEntries(lines, ctx) {
  const registry = ctx.registry ?? [];
  const safe = (fn, ...a) => {
    try {
      return fn(...a);
    } catch {
      return null;
    }
  };
  const own = typeof ctx.slice === 'string' ? ctx.slice : null;
  const branch = own !== null ? null : safe(ctx.branch);
  const m = branch ? SLICE_BRANCH.exec(branch) : null;
  let named = branch && ctx.sliceOf ? safe(ctx.sliceOf, branch) : null;
  // Two sheets that name the branch: the guard picks neither.
  const twins = Array.isArray(named) ? named : null;
  if (twins !== null) named = null;
  const id = own ?? (twins !== null ? null : (named ?? (m ? m[1].toUpperCase() : null)));
  const noSlice = ctx.noSlice ?? 'the branch is not slice/S-nn-...';
  let touches;
  const touchList = () => {
    if (touches === undefined) touches = id === null ? null : safe(ctx.touches, id);
    return touches;
  };
  const known = (repo) => repo !== null && repo !== WORKSPACE_PREFIX && registry.includes(repo);
  const entries = [];
  const unresolved = [];
  for (const line of lines) {
    const { repo, glob } = parseTouch(line);
    if (glob === '<touches>') {
      if (repo !== null) unresolved.push(`${line} cannot be resolved: <touches> carries its own repositories`);
      else if (id === null) unresolved.push(`<touches> cannot be resolved: ${noSlice}`);
      else {
        const list = touchList();
        if (!list || list.length === 0) unresolved.push(`<touches> cannot be resolved: the sheet of ${id} was not found or its touches: list is empty`);
        else {
          for (const t of list) {
            const p = parseTouch(t);
            const r = p.repo ?? (registry.length === 1 ? registry[0] : null);
            if (known(r)) entries.push({ repo: r, glob: p.glob });
            else unresolved.push(`the touch ${t} of ${id} names no code repository of the registry`);
          }
        }
      }
    } else if (glob === '<conflicted-files>') {
      const list = safe(ctx.conflicted);
      if (list === null) unresolved.push('<conflicted-files> cannot be resolved: git could not list the conflicted files');
      else if (list.length === 0) unresolved.push('<conflicted-files> is empty: git lists no conflicted file');
      else entries.push(...list.map((f) => ({ repo, glob: f.replace(/[*?{}[\]]/g, '\\$&'), conflicted: true })));
    } else if (glob.includes('<S-nn>')) {
      if (twins !== null) unresolved.push(`${line} cannot be resolved: two sheets name the branch ${branch}: ${twins.join(', ')}`);
      else if (id !== null) entries.push({ repo, glob: glob.replaceAll('<S-nn>', id) });
      else if (ctx.anySlice === true) entries.push({ repo, glob: glob.replaceAll('<S-nn>', 'S-*') });
      else unresolved.push(`${line} cannot be resolved: ${noSlice}`);
    } else entries.push({ repo, glob });
  }
  const list = id === null ? null : touchList();
  const sliceRepos = Array.isArray(list) ? reposOf(list, registry).filter(known) : [];
  return { entries, unresolved, sliceRepos };
}

/**
 * The globs of `resolved` that hold for a write at `where`, from a session at `session`:
 * - in a code repository, from a session of a code repository: the lines prefixed with its name, and the unprefixed
 *   lines when it is the repository of the session or a repository of the slice;
 * - in a code repository, from a session at the root of the workspace: only in a worktree of the slice of the session
 *   (`place` is `slice`), the lines prefixed with its name and the unprefixed lines; in a merge worktree (`merge`), the
 *   conflicted files only; anywhere else (the main checkout, the worktree of another slice), nothing;
 * - in the workspace, the lines prefixed with `workspace:`, and the unprefixed lines when the session runs in the
 *   workspace and runs no slice.
 */
function scopedGlobs({ entries, sliceRepos }, where, session, { place = null, running = [] } = {}) {
  return entries.filter((e) => {
    if (where.kind === 'workspace') return e.repo === WORKSPACE_PREFIX || (e.repo === null && session.kind === 'workspace' && running.length === 0);
    if (where.kind !== 'repo') return false;
    if (session.kind === 'workspace') {
      if (e.repo !== null && e.repo !== where.name) return false;
      if (place === 'merge') return e.conflicted === true;
      return place === 'slice' && sliceRepos.includes(where.name);
    }
    if (e.repo !== null) return e.repo === where.name;
    return session.kind === 'repo' && (where.name === session.name || sliceRepos.includes(where.name));
  }).map((e) => e.glob);
}

/** A session ID of Claude Code, as the hook input gives it. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/**
 * Where the slices each session at the root of the workspace runs are recorded: `.recade/sessions/<session id>`, one
 * slice ID per line. Only `recade slices open` writes it, once the slice is open, with the session ID of the shell that
 * runs it (CLAUDE_CODE_SESSION_ID): the guard only reads it, and no agent writes there.
 */
export const SESSIONS_DIR = join('.recade', 'sessions');

/** The slices a session at the root of the workspace runs, from `.recade/sessions/<id>`: an empty list when there is none. */
export function runningSlices(ws, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return [];
  try {
    return [...new Set(readFileSync(join(ws, SESSIONS_DIR, sessionId), 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^S-\d{2}[a-z]?$/.test(l)))];
  } catch {
    return [];
  }
}

/** The slice a session at the root of the workspace runs first (the one of /slice), or null. */
export const runningSlice = (ws, sessionId) => runningSlices(ws, sessionId)[0] ?? null;

/** Does a shell command set the session ID of Claude Code, which ties a session to its slices? */
const SETS_SESSION_ID = /(^|[^$\w{])CLAUDE_CODE_SESSION_ID['"]?[ \t]*\+?=|\$\{CLAUDE_CODE_SESSION_ID:?=|-v[ \t]+['"]?CLAUDE_CODE_SESSION_ID\b|\bread\b[^;&|\n]*[ \t'"]CLAUDE_CODE_SESSION_ID\b/;

/**
 * Is this Bash command exactly `node <plugin>/bin/recade.js repo sync [--project <workspace>]`, the way out of a bad
 * link? `--project` must name `ws`, the workspace that physically holds the repository of the session.
 */
function syncCommand(command, pluginRoot, ws) {
  if (typeof pluginRoot !== 'string' || pluginRoot === '' || /[\n\r;&|<>$`\\(){}*?[\]~!#]/.test(command)) return false;
  const words = [];
  const re = /[ \t]*(?:"([^"]*)"|'([^']*)'|([^ \t"']+))(?=[ \t]|$)/y;
  const text = command.trim();
  for (let at = 0; at < text.length;) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (m === null) return false;
    words.push(m[1] ?? m[2] ?? m[3]);
    at = re.lastIndex;
  }
  if (words[0] !== 'node' || words[1] !== resolve(pluginRoot, 'bin', 'recade.js') || words[2] !== 'repo' || words[3] !== 'sync') return false;
  const rest = words.slice(4);
  return rest.length === 0 || (rest.length === 2 && rest[0] === '--project' && rest[1].startsWith('/') && ws !== null && realPath(rest[1]) === ws);
}

/**
 * The Recade commands that only the main session runs, as the pair of words that names them, with the reason given to
 * an agent: `repo sync|add` rewrite the links, `workspace commit` commits under the commit lock, `workspace auto-push`
 * records the owner's consent, `harness specialise` writes the agent and command files, `guard snapshot` writes the
 * evidence the audit reads, `slices merge` is the owner's merge on the local forge.
 */
const MAIN_SESSION_ONLY = [
  [['repo', 'sync'], '`recade repo sync` and `recade repo add` rewrite the links of the code repositories: only the main session runs them.'],
  [['repo', 'add'], '`recade repo sync` and `recade repo add` rewrite the links of the code repositories: only the main session runs them.'],
  [['workspace', 'commit'], '`recade workspace commit` commits files of the workspace: only the main session runs it.'],
  [['workspace', 'auto-push'], '`recade workspace auto-push` records the owner\'s consent to push the workspace: only the main session runs it.'],
  [['harness', 'specialise'], '`recade harness specialise` writes the agent and command files of the harness: only the main session runs it.'],
  [['guard', 'snapshot'], '`recade guard snapshot` writes the evidence the audit reads: only the main session runs it.'],
  [['slices', 'merge'], '`recade slices merge` is the owner\'s merge of a slice on the local forge: no agent merges, only the main session runs it after the owner\'s yes.'],
  [['slices', 'open'], '`recade slices open` opens the worktrees of a slice and ties it to the session: only the main session runs it, from /slice.'],
];
/**
 * The reason a shell command runs a main-session-only Recade command, or null. The words are read after the shell
 * removes its quotes and backslashes (`re''po sync` is `repo sync`); the tokenizer gives a command substitution its own
 * segment. A folder given to `-C`, `--work-tree` or `--git-dir` is not a command word (`git -C workspace commit`), and a
 * commit message that names a command is one word, not a command.
 */
function mainSessionOnly(command) {
  let segments;
  try {
    segments = tokenize(command);
  } catch {
    return 'The command cannot be read, so it is refused for an agent.';
  }
  for (const tokens of segments) {
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (['-C', '--work-tree', '--git-dir'].includes(tokens[i - 1])) continue;
      const hit = MAIN_SESSION_ONLY.find(([[a, b]]) => tokens[i] === a && tokens[i + 1] === b);
      if (hit) return hit[1];
    }
  }
  return null;
}

/**
 * The floor of data safety for an agent: the reason a shell command removes or resets the workspace or a registered
 * repository other than the one of the session, or null. Read: `rm -r` and `find ... -delete` whose target is, or holds,
 * the workspace, its `repos/` or `.git`, or a registered repository; `git clean` and `git reset --hard` run in the
 * workspace or in another registered repository. A `cd` the guard cannot follow leaves the later relative paths unread.
 * @param {string} command
 * @param {{dir: string, ws: string, registry: string[], sessionRoot: string}} ctx
 */
function destroysShared(command, { dir, ws, registry, sessionRoot, sliceTrees = [] }) {
  const kept = [ws, join(ws, 'repos'), join(ws, '.git'), join(ws, WORKTREES), ...registry.map((n) => join(ws, 'repos', n)), ...registry.map((n) => join(ws, WORKTREES, n))].map(realPath);
  const trees = realPath(join(ws, WORKTREES));
  const repos = registry.map((n) => realPath(join(ws, 'repos', n)));
  const own = realPath(sessionRoot);
  const why = (what, where) => `${what} on ${where} is refused for an agent: it would destroy the workspace or a registered repository, which the audit cannot bring back. Ask the main session.`;
  let segments;
  try {
    segments = tokenize(command);
  } catch {
    return null;
  }
  let base = dir;
  const at = (t) => {
    if (base === null && !t.startsWith('/')) return null;
    // A glob is read as the folder it lists.
    const glob = t.search(/[*?[]/);
    const plain = glob === -1 ? t : dirname(`${t.slice(0, glob)}x`);
    return realPath(resolve(base ?? '/', plain));
  };
  const holdsKept = (abs) => abs !== null && kept.some((k) => inside(abs, k));
  for (const tokens of segments) {
    const cd = tokens.findIndex((t) => t === 'cd' || t === 'pushd');
    if (cd >= 0) {
      const to = tokens[cd + 1];
      base = to === undefined || /[$`~]/.test(to) || to === '-' || (base === null && !to.startsWith('/')) ? null : resolve(base, to);
      continue;
    }
    for (let i = 0; i < tokens.length; i++) {
      const name = basename(tokens[i]);
      const rest = tokens.slice(i + 1);
      if (name === 'rm' && rest.some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR]/.test(a))) {
        const end = rest.indexOf('--');
        const targets = rest.filter((a, k) => (end !== -1 && k > end) || (!a.startsWith('-') && (end === -1 || k < end)));
        const hit = targets.find((t) => holdsKept(at(t)));
        if (hit !== undefined) return why('rm -r', hit);
      }
      if (name === 'find' && rest.includes('-delete')) {
        const paths = [];
        for (const a of rest) {
          if (a.startsWith('-') || a === '(' || a === '!') break;
          paths.push(a);
        }
        const hit = (paths.length === 0 ? ['.'] : paths).find((t) => holdsKept(at(t)));
        if (hit !== undefined) return why('find -delete', hit);
      }
      if (name === 'git') {
        const words = untilSub(rest);
        const sub = words.sub;
        const after = rest.slice(rest.indexOf(sub) + 1);
        if (sub !== 'clean' && !(sub === 'reset' && after.includes('--hard'))) continue;
        const folder = words.folder === null ? base : base === null && !words.folder.startsWith('/') ? null : resolve(base ?? '/', words.folder);
        if (folder === null) continue;
        const top = realPath(run(folder, ['rev-parse', '--show-toplevel']) ?? folder);
        if (top === realPath(ws) || (repos.includes(top) && top !== own)) return why(`git ${sub === 'clean' ? 'clean' : 'reset --hard'}`, top);
        // From the root of the workspace, a worktree that is not one of the slice of the session is someone else's work.
        if (own === realPath(ws) && inside(trees, top) && top !== trees && !sliceTrees.includes(top)) return why(`git ${sub === 'clean' ? 'clean' : 'reset --hard'}`, top);
      }
    }
  }
  return null;
}

/** The subcommand of a git call and the folder of its last `-C`. */
function untilSub(rest) {
  let folder = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-C') folder = folder === null ? (rest[i + 1] ?? null) : resolve(folder, rest[i + 1] ?? '.');
    if (a === '-C' || a === '-c') i++;
    else if (!a.startsWith('-')) return { sub: a, folder };
  }
  return { sub: null, folder };
}

/** The workspace that physically holds the main repository of `sessionRoot` (`<ws>/repos/<name>`), or null. */
function physicalWorkspace(sessionRoot) {
  const main = mainRepo(sessionRoot);
  if (main === null) return null;
  const real = realPath(main);
  const ws = dirname(dirname(real));
  return basename(dirname(real)) === 'repos' && mayBeWorkspace(ws) && physicallyAt(ws, basename(real), real) ? ws : null;
}

/** Is a real path inside one of the temp folders of the system? */
const inTemp = (target, temps) => temps.some((t) => {
  const dir = realPath(t);
  return target !== dir && inside(dir, target);
});

/** Where the main session of Claude Code keeps its notes and plans: `~/.claude/projects/` and `~/.claude/plans/`. */
const claudeNotes = (target, home) => typeof home === 'string' && home !== '' && ['projects', 'plans'].some((d) => {
  const dir = realPath(join(home, '.claude', d));
  return target !== dir && inside(dir, target);
});

/**
 * The hook in a workspace session or a code repository session. Returns the text to print, or null when the session
 * folder is not a workspace after all (the YAML parser disagrees with the quick read): the caller then judges it as before.
 * - A code repository with a link that is missing, stale or names another workspace: every write tool and Bash call is
 *   refused with the advice `recade repo sync`, except that exact command.
 * - A write is tied to its root (`rootOf`): outside the workspace and the registry it is refused; in a code repository
 *   it is judged against the lines of the agent for that repository, with the protected paths and threshold files of
 *   that checkout; in the workspace, against the `workspace:` lines.
 */
async function handleWorkspaceHook({ kind, dir, cwdGiven = true, tool, input, agentType, sessionRoot, sessionId = null, pluginRoot, home, temps }) {
  if (!WRITE_TOOLS.has(tool) && tool !== 'Bash') return '';
  const layout = await import('../workspace/layout.js');
  const { loadState } = await import('../state.js');
  const refuse = (root, reason) => {
    logGuard(root, `deny ${tool} ${agentType ?? '-'}: ${reason}`);
    return denyJson(reason);
  };
  const command = tool === 'Bash' ? String(input?.command ?? '') : '';
  const mainOnly = agentType !== null && tool === 'Bash' ? mainSessionOnly(command) : null;
  if (mainOnly !== null) return refuse(sessionRoot, mainOnly);
  const found = layout.findWorkspace(sessionRoot);
  if (kind === 'code') {
    let link = layout.checkLink(sessionRoot);
    // The link must name the workspace that physically holds this repository at repos/<name>, with no symbolic link
    // on the way, and that workspace must be its own checkout (not a folder planted inside another one).
    const physical = physicalWorkspace(sessionRoot);
    if (link.ok && (physical === null || found === null || realPath(found.dir) !== physical || realPath(run(physical, ['rev-parse', '--show-toplevel']) ?? '') !== physical)) {
      link = { ok: false, reason: 'link points elsewhere' };
    }
    if (!link.ok) {
      if (agentType === null && tool === 'Bash' && syncCommand(command, pluginRoot, physical)) return '';
      return refuse(sessionRoot, `This code repository is not linked to its workspace (${link.reason}), so every write and every shell command is refused. Run \`${layout.SYNC_ADVICE}\` from the workspace, then start the session again.`);
    }
  }
  if (kind === 'workspace' && (found?.via !== 'self' || realPath(found.dir) !== realPath(sessionRoot))) return null;
  if (found === null) return refuse(sessionRoot, `No workspace was found for ${sessionRoot}, so every write is refused. Run \`${layout.SYNC_ADVICE}\` from the workspace.`);
  const ws = realPath(found.dir);
  const wsState = loadState(ws);
  const registry = registryNames(wsState).filter((n) => REPO_NAME.test(n) && n !== WORKSPACE_PREFIX);
  /** The default branches no agent moves: main, master and the default branch of each repository of the registry. */
  const defaultBranches = [...new Set([...PROTECTED_BRANCHES, ...(Array.isArray(wsState?.repos) ? wsState.repos : []).map((e) => e?.default_branch).filter((b) => typeof b === 'string' && b !== '')])];
  const ctx = { ws, registry };
  const session = rootOf(sessionRoot, ctx);
  if (session.kind === 'outside') {
    return refuse(sessionRoot, `${sessionRoot} is neither the workspace ${ws} nor a code repository of its registry (${registry.join(', ') || 'empty'}), so every write is refused. Run \`recade repo check\` in the workspace.`);
  }

  // A session at the root of the workspace runs its slice: `/slice` ties it with `recade slices open`, which writes the
  // record once the slice is open, and the agents of the session write only the worktrees of that slice, under
  // worktrees/<repo>/<S-nn> (and of a slice /review or /merge-order adds to it).
  if (tool === 'Bash' && SETS_SESSION_ID.test(command)) {
    return refuse(session.root, 'CLAUDE_CODE_SESSION_ID names the session of Claude Code that `recade slices open` ties to a slice. No command sets it.');
  }
  const running = session.kind === 'workspace' ? runningSlices(ws, sessionId) : [];
  const sliceTrees = running.flatMap((id) => registry.map((n) => realPath(join(ws, WORKTREES, n, id))));
  const runs = running.length === 0 ? 'no slice is open in this session (/slice <S-nn> opens one)' : `this session runs ${running.join(', ')}`;

  if (agentType !== null && tool === 'Bash') {
    const destroys = destroysShared(command, { dir: cwdGiven ? dir : session.root, ws, registry, sessionRoot: session.root, sliceTrees });
    if (destroys !== null) return refuse(session.root, destroys);
  }

  const name = agentType === null ? null : agentType.slice(agentType.lastIndexOf(':') + 1);
  const text = name !== null && /^[a-z0-9][a-z0-9-]*$/.test(name) ? agentFile(name, session.root, pluginRoot) : null;
  const listed = text === null ? null : parseWrites(text);
  // An agent with no Writes section (a general-purpose or custom agent) writes only the touches of the session's own
  // repository.
  const narrow = agentType !== null && listed === null;
  const writes = narrow ? ['<touches>'] : listed;
  const branchOf = (root) => run(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const sessionBranch = branchOf(session.root);
  /** The slice whose sheet names this branch in its `branch:` header, or null. */
  const sheetOfBranch = (name) => {
    const slices = join(ws, 'slices');
    if (!existsSync(slices)) return null;
    const found = [];
    for (const f of readdirSync(slices)) {
      if (!/^S-\d+[a-z]?-.*\.md$/i.test(f)) continue;
      const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(slices, f), 'utf8'))?.[1] ?? '';
      const value = (key) => /^[ \t]*(['"]?)(.*?)\1[ \t]*(?:#.*)?$/.exec(new RegExp(`^${key}:(.*)$`, 'm').exec(head)?.[1] ?? '')?.[2] ?? '';
      if (value('branch') === name) found.push((/^(S-\d+[a-z]?)$/i.exec(value('id') || value('doc_id'))?.[1] ?? /^(S-\d+[a-z]?)-/i.exec(f)[1]).toUpperCase());
    }
    if (found.length > 1) return found;
    return found[0] ?? null;
  };
  /** The branch of the sheet of a slice (its `branch:` header, else `slice/<file name>`), or null with no sheet. */
  const sheetBranch = (id) => {
    const slices = join(ws, 'slices');
    if (!existsSync(slices)) return null;
    const sheet = readdirSync(slices).find((f) => f.toUpperCase().startsWith(`${id.toUpperCase()}-`) && f.endsWith('.md'));
    if (sheet === undefined) return null;
    const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(slices, sheet), 'utf8'))?.[1] ?? '';
    const named = /^[ \t]*(['"]?)(.*?)\1[ \t]*(?:#.*)?$/.exec(/^branch:(.*)$/m.exec(head)?.[1] ?? '')?.[2] ?? '';
    return named !== '' ? named : `slice/${sheet.replace(/\.md$/, '')}`;
  };
  const sheetTouches = (id) => {
    const slices = join(ws, 'slices');
    if (!existsSync(slices)) return null;
    const sheet = readdirSync(slices).find((f) => f.toUpperCase().startsWith(`${id}-`) && f.endsWith('.md'));
    return sheet ? parseTouches(readFileSync(join(slices, sheet), 'utf8')) : null;
  };
  /**
   * Where a checkout of a code repository stands for a session at the root of the workspace: `slice` for the worktree
   * of a slice the session runs (`worktrees/<repo>/<S-nn>`), `merge` for the rebase worktree of such a slice
   * (`worktrees/<repo>/merge-<S-nn>`), `other` for the worktree of another slice, `other-merge` for a merge worktree of
   * another slice (or of none), `main` for the main checkout under repos/, `odd` for any other worktree. `id` is the slice.
   */
  const placeOf = (where) => {
    if (where.kind !== 'repo') return null;
    if (where.root === realPath(join(ws, 'repos', where.name))) return { place: 'main' };
    const m = /^worktrees\/([^/]+)\/([^/]+)$/.exec(toProjectPath(ws, where.root) ?? '');
    if (m === null || m[1] !== where.name) return { place: 'odd' };
    if (m[2].startsWith('merge-')) {
      const id = /^merge-(S-\d{2}[a-z]?)$/.exec(m[2])?.[1] ?? null;
      return id !== null && running.includes(id) ? { place: 'merge', id } : { place: 'other-merge', id };
    }
    return running.includes(m[2]) ? { place: 'slice', id: m[2] } : { place: 'other', id: m[2] };
  };
  const allowFor = (where) => {
    if (writes === null) return null;
    // The slice comes from the branch of the checkout written to; the workspace is on its own branch, so a write
    // there takes the slice of the session. A session at the root of the workspace takes the slice it runs.
    const branch = where.kind === 'repo' ? branchOf(where.root) : sessionBranch;
    const at = session.kind === 'workspace' ? placeOf(where) : null;
    // The slice a write takes: the one of the worktree it lands in, else (the workspace) each slice the session runs.
    const ids = session.kind !== 'workspace' ? [undefined] : at?.id && running.includes(at.id) ? [at.id] : running.length > 0 ? running : [null];
    const parts = ids.map((id) => resolveEntries(writes, {
      branch: () => branch,
      sliceOf: sheetOfBranch,
      ...(session.kind === 'workspace' ? { slice: id, noSlice: 'no slice is open in this session (/slice <S-nn> opens one)' } : {}),
      // A session started in the workspace with no slice: <S-nn> then stands for any slice.
      anySlice: session.kind === 'workspace' && running.length === 0,
      touches: sheetTouches,
      conflicted: () => {
        const out = run(where.root, ['diff', '--name-only', '--diff-filter=U']);
        return out === null ? null : out.split('\n').filter((l) => l !== '');
      },
      registry,
    }));
    const resolved = {
      entries: parts.flatMap((p) => p.entries),
      unresolved: [...new Set(parts.flatMap((p) => p.unresolved))],
      sliceRepos: [...new Set(parts.flatMap((p) => p.sliceRepos))],
    };
    return { globs: scopedGlobs(resolved, where, session, { place: at?.place ?? null, running }), unresolved: resolved.unresolved, sliceRepos: resolved.sliceRepos };
  };
  const who = agentType ?? 'This session';

  /** Why an agent of a session at the root of the workspace may not write in this checkout of a code repository, or null. */
  const notThisSlice = (where, target) => {
    const at = placeOf(where);
    const rel = `${toProjectPath(ws, where.root) ?? where.root}`;
    const slice = runs;
    if (at.place === 'main') return `${who} never writes the main checkout repos/${where.name}: a slice works in its worktree, worktrees/${where.name}/<S-nn>, and ${slice}. ${toProjectPath(ws, target) ?? target} is refused.`;
    if (at.place === 'other') return `${rel} is the worktree of ${at.id}, and ${slice}: ${who} writes only the worktrees of the slice of its session. ${toProjectPath(ws, target) ?? target} is refused.`;
    if (at.place === 'other-merge') return `${rel} is a merge worktree${at.id === null ? ' with no slice in its name (worktrees/<repo>/merge-<S-nn>)' : ` of ${at.id}`}, and ${slice}: ${who} writes only the merge worktree of the slice of its session. ${toProjectPath(ws, target) ?? target} is refused.`;
    if (at.place === 'odd') return `${rel} is not a slice worktree of the workspace (worktrees/${where.name}/<S-nn>): ${who} does not write there. ${toProjectPath(ws, target) ?? target} is refused.`;
    if (at.place === 'slice') {
      const branch = branchOf(where.root);
      const named = branch === null ? null : sheetOfBranch(branch);
      const fromName = branch === null ? null : SLICE_BRANCH.exec(branch)?.[1]?.toUpperCase() ?? null;
      if ((typeof named === 'string' ? named : fromName) !== at.id) return `${rel} is on ${branch ?? 'a detached HEAD'}, not on the branch of ${at.id}, so ${who} does not write there.`;
    }
    return null;
  };

  /** The reason a write of `target` (a real path) is refused, or null. */
  const judge = (target, judged, judgedInput) => {
    const where = rootOf(target, ctx);
    if (where.kind === 'outside') {
      const fixed = protectedWrite(target, null, judged, judgedInput);
      if (fixed) return fixed;
      if (agentType === null && claudeNotes(target, home)) return null;
      // The temp folder of the system holds command output and drafts; the paths of the workspace keep their rules.
      if (inTemp(target, temps) && !inside(ws, target)) return null;
      return `${who} writes only in the workspace ${ws}, its code repositories (${registry.join(', ') || 'none'}) and the temp folder. ${target} is outside them.`;
    }
    if (session.kind === 'workspace' && where.kind === 'repo' && agentType !== null) {
      const why = notThisSlice(where, target);
      if (why !== null) return why;
    }
    if (narrow && !(where.kind === 'repo' && session.kind === 'repo' && where.name === session.name) && !(where.kind === 'repo' && session.kind === 'workspace' && placeOf(where).place === 'slice')) {
      return `${who} has no Writes section, so it writes only the touches of ${session.kind === 'repo' ? session.name : 'the slice of its session'}. ${target} is refused.`;
    }
    const allow = allowFor(where);
    if (allow !== null && session.kind === 'workspace' && where.kind === 'repo' && placeOf(where).place === 'slice' && !allow.sliceRepos.includes(where.name)) {
      return `${who} works on ${placeOf(where).id}, which touches ${allow.sliceRepos.join(', ') || 'no code repository'}: ${where.name} is not a repository of this slice, so ${toProjectPath(where.root, target) ?? toProjectPath(ws, target) ?? target} in ${where.name} is refused.`;
    }
    if (allow !== null && where.kind === 'repo' && session.kind === 'repo' && where.name !== session.name && !allow.sliceRepos.includes(where.name) && allow.globs.length === 0) {
      const slice = allow.sliceRepos.length > 0 ? `the slice touches ${allow.sliceRepos.join(', ')}` : 'no slice of this branch touches it';
      const why = allow.unresolved.length > 0 ? ` ${allow.unresolved.join('. ')}.` : '';
      return `${who} works in ${session.name}: ${where.name} is not a repository of this slice (${slice}), so ${toProjectPath(where.root, target) ?? toProjectPath(ws, target) ?? target} in ${where.name} is refused.${why}`;
    }
    const thresholds = thresholdsOf(where.root, WORKSPACE_THRESHOLDS);
    const decision = decide({
      agentType, tool: judged, input: { ...judgedInput, file_path: target }, allow: allow && { globs: allow.globs, unresolved: allow.unresolved },
      deny: { thresholdFiles: thresholds.files, thresholdError: thresholds.error }, root: where.root,
    });
    return decision.allow ? null : decision.reason;
  };

  if (WRITE_TOOLS.has(tool)) {
    const given = targetOf(input);
    if (typeof given !== 'string' || given === '') return refuse(session.root, `${tool} names no file, so it is refused.`);
    const lexical = resolve(dir, given);
    const reason = protectedWrite(lexical, null, tool, input) ?? judge(realPath(lexical), tool, input);
    return reason === null ? '' : refuse(session.root, reason);
  }

  // The shell runs in the folder of the hook input: a relative path starts there, and a bare git command works on the
  // branch checked out there (a slice worktree, when the session moved into one). Without it, at the session root.
  const start = cwdGiven ? dir : session.root;
  const startTop = start === session.root ? null : run(start, ['rev-parse', '--show-toplevel']);
  const currentBranch = startTop === null ? sessionBranch : branchOf(start);
  const thresholds = thresholdsOf(session.root, WORKSPACE_THRESHOLDS);
  const isTracked = (path) => run(start, ['ls-files', '--error-unmatch', '--', path]) !== null;
  let reason = checkBash(command, { thresholdFiles: thresholds.files, currentBranch, isTracked, branchAt: branchAtFrom(start) });
  if (reason === null && agentType !== null) {
    // On the local forge no branch protection stands behind the guard: an agent writes no default branch and no branch
    // of a slice that is not its own (the slices of its session, or the branch of the repository it was opened in).
    const own = session.kind === 'workspace'
      ? running.map(sheetBranch).filter((b) => b !== null)
      : typeof sessionBranch === 'string' && SLICE_BRANCH.test(sessionBranch) ? [sessionBranch] : [];
    reason = checkRefWrites(command, { protectedBranches: defaultBranches, own, currentBranch, branchAt: branchAtFrom(start) });
  }
  const allow = allowFor(session);
  if (reason === null && allow !== null) {
    // From a workspace session, a shell write under `repos/` is refused: the code repositories are written with the
    // write tools, which judge each repository, or from a session of that repository.
    const match = session.kind === 'workspace' ? (g, p) => !/^repos(\/|$)/.test(p) && matchGlob(g, p) : matchGlob;
    // A path under worktrees/ is in a slice worktree, another repository: it is judged like a write tool there.
    const nested = session.kind === 'workspace' ? (abs) => /^worktrees\//.test(toProjectPath(ws, realPath(abs)) ?? '') : null;
    const shellAllow = { globs: allow.globs, unresolved: allow.unresolved };
    /** A folder the shell moves to or works in: the session checkout, or a checkout the agent may write. */
    const folder = (abs) => {
      const real = realPath(abs);
      const where = rootOf(real, ctx);
      if (where.kind === 'outside') {
        const inTempDir = temps.some((t) => inside(realPath(t), real));
        return inTempDir && !inside(ws, real) ? null : `The shell of ${who} may not work in ${real}: it is outside the workspace and its code repositories.`;
      }
      if (where.root === session.root && !(session.kind === 'workspace' && /^(repos|worktrees)(\/|$)/.test(toProjectPath(where.root, real) ?? ''))) return null;
      // From the root of the workspace, an agent works in the worktrees of its slice (to run the tests, git, a build),
      // also when it writes nothing there: each write is still judged on its own. The merge-keeper works in a merge worktree.
      if (session.kind === 'workspace' && where.kind === 'repo') {
        const at = placeOf(where).place;
        if (at === 'slice' && notThisSlice(where, real) === null) return null;
        if (at === 'merge' && (writes ?? []).includes('<conflicted-files>')) return null;
      }
      if (narrow) return `The shell of ${who} works only in ${session.root}.`;
      const there = allowFor(where);
      return there !== null && there.globs.length > 0 && where.root !== session.root ? null : `The shell of ${who} may not work in ${real}: it writes nothing there.`;
    };
    reason = checkRestrictedShell(command, shellAllow, session.root, match, (abs) => judge(realPath(abs), 'Write', {}), folder, 0, who, nested, start);
  }
  return reason === null ? '' : refuse(session.root, reason);
}
