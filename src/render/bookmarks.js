import { createHash } from 'node:crypto';

const BOOKMARK_MAX = 40;

const SAFE_LINK = /^(#|https?:|mailto:|tel:)/i;

/** True for a link a rendered document may carry: an anchor, http(s), mailto or tel. `javascript:` and the like are not. */
export const isSafeLink = (url) => SAFE_LINK.test(String(url ?? ''));

const shortHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);

/**
 * A Word bookmark name for a heading anchor or an ID: at most 40 characters, a letter first, then letters, digits
 * and underscores only. Deterministic and collision-safe: every dash becomes an underscore, IDs (`FR-LND-01`) keep
 * their form (`FR_LND_01`), heading anchors (`vision-goals`) get an `h_` prefix, an ID that starts with a digit gets
 * `id_`. A name that had to lose other characters, or that is too long, ends in a short hash of the original, so two
 * different inputs never share a name.
 * @param {string} anchorOrId
 * @returns {string}
 */
export function bookmarkName(anchorOrId) {
  const raw = String(anchorOrId ?? '');
  const lossless = /^[A-Za-z0-9-]*$/.test(raw);
  let prefix = 'h_';
  if (/^[A-Z][A-Z0-9-]*$/.test(raw)) prefix = '';
  else if (/^[A-Z0-9-]+$/.test(raw)) prefix = 'id_';
  let name = prefix + raw.replace(/[^A-Za-z0-9]/g, '_');
  if (!lossless) name += `_${shortHash(raw)}`;
  if (name.length > BOOKMARK_MAX) name = `${name.slice(0, BOOKMARK_MAX - 9)}_${shortHash(raw)}`;
  return name;
}
