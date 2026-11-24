import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from '../state.js';
import { forgeOf } from '../project/state.js';
import { listSliceBranches } from './conflicts.js';
import { findMerge, localMerges, mergedBranches, reviewPath, revParse } from './localforge.js';
import { checkSlices, globsOverlap, sliceRepoOrder } from '../project/slices.js';
import { parseTouch, registryNames } from '../project/touches.js';
import { defaultExec } from './stamps.js';

/**
 * @typedef {(cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}} Exec
 * @typedef {{pr: number, reason: string, waiting: boolean, repo?: string, slice?: string|null}} Placed `waiting` is true for a PR that cannot be merged yet. `repo` and `slice` are set across code repositories.
 */

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SLICE_BRANCH = /^slice\/(s-\d{2})([a-z]?)(?:-|$)/i;
/** Statuses of a dependency that is merged, or is waiting for the owner's merge with no open PR left (so merged). */
const MERGED = ['done', 'ready-to-merge'];

const firstLine = (text) => String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `slice/s-03a-name` is the slice `S-03a`. Null for any other branch. */
function sliceOf(branch) {
  const m = SLICE_BRANCH.exec(String(branch ?? ''));
  return m === null ? null : `S-${m[1].slice(2)}${m[2].toLowerCase()}`;
}

/** The open pull requests, as `gh pr list` prints them. `files` is capped by GitHub at about 100 files for a PR, so the shared-file count of a very large PR is approximate. Throws on a gh failure or an answer that is not JSON. */
function listPulls(repo, base, exec) {
  let r;
  try {
    r = exec(['gh', 'pr', 'list', '--state', 'open', '--base', base, '--limit', '200', '--json', 'number,title,headRefName,isDraft,additions,deletions,files'], { cwd: repo });
  } catch (err) {
    throw new Error(`gh pr list failed: ${firstLine(err?.message ?? err)}`);
  }
  if (r.code !== 0) throw new Error(`gh pr list failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new Error('gh pr list did not print JSON.');
  }
  if (!Array.isArray(data)) throw new Error('gh pr list did not print a list.');
  return data.map((p) => {
    const files = Array.isArray(p.files) ? p.files.map((f) => String(f?.path ?? '')).filter((f) => f !== '') : [];
    const lines = Number(p.additions ?? 0) + Number(p.deletions ?? 0);
    return {
      number: Number(p.number), title: String(p.title ?? ''), branch: String(p.headRefName ?? ''), draft: p.isDraft === true,
      files: new Set(files), lines: Number.isFinite(lines) ? lines : 0, slice: sliceOf(p.headRefName),
    };
  });
}

/**
 * The open pull requests of the local forge (docs/design.md, section 6.8): each local slice branch that has a review
 * request in the workspace (`slices/reviews/<S-nn>.md` of `root`) and is not merged into `base` yet. Same shape as
 * `listPulls`, with `number` a position in the sorted list and `local: true`. Files and lines come from
 * `git diff <base>...<branch>`. Only git runs.
 */
function listLocalPulls(root, repo, base, exec) {
  const merges = localMerges(exec, repo, base);
  const out = [];
  for (const branch of listSliceBranches(repo, exec)) {
    const slice = sliceOf(branch);
    const tip = revParse(exec, repo, `refs/heads/${branch}`);
    if (slice === null || tip === null || !BRANCH.test(branch) || findMerge(merges, { tip }) !== null) continue;
    if (!existsSync(join(root, reviewPath(slice)))) continue;
    const names = exec(['git', '-c', 'core.quotepath=off', 'diff', '--name-only', `${base}...${branch}`, '--'], { cwd: repo });
    const stat = exec(['git', 'diff', '--numstat', `${base}...${branch}`, '--'], { cwd: repo });
    if (names.code !== 0 || stat.code !== 0) throw new Error(`git diff ${base}...${branch} failed: ${firstLine(names.stderr || stat.stderr)}`);
    const lines = stat.stdout.split('\n').map((l) => l.split('\t')).reduce((n, [a, d]) => n + (Number(a) || 0) + (Number(d) || 0), 0);
    out.push({ number: out.length + 1, title: slice, branch, draft: false, files: new Set(names.stdout.split('\n').filter((f) => f !== '')), lines, slice, local: true });
  }
  return out;
}

/**
 * The slices whose branch is merged into `base` on the local forge, by the one rule of the board and the retro
 * (`mergedBranches`): a merge commit has the tip of the branch as a parent, or the `merged:` record of its sheet names one.
 * `rows` are the sheets, `name` the repository (absent for a project with no registry).
 */
function mergedLocalSlices(repo, base, exec, rows = [], name = undefined) {
  const entries = [
    ...rows.map((r) => ({ branch: r.branch, recorded: (name === undefined ? Object.values(r.merged ?? {})[0] : r.merged?.[name]) ?? null })),
    ...listSliceBranches(repo, exec).map((branch) => ({ branch })),
  ];
  return new Set(mergedBranches(exec, repo, base, entries).map((m) => sliceOf(m.branch)).filter((id) => id !== null));
}

/** The hotspots of the project. With `name`, only the ones of that repository, as globs with no prefix. */
function hotspotsOf(repo, name) {
  try {
    const list = loadState(repo)?.hotspots;
    const all = Array.isArray(list) ? list.filter((h) => typeof h === 'string' && h.trim() !== '').map((h) => h.trim()) : [];
    if (name === undefined) return all;
    return all.map((h) => parseTouch(h)).filter((t) => t.repo === name || t.repo === null).map((t) => t.glob);
  } catch {
    return [];
  }
}

/** The slices that have a merged PR into `base`. Throws on a gh failure. */
function mergedSlices(repo, base, exec) {
  let r;
  try {
    r = exec(['gh', 'pr', 'list', '--state', 'merged', '--base', base, '--limit', '200', '--json', 'headRefName,mergedAt'], { cwd: repo });
  } catch (err) {
    throw new Error(`gh pr list failed: ${firstLine(err?.message ?? err)}`);
  }
  if (r.code !== 0) throw new Error(`gh pr list failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new Error('gh pr list did not print JSON.');
  }
  if (!Array.isArray(data)) throw new Error('gh pr list did not print a list.');
  return new Set(data.filter((p) => p?.mergedAt).map((p) => sliceOf(p.headRefName)).filter((id) => id !== null));
}

const sample = (names, max = 3) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);

/**
 * The open pull requests in the order the owner should merge them (spec 10.10): the smallest and the most
 * independent first, which means the fewest files shared with the PRs not merged yet, then the fewest files, then
 * the fewest changed lines. A PR comes after the PR of every slice it depends on. A PR that cannot be merged yet goes
 * last, with the reason: a draft, a dependency whose slice is not merged and has no open PR, a PR that waits for such
 * a PR, a dependency cycle. A dependency counts as merged when its slice is `done`, or `ready-to-merge` with no open PR and a
 * merged PR for its branch (a second `gh pr list --state merged`; a PR closed unmerged does not count). Reads the sheets of `repo`, runs one `gh pr list`.
 * In a workspace with a registry (spec 6.13) it runs that for each code repository, in `repos/<name>/` and on the default
 * branch of that repository (or `base`), then puts the pull requests of one slice in the merge order of the slice:
 * `merge_order:` of its sheet, else the order of the prefixes of its `touches:`. Each entry then has `repo` and `slice`.
 * A pull request waits when the one of the same slice in an earlier repository waits.
 * @param {string} repo the project folder
 * @param {{exec?: Exec, base?: string}} [options]
 * @returns {Placed[]}
 */
export function mergeOrder(repo, { exec = defaultExec, base } = {}) {
  if (base !== undefined && !BRANCH.test(base)) throw new Error(`Invalid base branch: ${JSON.stringify(base)}.`);
  const state = loadState(repo) ?? {};
  // The local forge reads the slice branches and their review requests from git: no gh call (docs/design.md, section 6.8).
  const local = forgeOf(state) === 'local';
  const registry = registryNames(state);
  if (registry.length === 0) return orderPulls(repo, repo, { exec, base: base ?? 'main', local }).map(({ slice, order, ...placed }) => placed);
  return orderAcrossRepos(repo, registry, { exec, base, local });
}

/** Open pull requests of one folder in order: `dir` is where gh runs, `root` the project folder that holds the sheets. */
function orderPulls(root, dir, { exec, base, name, registry = [], local = false }) {
  const pulls = local ? listLocalPulls(root, dir, base, exec) : listPulls(dir, base, exec);
  /** How a pull request is named in a reason: its number, or its branch on the local forge. */
  const ref = (p) => (local ? p.branch : `#${p.number}`);
  const refOf = (n) => ref(pulls.find((p) => p.number === n));
  const rows = new Map(checkSlices(root).status.map((r) => [r.id, r]));
  const bySlice = new Map(pulls.filter((p) => p.slice !== null).map((p) => [p.slice, p]));
  const hotspots = hotspotsOf(root, name);
  /** A dependency that does not touch this repository has no pull request here and cannot hold one back. */
  const touchesHere = (id) => name === undefined || !rows.has(id) || sliceRepoOrder(rows.get(id), registry).includes(name);
  /** @type {Set<string>|undefined} The slices with a merged PR, asked for only when a dependency needs it. */
  let merged;
  /** Reasons a PR waits, keyed by number. */
  const waiting = new Map();
  /** The PRs a PR must come after. */
  const after = new Map();
  for (const p of pulls) {
    after.set(p.number, []);
    if (p.draft) {
      waiting.set(p.number, 'draft, not ready for review');
      continue;
    }
    for (const dep of (rows.get(p.slice)?.depends_on ?? []).filter(touchesHere)) {
      const open = bySlice.get(dep);
      if (open !== undefined) {
        after.get(p.number).push(open);
        continue;
      }
      const status = rows.get(dep)?.status;
      if (status === undefined) waiting.set(p.number, `waits for ${dep}, which has no sheet`);
      else if (status === 'ready-to-merge') {
        // No open PR is not proof of a merge: a PR closed unmerged looks the same. Ask for the merged PRs, once.
        merged ??= local ? mergedLocalSlices(dir, base, exec, [...rows.values()], name) : mergedSlices(dir, base, exec);
        if (!merged.has(dep)) waiting.set(p.number, `waits for ${dep} (ready-to-merge), which has no open or merged pull request`);
      } else if (status !== 'done') waiting.set(p.number, `waits for ${dep} (${status}), which is not merged and has no open pull request`);
      if (waiting.has(p.number)) break;
    }
  }
  // A PR that comes after a waiting PR waits too.
  for (let changed = true; changed;) {
    changed = false;
    for (const p of pulls) {
      if (waiting.has(p.number)) continue;
      const blocker = after.get(p.number).find((q) => waiting.has(q.number));
      if (blocker !== undefined) {
        waiting.set(p.number, `waits for ${ref(blocker)} (${blocker.slice}), which waits`);
        changed = true;
      }
    }
  }

  const unplaced = new Set(pulls.map((p) => p.number));
  const placed = [];
  /** @type {Placed[]} */
  const out = [];
  const byNumber = new Map(pulls.map((p) => [p.number, p]));
  const sharedWith = (p, among) => {
    const files = new Set();
    const prs = [];
    for (const q of among) {
      if (q.number === p.number) continue;
      const common = [...p.files].filter((f) => q.files.has(f));
      if (common.length > 0) {
        prs.push(q.number);
        for (const f of common) files.add(f);
      }
    }
    return { files: [...files].sort(), prs };
  };
  const everyone = pulls.slice();
  for (;;) {
    const ready = pulls.filter((p) => unplaced.has(p.number) && !waiting.has(p.number) && after.get(p.number).every((q) => !unplaced.has(q.number)));
    if (ready.length === 0) break;
    const remaining = [...unplaced].map((n) => byNumber.get(n));
    const scored = ready.map((p) => ({ p, shared: sharedWith(p, remaining) }));
    scored.sort((a, b) => a.shared.files.length - b.shared.files.length || a.p.files.size - b.p.files.size || a.p.lines - b.p.lines || a.p.number - b.p.number);
    const { p, shared } = scored[0];
    const parts = [];
    // A pull request of another contributor, not of a slice: ordered with the others by the files they share, and never
    // marked done or closed by Recade.
    if (p.slice === null) parts.push('not a slice');
    const deps = after.get(p.number);
    if (deps.length > 0) parts.push(`after ${deps.map((q) => `${ref(q)} (${q.slice})`).join(', ')}, which it depends on`);
    parts.push(plural(p.files.size, 'file'));
    if (shared.files.length > 0) {
      parts.push(`shares ${sample(shared.files)} with ${shared.prs.map(refOf).join(', ')}, which then rebase once`);
    } else if (sharedWith(p, everyone).files.length === 0) {
      parts.push('shares no file with the others');
    } else {
      parts.push(`no file left in common with the others once ${placed.map(ref).slice(-3).join(', ')} merged`);
    }
    const hot = hotspots.find((h) => [...p.files].some((f) => globsOverlap(f, h)));
    if (hot !== undefined) parts.push(`touches the hotspot "${hot}"`);
    out.push({ pr: local ? null : p.number, ...(local ? { branch: p.branch, review: reviewPath(p.slice) } : {}), reason: parts.join('; '), waiting: false, slice: p.slice, order: p.number });
    unplaced.delete(p.number);
    placed.push(p);
  }
  // What is left waits: with a reason, or caught in a cycle. Ordered by number.
  for (const n of [...unplaced].sort((a, b) => a - b)) {
    const reason = waiting.get(n) ?? `dependency cycle with ${after.get(n).filter((q) => unplaced.has(q.number)).map(ref).join(', ')}`;
    const p = byNumber.get(n);
    out.push({ pr: local ? null : n, ...(local ? { branch: p.branch, review: reviewPath(p.slice) } : {}), reason, waiting: true, slice: p.slice, order: n });
  }
  return out.map(({ order, ...placed }) => (local ? { ...placed, order } : placed));
}

/** The entries of the registry whose names make a folder under `repos/`. */
function registryEntries(root) {
  const repos = loadState(root)?.repos;
  return (Array.isArray(repos) ? repos : []).filter((r) => r !== null && typeof r === 'object' && typeof r.name === 'string');
}

/** Order the pull requests of every code repository, then of each slice across them. */
function orderAcrossRepos(root, registry, { exec, base, local = false }) {
  const defaults = new Map(registryEntries(root).map((e) => [e.name, e.default_branch]));
  const rows = new Map(checkSlices(root).status.map((r) => [r.id, r]));
  /** @type {Placed[]} */
  const ready = [];
  /** @type {Placed[]} */
  const waiting = [];
  for (const name of registry) {
    const own = base ?? (typeof defaults.get(name) === 'string' && BRANCH.test(defaults.get(name)) ? defaults.get(name) : 'main');
    for (const placed of orderPulls(root, join(root, 'repos', name), { exec, base: own, name, registry, local })) {
      (placed.waiting ? waiting : ready).push({ ...placed, repo: name });
    }
  }
  const tag = (p) => (local ? `${p.repo} ${p.branch}` : `${p.repo} #${p.pr}`);
  /** The pull requests of the slice of `p` in the repositories before the one of `p`, nearest first. */
  const before = (p) => {
    if (p.slice === null || !rows.has(p.slice)) return [];
    const order = sliceRepoOrder(rows.get(p.slice), registry);
    const at = order.indexOf(p.repo);
    return order.slice(0, at === -1 ? 0 : at).reverse().map((name) => [...ready, ...waiting].find((q) => q.slice === p.slice && q.repo === name)).filter(Boolean);
  };
  // A pull request waits when the one that must merge before it, in another repository, waits.
  for (let changed = true; changed;) {
    changed = false;
    for (const p of [...ready]) {
      const blocker = before(p).find((q) => q.waiting);
      if (blocker !== undefined) {
        ready.splice(ready.indexOf(p), 1);
        waiting.push({ ...p, waiting: true, reason: `waits for ${tag(blocker)} (${blocker.slice}), which merges first in the repository order, and waits` });
        changed = true;
      }
    }
  }
  // The others go after the one of their slice in the repository before: move a pull request that came too early.
  for (let moved = true, guard = 0; moved && guard <= ready.length * ready.length; guard++) {
    moved = false;
    for (const p of [...ready]) {
      const first = before(p).find((q) => !q.waiting && ready.indexOf(q) > ready.indexOf(p));
      if (first === undefined) continue;
      ready.splice(ready.indexOf(p), 1);
      ready.splice(ready.indexOf(first) + 1, 0, p);
      moved = true;
    }
  }
  for (const p of ready) {
    const earlier = before(p).filter((q) => !q.waiting);
    if (earlier.length > 0) p.reason += `; after ${earlier.map(tag).join(', ')}, the repositories of ${p.slice} that merge first`;
  }
  waiting.sort((a, b) => registry.indexOf(a.repo) - registry.indexOf(b.repo) || (local ? a.order - b.order : a.pr - b.pr));
  return [...ready, ...waiting].map(({ order, ...placed }) => placed);
}
