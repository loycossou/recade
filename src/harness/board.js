import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { frontMatterLength } from '../frontmatter-lines.js';
import { loadState, noteFirstSliceDone } from '../state.js';
import { findPlan } from '../project/plan.js';
import { localToday } from '../project/template.js';
import { STATUSES, allowedNext, checkSlices, parseBacklog, setStatus, sliceRepoOrder, statusFromPulls, writeMerged } from '../project/slices.js';
import { REPO_NAME, registryNames } from '../project/touches.js';
import { readStack, techSheet } from './claudemd.js';
import { defaultExec } from './stamps.js';
import { listSliceBranches } from './conflicts.js';
import { epicCode, epicPlan } from '../project/github.js';
import { forgeOf, projectRoot } from '../project/state.js';
import { WORKTREES_DIR } from '../workspace/worktrees.js';
import { findMerge, localMerges, reviewPath, revParse as localRev } from './localforge.js';

/**
 * @typedef {(cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}} Exec
 * @typedef {{id: string, kind: 'slice'|'story', status: string, pr: string, board: string, target: string, action: 'move'|'keep'|'skip', reason: string}} ReconcileRow
 */

/** The only places a branch name may come from are the sheets and git. Still, a name that starts with a dash is never passed on. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const STORY_ID = /\b[A-Z][A-Z0-9]*-\d{2,3}\b/g;
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})\/issues\/([1-9]\d{0,9})$/;
const SLICE_BRANCH = /^slice\/(s-\d{2}[a-z]?)(?:-|$)/i;
/** `slice/s-03a-name` and `slice/S-03a-name` are both the slice `S-03a`. */
const sliceId = (branch) => { const id = SLICE_BRANCH.exec(branch)[1]; return `S-${id.slice(2).toLowerCase()}`; };

/** One line of text: the first line that holds something. */
const firstLine = (text) => String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';

/** Run a command; a throw becomes code 127. */
function call(exec, cmd, cwd) {
  try {
    const r = exec(cmd, { cwd });
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
  }
}

class BoardError extends Error {}

// ---------------------------------------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------------------------------------

/**
 * The status of the board that matches the status of a slice. The names are the ones of the Status field of
 * spec 10.9. The options are read back from the board, never written down as ids.
 */
const BOARD_STATUS = {
  todo: 'Backlog', design: 'In progress', spec: 'In progress', 'gate-1': 'In progress', tests: 'In progress',
  implementation: 'In progress', blocked: 'In progress', audit: 'In review', 'gate-2': 'In review',
  'ready-to-merge': 'In review', done: 'Done',
};
/** Option names that count as the same place on the board, lower case. */
const SAME_PLACE = {
  Backlog: ['backlog', 'todo', 'ready'],
  'In progress': ['in progress'],
  'In review': ['in review', 'review'],
  Done: ['done'],
};

const asArray = (data, key) => (Array.isArray(data) ? data : (Array.isArray(data?.[key]) ? data[key] : []));
const optionFor = (options, wanted) => options.find((o) => SAME_PLACE[wanted].includes(String(o.name).toLowerCase()));
const lines = (text) => text.split(/\r?\n/);

/** The text of a `## <name>` section of a sheet, outside the front matter. Empty when there is none. */
function section(text, name) {
  const all = lines(text);
  const from = frontMatterLength(all);
  const out = [];
  let inside = false;
  let fence = false;
  for (const line of all.slice(from)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      inside = heading[1].toLowerCase() === name.toLowerCase();
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

/**
 * Is the Definition of Done of a sheet met? Every line of it must be ticked: a list item `- [x]`, or a table row
 * with a `[x]` cell. A line with `[ ]` is open. A section with no tick box at all is not met.
 * @param {string} text the sheet
 * @returns {{met: boolean, ticked: number, open: number}}
 */
export function dodState(text) {
  let ticked = 0;
  let open = 0;
  for (const line of lines(section(text, 'Definition of Done'))) {
    const item = /^\s{0,3}[-*+]\s+\[([ xX])\]/.exec(line);
    const boxes = item ? [item[1]] : (/^\s*\|/.test(line) ? [...line.matchAll(/\|\s*\[([ xX])\]\s*(?=\|)/g)].map((m) => m[1]) : []);
    if (boxes.length === 0) continue;
    if (boxes.every((b) => b !== ' ')) ticked++;
    else open++;
  }
  return { met: ticked > 0 && open === 0, ticked, open };
}

/** The branch and the text of a sheet. */
function readSheet(root, file) {
  const text = readFileSync(join(root, file), 'utf8');
  const raw = lines(text);
  const end = frontMatterLength(raw);
  let branch = '';
  let merged = {};
  try {
    const front = end === 0 ? null : parse(raw.slice(1, end - 1).join('\n'));
    branch = typeof front?.branch === 'string' ? front.branch.trim() : '';
    if (front?.merged !== null && typeof front?.merged === 'object' && !Array.isArray(front.merged)) merged = front.merged;
  } catch { /* an unreadable header gives no branch */ }
  return { text, branch, merged };
}

/** The state of the checks of a pull request, from its `statusCheckRollup`: red wins over pending, pending over green. */
function checksOf(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  const state = (c) => String(c?.conclusion || c?.state || c?.status || '').toUpperCase();
  const words = rollup.map(state);
  if (words.some((w) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(w))) return 'red';
  if (words.some((w) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(w))) return 'pending';
  return 'green';
}

/**
 * The pull request of a branch: `{kind: 'merged'|'other'|'open'|'closed'|'none', number, url, sha, checks, approved, draft}`.
 * `sha` is the commit that merged it (else its head), `checks` is `green|red|pending|none`, `approved` is the review
 * decision. With `base` (the default branch of a code repository) a pull request merged into any other branch is `other`:
 * it did not reach the default branch. Throws on a gh failure. `root` is the folder gh runs in: the project, or one code
 * repository.
 */
function pullRequest(exec, root, branch, base) {
  const r = call(exec, ['gh', 'pr', 'view', branch, '--json', 'number,state,mergedAt,url,mergeCommit,headRefOid,reviewDecision,statusCheckRollup,baseRefName,isDraft'], root);
  if (r.code !== 0) {
    if (/no pull requests? found/i.test(r.stderr)) return { kind: 'none' };
    throw new BoardError(`gh pr view ${branch} failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  }
  let pr;
  try {
    pr = JSON.parse(r.stdout);
  } catch {
    throw new BoardError(`gh pr view ${branch} did not print JSON.`);
  }
  const state = String(pr.state ?? '').toUpperCase();
  const into = typeof pr.baseRefName === 'string' ? pr.baseRefName : '';
  let kind = state === 'MERGED' && pr.mergedAt ? 'merged' : (state === 'OPEN' ? 'open' : 'closed');
  if (kind === 'merged' && base !== undefined && into !== '' && into !== base) kind = 'other';
  const sha = [pr.mergeCommit?.oid, pr.headRefOid].find((v) => typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v)) ?? '';
  return {
    kind, number: pr.number, url: pr.url, sha, checks: checksOf(pr.statusCheckRollup),
    approved: String(pr.reviewDecision ?? '').toUpperCase() === 'APPROVED',
    draft: pr.isDraft === true, base: into, expected: base,
  };
}

/**
 * The pull request of a slice branch on the local forge, read from git: `merged` when a merge commit of `base` has the tip
 * of the branch as a parent (or, once the branch is gone, when `recorded`, the commit of the `merged:` record, is such a
 * merge), `open` when the branch is there with its local review request, else `none`. Same shape as `pullRequest`,
 * with `local: true` and no number. Throws BoardError when git cannot read `base`.
 */
function localPullRequest(exec, dir, branch, base, { review, recorded = null }) {
  const into = base ?? 'main';
  const tip = localRev(exec, dir, `refs/heads/${branch}`);
  let merges;
  try {
    merges = localMerges(exec, dir, into);
  } catch (err) {
    throw new BoardError(firstLine(err.message));
  }
  const merge = findMerge(merges, { tip, recorded });
  const kind = merge !== null ? 'merged' : (tip !== null && review ? 'open' : 'none');
  return {
    kind, local: true, number: undefined, url: undefined, sha: merge?.oid ?? tip ?? '', checks: 'none',
    approved: false, draft: false, base: into, expected: into,
  };
}

const LOCAL_LABEL = { merged: 'merged locally', open: 'review requested', none: 'no review request', closed: 'closed' };
const prLabel = (pr) => {
  if (pr.local) return LOCAL_LABEL[pr.kind] ?? pr.kind;
  return pr.kind === 'none' ? 'none' : `${pr.kind === 'other' ? 'merged elsewhere' : pr.kind} #${pr.number}`;
};

const tag = (p) => (p.number === undefined ? p.repo : `${p.repo} #${p.number}`);

/** One pull request, or the pull requests of a slice across its repositories, as one value for the rules of `reconcile`. */
function together(pulls) {
  if (pulls.length === 1 && pulls[0].repo === undefined) return { ...pulls[0], text: pulls[0].local ? 'the slice branch' : `PR #${pulls[0].number}`, is: 'is', label: prLabel(pulls[0]) };
  const all = pulls.every((p) => p.kind === 'merged');
  const some = pulls.some((p) => p.kind === 'merged' || p.kind === 'open');
  const kind = all ? 'merged' : (some ? 'open' : (pulls.some((p) => p.kind === 'closed' || p.kind === 'other') ? 'closed' : 'none'));
  const local = pulls.some((p) => p.local);
  return {
    kind, local, number: undefined, text: local ? `the branches in ${pulls.map(tag).join(', ')}` : `PRs ${pulls.map(tag).join(', ')}`, is: 'are',
    label: pulls.map((p) => `${p.repo} ${prLabel(p)}`).join('; '),
  };
}

/**
 * The pull requests of a slice branch, one for each repository, in the merge order, each read against the default branch
 * of its repository. A folder that exists but is not a git repository of its own is refused: gh would read the
 * workspace repository there. Throws BoardError on a gh failure.
 */
function pullsOf(exec, root, branch, names, defaults = new Map(), local = null) {
  return names.map((repo) => {
    const dir = join(root, 'repos', repo);
    if (existsSync(dir) && !existsSync(join(dir, '.git'))) throw new BoardError(`${repo}: repos/${repo} is not a git repository. Run: recade repo sync`);
    const base = typeof defaults.get(repo) === 'string' ? defaults.get(repo) : undefined;
    if (local !== null) {
      if (!existsSync(join(dir, '.git'))) throw new BoardError(`${repo}: repos/${repo} is missing. Run: recade repo sync`);
      return { repo, ...localPullRequest(exec, dir, branch, base, { review: local.review, recorded: local.merged?.[repo] ?? null }) };
    }
    return { repo, ...pullRequest(exec, dir, branch, base) };
  });
}

/**
 * Reconcile the board with the facts (spec 10.7 and 10.9). For each slice and each story: the status the board
 * should show comes from `slices/STATUS.md` and from the pull request. A slice is `done` only when its pull request
 * is merged and its Definition of Done is ticked; any other slice never shows `Done`. A story follows its slice.
 * A slice whose pull request is merged and whose DoD is met moves from `ready-to-merge` to `done` in STATUS.md; no
 * other STATUS.md change is made here. The field and option ids are read with `gh project field-list`. Each move
 * leaves a comment on the issue. Without `apply` nothing is written.
 * @param {string} root the project folder
 * @param {{exec?: Exec, apply?: boolean}} [options]
 *
 * Across code repositories (a workspace with a registry; spec 6.13) a slice has one pull request for each repository
 * its `touches:` name, read with gh in `repos/<name>/`. `done` needs every pull request merged (and the DoD ticked); it
 * then writes `merged: {<repo>: <commit>}` in the sheet and closes the issue of the slice in the workspace repository.
 * `ready-to-merge` needs every pull request open, green and approved, or one already merged; a merged pull request with a
 * failing one keeps the slice `ready-to-merge` and names the failing one. `writes` lists the sheets this run writes.
 * With `deferStatus`, the STATUS.md moves and the sheet writes are not made here: `deferred` lists them for
 * `applyStatusMoves`, which makes no gh call and can run under the workspace lock.
 * @returns {{rows: ReconcileRow[], applied: string[], errors: string[], apply: boolean, writes: string[], deferred?: {id: string, to: string, sheet: {file: string, record: Record<string, string>}|null}[]}}
 */
export function reconcile(root, { exec = defaultExec, apply = false, deferStatus = false, today } = {}) {
  const result = { rows: [], epics: [], applied: [], errors: [], apply, writes: [] };
  if (deferStatus) result.deferred = [];
  const state = loadState(root) ?? {};
  // The local forge has no board and no pull request: the facts come from git and the review requests, and no gh call is made.
  const local = forgeOf(state) === 'local';
  result.local = local;
  const registry = registryNames(state);
  const defaults = new Map((Array.isArray(state.repos) ? state.repos : []).filter((e) => e !== null && typeof e === 'object').map((e) => [e.name, e.default_branch]));
  const github = state.github ?? {};
  const { owner, repo, project_number: number } = github;
  if (!local && (typeof owner !== 'string' || typeof repo !== 'string' || !Number.isInteger(number))) {
    result.errors.push('No board is recorded in recade/state.yaml. Run: recade github init');
    return result;
  }
  const gh = (args) => {
    const r = call(exec, ['gh', ...args], root);
    if (r.code !== 0) throw new BoardError(`gh ${args.slice(0, 2).join(' ')} failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    return r.stdout;
  };
  const ghJson = (args) => {
    try {
      return JSON.parse(gh(args));
    } catch (err) {
      if (err instanceof BoardError) throw err;
      throw new BoardError(`gh ${args.slice(0, 2).join(' ')} did not print JSON.`);
    }
  };

  let project;
  let status;
  let items = [];
  let issues = [];
  if (!local) try {
    project = ghJson(['project', 'view', String(number), '--owner', owner, '--format', 'json']);
    const fields = asArray(ghJson(['project', 'field-list', String(number), '--owner', owner, '--format', 'json', '--limit', '100']), 'fields');
    status = fields.find((f) => String(f.name).toLowerCase() === 'status');
    if (status === undefined || !Array.isArray(status.options)) throw new BoardError('The board has no Status field with options. Run: recade github init');
    items = asArray(ghJson(['project', 'item-list', String(number), '--owner', owner, '--format', 'json', '--limit', '1000']), 'items');
    issues = asArray(ghJson(['issue', 'list', '--repo', `${owner}/${repo}`, '--state', 'all', '--limit', '1000', '--json', 'number,title,url,state,body']));
  } catch (err) {
    result.errors.push(firstLine(err.message));
    return result;
  }

  const slices = checkSlices(root).status;
  const sheets = new Map(slices.map((s) => [s.id, readSheet(root, s.file)]));
  let stories = [];
  const plan = findPlan(root);
  if (plan !== null) stories = parseBacklog(plan.text); // no PLAN: only the slices
  const storyIds = new Set(stories.map((s) => s.id));
  const coveredBy = new Map();
  for (const s of slices) {
    for (const id of new Set(section(sheets.get(s.id).text, 'Scope').match(STORY_ID) ?? [])) {
      if (storyIds.has(id)) coveredBy.set(id, [...(coveredBy.get(id) ?? []), s.id]);
    }
  }

  // An issue of an adopted code repository, linked to a slice by its full URL (`github.links` of the state): it is the issue of
  // the slice, and its item on the board is found by that URL. Its state is read from its own repository.
  // Only an issue of the workspace repository or of the GitHub remote of a registered code repository counts.
  const linkable = new Set([`${owner}/${repo}`.toLowerCase()]);
  for (const e of Array.isArray(state.repos) ? state.repos : []) {
    const r = typeof e?.remote === 'string' ? /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(e.remote.trim()) : null;
    if (r !== null) linkable.add(`${r[1]}/${r[2]}`.toLowerCase());
  }
  const linkedIssue = (id) => {
    const link = github.links?.[id];
    const m = typeof link === 'string' ? ISSUE_URL.exec(link) : null;
    if (m === null || !linkable.has(m[1].toLowerCase())) return null;
    let state;
    try {
      state = ghJson(['issue', 'view', link, '--json', 'number,state']).state;
    } catch {
      state = undefined;
    }
    return { number: Number(m[2]), url: link, state, repoFull: m[1] };
  };
  const itemOf = (id) => {
    const linked = linkedIssue(id);
    if (linked !== null) return { issue: linked, item: items.find((i) => i.content?.url === linked.url) ?? null };
    const issue = issues.find((i) => typeof i.title === 'string' && (i.title === `[${id}]` || i.title.startsWith(`[${id}] `)));
    if (issue === undefined) return { issue: null, item: null };
    const item = items.find((i) => i.content?.url === issue.url || (i.content?.number === issue.number && (i.content?.repository ?? `${owner}/${repo}`) === `${owner}/${repo}`));
    return { issue, item: item ?? null };
  };

  /** The effective state of each slice, then the row of the slice and of each story. */
  const effective = new Map();
  const statusMoves = new Map();
  /** Across repositories: the `merged:` record to write in a sheet, and the slices whose issue is to be closed. */
  const mergedWrites = new Map();
  const closes = new Set();
  const rows = [];
  for (const s of slices) {
    const sheet = sheets.get(s.id);
    const row = { id: s.id, kind: 'slice', status: s.status, pr: 'none', board: '', target: '', action: 'keep', reason: '' };
    rows.push(row);
    let pr = { kind: 'none' };
    /** The pull requests of the slice, one for each repository, when it spans the registry; null for a single one in the project folder. */
    let pulls = null;
    const names = sliceRepoOrder(s, registry);
    if (s.lane === 'no-code') {
      // A no-code slice has no pull request and never will: /slice closes it in STATUS.md, with its DoD ticked. The board
      // follows STATUS.md, and the issue of a done slice is closed like the one of a merged slice.
      row.pr = 'none (no-code)';
      const current = s.status;
      const dod = dodState(sheet.text);
      const reason = current === 'done' && dod.open > 0 ? `STATUS.md says done with ${dod.open} line${dod.open === 1 ? '' : 's'} of the DoD open` : '';
      effective.set(s.id, { status: current, done: current === 'done', reason });
      row.target = BOARD_STATUS[current] ?? '';
      row.reason = reason;
      if (current === 'done') closes.add(s.id);
      continue;
    }
    if (!BRANCH.test(sheet.branch)) row.reason = 'its sheet names no usable branch, so there is no pull request to look at';
    else {
      try {
        const there = local ? { review: existsSync(join(root, reviewPath(s.id))), merged: sheet.merged } : null;
        if (names.length > 0) {
          pulls = pullsOf(exec, root, sheet.branch, names, defaults, there);
          pr = together(pulls);
        } else if (local) pr = together([localPullRequest(exec, root, sheet.branch, 'main', { review: there.review, recorded: Object.values(sheet.merged)[0] ?? null })]);
        else pr = together([pullRequest(exec, root, sheet.branch)]);
      } catch (err) {
        result.errors.push(firstLine(err.message));
        row.pr = 'unknown';
        row.action = 'skip';
        row.reason = 'the pull request could not be read, so nothing is moved';
        continue;
      }
    }
    row.pr = pr.label ?? prLabel(pr);
    const dod = dodState(sheet.text);
    const doneProved = pr.kind === 'merged' && dod.met;
    let current = s.status;
    const reasons = [];
    if (doneProved && current !== 'done') {
      const move = setStatus(root, s.id, 'done');
      if (move.ok) {
        statusMoves.set(s.id, { from: move.from, to: move.to });
        current = 'done';
        reasons.push(`${pr.text} merged and the DoD is ticked`);
      } else {
        const left = /^Blocked from ([a-z0-9-]+): /.exec(s.note)?.[1] ?? '';
        const next = allowedNext(current, s.lane, left) ?? [];
        reasons.push(`${pr.text} ${pr.is} merged and the DoD is ticked, but ${s.id} is ${current}${next.includes('ready-to-merge') ? ': move it to ready-to-merge first' : ''}`);
      }
    } else if (!doneProved) {
      if (pr.kind === 'merged') reasons.push(`${pr.text} ${pr.is} merged, but the DoD is not ticked (${dod.ticked + dod.open === 0 ? 'no tick box' : `${dod.open} line${dod.open === 1 ? '' : 's'} open`}): not done`);
      else if (s.status === 'done') reasons.push(`STATUS.md says done, but the pull request is not merged (${pr.label ?? prLabel(pr)}): the board does not show Done`);
      else if (pr.kind === 'open') reasons.push(`${pr.text} ${pr.is} not merged yet`);
    }
    if (pulls !== null) {
      // On the local forge there is no check and no approval to read: /slice moves the slice to ready-to-merge itself.
      const verdict = local ? { status: null, failing: [] } : statusFromPulls(pulls);
      // Every pull request open, green and approved (or one already merged) makes the slice ready to merge.
      if (!doneProved && verdict.status === 'ready-to-merge' && !['ready-to-merge', 'done'].includes(current)) {
        const move = setStatus(root, s.id, 'ready-to-merge');
        if (move.ok) {
          statusMoves.set(s.id, { from: move.from, to: move.to });
          current = 'ready-to-merge';
          reasons.push(pulls.some((p) => p.kind === 'merged') ? 'one pull request is merged' : 'every pull request is open, green and approved');
        }
      }
      if (pr.kind !== 'merged' && verdict.failing.length > 0) {
        reasons.push(`not done: ${verdict.failing.map((f) => `${tag(f)} (${f.why})`).join(', ')}`);
      }
      if (doneProved && current === 'done') {
        const record = Object.fromEntries(pulls.filter((p) => p.sha !== '').map((p) => [p.repo, p.sha]));
        if (Object.keys(record).length > 0 && JSON.stringify(Object.entries(record)) !== JSON.stringify(Object.entries(sheet.merged))) {
          mergedWrites.set(s.id, { file: s.file, record });
          result.writes.push(s.file);
        }
        closes.add(s.id);
      }
    }
    const shown = doneProved || current !== 'done' ? current : 'ready-to-merge';
    effective.set(s.id, { status: shown, done: shown === 'done', reason: reasons.join('; ') });
    row.target = BOARD_STATUS[shown] ?? '';
    row.reason = reasons.join('; ');
  }
  /** How far a status is along the chain. `blocked` counts as work that began. */
  const rank = (status) => (status === 'blocked' ? 1 : STATUSES.indexOf(status));
  for (const story of stories) {
    const by = coveredBy.get(story.id) ?? [];
    const row = { id: story.id, kind: 'story', status: '', pr: '', board: '', target: '', action: 'keep', reason: '' };
    rows.push(row);
    if (by.length === 0) {
      row.action = 'skip';
      row.reason = 'no slice cites it in its Scope';
      continue;
    }
    const unread = by.filter((id) => !effective.has(id));
    if (unread.length > 0) {
      row.action = 'skip';
      row.reason = `slice ${unread.join(', ')} could not be read`;
      continue;
    }
    // A story is done only when every slice that cites it is done. Otherwise it follows the least advanced one.
    const least = by.map((id) => ({ id, ...effective.get(id) })).reduce((a, b) => (rank(b.status) < rank(a.status) ? b : a));
    row.status = `${by.length === 1 ? 'slice' : 'slices'} ${by.join(', ')}: ${least.status}`;
    row.target = BOARD_STATUS[least.status] ?? '';
    row.reason = by.length === 1 ? `follows ${by[0]}` : `follows ${least.id}, the least advanced of ${by.join(', ')}`;
  }

  // The board side of each row.
  const ids = new Map();
  for (const row of rows) {
    if (local) {
      // No board: STATUS.md and the sheets are the board.
      row.board = row.target === '' ? '' : 'local';
      continue;
    }
    if (row.action === 'skip' || row.target === '') continue;
    const { issue, item } = itemOf(row.id);
    ids.set(row.id, { issue, item });
    if (item === null) {
      row.action = 'skip';
      row.reason = `${row.reason ? `${row.reason}. ` : ''}It is not on the board (${issue === null ? 'no issue' : 'issue without an item'}): run recade github init`;
      continue;
    }
    row.board = String(item.status ?? '');
    const same = SAME_PLACE[row.target].includes(row.board.toLowerCase());
    const option = optionFor(status.options, row.target);
    if (!same && option === undefined) {
      row.action = 'skip';
      row.reason = `${row.reason ? `${row.reason}. ` : ''}The Status field has no "${row.target}" option`;
      continue;
    }
    if (!same) row.action = 'move';
  }
  // The issue of a done slice is closed once: only when the workspace repository still shows it open.
  const closing = new Set();
  for (const row of rows) {
    if (local || !closes.has(row.id) || row.action === 'skip') continue;
    const issue = ids.get(row.id)?.issue;
    if (issue !== null && issue !== undefined && String(issue.state ?? '').toUpperCase() !== 'CLOSED') closing.add(row.id);
  }
  for (const row of rows) {
    if (row.action === 'keep' && (statusMoves.has(row.id) || mergedWrites.has(row.id) || closing.has(row.id))) row.action = 'move';
  }
  result.rows = rows;

  // The epic of a lot (the issue with the Recade marker) closes when every story of the lot is cited by a slice and every slice
  // that serves the lot is done, and reopens when a slice that serves it is not done any more, or a new one is added.
  // A lot that left the PLAN is not looked at here: `recade github sync` closed its epic.
  let lotPlan = { lots: [], sliceLots: new Map() };
  try {
    lotPlan = epicPlan(root);
  } catch (err) {
    result.errors.push(`epics: ${firstLine(err.message)}`);
  }
  for (const lot of lotPlan.lots) {
    const epic = issues.find((i) => epicCode(i.body) === lot.code);
    if (epic === undefined) continue;
    const serving = slices.filter((s) => (lotPlan.sliceLots.get(s.id) ?? []).includes(lot.code)).map((s) => s.id);
    if (serving.length === 0 || serving.some((id) => !effective.has(id))) continue;
    const uncovered = lot.stories.filter((st) => (coveredBy.get(st.id) ?? []).length === 0).map((st) => st.id);
    const open = serving.filter((id) => !effective.get(id).done);
    const closed = String(epic.state ?? '').toUpperCase() === 'CLOSED';
    if (!closed && open.length === 0 && uncovered.length === 0) {
      result.epics.push({ code: lot.code, number: epic.number, action: 'close', reason: `every slice of the lot is done (${serving.join(', ')})` });
    } else if (closed && open.length > 0) {
      result.epics.push({ code: lot.code, number: epic.number, action: 'reopen', reason: `${open.join(', ')} ${open.length === 1 ? 'is' : 'are'} not done` });
    }
  }
  if (!apply) return result;

  for (const row of rows.filter((r) => r.action === 'move')) {
    const found = ids.get(row.id) ?? { issue: null, item: null };
    const note = [];
    try {
      const to = statusMoves.get(row.id)?.to;
      const sheetWrite = mergedWrites.get(row.id) ?? null;
      if (deferStatus && (to !== undefined || sheetWrite !== null)) {
        // The caller writes STATUS.md and the sheet under the workspace lock, after the gh calls (`applyStatusMoves`).
        result.deferred.push({ id: row.id, to: to ?? null, sheet: sheetWrite });
        if (to !== undefined) note.push(`STATUS.md: ${row.status} to ${to}`);
        if (sheetWrite !== null) note.push(`merged: ${recordText(sheetWrite.record)}`);
      } else {
        if (to !== undefined) {
          // Computed again from the file as it is now: an earlier move of this run has already changed it.
          const move = setStatus(root, row.id, to);
          if (!move.ok) throw new BoardError(move.message);
          writeFileSync(join(root, 'slices', 'STATUS.md'), move.text);
          if (move.to === 'done') noteFirstSliceDone(root, today ?? localToday());
          note.push(`STATUS.md: ${move.from} to ${move.to}`);
        }
        if (sheetWrite !== null) {
          writeSheetRecord(root, sheetWrite);
          note.push(`merged: ${recordText(sheetWrite.record)}`);
        }
      }
      if (closing.has(row.id)) note.push('issue closed');
      if (local) {
        result.applied.push(`${row.id}: ${note.join('; ')}`);
        continue;
      }
      if (found.item !== null && !SAME_PLACE[row.target].includes(row.board.toLowerCase())) {
        gh(['project', 'item-edit', '--id', found.item.id, '--project-id', project.id, '--field-id', status.id,
          '--single-select-option-id', optionFor(status.options, row.target).id]);
        note.push(`board: ${row.board || 'empty'} to ${row.target}`);
      }
      if (found.issue !== null && note.length > 0) {
        const body = `Board reconcile: ${row.id} ${note.join('; ')}.${row.reason ? ` ${row.reason}.` : ''}`;
        gh(['issue', 'comment', String(found.issue.number), '--repo', found.issue.repoFull ?? `${owner}/${repo}`, '--body', body]);
      }
      if (closing.has(row.id)) gh(['issue', 'close', String(found.issue.number), '--repo', found.issue.repoFull ?? `${owner}/${repo}`, '--reason', 'completed']);
      result.applied.push(`${row.id}: ${note.join('; ')}`);
    } catch (err) {
      result.errors.push(`${row.id}: ${firstLine(err.message)}`);
    }
  }
  for (const e of result.epics) {
    try {
      gh(['issue', 'comment', String(e.number), '--repo', `${owner}/${repo}`, '--body', `Board reconcile: the epic ${e.code} is ${e.action === 'close' ? 'closed' : 'reopened'}: ${e.reason}.`]);
      gh(e.action === 'close'
        ? ['issue', 'close', String(e.number), '--repo', `${owner}/${repo}`, '--reason', 'completed']
        : ['issue', 'reopen', String(e.number), '--repo', `${owner}/${repo}`]);
      result.applied.push(`epic ${e.code}: ${e.action === 'close' ? 'closed' : 'reopened'}`);
    } catch (err) {
      result.errors.push(`epic ${e.code}: ${firstLine(err.message)}`);
    }
  }
  return result;
}

/** `api a1b2c3d, web e4f5a6b`: a `merged:` record, short. */
const recordText = (record) => Object.entries(record).map(([name, sha]) => `${name} ${sha.slice(0, 7)}`).join(', ');

/** Write the `merged:` record of a slice in its sheet (read again, so an earlier write of this run is kept). */
function writeSheetRecord(root, { file, record }) {
  const path = join(root, file);
  writeFileSync(path, writeMerged(readFileSync(path, 'utf8'), record));
}

/**
 * The writes that `reconcile(..., {deferStatus: true})` left to do: each slice moves to its status (`to`, `done` for a
 * plain id), computed from STATUS.md as it is now, and its sheet gets the `merged:` record. No gh call here, so it can
 * run under a lock. Returns the errors, one line each.
 * @param {string} root
 * @param {(string|{id: string, to?: string|null, sheet?: {file: string, record: Record<string, string>}|null})[]} moves
 * @param {{today?: string, noteFirst?: boolean}} [options] `noteFirst`: the first slice that becomes done records
 *   `today` as `first_slice_done:` in the state (the caller commits the state with STATUS.md)
 */
export function applyStatusMoves(root, moves, { today, noteFirst = false } = {}) {
  const errors = [];
  for (const m of moves) {
    const { id, to = 'done', sheet = null } = typeof m === 'string' ? { id: m } : m;
    if (to !== null) {
      const move = setStatus(root, id, to);
      if (!move.ok) {
        errors.push(`${id}: ${firstLine(move.message)}`);
        continue;
      }
      writeFileSync(join(root, 'slices', 'STATUS.md'), move.text);
      if (noteFirst && move.to === 'done') noteFirstSliceDone(root, today ?? localToday());
    }
    if (sheet !== null) writeSheetRecord(root, sheet);
  }
  return errors;
}

const pad = (rows, i) => Math.max(...rows.map((r) => String(r[i]).length));

/**
 * The table of a reconcile, for the owner. One row for each slice and story, then the problems.
 * @param {ReturnType<typeof reconcile>} result
 * @returns {string}
 */
export function formatReconcile(result) {
  const out = [];
  if (result.rows.length > 0) {
    // The local forge has no board: STATUS.md is the board, and the review request stands for the pull request.
    const head = result.local ? ['Item', 'STATUS.md', 'Review', 'Action'] : ['Item', 'STATUS.md', 'PR', 'Board now', 'Board target', 'Action'];
    const body = result.rows.map((r) => (result.local ? [r.id, r.status || '-', r.pr || '-', r.action] : [r.id, r.status || '-', r.pr || '-', r.board || '-', r.target || '-', r.action]));
    const all = [head, ...body];
    const w = head.map((_, i) => pad(all, i));
    const fmt = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
    out.push(fmt(head), fmt(w.map((n) => '-'.repeat(n))), ...body.map(fmt));
    const why = result.rows.filter((r) => r.reason !== '' && (r.action !== 'keep' || /not|never/.test(r.reason)));
    if (why.length > 0) out.push('', ...why.map((r) => `${r.id}: ${r.reason}`));
  } else if (result.errors.length === 0) out.push('No slice and no story to reconcile.');
  if ((result.epics ?? []).length > 0) out.push('', ...result.epics.map((e) => `Epic ${e.code}: ${e.action}, ${e.reason}`));
  const moves = result.rows.filter((r) => r.action === 'move').length + (result.epics ?? []).length;
  if (result.apply) {
    out.push('', `Applied ${result.applied.length} of ${moves} move${moves === 1 ? '' : 's'}${result.local ? ' (local forge: no gh call)' : ''}.`);
    for (const a of result.applied) out.push(`  ${a}`);
  } else if (result.errors.length === 0) {
    out.push('', `Dry run: ${moves} move${moves === 1 ? '' : 's'} planned, nothing changed. Run again with --apply once the owner agrees.`);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------------------------------------

/** Folders that hold build output, caches or installed dependencies. Only the ones Git ignores are counted as caches. */
const CACHE_DIRS = ['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', '.cache', '.turbo', '.parcel-cache', '__pycache__', '.venv', 'venv', 'target', '.gradle'];
/** `git gc` runs when the loose objects and the garbage together are bigger than this (KiB). */
export const GC_THRESHOLD_KIB = 50 * 1024;
/** A stop command is split on spaces and run without a shell: it may not carry shell syntax. */
const SHELL_SYNTAX = /[;&|<>$`\\"'()*?\n]/;

/** Size in bytes of a file or a folder, without following links. */
function sizeOf(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names = [];
  try {
    names = readdirSync(path);
  } catch { /* unreadable: count what we can */ }
  for (const name of names) total += sizeOf(join(path, name));
  return total;
}

/** The worktrees of a repository, from `git worktree list --porcelain`. */
function worktrees(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null, locked: false, bare: false };
      out.push(cur);
    } else if (cur !== null) {
      if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length);
      else if (line === 'bare') cur.bare = true;
      else if (line.startsWith('locked')) cur.locked = true;
    }
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Is `path` inside the folder `main` for real: no link on the way takes it somewhere else? A path that is gone counts as inside. */
function insideRepo(main, path) {
  const rel = relative(resolve(main), resolve(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  try {
    return realpathSync(resolve(path)) === join(realpathSync(resolve(main)), rel);
  } catch (err) {
    return err?.code === 'ENOENT';
  }
}

/**
 * Clean up after the merges (spec 10.7). A candidate is the worktree and the branches (local and remote) of a slice
 * whose pull request is merged. The merge is read from the pull request (`gh pr view`), not from `git branch --merged`,
 * because a squash merge leaves the branch out of the history of `main`. Work is never removed when:
 * the worktree has uncommitted changes (untracked files included), the local or the remote branch holds a commit that
 * is not in the merged pull request, the worktree is the folder the command runs from, is locked, or its stop command
 * fails. Such a slice is kept whole and listed with its reasons. Nothing is forced: the worktree is removed without
 * `--force`, a branch is deleted only after its tip is proved to be in the merged pull request.
 * The services of a worktree are stopped first with the `Stop` command of the harness technical sheet of `docs/STACK.md`.
 * Then the worktree is removed (and with it its build output and installed dependencies), `git worktree prune` runs,
 * the local and remote branches go, and `git gc` runs when the loose objects grew over `gcThresholdKiB`.
 * Files that Git ignores are deleted with the worktree. The folders of `CACHE_DIRS` are caches and may go; any other ignored
 * file (a local `.env`, a database) keeps the slice, with the names in the reason, unless its path is listed in `allowIgnored`.
 * `.recade/` (stamps and gate logs) is Recade's own and is removed before the worktree, so that Git does not refuse. Every
 * check that can make the removal fail is made before the services are stopped.
 * Without `apply` nothing is changed: the result lists what would be done, with an estimate of the bytes.
 * @param {string} repo the main folder of the repository, or one of its worktrees
 * @param {{exec?: Exec, apply?: boolean, gcThresholdKiB?: number}} [options]
 */
function cleanupRepo(repo, { exec = defaultExec, apply = false, gcThresholdKiB = GC_THRESHOLD_KIB, allowIgnored = [], stack, name, ws = null, local: localForge = false, base: localBase = 'main' } = {}) {
  const result = { candidates: [], kept: [], removed: [], bytesEstimate: 0, bytesFreed: 0, gc: false, errors: [], warnings: [], apply };
  const git = (cwd, ...args) => call(exec, ['git', ...args], cwd);
  const fail = (message) => {
    result.errors.push(message);
    return result;
  };

  const top = git(repo, 'rev-parse', '--show-toplevel');
  if (top.code !== 0) return fail('Not a git repository. Run this from the repository folder.');
  const here = resolve(top.stdout.trim());
  const listing = git(here, 'worktree', 'list', '--porcelain');
  if (listing.code !== 0) return fail(`git worktree list failed: ${firstLine(listing.stderr) || `exit ${listing.code}`}`);
  const trees = worktrees(listing.stdout);
  const main = resolve(trees[0]?.path ?? here);
  // The local forge never reaches a remote: no remote branch is read or deleted.
  const hasOrigin = !localForge && git(main, 'remote', 'get-url', 'origin').code === 0;
  let merges = null;
  if (localForge) {
    try {
      merges = localMerges(exec, main, localBase);
    } catch (err) {
      return fail(firstLine(err.message));
    }
  }

  // The stop command, from the harness technical sheet. Read from the main folder.
  let stop = null;
  try {
    // In a workspace the sheet is the table of this repository in the STACK of the workspace.
    stop = techSheet(stack === undefined ? readStack(main) : stack, name).get('stop') ?? null;
  } catch { /* no STACK: nothing to stop */ }

  const revParse = (cwd, ref) => {
    const r = git(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return r.code === 0 && /^[0-9a-f]{40,64}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
  };
  /** True, false, or null when git cannot tell (an object that is not here). */
  const isAncestor = (a, b) => {
    const r = git(main, 'merge-base', '--is-ancestor', a, b);
    return r.code === 0 ? true : (r.code === 1 ? false : null);
  };

  let branches;
  try {
    branches = listSliceBranches(main, exec);
  } catch (err) {
    return fail(firstLine(err.message));
  }
  for (const t of trees) {
    const name = t.branch?.replace(/^refs\/heads\//, '');
    if (name !== undefined && SLICE_BRANCH.test(name) && !branches.includes(name)) branches.push(name);
  }

  const analyse = () => {
    const candidates = [];
    const kept = [];
    for (const branch of branches.filter((b) => SLICE_BRANCH.test(b) && BRANCH.test(b)).sort()) {
      const slice = sliceId(branch);
      const keep = (...reasons) => kept.push({ slice, branch, worktree: tree?.path ?? null, reasons });
      const tree = trees.find((t) => t.branch === `refs/heads/${branch}`);
      // On the local forge the merge is read from git: a merge commit of the base branch whose parent is the branch tip.
      const localTip = localForge ? revParse(main, `refs/heads/${branch}`) : null;
      const localMerge = localForge ? findMerge(merges, { tip: localTip }) : null;
      if (localForge && localMerge === null) {
        keep(localTip === null ? 'the branch is gone, so its merge cannot be proved' : `the branch is not merged into ${localBase} with a merge commit (git merge --no-ff)`);
        continue;
      }
      const r = localForge
        ? { code: 0, stdout: JSON.stringify({ number: null, state: 'MERGED', mergedAt: 'local', headRefOid: localTip, baseRefName: localBase }), stderr: '' }
        : call(exec, ['gh', 'pr', 'view', branch, '--json', 'number,state,mergedAt,headRefOid,baseRefName'], main);
      if (r.code !== 0) {
        if (/no pull requests? found/i.test(r.stderr)) keep('no pull request found for the branch');
        else keep(`the pull request could not be read: ${firstLine(r.stderr) || `exit ${r.code}`}`);
        continue;
      }
      let pr;
      try {
        pr = JSON.parse(r.stdout);
      } catch {
        keep('the pull request could not be read: gh did not print JSON');
        continue;
      }
      if (String(pr.state).toUpperCase() !== 'MERGED' || !pr.mergedAt) {
        keep(`the pull request is not merged (${String(pr.state ?? 'unknown').toLowerCase()})`);
        continue;
      }
      const reasons = [];
      const head = typeof pr.headRefOid === 'string' && /^[0-9a-f]{40,64}$/.test(pr.headRefOid) ? pr.headRefOid : null;
      const base = typeof pr.baseRefName === 'string' && BRANCH.test(pr.baseRefName) ? pr.baseRefName : 'main';
      const baseTips = [`refs/heads/${base}`, `refs/remotes/origin/${base}`].map((ref) => revParse(main, ref)).filter(Boolean);
      /** Is a commit part of the merged pull request (its head, below its head, or already in the base)? */
      const inMerged = (sha) => {
        if (head !== null && (sha === head || isAncestor(sha, head) === true)) return true;
        return baseTips.some((tip) => isAncestor(sha, tip) === true);
      };
      const unsaid = (sha, where) => {
        if (head !== null && revParse(main, head) !== null) {
          const n = git(main, 'rev-list', '--count', `${head}..${sha}`);
          const count = n.code === 0 ? Number(n.stdout.trim()) : NaN;
          if (Number.isInteger(count) && count > 0) return `${where} has ${plural(count, 'commit')} not in the merged pull request`;
        }
        return `${where} holds work that cannot be proved to be in the merged pull request`;
      };
      const local = revParse(main, `refs/heads/${branch}`);
      if (local !== null && !inMerged(local)) reasons.push(unsaid(local, 'the local branch'));
      let remote = null;
      if (hasOrigin) {
        const lr = git(main, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
        if (lr.code !== 0) reasons.push(`the remote branch could not be checked: ${firstLine(lr.stderr) || `exit ${lr.code}`}`);
        else {
          remote = /^([0-9a-f]{40,64})\s/.exec(lr.stdout.trim())?.[1] ?? null;
          if (remote !== null && !inMerged(remote)) reasons.push(unsaid(remote, 'the remote branch'));
        }
      }
      let bytes = 0;
      let caches = 0;
      if (tree !== undefined) {
        // A slice worktree lives under worktrees/<repo>/ of the workspace, or, before the migration, inside the repository.
        if (!insideRepo(main, tree.path) && !(ws !== null && name !== undefined && insideRepo(join(ws, WORKTREES_DIR, name), tree.path))) reasons.push('the worktree is outside the repository folder and the worktrees/ folder of the workspace, or is reached through a link: it was not touched');
        else if (resolve(tree.path) === main) reasons.push('it is checked out in the main folder');
        else if (resolve(tree.path) === here) reasons.push('it is the current folder: run the cleanup from the main folder');
        else if (tree.locked) reasons.push('the worktree is locked');
        else {
          // Untracked files of `.recade/` (stamps, gate logs) are Recade's own and do not count. A tracked file of
          // `.recade/` that was modified, and any other change, does.
          const st = git(tree.path, 'status', '--porcelain', '--untracked-files=all');
          const changed = st.stdout.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('?? .recade/'));
          if (st.code !== 0) reasons.push(`the worktree could not be checked: ${firstLine(st.stderr) || `exit ${st.code}`}`);
          else if (changed.length > 0) reasons.push(`the worktree has uncommitted changes (${plural(changed.length, 'file')})`);
          bytes = sizeOf(tree.path);
          // Ignored files are not work in progress, but they are deleted with the worktree. Caches and installed
          // dependencies may go. Anything else that Git ignores (a local .env, a database) is kept unless the owner named it.
          const ignored = git(tree.path, 'status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=normal');
          if (ignored.code !== 0) reasons.push(`the ignored files of the worktree could not be listed: ${firstLine(ignored.stderr) || `exit ${ignored.code}`}`);
          else {
            const precious = [];
            for (const entry of ignored.stdout.split('\0').filter((e) => e.startsWith('!! ')).map((e) => e.slice(3))) {
              const name = entry.replace(/\/$/, '');
              if (name === '.recade' || name.startsWith('.recade/')) continue; // the stamps and logs of Recade, made again by the next gate run
              if (entry.endsWith('/') && CACHE_DIRS.includes(name.split('/').pop())) caches += sizeOf(join(tree.path, name));
              else if (!allowIgnored.includes(name)) precious.push(name);
            }
            if (precious.length > 0) {
              const shown = precious.slice(0, 5).join(', ');
              reasons.push(`the worktree holds ignored files that are not caches and would be deleted with it: ${shown}${precious.length > 5 ? ` and ${precious.length - 5} more` : ''}. Copy them out, or name them with --allow-ignored`);
            }
          }
        }
      }
      if (reasons.length > 0) keep(...reasons);
      else if (tree === undefined && local === null && remote === null) continue; // a stale tracking ref: nothing to clean
      else candidates.push({ slice, branch, worktree: tree?.path ?? null, local, remote, pr: pr.number, bytes, caches, stop: tree !== undefined ? stop : null });
    }
    return { candidates, kept };
  };

  const first = analyse();
  result.candidates = first.candidates;
  result.kept = first.kept;
  result.bytesEstimate = first.candidates.reduce((n, c) => n + c.bytes, 0);
  if (!apply) return result;

  // Apply: read the facts again right now, the list the owner saw may be old.
  const now = analyse();
  result.kept = now.kept;
  result.candidates = now.candidates;
  const gitDir = git(main, 'rev-parse', '--git-common-dir');
  const common = gitDir.code === 0 ? resolve(main, gitDir.stdout.trim()) : join(main, '.git');
  const before = sizeOf(common);
  for (const c of now.candidates) {
    const stay = (...reasons) => result.kept.push({ slice: c.slice, branch: c.branch, worktree: c.worktree, reasons });
    if (c.worktree !== null) {
      if (c.stop !== null) {
        const argv = c.stop.split(/\s+/).filter(Boolean);
        if (SHELL_SYNTAX.test(c.stop) || argv.length === 0) {
          stay(`the stop command "${c.stop}" has shell syntax, so it was not run: stop the services by hand`);
          continue;
        }
        const s = call(exec, argv, c.worktree);
        if (s.code !== 0) {
          stay(`the stop command failed (${firstLine(s.stderr) || firstLine(s.stdout) || `exit ${s.code}`}): the services may still run`);
          continue;
        }
      }
      // The stamps and logs of Recade are not work, and Git refuses to remove a worktree that holds them untracked.
      const tracked = git(c.worktree, 'ls-files', '--', '.recade');
      if (tracked.code !== 0) {
        stay(`git ls-files failed in the worktree: ${firstLine(tracked.stderr) || `exit ${tracked.code}`}`);
        continue;
      }
      if (tracked.stdout.trim() === '') {
        try {
          rmSync(join(c.worktree, '.recade'), { recursive: true, force: true });
        } catch (err) {
          stay(`the .recade folder of the worktree could not be removed: ${firstLine(err.message)}`);
          continue;
        }
      }
      const removed = git(main, 'worktree', 'remove', c.worktree);
      if (removed.code !== 0) {
        stay(`git worktree remove refused: ${firstLine(removed.stderr) || `exit ${removed.code}`}`);
        continue;
      }
    }
    const gone = { slice: c.slice, branch: c.branch, worktree: c.worktree, local: false, remote: false, bytes: c.bytes, caches: c.caches };
    // Only a slice branch, and only when its tip is still the one that was proved to be in the merged pull request.
    if (c.local !== null) {
      if (revParse(main, `refs/heads/${c.branch}`) !== c.local) stay('the local branch moved while cleaning: left as it is');
      else {
        const d = git(main, 'branch', '-D', c.branch);
        if (d.code === 0) gone.local = true;
        else result.errors.push(`${c.branch}: git branch -D failed: ${firstLine(d.stderr) || `exit ${d.code}`}`);
      }
    }
    if (c.remote !== null) {
      const lr = git(main, 'ls-remote', '--heads', 'origin', `refs/heads/${c.branch}`);
      const tip = /^([0-9a-f]{40,64})\s/.exec(lr.stdout.trim())?.[1] ?? null;
      if (tip !== c.remote) stay('the remote branch moved while cleaning: left as it is');
      else {
        const d = git(main, 'push', 'origin', '--delete', c.branch);
        if (d.code === 0) gone.remote = true;
        else result.errors.push(`${c.branch}: deleting the remote branch failed: ${firstLine(d.stderr) || `exit ${d.code}`}`);
      }
    }
    result.removed.push(gone);
    result.bytesFreed += c.bytes;
  }
  if (result.removed.length > 0) {
    git(main, 'worktree', 'prune');
    const count = git(main, 'count-objects', '-v');
    const kib = (key) => Number(new RegExp(`^${key}: (\\d+)`, 'm').exec(count.stdout)?.[1] ?? 0);
    if (count.code === 0 && kib('size') + kib('size-garbage') >= gcThresholdKiB) {
      const g = git(main, 'gc', '--quiet');
      if (g.code === 0) {
        result.gc = true;
        result.bytesFreed += Math.max(0, before - sizeOf(common));
      } else result.warnings.push(`git gc failed: ${firstLine(g.stderr) || `exit ${g.code}`}`);
    }
  }
  return result;
}

/** The workspace folder when `top` is one (its state says `kind: workspace`), else null. */
function workspaceTop(top) {
  try {
    return loadState(top)?.kind === 'workspace' ? top : null;
  } catch {
    return null;
  }
}

/**
 * The artifacts of a slice in a repository, as workspace paths that exist: `artifacts/<repo>/<S-nn>`. Every component
 * under the workspace is looked at without following links; a link anywhere on the path gives a warning and no path, so
 * nothing outside the workspace is ever read or removed.
 */
function artifactsOf(ws, repo, slice, warnings) {
  const parts = ['artifacts', repo, slice];
  let st;
  for (let i = 0; i < parts.length; i++) {
    const rel = parts.slice(0, i + 1).join('/');
    try {
      st = lstatSync(join(ws, rel));
    } catch {
      return [];
    }
    if (st.isSymbolicLink()) {
      warnings.push(`${rel} is a link: it was not followed and not removed`);
      return [];
    }
  }
  return st.isDirectory() ? [parts.join('/')] : [];
}

/**
 * Clean up after the merges. In a code repository (or any git folder that is not a workspace) this is the cleanup of that
 * repository, see `cleanupRepo` above. From the workspace (spec 6.9) it runs that cleanup in each registered repository
 * (`repos/<name>/`, with the stop command of the table of that repository in the STACK of the workspace), and for each
 * slice branch it removed, also deletes `artifacts/<repo>/<S-nn>/`. The version folders `artifacts/<repo>/<version>/` are
 * never touched. `tmp/` is emptied (the folder stays) only when at least one slice was removed and none was kept, so
 * the drafts of a slice that is still open survive. The rules of the single repository (merged pull request, unpushed
 * work kept, nothing forced) hold in each repository. Entries carry `repo`; errors and warnings start with the name.
 * @param {string} repo the workspace, a code repository, or a folder of one
 * @param {{exec?: Exec, apply?: boolean, gcThresholdKiB?: number, allowIgnored?: string[]}} [options]
 */
export function cleanup(repo, options = {}) {
  const { exec = defaultExec, apply = false } = options;
  const top = call(exec, ['git', 'rev-parse', '--show-toplevel'], repo);
  const ws = top.code === 0 ? workspaceTop(resolve(top.stdout.trim())) : null;
  if (ws === null) {
    // A code repository of a workspace, or a legacy project: its forge is read from the project it belongs to.
    let state = null;
    try {
      const home = projectRoot(repo);
      state = home === null ? null : loadState(home);
    } catch { /* no readable project: the GitHub forge, as before */ }
    const name = top.code === 0 ? basename(resolve(top.stdout.trim())) : '';
    const entry = (Array.isArray(state?.repos) ? state.repos : []).find((e) => e?.name === name);
    const base = typeof entry?.default_branch === 'string' && BRANCH.test(entry.default_branch) ? entry.default_branch : 'main';
    return cleanupRepo(repo, { ...options, local: forgeOf(state) === 'local', base });
  }

  const result = { candidates: [], kept: [], removed: [], bytesEstimate: 0, bytesFreed: 0, gc: false, errors: [], warnings: [], apply, tmp: { path: 'tmp', planned: false, removed: false, bytes: 0 } };
  const stack = readStack(ws);
  const state = loadState(ws) ?? {};
  const names = registryNames(state).filter((n) => REPO_NAME.test(n) && n !== 'workspace');
  for (const name of names) {
    // A folder with no .git of its own would be read as the workspace repository: refuse it.
    if (!existsSync(join(ws, 'repos', name, '.git'))) {
      result.errors.push(`${name}: repos/${name} is not a git repository. Run: recade repo sync`);
      continue;
    }
    const entry = (Array.isArray(state.repos) ? state.repos : []).find((e) => e?.name === name);
    const base = typeof entry?.default_branch === 'string' && BRANCH.test(entry.default_branch) ? entry.default_branch : 'main';
    const sub = cleanupRepo(join(ws, 'repos', name), { ...options, stack: stack ?? '', name, ws, local: forgeOf(state) === 'local', base });
    const label = (item) => ({ repo: name, ...item });
    result.kept.push(...sub.kept.map(label));
    result.errors.push(...sub.errors.map((e) => `${name}: ${e}`));
    result.warnings.push(...sub.warnings.map((w) => `${name}: ${w}`));
    result.gc ||= sub.gc;
    result.bytesFreed += sub.bytesFreed;
    result.bytesEstimate += sub.bytesEstimate;
    // The artifacts of a slice stay while any branch of that slice is kept in this repository.
    const stays = new Set(sub.kept.map((k) => k.slice));
    for (const c of sub.candidates) {
      const artifacts = stays.has(c.slice) ? [] : artifactsOf(ws, name, c.slice, result.warnings);
      for (const a of artifacts) result.bytesEstimate += sizeOf(join(ws, a));
      result.candidates.push(label({ ...c, artifacts }));
    }
    for (const r of sub.removed) {
      const artifacts = stays.has(r.slice) ? [] : artifactsOf(ws, name, r.slice, result.warnings);
      const gone = [];
      for (const a of artifacts) {
        const bytes = sizeOf(join(ws, a));
        try {
          if (!realpathSync(join(ws, a)).startsWith(`${realpathSync(join(ws, 'artifacts'))}${sep}`)) throw new Error('it is not under artifacts/');
          rmSync(join(ws, a), { recursive: true, force: true });
          gone.push(a);
          result.bytesFreed += bytes;
        } catch (err) {
          result.errors.push(`${name}: ${a} could not be removed: ${firstLine(err.message)}`);
        }
      }
      result.removed.push(label({ ...r, artifacts: gone }));
    }
  }
  // The drafts are shared by every slice: they go only when nothing of any slice is kept.
  const quiet = result.kept.length === 0 && result.errors.length === 0;
  const tmp = join(ws, 'tmp');
  let tmpStat = null;
  try {
    tmpStat = lstatSync(tmp);
  } catch { /* no tmp/ */ }
  if (tmpStat !== null && tmpStat.isSymbolicLink()) result.warnings.push('tmp is a link: it was not followed and not emptied');
  else if (tmpStat !== null && tmpStat.isDirectory() && quiet) {
    const names2 = readdirSync(tmp);
    result.tmp.bytes = names2.reduce((n, f) => n + sizeOf(join(tmp, f)), 0);
    if (!apply && result.candidates.length > 0) {
      result.tmp.planned = names2.length > 0;
      result.bytesEstimate += result.tmp.bytes;
    } else if (apply && result.removed.length > 0 && names2.length > 0) {
      for (const f of names2) rmSync(join(tmp, f), { recursive: true, force: true });
      result.tmp.removed = true;
      result.bytesFreed += result.tmp.bytes;
    }
  }
  return result;
}

const human = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : (n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`));

/**
 * The list of a cleanup, for the owner: what goes, what stays and why, the space.
 * @param {ReturnType<typeof cleanup>} result
 * @returns {string}
 */
export function formatCleanup(result) {
  const out = [];
  const done = result.apply;
  const list = done ? result.removed : result.candidates;
  out.push(done ? `Removed (${list.length}):` : `Would remove (${list.length}):`);
  if (list.length === 0) out.push('  nothing');
  for (const c of list) {
    const what = [];
    if (c.worktree !== null) what.push(`worktree ${c.worktree}`);
    if (done ? c.local : c.local !== null) what.push('local branch');
    if (done ? c.remote : c.remote !== null) what.push('remote branch');
    for (const a of c.artifacts ?? []) what.push(a);
    out.push(`  ${c.repo === undefined ? '' : `${c.repo}: `}${c.slice} ${c.branch}: ${what.join(', ') || 'nothing left'}${c.bytes > 0 ? `, ${human(c.bytes)}${c.caches > 0 ? ` (${human(c.caches)} of caches and installed dependencies)` : ''}` : ''}`);
  }
  out.push('', `Kept (${result.kept.length}):`);
  if (result.kept.length === 0) out.push('  nothing');
  for (const k of result.kept) out.push(`  ${k.repo === undefined ? '' : `${k.repo}: `}${k.slice} ${k.branch}: ${k.reasons.join('; ')}`);
  if (result.tmp !== undefined) {
    if (result.tmp.removed) out.push('', `tmp/ emptied (${human(result.tmp.bytes)}).`);
    else if (result.tmp.planned) out.push('', `tmp/ would be emptied (${human(result.tmp.bytes)}).`);
    else if (result.kept.length > 0) out.push('', 'tmp/ kept: a slice is still open.');
  }
  for (const w of result.warnings) out.push('', `Warning: ${w}`);
  out.push('');
  if (done) out.push(`Freed ${human(result.bytesFreed)}${result.gc ? ' (git gc ran)' : ''}.`);
  else out.push(`Dry run: about ${human(result.bytesEstimate)} would be freed, nothing changed. Run again with --apply once the owner agrees.`);
  return `${out.join('\n')}\n`;
}
