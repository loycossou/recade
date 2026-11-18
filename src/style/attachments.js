import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { scanInvisible } from './lint.js';

/**
 * The intake scan: every file under `intake/attachments/` is checked for invisible Unicode and bidirectional controls
 * before an agent reads it. A file that cannot be checked is not skipped in silence, it is a BLOCKING finding.
 * @typedef {import('./lint.js').Finding & {total?: number}} Finding
 */

/** Plain text types, scanned as text. */
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.svg', '.html', '.htm', '.xml', '.csv', '.tsv', '.json', '.yaml', '.yml', '.ini', '.rtf']);
/** Zip containers of XML (Office and OpenDocument): their XML parts are scanned. */
const ZIP_EXTS = new Set(['.docx', '.pptx', '.xlsx', '.odt']);
/** Markup types, where `&#x202E;` is a character to the reader and so is decoded. */
const MARKUP_EXTS = new Set(['.svg', '.html', '.htm', '.xml']);
/** The parts of a container that hold text. Pictures, fonts and the like inside it are not read by an agent. */
const ZIP_TEXT_PARTS = /\.(xml|rels|txt|html|json|csv)$/i;
const ZIP_MARKUP_PARTS = /\.(xml|rels|html)$/i;
/** Folders the project copy skips, and files that are operating system litter and not attachments. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.superpowers']);
/** `.gitkeep` is the empty placeholder the scaffold writes in `intake/attachments/`: nothing in it to read. */
const LITTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep']);

/** Limits. Each can be lowered in the options (the tests do). */
export const DEFAULT_CAPS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFindingsPerFile: 20,
  maxEntries: 2000,
  maxFiles: 5000,
  maxDepth: 16,
});

const mb = (n) => (n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${n} bytes`);

/** Text of a buffer: UTF-16 when it has a byte order mark, UTF-8 otherwise. */
function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8');
}

/** A finding about a file that could not be checked. */
const notScanned = (file, why) => ({ file, rule: 'not-scanned', severity: 'error', message: `Not scanned: ${why}. Do not let an agent read it until the owner has checked it by hand.` });

/** The findings of one text, capped: the first `max` are listed, then one line with the count of the others. */
function scanTextFile(text, file, max, references = false) {
  const found = scanInvisible(text, file, { limit: max, references });
  const out = [...found];
  if (found.total > found.length) {
    const hiddenErrors = found.errors - found.filter((f) => f.severity === 'error').length;
    out.push({
      file, rule: 'more-findings', severity: hiddenErrors > 0 ? 'error' : 'warn', total: found.total,
      message: `${found.total - found.length} more findings are not listed (${found.total} in total in this file).`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Zip containers, with node zlib only
// ---------------------------------------------------------------------------------------------------------

class ZipError extends Error {}

/** The central directory of a zip file: name, flags, method and sizes of each entry. Zip64 is refused. */
function zipEntries(buf, maxEntries) {
  const from = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a readable zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
  if (count > maxEntries) throw new ZipError(`more than ${maxEntries} entries`);
  if (offset + size > buf.length) throw new ZipError('the central directory is outside the file');
  const entries = [];
  let pos = offset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new ZipError('damaged central directory');
    const nameLength = buf.readUInt16LE(pos + 28);
    const entry = {
      flags: buf.readUInt16LE(pos + 8), method: buf.readUInt16LE(pos + 10),
      compressed: buf.readUInt32LE(pos + 20), size: buf.readUInt32LE(pos + 24), offset: buf.readUInt32LE(pos + 42),
      name: buf.toString('utf8', pos + 46, pos + 46 + nameLength),
    };
    if (entry.compressed === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) throw new ZipError('zip64 entries are not supported');
    entries.push(entry);
    pos += 46 + nameLength + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  return entries;
}

/** The bytes of one entry, stored or deflated, never more than its declared size, which must itself be under the cap. */
function zipEntryData(buf, e) {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new ZipError('damaged local header');
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  if (start + e.compressed > buf.length) throw new ZipError('entry data is outside the file');
  const raw = buf.subarray(start, start + e.compressed);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
  else throw new ZipError(`compression method ${e.method} is not supported`);
  if (data.length !== e.size) throw new ZipError('the size of the entry does not match its header');
  return data;
}

function scanZip(buf, file, caps) {
  const out = [];
  let budget = caps.maxTotalBytes;
  let entries;
  try {
    entries = zipEntries(buf, caps.maxEntries);
  } catch (err) {
    return [notScanned(file, err instanceof ZipError ? err.message : 'the archive could not be read')];
  }
  for (const e of entries) {
    if (e.name.endsWith('/') || !ZIP_TEXT_PARTS.test(e.name)) continue;
    const label = `${file}!${e.name}`;
    try {
      if (e.flags & 1) throw new ZipError('the entry is encrypted');
      if (e.size > caps.maxEntryBytes) throw new ZipError(`the entry is over the ${mb(caps.maxEntryBytes)} cap`);
      budget -= e.size;
      if (budget < 0) throw new ZipError(`the archive holds more than ${mb(caps.maxTotalBytes)} of text`);
      out.push(...scanTextFile(decode(zipEntryData(buf, e)), label, caps.maxFindingsPerFile, ZIP_MARKUP_PARTS.test(e.name)));
    } catch (err) {
      out.push(notScanned(label, err instanceof ZipError ? err.message : 'the entry could not be inflated'));
      if (budget < 0) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------------------

/**
 * Scan everything under `intake/attachments/` of a project, at any depth. `blocking` is true when one finding is an
 * error: a hidden or bidirectional character, or a file that could not be checked (a symbolic link, a skipped folder,
 * an archive that cannot be read, any binary that is not a known container, a file over the byte cap). Findings per file
 * are capped (the first ones, then one `more-findings` line). Paths in the findings are relative to the project.
 * @param {string} root project folder
 * @param {Partial<typeof DEFAULT_CAPS>} [options]
 * @returns {{findings: Finding[], blocking: boolean}}
 */
export function scanAttachments(root, options = {}) {
  const caps = { ...DEFAULT_CAPS, ...options };
  const base = join(root, 'intake', 'attachments');
  const findings = [];
  let files = 0;
  let stopped = false;

  const scanFile = (path, label) => {
    const ext = extname(path).toLowerCase();
    try {
      const size = lstatSync(path).size;
      if (size > caps.maxFileBytes) {
        findings.push(notScanned(label, `the file is over the ${mb(caps.maxFileBytes)} cap`));
      } else if (TEXT_EXTS.has(ext)) {
        findings.push(...scanTextFile(decode(readFileSync(path)), label, caps.maxFindingsPerFile, MARKUP_EXTS.has(ext)));
      } else if (ZIP_EXTS.has(ext)) {
        findings.push(...scanZip(readFileSync(path), label, caps));
      } else {
        findings.push(notScanned(label, `${ext === '' ? 'a file with no extension' : `a ${ext} file`} is a binary or unknown type that cannot be checked for hidden characters`));
      }
    } catch {
      findings.push(notScanned(label, 'the file could not be read'));
    }
  };

  const walk = (dir, rel, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (rel === '' && err?.code === 'ENOENT') return;
      findings.push(notScanned(`intake/attachments/${rel}`.replace(/\/$/, ''), 'the folder could not be read'));
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (stopped) return;
      if (LITTER.has(e.name)) continue;
      const path = join(dir, e.name);
      const label = `intake/attachments/${rel}${e.name}`;
      if (e.isSymbolicLink()) findings.push(notScanned(label, 'a symbolic link is not followed, and an agent that reads it would read its target'));
      else if (e.isDirectory()) {
        if (SKIPPED_DIRS.has(e.name)) findings.push(notScanned(label, 'this folder is skipped by the scan'));
        else if (depth >= caps.maxDepth) findings.push(notScanned(label, `the folder is deeper than ${caps.maxDepth} levels`));
        else walk(path, `${rel}${e.name}/`, depth + 1);
      } else if (e.isFile()) {
        if (++files > caps.maxFiles) {
          findings.push(notScanned('intake/attachments', `more than ${caps.maxFiles} files, the scan stopped`));
          stopped = true;
          return;
        }
        scanFile(path, label);
      } else findings.push(notScanned(label, 'not a regular file'));
    }
  };
  walk(base, '', 0);
  return { findings, blocking: findings.some((f) => f.severity === 'error') };
}

/** One finding as one line: `file:line:column rule U+XXXX message`, or `file rule message` for a file-level finding. */
export function formatFinding(f) {
  return `${f.file}${f.line === undefined ? '' : `:${f.line}:${f.column}`} ${f.rule}${f.codePoint === undefined ? '' : ` ${f.codePoint}`} ${f.message}`;
}
