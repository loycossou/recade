const RULE = /^---[ \t]*\r?$/;

/**
 * Number of lines taken by a leading YAML front matter block, closing rule included, or 0 when the
 * text does not open with a closed block. Lines may keep their `\r`. Dependency free on purpose.
 * @param {string[]} lines
 * @returns {number}
 */
export function frontMatterLength(lines) {
  if (!RULE.test(lines[0] ?? '')) return 0;
  const end = lines.findIndex((l, i) => i > 0 && RULE.test(l));
  return end === -1 ? 0 : end + 1;
}
