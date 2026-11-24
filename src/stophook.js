import { dirname, join, resolve } from 'node:path';

/**
 * The workspace the Stop hook pushes, or null. It walks up from `start` to the first `recade/state.yaml`, and answers
 * only when that state is a workspace whose owner turned auto-push on. It reads the text with two line tests, never a
 * YAML parser, so that the hook stays free of dependencies and costs nothing in a folder that is not a workspace.
 * @param {string} start
 * @param {{exists: (f: string) => boolean, read: (f: string) => string}} fs
 * @returns {string|null}
 */
export function autoPushWorkspace(start, { exists, read }) {
  for (let d = resolve(start); ; d = dirname(d)) {
    const file = join(d, 'recade', 'state.yaml');
    if (exists(file)) {
      let text = '';
      try {
        text = read(file);
      } catch {
        return null;
      }
      return /^kind:\s*["']?workspace["']?\s*$/m.test(text) && /^workspace:\s*\n(?:[ \t]+.*\n)*?[ \t]+auto_push:\s*true\s*$/m.test(text) ? d : null;
    }
    if (dirname(d) === d) return null;
  }
}

/**
 * The workspace a session starts in, or null: the first `recade/state.yaml` above `start` that says `kind: workspace`.
 * Two line tests, no YAML parser.
 */
export function workspaceAt(start, { exists, read }) {
  for (let d = resolve(start); ; d = dirname(d)) {
    const file = join(d, 'recade', 'state.yaml');
    if (exists(file)) {
      try {
        return /^kind:\s*["']?workspace["']?\s*$/m.test(read(file)) ? d : null;
      } catch {
        return null;
      }
    }
    if (dirname(d) === d) return null;
  }
}
