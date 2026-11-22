import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from '../state.js';
import { forgeOf } from '../project/state.js';
import { checkSlices, sliceRepoOrder } from '../project/slices.js';
import { registryNames } from '../project/touches.js';
import { dodState } from './board.js';
import { findMerge, localMerges, mergeCommand, reviewPath, revParse } from './localforge.js';
import { defaultExec } from './stamps.js';

/**
 * The owner's merge of a slice on the local forge (docs/design.md, section 6.8). No agent merges: `recade slices merge`
 * is a main-session command (the guard refuses it to every agent), the command files run it only after the owner said
 * yes in the session, and the owner may run the printed git commands in a terminal instead.
 *
 * The merge goes into the main checkout of each code repository of the slice, `repos/<name>/`, on its default branch,
 * in the merge order of the slice, with `git merge --no-ff` so that the merge commit proves it. It refuses: a project on
 * GitHub, a slice that is not `ready-to-merge`, a Definition of Done not ticked, no local review request, a checkout that
 * is not on its default branch or has tracked changes, a branch that is missing. A repository already merged is skipped,
 * so a run stopped by a conflict goes on where it stopped. A conflict aborts that merge and stops: the earlier
 * repositories stay merged, and `/merge-order` brings the branch up to date.
 */

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SLICE_ID = /^S-\d{2}[a-z]?$/;
const firstLine = (text) => String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';

function call(exec, cmd, cwd) {
  try {
    const r = exec(cmd, { cwd });
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
  }
}

/**
 * What the merge of a slice would do, read only.
 * @param {string} root the workspace (or a legacy project)
 * @param {string} id S-nn
 * @param {{exec?: Function}} [options]
 * `errors` stop even the dry run (a project on GitHub, no sheet, a missing checkout); `waits` are what must be true before
 * the merge runs (the status, the ticked DoD, the review request, a clean checkout on its default branch): the dry run
 * still prints the commands with them.
 * @returns {{errors: string[], waits: string[], review: string, steps: {repo: string|null, dir: string, branch: string, base: string, command: string, merged: string|null}[]}}
 */
export function planLocalMerge(root, id, { exec = defaultExec } = {}) {
  const out = { errors: [], waits: [], review: reviewPath(id), steps: [] };
  if (!SLICE_ID.test(id)) {
    out.errors.push(`${id} is not a slice ID. Use S-nn.`);
    return out;
  }
  const state = loadState(root) ?? {};
  if (forgeOf(state) !== 'local') {
    out.errors.push('This project works on GitHub (forge: github): the owner merges the pull requests on GitHub, and this command does nothing.');
    return out;
  }
  const row = checkSlices(root).status.find((s) => s.id === id);
  if (row === undefined) {
    out.errors.push(`${id} has no sheet in slices/.`);
    return out;
  }
  if (row.status !== 'ready-to-merge') out.waits.push(`${id} is ${row.status}, not ready-to-merge: /slice ${id} takes it there first.`);
  const dod = dodState(readFileSync(join(root, row.file), 'utf8'));
  if (!dod.met) out.waits.push(`The Definition of Done of ${id} is not ticked (${dod.open} line${dod.open === 1 ? '' : 's'} open).`);
  if (!existsSync(join(root, out.review))) out.waits.push(`${id} has no local review request: ${out.review} is missing.`);
  if (!BRANCH.test(row.branch)) out.errors.push(`The sheet of ${id} names no usable branch.`);
  const registry = registryNames(state);
  const names = sliceRepoOrder(row, registry);
  const defaults = new Map((Array.isArray(state.repos) ? state.repos : []).filter((e) => e !== null && typeof e === 'object').map((e) => [e.name, e.default_branch]));
  const places = names.length > 0 ? names.map((name) => ({ repo: name, dir: join(root, 'repos', name), base: defaults.get(name) })) : [{ repo: null, dir: root, base: 'main' }];
  if (out.errors.length > 0) return out;
  for (const place of places) {
    const label = place.repo ?? 'the project';
    const base = typeof place.base === 'string' && BRANCH.test(place.base) ? place.base : 'main';
    if (!existsSync(join(place.dir, '.git'))) {
      out.errors.push(`${label}: ${place.dir} is not a git repository. Run: recade repo sync`);
      continue;
    }
    const tip = revParse(exec, place.dir, `refs/heads/${row.branch}`);
    let merged = null;
    try {
      merged = findMerge(localMerges(exec, place.dir, base), { tip, recorded: row.merged?.[place.repo] ?? null })?.oid ?? null;
    } catch (err) {
      out.errors.push(`${label}: ${firstLine(err.message)}`);
      continue;
    }
    if (merged === null) {
      if (tip === null) out.errors.push(`${label}: the branch ${row.branch} is missing.`);
      const head = call(exec, ['git', 'symbolic-ref', '--short', '-q', 'HEAD'], place.dir);
      if (head.stdout.trim() !== base) out.waits.push(`${label}: the main checkout is on ${head.stdout.trim() || 'a detached HEAD'}, not on ${base}. Switch it to ${base} first.`);
      const dirty = call(exec, ['git', 'status', '--porcelain', '--untracked-files=no'], place.dir);
      if (dirty.code !== 0 || dirty.stdout.trim() !== '') out.waits.push(`${label}: the main checkout has uncommitted changes. Commit them or set them aside first.`);
    }
    out.steps.push({ repo: place.repo, dir: place.dir, branch: row.branch, base, command: mergeCommand(place.dir, row.branch), merged });
  }
  return out;
}

/**
 * Merge a slice, after the owner's yes. Runs `planLocalMerge` again, then `git merge --no-ff --no-edit` in each checkout
 * that is not merged yet, in order. A failed merge is aborted and stops the run.
 * @returns {ReturnType<typeof planLocalMerge> & {done: string[]}}
 */
export function runLocalMerge(root, id, { exec = defaultExec } = {}) {
  const plan = planLocalMerge(root, id, { exec });
  const result = { ...plan, errors: [...plan.errors, ...plan.waits], done: [] };
  if (result.errors.length > 0) return result;
  for (const step of plan.steps) {
    const label = step.repo ?? 'the project';
    if (step.merged !== null) continue;
    const r = call(exec, ['git', '-C', step.dir, 'merge', '--no-ff', '--no-edit', step.branch], step.dir);
    if (r.code !== 0) {
      call(exec, ['git', '-C', step.dir, 'merge', '--abort'], step.dir);
      result.errors.push(`${label}: git merge failed and was aborted: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}. Run /merge-order to bring the branch up to date, then merge again.`);
      break;
    }
    step.merged = revParse(exec, step.dir, `refs/heads/${step.base}`);
    result.done.push(label);
  }
  return result;
}
