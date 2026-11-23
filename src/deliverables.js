/**
 * The extra deliverables the owner can ask for, on top of D1, D2, D3 and the PLAN which are always rendered.
 * The order here is the order they are rendered in, whatever order the owner typed them in.
 */
export const EXTRAS = Object.freeze(['stack', 'decisions', 'design', 'reviews']);

/**
 * The values of `deliverables.deck`, the PowerPoint deck for a steering committee: `ask` until the owner answered the
 * question of `/recade:start` or `/recade:docs`, then `yes` or `no`. The deck is rendered only on `yes`.
 */
export const DECK_CHOICES = Object.freeze(['ask', 'yes', 'no']);

/** True when `value` is the name of an extra deliverable. */
export const isExtra = (value) => typeof value === 'string' && EXTRAS.includes(value);

/**
 * The extras named by a raw `config set` value: comma separated, `none` or an empty value for no extra. Duplicates
 * go, the order is the canonical one. Throws an Error with a one-line message on an unknown name.
 * @param {string} raw
 * @returns {string[]}
 */
export function parseExtras(raw) {
  const names = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 1 && names[0].toLowerCase() === 'none') return [];
  if (names.some((n) => n.toLowerCase() === 'none')) throw new Error('none cannot be combined with other extras.');
  const unknown = names.find((n) => !isExtra(n));
  if (unknown !== undefined) throw new Error(`Unknown extra deliverable: ${unknown}. Use ${EXTRAS.join(', ')}, or none.`);
  return EXTRAS.filter((e) => names.includes(e));
}
