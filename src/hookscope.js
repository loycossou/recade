import { dirname, join, resolve } from 'node:path';

/**
 * The Recade project a folder belongs to, or null. It walks up from `start` to the first folder that holds
 * `recade/state.yaml` (a workspace, or an older project in one folder) or `.recade/workspace` (a code repository
 * linked to its workspace). The hooks of the plugin run in every session; they act only when this finds a project.
 * No YAML parser and no git call: it costs a few `exists` checks.
 * @param {string} start
 * @param {{exists: (f: string) => boolean}} fs
 * @returns {{root: string, kind: 'project'|'code'}|null}
 */
export function recadeProject(start, { exists }) {
  if (typeof start !== 'string' || start === '') return null;
  for (let d = resolve(start); ; d = dirname(d)) {
    if (exists(join(d, 'recade', 'state.yaml'))) return { root: d, kind: 'project' };
    if (exists(join(d, '.recade', 'workspace'))) return { root: d, kind: 'code' };
    if (dirname(d) === d) return null;
  }
}
