import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const readRegular = (file) => {
  try {
    return lstatSync(file).isFile() ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
};

/** The PLAN of every workspace, whatever the mode of the project. */
export const PLAN_FILE = 'docs/PLAN.md';

/**
 * The PLAN of `root`, the one resolver for `slices check`, `github init` and the board. It is `docs/PLAN.md` of the
 * workspace: an adopted project has no other place for it (the code repositories hold no Recade document).
 * @param {string} root workspace folder
 * @returns {{file: string, text: string}|null} the path relative to `root`, and the text; null when there is none
 */
export function findPlan(root) {
  const text = readRegular(join(root, 'docs', 'PLAN.md'));
  return text === null ? null : { file: PLAN_FILE, text };
}

/** The text of the PLAN of `root` (see findPlan), or null. */
export const readPlan = (root) => findPlan(root)?.text ?? null;

/**
 * Where the PLAN is, or where it is to be written: always `docs/PLAN.md`.
 * @param {string} root workspace folder
 * @returns {string}
 */
export const planFile = (_root) => PLAN_FILE;
