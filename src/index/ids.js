/** ID grammar (spec 7.2). Longest forms first so alternation never stops early. */
/** A milestone ID. It is a real ID in the ID column of a table, but too common a word-and-number to mute in a sentence. */
const MILESTONE_FORM = 'M\\d{1,2}';
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
  MILESTONE_FORM,
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Alternation of every ID form, without boundaries or flags.
 * @param {string[]} [lots]
 * @param {{milestones?: boolean}} [options] `milestones: false` leaves out the bare `M1` form
 * @returns {string}
 */
export function idSource(lots = [], { milestones = true } = {}) {
  const backlog = lots.map((lot) => `${escapeRe(lot)}-\\d{2,3}`);
  const fixed = milestones ? FIXED_FORMS : FIXED_FORMS.filter((form) => form !== MILESTONE_FORM);
  return [...fixed, ...backlog].join('|');
}

/**
 * Build the ID regex, optionally with backlog lots (`<LOT>-NN`).
 * @param {string[]} [lots]
 * @param {{global?: boolean, anchored?: boolean, milestones?: boolean}} [flags]
 * @returns {RegExp}
 */
export function buildIdPattern(lots = [], { global = true, anchored = false, milestones = true } = {}) {
  const body = idSource(lots, { milestones });
  const re = anchored ? `^(?:${body})$` : `\\b(?:${body})\\b`;
  return new RegExp(re, global ? 'g' : '');
}

/** Global pattern for the fixed forms. Use matchAll, or reset lastIndex before exec. */
export const ID_PATTERN = buildIdPattern();
