/** ID grammar (spec 7.2). Longest forms first so alternation never stops early. */
const FIXED_FORMS = [
  'FR-[A-Z]{2,4}-\\d{2,3}',
  'SEC-[A-Z]{2,4}-\\d{2,3}',
  'SEC-A\\d{2,3}',
  'NFR-\\d{2,3}',
  'PAR-\\d{2,3}',
  'PRI-\\d{2,3}',
  'DEC-\\d{2,3}',
  'ADR-\\d{2,3}',
  'TB-\\d{1,2}',
  'RSK-\\d{2,3}',
  'EXT-\\d{2,3}',
  'PRV-\\d{2,3}',
  'INC-\\d{1,2}',
  'Q-\\d{2,3}',
  'S-\\d{2}[a-z]?',
  'M\\d{1,2}',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Alternation of every ID form, without boundaries or flags.
 * @param {string[]} [lots]
 * @returns {string}
 */
export function idSource(lots = []) {
  const backlog = lots.map((lot) => `${escapeRe(lot)}-\\d{2,3}`);
  return [...FIXED_FORMS, ...backlog].join('|');
}

/**
 * Build the ID regex, optionally with backlog lots (`<LOT>-NN`).
 * @param {string[]} [lots]
 * @param {{global?: boolean, anchored?: boolean}} [flags]
 * @returns {RegExp}
 */
export function buildIdPattern(lots = [], { global = true, anchored = false } = {}) {
  const body = idSource(lots);
  const re = anchored ? `^(?:${body})$` : `\\b(?:${body})\\b`;
  return new RegExp(re, global ? 'g' : '');
}

/** Global pattern for the fixed forms. Use matchAll, or reset lastIndex before exec. */
export const ID_PATTERN = buildIdPattern();
