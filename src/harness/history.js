import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_LINE, genericOf } from './install.js';
import { frontMatterLength } from '../frontmatter-lines.js';

/**
 * The fingerprints of every text Recade ever installed above the specialisation line of a harness file
 * (`harness/history.json`, written by `node tools/harness-history.js` from the git history of the templates).
 *
 * `recade harness migrate` removes an old harness copy of a code repository when its text above the line is one of
 * them: that text is Recade's, of an earlier version, and a re-install would replace it anyway. A line the team wrote
 * there gives another fingerprint, and the file stays.
 */

export const HISTORY_FILE = join('harness', 'history.json');
const HEADER = /^<!-- recade-harness v\S+: specialise below the line -->$/;

/**
 * The fingerprint of the text above the specialisation line of a harness file, or of a template. The version header and
 * the model line are left out: the first changes with each release, the second with the models the project chose.
 */
export function fingerprint(text) {
  let lines = genericOf(String(text).replace(/\r\n/g, '\n').split(`\n${SPEC_LINE}`)[0], '0').split('\n');
  const end = frontMatterLength(lines);
  lines = lines.filter((l, i) => !HEADER.test(l) && !(i < end && l.startsWith('model:')));
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
}

/** The fingerprints the plugin ships, as a Set. Empty when the file is missing or unreadable. */
export function knownTexts(pluginRoot) {
  const path = join(pluginRoot, HISTORY_FILE);
  if (!existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return new Set(Array.isArray(data?.texts) ? data.texts.filter((t) => typeof t === 'string') : []);
  } catch {
    return new Set();
  }
}
