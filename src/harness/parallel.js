import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { frontMatterLength } from '../frontmatter-lines.js';
import { loadState } from '../state.js';
import { checkSlices } from '../project/slices.js';
import { registryNames, reposOf, touchProblems, touchRepo, touchesOverlap } from '../project/touches.js';
import { worktreeRel } from '../workspace/worktrees.js';

/**
 * @typedef {{repo: string, path: string, branch: string}} Worktree
 * @typedef {{slice: string, reason: string, worktrees: Worktree[]}} Pick
 * @typedef {{slice: string, reason: string}} Deferred
 */

export const DEFAULT_MAX = 5;
/** Aim for at least this many slices in a batch, when the scopes allow it. */
export const WANTED = 3;

const SIZE_RANK = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };
const sizeRank = (size) => SIZE_RANK[String(size ?? '').trim().toUpperCase()] ?? 5;
const SEARCH_LIMIT = 20000;

const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);

/** The `touches:` globs and the `branch:` of a sheet, read from its front matter. An unreadable sheet touches nothing. */
function readFront(root, file) {
  try {
    const raw = readFileSync(join(root, file), 'utf8').split('\n');
    const end = frontMatterLength(raw);
    if (end === 0) return { touches: [], branch: null };
    const front = parse(raw.slice(1, end - 1).join('\n'));
    if (front === null || typeof front !== 'object') return { touches: [], branch: null };
    return { touches: asList(front.touches), branch: typeof front.branch === 'string' && front.branch.trim() !== '' ? front.branch.trim() : null };
  } catch {
    return { touches: [], branch: null };
  }
}

/** The hotspots and the repository names of `recade/state.yaml`. */
function readProject(root) {
  try {
    const state = loadState(root);
    return { hotspots: asList(state?.hotspots), registry: registryNames(state) };
  } catch {
    return { hotspots: [], registry: [] };
  }
}

/** The worktrees of a slice: one per repository its touches name, all on the same branch (spec 6.5). */
function worktreesOf(id, front, registry) {
  const branch = front.branch ?? `slice/${id.toLowerCase()}`;
  // only registered repositories get a worktree, whatever the touches say
  return reposOf(front.touches, registry).filter((repo) => registry.includes(repo)).map((repo) => ({ repo, path: worktreeRel(repo, id), branch }));
}

/** Do two slices share a hotspot repository? A hotspot whose repository is unknown clashes with every other one. */
function hotClash(a, b) {
  return a.hots.some((x) => b.hots.some((y) => x.repo === null || y.repo === null || x.repo === y.repo));
}

/** Best set of mutually compatible candidates, at most `max`, found by a bounded depth-first search. */
function widest(candidates, max, compatible) {
  let best = [];
  let visited = 0;
  const walk = (from, chosen) => {
    if (chosen.length > best.length) best = [...chosen];
    if (best.length >= max) return;
    for (let i = from; i < candidates.length; i++) {
      if (++visited > SEARCH_LIMIT) return;
      if (chosen.length + (candidates.length - i) <= best.length) return;
      if (chosen.every((c) => compatible(c, candidates[i]))) {
        chosen.push(candidates[i]);
        walk(i + 1, chosen);
        chosen.pop();
        if (best.length >= max) return;
      }
    }
  };
  walk(0, []);
  return best;
}

/**
 * The slices to start now, with the ones that could start but wait. A slice is a candidate when it is `todo`
 * and every slice it depends on is `done`. The slices already under way (any state but `todo` and `done`) keep
 * their scope: a candidate that overlaps one waits. The picks have pairwise disjoint `touches:` scopes, and at
 * most one of them (counting the ones under way) touches a hotspot of `recade/state.yaml`. The smallest slice
 * comes first. The batch holds up to `max` slices, and the search tries a wider combination when the smallest-first
 * pick leaves fewer than three.
 * @param {string} root the project folder
 * @param {{max?: number}} [options]
 * @returns {{picked: Pick[], deferred: Deferred[]}}
 */
export function explainParallel(root, { max = DEFAULT_MAX } = {}) {
  if (!Number.isInteger(max) || max < 1) throw new Error(`Invalid max: ${max}. Use a whole number of 1 or more.`);
  const rows = checkSlices(root).status;
  const { hotspots, registry } = readProject(root);
  const scopesOverlap = (a, b) => a.some((x) => b.some((y) => touchesOverlap(x, y, registry)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const info = (r) => {
    const front = readFront(root, r.file);
    const { touches } = front;
    const hots = hotspots.filter((h) => touches.some((t) => touchesOverlap(t, h, registry))).map((text) => ({ text, repo: touchRepo(text, registry) }));
    return { row: r, front, touches, hots, hot: hots[0]?.text };
  };
  const underWay = rows.filter((r) => r.status !== 'todo' && r.status !== 'done').map(info);
  const deferred = [];
  const candidates = [];
  for (const r of rows.filter((x) => x.status === 'todo')) {
    const waiting = r.depends_on.filter((d) => byId.get(d)?.status !== 'done');
    if (waiting.length > 0) continue; // not a candidate yet: /status shows what it waits for
    const c = info(r);
    if (c.touches.length === 0 && r.lane !== 'no-code') {
      deferred.push({ slice: r.id, reason: 'its sheet lists no `touches:`, so its scope is unknown. Fill it in first' });
      continue;
    }
    const problem = touchProblems(c.touches, registry)[0];
    if (problem) {
      deferred.push({ slice: r.id, reason: `its \`touches:\` has an error (${problem.rule}): ${problem.message}` });
      continue;
    }
    const clash = underWay.find((u) => scopesOverlap(c.touches, u.touches));
    if (clash) {
      deferred.push({ slice: r.id, reason: `its scope overlaps ${clash.row.id}, which is ${clash.row.status}` });
      continue;
    }
    const hotRival = c.hot !== undefined ? underWay.find((u) => hotClash(c, u)) : undefined;
    if (hotRival) {
      deferred.push({ slice: r.id, reason: `it touches the hotspot "${c.hot}" and ${hotRival.row.id} is already on a hotspot` });
      continue;
    }
    candidates.push(c);
  }
  candidates.sort((a, b) => sizeRank(a.row.size) - sizeRank(b.row.size) || a.row.id.localeCompare(b.row.id));
  const compatible = (a, b) => !scopesOverlap(a.touches, b.touches) && !hotClash(a, b);
  let chosen = [];
  for (const c of candidates) {
    if (chosen.length < max && chosen.every((p) => compatible(p, c))) chosen.push(c);
  }
  if (chosen.length < Math.min(WANTED, max)) {
    const wider = widest(candidates, max, compatible);
    if (wider.length > chosen.length) chosen = wider;
  }
  const picked = chosen.map((c) => ({
    slice: c.row.id,
    worktrees: worktreesOf(c.row.id, c.front, registry),
    reason: [
      c.row.size ? `size ${c.row.size}` : 'size not set',
      'dependencies done',
      c.touches.length === 0 ? 'no code to write' : 'scope disjoint from the others',
      c.hot !== undefined ? `the only slice on the hotspot "${c.hot}"` : null,
    ].filter(Boolean).join(', '),
  }));
  const taken = new Set(chosen.map((c) => c.row.id));
  for (const c of candidates) {
    if (taken.has(c.row.id)) continue;
    const rival = chosen.find((p) => scopesOverlap(p.touches, c.touches));
    const hotRival = c.hot !== undefined ? chosen.find((p) => hotClash(c, p)) : undefined;
    let reason = `the batch is full (${max})`;
    if (rival) reason = `its scope overlaps ${rival.row.id}`;
    else if (hotRival) reason = `it touches the hotspot "${c.hot}" and ${hotRival.row.id} is already on a hotspot`;
    deferred.push({ slice: c.row.id, reason });
  }
  deferred.sort((a, b) => a.slice.localeCompare(b.slice));
  return { picked, deferred };
}

/**
 * The slices to start now (spec 10.10). See `explainParallel` for the rules.
 * @param {string} root
 * @param {{max?: number}} [options]
 * @returns {Pick[]}
 */
export function planParallel(root, options = {}) {
  return explainParallel(root, options).picked;
}
