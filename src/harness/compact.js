import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file of the settings of Claude Code for one project on one machine, never committed. */
export const LOCAL_SETTINGS = '.claude/settings.local.json';

/**
 * Write the auto-compact window of the sessions of a project (`autoCompactWindow`, in tokens) in its local settings,
 * or take it out when `tokens` is null. The other keys of the file stay. A file that is not a JSON object is left as
 * it is, and the reason comes back.
 * @param {string} root the workspace
 * @param {number|null} tokens
 * @returns {{changed: boolean, error?: string}}
 */
export function applyCompact(root, tokens) {
  const path = join(root, LOCAL_SETTINGS);
  let data = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      return { changed: false, error: `${LOCAL_SETTINGS} is not valid JSON (${String(err.message).split('\n')[0]}), so the compact size was not written` };
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { changed: false, error: `${LOCAL_SETTINGS} does not hold a JSON object, so the compact size was not written` };
  }
  const before = data.autoCompactWindow;
  if (tokens === null) delete data.autoCompactWindow;
  else data.autoCompactWindow = tokens;
  if (before === data.autoCompactWindow) return { changed: false };
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return { changed: true };
}
