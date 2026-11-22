import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ownFile, writeOwnFile } from '../project/adopt.js';
import { REPO_NAME, WORKSPACE_PREFIX } from '../project/touches.js';
import { SECOND_OPINION_MODELS } from '../models.js';
import { loadState } from '../state.js';
import { WORKTREES_DIR, WORKTREES_IGNORE, ignoresWorktrees, legacyWorktrees, listWorktrees, worktreePath, worktreeRel } from '../workspace/worktrees.js';
import { INSTALL_RECORD, LAUNCHER, SPEC_LINE, genericOf, install, isAdopt, legacyCopies, matchesInstallRecord, pluginVersion, readInstallRecord } from './install.js';
import { withModelLine } from './models.js';
import { specialise } from './specialise.js';
import { defaultExec } from './stamps.js';
import { POINTER_COMMANDS } from './targets.js';

/**
 * `recade harness migrate`: bring a workspace of the old layout to the one entry point (docs/design.md, section 10.4).
 *
 * 1. Install the harness at the root of the workspace (every command and every agent), which adds `worktrees/` to its
 *    `.gitignore`.
 * 2. Move each slice worktree from `repos/<repo>/.claude/worktrees/<S-nn>` to `worktrees/<repo>/<S-nn>` with
 *    `git worktree move`. A worktree with uncommitted changes, a locked one, or one whose new place is taken stays where
 *    it is, and the reason is reported.
 * 3. Remove the old harness copies from each code repository (its agents, its commands, its protocol) only where they are
 *    exactly what Recade installed: the hash of the install record, the record of an adopted repository, or the text the
 *    install of that version writes. A file the team changed stays, and is reported. The pointer command takes the place of
 *    the old `/slice` when that one was removed.
 *
 * `dryRun` changes nothing and says what would be done. A second run finds nothing to do.
 */

const firstLine = (text) => String(text ?? '').trim().split('\n')[0];
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const HEADER_VERSION = /^<!-- recade-harness v(\S+): specialise below the line -->$/m;

/**
 * The text the install of `version` writes for one harness file of a code repository, or null when the plugin has no
 * template for it. `fable` gives the second-opinion agent on the other family, as the install does for that choice.
 */
function installedText(pluginRoot, file, version, { fable = false } = {}) {
  const harness = join(pluginRoot, 'harness');
  let template = null;
  const agent = /^\.claude\/agents\/([a-z0-9-]+)\.md$/.exec(file)?.[1];
  const command = /^\.claude\/commands\/([a-z0-9-]+)\.md$/.exec(file)?.[1];
  if (agent !== undefined && existsSync(join(harness, 'agents', `${agent}.md`))) template = readFileSync(join(harness, 'agents', `${agent}.md`), 'utf8');
  else if (command !== undefined && existsSync(join(harness, 'commands', `${command}.md`))) template = readFileSync(join(harness, 'commands', `${command}.md`), 'utf8');
  else if (file === '.claude/protocol.md') template = readFileSync(join(harness, 'protocol.md'), 'utf8');
  if (template === null) return null;
  if (fable && agent === 'second-opinion') template = withModelLine(template, SECOND_OPINION_MODELS.fable);
  return `${genericOf(template, version)}\n${SPEC_LINE}\n`;
}

/**
 * Is a harness file of a code repository still exactly what Recade installed? Returns null when it is, or the reason it
 * is kept.
 */
function changedBy(repoDir, file, pluginRoot, adopt) {
  // The team's text comes first: `recade harness specialise` records the hash of the specialised file (in an adopted
  // repository) and a re-install keeps the text below the line, so neither record proves the file is only Recade's.
  if (teamText(readFileSync(join(repoDir, file), 'utf8')) !== '') return 'it holds text of the team below the specialisation line';
  if (adopt && ownFile(repoDir, file)) return null;
  if (matchesInstallRecord(repoDir, file)) return null;
  const text = readFileSync(join(repoDir, file), 'utf8');
  const version = HEADER_VERSION.exec(text)?.[1];
  if (version === undefined) return 'it has no harness header, so it was not written by Recade';
  for (const fable of [false, true]) {
    if (installedText(pluginRoot, file, version, { fable }) === text) return null;
  }
  return `it differs from what Recade v${version} installed`;
}

/** The text of the team below the specialisation line of a harness file, trimmed: empty when there is none. */
function teamText(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => l === SPEC_LINE);
  return at < 0 ? '' : lines.slice(at + 1).join('\n').trim();
}

/** The kind and name of a harness file that `recade harness specialise` can write, or null (the protocol). */
function specialisable(file) {
  const m = /^\.claude\/(agents|commands)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(file);
  return m === null ? null : { kind: m[1] === 'agents' ? 'agent' : 'command', name: m[2] };
}

/** Remove a folder when it is empty, and its parent when that is left empty too, up to `stop`. */
function dropEmpty(dir, stop) {
  for (let d = dir; d !== stop && d.startsWith(`${stop}/`); d = resolve(d, '..')) {
    try {
      if (readdirSync(d).length > 0) return;
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

/**
 * Carry the text of the team below the line of a kept harness file to the copy of the workspace, with `specialise` (the
 * same text twice changes nothing). Returns what was done, or null when the file holds no text of the team.
 */
function carry(home, repoDir, file, dryRun) {
  const text = teamText(readFileSync(join(repoDir, file), 'utf8'));
  if (text === '') return null;
  const target = specialisable(file);
  if (target === null) return `not carried: recade harness specialise does not write ${file}, so copy the text by hand`;
  if (!existsSync(join(home, file))) return dryRun ? 'would carry it to the copy of the workspace' : `not carried: the workspace has no ${file}`;
  if (dryRun) return 'would carry it to the copy of the workspace';
  try {
    const done = specialise(home, target.kind, target.name, text);
    return done.status === 'updated' ? 'carried to the copy of the workspace' : 'already in the copy of the workspace';
  } catch (err) {
    return `not carried: ${firstLine(err.message)}`;
  }
}

/**
 * Move the ledger of a moved slice worktree (`.recade/slices/<S-nn>/progress.md`, where the old /slice kept it) to the
 * workspace, where /slice reads it now. A ledger already in the workspace is never overwritten: the same text drops the
 * old copy, another text keeps both and reports it.
 */
function moveLedger(out, home, tree, at, dryRun) {
  const rel = join('.recade', 'slices', tree.name, 'progress.md');
  const from = join(at, rel);
  const to = join(home, rel);
  if (!existsSync(from)) return;
  const entry = { repo: tree.repo, slice: tree.name, from, to };
  if (existsSync(to)) {
    const same = readFileSync(from, 'utf8') === readFileSync(to, 'utf8');
    if (same && !dryRun) rmSync(from);
    out.ledgers.push(same
      ? { ...entry, status: dryRun ? 'would drop' : 'dropped', reason: 'the workspace holds the same ledger' }
      : { ...entry, status: 'kept', reason: 'the workspace has a ledger of this slice already, so neither is changed' });
    return;
  }
  out.ledgers.push({ ...entry, status: dryRun ? 'would move' : 'moved' });
  if (dryRun) return;
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    writeFileSync(to, readFileSync(from));
    rmSync(from);
  }
  dropEmpty(dirname(from), join(at, '.recade'));
}

/**
 * @param {string} ws the workspace
 * @param {{pluginRoot: string, dryRun?: boolean, exec?: Function, ref?: string, secondOpinion?: string}} options
 * @returns {{dryRun: boolean, install: object|null, ignore: 'present'|'added'|'would add', moves: object[], removed: object[], kept: object[], pointers: object[], errors: string[], notes: string[]}}
 */
export function migrate(ws, { pluginRoot, dryRun = false, exec = defaultExec, ref, secondOpinion } = {}) {
  const home = real(ws);
  const out = { dryRun, install: null, ignore: 'present', moves: [], left: [], ledgers: [], removed: [], kept: [], pointers: [], errors: [], notes: [] };
  const state = loadState(home) ?? {};
  if (state.kind !== 'workspace') {
    out.errors.push(`${home} is not a workspace (recade/state.yaml does not say kind: workspace). Run the migration from the workspace of the project.`);
    return out;
  }
  const names = (Array.isArray(state.repos) ? state.repos : []).map((e) => e?.name).filter((n) => typeof n === 'string' && REPO_NAME.test(n) && n !== WORKSPACE_PREFIX);
  const adopt = isAdopt(home);

  // 1. The harness at the root of the workspace, with worktrees/ in its .gitignore.
  const ignorePath = join(home, '.gitignore');
  const ignored = ignoresWorktrees(existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '');
  if (dryRun) {
    out.ignore = ignored ? 'present' : 'would add';
    const missing = ['commands', 'agents'].flatMap((kind) => readdirSync(join(pluginRoot, 'harness', kind)).filter((f) => f.endsWith('.md')).map((f) => `.claude/${kind}/${f}`)).filter((f) => !existsSync(join(home, f)));
    out.install = { dryRun: true, missing };
  } else {
    try {
      out.install = install(home, { pluginRoot, target: 'workspace', exec, ref, secondOpinion });
    } catch (err) {
      out.errors.push(`The harness was not installed at the root of the workspace: ${firstLine(err.message)}`);
      return out;
    }
    out.ignore = ignored ? 'present' : 'added';
  }

  // 2. The slice worktrees, moved under worktrees/<repo>/.
  for (const tree of legacyWorktrees(home, { exec, all: true })) {
    if (tree.kind !== 'slice') {
      out.left.push({ repo: tree.repo, name: tree.name, path: tree.path, reason: tree.kind === 'merge'
        ? 'it is a rebase worktree of /merge-order: finish the rebase there, then remove it with git worktree remove (a new one opens under worktrees/<repo>/merge-<S-nn>)'
        : 'its name is not a slice ID, so it is not a Recade slice worktree (a worktree of Claude Code itself, or one made by hand)' });
      continue;
    }
    const main = join(home, 'repos', tree.repo);
    const to = worktreePath(home, tree.repo, tree.name);
    const move = { repo: tree.repo, slice: tree.name, from: tree.path, to, status: dryRun ? 'would move' : 'moved' };
    const refuse = (reason) => out.moves.push({ ...move, status: 'refused', reason });
    const listed = (listWorktrees(exec, main) ?? []).find((t) => t.path === tree.path);
    const locked = exec(['git', 'worktree', 'list', '--porcelain'], { cwd: main }).stdout.split(/\n\n+/).some((b) => b.includes(`worktree ${tree.path}`) && /^locked/m.test(b));
    const status = exec(['git', 'status', '--porcelain', '--untracked-files=all'], { cwd: tree.path });
    const dirty = status.stdout.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('?? .recade/'));
    if (listed === undefined) refuse('git does not list it any more');
    else if (locked) refuse('it is locked (git worktree unlock, then run the migration again)');
    else if (status.code !== 0) refuse(`its state could not be read: ${firstLine(status.stderr) || `exit ${status.code}`}`);
    else if (dirty.length > 0) refuse(`it has uncommitted changes (${dirty.length} file${dirty.length === 1 ? '' : 's'}: ${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}${dirty.length > 3 ? ', ...' : ''}). Commit them or set them aside, then run the migration again`);
    else if (existsSync(to)) refuse(`${worktreeRel(tree.repo, tree.name)} is taken already`);
    else if (dryRun) {
      out.moves.push(move);
      moveLedger(out, home, tree, tree.path, dryRun);
    } else {
      mkdirSync(join(home, WORKTREES_DIR, tree.repo), { recursive: true });
      const r = exec(['git', 'worktree', 'move', tree.path, to], { cwd: main });
      if (r.code !== 0) refuse(`git worktree move failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
      else {
        out.moves.push(move);
        moveLedger(out, home, tree, to, dryRun);
      }
    }
  }
  if (out.left.length > 0) out.notes.push('A worktree left in place is not a slice worktree: the migration never moves it. Remove it by hand when it is no longer needed.');
  if (out.ledgers.some((l) => l.status === 'kept')) out.notes.push('A slice has a ledger in the workspace already and another one in its old worktree: the workspace one is kept, untouched. Compare the two, and copy what the old one has by hand before /slice resumes.');
  if (out.moves.some((m) => m.status !== 'refused')) out.notes.push('A moved worktree keeps its installed dependencies. A tool that wrote the old absolute path into them (a generated client, a virtual environment) needs its install command again in the new folder.');

  // 3. The old harness copies of each code repository, removed where they are exactly Recade's.
  const version = pluginVersion(pluginRoot);
  for (const repo of names) {
    const dir = join(home, 'repos', repo);
    if (!existsSync(join(dir, '.git'))) continue;
    const record = readInstallRecord(dir);
    let recordChanged = false;
    for (const file of legacyCopies(dir)) {
      const why = changedBy(dir, file, pluginRoot, adopt);
      if (why !== null) {
        out.kept.push({ repo, file, reason: why, carried: carry(home, dir, file, dryRun) });
        continue;
      }
      out.removed.push({ repo, file, status: dryRun ? 'would remove' : 'removed' });
      if (dryRun) continue;
      rmSync(join(dir, file));
      dropEmpty(resolve(join(dir, file), '..'), join(dir, '.claude'));
      if (record[file] !== undefined) {
        delete record[file];
        recordChanged = true;
      }
    }
    // The pointer takes the place of the old /slice once that one is removed (or was never there). The team's copy stays.
    for (const name of POINTER_COMMANDS) {
      const file = `.claude/commands/${name}.md`;
      const gone = !existsSync(join(dir, file)) || out.removed.some((r) => r.repo === repo && r.file === file);
      // Only a repository whose harness was installed gets the pointer: the install writes it in the others.
      if (!gone || !existsSync(join(dir, LAUNCHER))) continue;
      out.pointers.push({ repo, file, status: dryRun ? 'would write' : 'written' });
      if (dryRun) continue;
      const pointer = `${genericOf(readFileSync(join(pluginRoot, 'harness', 'pointer', `${name}.md`), 'utf8'), version)}\n${SPEC_LINE}\n`;
      if (adopt) writeOwnFile(dir, file, pointer, { keepEdits: true });
      else {
        mkdirSync(join(dir, '.claude', 'commands'), { recursive: true });
        writeFileSync(join(dir, file), pointer);
      }
    }
    if (recordChanged && existsSync(join(dir, INSTALL_RECORD))) {
      writeFileSync(join(dir, INSTALL_RECORD), `${JSON.stringify({ version, files: record }, null, 2)}\n`);
    }
  }
  if (out.kept.some((k) => k.carried === null || k.carried.startsWith('not carried'))) out.notes.push('A kept file was changed by the team. Its own text now belongs in the copy of the workspace: add it there with recade harness specialise agent|command <name> --file <path> --target workspace, then delete the old copy by hand.');
  if (!dryRun && out.kept.some((k) => k.carried !== null && !k.carried.startsWith('not carried'))) out.notes.push('The text of the team below the line of a kept file is in the copy of the workspace now. The old copy stays in the code repository: check the workspace copy, then delete the old one by hand.');
  if (!dryRun && out.removed.length > 0) out.notes.push('The removed files are deletions in each code repository: commit them there (git add the paths, then commit), as /recade:harness does.');
  return out;
}

/** The text the CLI prints for a migration. */
export function formatMigrate(r) {
  const lines = [r.dryRun ? 'Dry run: nothing was changed.' : 'Migration to the workspace root.'];
  if (r.install !== null) {
    if (r.install.dryRun) lines.push(`Harness at the root of the workspace: would install it${r.install.missing.length > 0 ? ` (${r.install.missing.length} command and agent files are missing there)` : ''}.`);
    else {
      const count = (s) => r.install.written.filter((w) => w.status === s).length;
      lines.push(`Harness at the root of the workspace: ${count('created')} created, ${count('updated')} updated, ${count('unchanged')} unchanged, ${count('kept')} kept.`);
    }
  }
  lines.push(`.gitignore of the workspace: ${r.ignore === 'present' ? `${WORKTREES_IGNORE} already there` : `${WORKTREES_IGNORE} ${r.ignore === 'added' ? 'added' : 'would be added'}`}.`);
  for (const m of r.moves) {
    lines.push(m.status === 'refused'
      ? `refused     ${m.repo} ${m.slice}: ${m.from} stays where it is: ${m.reason}.`
      : `${m.status.padEnd(11)} ${m.repo} ${m.slice}: ${m.from} -> ${m.to}`);
  }
  for (const x of r.left) lines.push(`left        ${x.repo} ${x.name}: ${x.path} stays where it is: ${x.reason}.`);
  for (const l of r.ledgers) lines.push(`${l.status.padEnd(11)} ${l.repo} ${l.slice} ledger: ${l.from} -> ${l.to}${l.reason ? ` (${l.reason})` : ''}`);
  for (const x of r.removed) lines.push(`${x.status.padEnd(11)} ${x.repo} ${x.file}`);
  for (const x of r.pointers) lines.push(`${x.status.padEnd(11)} ${x.repo} ${x.file} (the pointer to the workspace)`);
  for (const x of r.kept) lines.push(`kept        ${x.repo} ${x.file}: ${x.reason}${x.carried ? `; the text of the team: ${x.carried}` : ''}.`);
  if (r.moves.length === 0 && r.removed.length === 0 && r.pointers.length === 0 && r.kept.length === 0 && r.left.length === 0 && r.ledgers.length === 0) lines.push('Nothing of the old layout is left.');
  for (const n of r.notes) lines.push(n);
  for (const e of r.errors) lines.push(`error: ${e}`);
  return `${lines.join('\n')}\n`;
}
