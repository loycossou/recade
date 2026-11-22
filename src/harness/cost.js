import * as nodeFs from 'node:fs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadState } from '../state.js';
import { firstSliceLine } from '../project/state.js';
import { registryNames } from '../project/touches.js';
import { checkSlices } from '../project/slices.js';
import { listProvisionals } from '../project/provisionals.js';
import { listAllQuarantine, dueForIncrementAll } from './quarantine.js';
import { fillTemplate, localToday, readTemplate } from '../project/template.js';
import { defaultExec } from './stamps.js';

/**
 * @typedef {(cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}} Exec
 * @typedef {{agent: string, type?: string, model: string, input: number, output: number, cacheCreation: number, cacheRead: number}} UsageRow
 * @typedef {{slice: string, minutes: number, fixLoops: number, tokens: number|null, usage: UsageRow[]|null, tokenRecords: number, records: number, lastAt: string|null}} Cost
 */

const SLICE_ID = /^S-\d{2}[a-z]?$/;
const INC_ID = /^INC-\d+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SLICE_BRANCH = /^slice\/(s-\d{2})([a-z]?)(?:-|$)/i;
const FAILURE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FILE = ['.recade', 'cost.jsonl'];

/** A problem with what the owner asked for (no slice in the increment, a retro already written), not a tool failure. */
export class RetroInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetroInputError';
  }
}

const firstLine = (text) => String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const round = (n, digits = 1) => Number(n.toFixed(digits));

/** `slice/s-03a-name` is the slice `S-03a`. Null for any other branch. */
function sliceOf(branch) {
  const m = SLICE_BRANCH.exec(String(branch ?? ''));
  return m === null ? null : `S-${m[1].slice(2)}${m[2].toLowerCase()}`;
}

// ---------------------------------------------------------------------------------------------------------
// Token counts from Claude Code transcripts
// ---------------------------------------------------------------------------------------------------------

const MAIN_AGENT = 'main';
const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,80})\.jsonl$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const AGENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,59}$/;
const COUNTS = [['input', 'input_tokens'], ['output', 'output_tokens'], ['cacheCreation', 'cache_creation_input_tokens'], ['cacheRead', 'cache_read_input_tokens']];

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/** The four counts of a `message.usage`, or null when it is not usable (no input and output, or a count that is not a whole number). */
function usageCounts(u) {
  if (u === null || typeof u !== 'object') return null;
  if (u.input_tokens === undefined && u.output_tokens === undefined) return null;
  const out = {};
  for (const [key, field] of COUNTS) {
    const v = u[field] ?? 0;
    if (!isCount(v)) return null;
    out[key] = v;
  }
  return out;
}

/** The session folder of a transcript file: `<dir>/<id>.jsonl` has its subagents in `<dir>/<id>/subagents/`. */
const subagentDir = (path) => join(path.replace(/\.jsonl$/i, ''), 'subagents');

/**
 * The tokens of one Claude Code session, read from its JSONL transcript and from the subagent transcripts that
 * Claude Code writes next to it (`<id>.jsonl` and `<id>/subagents/agent-<agent id>.jsonl`). Claude Code writes the
 * same message on several lines, so a message counts once, by `message.id` (across all the files too): summing every
 * line gives two to three times the real figure. Of the lines of one message, the fullest (most output) counts.
 * Lines that are not JSON, with no message id or with no usable usage are skipped and counted.
 * Any failure to read gives `{ok: false, reason}`: never a throw, never a partial or guessed figure. Only tokens are
 * read: no price, and no text of the conversation leaves this function.
 * @param {string} path the session transcript
 * @param {{fs?: Pick<typeof nodeFs, 'readFileSync' | 'readdirSync'>, since?: number}} [options] `since`: epoch ms, older lines are ignored
 * @returns {{ok: true, tokens: number, total: {input: number, output: number, cacheCreation: number, cacheRead: number}, rows: UsageRow[], messages: number, skipped: number}
 *   | {ok: false, reason: string}}
 */
export function readTranscriptUsage(path, { fs = nodeFs, since } = {}) {
  try {
    if (typeof path !== 'string' || path === '') return { ok: false, reason: 'no transcript path' };
    const files = [{ file: path, agent: null }];
    let names = [];
    try {
      names = fs.readdirSync(subagentDir(path));
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    }
    for (const name of [...names].sort()) {
      const m = AGENT_FILE.exec(name);
      if (m !== null) files.push({ file: join(subagentDir(path), name), agent: m[1] });
    }

    const seen = new Map();
    let skipped = 0;
    for (const { file, agent } of files) {
      for (const line of String(fs.readFileSync(file, 'utf8')).split('\n')) {
        if (line.trim() === '') continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          skipped++;
          continue;
        }
        if (o === null || typeof o !== 'object' || o.type !== 'assistant') continue;
        const msg = o.message;
        const counts = usageCounts(msg?.usage);
        if (counts === null || typeof msg.id !== 'string' || msg.id === '') {
          skipped++;
          continue;
        }
        if (msg.model === '<synthetic>') continue;
        if (since !== undefined) {
          // A line with no usable timestamp cannot be placed in the window, so it is not charged to it.
          const at = Date.parse(o.timestamp);
          if (!Number.isFinite(at) || at < since) continue;
        }
        const who = agent ?? (o.isSidechain === true && typeof o.agentId === 'string' && AGENT_ID.test(o.agentId) ? o.agentId : MAIN_AGENT);
        const model = typeof msg.model === 'string' && msg.model !== '' ? msg.model : 'unknown';
        const before = seen.get(msg.id);
        if (before === undefined) seen.set(msg.id, { agent: who, model, counts });
        else if (counts.output >= before.counts.output) seen.set(msg.id, { agent: before.agent, model: before.model, counts });
      }
    }
    if (seen.size === 0) return { ok: false, reason: 'no usage found in the transcript' };

    const byKey = new Map();
    const total = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    for (const { agent, model, counts } of seen.values()) {
      const key = `${agent}\u0000${model}`;
      const r = byKey.get(key) ?? { agent, model, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      for (const [k] of COUNTS) {
        r[k] += counts[k];
        total[k] += counts[k];
      }
      byKey.set(key, r);
    }
    const rank = (r) => (r.agent === MAIN_AGENT ? 0 : 1);
    const rows = [...byKey.values()].sort((a, b) => rank(a) - rank(b) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
    for (const r of rows) {
      const type = r.agent === MAIN_AGENT ? undefined : agentType(fs, path, r.agent);
      if (type !== undefined) r.type = type;
    }
    return { ok: true, tokens: total.input + total.output + total.cacheCreation + total.cacheRead, total, rows, messages: seen.size, skipped };
  } catch (err) {
    return { ok: false, reason: firstLine(err?.message ?? err) || 'the transcript could not be read' };
  }
}

/** The `agentType` of `agent-<id>.meta.json` (a short name such as `implementer`), or undefined. Nothing else of that file is read out. */
function agentType(fs, path, agent) {
  try {
    const meta = JSON.parse(String(fs.readFileSync(join(subagentDir(path), `agent-${agent}.meta.json`), 'utf8')));
    return typeof meta?.agentType === 'string' && AGENT_TYPE.test(meta.agentType) ? meta.agentType : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session transcripts of a working directory, newest first, with the moment each was last written. Claude Code keeps
 * them in `<config>/projects/<the folder path with every character that is not a letter or digit turned into "-">/<session id>.jsonl`,
 * under the folder the session was STARTED in (for a slice, its worktree). With `since` (epoch ms), only the files written
 * since then. An empty list when there is none or the folder cannot be read.
 * @param {string} cwd
 * @param {{configDir?: string, since?: number, fs?: Pick<typeof nodeFs, 'readdirSync' | 'statSync'>}} [options] `configDir` defaults to `~/.claude`
 * @returns {{file: string, mtimeMs: number}[]}
 */
export function findTranscripts(cwd, { configDir = join(homedir(), '.claude'), since, fs = nodeFs } = {}) {
  try {
    const folder = join(configDir, 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
    const found = [];
    for (const name of fs.readdirSync(folder)) {
      if (!/^[^/\\]+\.jsonl$/.test(name)) continue;
      const stat = fs.statSync(join(folder, name));
      if (stat.isFile() && (since === undefined || stat.mtimeMs >= since)) found.push({ file: join(folder, name), mtimeMs: stat.mtimeMs });
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Cost records
// ---------------------------------------------------------------------------------------------------------

function count(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} must be a whole number, 0 or more.`);
  return value;
}

/** The per agent and model rows as they are written to `cost.jsonl` (snake_case, like `fix_loops`). */
function usageToRecord(usage) {
  if (!Array.isArray(usage)) throw new Error('usage must be a list of rows.');
  return usage.map((r) => {
    if (typeof r?.agent !== 'string' || !AGENT_ID.test(r.agent) || typeof r.model !== 'string' || r.model === '') throw new Error('usage rows need an agent and a model.');
    const out = { agent: r.agent };
    if (r.type !== undefined) {
      if (typeof r.type !== 'string' || !AGENT_TYPE.test(r.type)) throw new Error('usage row type is not a short name.');
      out.type = r.type;
    }
    out.model = r.model;
    for (const [key, field] of COUNTS) out[field.replace(/_tokens$/, '')] = count(r[key], `usage ${key}`);
    return out;
  });
}

/** The rows of a record read back, or null when they are not valid (the record still counts, without them). */
function usageFromRecord(usage) {
  if (usage === undefined) return undefined;
  if (!Array.isArray(usage)) return null;
  const rows = [];
  for (const r of usage) {
    if (r === null || typeof r !== 'object' || typeof r.agent !== 'string' || !AGENT_ID.test(r.agent) || typeof r.model !== 'string' || r.model === '') return null;
    if (r.type !== undefined && (typeof r.type !== 'string' || !AGENT_TYPE.test(r.type))) return null;
    const row = { agent: r.agent, ...(r.type === undefined ? {} : { type: r.type }), model: r.model };
    for (const [key, field] of COUNTS) {
      const v = r[field.replace(/_tokens$/, '')];
      if (!isCount(v)) return null;
      row[key] = v;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Append one cost record to `.recade/cost.jsonl`: the minutes since the slice started, the FIX loops so far
 * and, when known, the tokens. `/slice` writes the cumulative figures of its ledger each time it stops, so the
 * last record of a slice is the one that counts (see `readCost`).
 * @param {string} root project folder
 * @param {{slice: string, minutes: number, fixLoops: number, tokens?: number, usage?: UsageRow[]}} cost
 * @param {{now?: () => Date}} [options]
 * @returns {{slice: string, minutes: number, fix_loops: number, tokens?: number, at: string}}
 */
export function recordCost(root, cost, { now = () => new Date() } = {}) {
  if (typeof cost?.slice !== 'string' || !SLICE_ID.test(cost.slice)) throw new Error(`Invalid slice: ${JSON.stringify(cost?.slice)}. Use S-03 style.`);
  const record = { slice: cost.slice, minutes: count(cost.minutes, 'minutes'), fix_loops: count(cost.fixLoops, 'FIX loops') };
  if (cost.tokens !== undefined) record.tokens = count(cost.tokens, 'tokens');
  if (cost.usage !== undefined) record.usage = usageToRecord(cost.usage);
  record.at = now().toISOString();
  mkdirSync(join(root, FILE[0]), { recursive: true });
  appendFileSync(join(root, ...FILE), `${JSON.stringify(record)}\n`);
  return record;
}

/**
 * The cost of each slice. A slice can have several records: the last one wins for the minutes and the FIX loops
 * (they are cumulative), and the tokens of all the records add up (each record holds the tokens of its own window).
 * A line that is not a valid record is skipped and counted.
 * @param {string} root project folder
 * @returns {{bySlice: Map<string, Cost>, skipped: number}}
 */
export function readCost(root) {
  const bySlice = new Map();
  let skipped = 0;
  let text = '';
  try {
    text = readFileSync(join(root, ...FILE), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const ok = r !== null && typeof r === 'object' && SLICE_ID.test(r.slice ?? '') && Number.isSafeInteger(r.minutes) && r.minutes >= 0
      && Number.isSafeInteger(r.fix_loops) && r.fix_loops >= 0 && (r.tokens === undefined || (Number.isSafeInteger(r.tokens) && r.tokens >= 0));
    if (!ok) {
      skipped++;
      continue;
    }
    const before = bySlice.get(r.slice);
    // The minutes and the FIX loops are cumulative (the last record counts). The tokens of a record are those of its own
    // window, so they add up; a record with none stays visible as such (`tokenRecords` below `records`).
    const rows = r.tokens === undefined ? null : usageFromRecord(r.usage) ?? null;
    bySlice.set(r.slice, {
      slice: r.slice, minutes: r.minutes, fixLoops: r.fix_loops,
      tokens: r.tokens === undefined ? (before?.tokens ?? null) : (before?.tokens ?? 0) + r.tokens,
      usage: rows === null ? (before?.usage ?? null) : [...(before?.usage ?? []), ...rows],
      tokenRecords: (before?.tokenRecords ?? 0) + (r.tokens === undefined ? 0 : 1),
      records: (before?.records ?? 0) + 1,
      lastAt: typeof r.at === 'string' ? r.at : (before?.lastAt ?? null),
    });
  }
  return { bySlice, skipped };
}

// ---------------------------------------------------------------------------------------------------------
// DORA metrics
// ---------------------------------------------------------------------------------------------------------

/** The commit of a branch: the local branch first, then `origin/<name>`. */
function resolveBase(repo, base, exec) {
  for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
    const r = exec(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo });
    if (r.code === 0 && /^[0-9a-f]{40,64}$/.test(r.stdout.trim())) return r.stdout.trim();
  }
  throw new Error(`Cannot find the branch ${base}, locally or on origin.`);
}

/** The merged pull requests, as `gh pr list` prints them. Throws on a gh failure or an answer that is not JSON. */
function listMerged(repo, base, exec) {
  let r;
  try {
    r = exec(['gh', 'pr', 'list', '--state', 'merged', '--base', base, '--limit', '500', '--json', 'number,title,headRefName,mergedAt,mergeCommit,commits'], { cwd: repo });
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
  return data
    .filter((p) => p && Number.isFinite(Date.parse(p.mergedAt)))
    .map((p) => {
      const dates = (Array.isArray(p.commits) ? p.commits : [])
        .flatMap((c) => [c?.committedDate, c?.authoredDate])
        .map((d) => Date.parse(d))
        .filter(Number.isFinite);
      return {
        number: Number(p.number), title: String(p.title ?? ''), branch: String(p.headRefName ?? ''),
        mergedAt: Date.parse(p.mergedAt), oid: String(p.mergeCommit?.oid ?? ''),
        firstCommit: dates.length > 0 ? Math.min(...dates) : null,
      };
    });
}

/**
 * The first-parent history of the base branch, newest first, with the files each commit changed (a merge commit
 * against its first parent).
 * @returns {{oid: string, at: number, subject: string, files: Set<string>}[]}
 */
function mainHistory(repo, ref, exec) {
  const r = exec(['git', '-c', 'core.quotepath=off', 'log', ref, '--first-parent', '-m', '--name-only', '--format=%x1e%H%x1f%cI%x1f%s'], { cwd: repo });
  if (r.code !== 0) throw new Error(`git log failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  return r.stdout.split('\x1e').filter((rec) => rec.trim() !== '').map((rec) => {
    const [head, ...rest] = rec.split('\n');
    const [oid, at, subject] = head.split('\x1f');
    return { oid, at: Date.parse(at), subject: subject ?? '', files: new Set(rest.map((l) => l.trim()).filter((l) => l !== '' && !BOOKKEEPING.test(l))) };
  });
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Files every slice touches without being their code: the generated status and graph of the board, the index, CLAUDE.md.
 * Two merges that both update them did not change the same behaviour, so they never link a fix to a merge.
 */
const BOOKKEEPING = /^(slices\/(STATUS|graph)\.md|INDEX\.md|CLAUDE\.md|\.recade\/.*)$/;

/** A commit that undoes or repairs: a revert, or a conventional `fix`. */
const isRepair = (label) => /^revert\b/i.test(label) || /^fix(\([^)]*\))?!?:/i.test(label);

/**
 * The slices of an increment, as the sheets say.
 * @returns {{id: string, title: string, status: string}[]}
 */
function slicesOf(root, inc) {
  return checkSlices(root).status.filter((s) => String(s.increment).trim().toLowerCase() === inc.toLowerCase());
}

/**
 * DORA metrics for the slices of one increment, from git and gh (spec 11).
 * - Deployment frequency: the merges of those slices to the base branch, per week, over the window from the first
 *   commit of the first slice to the last merge (at least one week, so a burst does not inflate the figure).
 * - Lead time: first commit of the pull request to its merge, median.
 * - Change failure rate: the merges followed, within 7 days, by a revert or a `fix:` that touches one of the same
 *   files. A merge commit is named by the title of its pull request, a squash commit by its subject.
 * - Time to restore: from the failed merge to the first such revert or fix, median.
 * `gh pr list` is the only gh call, git is only read.
 * In a workspace with a registry (spec 6.13) this runs in each code repository, in `repos/<name>/`, on its default
 * branch (or `base`): the result is the total over every repository, with `repos`, the same figures for each repository,
 * and `repo` on each merge and failure. A fix in one repository is never linked to a merge in another.
 * @param {string} root project folder (a legacy project is also the repository)
 * @param {string} inc INC-n
 * @param {{exec?: Exec, base?: string}} [options] `base` defaults to `main`, or to the default branch of each repository
 */
export function doraMetrics(root, inc, { exec = defaultExec, base } = {}) {
  if (!INC_ID.test(inc)) throw new Error(`Invalid increment: ${JSON.stringify(inc)}. Use INC-1 style.`);
  if (base !== undefined && !BRANCH.test(base)) throw new Error(`Invalid base branch: ${JSON.stringify(base)}.`);
  const ids = new Set(slicesOf(root, inc).map((s) => s.id));
  const state = loadState(root) ?? {};
  const names = registryNames(state).filter((n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n) && n !== 'workspace');
  if (names.length === 0) {
    const own = base ?? 'main';
    const found = collect(root, ids, own, exec);
    return summarize(inc, own, found.merges, found.failed);
  }
  const defaults = new Map((Array.isArray(state.repos) ? state.repos : []).filter((e) => e !== null && typeof e === 'object').map((e) => [e.name, e.default_branch]));
  const merges = [];
  const failed = [];
  const repos = [];
  for (const name of names) {
    const dir = join(root, 'repos', name);
    if (!existsSync(join(dir, '.git'))) throw new Error(`${name}: repos/${name} is not a git repository. Run: recade repo sync`);
    const own = base ?? (typeof defaults.get(name) === 'string' && BRANCH.test(defaults.get(name)) ? defaults.get(name) : 'main');
    let found;
    try {
      found = collect(dir, ids, own, exec);
    } catch (err) {
      throw new Error(`${name}: ${firstLine(err?.message ?? err)}`);
    }
    const tagged = { merges: found.merges.map((m) => ({ repo: name, ...m })), failed: found.failed.map((f) => ({ repo: name, ...f })) };
    merges.push(...tagged.merges);
    failed.push(...tagged.failed);
    repos.push({ repo: name, ...summarize(inc, own, tagged.merges, tagged.failed) });
  }
  merges.sort((a, b) => a.time - b.time);
  return { ...summarize(inc, base ?? null, merges, failed), repos };
}

/** The merges of the slices `ids` into `base` of the repository at `dir`, and the ones that failed. */
function collect(dir, ids, base, exec) {
  const merged = listMerged(dir, base, exec);
  const history = mainHistory(dir, resolveBase(dir, base, exec), exec);
  const titleOf = new Map(merged.map((p) => [p.oid, p.title]));
  const labelled = history.map((c) => ({ ...c, label: titleOf.get(c.oid) ?? c.subject }));

  const merges = merged
    .filter((p) => ids.has(sliceOf(p.branch)))
    .sort((a, b) => a.mergedAt - b.mergedAt)
    .map((p) => ({
      slice: sliceOf(p.branch), pr: p.number, title: p.title, oid: p.oid,
      mergedAt: new Date(p.mergedAt).toISOString(),
      firstCommit: p.firstCommit === null ? null : new Date(p.firstCommit).toISOString(),
      leadHours: p.firstCommit === null ? null : (p.mergedAt - p.firstCommit) / HOUR_MS,
      time: p.mergedAt,
    }));

  const failed = [];
  for (const m of merges) {
    const at = labelled.findIndex((c) => c.oid === m.oid);
    const files = at >= 0 ? labelled[at].files : new Set();
    const later = at >= 0 ? labelled.slice(0, at) : labelled;
    const repairs = later
      .filter((c) => c.at >= m.time && c.at - m.time <= FAILURE_WINDOW_MS && isRepair(c.label) && [...c.files].some((f) => files.has(f)))
      .sort((a, b) => a.at - b.at);
    if (repairs.length > 0) failed.push({ slice: m.slice, pr: m.pr, by: repairs[0].label, byAt: new Date(repairs[0].at).toISOString(), restoreHours: (repairs[0].at - m.time) / HOUR_MS });
  }
  return { merges, failed };
}

/** The four figures from a list of merges (with `time`) and of failed merges. */
function summarize(inc, base, merges, failed) {
  let windowDays = null;
  let deploysPerWeek = null;
  if (merges.length > 0) {
    const start = Math.min(...merges.map((m) => m.firstCommit === null ? m.time : Date.parse(m.firstCommit)));
    const end = Math.max(...merges.map((m) => m.time));
    windowDays = Math.max(7, Math.round((end - start) / DAY_MS));
    deploysPerWeek = round(merges.length / (windowDays / 7), 2);
  }
  const lead = median(merges.map((m) => m.leadHours).filter((h) => h !== null));
  return {
    inc, base,
    merges: merges.map(({ time, ...m }) => m),
    windowDays, deploysPerWeek,
    leadTimeHours: lead,
    failed,
    changeFailureRate: merges.length === 0 ? null : failed.length / merges.length,
    restoreHours: median(failed.map((f) => f.restoreHours)),
  };
}

// ---------------------------------------------------------------------------------------------------------
// The retro file
// ---------------------------------------------------------------------------------------------------------

const fmtHours = (h) => (h < 48 ? `${round(h)} h` : `${round(h / 24)} days`);
const fmtMinutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 === 0 ? '' : ` ${m % 60} min`}`);
const cell = (value) => String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim().replaceAll('|', '\\|');
const row = (...cells) => `| ${cells.map(cell).join(' | ')} |`;

/** The four DORA figures as the text of the Value column. */
function doraValues(m) {
  const leads = m.merges.filter((x) => x.leadHours !== null).length;
  return {
    'Deployment frequency': m.merges.length === 0 ? 'no merge in this increment' : `${plural(m.merges.length, 'merge')}, ${m.deploysPerWeek} per week`,
    'Lead time for changes': m.leadTimeHours === null ? 'no data' : `${fmtHours(m.leadTimeHours)} (median of ${leads})`,
    'Change failure rate': m.changeFailureRate === null ? 'no data' : `${Math.round(m.changeFailureRate * 100)}% (${m.failed.length} of ${plural(m.merges.length, 'merge')})`,
    'Time to restore service': m.restoreHours === null ? (m.merges.length === 0 ? 'no data' : 'no failure to restore') : `${fmtHours(m.restoreHours)} (median of ${m.failed.length})`,
  };
}

/** One row per code repository under the DORA table of a workspace, then a blank line. */
function repoTable(repos) {
  const failure = (r) => (r.changeFailureRate === null ? 'no data' : `${Math.round(r.changeFailureRate * 100)}% (${r.failed.length} of ${plural(r.merges.length, 'merge')})`);
  const restore = (r) => (r.restoreHours === null ? (r.merges.length === 0 ? 'no data' : 'no failure to restore') : fmtHours(r.restoreHours));
  return [
    '', '| Repository | Merges | Lead time | Change failure rate | Time to restore |', '|---|---|---|---|---|',
    ...repos.map((r) => row(r.repo, r.merges.length, r.leadTimeHours === null ? 'no data' : fmtHours(r.leadTimeHours), failure(r), restore(r))),
    '',
  ];
}

/** The Value column of the DORA table of an earlier retro, by metric. Empty when the file or the table is missing. */
function earlierValues(root, inc) {
  const n = Number(inc.slice(4));
  const out = new Map();
  if (n < 1) return out;
  let text;
  try {
    text = readFileSync(join(root, 'retros', `INC-${n - 1}.md`), 'utf8');
  } catch {
    return out;
  }
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === '## DORA metrics');
  if (at < 0) return out;
  for (let i = at + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(lines[i]);
    if (m && !/^(Metric|-+)$/.test(m[1]) && !/^(Example|none)$/i.test(m[2])) out.set(m[1], m[2]);
  }
  return out;
}

/** Replace the body of the `## <heading>` section, keeping the heading. */
function replaceSection(lines, heading, body) {
  const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (at < 0) throw new Error(`templates/retro.md has no "## ${heading}" section.`);
  let end = at + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end++;
  lines.splice(at + 1, end - at - 1, '', ...body, '');
}

const TO_WRITE = 'To write with the owner.';

/**
 * Write `retros/<inc>.md` from the retro template: what was delivered, the DORA metrics, the cost per slice and the
 * provisionals still open come from the repository, the board and the registers. The sections that need the owner
 * (demo, decisions, recalibrated dates, back-ports) are left to write. An existing file is never replaced without
 * `force`, because the owner edits it afterwards.
 * @param {string} root project folder (also the repository)
 * @param {string} inc INC-n
 * @param {{exec?: Exec, base?: string, force?: boolean, now?: () => Date}} [options]
 * @returns {{file: string, metrics: ReturnType<typeof doraMetrics>, values: Record<string, string>, recorded: number, missing: number, text: string}}
 */
export function retro(root, inc, { exec = defaultExec, base, force = false, now = () => new Date() } = {}) {
  if (!INC_ID.test(inc)) throw new Error(`Invalid increment: ${JSON.stringify(inc)}. Use INC-1 style.`);
  const slices = slicesOf(root, inc);
  if (slices.length === 0) throw new RetroInputError(`No slice belongs to ${inc}. Check the increment key of the slice sheets.`);
  const file = join(root, 'retros', `${inc}.md`);
  if (existsSync(file) && !force) throw new RetroInputError(`retros/${inc}.md already exists. Run it again with --force to replace it.`);

  // A flaky test is fixed before its increment closes (spec 12). No `force` gets round this: the retro is the close.
  // Each code repository has its own tests/quarantine.json; the retro reads them all.
  const held = dueForIncrementAll(root, inc);
  if (held.length > 0) {
    throw new RetroInputError(`${inc} cannot close with ${plural(held.length, 'quarantined test')}: ${held.map((e) => `${e.repo === null ? '' : `${e.repo}: `}${e.test} (${e.slice})`).join('; ')}. Fix each one, then run recade quarantine remove '<test>'${held.some((e) => e.repo !== null) ? ' --repo <name>' : ''} and commit tests/quarantine.json${held.some((e) => e.repo !== null) ? ' in that repository' : ''}.`);
  }

  const metrics = doraMetrics(root, inc, { exec, base });
  const values = doraValues(metrics);
  const before = earlierValues(root, inc);
  const { bySlice } = readCost(root);
  const merged = new Set(metrics.merges.map((m) => m.slice));

  const date = localDate(now());
  const language = loadState(root)?.languages?.work ?? 'en';
  const project = root.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
  const lines = fillTemplate(readTemplate('retro.md'), {
    doc_id: inc, title: `${project}, retrospective ${inc}`, project, version: '0.1', date, language,
  }).split('\n');

  const firstSlice = firstSliceLine(loadState(root) ?? {}, date);
  replaceSection(lines, 'Delivered', [
    ...(metrics.merges.length === 0
      ? ['Nothing merged yet.']
      : ['| Slice | What shipped | Merged on |', '|---|---|---|', ...metrics.merges.map((m) => row(m.slice, m.title, m.mergedAt.slice(0, 10)))]),
    ...(firstSlice === null ? [] : ['', firstSlice]),
  ]);
  replaceSection(lines, 'Decisions', [TO_WRITE]);
  const open = slices.filter((s) => !merged.has(s.id));
  replaceSection(lines, 'Carry-over', open.length === 0
    ? ['Nothing carried over.']
    : ['| Item | Why it moved | New home |', '|---|---|---|', ...open.map((s) => row(`${s.id}: ${s.title}`, 'Not merged when this retro was written', 'To decide'))]);
  const provisionals = listProvisionals(root, { open: true });
  replaceSection(lines, 'Provisionals still open', provisionals.length === 0
    ? ['No provisional is open.']
    : ['| What | Who gives the real one | Due |', '|---|---|---|', ...provisionals.map((p) => row(`${p.id}: ${p.what}`, p.owner, p.due === '' ? 'not set' : p.due))]);
  const quarantined = listAllQuarantine(root);
  replaceSection(lines, 'Quarantined tests', quarantined.length === 0
    ? ['No test is quarantined.']
    : ['| Test | Slice | Since | Reason |', '|---|---|---|---|', ...quarantined.map((e) => row(e.repo === null ? e.test : `${e.repo}: ${e.test}`, e.slice, e.since, e.reason)), '', 'These tests belong to a later increment. Each one is fixed before the increment of its slice closes.']);
  replaceSection(lines, 'DORA metrics', [
    '| Metric | Value | Compared with last increment |', '|---|---|---|',
    ...Object.entries(values).map(([name, value]) => row(name, value, before.has(name) ? `was ${before.get(name)}` : 'no earlier retro figure')),
    '',
    ...(metrics.repos === undefined ? [] : repoTable(metrics.repos)),
    `Computed from the pull requests merged into ${metrics.base === null ? 'the default branch of each repository' : metrics.base} and the history of ${metrics.base === null ? 'each repository' : metrics.base}, for the slices of ${inc}.`,
  ]);
  let recorded = 0;
  const costRows = slices.map((s) => {
    const c = bySlice.get(s.id);
    if (c) recorded++;
    const tokens = c?.tokens == null ? 'not recorded' : c.tokenRecords === c.records ? c.tokens : `${c.tokens} (partial: ${c.tokenRecords} of ${c.records} records)`;
    return row(s.id, c ? fmtMinutes(c.minutes) : 'not recorded', c ? c.fixLoops : 'not recorded', tokens);
  });
  const byModel = [];
  for (const s of slices) {
    const models = new Map();
    for (const u of bySlice.get(s.id)?.usage ?? []) {
      const m = models.get(u.model) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      for (const k of Object.keys(m)) m[k] += u[k];
      models.set(u.model, m);
    }
    for (const [model, m] of [...models].sort((a, b) => a[0].localeCompare(b[0]))) byModel.push(row(s.id, model, m.input, m.output, m.cacheCreation, m.cacheRead));
  }
  replaceSection(lines, 'Cost per slice', [
    '| Slice | Elapsed time | FIX loops | Tokens |', '|---|---|---|---|', ...costRows, '',
    'Elapsed time is the wall clock from the start of the slice to its end, gate waits and the owner\'s reading included. It is not the time an agent worked. Tokens are input, output, cache write and cache read added up, from the session transcripts, subagents included. Each cost record holds the tokens of its own window (since the previous record), and the slice figure is their sum; a record written without a transcript, or whose transcript could not be read, adds nothing and the figure is marked partial.',
    ...(byModel.length === 0 ? [] : ['', '| Slice | Model | Input | Output | Cache write | Cache read |', '|---|---|---|---|---|---|', ...byModel]),
  ]);
  replaceSection(lines, 'Recalibrated dates', [TO_WRITE]);
  replaceSection(lines, 'Spec back-ports done', [TO_WRITE]);

  const text = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  mkdirSync(join(root, 'retros'), { recursive: true });
  writeFileSync(file, text, { flag: force ? 'w' : 'wx' });
  return { file, metrics, values, recorded, missing: slices.length - recorded, firstSlice, text };
}

const localDate = (d) => (Number.isNaN(d.getTime()) ? localToday() : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
