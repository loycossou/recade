/**
 * The local forge (docs/design.md, section 6.8): no GitHub, git on this machine only. A slice ends with a local review
 * request, a file of the workspace, and the owner merges its branch with `git merge --no-ff`. Everything here is read from
 * git, and nothing calls `gh`.
 *
 * A slice branch counts as merged into the base branch when a merge commit on the first-parent history of the base has
 * the tip of the branch as one of its other parents. A branch with no commit of its own, or one merged by a fast forward,
 * is not counted: the commands show the owner the `--no-ff` merge, which leaves that proof.
 */

/** @typedef {(cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}} Exec */

const firstLine = (text) => String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
const SHA = /^[0-9a-f]{40,64}$/;

/** The folder of the local review requests, in the workspace. */
export const REVIEWS_DIR = 'slices/reviews';
/** The local review request of a slice: the body the release manager would have put in the pull request. */
export const reviewPath = (id) => `${REVIEWS_DIR}/${id}.md`;

function call(exec, cmd, cwd) {
  try {
    const r = exec(cmd, { cwd });
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    return { code: 127, stdout: '', stderr: String(err?.message ?? err) };
  }
}

/** The commit a ref names, or null. */
export function revParse(exec, dir, ref) {
  const r = call(exec, ['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

/**
 * The merge commits of the first-parent history of `base`, newest first. Throws when git cannot read the branch.
 * @returns {{oid: string, parents: string[], at: number, subject: string}[]}
 */
export function localMerges(exec, dir, base) {
  const r = call(exec, ['git', 'log', '--first-parent', '--merges', '--format=%H%x1f%P%x1f%cI%x1f%s', `refs/heads/${base}`, '--'], dir);
  if (r.code !== 0) throw new Error(`git log ${base} failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  return r.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => {
    const [oid, parents, at, subject] = l.split('\x1f');
    return { oid, parents: String(parents ?? '').split(' ').filter(Boolean), at: Date.parse(at), subject: subject ?? '' };
  });
}

/**
 * The merge of a slice branch into `base`, or null when it is not merged. `tip` is the commit of the branch now (null
 * when the branch is gone); `recorded` is the commit of the `merged:` record of the sheet, which proves a merge whose
 * branch was cleaned up.
 * @param {{oid: string, parents: string[]}[]} merges from `localMerges`
 * @param {{tip: string|null, recorded?: string|null}} where
 * @returns {{oid: string, parents: string[], at: number, subject: string}|null}
 */
export function findMerge(merges, { tip, recorded = null }) {
  if (tip !== null) {
    const m = merges.find((x) => x.parents.slice(1).includes(tip));
    if (m !== undefined) return m;
  }
  if (typeof recorded === 'string' && SHA.test(recorded)) return merges.find((x) => x.oid === recorded) ?? null;
  return null;
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The slice branches merged into `base`, by the one rule of the local forge (`findMerge`): a merge commit of the
 * first-parent history of `base` has the tip of the branch as a parent, or, once the branch is gone, the `merged:`
 * record of its sheet names such a merge. The subject of the merge commit is never read, so an edited message counts.
 * @param {Exec} exec
 * @param {string} dir the main checkout of the repository
 * @param {string} base
 * @param {{branch: string, recorded?: string|null}[]} entries the branches to look for, each once
 * @param {{oid: string, parents: string[], at: number, subject: string}[]} [merges] from `localMerges`, read when absent
 * @returns {{branch: string, merge: {oid: string, parents: string[], at: number, subject: string}}[]}
 */
export function mergedBranches(exec, dir, base, entries, merges = localMerges(exec, dir, base)) {
  const out = [];
  const seen = new Set();
  for (const { branch, recorded = null } of entries) {
    if (typeof branch !== 'string' || !BRANCH_NAME.test(branch) || seen.has(branch)) continue;
    seen.add(branch);
    const merge = findMerge(merges, { tip: revParse(exec, dir, `refs/heads/${branch}`), recorded });
    if (merge !== null) out.push({ branch, merge });
  }
  return out;
}

/**
 * The exact git command the owner runs to merge a slice branch, with each value quoted for a POSIX shell.
 * @param {string} repo the folder of the main checkout of the code repository
 * @param {string} branch
 */
export function mergeCommand(repo, branch) {
  const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  return `git -C ${q(repo)} merge --no-ff ${branch}`;
}
