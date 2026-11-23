import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/*
 * The shell side of the guard: a tokenizer and the deny list for Bash commands. It reads a command line the way a
 * careful reader would, not the way a shell does, so it is a deny list and not a sandbox. Only `node:` builtins.
 */

export const PROTECTED_BRANCHES = ['main', 'master'];
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const MUTATING = /(^|[^<>=])>|\b(sed|perl|tee|mv|cp|rm|truncate|patch|ed|dd|install|chmod|ln|touch|mkdir|python3?|node|ruby)\b|\bgit\s+(checkout|restore|apply|stash|mv|rm)\b/;
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'command', 'exec', 'xargs', 'nice', 'timeout', 'stdbuf', 'setsid', 'watch', 'find', 'parallel', 'then', 'do', 'else', '{', '!']);
const DYNAMIC = /[$`{*[?]/;
const NO_VERIFY = /^--no-v(e(r(i(f(y)?)?)?)?)?$/;

/** Fixed paths no agent and no shell command may change, whatever the project state says. */
const FIXED_SHELL = [
  /(^|[\s"'=/<>])\.recade(\/|[\s"']|$)/,
  /\.claude\/settings[\w.-]*\.json/,
  /(^|[\s"'=/<>])\.githooks(\/|[\s"']|$)/,
  /(^|[\s"'=/<>])\.git\/hooks/,
  /(^|[\s"'=/<>])\.claude\/hooks(\/|[\s"']|$)/,
  /(^|[\s"'=/<>])recade\/state\.yaml/,
  /(^|[\s"'=/<>])\.claude\/recade\.yaml/,
];

/** Write `a//b` and `a/./b` as `a/b`, the way the file system reads them. */
const collapse = (path) => path.replace(/\/(?:\.\/)+/g, '/').replace(/\/{2,}/g, '/');

/** Does one path segment, a glob or not, match a name? As in a shell, a glob that does not start with `.` skips dot names. */
function segmentMatches(segment, name) {
  if (!/[*?[]/.test(segment)) return segment === name;
  if (name.startsWith('.') && !segment.startsWith('.')) return false;
  let re = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = segment.indexOf(']', i + 2);
      if (end === -1) re += '\\[';
      else {
        re += `[${segment.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\{}\]]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return true;
  }
}

/** The harness paths a shell command may not change, as path segments. A segment lists the names it stands for. */
const HARNESS_PATHS = [
  [['.claude'], ['hooks']],
  [['.claude'], ['settings.json', 'settings.local.json']],
  [['.recade']],
  [['.githooks']],
  [['recade'], ['state.yaml']],
  [['.claude'], ['recade.yaml']],
];

/**
 * Does a simple command name the agents or the commands of the harness (`.claude/agents`, `.claude/commands`), through
 * `//`, `/./` or a glob? A path inside them always counts. The folder itself counts too, except as an argument of the
 * Recade CLI (`recade harness models --dir .claude/agents`), which is how the harness writes them.
 */
function namesAgentFiles(tokens) {
  const cli = (tokens[0] === 'node' && typeof tokens[1] === 'string' && tokens[1].endsWith('/bin/recade.js')) || basename(tokens[0] ?? '') === 'recade';
  return tokens.some((word) => {
    const parts = collapse(word.replace(/^\d*>>?\|?/, '').replace(/^[^=/]*=/, '')).split('/');
    for (let i = 0; i + 1 < parts.length; i++) {
      if (!segmentMatches(parts[i], '.claude') || !['agents', 'commands'].some((n) => segmentMatches(parts[i + 1], n))) continue;
      if (i + 2 < parts.length || !cli) return true;
    }
    return false;
  });
}

/** A path segment git reads as `.git`: any case, with trailing dots or spaces (case-insensitive file systems strip them). */
const GIT_SEGMENT = /(^|\/)\.git[. ]*(\/|$)/i;

/**
 * Does a command write a path that has a `.git` segment (a redirect, `>|`, `tee`, `cp`, `mv`, `install`, `ln`, `mkdir`,
 * `touch`, `sed -i`, `dd of=`)? Reading one (`cat .git/config > out`) is not a write to it.
 */
function writesGitFolder(command) {
  const hit = (p) => typeof p === 'string' && GIT_SEGMENT.test(collapse(p.replace(/^["']|["']$/g, '')));
  for (const m of command.matchAll(/>\|[ \t]*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g)) if (hit(m[1])) return true;
  for (const tokens of tokenize(command)) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const name = basename(t);
      const rest = tokens.slice(i + 1);
      const redirect = /^\d*>>?\|?(.*)$/.exec(t);
      if (redirect && hit(redirect[1] !== '' ? redirect[1] : tokens[i + 1])) return true;
      if (/^of=/.test(t) && hit(t.slice(3))) return true;
      if (['tee', 'mkdir', 'touch', 'truncate'].includes(name) && positionals(rest).some(hit)) return true;
      if (['cp', 'mv', 'install', 'ln'].includes(name)) {
        const at = rest.findIndex((a) => a === '-t' || a.startsWith('--target-directory'));
        const dest = at >= 0 ? (rest[at].includes('=') ? rest[at].split('=')[1] : rest[at + 1]) : positionals(rest).at(-1);
        if (hit(dest)) return true;
      }
      if ((name === 'sed' || name === 'perl') && rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) && positionals(rest).some(hit)) return true;
    }
  }
  return false;
}

/**
 * Does a word of a command name a harness path, through `//`, `/./` or a glob? A word that ends in a glob on the way
 * to one counts too (`rm -rf .cl*`), unless that glob starts with `*` (`build/*`).
 */
function namesHarness(word) {
  const parts = collapse(word.replace(/^\d*>>?\|?/, '').replace(/^[^=/]*=/, '')).split('/');
  const hit = (segment, names) => names.some((n) => segmentMatches(segment, n));
  for (const path of HARNESS_PATHS) {
    for (let i = 0; i < parts.length; i++) {
      let k = 0;
      while (k < path.length && i + k < parts.length && hit(parts[i + k], path[k])) k++;
      if (k === path.length) return true;
      const last = parts[i + k - 1];
      if (k > 0 && i + k === parts.length && /[*?[]/.test(last) && !last.startsWith('*')) return true;
    }
  }
  return false;
}

/** The harness folders no command may `cd` or `pushd` into. `recade` counts only in a relative path. */
const HARNESS_DIRS = ['.claude', '.recade', '.githooks'];
function entersHarness(target) {
  const parts = collapse(target).split('/');
  return parts.some((p) => HARNESS_DIRS.some((n) => segmentMatches(p, n)) || (!target.startsWith('/') && segmentMatches(p, 'recade')));
}

const escapeRe = (s) => s.replace(/[.+^$()|\\[\]{}*?]/g, '\\$&');

const ANSI = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b' };

/** Decode the escapes of a `$'...'` string, starting after the backslash. Returns the text and the new index. */
function ansiEscape(s, i) {
  const c = s[i];
  if (c in ANSI) return [ANSI[c], i];
  if (c === 'x') {
    const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
    if (m) return [String.fromCharCode(parseInt(m[0], 16)), i + m[0].length];
  }
  if (c === 'u' || c === 'U') {
    const m = new RegExp(`^[0-9a-fA-F]{1,${c === 'u' ? 4 : 8}}`).exec(s.slice(i + 1));
    if (m) return [String.fromCodePoint(parseInt(m[0], 16)), i + m[0].length];
  }
  if (/[0-7]/.test(c)) {
    const m = /^[0-7]{1,3}/.exec(s.slice(i));
    return [String.fromCharCode(parseInt(m[0], 8)), i + m[0].length - 1];
  }
  return [c, i];
}

const HEREDOC = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/;

/** The here-document operator at `i` of `s`, or null: its delimiter, and whether the body is quoted (no expansion). */
function heredocAt(s, i) {
  if (s[i] !== '<' || s[i + 1] !== '<' || s[i + 2] === '<') return null;
  const m = HEREDOC.exec(s.slice(i));
  if (!m) return null;
  return { length: m[0].length, tabs: m[1] === '-', delim: m[2] ?? m[3] ?? m[4], quoted: m[2] !== undefined || m[3] !== undefined || m[0].includes('\\') };
}

/** Read the bodies of pending here-documents, from the newline at `i`. Returns the index of the last newline read and the bodies. */
function readBodies(s, i, docs) {
  const bodies = [];
  let at = i + 1;
  for (const doc of docs) {
    const lines = [];
    while (at <= s.length) {
      let end = s.indexOf('\n', at);
      if (end === -1) end = s.length;
      const line = s.slice(at, end);
      at = end + 1;
      if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delim) break;
      lines.push(line);
    }
    bodies.push({ doc, text: lines.join('\n') });
  }
  return { end: Math.min(at - 1, s.length), bodies };
}

/** The index of the `)` that closes the `$(` at `start`, reading quotes and here-documents. */
function substitutionEnd(s, start) {
  let depth = 0;
  let q = null;
  const pend = [];
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === '\\') i++;
    else if (heredocAt(s, i)) {
      const h = heredocAt(s, i);
      pend.push(h);
      i += h.length - 1;
    } else if (c === '\n' && pend.length > 0) i = readBodies(s, i, pend.splice(0)).end;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length - 1;
}

/**
 * Split a command line into segments of tokens. Quotes are removed (`'...'`, `"..."` and `$'...'` with its escapes),
 * a backslash before a newline joins the lines, and `;` `&` `|` newline parentheses and backticks end a segment.
 * @param {string} command
 * @returns {string[][]}
 */
export function tokenize(command) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  const pending = [];
  const endToken = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === "$'") {
      if (c === "'") quote = null;
      else if (c === '\\' && i + 1 < command.length) {
        const [text, at] = ansiEscape(command, i + 1);
        cur += text;
        i = at;
      } else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && command[i + 1] === '\n') i++;
      else if (c === '\\' && i + 1 < command.length) cur += command[++i];
      else if (c === '$' && command[i + 1] === '(') {
        const end = substitutionEnd(command, i);
        cur += command.slice(i, end + 1);
        i = end;
      } else cur += c;
    } else if (c === '$' && command[i + 1] === "'") {
      quote = "$'";
      has = true;
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && command[i + 1] === '\n') i++;
    else if (c === '\\' && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (command.startsWith('<<<', i)) {
      endToken();
      tokens.push('<<<');
      i += 2;
    } else if (heredocAt(command, i)) {
      const h = heredocAt(command, i);
      pending.push(h);
      endToken();
      i += h.length - 1;
    } else if (c === ' ' || c === '\t') endToken();
    else if (c === '\n' && pending.length > 0) {
      endSegment();
      // The body of a here-document is text, not commands. Only the substitutions of an unquoted one run.
      const { end, bodies } = readBodies(command, i, pending.splice(0));
      i = end;
      for (const { doc, text } of bodies) {
        if (!doc.quoted) for (const m of text.matchAll(/\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`/g)) segments.push([m[0]]);
      }
    } else if (';&|\n()`'.includes(c)) endSegment();
    else {
      cur += c;
      has = true;
    }
  }
  endSegment();
  return segments;
}

export const isTestPath = (p) => {
  const path = p.replace(/^\.\//, '');
  return /(^|\/)(tests?|e2e|__tests__)(\/|$)/.test(path) || /\.(test|spec)\.[^/]*$/.test(path);
};

/** Does a push refspec reach a protected branch? `+src:dst`, `dst`, `heads/dst` and `refs/heads/dst` all name `dst`. */
export const protectedRef = (ref) => {
  let r = ref.replace(/^\+/, '');
  if (r.includes(':')) r = r.slice(r.lastIndexOf(':') + 1);
  r = r.replace(/^refs\//, '').replace(/^heads\//, '');
  return PROTECTED_BRANCHES.includes(r);
};

/** A change of folder in a command: git is then asked about the wrong path. */
const MOVES = /(^|[\s;&|(`])(cd|pushd|popd)(?=[\s;&|)`]|$)|(^|\s)-C(?=\s|$)/;

/**
 * May this test path hold a file git tracks? Without a way to ask git, with a pattern, or after `cd`, `pushd`, `popd`
 * or `-C` anywhere in the command, yes. An untracked file is a red test of the slice not committed yet, which /slice
 * sets aside; the ledger keeps its hash.
 */
const tracked = (ctx, path) =>
  typeof ctx.isTracked !== 'function' || DYNAMIC.test(path) || MOVES.test(ctx.raw ?? '') || ctx.isTracked(path) !== false;

const onProtected = (branch) => branch !== null && branch !== undefined && PROTECTED_BRANCHES.includes(branch);
const TEST_RM = 'Deleting tests is refused. A test that is wrong is fixed through the spec, never removed.';

/** Positional arguments: no dash, and not the value of an option that takes one. */
function positionals(args, valueOptions = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueOptions.includes(a)) i++;
    else if (!a.startsWith('-')) out.push(a);
  }
  return out;
}

/**
 * A git configuration key that can switch the hooks off from a file or an alias: `include.path`, `includeIf.<cond>.path`
 * (the included file may set core.hooksPath) and `alias.<name>` (it may hide `commit --no-verify`). Keys are not case sensitive.
 */
const CONFIG_BYPASS = /^(include\.path|includeif\..*\.path|alias\..+)$/i;
const bypassKey = (text) => CONFIG_BYPASS.test(text.split('=')[0]) || /^includeif\..*\.path=/i.test(text);
const CONFIG_REFUSED = 'git include.path, includeIf and alias entries can switch the git hooks off. Refused.';
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list', '--show-origin', '--show-scope', '--name-only']);

const HIDDEN_SUB = 'git with a variable or a substitution as the subcommand hides what it does. Write the subcommand out.';
const INFO_FLAGS = /^--(version|help|html-path|man-path|info-path|exec-path)$|^-h$|^-v$/;
const CONFIG_HIDDEN = 'A git configuration key held in a variable or a substitution hides what it sets. Write the key out.';
const CONFIG_SECTIONS = 'Renaming or removing a git configuration section can build an include, alias or core entry. Refused.';
const CONFIG_EDIT = 'Opening the git configuration in an editor is refused. Use git config with a key.';
const CONFIG_SET = new Set(['-e', '--edit', 'edit']);
const CONFIG_SECTION_OPS = new Set(['--rename-section', 'rename-section', '--remove-section', 'remove-section']);

/** A `-c` or `--config` value: the key part may not be hidden and may not be a bypass key. */
function configValue(given) {
  if (given === undefined) return CONFIG_HIDDEN;
  if (/[$`]/.test(given.split('=')[0])) return CONFIG_HIDDEN;
  return bypassKey(given) ? CONFIG_REFUSED : null;
}

/**
 * The reason a `git -c key=value`, `git clone --config key=value` or `git config key value` names a key that opens a
 * bypass, or null. `i` is where the subcommand sits, `args` all the arguments after `git`.
 */
function configReason(args, i, sub, rest) {
  for (let k = 0; k < i; k++) {
    const opt = args[k];
    const hit = opt === '-c' ? configValue(args[k + 1]) : /^-c./.test(opt) ? configValue(opt.slice(2)) : null;
    if (hit) return hit;
  }
  // After the subcommand `-c` is a bypass too (`git clone -c ...`), except for `commit -c <commit>`.
  for (let k = 0; k < rest.length; k++) {
    const opt = rest[k];
    let hit = null;
    if (opt === '--config') hit = configValue(rest[k + 1]);
    else if (opt.startsWith('--config=')) hit = configValue(opt.slice('--config='.length));
    else if (sub !== 'commit' && sub !== 'config') {
      if (opt === '-c' && /^[A-Za-z][\w-]*\./.test(rest[k + 1] ?? '')) hit = configValue(rest[k + 1]);
      else if (/^-c[A-Za-z][\w-]*\./.test(opt)) hit = configValue(opt.slice(2));
    }
    if (hit) return hit;
  }
  if (sub === 'config') {
    if (rest.some((a) => CONFIG_SET.has(a))) return CONFIG_EDIT;
    if (rest.some((a) => CONFIG_SECTION_OPS.has(a))) return CONFIG_SECTIONS;
    if (!rest.some((a) => CONFIG_READS.has(a)) && rest[0] !== 'get') {
      const keys = rest.filter((a) => !a.startsWith('-'));
      if (keys.some((a) => /[$`]/.test(a))) return CONFIG_HIDDEN;
      if (keys.some(bypassKey)) return CONFIG_REFUSED;
    }
  }
  return null;
}

/** The reason a git command is refused, or null. `args` starts after `git`. */
function checkGit(args, ctx) {
  let i = 0;
  /** The folders of `-C`: a merge there lands on the branch of that checkout, not of the session. */
  const folders = [];
  while (i < args.length && args[i].startsWith('-')) {
    const opt = args[i];
    if (opt === '-C' && args[i + 1] !== undefined) folders.push(args[i + 1]);
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'].includes(opt) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const configured = configReason(args, i, sub, rest);
  if (configured) return configured;
  // A backtick ends a segment, so `git `echo commit` -n` leaves a bare `git`: the subcommand is hidden.
  if (sub === undefined) return ctx.raw.includes('`') && !args.some((a) => INFO_FLAGS.test(a)) ? HIDDEN_SUB : null;
  if (/[$`]/.test(sub)) return HIDDEN_SUB;
  if (args.some((a) => NO_VERIFY.test(a))) return '--no-verify skips the git hooks. Refused for every agent.';
  if (sub === 'commit') {
    const withValue = new Set(['-m', '-F', '-C', '-c', '--message', '--file', '--author', '--date']);
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (withValue.has(a)) k++;
      else if (/^-[a-zA-Z]*n[a-zA-Z]*$/.test(a)) return '`git commit -n` is --no-verify. Refused for every agent.';
    }
  }
  if (sub === 'push' || sub === 'merge' || sub === 'pull') {
    if (args.some((a) => DYNAMIC.test(a))) return `git ${sub} with a variable, a substitution or a pattern hides the target. Write the branch out.`;
  }
  if (sub === 'push') {
    if (rest.includes('--all') || rest.includes('--mirror')) return 'Pushing every branch includes main. Refused.';
    const pos = positionals(rest, ['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
    if (pos.some(protectedRef)) return 'Pushing to main is refused. Push the branch of the slice and open a pull request.';
    if (pos.length < 2) return 'Name the remote and the branch in a push: git push origin slice/S-nn-name. A bare push is refused.';
    const chained = /\b(switch|checkout)\b/.test(ctx.raw);
    if (pos.slice(1).some((r) => /^(HEAD|@)(:|$)/.test(r)) && (onProtected(ctx.currentBranch) || ctx.currentBranch === null || chained)) {
      return 'Pushing HEAD is refused when the branch may be main. Write the branch name.';
    }
  }
  if ((sub === 'merge' || sub === 'pull') && (onProtected(ctx.currentBranch) || /\b(switch|checkout)\b/.test(ctx.raw))) {
    return 'Merging into main is refused. A human merges the pull request.';
  }
  // `git -C <folder> merge` merges into the branch checked out in that folder, which may be main of another checkout
  // (the main checkout of a code repository, seen from a slice worktree). The caller reads that branch.
  if ((sub === 'merge' || sub === 'pull') && folders.length > 0 && typeof ctx.branchAt === 'function') {
    const at = ctx.branchAt(folders[folders.length - 1]);
    if (at === undefined || onProtected(at)) return 'Merging into main is refused. A human merges the pull request (on the local forge: recade slices merge, from the main session, after the owner\'s yes).';
  }
  if (sub === 'init') return '`git init` inside the project would hide its files behind another repository. Refused.';
  if (sub === 'rm' && positionals(rest).some(isTestPath)) return TEST_RM;
  return null;
}

/** Drop `-R`, `--repo` and `--hostname` with their values from the arguments of `gh`. */
function dropRepo(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-R' || a === '--repo' || a === '--hostname') i++;
    else if (/^--(repo|hostname)=/.test(a) || /^-R./.test(a)) continue;
    else out.push(a);
  }
  return out;
}

const decoded = (a) => {
  try {
    return decodeURIComponent(a);
  } catch {
    return a;
  }
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_TARGETS = [/\/rulesets(\/|$)/, /\/contents\//, /\/protection(\/|$)/, /\/merges(\/|$)/, /\/pulls\/[^/]+\/merge/, /\/git\/refs(\/|$)/];

/** The HTTP method of a `gh api` call: `-X`/`--method` when given, else POST when a field is passed, else GET. */
function apiMethod(args) {
  let method = null;
  let fields = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') method = args[++i] ?? '';
    else if (/^-X./.test(a)) method = a.slice(2);
    else if (a.startsWith('--method=')) method = a.slice('--method='.length);
    else if (['-f', '-F', '--field', '--raw-field'].includes(a) || /^-[fF]./.test(a) || /^--(raw-)?field=/.test(a)) fields = true;
  }
  if (method !== null) return method.toUpperCase();
  return fields ? 'POST' : 'GET';
}

/** The reason a `gh` command is refused, or null. `args` starts after `gh`. */
function checkGh(rawArgs) {
  const args = dropRepo(rawArgs);
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos[0] === 'pr' && pos[1] === 'merge') return '`gh pr merge` is refused. A human merges the pull request.';
  if (pos[0] === 'alias') return '`gh alias` could hide a merge behind another name. Refused.';
  if (pos[0] === 'api') {
    const refused = 'This `gh api` call could merge or move a branch. A human does that.';
    if (args.some((a) => /[$`]/.test(a))) return 'A `gh api` call with a variable or a substitution hides its target. Write it out.';
    for (const a of args) {
      const d = decoded(a);
      if (/\/pulls\/[^/]+\/merge/.test(d) || /\/merges?(?![A-Za-z0-9_])/.test(d)) return refused;
      if (/git\/refs/.test(d) && /(^|\/)heads\/(main|master)\b/.test(d)) return refused;
      if (/refs\/heads\/(main|master)\b/.test(d)) return refused;
      if (a === '--input' || a.startsWith('--input=') || /^[^=]*=@/.test(a) || a.startsWith('@')) return 'A `gh api` body read from a file or stdin hides what it does. Refused.';
    }
    if (pos[1] === 'graphql' && args.some((a) => /merge/i.test(a))) return refused;
    if (pos[1] === 'graphql' && args.some((a) => /mutation/i.test(a))) return 'A `gh api graphql` mutation changes GitHub. A human does that.';
    if (WRITE_METHODS.has(apiMethod(args)) && args.some((a) => !a.startsWith('-') && WRITE_TARGETS.some((re) => re.test(decoded(a))))) {
      return 'This `gh api` call writes files, branch protection, merges or refs on GitHub. A human does that, or a pull request.';
    }
  }
  return null;
}

/** Is the token at `i` where a command starts: first in the segment, or behind a wrapper such as `sudo` or `env`? */
function atCommand(tokens, i) {
  const first = tokens.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  return i === first || (first >= 0 && first < i && WRAPPERS.has(basename(tokens[first])));
}

/** A git configuration file as a write target: `.git/config`, `.gitconfig`, `~/.config/git/config`, with nothing after it. */
const GIT_CONFIG_FILE = /(^|\/)(\.git\/config|\.gitconfig|\.config\/git\/config)$/;

/** The git configuration file this segment writes (redirect, tee, sed -i, cp, mv, install, ln, truncate, dd of=), or null. */
function gitConfigWrite(tokens) {
  const hit = (t) => (t !== undefined && GIT_CONFIG_FILE.test(collapse(t)) ? t : null);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const name = basename(t);
    const rest = tokens.slice(i + 1);
    const redirect = />>?\|?([^>]*)$/.exec(t);
    let found = null;
    if (redirect) found = hit(redirect[1] !== '' ? redirect[1] : tokens[i + 1]);
    else if (name === 'tee' || name === 'truncate') found = positionals(rest).map(hit).find(Boolean) ?? null;
    else if (name === 'sed' || name === 'gsed' || name === 'perl') {
      if (rest.some((a) => /^--in-place/.test(a) || (/^-[a-zA-Z]*i/.test(a) && !a.startsWith('--')))) found = positionals(rest).map(hit).find(Boolean) ?? null;
    } else if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln') {
      const at = rest.findIndex((a) => a === '-t' || a.startsWith('--target-directory'));
      const dest = at >= 0 ? (rest[at].includes('=') ? rest[at].split('=')[1] : rest[at + 1]) : positionals(rest).at(-1);
      found = hit(dest);
    } else if (/^of=/.test(t)) found = hit(t.slice(3));
    if (found) return found;
  }
  return null;
}

/** The reason one segment is refused, or null. A command may start anywhere in the segment, behind any wrapper. */
function checkSegment(tokens, ctx, depth) {
  const first = basename(tokens[0] ?? '');
  if (['export', 'declare', 'typeset', 'readonly'].includes(first) && tokens.some((t) => /^GIT_CONFIG\w*(=|$)/.test(t))) {
    return 'Exporting a GIT_CONFIG variable points git at another configuration and turns the git hooks off. Refused.';
  }
  const written = gitConfigWrite(tokens);
  if (written) return `${written} is a git configuration file. Writing it through the shell is refused.`;
  for (let i = 0; i < tokens.length; i++) {
    const name = basename(tokens[i]);
    const rest = tokens.slice(i + 1);
    let reason = null;
    if (tokens[i] === '<<<' && tokens[i + 1] !== undefined) reason = scanCommand(tokens[i + 1], ctx, depth + 1);
    else if (name === 'git') reason = checkGit(rest, ctx);
    else if (name === 'gh') reason = checkGh(rest);
    else if (name === 'rm' && positionals(rest).some((p) => isTestPath(p) && tracked(ctx, p))) reason = TEST_RM;
    else if ((name === 'cd' || name === 'pushd') && atCommand(tokens, i) && positionals(rest).some(entersHarness)) {
      reason = 'Entering .claude, .recade, .githooks or recade/ from the shell is refused: a path there could not be checked.';
    }
    else if (name === 'eval' && atCommand(tokens, i)) {
      const text = rest.join(' ');
      reason = /[$`]/.test(text) ? 'eval of a variable or a substitution hides the command. Refused.' : scanCommand(text, ctx, depth + 1);
    } else if (name === 'env' && atCommand(tokens, i)) {
      const at = rest.findIndex((a) => a === '-S' || a === '--split-string' || /^-S./.test(a) || a.startsWith('--split-string='));
      if (at >= 0) reason = scanCommand(rest[at].replace(/^(-S|--split-string=?)/, '') || (rest[at + 1] ?? ''), ctx, depth + 1);
    } else if (SHELLS.has(name)) {
      const at = rest.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
      if (at >= 0 && rest[at + 1] !== undefined) reason = scanCommand(rest[at + 1], ctx, depth + 1);
      else if (atCommand(tokens, i) && rest.every((a) => a.startsWith('-'))) reason = 'A shell fed from a pipe or a here-document hides the command. Write the command itself.';
    }
    if (reason) return reason;
  }
  return null;
}

/** Tokens that open the git hooks or the git configuration to a bypass. A commit message is not looked at. */
function hooksReason(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const p = tokens[i - 1];
    if (p === '-m' || p === '--message' || p === '-F' || /^-m./.test(t)) continue;
    if (/hookspath/i.test(t) || /^--config-env/.test(t) || /^GIT_CONFIG\w*=/.test(t)) {
      return 'Changing core.hooksPath or the git configuration through the environment turns the git hooks off. Refused.';
    }
  }
  return null;
}

/** Scan a command line, nested command substitutions, `sh -c` strings and `eval` included. */
function scanCommand(command, ctx, depth = 0) {
  if (depth > 4) return 'The command nests too deeply to be read. Refused.';
  const segments = tokenize(command);
  for (const tokens of segments) {
    ctx.hooks ??= hooksReason(tokens);
    if (tokens.some((t) => basename(t) === 'git')) ctx.gitSeen = true;
    const reason = checkSegment(tokens, ctx, depth);
    if (reason) return reason;
    for (const token of tokens) {
      if (token.includes('$(') || token.includes('`')) {
        const inner = scanCommand(token, ctx, depth + 1);
        if (inner) return inner;
      }
    }
  }
  return null;
}

/**
 * The reason a shell command is refused for every agent, or null: `gh pr merge` (whatever the flags in front),
 * a push or a merge that may reach main, `--no-verify` and its abbreviations, a way around the git hooks, deleting
 * tests, and changing a threshold file or a file of the harness (`.recade`, `.githooks`, `.claude/settings*.json`,
 * `recade/state.yaml`) through the shell.
 * @param {string} command
 * @param {{currentBranch?: string|null, thresholdFiles?: string[]}} [deny]
 * @returns {string|null}
 */
export function checkBash(command, deny = {}) {
  const ctx = { currentBranch: deny.currentBranch ?? null, raw: command, isTracked: deny.isTracked, branchAt: deny.branchAt };
  const reason = scanCommand(command, ctx);
  if (reason) return reason;
  if (ctx.hooks && ctx.gitSeen) return ctx.hooks;
  if (MUTATING.test(command)) {
    for (const file of deny.thresholdFiles ?? []) {
      const f = file.replace(/^\.\//, '');
      if (new RegExp(`(^|[\\s"'=/<>])${escapeRe(f)}($|[\\s"'])`).test(command)) {
        return `${f} holds a threshold. Editing it through the shell is refused. A human changes thresholds.`;
      }
    }
    const harness = (c) => FIXED_SHELL.some((re) => re.test(c) || re.test(collapse(c))) || tokenize(c).some((tokens) => tokens.some(namesHarness));
    if (harness(command)) {
      // The usual case is no change at all: a command that reads .recade/plugin-root to find the plugin and writes a file
      // of its own. It stays refused (the guard does not tell a read from a write in one command), with the way out.
      const readsRoot = /\$\(\s*(?:cat|head(?:\s+-n?\s*1|\s+-1)?)\s+["']?[^)"'\s]*\.recade\/plugin-root["']?\s*\)/g;
      if (readsRoot.test(command) && !harness(command.replace(readsRoot, 'PLUGIN'))) {
        return 'This command reads .recade/plugin-root and writes a file in the same command, and the guard does not tell that read from a change of the harness. Read the plugin folder in a command of its own, then write its path itself in the next command.';
      }
      return 'The stamps, the hooks, the settings and the project state are not changed through the shell. A human does that.';
    }
    if (writesGitFolder(command)) {
      return 'A file or folder named .git is not written through the shell: git would read the folder around it as another checkout. Only git itself writes there.';
    }
    if (tokenize(command).some(namesAgentFiles)) {
      return 'The agents and the commands of the harness (.claude/agents, .claude/commands) are not changed through the shell. `recade harness install` or a human does that.';
    }
  }
  return null;
}

/* ---------- the refs of the default branch and of the other slices ---------- */

/** The branch a ref names (`main`, `heads/main`, `refs/heads/main`, `+src:main`), or null for a ref that is not a branch. */
function branchOfRef(ref) {
  let r = String(ref).replace(/^\+/, '');
  if (r.startsWith('refs/') && !r.startsWith('refs/heads/')) return null;
  r = r.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
  return r === '' ? null : r;
}

/** Git options that take a value, by subcommand, so their value is not read as a branch. */
const REF_VALUE_OPTIONS = {
  'update-ref': ['-m'],
  'symbolic-ref': ['-m'],
  fetch: ['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--upload-pack', '-o', '--server-option', '--negotiation-tip', '--refmap', '--filter', '--recurse-submodules-default'],
  push: ['-o', '--push-option', '--receive-pack', '--exec', '--repo'],
  branch: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '-u', '--set-upstream-to'],
  checkout: ['--conflict', '--pathspec-from-file'],
  switch: ['--conflict'],
  rebase: ['--onto', '-s', '--strategy', '-X', '--strategy-option', '--exec', '-x'],
  reset: ['--pathspec-from-file'],
};

/** The short flags of one word (`-fD` gives `f` and `D`), or the long option itself. */
const flagsOf = (args) => args.flatMap((a) => (/^-[a-zA-Z]+$/.test(a) ? [...a.slice(1)].map((c) => `-${c}`) : a.startsWith('--') ? [a.split('=')[0]] : []));

/**
 * The reason a git command of an agent writes the default branch, or the branch of a slice that is not its own, or
 * null. It reads `update-ref` (and `--stdin`), `symbolic-ref HEAD <ref>`, a `fetch` or `push` refspec into the branch,
 * `branch -f`, `-m`, `-M`, `-c`, `-C`, `-d`, `-D` and the creation of a branch, `checkout -b`/`-B` and `switch -c`/`-C`,
 * a switch to such a branch, `rebase <upstream> <branch>`, and `reset`, `commit`, `cherry-pick`, `revert`, `am`, `merge`,
 * `pull` and `rebase` on a checkout that is on such a branch. On the local forge no branch protection backs this up.
 * @param {string} command
 * @param {{protectedBranches?: string[], own?: string[], currentBranch?: string|null, branchAt?: (folder: string) => string|null|undefined}} ctx
 *   `protectedBranches`: the default branches; `own`: the branches the agent may write (the branches of its slices);
 *   `currentBranch`: the branch where the shell runs; `branchAt`: the branch checked out in a folder given to `-C`
 * @returns {string|null}
 */
export function checkRefWrites(command, ctx = {}, depth = 0) {
  if (depth > 4) return 'The command nests too deeply to be read. Refused.';
  const protectedList = ctx.protectedBranches ?? PROTECTED_BRANCHES;
  const own = ctx.own ?? [];
  const why = (branch, what) => (protectedList.includes(branch)
    ? `${what} writes ${branch}, the default branch. No agent moves it: a human merges (on the local forge: recade slices merge, from the main session, after the owner's yes).`
    : `${what} writes ${branch}, the branch of another slice. An agent writes only the branch of its own slice${own.length > 0 ? ` (${own.join(', ')})` : ''}.`);
  const bad = (branch) => typeof branch === 'string' && (protectedList.includes(branch) || (/^slice\//.test(branch) && !own.includes(branch)));
  let segments;
  try {
    segments = tokenize(command);
  } catch {
    return 'The command cannot be read, so it is refused for an agent.';
  }
  for (const tokens of segments) {
    for (const t of tokens) {
      if (t.includes('$(') || t.includes('`')) {
        const inner = checkRefWrites(t.replace(/`/g, ' '), ctx, depth + 1);
        if (inner) return inner;
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      if (basename(tokens[i]) !== 'git') continue;
      const args = tokens.slice(i + 1);
      let k = 0;
      let folder = null;
      while (k < args.length && args[k].startsWith('-')) {
        if (args[k] === '-C' && args[k + 1] !== undefined) folder = folder === null ? args[k + 1] : resolve(folder, args[k + 1]);
        k += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'].includes(args[k]) ? 2 : 1;
      }
      const sub = args[k];
      if (sub === undefined) continue;
      const rest = args.slice(k + 1);
      const end = rest.indexOf('--');
      const before = end === -1 ? rest : rest.slice(0, end);
      const pos = positionals(before, REF_VALUE_OPTIONS[sub] ?? []);
      const flags = flagsOf(before);
      const has = (...names) => names.some((n) => flags.includes(n));
      /** The branch checked out where this git command works: null when HEAD is detached, undefined when unknown. */
      const here = () => (folder !== null && typeof ctx.branchAt === 'function' ? ctx.branchAt(folder) : ctx.currentBranch ?? null);
      const hidden = (list) => list.some((a) => DYNAMIC.test(a));
      const what = `git ${sub}`;
      if (sub === 'update-ref') {
        if (has('--stdin')) return 'git update-ref --stdin hides the refs it writes. Refused for an agent.';
        if (hidden(pos)) return 'git update-ref with a variable, a substitution or a pattern hides the ref. Refused for an agent.';
        const ref = pos[0];
        if (ref === undefined) continue;
        const branch = ref === 'HEAD' || ref === '@' ? here() : branchOfRef(ref);
        if (branch === undefined) return 'git update-ref HEAD in a folder the guard cannot read is refused for an agent.';
        if (bad(branch)) return why(branch, what);
      } else if (sub === 'symbolic-ref') {
        if (has('-d', '--delete') || pos.length >= 2) return 'git symbolic-ref that points HEAD at another branch (or deletes it) is refused for an agent: a commit would then land on that branch.';
      } else if (sub === 'fetch' || sub === 'push') {
        if (sub === 'fetch' && has('--multiple', '--all')) continue;
        const specs = sub === 'push' && has('-d', '--delete') ? pos.slice(1).map((r) => `:${r}`) : pos.slice(1);
        for (const spec of specs) {
          if (sub === 'fetch' && !spec.includes(':')) continue;
          const dst = spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec;
          if (DYNAMIC.test(dst)) return `${what} with a pattern or a variable in the refspec hides the branch it writes. Refused for an agent.`;
          const branch = dst === 'HEAD' || dst === '@' ? here() : branchOfRef(dst);
          if (bad(branch)) return why(branch, what);
        }
      } else if (sub === 'branch') {
        const current = here();
        let written = [];
        if (has('-d', '-D', '--delete')) written = pos;
        else if (has('-m', '-M', '--move', '-c', '-C', '--copy')) {
          const moves = has('-m', '-M', '--move');
          written = pos.length >= 2 ? [pos[1], ...(moves ? [pos[0]] : [])] : [pos[0], ...(moves ? [current] : [])];
        } else if (has('-f', '--force')) written = pos.slice(0, 1);
        else if (!has('-l', '--list', '-a', '--all', '-r', '--remotes', '--show-current', '-v', '--verbose', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description')) written = pos.slice(0, 1);
        if (hidden(written.filter((b) => typeof b === 'string'))) return 'git branch with a variable, a substitution or a pattern hides the branch it writes. Refused for an agent.';
        const hit = written.find(bad);
        if (hit !== undefined) return why(hit, what);
      } else if (sub === 'checkout' || sub === 'switch') {
        const create = sub === 'checkout' ? ['-b', '-B', '--orphan'] : ['-c', '-C', '--create', '--force-create', '--orphan'];
        const at = before.findIndex((a) => create.includes(a.split('=')[0]));
        if (at >= 0) {
          const name = before[at].includes('=') ? before[at].split('=')[1] : before[at + 1];
          if (name !== undefined && DYNAMIC.test(name)) return `${what} with a variable in the branch name hides it. Refused for an agent.`;
          if (bad(name)) return why(name, what);
        } else if (end === -1 && pos.length === 1 && bad(pos[0])) return why(pos[0], `${what} to ${pos[0]}, then a commit there,`);
      } else if (sub === 'rebase' && pos.length >= 2 && !has('--abort', '--continue', '--skip', '--quit', '--edit-todo', '--show-current-patch')) {
        if (bad(pos[1])) return why(pos[1], what);
      } else if (sub === 'worktree') continue;
      if (['reset', 'commit', 'cherry-pick', 'revert', 'am', 'merge', 'pull', 'rebase'].includes(sub)) {
        if (sub === 'reset') {
          const moves = !has('-p', '--patch') && pos.length > 0 && !['HEAD', '@'].includes(pos[0]);
          if (!moves) continue;
        }
        if (['--abort', '--quit'].some((f) => before.includes(f))) continue;
        const branch = here();
        if (branch === undefined) return `${what} in a folder the guard cannot read is refused for an agent: it cannot say which branch it moves.`;
        if (bad(branch)) return why(branch, `${what} on the checkout of ${branch}`);
      }
    }
  }
  return null;
}

/* ---------- restricted agents ---------- */

/** A path with its symbolic links resolved: the path itself when it exists, else its nearest existing folder. */
function realOf(abs) {
  try {
    let d = abs;
    while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
    return join(realpathSync(d), relative(d, abs));
  } catch {
    return abs;
  }
}

const isDir = (abs) => {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
};

/** The folders a git command works in: `-C <dir>`, `--work-tree[=]<dir>` and `--git-dir[=]<dir>`, before the subcommand. */
function gitFolders(rest) {
  const out = [];
  let sub = null;
  for (let i = 0; i < rest.length && sub === null; i++) {
    const a = rest[i];
    const eq = /^--(work-tree|git-dir)=(.*)$/.exec(a);
    if (eq) out.push(eq[2]);
    else if (a === '-C' || a === '--work-tree' || a === '--git-dir') {
      if (rest[i + 1] !== undefined) out.push(rest[i + 1]);
      i++;
    } else if (a === '-c') i++;
    else if (!a.startsWith('-')) sub = a;
  }
  return { folders: out, sub };
}

/** Words that may stand before the command of a segment: shell keywords, `time`, `builtin`, `command` and the wrappers. */
const LEADERS = new Set(['{', '(', 'if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', 'time', 'builtin', 'command', ...WRAPPERS]);
const isAssignment = (t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
/** Is the token at `i` the command of its segment: only leaders, assignments, options and numbers before it? */
const commandAt = (tokens, i) => tokens.slice(0, i).every((t) => LEADERS.has(basename(t)) || isAssignment(t) || t.startsWith('-') || /^\d+$/.test(t));
/** Commands that write, or run another command that may write. */
const WRITERS = new Set(['cp', 'mv', 'install', 'ln', 'tee', 'sed', 'gsed', 'perl', 'dd', 'truncate', 'rm', 'touch', 'mkdir', 'rsync', 'tar', 'unzip', 'chmod', 'git', 'python', 'python3', 'node', 'ruby', 'patch', ...SHELLS, 'eval', 'source', '.']);
const READ_ONLY_GIT = new Set(['log', 'status', 'diff', 'show', 'rev-parse']);
const GIT_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE)(=|$)/;

/** The arguments of a command up to its first redirect or here-string. */
const untilRedirect = (rest) => {
  const at = rest.findIndex((a) => /^(\d*[<>]|&>|<<<)/.test(a));
  return at === -1 ? rest : rest.slice(0, at);
};

/**
 * The reason a segment is refused outright for an agent with a list of Writes, whatever its paths: a nested shell
 * (`sh -c`, `bash -lc`), `eval`, `env -C`, `xargs` or `find -exec` with a writing command, the git environment
 * (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`), `git -c core.worktree`, `--git-dir`, `git worktree add`, `git clone`,
 * hard links (`ln` without `-s`, `cp -l`, `cp --link`, `rsync --link-dest`).
 */
function agentRefusal(tokens) {
  const no = (what) => `${what} is refused for an agent: the guard cannot follow what it writes.`;
  if (tokens.some((t) => GIT_ENV.test(t))) return no('Setting GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const name = basename(t);
    const rest = tokens.slice(i + 1);
    const at = commandAt(tokens, i);
    if (SHELLS.has(name) && at && rest.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))) return no(`${name} -c`);
    if (name === 'eval' && at) return no('eval');
    if (name === 'harness' && rest[0] === 'specialise') return no('recade harness specialise');
    if (name === 'env' && at && rest.some((a) => a === '-C' || /^-C./.test(a) || a === '--chdir' || a.startsWith('--chdir='))) return no('env -C');
    if ((name === 'xargs' || name === 'parallel') && rest.some((a) => WRITERS.has(basename(a)))) return no(`${name} with a writing command`);
    if (name === 'find' && rest.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)) && rest.some((a) => WRITERS.has(basename(a)))) return no('find -exec with a writing command');
    if (name === 'cp' && at && rest.some((a) => a === '--link' || /^-[a-zA-Z]*l/.test(a))) return no('A hard link (cp -l)');
    if (name === 'ln' && at && !rest.some((a) => a === '--symbolic' || /^-[a-zA-Z]*s/.test(a))) return no('A hard link (ln without -s)');
    if (name === 'rsync' && rest.some((a) => a.startsWith('--link-dest'))) return no('rsync --link-dest');
    if (name === 'git') {
      if (rest.some((a, k) => (rest[k - 1] === '-c' && /^core\.worktree=/i.test(a)) || /^--git-dir(=|$)/.test(a) || /^-ccore\.worktree=/i.test(a))) return no('git with core.worktree or --git-dir');
      const sub = gitFolders(rest).sub;
      const after = rest[rest.indexOf(sub) + 1];
      if (sub === 'clone') return no('git clone');
      if (sub === 'worktree' && after === 'add') return no('git worktree add');
    }
  }
  return null;
}

/**
 * For an agent with a list of Writes: the reason a shell command writes outside it, or null. It reads redirects
 * (also `>|`), `tee`, `sed -i`, `perl -i`, `cp`, `mv`, `install`, `ln` (both ends: a link is a write to what it points at),
 * `dd of=`, `truncate`, `tar -C` and `unzip -d`, `git apply` and `patch`, and refuses outright what it cannot follow
 * (see `agentRefusal`). Every target is read with its symbolic links resolved, from the folder the command is in after
 * a `cd` or `pushd` wherever it stands; a `cd` the guard cannot follow (a variable, `-`, `~`, no folder, `CDPATH`) makes
 * every later relative path refused. A file with more than one hard link is not written. Command substitutions are
 * read the same way. This is a deny list, not a sandbox: see the protocol.
 * @param {string} command
 * @param {{globs: string[]}} allow
 * @param {string} root the project folder
 * @param {(glob: string, path: string) => boolean} matchGlob
 * @param {(abs: string) => string|null} [outside] judges a write outside `root`: a reason, or null. Without it, such a
 *   write is not held (a project that is not a workspace).
 * @param {((abs: string) => string|null)|null} [folder] judges a folder a command moves to or works in (`cd`, `pushd`,
 *   `git -C`, `--work-tree`, `tar -C`, `unzip -d`): a reason, or null. Without it, any folder is accepted.
 * @param {number} [depth] how deep in command substitutions the call is (internal)
 * @param {string} [agent] how a refusal names the agent, with its Writes: `the agent` by default
 * @param {((abs: string) => boolean)|null} [nested] a path inside `root` that belongs to another checkout (a slice worktree
 *   under the workspace): it is judged by `outside`, not by the globs
 * @param {string|null} [start] the folder the shell runs in, where relative paths start (`root` by default; null when
 *   the guard cannot tell, so every relative path is refused)
 * @returns {string|null}
 */
export function checkRestrictedShell(command, allow, root, matchGlob, outside = () => null, folder = null, depth = 0, agent = 'the agent', nested = null, start = root) {
  if (depth > 4) return 'The command nests too deeply to be read. Refused.';
  const held = `Shell writes are held to the Writes of ${agent} (${allow.globs.length > 0 ? allow.globs.join(', ') : 'no file'})`;
  const refuse = (target) => `${held}: ${target} is not among them.`;
  const lost = (target) => `${held}: after a cd the guard cannot follow, ${target} cannot be checked.`;
  const realRoot = realOf(root);
  // The shell starts in the folder of the hook input (a worktree, when the session moved there), else at the root.
  let base = start === undefined ? root : start;
  const judgeAbs = (abs, top, shown) => {
    const rel = relative(top, abs);
    if (rel === '') return refuse(shown);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || (nested !== null && nested(abs))) return outside(abs);
    const p = rel.split('\\').join('/');
    return allow.globs.some((g) => matchGlob(g, p) || matchGlob(g, `${p}/x`)) ? null : refuse(p);
  };
  const checkFrom = (target, from) => {
    if (target === '' || DYNAMIC.test(target) || target.startsWith('~')) return refuse(target || '(empty path)');
    if (/^\/dev\/(null|stdout|stderr|tty)$/.test(target) || target.startsWith('&')) return null;
    if (from === null && !target.startsWith('/')) return lost(target);
    const abs = resolve(from ?? root, target);
    const real = realOf(abs);
    try {
      const st = lstatSync(real);
      if (st.isFile() && st.nlink > 1) return `${target} has more than one hard link: writing it would change another file. Refused.`;
    } catch {
      // A new file.
    }
    return judgeAbs(abs, root, target) ?? (real !== abs || realRoot !== root ? judgeAbs(real, realRoot, target) : null);
  };
  const check = (target) => checkFrom(target, base);
  /**
   * A path a command removes (`rm`, `rmdir`, the source of `mv`, `find -delete`, `git clean`, `git rm`, `git worktree
   * remove`), judged like a write. A glob is read as the folder it lists: removing in it is writing in it.
   */
  const removes = (target, from = base) => {
    if (target === undefined) return null;
    if (/[$`]/.test(target) || target.startsWith('~')) return refuse(target);
    const at = target.search(/[*?[{]/);
    // A folder goes with everything in it: it is judged as a path inside it.
    if (at === -1) {
      if (from === null && !target.startsWith('/')) return lost(target);
      if (!isDir(resolve(from ?? root, target))) return checkFrom(target, from);
      if (checkFrom(`${target.replace(/\/+$/, '')}/x`, from) === null) return null;
      return checkFrom(target, from) ?? refuse(target);
    }
    const folderOf = dirname(`${target.slice(0, at)}x`);
    return checkFrom(`${folderOf}/x`, from) === null ? null : refuse(target);
  };
  /** The folder a git command works in: its last `-C`, read from the current folder. Undefined when it is lost. */
  const gitFrom = (folders) => {
    let at = base;
    for (const f of folders) {
      if (at === null && !f.startsWith('/')) return undefined;
      at = resolve(at ?? root, f);
    }
    return at;
  };
  const moveTo = (target) => {
    if (target === undefined || target === '-' || DYNAMIC.test(target) || target.startsWith('~')) return { base: null };
    if (base === null && !target.startsWith('/')) return { base: null };
    const abs = resolve(base ?? root, target);
    const reason = folder === null ? null : folder(abs);
    return reason ? { reason } : { base: abs };
  };
  const inFolder = (target) => {
    const moved = moveTo(target);
    return moved.reason ?? (moved.base === null ? lost(target ?? '(no folder)') : null);
  };
  // `>|` (a redirect that overrides noclobber) is split by the tokenizer at the `|`: read it from the text.
  for (const m of command.matchAll(/(?:^|[^>])\d*>\|[ \t]*("([^"]*)"|'([^']*)'|[^\s;&|<>()]+)/g)) {
    const r = check(m[2] ?? m[3] ?? m[1]);
    if (r) return r;
  }
  for (const tokens of tokenize(command)) {
    const refused = agentRefusal(tokens);
    if (refused) return refused;
    // A command substitution runs too: read it the same way, from the current folder.
    for (const t of tokens) {
      if (t.includes('$(') || t.includes('`')) {
        const inner = checkRestrictedShell(t.replace(/`/g, ' '), allow, root, matchGlob, outside, folder, depth + 1, agent, nested, base);
        if (inner) return inner;
      }
    }
    const cdAt = tokens.findIndex((t, k) => (t === 'cd' || t === 'pushd' || t === 'popd') && commandAt(tokens, k));
    if (cdAt >= 0) {
      if (tokens[cdAt] === 'popd' || tokens.slice(0, cdAt).some((t) => /^CDPATH=/.test(t))) base = null;
      else {
        const moved = moveTo(positionals(tokens.slice(cdAt + 1))[0]);
        if (moved.reason) return moved.reason;
        base = moved.base;
      }
      continue;
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const name = basename(t);
      const rest = tokens.slice(i + 1);
      const redirect = /^\d*>>?\|?(.*)$/.exec(t);
      if (redirect) {
        const target = redirect[1] !== '' ? redirect[1] : tokens[i + 1];
        if (target !== undefined) {
          const r = check(target);
          if (r) return r;
        }
      } else if (name === 'source' || (t === '.' && commandAt(tokens, i))) {
        const file = rest[0];
        if (file === undefined || DYNAMIC.test(file) || (base === null && !file.startsWith('/'))) return 'source of a file the guard cannot read is refused for an agent.';
        const real = realOf(resolve(base ?? root, file));
        const rel = relative(realRoot, real);
        if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return `source of ${file}, outside this repository, is refused for an agent.`;
      } else if (name === 'tee') {
        for (const f of positionals(untilRedirect(rest))) {
          const r = check(f);
          if (r) return r;
        }
      } else if (name === 'sed' || name === 'gsed' || name === 'perl') {
        const args = untilRedirect(rest);
        const inPlace = args.some((a) => /^--in-place/.test(a) || (/^-[a-zA-Z]*i/.test(a) && !a.startsWith('--')));
        if (inPlace) {
          const valued = positionals(args, ['-e', '-f', '-E']);
          const hasScriptFlag = args.some((a) => a === '-e' || a === '-f' || a === '-E');
          for (const f of hasScriptFlag || name === 'perl' ? valued : valued.slice(1)) {
            const r = check(f);
            if (r) return r;
          }
        }
      } else if (['rm', 'rmdir', 'unlink', 'shred'].includes(name) && commandAt(tokens, i)) {
        const args = untilRedirect(rest);
        const end = args.indexOf('--');
        const targets = end === -1 ? positionals(args) : [...positionals(args.slice(0, end)), ...args.slice(end + 1)];
        for (const f of targets) {
          const r = removes(f);
          if (r) return r;
        }
      } else if (name === 'find' && commandAt(tokens, i) && rest.includes('-delete')) {
        const paths = [];
        for (const a of rest) {
          if (a.startsWith('-') || a === '(' || a === '!') break;
          paths.push(a);
        }
        for (const f of paths.length === 0 ? ['.'] : paths) {
          const r = removes(f);
          if (r) return r;
        }
      } else if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln') {
        const args = untilRedirect(rest);
        const at = args.findIndex((a) => a === '-t' || a.startsWith('--target-directory'));
        const dest = at >= 0 ? (args[at].includes('=') ? args[at].split('=')[1] : args[at + 1]) : positionals(args).at(-1);
        if (dest !== undefined) {
          const r = check(dest);
          if (r) return r;
        }
        if (name === 'mv') {
          // A move removes its sources: each one is judged like a write too.
          const sources = at >= 0 ? positionals(args).filter((a) => a !== dest) : positionals(args).slice(0, -1);
          for (const src of sources) {
            const r = removes(src);
            if (r) return r;
          }
        }
        if (name === 'ln' && dest !== undefined) {
          // Writing through a link writes what it points at: each source is judged as a write too. The target of a
          // symbolic link is read from the folder of the link.
          const sources = at >= 0 ? positionals(args).filter((a) => a !== dest) : positionals(args).slice(0, -1);
          const destAbs = base === null && !dest.startsWith('/') ? null : resolve(base ?? root, dest);
          const linkDir = destAbs === null ? null : dest.endsWith('/') || isDir(destAbs) ? destAbs : dirname(destAbs);
          for (const src of sources) {
            const r = checkFrom(src, linkDir);
            if (r) return r;
          }
        }
      } else if (name === 'truncate') {
        for (const f of positionals(rest, ['-s', '-r', '--size', '--reference'])) {
          const r = check(f);
          if (r) return r;
        }
      } else if (name === 'tar' || name === 'unzip') {
        const flag = name === 'tar' ? /^(-C|--directory)$/ : /^-d$/;
        const k = rest.findIndex((a) => flag.test(a) || (name === 'tar' && a.startsWith('--directory=')));
        if (k >= 0) {
          const r = inFolder(rest[k].includes('=') ? rest[k].split('=')[1] : rest[k + 1]);
          if (r) return r;
        }
      } else if (name === 'patch') return 'Applying a patch through the shell is refused for an agent with a list of Writes.';
      else if (name === 'git') {
        const { folders, sub } = gitFolders(rest);
        if (sub === 'apply') return 'git apply is refused for an agent with a list of Writes.';
        if (!READ_ONLY_GIT.has(sub)) {
          for (const f of folders) {
            const r = inFolder(f);
            if (r) return r;
          }
        }
        const subArgs = rest.slice(rest.indexOf(sub) + 1);
        const end = subArgs.indexOf('--');
        const opts = end === -1 ? subArgs : subArgs.slice(0, end);
        const paths = end === -1 ? positionals(subArgs, ['-e', '--exclude']) : [...positionals(opts, ['-e', '--exclude']), ...subArgs.slice(end + 1)];
        const flags = opts.flatMap((a) => (/^-[a-zA-Z]+$/.test(a) ? [...a.slice(1)].map((c) => `-${c}`) : [a.split('=')[0]]));
        const removed = sub === 'clean' && !flags.includes('-n') && !flags.includes('--dry-run') ? (paths.length === 0 ? ['.'] : paths)
          : sub === 'rm' && !flags.includes('--cached') ? paths
            : sub === 'worktree' && ['remove', 'move'].includes(subArgs[0]) ? positionals(subArgs.slice(1)).slice(0, 1)
              : [];
        if (removed.length > 0) {
          const from = gitFrom(folders.filter((f) => !/^--/.test(f)));
          for (const f of removed) {
            const r = from === undefined && !f.startsWith('/') ? lost(f) : removes(f, from);
            if (r) return r;
          }
        }
      } else if (/^of=/.test(t)) {
        const r = check(t.slice(3));
        if (r) return r;
      }
    }
  }
  return null;
}
