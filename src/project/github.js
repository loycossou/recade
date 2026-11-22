import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { loadState, saveState } from '../state.js';
import { findPlan } from './plan.js';
import { checkSlices } from './slices.js';
import { parseLots, parseStories, storyBody, storyOfBody } from './backlog.js';
import { slugify } from './scaffold.js';

/**
 * @typedef {(cmd: string, args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} Exec
 * @typedef {{repo: string|null, project: number|null, created: string[], planned: string[], warnings: string[], error: string|null}} GithubResult
 */

/**
 * The board fields of spec 10.9. `kind` tells how to create the field and how to write a value into it.
 * Single-select options listed here are only used to create a field that is missing. The ids of the fields
 * and of their options are always read back from the board.
 */
export const FIELDS = Object.freeze([
  { name: 'Status', kind: 'select', options: ['Backlog', 'Ready', 'In progress', 'In review', 'Done'] },
  { name: 'Increment', kind: 'text' },
  { name: 'Sprint', kind: 'iteration' },
  { name: 'Lane', kind: 'select', options: ['sensitive', 'standard', 'no-code'] },
  { name: 'Points', kind: 'number' },
  { name: 'Priority', kind: 'select', options: ['P0', 'P1', 'P2', 'P3'] },
  { name: 'Due', kind: 'date' },
  { name: 'Owner', kind: 'text' },
  { name: 'Epic', kind: 'text' },
]);

// ---- epics: one issue for each lot of the PLAN ----

/** The label of an epic issue. */
export const EPIC_LABEL = 'epic';
/** The marker that makes an issue the epic of a lot: Recade finds its epics by it, and only by it. */
export const epicMarker = (code) => `<!-- recade:epic ${code} -->`;
const EPIC_MARK = /<!-- recade:epic ([A-Z][A-Z0-9]*) -->/;
/** The lot code of an epic issue body, or null for any other issue. */
export const epicCode = (body) => EPIC_MARK.exec(String(body ?? ''))?.[1] ?? null;
const STORY_IN_TEXT = /\b[A-Z][A-Z0-9]*-\d{2,3}\b/g;

/** The section `## <name>` of a sheet, as text, without its comments. */
function sheetSection(text, name) {
  const lines = String(text).replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(l));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/**
 * The epics of a project, from the PLAN and the slice sheets as they are now. A lot is a code of the `## Lots` table of the
 * PLAN (with its name and goal) or of a backlog story. Its stories are the backlog rows of that code. A slice sits under the
 * lot of the first story its Scope cites, and the other lots it serves are named in `also`. A slice that cites no story has no epic.
 * @param {string} root
 * @returns {{file: string|null, lots: {code: string, name: string, goal: string, stories: {id: string, title: string}[], slices: {id: string, title: string}[], servedBy: string[]}[],
 *   lotOf: Map<string, string>, also: Map<string, string[]>, sliceLots: Map<string, string[]>}}
 */
export function epicPlan(root) {
  const found = findPlan(root);
  const stories = found === null ? [] : parseStories(found.text);
  const table = found === null ? new Map() : parseLots(found.text);
  const codes = [...new Set([...table.keys(), ...stories.map((s) => s.lot)])];
  const lots = codes.map((code) => ({
    code,
    name: table.get(code)?.name || stories.find((s) => s.lot === code && s.lotName !== '')?.lotName || '',
    goal: table.get(code)?.goal ?? '',
    stories: stories.filter((s) => s.lot === code).map((s) => ({ id: s.id, title: s.title })),
    slices: [],
    servedBy: [],
  }));
  const byCode = new Map(lots.map((l) => [l.code, l]));
  const storyLot = new Map(stories.map((s) => [s.id, s.lot]));
  const lotOf = new Map(stories.map((s) => [s.id, s.lot]));
  const also = new Map();
  const sliceLots = new Map();
  for (const s of checkSlices(root).status) {
    let text = '';
    try {
      text = readFileSync(join(root, s.file), 'utf8');
    } catch { /* an unreadable sheet has no epic */ }
    const served = [...new Set((sheetSection(text, 'Scope').match(STORY_IN_TEXT) ?? []).filter((id) => storyLot.has(id)).map((id) => storyLot.get(id)))];
    sliceLots.set(s.id, served);
    if (served.length === 0) continue;
    lotOf.set(s.id, served[0]);
    also.set(s.id, served.slice(1));
    byCode.get(served[0]).slices.push({ id: s.id, title: s.title });
    for (const code of served.slice(1)) byCode.get(code).servedBy.push(s.id);
  }
  return { file: found?.file ?? null, lots, stories, lotOf, also, sliceLots };
}

/** The title of the epic of a lot: its code in brackets and its name. */
export const epicTitle = (lot) => `[${lot.code}] ${lot.name || `Lot ${lot.code}`}`;

/** The body of the epic of a lot: the marker, the goal, the stories and the slices. Rebuilt the same way each time. */
export function epicBody(lot, plan) {
  const out = [epicMarker(lot.code), `Epic of the lot ${lot.code}${lot.name ? ` (${lot.name})` : ''}, from ${plan.file ?? 'the PLAN'}.`, ''];
  out.push(lot.goal ? `Goal: ${lot.goal}` : 'Goal: the PLAN gives none yet.', '');
  out.push('Stories:', ...(lot.stories.length > 0 ? lot.stories.map((s) => `- ${s.id} ${s.title}`) : ['- none yet']), '');
  out.push('Slices:', ...(lot.slices.length > 0 ? lot.slices.map((s) => `- ${s.id} ${s.title}`) : ['- none yet']));
  if (lot.servedBy.length > 0) out.push('', `Also served by: ${lot.servedBy.map((id) => `${id} (under ${plan.lotOf.get(id)})`).join(', ')}.`);
  return out.join('\n');
}

/**
 * Did Recade write this issue for this story or slice? A story issue carries the story marker, or the one-line body of
 * earlier versions; a slice issue carries its `[ID]` title and the body Recade writes. Only such an issue is ever edited.
 */
function madeByRecade(issue, t) {
  if (issue === null || !Number.isInteger(issue.number) || typeof issue.body !== 'string') return false;
  if (t.story && storyOfBody(issue.body) === t.id) return true;
  const titled = typeof issue.title === 'string' && (issue.title === `[${t.id}]` || issue.title.startsWith(`[${t.id}] `));
  if (!titled) return false;
  return t.story ? issue.body.startsWith(`Backlog story ${t.id} of `) && storyOfBody(issue.body) === null : issue.body.startsWith('Slice sheet ');
}

/** The body of the issue of a slice. A slice that serves several lots names the others. */
const sliceBody = (file, others) => `Slice sheet ${file}.${others.length > 0 ? ` It also serves the lot${others.length === 1 ? '' : 's'} ${others.join(', ')}.` : ''}`;

/**
 * The gh call that attaches an issue to its epic as a sub-issue (REST: POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues
 * with the numeric id of the sub-issue). `replace` moves an issue that already has a parent. Every sub-issue write goes through here.
 */
export const subIssueArgs = (repo, epicNumber, subIssueId, replace = false) => [
  'api', '--method', 'POST', `repos/${repo}/issues/${epicNumber}/sub_issues`, '-F', `sub_issue_id=${subIssueId}`,
  ...(replace ? ['-F', 'replace_parent=true'] : []),
];

const DATA_TYPE = { text: 'TEXT', number: 'NUMBER', date: 'DATE', select: 'SINGLE_SELECT' };
const SIZE_POINTS = { S: 1, M: 2, L: 3 };
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** A code repository name of the registry: the folder under repos/. */
const CODE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NOT_FOUND = /could not resolve|not found|404/i;

/** The most items any list call asks for. A list that fills it may be cut off, so the run stops instead of working on part of GitHub. */
const LIST_LIMIT = 1000;
/** The URL of an issue of a GitHub repository: how a slice is linked to an issue of an adopted code repository. */
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})\/issues\/([1-9]\d{0,9})$/;
const FIELD_LIMIT = 100;

/** Stop on a list that reached its limit: gh cuts it silently, and Recade must never match, link or create on a truncated view. */
function complete(list, limit, what) {
  if (list.length >= limit) throw new GhError(`gh returned ${list.length} ${what}, which is the limit. Recade will not work on a list that may be cut off: close or archive some, then run this again.`);
  return list;
}

/** A failed call. The message is one line. */
class GhError extends Error {}

/** The first non-empty line of a text. */
const firstLine = (text) => String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';

/** A command line for display, with the arguments that need it in single quotes. */
const show = (args, cmd = 'gh') => [cmd, ...args].map((a) => (/^[\w@%+=:,./<>\[\]-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(' ');

const asArray = (data, key) => (Array.isArray(data) ? data : (Array.isArray(data?.[key]) ? data[key] : []));

/** The project name: `project:` of the PLAN, or the slug in words. */
function projectName(root, slug) {
  try {
    const text = (findPlan(root)?.text ?? '').replace(/^\uFEFF/, '');
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const name = m ? parse(m[1])?.project : null;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  } catch { /* no PLAN yet: use the slug */ }
  // The folder of a workspace is `<slug>-workspace`: the board is the delivery board of the project, not of the folder.
  return slug.replace(/-workspace$/, '').split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Project';
}

/** The things that become issues: each backlog story of the PLAN, then each slice. `epics` (from `epicPlan`) adds the Epic value. */
function targets(root, epics = null) {
  const out = [];
  const found = findPlan(root);
  // No PLAN: only the slices. A story carries what the PLAN says of it, and its board fields follow the PLAN.
  const lotName = (story) => epics?.lots.find((l) => l.code === story.lot)?.name ?? story.lotName;
  for (const s of found === null ? [] : parseStories(found.text)) {
    const values = { Status: 'Backlog' };
    if (s.points !== null) values.Points = s.points;
    if (s.priority !== '') values.Priority = s.priority;
    if (s.increment !== '') values.Increment = s.increment;
    out.push({ id: s.id, title: s.title, body: storyBody(s, found.file, lotName(s)), values, story: true, follow: ['Points', 'Priority', 'Increment', 'Epic'] });
  }
  for (const s of checkSlices(root).status) {
    const values = { Status: 'Backlog' };
    if (String(s.lane).trim() !== '') values.Lane = String(s.lane).trim();
    if (String(s.increment).trim() !== '') values.Increment = String(s.increment).trim();
    if (SIZE_POINTS[String(s.size).trim()] !== undefined) values.Points = SIZE_POINTS[String(s.size).trim()];
    out.push({ id: s.id, title: s.title, body: sliceBody(s.file, epics?.also.get(s.id) ?? []), values, slice: true, follow: ['Epic'] });
  }
  if (epics !== null) for (const t of out) if (epics.lotOf.has(t.id)) t.values.Epic = epics.lotOf.get(t.id);
  return out;
}

/**
 * Create the private repository, the project board, its fields and one issue for each backlog story and each
 * slice, then add each issue to the board with its field values. Every object is looked up before it is created,
 * so a rerun after a failure creates only what is missing. A value already on the board is never overwritten.
 * The state records only the owner, the repository and the project (`github:` with owner, repo, project_number),
 * after each one is known. A recorded repository name and project number are used first, so a renamed folder
 * or a renamed PLAN project does not make a second repository or board; the board is looked up by its title
 * only when there is no record. There is no per-object state: a rerun finds the issues and items again by reading GitHub.
 * The first push needs a commit. Without one the run stops before any write (a dry run plans the commit); when the repository exists but
 * its remote has no branch yet, the run pushes.
 * On a failed call the run stops: `error` holds one line and `created` what was made before it.
 * With `dryRun`, only read calls run and `planned` holds the write calls that would follow.
 * In a workspace (`kind: workspace`) the repository, the board and the issues are those of the workspace, and the
 * workspace repository is always private. `repos` names the code repositories of the registry that the owner said yes to,
 * one yes each: each one is created after the workspace repository, with the `visibility` of its entry, as
 * `<owner>/<project>-<name>`, pushed, and its remote recorded in the registry. A code repository whose remote is already a
 * GitHub repository is only checked (never created, never pushed to), and one whose remote is elsewhere is skipped with
 * a warning. The issues always land on the workspace repository: a slice sheet is private and never reaches a code repository.
 * The epics come with the issues: the label `epic`, one epic issue for each lot of the PLAN (`epicPlan`), each story and slice
 * issue under the epic of its lot as a sub-issue, and the `Epic` field. The title and the body of an epic, and of a story or slice
 * issue Recade wrote, follow the documents, as do the `Epic` field and the `Points`, `Priority` and `Increment` of a story. The epic
 * of a lot that left the PLAN is closed with a comment, never deleted. An issue Recade did not write is never edited; a linked
 * one is only put under its epic.
 * With `sync` (`recade github sync`), the repository and the board must be recorded already: nothing is created or pushed but
 * the epics, the issues, the items and the links that the documents call for.
 * @param {string} root the project folder (its name is the repository name)
 * @param {{owner: string, exec: Exec, dryRun?: boolean, repos?: string[], sync?: boolean}} options
 * @returns {Promise<GithubResult>}
 */
export async function initGithub(root, { owner, exec, dryRun = false, repos = [], sync = false }) {
  const created = [];
  const planned = [];
  const warnings = [];
  const result = { repo: null, project: null, codeRepos: [], created, planned, warnings, error: null };
  const slug = slugify(basename(root));
  if (typeof owner !== 'string' || !OWNER.test(owner)) {
    result.error = `Invalid GitHub owner: ${owner}. Use letters, digits and hyphens.`;
    return result;
  }
  if (slug === '') {
    result.error = `Cannot make a repository name from the folder ${basename(root)}.`;
    return result;
  }
  const state0 = loadState(root);
  const isWorkspace = state0?.kind === 'workspace';
  const registry = isWorkspace && Array.isArray(state0.repos) ? state0.repos.filter((e) => e !== null && typeof e === 'object') : [];
  const wanted = [];
  if (repos.length > 0 && !isWorkspace) {
    result.error = 'Code repositories belong to a workspace, and this project is not one.';
    return result;
  }
  for (const name of new Set(repos)) {
    const entry = registry.find((e) => e.name === name);
    if (entry === undefined) {
      result.error = `${name} is not in the registry of this workspace. List it with: recade repo list`;
      return result;
    }
    const visibility = String(entry.visibility ?? 'private');
    if (!['private', 'public', 'internal'].includes(visibility)) {
      result.error = `The visibility of ${name} in the registry is ${visibility}. Use private, public or internal.`;
      return result;
    }
    // The registry can be edited by hand: the name and the GitHub name are checked again, before any gh or git call, so that
    // a value like `--x` or `../x` never reaches a command line or a folder path.
    if (typeof name !== 'string' || !CODE_NAME.test(name) || name === 'workspace') {
      result.error = `${JSON.stringify(name)} is not a repository name of the registry (lowercase words joined by hyphens). Fix recade/state.yaml.`;
      return result;
    }
    const remote = typeof entry.remote === 'string' ? entry.remote.trim() : 'none';
    const own = remote === '' || remote === 'none';
    let full = `${owner}/${slug.replace(/-workspace$/, '') || slug}-${name}`;
    if (!own) {
      const m = GITHUB_REMOTE.exec(remote);
      if (m === null) {
        warnings.push(`${name}: the remote ${remote} is not a GitHub remote, so no repository is created for it.`);
        continue;
      }
      full = `${m[1]}/${m[2]}`;
    }
    if (!REPO_NAME.test(full)) {
      result.error = `${full} is not a GitHub repository name (the remote of ${name}). Fix recade/state.yaml.`;
      return result;
    }
    wanted.push({ ...entry, visibility, own, full });
  }
  // The record of an earlier run wins over the folder name and the project title: a renamed folder or a renamed
  // PLAN project must not make a second repository or a second board.
  const recorded = state0?.github ?? {};
  const repoName = typeof recorded.repo === 'string' && recorded.repo !== '' ? recorded.repo : slug;
  const repo = `${owner}/${repoName}`;
  if (!REPO_NAME.test(repo)) {
    result.error = `${repo} is not a GitHub repository name. Fix github.repo in recade/state.yaml.`;
    return result;
  }
  const AUTH_HINT = 'If this is an authentication problem, run `gh auth setup-git`, then run this again.';

  const call = async (args) => {
    try {
      const r = await exec('gh', args);
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    } catch (err) {
      return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
    }
  };
  const gitIn = async (dir, args) => {
    try {
      const r = await exec('git', ['-C', dir, ...args]);
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    } catch (err) {
      return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
    }
  };
  const git = (args) => gitIn(root, args);
  let commitPlanned = false;
  const needCommit = async (dir = root, label = null) => {
    if ((await gitIn(dir, ['rev-parse', 'HEAD'])).code === 0) return;
    if (label !== null) throw new GhError(`The code repository ${label} has no commit yet. Commit its files, then run this again.`);
    if (dryRun) {
      // The command that runs this step makes the commit itself, so a dry run only plans it.
      if (!commitPlanned) {
        planned.push(`${show(['-C', root, 'add', '-A'], 'git')} (the project has no commit yet)`);
        planned.push(show(['-C', root, 'commit', '-m', 'chore: initial project documents'], 'git'));
        commitPlanned = true;
      }
      return;
    }
    throw new GhError('The project has no commit yet. Commit the project files (git add -A, then git commit), then run this again.');
  };
  const fail = (args, r) => new GhError(`gh ${args.slice(0, 2).join(' ')} failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  const read = async (args) => {
    const r = await call(args);
    if (r.code !== 0) throw fail(args, r);
    return r.stdout;
  };
  const readJson = async (args) => {
    const out = await read(args);
    try {
      return JSON.parse(out);
    } catch {
      throw new GhError(`gh ${args.slice(0, 2).join(' ')} did not print JSON.`);
    }
  };
  /** A write call. In a dry run it only records the line and returns null. */
  const write = async (args, note = '') => {
    if (dryRun) {
      planned.push(show(args) + note);
      return null;
    }
    return read(args);
  };
  const record = (patch) => {
    if (dryRun) return;
    const state = loadState(root);
    if (state === null) throw new GhError('Cannot record the board: recade/state.yaml not found.');
    const github = { ...(state.github ?? {}), ...patch };
    if (JSON.stringify(github) !== JSON.stringify(state.github ?? {})) saveState(root, { ...state, github });
  };
  /** The remote of a code repository once its GitHub repository exists, in the registry of the workspace. */
  const recordRemote = (name, url) => {
    const state = loadState(root);
    if (state === null) throw new GhError('Cannot record the repository: recade/state.yaml not found.');
    const list = Array.isArray(state.repos) ? state.repos : [];
    saveState(root, { ...state, repos: list.map((e) => (e?.name === name ? { ...e, remote: url } : e)) });
  };

  try {
    // The owner is kept in the state (the one given on the command line is read first the next time).
    if (recorded.owner !== owner) record({ owner });

    // Repository. `ensure` finds the repository `full` on GitHub or creates it from the folder `dir` and pushes the first
    // commit. A repository that exists but whose remote holds no branch yet (a run stopped before the push) is pushed.
    // `manage: false` is a repository that already has its own remote: it is only looked at, never pushed to.
    const ensure = async ({ full, dir, visibility, label = null, manage = true, mayCreate = true }) => {
      let exists = false;
      const view = await call(['repo', 'view', full, '--json', 'name,visibility']);
      if (view.code === 0) {
        exists = true;
        let actual = null;
        try {
          actual = JSON.parse(view.stdout).visibility;
        } catch { /* an unreadable answer is treated as private by the next check */ }
        if (typeof actual === 'string' && actual.toUpperCase() !== visibility.toUpperCase()) {
          if (label === null) throw new GhError(`The repository ${full} exists and is not private. Recade only uses private repositories.`);
          const leaks = visibility === 'private' || (visibility === 'internal' && actual.toUpperCase() === 'PUBLIC');
          const text = `The repository ${full} is ${actual.toLowerCase()}, and the registry says ${visibility} for ${label}.`;
          if (leaks) throw new GhError(`${text} Change the visibility on GitHub or in the registry, then run this again.`);
          warnings.push(text);
        }
      } else if (!NOT_FOUND.test(view.stderr)) {
        throw fail(['repo', 'view'], view);
      } else if (!mayCreate) {
        throw new GhError(`The repository ${full}, named by the remote of ${label}, does not exist on GitHub.`);
      }
      if (!exists) {
        await needCommit(dir, label);
        try {
          await write(['repo', 'create', full, `--${visibility}`, '--source', dir, '--push']);
        } catch (err) {
          throw new GhError(`${firstLine(err.message)} ${AUTH_HINT}`);
        }
        if (!dryRun) created.push(`repo ${full}`);
      } else if (manage) {
        const origin = await gitIn(dir, ['remote', 'get-url', 'origin']);
        let emptyRemote;
        const remoteUrl = `https://github.com/${full}.git`;
        if (origin.code !== 0) {
          await needCommit(dir, label);
          // No origin here: whatever the repository holds was not put there by this folder. Never push over it.
          const refs = await gitIn(dir, ['ls-remote', '--heads', remoteUrl]);
          if (refs.code !== 0) throw new GhError(`git ls-remote failed: ${firstLine(refs.stderr) || `exit ${refs.code}`}. ${AUTH_HINT}`);
          if (refs.stdout.trim() !== '') {
            throw new GhError(`The repository ${full} already exists on GitHub and already has branches, and ${label ?? 'this folder'} has no origin. Recade does not push over it. Check it, then add it yourself with: git remote add origin ${remoteUrl}`);
          }
          if (dryRun) planned.push(show(['-C', dir, 'remote', 'add', 'origin', remoteUrl], 'git'));
          else {
            const added = await gitIn(dir, ['remote', 'add', 'origin', remoteUrl]);
            if (added.code !== 0) throw new GhError(`git remote add failed: ${firstLine(added.stderr) || `exit ${added.code}`}`);
          }
          emptyRemote = true;
        } else {
          const refs = await gitIn(dir, ['ls-remote', '--heads', 'origin']);
          if (refs.code !== 0) throw new GhError(`git ls-remote failed: ${firstLine(refs.stderr) || `exit ${refs.code}`}. ${AUTH_HINT}`);
          emptyRemote = refs.stdout.trim() === '';
        }
        if (emptyRemote) {
          await needCommit(dir, label);
          if (dryRun) planned.push(show(['-C', dir, 'push', '-u', 'origin', 'HEAD'], 'git'));
          else {
            const pushed = await gitIn(dir, ['push', '-u', 'origin', 'HEAD']);
            if (pushed.code !== 0) throw new GhError(`git push failed: ${firstLine(pushed.stderr) || `exit ${pushed.code}`}. ${AUTH_HINT}`);
            created.push(`push ${full}`);
          }
        }
      }
      return exists;
    };
    // The workspace repository, and a project that is not a workspace, are always private. A sync never creates or pushes:
    // the repository and the board must be the ones `recade github init` recorded.
    let repoExists = true;
    if (sync) {
      if (typeof recorded.repo !== 'string' || !Number.isInteger(recorded.project_number)) throw new GhError('No board is recorded in recade/state.yaml. Run recade github init first.');
      const view = await readJson(['repo', 'view', repo, '--json', 'name,visibility']);
      if (typeof view?.visibility === 'string' && view.visibility.toUpperCase() !== 'PRIVATE') throw new GhError(`The repository ${repo} is not private. Recade only uses private repositories.`);
    } else repoExists = await ensure({ full: repo, dir: root, visibility: 'private' });
    result.repo = repo;
    record({ owner, repo: repoName });

    // The code repositories the owner said yes to, one yes each, after the workspace repository.
    for (const entry of sync ? [] : wanted) {
      const { full, own } = entry;
      const dir = join(root, 'repos', entry.name);
      await ensure({ full, dir, visibility: entry.visibility, label: entry.name, manage: own, mayCreate: own });
      if (own && !dryRun) recordRemote(entry.name, `https://github.com/${full}.git`);
      result.codeRepos.push({ name: entry.name, repo: full });
    }

    // Project
    const title = `${projectName(root, slug)} delivery`;
    let project = null;
    if (Number.isInteger(recorded.project_number)) {
      // A board recorded by an earlier run is read by its number, whatever its title is now.
      project = await readJson(['project', 'view', String(recorded.project_number), '--owner', owner, '--format', 'json']);
      if (project === null || typeof project !== 'object' || project.number === undefined) {
        throw new GhError('gh project view did not print the board.');
      }
    } else {
      const projects = complete(asArray(await readJson(['project', 'list', '--owner', owner, '--closed', '--format', 'json', '--limit', String(LIST_LIMIT)]), 'projects'), LIST_LIMIT, 'boards');
      project = projects.find((p) => p.title === title) ?? null;
    }
    if (project !== null && project.closed === true) {
      warnings.push(`The board ${project.number} is closed. Reopen it with: gh project close ${project.number} --owner ${owner} --undo`);
    }
    if (project === null) {
      const out = await write(['project', 'create', '--owner', owner, '--title', title, '--format', 'json']);
      if (!dryRun) {
        try {
          project = JSON.parse(out);
        } catch {
          throw new GhError('gh project create did not print JSON.');
        }
        created.push(`project ${project.number}`);
      }
    }
    const projectRef = project?.number ?? '<project>';
    if (project !== null) {
      result.project = project.number;
      record({ project_number: project.number });
    }
    const real = project !== null; // the board exists on GitHub, so it can be read

    // Fields. The items are read first: they decide whether the Status options can be changed.
    const items = real ? complete(asArray(await readJson(['project', 'item-list', String(project.number), '--owner', owner, '--format', 'json', '--limit', String(LIST_LIMIT)]), 'items'), LIST_LIMIT, 'board items') : [];
    const listFields = async () => complete(asArray(
      await readJson(['project', 'field-list', String(project.number), '--owner', owner, '--format', 'json', '--limit', String(FIELD_LIMIT)]),
      'fields',
    ), FIELD_LIMIT, 'board fields');
    let fields = real ? await listFields() : [];
    const named = (name) => fields.find((f) => String(f.name).toLowerCase() === name.toLowerCase());
    const hasBacklog = (f) => asArray(f, 'options').some((o) => String(o.name).toLowerCase() === 'backlog');
    const addBacklog = async (statusField) => {
      // Only on a board without items: the options are written again, so their ids change.
      const names = ['Backlog', ...asArray(statusField, 'options').map((o) => String(o.name)).filter((n) => n.toLowerCase() !== 'backlog')];
      const options = names.map((n) => `{name: "${n.replace(/[\r\n]+/g, ' ').replaceAll('\\', '').replaceAll('"', '').trim()}", color: GRAY, description: ""}`).join(', ');
      await write(['api', 'graphql', '-f',
        `query=mutation($field: ID!) { updateProjectV2Field(input: {fieldId: $field, singleSelectOptions: [${options}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
        '-f', `field=${statusField?.id ?? '<Status>'}`]);
      if (!dryRun) created.push('field Status option Backlog');
    };
    let changed = false;
    for (const spec of FIELDS) {
      const f = named(spec.name);
      if (f === undefined && spec.name === 'Status' && !real) {
        // GitHub gives every new project a Status field. Only the Backlog option is added to it.
        await addBacklog(null);
      } else if (f === undefined) {
        if (spec.kind === 'iteration') {
          await write(['api', 'graphql', '-f',
            'query=mutation($project: ID!) { createProjectV2Field(input: {projectId: $project, dataType: ITERATION, name: "Sprint"}) { projectV2Field { ... on ProjectV2IterationField { id } } } }',
            '-f', `project=${real ? project.id : '<project id>'}`]);
        } else {
          const args = ['project', 'field-create', String(projectRef), '--owner', owner, '--name', spec.name,
            '--data-type', DATA_TYPE[spec.kind]];
          if (spec.kind === 'select') args.push('--single-select-options', spec.options.join(','));
          args.push('--format', 'json');
          await write(args);
        }
        if (!dryRun) created.push(`field ${spec.name}`);
        changed = true;
      } else if (spec.name === 'Status' && !hasBacklog(f)) {
        if (items.length > 0) {
          throw new GhError('The Status field has no "Backlog" option and the board already has items. Add a "Backlog" option to Status by hand in the board settings, then run this again.');
        }
        await addBacklog(f);
        changed = true;
      }
    }
    if (changed && !dryRun) fields = await listFields();

    // Issues and items. The issues are listed once and matched here by the exact [ID] prefix, the epics by their marker.
    const issues = repoExists
      ? complete(asArray(await readJson(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', String(LIST_LIMIT), '--json', 'number,title,url,body,state'])), LIST_LIMIT, 'issues')
      : [];
    const epics = epicPlan(root);
    const inPlan = new Set(epics.lots.map((l) => l.code));
    /** The epic issue of each lot code, open or closed: only an issue with the marker, so only one Recade created. */
    const epicIssues = new Map();
    for (const i of issues) {
      const code = epicCode(i.body);
      if (code !== null && !epicIssues.has(code)) epicIssues.set(code, i);
    }
    /** Add an issue to the board when it is not there, and keep its Epic value in line. */
    const placeEpic = async (issue, ref, code) => {
      let item = issue === null ? null : (items.find((i) => i.content?.url === issue.url) ?? null);
      if (item === null) {
        const out = await write(['project', 'item-add', String(projectRef), '--owner', owner, '--url', issue?.url ?? `<issue ${ref}>`, '--format', 'json']);
        if (!dryRun) {
          try {
            item = { ...JSON.parse(out), content: { url: issue.url } };
          } catch {
            throw new GhError('gh project item-add did not print JSON.');
          }
          items.push(item);
          created.push(`item ${ref}`);
        }
      }
      if (item?.epic === code) return;
      if (dryRun) {
        planned.push(`${show(['project', 'item-edit', '--id', `<item ${ref}>`, '--project-id', '<project id>', '--field-id', '<Epic>'])} (Epic = ${code})`);
        return;
      }
      const field = named('Epic');
      if (field === undefined) throw new GhError('The board has no Epic field.');
      await write(['project', 'item-edit', '--id', item.id, '--project-id', project.id, '--field-id', field.id, '--text', code]);
      item.epic = code;
    };
    const numberOf = (url) => Number(/\/issues\/(\d+)$/.exec(String(url ?? ''))?.[1] ?? NaN);
    if (epics.lots.length > 0) {
      // The label first: an issue cannot be created with a label that does not exist.
      const labels = repoExists ? complete(asArray(await readJson(['label', 'list', '--repo', repo, '--json', 'name', '--limit', String(LIST_LIMIT)])), LIST_LIMIT, 'labels') : [];
      if (!labels.some((l) => String(l?.name).toLowerCase() === EPIC_LABEL)) {
        await write(['label', 'create', EPIC_LABEL, '--repo', repo, '--color', '5319E7', '--description', 'A lot of the PLAN, kept by Recade']);
        if (!dryRun) created.push(`label ${EPIC_LABEL}`);
      }
    }
    for (const lot of epics.lots) {
      const title = epicTitle(lot);
      const body = epicBody(lot, epics);
      const ref = `epic ${lot.code}`;
      let issue = epicIssues.get(lot.code) ?? null;
      if (issue === null) {
        const out = await write(['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', EPIC_LABEL]);
        if (!dryRun) {
          const url = firstLine(out.split(/\r?\n/).filter(Boolean).pop());
          if (!/^https:\/\//.test(url)) throw new GhError('gh issue create did not print the issue URL.');
          issue = { url, number: numberOf(url), title, body, state: 'OPEN' };
          epicIssues.set(lot.code, issue);
          created.push(`issue ${ref}`);
        }
      } else {
        // A renamed lot or a changed goal, story list or slice list: the epic follows the PLAN.
        const edit = [];
        if (issue.title !== title) edit.push('--title', title);
        if (String(issue.body ?? '').trim() !== body.trim()) edit.push('--body', body);
        if (edit.length > 0) {
          await write(['issue', 'edit', String(issue.number), '--repo', repo, ...edit]);
          if (!dryRun) {
            Object.assign(issue, { title, body });
            created.push(`update ${ref}`);
          }
        }
      }
      await placeEpic(issue, ref, lot.code);
    }
    // An issue of an adopted repository that the owner linked to a slice (`recade adopt board`) is that slice's issue,
    // whatever its title. It is never renamed, never copied: the slice is added to the board through it.
    const links = recorded.links !== null && typeof recorded.links === 'object' ? recorded.links : {};
    // A link is honoured only for an issue of the workspace repository or of a code repository of this project.
    const linkable = new Set([repo, ...wanted.map((w) => w.full)].map((r) => r.toLowerCase()));
    for (const e of Array.isArray(state0?.repos) ? state0.repos : []) {
      const r = typeof e?.remote === 'string' ? GITHUB_REMOTE.exec(e.remote.trim()) : null;
      if (r !== null) linkable.add(`${r[1]}/${r[2]}`.toLowerCase());
    }
    /** The issue of each story and slice, and the repository it lives in, for the sub-issue links. */
    const placed = new Map();
    for (const t of targets(root, epics)) {
      const prefix = `[${t.id}]`;
      // A story issue is found by its marker first, so a renamed title does not make a second one.
      let issue = (t.story ? issues.find((i) => storyOfBody(i.body) === t.id) : undefined)
        ?? issues.find((i) => typeof i.title === 'string' && (i.title === prefix || i.title.startsWith(`${prefix} `))) ?? null;
      if (issue === null && Number.isInteger(links[t.id])) {
        issue = issues.find((i) => i.number === links[t.id]) ?? null;
        if (issue === null) warnings.push(`${prefix}: the linked issue #${links[t.id]} was not found in ${repo}, so a new issue is created.`);
      } else if (issue === null && typeof links[t.id] === 'string') {
        // An issue of an adopted code repository, linked by its full URL: it is the item of the slice on this board, and
        // no issue is created for the slice, here or in the code repository. It has no number of its own here.
        const m = ISSUE_URL.exec(links[t.id]);
        if (m === null) warnings.push(`${prefix}: the link ${links[t.id]} is not a GitHub issue URL, so it is ignored and the slice gets an issue of its own.`);
        else if (!linkable.has(m[1].toLowerCase())) warnings.push(`${prefix}: the link ${links[t.id]} is not an issue of the workspace repository or of a code repository of this project, so it is ignored and the slice gets an issue of its own.`);
        else issue = { url: links[t.id] };
      }
      const createdNow = issue === null;
      if (issue === null) {
        const out = await write(['issue', 'create', '--repo', repo, '--title', `${prefix} ${t.title}`, '--body', t.body]);
        if (!dryRun) {
          issue = { url: firstLine(out.split(/\r?\n/).filter(Boolean).pop()) };
          if (!/^https:\/\//.test(issue.url)) throw new GhError('gh issue create did not print the issue URL.');
          created.push(`issue ${prefix}`);
        }
      } else if (madeByRecade(issue, t)) {
        // The title and the body Recade wrote follow the PLAN and the sheets. An issue Recade did not write is never edited.
        const edit = [];
        const title = `${prefix} ${t.title}`;
        if (issue.title !== title) edit.push('--title', title);
        if (String(issue.body ?? '').trim() !== t.body.trim()) edit.push('--body', t.body);
        if (edit.length > 0) {
          await write(['issue', 'edit', String(issue.number), '--repo', repo, ...edit]);
          if (!dryRun) {
            Object.assign(issue, { title, body: t.body });
            created.push(`update ${prefix}`);
          }
        }
      }
      placed.set(t.id, { issue, ref: prefix, linked: !createdNow && !madeByRecade(issue, t) });
      let item = issue === null ? null : (items.find((i) => i.content?.url === issue.url
        || (issue.number !== undefined && i.content?.number === issue.number && i.content?.repository === repo)) ?? null);
      const isNew = item === null;
      if (isNew) {
        const out = await write(['project', 'item-add', String(projectRef), '--owner', owner, '--url', issue?.url ?? `<issue ${prefix}>`, '--format', 'json']);
        if (!dryRun) {
          try {
            item = { ...JSON.parse(out), content: { url: issue.url } };
          } catch {
            throw new GhError('gh project item-add did not print JSON.');
          }
          items.push(item);
          created.push(`item ${prefix}`);
        }
      }
      for (const [name, value] of Object.entries(t.values)) {
        const current = item?.[name.toLowerCase()];
        // The Epic value follows the PLAN; any other value already on the board is the owner's and stays.
        if (t.follow.includes(name) ? current === value : (current !== undefined && current !== null && current !== '')) continue;
        if (dryRun) {
          planned.push(`${show(['project', 'item-edit', '--id', `<item ${prefix}>`, '--project-id', '<project id>', '--field-id', `<${name}>`])} (${name} = ${value})`);
          continue;
        }
        const field = named(name);
        if (field === undefined) throw new GhError(`The board has no ${name} field.`);
        const args = ['project', 'item-edit', '--id', item.id, '--project-id', project.id, '--field-id', field.id];
        if (Array.isArray(field.options)) {
          const option = field.options.find((o) => String(o.name).toLowerCase() === String(value).toLowerCase());
          if (option === undefined) {
            warnings.push(`${prefix}: the ${name} field has no option "${value}", so ${name} is left empty.`);
            continue;
          }
          args.push('--single-select-option-id', option.id);
        } else {
          args.push(name === 'Points' ? '--number' : '--text', String(value));
        }
        await write(args);
        item[name.toLowerCase()] = value;
        if (!isNew) created.push(`set ${name} on ${prefix}`);
      }
    }

    // Sub-issues: each story and slice under the epic of its lot. The sub-issues of every epic Recade made are read first, so
    // an issue already in place gets no call, and one under another epic is moved (`replace_parent`), never doubled.
    const parentOf = new Map();
    for (const [code, epic] of epicIssues) {
      if (!Number.isInteger(epic.number)) continue;
      const subs = complete(asArray(await readJson(['api', `repos/${repo}/issues/${epic.number}/sub_issues?per_page=100`])), 100, `sub-issues of the epic ${code}`);
      for (const sub of subs) if (typeof sub?.html_url === 'string') parentOf.set(sub.html_url, code);
    }
    for (const [id, { issue, ref, linked }] of placed) {
      const code = epics.lotOf.get(id);
      const epic = code === undefined ? null : epicIssues.get(code) ?? null;
      if (code === undefined || (issue !== null && parentOf.get(issue.url) === code)) continue;
      const from = issue === null ? undefined : parentOf.get(issue.url);
      if (dryRun && (issue === null || epic === null)) {
        planned.push(show(subIssueArgs(repo, `<epic ${code}>`, `<id of ${ref}>`, from !== undefined)));
        continue;
      }
      // The numeric id of the issue, read from its own repository (an adopted issue may live in a code repository).
      const where = ISSUE_URL.exec(issue.url);
      if (where === null) throw new GhError(`${ref}: ${issue.url} is not a GitHub issue URL.`);
      const subId = firstLine(await read(['api', `repos/${where[1]}/issues/${where[2]}`, '--jq', '.id']));
      if (!/^\d+$/.test(subId)) throw new GhError(`gh api did not print the id of ${ref}.`);
      const args = subIssueArgs(repo, epic.number, subId, from !== undefined);
      if (dryRun) {
        planned.push(show(args));
        continue;
      }
      const r = await call(args);
      if (r.code !== 0) {
        // An adopted issue may already have a parent of its own: Recade does not take it away.
        if (linked) {
          warnings.push(`${ref}: the linked issue ${issue.url} could not be put under the epic ${code} (${firstLine(r.stderr) || `exit ${r.code}`}). Attach it by hand if you want it there.`);
          continue;
        }
        throw fail(args, r);
      }
      parentOf.set(issue.url, code);
      created.push(from === undefined ? `sub-issue ${ref} under epic ${code}` : `move ${ref} from epic ${from} to epic ${code}`);
    }

    // A lot that left the PLAN: its epic is closed with a comment, never deleted. It is reopened if the lot comes back.
    for (const [code, epic] of epicIssues) {
      const open = String(epic.state ?? 'OPEN').toUpperCase() !== 'CLOSED';
      if (!inPlan.has(code) && open) {
        await write(['issue', 'comment', String(epic.number), '--repo', repo, '--body', `The lot ${code} is no longer in ${epics.file ?? 'the PLAN'}, so Recade closes this epic. It is kept, not deleted.`]);
        await write(['issue', 'close', String(epic.number), '--repo', repo, '--reason', 'not planned']);
        if (!dryRun) {
          epic.state = 'CLOSED';
          created.push(`close epic ${code}`);
        }
      }
    }
  } catch (err) {
    result.error = firstLine(err?.message ?? err) || 'Unknown failure.';
  }
  return result;
}

// ---- an existing repository and board (adopt) ----

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const norm = (title) => String(title ?? '').replace(/\[[^\]]*\]/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (title) => new Set(norm(title).split(' ').filter((w) => w.length > 1));
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelNames = (issue) => (Array.isArray(issue.labels) ? issue.labels : []).map((l) => String(l?.name ?? l).toLowerCase());

/** How well an issue fits a slice, 0 when it does not, and by what: the ID in the title, a label, or the words of the title. */
function fit(issue, slice) {
  const id = String(slice.id).toLowerCase();
  if (new RegExp(`(^|[^a-z0-9])${escapeRe(id)}([^a-z0-9]|$)`, 'i').test(String(issue.title ?? ''))) return { score: 1, by: 'title' };
  if (labelNames(issue).some((l) => l === id || l === `slice:${id}` || l === `slice/${id}` || l === `slice-${id}`)) return { score: 0.95, by: 'label' };
  const a = tokens(issue.title);
  const b = tokens(slice.title);
  if (a.size === 0 || b.size === 0) return { score: 0, by: 'title' };
  if (norm(issue.title) === norm(slice.title)) return { score: 0.9, by: 'title' };
  const common = [...a].filter((w) => b.has(w)).length;
  const jaccard = common / (a.size + b.size - common);
  return { score: jaccard >= 0.6 ? jaccard * 0.9 : 0, by: 'title' };
}

/**
 * Propose which slice each open issue belongs to, by the slice ID in the title, a label (`S-02`, `slice:S-02`,
 * `slice/S-02`) or the words of the title. An issue is never matched to two slices, a slice never to two issues,
 * and a tie (an issue that fits two slices equally well, two issues that fit one slice equally well) is left unmatched and
 * listed in `ambiguous`: a guess would be worse than a question.
 * @param {{number: number, title: string, labels?: unknown[]}[]} issues
 * @param {{id: string, title: string}[]} slices
 * @returns {{matched: {issue: number, slice: string, title: string, by: 'title'|'label'}[], unmatched: number[], ambiguous: {issues: number[], slices: string[]}[]}}
 */
export function matchIssues(issues, slices) {
  const tops = [];
  const ambiguous = [];
  const dropped = new Set();
  for (const issue of issues) {
    const mine = slices.map((slice) => ({ issue, slice, ...fit(issue, slice) })).filter((p) => p.score > 0).sort((x, y) => y.score - x.score);
    if (mine.length > 1 && mine[0].score === mine[1].score) {
      const top = mine.filter((p) => p.score === mine[0].score);
      ambiguous.push({ issues: [issue.number], slices: top.map((p) => p.slice.id).sort() });
      dropped.add(issue.number);
    } else tops.push(...mine.slice(0, 1));
  }
  // Two issues that fit one slice equally well (the same title, the same label) are a question, never the lowest number.
  for (const slice of slices) {
    const mine = tops.filter((p) => p.slice.id === slice.id);
    const best = Math.max(0, ...mine.map((p) => p.score));
    const tied = mine.filter((p) => p.score === best);
    if (tied.length > 1) {
      ambiguous.push({ issues: tied.map((p) => p.issue.number).sort((x, y) => x - y), slices: [slice.id] });
      for (const p of mine) dropped.add(p.issue.number);
    }
  }
  const pairs = tops.filter((p) => !dropped.has(p.issue.number));
  pairs.sort((x, y) => (y.score - x.score) || (x.issue.number - y.issue.number) || (x.slice.id < y.slice.id ? -1 : 1));
  const usedIssues = new Set();
  const usedSlices = new Set();
  const matched = [];
  for (const p of pairs) {
    if (usedIssues.has(p.issue.number) || usedSlices.has(p.slice.id)) continue;
    usedIssues.add(p.issue.number);
    usedSlices.add(p.slice.id);
    matched.push({ issue: p.issue.number, slice: p.slice.id, title: String(p.issue.title ?? ''), by: p.by });
  }
  matched.sort((x, y) => x.issue - y.issue);
  ambiguous.sort((x, y) => x.issues[0] - y.issues[0]);
  return { matched, unmatched: issues.map((i) => i.number).filter((n) => !usedIssues.has(n)).sort((x, y) => x - y), ambiguous };
}

const GITHUB_REMOTE = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/**
 * Read the existing GitHub repository and Projects v2 board of an adopted repository, with `gh`, and propose which open
 * issue belongs to which slice (by ID, label or title) for an owner question. It only reads, with two exceptions that
 * need the owner's answer: `create` makes one project when the repository has none, and `accept` records the matches the
 * owner confirmed (state `github.links`, slice ID to issue number, which `recade github init` honours so that no issue
 * is duplicated and none is renamed). The repository, owner and board are recorded in the state like `recade github init`.
 * Boards are read open and closed: a board is never picked for the owner (the one candidate is proposed in `choose`, with the closed
 * ones, and `suggested` names the one with the title Recade would use), and a second project is never created while any board
 * exists. A public repository is a warning: Recade writes nothing to it here.
 * @param {string} repo the repository folder
 * @param {{exec: Exec, repoName?: string, project?: number, create?: boolean, accept?: {issue: number, slice: string}[]}} options
 *   `repoName` is `owner/name` (otherwise the recorded one, otherwise the GitHub remote `origin`); `project` is the board the owner chose
 * @returns {Promise<{repo: string|null, project_number: number|null, matched: {issue: number, slice: string, title: string, by: string}[], unmatched: number[],
 *   ambiguous: {issues: number[], slices: string[]}[], linked: Record<string, number>, choose: {number: number, title: string, closed: boolean}[], suggested: number|null, needsCreate: boolean, created: boolean, warnings: string[], error: string|null}>}
 */
export async function adoptBoard(repo, { exec, repoName, project, create = false, accept, owner: ownerOption } = {}) {
  const warnings = [];
  const result = { repo: null, project_number: null, matched: [], unmatched: [], ambiguous: [], linked: {}, choose: [], suggested: null, needsCreate: false, created: false, warnings, error: null };
  const call = async (cmd, args) => {
    try {
      const r = await exec(cmd, args);
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    } catch (err) {
      return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
    }
  };
  const read = async (args) => {
    const r = await call('gh', args);
    if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 2).join(' ')} failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    return r.stdout;
  };
  const readJson = async (args) => {
    const out = await read(args);
    try {
      return JSON.parse(out);
    } catch {
      throw new GhError(`gh ${args.slice(0, 2).join(' ')} did not print JSON.`);
    }
  };

  try {
    const state = loadState(repo);
    if (state === null) throw new GhError('No Recade project here: recade/state.yaml not found.');
    const recorded = state.github ?? {};
    // In a workspace the board and the issues of the slices live on the workspace repository, which is private. The issues
    // of a code repository are not read here: a slice sheet never goes to a code repository.
    const isWorkspace = state.kind === 'workspace';
    if (isWorkspace && repoName !== undefined && repoName !== `${recorded.owner}/${recorded.repo}`) {
      throw new GhError('In a workspace the board and the issues are those of the workspace repository. Run recade github init, and leave out --repo.');
    }

    // The repository: the owner's word, then the record, then the remote.
    let full = null;
    if (repoName !== undefined) {
      if (!REPO_NAME.test(repoName)) throw new GhError(`Invalid repository: ${repoName}. Use <owner>/<name>.`);
      full = repoName;
    } else if (typeof recorded.owner === 'string' && typeof recorded.repo === 'string') {
      full = `${recorded.owner}/${recorded.repo}`;
      if (!REPO_NAME.test(full)) throw new GhError(`Invalid repository recorded in recade/state.yaml: ${full}. Fix github.owner and github.repo, or run again with --repo <owner>/<name>.`);
    } else {
      const origin = await call('git', ['-C', repo, 'remote', 'get-url', 'origin']);
      if (origin.code !== 0 && isWorkspace) {
        // A workspace with no GitHub repository yet is matched before `recade github init` creates it: the issues of the code
        // repositories are linked first, so that no issue is created for a slice that already has one.
        full = null;
      } else {
        if (origin.code !== 0) throw new GhError('This repository has no GitHub remote called origin. Run again with --repo <owner>/<name>.');
        const m = GITHUB_REMOTE.exec(origin.stdout.trim());
        if (m === null) throw new GhError('The remote origin is not a GitHub remote. Run again with --repo <owner>/<name>.');
        full = `${m[1]}/${m[2]}`;
        if (!REPO_NAME.test(full)) throw new GhError(`Invalid repository: ${full}. Use <owner>/<name>.`);
      }
    }
    let owner;
    let name = null;
    if (full === null) {
      owner = typeof recorded.owner === 'string' && recorded.owner !== '' ? recorded.owner : ownerOption;
      if (typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) throw new GhError('No GitHub owner. Set it with: recade config set github_owner <name>.');
      warnings.push('The workspace has no GitHub repository yet: recade github init creates it, and adds the linked issues of the code repositories to its board.');
    } else {
      [owner, name] = full.split('/');
      const view = await readJson(['repo', 'view', full, '--json', 'name,visibility']);
      result.repo = full;
      if (isWorkspace && typeof view?.visibility === 'string' && view.visibility.toUpperCase() !== 'PRIVATE') {
        throw new GhError(`The workspace repository ${full} is not private. Recade only uses a private repository for the workspace.`);
      }
      if (typeof view?.visibility === 'string' && view.visibility.toUpperCase() !== 'PRIVATE') {
        warnings.push(`The repository ${full} is ${view.visibility.toLowerCase()}. Recade writes nothing to it here; the harness and the board texts go to a public place, so check that is intended.`);
      }
    }

    // The board: the one the owner chose, or the recorded one. Never one picked for the owner: the candidates, closed
    // boards included, are offered, and a board is recorded only after the answer.
    const wanted = Number.isInteger(project) ? project : (Number.isInteger(recorded.project_number) ? recorded.project_number : null);
    let board = null;
    const listBoards = async () => complete(asArray(await readJson(['project', 'list', '--owner', owner, '--closed', '--format', 'json', '--limit', String(LIST_LIMIT)]), 'projects'), LIST_LIMIT, 'boards');
    if (wanted !== null) {
      board = await readJson(['project', 'view', String(wanted), '--owner', owner, '--format', 'json']);
      if (board === null || typeof board !== 'object' || board.number === undefined) throw new GhError('gh project view did not print the board.');
      // In a workspace `recade github init` has recorded the board already, and the owner may still want one of theirs: the boards are listed.
      if (isWorkspace) result.choose = (await listBoards()).map((p) => ({ number: p.number, title: String(p.title ?? ''), closed: p.closed === true }));
    } else {
      const all = await listBoards();
      result.choose = all.map((p) => ({ number: p.number, title: String(p.title ?? ''), closed: p.closed === true }));
      result.suggested = all.find((p) => p.title === `${projectName(repo, slugify(basename(repo)))} delivery`)?.number ?? null;
      result.needsCreate = all.length === 0;
      if (create && all.length > 0) {
        const named = result.choose.map((c) => `${c.number}${c.closed ? ' (closed)' : ''}`).join(', ');
        throw new GhError(`The owner ${owner} already has a board (${named}). Recade does not create a second one: choose it with --project <number>. A closed board can be reopened with: gh project close <number> --owner ${owner} --undo`);
      }
    }
    if (board !== null && board.closed === true) warnings.push(`The board ${board.number} is closed. Reopen it with: gh project close ${board.number} --owner ${owner} --undo`);

    // The slices and the open issues, minus what the owner already linked. In a workspace the open issues of every
    // registered code repository that has a GitHub remote are read too: an issue of an adopted repository is linked to
    // a slice by its full URL, and a number alone would not tell the repositories apart.
    const slices = checkSlices(repo).status.map((s) => ({ id: s.id, title: s.title }));
    const listOpen = async (target) => complete(asArray(await readJson(['issue', 'list', '--repo', target, '--state', 'open', '--limit', String(LIST_LIMIT), '--json', 'number,title,url,labels'])), LIST_LIMIT, `open issues of ${target}`);
    const pool = full === null ? [] : (await listOpen(full)).map((i) => ({ ...i, repo: null, from: full }));
    const codeRepos = new Map();
    if (isWorkspace) {
      for (const entry of Array.isArray(state.repos) ? state.repos : []) {
        const m = typeof entry?.remote === 'string' ? GITHUB_REMOTE.exec(entry.remote.trim()) : null;
        if (m === null || typeof entry.name !== 'string' || !CODE_NAME.test(entry.name) || entry.name === 'workspace') continue;
        const target = `${m[1]}/${m[2]}`;
        if (!REPO_NAME.test(target)) continue;
        codeRepos.set(entry.name, target);
        for (const i of await listOpen(target)) pool.push({ ...i, repo: entry.name, from: target });
      }
    }
    // One order for everything: the workspace first, then the code repositories by name, each by issue number.
    pool.sort((x, y) => (x.repo === null ? '' : x.repo).localeCompare(y.repo === null ? '' : y.repo) || (x.number - y.number));
    const ref = (p) => (p.repo === null ? p.number : `${p.repo}#${p.number}`);
    const valueOf = (p) => (p.repo === null ? p.number : p.url);
    const links = { ...(recorded.links !== null && typeof recorded.links === 'object' ? recorded.links : {}) };
    const shown = (v) => String(v);
    const picked = (accept ?? []).map((a) => {
      const target = a.repo === undefined ? full : codeRepos.get(a.repo);
      const p = target === undefined || target === null ? undefined : pool.find((i) => i.number === a.issue && i.from === target);
      if (p === undefined && target === null) throw new GhError(`The workspace repository does not exist yet, so issue ${a.issue} must name its code repository, as <repo>#${a.issue}.`);
      if (p === undefined) throw new GhError(a.repo !== undefined && target === undefined
        ? `${a.repo} is not a code repository of this workspace with a GitHub remote.`
        : `Issue ${a.repo === undefined ? a.issue : `${a.repo}#${a.issue}`} is not an open issue of ${target}.`);
      if (typeof p.url !== 'string' || (p.repo !== null && !ISSUE_URL.test(p.url))) throw new GhError(`${ref(p)} has no usable issue URL.`);
      if (!slices.some((s) => s.id === a.slice)) throw new GhError(`${a.slice} is not a slice of this project.`);
      return { slice: a.slice, p, value: valueOf(p) };
    });
    for (const [i, a] of picked.entries()) {
      for (const b of picked.slice(i + 1)) {
        if (a.slice === b.slice && a.value !== b.value) throw new GhError(`${a.slice} is linked to two issues (${ref(a.p)} and ${ref(b.p)}). Choose one.`);
        if (a.value === b.value && a.slice !== b.slice) throw new GhError(`Issue ${ref(a.p)} is linked to two slices (${a.slice} and ${b.slice}). Choose one.`);
      }
      if (links[a.slice] !== undefined && links[a.slice] !== a.value) throw new GhError(`${a.slice} is already linked to issue ${shown(links[a.slice])}.`);
      const holder = Object.entries(links).find(([, v]) => v === a.value);
      if (holder !== undefined && holder[0] !== a.slice) throw new GhError(`Issue ${ref(a.p)} is already linked to ${holder[0]}.`);
    }
    for (const a of picked) links[a.slice] = a.value;
    result.linked = links;
    const linkedValues = new Set(Object.values(links));
    const open = pool.filter((p) => !linkedValues.has(valueOf(p)));
    // matchIssues keys its issues by number: each gets a number of its own here, in the order above, and is named back after.
    const proposal = matchIssues(open.map((p, k) => ({ number: k + 1, title: p.title, labels: p.labels })), slices.filter((s) => links[s.id] === undefined));
    const back = (k) => open[k - 1];
    result.matched = proposal.matched.map((m) => ({ issue: back(m.issue).number, repo: back(m.issue).repo, url: back(m.issue).url, slice: m.slice, title: m.title, by: m.by }));
    result.unmatched = proposal.unmatched.map((k) => ref(back(k)));
    result.ambiguous = proposal.ambiguous.map((x) => ({ issues: x.issues.map((k) => ref(back(k))), slices: x.slices }));

    // Writes: the only one on GitHub is the project, and only on the owner's yes.
    if (create && board === null && result.needsCreate) {
      const title = `${projectName(repo, slugify(basename(repo)))} delivery`;
      const out = await read(['project', 'create', '--owner', owner, '--title', title, '--format', 'json']);
      try {
        board = JSON.parse(out);
      } catch {
        throw new GhError('gh project create did not print JSON.');
      }
      result.created = true;
      result.needsCreate = false;
    }
    if (board !== null) result.project_number = board.number;
    const github = { ...recorded, owner, ...(name === null ? {} : { repo: name }), ...(board === null ? {} : { project_number: board.number }), ...(Object.keys(links).length > 0 ? { links } : {}) };
    if (JSON.stringify(github) !== JSON.stringify(state.github ?? {})) saveState(repo, { ...state, github });
  } catch (err) {
    result.error = firstLine(err?.message ?? err) || 'Unknown failure.';
  }
  return result;
}
