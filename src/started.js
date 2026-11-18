// No dependencies besides node: modules. bin/recade-hook.js loads this file in a plugin install
// without node_modules, so it cannot use the yaml package.

// A top-level `started` key at column 0 whose value is true, True, TRUE, "true" or 'true',
// with an optional trailing `# comment`.
const STARTED_LINE = /^started:[ \t]*(?:true|True|TRUE|"true"|'true')(?:[ \t]+#.*|[ \t]*)$/;

/**
 * True when the raw config text sets `started` to true at the top level.
 * Nested keys, comments and other spellings do not count.
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
export function isStarted(text) {
  if (typeof text !== 'string') return false;
  return text.split(/\r?\n/).some((line) => STARTED_LINE.test(line));
}
