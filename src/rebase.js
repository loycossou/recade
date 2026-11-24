import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The files an older Recade kept in a code repository, which a clean removes from the default branch. A conflict that
 * holds only these files during a rebase on that branch has one answer: the branch's version, removed or kept.
 */
export const LEFTOVER = /^(\.claude\/|\.githooks\/|\.github\/workflows\/(conflicts|second-opinion|recade|recade-conflicts|recade-second-opinion)\.yml$)/;

/**
 * Settle the conflicts of a rebase in progress when every conflicted file is a leftover of an older Recade: each takes
 * the version of the branch the slice is rebased on (in a rebase, `--ours`), or is removed when that branch removed it.
 * Any other conflicted file stops it: nothing is changed, and the files are named for the owner.
 * @param {string} dir the worktree where the rebase runs
 * @returns {{state: 'none'|'resolved'|'others'|'clean', resolved?: string[], others?: string[], message: string}}
 */
export function resolveLeftovers(dir) {
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const gitDir = git('rev-parse', '--git-dir');
  const at = gitDir.status === 0 ? resolve(dir, gitDir.stdout.trim()) : null;
  if (at === null || (!existsSync(resolve(at, 'rebase-merge')) && !existsSync(resolve(at, 'rebase-apply')))) {
    return { state: 'none', message: 'No rebase is in progress here.' };
  }
  const conflicted = git('diff', '--name-only', '--diff-filter=U').stdout.split('\n').filter(Boolean);
  if (conflicted.length === 0) return { state: 'clean', message: 'The rebase has no conflict.' };
  const others = conflicted.filter((f) => !LEFTOVER.test(f));
  if (others.length > 0) return { state: 'others', others, message: `These conflicts are not leftovers of an older Recade, so nothing was resolved: ${others.join(', ')}.` };
  for (const f of conflicted) {
    const onBase = git('cat-file', '-e', `:2:${f}`).status === 0;
    const r = onBase ? git('checkout', '--ours', '--', f) : git('rm', '-q', '--', f);
    if (r.status !== 0) return { state: 'others', others: [f], message: `${f} could not be resolved: ${String(r.stderr).trim().split('\n')[0]}` };
    if (onBase) git('add', '--', f);
  }
  return { state: 'resolved', resolved: conflicted, message: `Resolved with the version of the base branch: ${conflicted.join(', ')}. Run git rebase --continue.` };
}
