import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnFile } from '../project/adopt.js';
import { SPEC_LINE } from './install.js';

/** The folders of the two kinds of harness file, relative to the root of a target. */
const FOLDERS = { agent: '.claude/agents', command: '.claude/commands' };
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEADER = /<!-- recade-harness v\S+: specialise below the line -->/;
const MAX_BYTES = 64 * 1024;

export class SpecialiseError extends Error {}

/**
 * Add the team's own text below the specialisation line of one agent or one command of the harness, in the target at
 * `root` (the workspace or a code repository). This is the way to do it once the guard is active: the guard refuses
 * every Edit and Write in `.claude/agents/` and `.claude/commands/`, and an agent never runs the command that calls this.
 * The text goes at the end of the file, after a blank line. The same text twice changes nothing. The generic part above
 * the line is never touched, and a re-install keeps what is below it.
 * @param {string} root
 * @param {string} kind `agent` or `command`
 * @param {string} name file name without `.md`, lower-case words joined by hyphens
 * @param {string} text
 * @param {{adopt?: boolean}} [options] `adopt`: write through the own-files policy (the file is recorded with its new hash)
 * @returns {{status: 'updated'|'unchanged', file: string}} `file` is relative to `root`
 */
export function specialise(root, kind, name, text, { adopt = false } = {}) {
  if (!Object.hasOwn(FOLDERS, kind)) throw new SpecialiseError(`The first word is agent or command, not ${JSON.stringify(kind)}.`);
  if (typeof name !== 'string' || !NAME.test(name)) throw new SpecialiseError(`The name of ${kind === 'agent' ? 'an agent' : 'a command'} is lower-case words joined by hyphens, not ${JSON.stringify(name)}.`);
  const rel = `${FOLDERS[kind]}/${name}.md`;
  const path = join(root, ...rel.split('/'));
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new SpecialiseError(`No ${kind} ${name} in ${join(root, FOLDERS[kind])}. Install the harness there first.`);
  const body = String(text).replace(/\r\n/g, '\n').trim();
  if (body === '') throw new SpecialiseError('The text is empty.');
  if (Buffer.byteLength(body) > MAX_BYTES) throw new SpecialiseError('The text is over 64 KB.');
  if (body.includes('\0')) throw new SpecialiseError('The text holds a NUL character.');
  if (body.includes(SPEC_LINE) || HEADER.test(body)) throw new SpecialiseError('The text holds the specialisation line or the version header of the harness: leave them out.');
  const existing = readFileSync(path, 'utf8');
  const at = existing.split('\n').findIndex((l) => l.replace(/\r$/, '') === SPEC_LINE);
  if (at < 0) throw new SpecialiseError(`${rel} has no specialisation line (${SPEC_LINE}), so a re-install would not keep the text. Add the line by hand, then run this again.`);
  const below = existing.split('\n').slice(at + 1).join('\n');
  if (below.replace(/\r\n/g, '\n').includes(body)) return { status: 'unchanged', file: rel };
  const next = `${existing.replace(/\s+$/, '')}\n\n${body}\n`;
  if (adopt) writeOwnFile(root, rel, next, { keepEdits: true });
  else writeFileSync(path, next);
  return { status: 'updated', file: rel };
}
