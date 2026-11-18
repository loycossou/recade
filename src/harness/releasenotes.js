import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultExec } from './stamps.js';

/**
 * Release notes from conventional commits (spec 12). The section of a release is built from the commits of a
 * range: breaking changes first, then features, fixes, performance, documentation and the rest, each with its
 * pull request number linked when the remote is on GitHub. Git is only read, through the injected `exec`.
 *
 * @typedef {(cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}} Exec
 */

/** A problem with what the owner asked for (a bad range, no commit, a section already written), not a tool failure. */
export class ReleaseNotesInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseNotesInputError';
  }
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._/@~^-]*$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const CONVENTIONAL = /^([A-Za-z]+)(?:\(([^)\n]*)\))?(!)?:\s+(.+)$/;
const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:\s*(.*)$/m;
const MERGE_PR = /^Merge pull request #(\d+)\b/;
const OID = /^[0-9a-f]{40,64}$/;
const HEADINGS = [['feat', 'Features'], ['fix', 'Fixes'], ['perf', 'Performance'], ['docs', 'Documentation']];

const firstLine = (text) => String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Read one commit message as a conventional commit. A subject that does not follow the convention has the type
 * `other`. The pull request number comes from a trailing `(#n)` of the subject.
 * @returns {{type: string, scope: string|null, breaking: boolean, breakingNote: string|null, description: string, pr: number|null}}
 */
export function parseCommit(subject, body) {
  let text = String(subject ?? '').trim();
  let pr = null;
  const suffix = PR_SUFFIX.exec(text);
  if (suffix !== null) {
    pr = Number(suffix[1]);
    text = text.slice(0, suffix.index).trim();
  }
  const m = CONVENTIONAL.exec(text);
  const footer = BREAKING_FOOTER.exec(String(body ?? ''));
  const note = footer !== null && footer[1].trim() !== '' ? footer[1].trim() : null;
  return {
    type: m === null ? 'other' : m[1].toLowerCase(),
    scope: m === null || m[2] === undefined || m[2].trim() === '' ? null : m[2].trim(),
    breaking: (m !== null && m[3] === '!') || footer !== null,
    breakingNote: note,
    description: m === null ? text : m[4].trim(),
    pr,
  };
}

/** The `https://github.com/owner/repo` of the origin remote, or null for any other host or no remote. */
function repoUrl(repo, exec) {
  const r = exec(['git', 'remote', 'get-url', 'origin'], { cwd: repo });
  if (r.code !== 0) return null;
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?|(?:ssh:\/\/)?git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(r.stdout.trim());
  return m === null ? null : `https://github.com/${m[1]}/${m[2]}`;
}

/** The pull request number of each commit a `Merge pull request #n` commit of the range brought in. */
function mergedPrs(repo, range, exec) {
  const map = new Map();
  const r = exec(['git', 'log', '--merges', '--format=%H%x1f%P%x1f%s', range, '--'], { cwd: repo });
  if (r.code !== 0) return map;
  for (const row of r.stdout.split('\n')) {
    const [, parents, subject] = row.split('\x1f');
    const m = MERGE_PR.exec(subject ?? '');
    const [first, second] = (parents ?? '').split(' ');
    if (m === null || !OID.test(first ?? '') || !OID.test(second ?? '')) continue;
    const brought = exec(['git', 'rev-list', `${first}..${second}`, '--'], { cwd: repo });
    if (brought.code !== 0) continue;
    for (const oid of brought.stdout.split('\n').map((l) => l.trim()).filter((l) => OID.test(l))) if (!map.has(oid)) map.set(oid, Number(m[1]));
  }
  return map;
}

/**
 * The release notes of a range of commits, as the Markdown section of a changelog.
 * @param {string} repo repository folder
 * @param {string} range `<from>..<to>`: the commits of `to` that are not in `from`
 * @param {{exec?: Exec, version?: string, now?: () => Date}} [options] `version` names the section, by default the `to` ref (`Unreleased` for HEAD)
 * @returns {string} the section, ending with a newline
 */
export function releaseNotes(repo, range, { exec = defaultExec, version, now = () => new Date() } = {}) {
  const parts = String(range ?? '').split('..');
  if (parts.length !== 2 || parts.some((p) => !REF.test(p) || p.includes('..'))) {
    throw new ReleaseNotesInputError(`Invalid range: ${JSON.stringify(range)}. Use <from>..<to>, for example v0.1.0..HEAD.`);
  }
  if (version !== undefined && !VERSION.test(version)) throw new ReleaseNotesInputError(`Invalid version: ${JSON.stringify(version)}.`);
  const log = exec(['git', 'log', '--no-merges', '--format=%x1e%H%x1f%s%x1f%b', range, '--'], { cwd: repo });
  if (log.code !== 0) throw new Error(`git log failed: ${firstLine(log.stderr) || `exit ${log.code}`}`);
  const commits = log.stdout.split('\x1e').filter((r) => r.trim() !== '').map((r) => {
    const [oid, subject, ...body] = r.split('\x1f');
    return { oid: oid.trim(), ...parseCommit(subject, body.join('\x1f')) };
  });
  if (commits.length === 0) throw new ReleaseNotesInputError(`No commit in ${range}.`);

  const viaMerge = mergedPrs(repo, range, exec);
  const base = repoUrl(repo, exec);
  const entry = (c) => {
    const pr = c.pr ?? viaMerge.get(c.oid) ?? null;
    const scope = c.scope === null ? '' : `**${c.scope}:** `;
    const link = pr === null ? '' : base === null ? ` (#${pr})` : ` ([#${pr}](${base}/pull/${pr}))`;
    const note = c.breaking && c.breakingNote !== null ? `\n  - Breaking: ${c.breakingNote}` : '';
    return `- ${scope}${c.description}${link}${note}`;
  };

  const groups = [['Breaking changes', commits.filter((c) => c.breaking)]];
  const rest = commits.filter((c) => !c.breaking);
  for (const [type, title] of HEADINGS) groups.push([title, rest.filter((c) => c.type === type)]);
  groups.push(['Other changes', rest.filter((c) => !HEADINGS.some(([type]) => type === c.type))]);

  const name = version ?? (parts[1] === 'HEAD' ? 'Unreleased' : parts[1]);
  const out = [`## ${name} (${localDate(now())})`];
  for (const [title, list] of groups) {
    if (list.length === 0) continue;
    out.push('', `### ${title}`, '', ...list.map(entry));
  }
  return `${out.join('\n')}\n`;
}

/**
 * Put a section on top of `CHANGELOG.md`, newest first: under the title, before the first release. The file is
 * created with the title `# Changelog` when it does not exist. A section that is already there is refused.
 * @param {string} root repository folder
 * @param {string} section the text of `releaseNotes`
 * @returns {string} the path written
 */
export function prependChangelog(root, section) {
  const file = join(root, 'CHANGELOG.md');
  const heading = /^## (\S+)/.exec(section)?.[1];
  if (heading === undefined) throw new Error('The section to write must start with "## <version>".');
  if (!existsSync(file)) {
    writeFileSync(file, `# Changelog\n\n${section}`);
    return file;
  }
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (lines.some((l) => l.startsWith(`## ${heading} `) || l === `## ${heading}`)) {
    throw new ReleaseNotesInputError(`CHANGELOG.md already has a section "## ${heading}". Remove it first, or name another version.`);
  }
  const at = lines.findIndex((l) => l.startsWith('## '));
  const next = at >= 0
    ? `${lines.slice(0, at).join('\n')}${at > 0 ? '\n' : ''}${section}\n${lines.slice(at).join('\n')}`
    : `${text.replace(/\n*$/, '\n')}\n${section}`;
  writeFileSync(file, next);
  return file;
}
