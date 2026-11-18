/** `U+202E`: the code point of a one-character match, as it is written in reports (the character itself is never echoed). */
export const codePointOf = (text) => `U+${text.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/** A BOM is legitimate as the first character of a file, and only there. */
const isLeadingBom = (m, lineNo) => lineNo === 1 && m.index === 0 && m[0] === '\uFEFF';

/**
 * Style rules. Patterns are global so every match on a line is reported. `message` may be a function of the match.
 * `applies` can keep a match out of a rule (it gets the match and the 1-based line number). `invisible` marks the
 * rules about characters a reader cannot see, which the intake scan also uses.
 * @type {{id: string, severity: 'error'|'warn', pattern: RegExp, message: string | ((m: RegExpMatchArray) => string), invisible?: boolean, applies?: (m: RegExpMatchArray, lineNo: number) => boolean}[]}
 */
export const RULES = [
  {
    id: 'em-dash',
    severity: 'error',
    pattern: /\u2014/g,
    message: 'Em dash. Use a comma, a colon, parentheses or a new sentence.',
  },
  {
    id: 'tic-delve', // recade-style-ignore
    severity: 'warn',
    pattern: /\bdelv(e|es|ing)\b/gi,
    message: 'Writing tic "delve". Say "look at" or "examine".', // recade-style-ignore
  },
  {
    id: 'tic-leverage', // recade-style-ignore
    severity: 'warn',
    pattern: /\bleverag(e|es|ing)\b/gi,
    message: 'Writing tic "leverage". Say "use".', // recade-style-ignore
  },
  {
    id: 'tic-robust', // recade-style-ignore
    severity: 'warn',
    pattern: /\brobust\b/gi,
    message: 'Writing tic "robust". Say what makes it hold.', // recade-style-ignore
  },
  {
    id: 'tic-seamless', // recade-style-ignore
    severity: 'warn',
    pattern: /\bseamless(ly)?\b/gi,
    message: 'Writing tic "seamless". Describe the actual behaviour.', // recade-style-ignore
  },
  {
    id: 'tic-important-to-note',
    severity: 'warn',
    pattern: /it'?s important to note/gi,
    message: 'Writing tic "it\'s important to note". State the point directly.',
  },
  {
    id: 'tic-dive-in',
    severity: 'warn',
    pattern: /let'?s dive in/gi,
    message: 'Writing tic "let\'s dive in". Start with the content.',
  },
  {
    id: 'tic-unlock',
    severity: 'warn',
    pattern: /unlock the power/gi, // recade-style-ignore
    message: 'Writing tic "unlock the power". Say what the tool does.', // recade-style-ignore
  },
  // Invisible Unicode. A hidden character can make a text read differently to a person and to an agent, so these
  // are errors, except the ones that are legitimate in some scripts. Tests build them with \u escapes.
  {
    id: 'bidi-control',
    severity: 'error',
    invisible: true,
    pattern: /[\u202A-\u202E\u2066-\u2069]/g,
    message: (m) => `Bidirectional control character ${codePointOf(m[0])}. It can make text read in another order than it is stored. Delete it.`,
  },
  {
    id: 'invisible-char',
    severity: 'error',
    invisible: true,
    pattern: /[\u200B\u2060\uFEFF]/g,
    applies: (m, lineNo) => !isLeadingBom(m, lineNo),
    message: (m) => `Invisible character ${codePointOf(m[0])} (zero width space, word joiner or BOM inside the text). Delete it.`,
  },
  {
    id: 'bom',
    severity: 'warn',
    invisible: true,
    pattern: /\uFEFF/g,
    applies: isLeadingBom,
    message: (m) => `Byte order mark ${codePointOf(m[0])} at the start of the file. Save the file without it.`,
  },
  {
    id: 'joiner',
    severity: 'warn',
    invisible: true,
    pattern: /[\u200C\u200D]/g,
    message: (m) => `Zero width joiner or non-joiner ${codePointOf(m[0])}. Legitimate in Persian, Indic scripts and emoji, so check that it belongs here.`,
  },
];

export const IGNORE_MARKER = 'recade-style-ignore';
export const SCANNED_EXTS = ['.md', '.js', '.json', '.yml', '.yaml', '.txt'];
