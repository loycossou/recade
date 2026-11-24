import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** The settings of the code repository `<name>`, in the workspace: `recade/repos/<name>.yaml`, `harness: {required_gates, threshold_files}`. */
export const repoSettingsRel = (name) => `recade/repos/${name}.yaml`;

/**
 * The settings file of the code repository `dir` (or of a worktree of it): in the workspace named by its link
 * (`.recade/workspace` of its main checkout), under the name of the main checkout. Null when the repository has no link.
 * Zero dependencies: the guard calls it.
 */
export function repoSettingsFile(dir) {
  const main = mainCheckout(dir);
  let ws = '';
  try {
    ws = readFileSync(join(main, '.recade', 'workspace'), 'utf8').split('\n')[0].trim();
  } catch {
    return null;
  }
  return ws === '' ? null : join(ws, repoSettingsRel(basename(main)));
}

/** The main checkout of a git folder: the folder itself, or, for a linked worktree, the folder of its common git folder. */
function mainCheckout(dir) {
  try {
    const dotGit = join(dir, '.git');
    if (statSync(dotGit).isDirectory()) return dir;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!gitdir) return dir;
    const abs = resolve(dir, gitdir);
    const common = resolve(abs, readFileSync(join(abs, 'commondir'), 'utf8').trim());
    return basename(common) === '.git' ? dirname(common) : dir;
  } catch {
    return dir;
  }
}

