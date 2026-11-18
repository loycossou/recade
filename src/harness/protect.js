import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadState } from '../state.js';
import { isAdopt, workflowFiles } from './install.js';
import { WORKSPACE_WORKFLOW } from './targets.js';

/**
 * Branch protection on GitHub: no direct push to the main branch, a pull request and the CI checks required, for the
 * administrators too. It is the real barrier against a merge or a push by an agent that runs with the owner's `gh`
 * login; the guard is defence in depth. `/recade:harness` offers it and runs `--apply` only after the owner says yes.
 * Without `apply` nothing is called but a read. The workspace repository (`kind: workspace` in its state) gets looser
 * rules (see `workspaceProtectionArgs`): its commands push to the default branch.
 */

/**
 * A check name per job of the workflows of `root`: the `name` of the job, else its key. A code repository has the CI and
 * conflicts workflows; the workspace has `workspace.yml`, and an unreadable or absent one gives no check, never an error.
 */
export function requiredChecks(root, adopt = isAdopt(root)) {
  const names = [];
  let workspace = false;
  try {
    workspace = loadState(root)?.kind === 'workspace';
  } catch { /* a state that cannot be read is no workspace here */ }
  const wf = workflowFiles(adopt);
  for (const f of workspace ? [WORKSPACE_WORKFLOW] : [wf.ci, wf.conflicts]) {
    const path = join(root, f);
    if (!existsSync(path)) continue;
    let jobs;
    try {
      jobs = parse(readFileSync(path, 'utf8'))?.jobs ?? {};
    } catch (err) {
      if (!workspace) throw err;
      continue;
    }
    for (const [key, job] of Object.entries(jobs)) names.push(typeof job?.name === 'string' ? job.name : key);
  }
  return names;
}

/** The `gh api` arguments that set the protection of a branch. */
export function protectionArgs(repo, branch, checks) {
  const args = ['api', '-X', 'PUT', `repos/${repo}/branches/${branch}/protection`];
  args.push('-F', 'required_status_checks[strict]=true');
  for (const c of checks) args.push('-f', `required_status_checks[contexts][]=${c}`);
  args.push(
    '-F', 'enforce_admins=true',
    '-F', 'required_pull_request_reviews[required_approving_review_count]=0',
    '-F', 'restrictions=null',
    '-F', 'allow_force_pushes=false',
    '-F', 'allow_deletions=false',
  );
  return args;
}

/**
 * The `gh api` arguments for the workspace repository. Recade commits and pushes documents straight to its default
 * branch, so no pull request and no check is required; force push and deletion are blocked and the history is linear.
 */
export function workspaceProtectionArgs(repo, branch) {
  return [
    'api', '-X', 'PUT', `repos/${repo}/branches/${branch}/protection`,
    '-F', 'required_status_checks=null',
    '-F', 'enforce_admins=true',
    '-F', 'required_pull_request_reviews=null',
    '-F', 'restrictions=null',
    '-F', 'required_linear_history=true',
    '-F', 'allow_force_pushes=false',
    '-F', 'allow_deletions=false',
  ];
}

const show = (args) => ['gh', ...args].map((a) => (/^[\w@%+=:,./\[\]-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(' ');

/**
 * @param {string} root
 * @param {{exec: (cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}, apply?: boolean, branch?: string}} options
 * @returns {{repo: string|null, branch: string, checks: string[], command: string, applied: boolean, error: string|null}}
 */
export function protect(root, { exec, apply = false, branch = 'main', code = null }) {
  // `code`: `root` is a code repository of a workspace (`{adopt}` tells which workflow names it has). It gets the strict
  // rules, and its GitHub name comes from gh run in that repository, never from the workspace state.
  const result = { repo: null, branch, checks: requiredChecks(root, code === null ? undefined : code.adopt === true), command: '', applied: false, error: null, workspace: false };
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return { ...result, error: `Not a branch name: ${branch}` };
  let repo = null;
  let workspace = false;
  try {
    const state = code === null ? loadState(root) : null;
    workspace = state?.kind === 'workspace';
    const gh = state?.github;
    if (gh?.owner && gh?.repo) repo = `${gh.owner}/${gh.repo}`;
  } catch {
    repo = null;
  }
  if (repo === null) {
    const r = exec(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: root });
    if (r.code !== 0 || !/^[\w.-]+\/[\w.-]+$/.test(r.stdout.trim())) return { ...result, error: code === null ? 'The GitHub repository is not known: no github: record in recade/state.yaml and gh cannot tell. Create it with /recade:slices first.' : 'The GitHub repository of this code repository is not known: gh cannot tell from its remote. Create it and push it first.' };
    repo = r.stdout.trim();
  }
  if (workspace) result.checks = [];
  else if (result.checks.length === 0) return { ...result, repo, error: 'No CI job found in .github/workflows. Install the harness first.' };
  const args = workspace ? workspaceProtectionArgs(repo, branch) : protectionArgs(repo, branch, result.checks);
  result.repo = repo;
  result.workspace = workspace;
  result.command = show(args);
  if (!apply) return result;
  const r = exec(['gh', ...args], { cwd: root });
  if (r.code !== 0) return { ...result, error: `gh could not set the protection: ${(r.stderr || r.stdout).trim().split('\n')[0]}` };
  return { ...result, applied: true };
}
