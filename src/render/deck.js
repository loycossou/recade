import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { parseLots, parseStories } from '../project/backlog.js';
import { listProvisionals } from '../project/provisionals.js';
import { gatesOf, phasesOf } from '../project/state.js';
import { loadState } from '../state.js';
import { splitFrontMatter } from './frontmatter.js';
import { parseInlineText, plainText } from './inline.js';
import { insideProject, pngSize } from './figures.js';
import { loadStory, headingParts, storyText } from './story.js';

/**
 * The deck for a steering committee: one PowerPoint file that sums up the project, built from the sources that
 * exist. Nothing here asks a question: `deliverables.deck` of the user config says whether it is wanted, and the
 * commands ask the owner before it is ever `yes`. A missing source drops its slide with a warning, never a failure.
 *
 * The look comes from the project: the colours of its logo when there is one, then the tokens of the art direction
 * (`design/tokens.json`), then the render theme (`design/theme.json` over the bundled default). The deck uses them
 * for full-bleed title and divider slides, cards, a timeline of the lots and big numbers.
 */

export { DECK_CHOICES } from '../deliverables.js';

const MAX_BULLETS = 6;
const MAX_CHARS = 150;
const FONT = 'Inter Tight';
const W = 13.333;
const H = 7.5;

/** True when `path` is a regular file inside the project. */
const isFile = (path, root) => {
  try {
    return lstatSync(path).isFile() && insideProject(path, root);
  } catch {
    return false;
  }
};

/** Inline Markdown as plain text, on one line. */
const plain = (text) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  try {
    return plainText(parseInlineText(flat)).replace(/\s+/g, ' ').trim();
  } catch {
    return flat;
  }
};

/**
 * A text cut to `max` characters at a word boundary, with an ellipsis when something was cut.
 * @param {string} text
 * @param {number} [max]
 */
export function clip(text, max = MAX_CHARS) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** The body of a Markdown file without its front matter, or null when the file is missing or unreadable. */
function readBody(root, rel) {
  const file = join(root, rel);
  if (!isFile(file, root)) return null;
  try {
    return splitFrontMatter(readFileSync(file, 'utf8'), rel).body;
  } catch {
    return null;
  }
}

/** The headings of `level` with their lines, fenced code and comments skipped: `{title, lines}`. */
function sectionsOf(body, level) {
  const heading = new RegExp(`^${'#'.repeat(level)} (.*)$`);
  const out = [];
  let fence = false;
  let comment = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
    if (line.includes('<!--') && !line.includes('-->')) {
      comment = true;
      continue;
    }
    const m = heading.exec(line);
    if (m) out.push({ title: m[1].trim(), lines: [] });
    else if (out.length > 0) out.at(-1).lines.push(line);
  }
  return out;
}

/** The first paragraph of plain prose in `lines`: no heading, table, list, quote, figure or comment. */
function firstParagraph(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    const prose = line !== '' && !/^(#|\||>|<!--|!\[|[-*+] |\d+[.)] )/.test(line);
    if (prose) out.push(line);
    else if (out.length > 0) break;
  }
  return plain(out.join(' '));
}

/**
 * The first paragraph of the sections whose title matches `wanted`, else of any section that is not about reading the
 * document itself (its purpose, its conventions), else of any section at all.
 */
function proseOf(sections, wanted) {
  return proseSection(sections, wanted)?.text ?? '';
}

/** As `proseOf`, with the section the paragraph comes from: `{text, section}`, or null. */
function proseSection(sections, wanted) {
  const about = /purpose|objet|reading|lecture|convention|standard/i;
  const pick = (test) => {
    for (const section of sections.filter((s) => test(headingParts(s.title).title))) {
      const text = firstParagraph(section.lines);
      if (text !== '') return { text, section };
    }
    return null;
  };
  return pick((t) => wanted.test(t) && !about.test(t)) ?? pick((t) => !about.test(t)) ?? pick(() => true);
}

/** The rows of the first table of a section as short lines: `ID: text` when the first column is an ID. */
function tableLines(lines, sep = ': ') {
  const { header, rows } = firstTable(lines);
  return rows.map((r) => {
    const [a, b] = [plain(r[0]), plain(r[1] ?? '')];
    if (a === '') return '';
    return b === '' ? a : `${a}${sep}${b}`;
  }).filter((t) => t !== '' && header.length > 0);
}

/** The cells of a Markdown table row, `\|` read as a pipe. */
function rowCells(row) {
  const inner = row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll('\\|', '|'));
}

/** The first table of `lines`: its header (plain, lower case) and its rows. */
function firstTable(lines) {
  const at = lines.findIndex((l) => l.trim().startsWith('|'));
  if (at < 0) return { header: [], rows: [] };
  let end = at;
  while (end < lines.length && lines[end].trim().startsWith('|')) end++;
  const table = lines.slice(at, end).map(rowCells);
  return { header: table[0].map((h) => plain(h).toLowerCase()), rows: table.slice(2) };
}

/** The companion of a document as plain texts, or null when it has none. */
function storyOf(root, rel) {
  const file = join(root, rel);
  if (!isFile(file, root)) return null;
  const { story } = loadStory(file, rel.replace(/\.md$/, '.story.yaml'));
  if (!story) return null;
  return {
    kicker: story.kicker ? storyText(story.kicker) : '',
    lede: story.lede ? storyText(story.lede) : '',
    facts: story.facts.map((f) => ({ value: storyText(f.value), label: storyText(f.label) })),
    recap: story.recap.map((r) => storyText(r)),
    images: story.sections.filter((s) => s.image).map((s) => storyText(s.image)),
    stats: story.sections.flatMap((s) => s.stats.map((t) => ({ value: storyText(t.value), label: storyText(t.label) }))),
  };
}

/** At most `max` items, clipped, the last one saying how many were left out. */
function limited(items, labels, max = MAX_BULLETS, chars = MAX_CHARS) {
  const list = items.map((i) => clip(i, chars)).filter((i) => i !== '');
  if (list.length <= max) return list;
  return [...list.slice(0, max - 1), labels.more.replace('{n}', String(list.length - max + 1))];
}

/** The summary of D2 or D3 from its companion (recap, facts, first image), else from its first paragraph. */
function summaryOf(root, id, labels) {
  const rel = `docs/${id}.md`;
  const body = readBody(root, rel);
  if (body === null) return null;
  const story = storyOf(root, rel);
  if (story && (story.recap.length > 0 || story.facts.length > 0)) {
    return { lede: story.lede, bullets: limited(story.recap, labels), facts: story.facts.slice(0, 3), picture: story.images[0] ?? '' };
  }
  const found = proseSection([...sectionsOf(body, 2), ...sectionsOf(body, 3)], /context|principle|principe|decision|décision|essential|essentiel/i);
  if (found === null) return null;
  const rows = tableLines(found.section.lines, labels.sep);
  return rows.length > 0
    ? { lede: clip(found.text, 200), bullets: limited(rows, labels, 5, 140), facts: [], picture: story?.images[0] ?? '' }
    : { lede: story?.lede ?? '', bullets: [clip(found.text, 320)], facts: [], picture: story?.images[0] ?? '' };
}

/** The body of a Markdown text without its front matter, or the text itself when it has none that parses. */
function bodyOf(text, rel) {
  try {
    return splitFrontMatter(text, rel).body;
  } catch {
    return text;
  }
}

/**
 * The board of the art direction the owner chose: the `source` of the tokens (`design/directions/<name>.html`), else
 * the first bold name of the "chosen direction" section of `design/directions/README.md`. Null when there is none.
 * @returns {{file:string, rel:string, name:string}|null}
 */
export function chosenBoard(root) {
  const board = (name) => {
    const stem = String(name ?? '').trim().replace(/^design\/directions\//, '').replace(/\.html$/i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem)) return null;
    const rel = `design/directions/${stem}.html`;
    return isFile(join(root, rel), root) ? { file: join(root, rel), rel, name: stem } : null;
  };
  try {
    const tokens = JSON.parse(readFileSync(join(root, 'design', 'tokens.json'), 'utf8'));
    const found = board(tokens?.$meta?.source) ?? board(tokens?.$meta?.direction);
    if (found) return found;
  } catch {
    // No tokens, or not JSON: try the README.
  }
  const readme = join(root, 'design', 'directions', 'README.md');
  if (!isFile(readme, root)) return null;
  let body;
  try {
    body = readFileSync(readme, 'utf8');
  } catch {
    return null;
  }
  const section = sectionsOf(body, 2).find((s) => /chosen|choisie|picked|retenue/i.test(s.title));
  const bold = /\*\*([^*]+)\*\*/.exec((section?.lines ?? []).join('\n'))?.[1];
  return bold ? board(bold) : null;
}

/**
 * The name of the project as a reader writes it: the part of a document title before its first comma, when it is the
 * `project` of the front matter written with its accents and capitals (`Potager partagé` for `potager-partage`), else
 * that `project`, else `fallback`.
 */
export function displayName(root, fallback) {
  const squash = (t) => String(t ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const rel of ['docs/D1.md', 'docs/D2.md', 'docs/PLAN.md', 'BIBLE.md', 'docs/STACK.md']) {
    const file = join(root, rel);
    if (!isFile(file, root)) continue;
    try {
      const { meta } = splitFrontMatter(readFileSync(file, 'utf8'), rel);
      const project = String(meta.project ?? '').trim();
      const head = String(meta.title ?? '').split(', ')[0].trim();
      if (head !== '' && head !== String(meta.title ?? '').trim() && (project === '' || squash(head) === squash(project))) return head;
      if (project !== '') return project;
    } catch {
      // The next one.
    }
  }
  return fallback;
}

/**
 * Everything the deck says, read from the project, with one warning for each slide left out. No PowerPoint here, so
 * it is cheap to test. The slides come in three parts (the project, the technical side, the delivery), each opened
 * by a divider when it has a slide.
 * @param {string} root project folder
 * @param {{project:string, date:string, labels:any, decisions:{entries:any[]}|null}} meta `labels` is the `deck`
 *   block of the labels of the document language
 * @returns {{slides: object[], warnings: string[]}}
 */
export function deckContent(root, { project, date, labels, decisions }) {
  const L = labels;
  const warnings = [];
  const drop = (what, slide) => warnings.push(`deck: no ${what}, the slide "${slide}" is left out.`);
  const parts = { project: [], tech: [], delivery: [] };

  // The project: context and goal, key figures, scope.
  const d1Story = storyOf(root, 'docs/D1.md');
  const d1 = readBody(root, 'docs/D1.md');
  if (d1 === null) {
    drop('docs/D1.md', L.context);
  } else if (d1Story && (d1Story.recap.length > 0 || d1Story.facts.length > 0)) {
    parts.project.push({
      kind: 'context', title: L.context, lede: d1Story.lede, bullets: limited(d1Story.recap, L, 5), facts: d1Story.facts.slice(0, 4), objectives: [], picture: d1Story.images[0] ?? '',
    });
  } else {
    const all = [...sectionsOf(d1, 1), ...sectionsOf(d1, 2), ...sectionsOf(d1, 3)];
    const text = proseOf(all, /context|introduction|vision|problem|probl/i);
    // The objectives and their targets, from the first table of a section on objectives.
    const goals = all.find((s) => /objecti/i.test(headingParts(s.title).title) && firstTable(s.lines).rows.length > 0);
    const { header, rows } = firstTable(goals?.lines ?? []);
    const targetCol = header.findIndex((h) => /target|cible/.test(h));
    const objectives = rows.map((r) => ({ goal: clip(plain(r[0]), 90), target: targetCol < 0 ? '' : clip(plain(r[targetCol]), 70) })).filter((o) => o.goal !== '').slice(0, 4);
    if (text === '' && objectives.length === 0) drop('context paragraph in docs/D1.md', L.context);
    else parts.project.push({ kind: 'context', title: L.context, lede: clip(text, 260), bullets: [], facts: [], objectives, picture: d1Story?.images[0] ?? '' });
  }
  const stats = ['D1', 'D2', 'D3'].flatMap((id) => (id === 'D1' ? d1Story : storyOf(root, `docs/${id}.md`))?.stats ?? []);
  if (stats.length > 0) parts.project.push({ kind: 'stats', title: L.keyFigures, stats: stats.slice(0, 4) });
  if (d1 !== null) {
    const h2 = sectionsOf(d1, 2);
    const catalogue = h2.find((s) => /module/i.test(headingParts(s.title).title));
    const { header, rows } = firstTable(catalogue?.lines ?? []);
    const nameCol = header.findIndex((h) => /^(module|area|domaine|domain)/.test(h));
    const whatCol = header.findIndex((h) => /for|purpose|what|role|rôle|but|sert/.test(h));
    let items = nameCol < 0 ? [] : rows.map((r) => ({ name: plain(r[nameCol]), text: whatCol < 0 ? '' : plain(r[whatCol]) })).filter((i) => i.name !== '');
    if (items.length === 0) {
      const seen = new Set();
      items = h2.map((s) => plain(headingParts(s.title).title))
        .filter((t) => t !== '' && !/^(annex|annexe|appendix)\b/i.test(t) && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
        .map((name) => ({ name, text: '' }));
    }
    if (items.length === 0) drop('main section in docs/D1.md', L.scope);
    else {
      const shown = items.slice(0, 6).map((i) => ({ name: clip(i.name, 40), text: clip(i.text, 110) }));
      if (items.length > 6) shown[5] = { name: L.more.replace('{n}', String(items.length - 5)), text: '' };
      parts.project.push({ kind: 'cards', title: L.scope, items: shown });
    }
  } else {
    drop('docs/D1.md', L.scope);
  }
  // The look and feel: a picture of the art direction the owner chose, when there is one.
  const board = chosenBoard(root);
  if (board) parts.project.push({ kind: 'picture', image: 'board', title: L.look, caption: L.lookCaption.replace('{name}', board.name) });

  // The technical side: architecture (with the first figure of D2 when it is drawn) and security.
  const d2 = summaryOf(root, 'D2', L);
  if (d2 === null) drop('docs/D2.md', L.architecture);
  else parts.tech.push({ kind: 'figure', title: L.architecture, image: 'architecture', ...d2 });
  const d3 = summaryOf(root, 'D3', L);
  if (d3 === null) drop('docs/D3.md', L.security);
  else parts.tech.push({ kind: 'steps', title: L.security, ...d3 });

  // The delivery: the lots of the PLAN, the decisions, the open points, the next steps.
  const planFile = join(root, 'docs', 'PLAN.md');
  let planText = null;
  if (isFile(planFile, root)) {
    try {
      planText = readFileSync(planFile, 'utf8');
    } catch {
      planText = null;
    }
  }
  let lots = new Map();
  try {
    lots = planText === null ? new Map() : parseLots(planText);
  } catch {
    lots = new Map();
  }
  let stories = [];
  try {
    stories = planText === null ? [] : parseStories(planText);
  } catch {
    stories = [];
  }
  // A PLAN written before the Lots table: the lots of its backlog, in the order they first come, with their item count.
  if (lots.size === 0) {
    for (const s of stories) {
      const code = s.lotName || s.lot;
      if (!code) continue;
      const lot = lots.get(code) ?? { name: '', goal: '', count: 0 };
      lot.count += 1;
      lot.goal = L.items.replace('{n}', String(lot.count));
      lots.set(code, lot);
    }
  }
  if (lots.size === 0) {
    drop(planText === null ? 'docs/PLAN.md' : 'lot in the Lots table of docs/PLAN.md', L.plan);
  } else {
    const points = new Map();
    for (const s of stories) {
      if (typeof s.points !== 'number') continue;
      const code = [...lots.keys()].find((c) => [s.lot, s.lotName].includes(c) || s.id.startsWith(`${c}-`) || (lots.get(c).name !== '' && [s.lot, s.lotName].includes(lots.get(c).name)));
      if (code !== undefined) points.set(code, (points.get(code) ?? 0) + s.points);
    }
    const items = [...lots].map(([code, { name, goal }]) => ({
      code, name: clip(name === '' ? code : name, 36), goal: clip(goal, 120), estimate: points.has(code) ? L.points.replace('{n}', String(points.get(code))) : '',
    }));
    parts.delivery.push({ kind: 'timeline', title: L.plan, header: [L.lot, L.content, L.estimate], lots: items });
  }

  const entries = decisions?.entries ?? [];
  if (entries.length === 0) {
    drop('decisions/DEC-*.md', L.decisions);
  } else {
    const isOpen = (e) => e.chosen === 'none yet' && !/^(closed|decided|superseded)$/i.test(e.status);
    const open = entries.filter(isOpen);
    const items = open.map((e) => ({ id: e.id, text: clip(plain(e.question), 120) }));
    parts.delivery.push({
      kind: 'decisions', title: L.decisions, closed: entries.length - open.length, openCount: open.length, open: items.slice(0, 4),
      more: items.length > 4 ? L.more.replace('{n}', String(items.length - 4)) : '',
    });
  }

  let provisionals = null;
  if (isFile(join(root, 'intake', 'provisionals.md'), root)) {
    try {
      provisionals = listProvisionals(root, { open: true });
    } catch {
      provisionals = null;
    }
  }
  if (provisionals === null) {
    drop('intake/provisionals.md', L.risks);
  } else {
    const items = provisionals.map((p) => {
      const due = String(p.due ?? '').trim();
      return { id: p.id, text: clip(plain(p.what), 90), due: due === '' ? '' : L.due.replace('{date}', due) };
    });
    parts.delivery.push({
      kind: 'risks', title: L.risks, lede: provisionals.length === 0 ? L.noOpenPoint : L.provisionalCount.replace('{n}', String(provisionals.length)),
      items: items.slice(0, 6), more: items.length > 6 ? L.more.replace('{n}', String(items.length - 5)) : '',
    });
    if (items.length > 6) parts.delivery.at(-1).items = items.slice(0, 5);
  }

  let gate = '';
  try {
    const state = loadState(root);
    if (state) {
      const gates = state.gates ?? {};
      const open = gatesOf(state).find((g) => !gates[g]);
      if (open === undefined) gate = L.allGates;
      else {
        const phase = phasesOf(state).find((p) => p.gates.includes(open));
        gate = L.nextGate.replace('{gate}', open).replace('{gist}', L.gates?.[open] ?? phase?.noun ?? '');
      }
    }
  } catch {
    gate = '';
  }
  const milestones = [];
  if (planText !== null) {
    const section = sectionsOf(bodyOf(planText, 'docs/PLAN.md'), 2).find((s) => /milestone|jalon/i.test(headingParts(s.title).title));
    const { header, rows } = firstTable(section?.lines ?? []);
    const dateCol = header.findIndex((h) => /^(date|due|échéance)/.test(h));
    const whatCol = header.findIndex((h) => /what|true|quoi|vrai|description|goal|objectif|milestone|jalon/.test(h));
    const idCol = header.findIndex((h) => h === 'id');
    const statusCol = header.findIndex((h) => /status|statut/.test(h));
    for (const r of rows) {
      const when = plain(r[dateCol] ?? '');
      const status = plain(r[statusCol] ?? '').toLowerCase();
      if (dateCol < 0 || !/^\d{4}-\d{2}-\d{2}/.test(when) || when < date || /^(done|met|passed|fait|atteint)$/.test(status)) continue;
      milestones.push({ date: when, id: idCol < 0 ? '' : plain(r[idCol]), text: clip(whatCol < 0 ? '' : plain(r[whatCol]), 80) });
    }
  }
  if (gate === '' && milestones.length === 0) drop('recade/state.yaml nor milestone ahead in docs/PLAN.md', L.next);
  else parts.delivery.push({ kind: 'next', title: L.next, gate, milestones: milestones.slice(0, 4), milestonesTitle: L.milestones });

  const context = parts.project.find((s) => s.kind === 'context');
  const lede = d1Story?.lede || (context?.lede ?? '');
  const slides = [{ kind: 'title', title: project, kicker: d1Story?.kicker || L.kicker, lede, subtitle: L.subtitle, date }];
  let n = 0;
  for (const [key, title] of [['project', L.partProject], ['tech', L.partTech], ['delivery', L.partDelivery]]) {
    if (parts[key].length === 0) continue;
    n += 1;
    slides.push({ kind: 'divider', part: key, number: String(n).padStart(2, '0'), title, items: parts[key].map((s) => s.title) }, ...parts[key].map((s) => ({ ...s, part: key })));
  }
  return { slides, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Colours

const HEX = /^[0-9A-Fa-f]{6}$/;
const norm = (v) => {
  const s = String(v ?? '').trim().replace(/^#/, '');
  if (/^[0-9A-Fa-f]{3}$/.test(s)) return s.split('').map((c) => c + c).join('').toUpperCase();
  return HEX.test(s) ? s.toUpperCase() : null;
};
const rgb = (hex) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Hue (0 to 360), saturation and lightness (0 to 1) of a colour. */
function hsl(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function fromHsl({ h, s, l }) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The WCAG contrast ratio of two colours. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
/** A light tint of a colour, for the background of a card. */
const tint = (hex, t = 0.85) => mix(hex, 'FFFFFF', t);
/** The colour darkened step by step until white text on it reaches `ratio` (WCAG AA is 4.5). */
function deepen(hex, ratio = 4.5) {
  let c = hex;
  for (let i = 0; i < 20 && contrast(c, 'FFFFFF') < ratio; i++) c = mix(c, '000000', 0.1);
  return c;
}
/** The colour darkened until it reaches `ratio` as text on `ground`. */
function readableOn(hex, ground, ratio = 4.5) {
  let c = hex;
  for (let i = 0; i < 20 && contrast(c, ground) < ratio; i++) c = mix(c, '000000', 0.12);
  return c;
}
/** White or the ink on a fill, whichever reads better. */
const textOn = (fill, ink) => (contrast(fill, 'FFFFFF') >= contrast(fill, ink) ? 'FFFFFF' : ink);

const chromatic = (hex) => {
  const { s, l } = hsl(hex);
  return s >= 0.18 && l >= 0.12 && l <= 0.88;
};
const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));

/** Read a PNG into RGBA pixels: 8-bit, not interlaced, grey, RGB, palette or with alpha. Null for anything else. */
export function decodePng(bytes) {
  const size = pngSize(bytes);
  if (!size || size.width * size.height > 16_000_000) return null;
  const depth = bytes[24];
  const type = bytes[25];
  if (depth !== 8 || bytes[28] !== 0 || ![0, 2, 3, 4, 6].includes(type)) return null;
  const idat = [];
  let palette = null;
  let alpha = null;
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const kind = bytes.toString('latin1', at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IDAT') idat.push(data);
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') alpha = data;
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const { width, height } = size;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = prev[i];
      const corner = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (type === 3) {
        const p = line[s];
        if (!palette || p * 3 + 2 >= palette.length) return null;
        pixels[o] = palette[p * 3]; pixels[o + 1] = palette[p * 3 + 1]; pixels[o + 2] = palette[p * 3 + 2];
        pixels[o + 3] = alpha && p < alpha.length ? alpha[p] : 255;
      } else if (type === 0 || type === 4) {
        pixels[o] = pixels[o + 1] = pixels[o + 2] = line[s];
        pixels[o + 3] = type === 4 ? line[s + 1] : 255;
      } else {
        pixels[o] = line[s]; pixels[o + 1] = line[s + 1]; pixels[o + 2] = line[s + 2];
        pixels[o + 3] = type === 6 ? line[s + 3] : 255;
      }
    }
    prev = line;
  }
  return { width, height, pixels };
}

/** The main colours of an image or an SVG text, most present first: greys, black and white left out. */
export function imageColours(bytes, ext) {
  const counts = new Map();
  if (ext === '.svg') {
    for (const m of bytes.toString('utf8').matchAll(/#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g)) {
      const hex = norm(m[1]);
      if (hex && chromatic(hex)) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  }
  if (ext !== '.png') return [];
  const image = decodePng(bytes);
  if (!image) return [];
  const step = Math.max(1, Math.floor((image.width * image.height) / 40_000));
  const sums = new Map();
  for (let i = 0; i < image.width * image.height; i += step) {
    const o = i * 4;
    if (image.pixels[o + 3] < 128) continue;
    const c = [image.pixels[o], image.pixels[o + 1], image.pixels[o + 2]];
    if (!chromatic(toHex(c))) continue;
    const key = c.map((v) => v >> 5).join(',');
    const sum = sums.get(key) ?? [0, 0, 0, 0];
    sums.set(key, [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2], sum[3] + 1]);
  }
  return [...sums.values()].sort((a, b) => b[3] - a[3]).map(([r, g, b, n]) => toHex([r / n, g / n, b / n]));
}

const LOGO_DIRS = ['design', 'design/logo', 'assets', 'intake/attachments', 'docs/figures', '.'];
const LOGO_EXTS = ['.png', '.svg', '.jpg', '.jpeg'];

/**
 * The logo of the project: the first file whose name holds `logo` in design/, assets/, the intake attachments or the
 * figures, a PNG before an SVG before a JPEG.
 * @returns {{file:string, rel:string, ext:string}|null}
 */
export function findLogo(root) {
  for (const dir of LOGO_DIRS) {
    let names = [];
    try {
      if (!insideProject(join(root, dir), root)) continue;
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    const found = names.filter((n) => /logo/i.test(n) && LOGO_EXTS.includes(extname(n).toLowerCase()) && isFile(join(root, dir, n), root))
      .sort((a, b) => LOGO_EXTS.indexOf(extname(a).toLowerCase()) - LOGO_EXTS.indexOf(extname(b).toLowerCase()) || a.localeCompare(b, 'en'));
    if (found.length > 0) {
      const rel = dir === '.' ? found[0] : `${dir}/${found[0]}`;
      return { file: join(root, rel), rel, ext: extname(found[0]).toLowerCase() };
    }
  }
  return null;
}

/** The colours of the art direction tokens: brand, primary, secondary and accent first, then any other. */
function tokenColours(root) {
  const file = join(root, 'design', 'tokens.json');
  if (!isFile(file, root)) return [];
  let tokens;
  try {
    tokens = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const found = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      const hex = norm(node);
      if (hex) found.push({ hex, path });
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) if (!k.startsWith('$') || k === '$value') walk(v, k === '$value' ? path : `${path}.${k}`);
    }
  };
  walk(tokens.color ?? tokens.colors ?? tokens, '');
  const rank = (p) => (/brand|primary|logo/i.test(p) ? 0 : /secondary|accent|action|interactive|highlight/i.test(p) ? 1 : 2);
  return found.sort((a, b) => rank(a.path) - rank(b.path)).map((f) => f.hex);
}

/**
 * The palette of the deck, from the first source that has colours: the logo, the art direction tokens, the render
 * theme. 4 to 6 colours, the first one the main colour; a source with fewer colours is completed by neighbours of
 * its main hue, so the deck always has at least four.
 * @param {string} root
 * @param {any} theme the render theme
 * @param {string[]} [logoColours]
 * @returns {{colours:string[], source:'logo'|'tokens'|'theme', ink:string, muted:string, rule:string}}
 */
export function deckPalette(root, theme, logoColours = []) {
  const c = theme?.color ?? {};
  const fromTheme = [c.accent, c.chartFill, c.heading, c.headerFill, theme?.figure?.ok?.stroke, theme?.figure?.warm?.stroke].map(norm).filter(Boolean);
  const sources = [['logo', logoColours], ['tokens', tokenColours(root)], ['theme', fromTheme]];
  const picked = [];
  let source = 'theme';
  for (const [name, list] of sources) {
    for (const hex of list) {
      if (picked.length >= 6) break;
      if (chromatic(hex) && picked.every((p) => distance(p, hex) > 48)) {
        if (picked.length === 0) source = name;
        picked.push(hex);
      }
    }
    if (picked.length >= 3) break;
  }
  if (picked.length === 0) picked.push('1F3864');
  const base = hsl(picked[0]);
  for (const shift of [150, 40, -40, 200, 80]) {
    if (picked.length >= 4) break;
    const hex = fromHsl({ h: (base.h + shift + 360) % 360, s: Math.max(0.45, Math.min(0.7, base.s)), l: Math.max(0.35, Math.min(0.55, base.l)) });
    if (picked.every((p) => distance(p, hex) > 48)) picked.push(hex);
  }
  return {
    colours: picked, source,
    ink: norm(c.ink) ?? '0F1A22', muted: norm(c.muted) ?? '5A6672', rule: norm(c.rule) ?? 'D9DFE4',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The PowerPoint file

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A fixed date for every entry of the zip and the document properties: the same sources give the same bytes. */
async function settle(bytes, date, { title, author }) {
  const when = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : '2000-01-01T00:00:00Z';
  const zip = await JSZip.loadAsync(bytes);
  const out = new JSZip();
  const stamp = new Date(when);
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    let data = await entry.async('nodebuffer');
    if (name === 'docProps/core.xml') {
      data = Buffer.from(data.toString('utf8')
        .replace(/<dcterms:(created|modified) ([^>]*)>[^<]*</g, `<dcterms:$1 $2>${when}<`)
        .replace(/<dc:creator>[^<]*</, `<dc:creator>${xml(author)}<`)
        .replace(/<cp:lastModifiedBy>[^<]*</, `<cp:lastModifiedBy>${xml(author)}<`)
        .replace(/<dc:subject>[^<]*</, `<dc:subject>${xml(title)}<`));
    }
    out.file(name, data, { date: stamp, createFolders: false });
  }
  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

/** The data URL of an image for pptxgenjs, and its size in inches inside a `w` by `h` box. */
function picture(image, w, h) {
  if (!image?.bytes || !image.width || !image.height) return null;
  const ratio = image.width / image.height;
  const fit = ratio > w / h ? { w, h: w / ratio } : { w: h * ratio, h };
  return { data: `${image.mime ?? 'image/png'};base64,${image.bytes.toString('base64')}`, ...fit };
}


/**
 * The slides as they are drawn, once the pictures are known: a picture slide whose picture could not be made goes,
 * the architecture becomes its text followed by a full slide for its figure when the figure exists, and each divider
 * lists the slides of its part again (a part left with no slide loses its divider).
 * @param {object[]} slides from `deckContent`
 * @param {Record<string, any>} images
 * @param {any} labels the `deck` labels
 */
export function prepareSlides(slides, images, labels) {
  const has = (key) => picture(images?.[key], 1, 1) !== null;
  const out = [];
  for (const s of slides) {
    if (s.kind === 'picture' && !has(s.image)) continue;
    if (s.kind === 'figure') {
      out.push({ ...s, kind: 'steps' });
      if (has(s.image)) out.push({ kind: 'picture', part: s.part, title: labels.architectureMap, image: s.image, caption: s.lede ?? '' });
      continue;
    }
    out.push(s);
  }
  const kept = out.filter((s, n) => s.kind !== 'divider' || (out[n + 1] && out[n + 1].kind !== 'divider'));
  let number = 0;
  return kept.map((s, n) => {
    if (s.kind !== 'divider') return s;
    number += 1;
    const items = [];
    for (const next of kept.slice(n + 1)) {
      if (next.kind === 'divider') break;
      if (!items.includes(next.title)) items.push(next.title);
    }
    return { ...s, number: String(number).padStart(2, '0'), items };
  });
}

/**
 * The deck as the bytes of a `.pptx`, 16:9, every text in Inter Tight (the theme fonts too; PowerPoint uses its own
 * fallback when the font is missing). Title and dividers are full-bleed in a deep palette colour with vector motifs;
 * each content slide has a coloured title band over a light tint of its colour, and white cards. Every text on a
 * colour is white or the ink, at WCAG AA at least.
 * @param {{slides: object[]}} content from `deckContent`
 * @param {{project:string, date:string, title:string, palette:ReturnType<typeof deckPalette>, labels:any,
 *   language:string, images?:Record<string, any>}} meta an image is `{bytes, width, height, mime}`; the keys are
 *   `logo`, `architecture` and `board`
 * @returns {Promise<Buffer>}
 */
export async function deckBytes(content, { project, date, title, palette, labels, language, images = {} }) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const P = palette.colours;
  const ink = palette.ink;
  const colourAt = (i) => P[((i % P.length) + P.length) % P.length];
  // A light colour (a yellow) turns muddy once darkened for white text: the large fills use the colours that need
  // little darkening, and the light ones stay for stripes, motifs and tints.
  const strong = P.filter((c) => contrast(c, 'FFFFFF') >= 3);
  const fills = strong.length >= 2 ? strong : P;
  const deep = (i, ratio = 4.5) => deepen(fills[((i % fills.length) + fills.length) % fills.length], ratio);
  /** A palette colour as a fill under white text: itself darkened when it is strong, else a strong one. */
  const solid = (c) => deepen(contrast(c, 'FFFFFF') >= 3 ? c : fills[Math.max(0, P.indexOf(c)) % fills.length]);
  const slides = prepareSlides(content.slides, images, labels);

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.subject = title;
  pptx.author = 'Recade';
  pptx.company = '';
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
  const lang = String(language ?? '').toLowerCase().startsWith('fr') ? 'fr-FR' : 'en-US';
  const T = { fontFace: FONT, color: ink, lang, margin: 0 };
  const S = pptx.ShapeType;
  const none = { type: 'none' };
  const total = slides.length;
  const logo = images.logo ?? null;
  const parts = { project: 0, tech: 1, delivery: 2 };

  const shape = (slide, kind, o, colour, transparency = 0) => slide.addShape(kind, { ...o, fill: { color: colour, transparency }, line: none });

  /** The logo on a white pill, top right. */
  const corner = (slide, y = 0.27) => {
    const pic = picture(logo, 1.6, 0.42);
    if (!pic) return;
    shape(slide, S.roundRect, { x: W - 0.55 - pic.w - 0.3, y, w: pic.w + 0.3, h: pic.h + 0.2, rectRadius: 0.1 }, 'FFFFFF');
    slide.addImage({ data: pic.data, x: W - 0.55 - pic.w - 0.15, y: y + 0.1, w: pic.w, h: pic.h });
  };

  /** Vector motifs in the palette, one family for each part, drawn in the right part of a full-bleed slide. */
  const motif = (slide, style, seed) => {
    const c = (n) => colourAt(seed + n);
    if (style === 'tech') {
      const hex = [[9.0, 1.2], [10.55, 0.3], [10.55, 2.1], [12.1, 1.2], [9.0, 3.0], [12.1, 3.0], [10.55, 3.9], [9.0, 4.8], [10.55, 5.7], [12.1, 4.8]];
      hex.forEach(([x, y], n) => shape(slide, S.hexagon, { x, y, w: 1.7, h: 1.5 }, c(n % 3 + 1), n % 2 ? 20 : 45));
      return;
    }
    if (style === 'delivery') {
      for (let n = 0; n < 4; n++) shape(slide, S.chevron, { x: 7.6 + n * 1.35, y: 2.6, w: 1.9, h: 2.3 }, c(n + 1), 15 + n * 12);
      shape(slide, S.ellipse, { x: 10.6, y: -1.4, w: 3.6, h: 3.6 }, c(2), 40);
      shape(slide, S.star4, { x: 9.2, y: 5.4, w: 0.9, h: 0.9 }, 'FFFFFF', 30);
      shape(slide, S.wave, { x: 7.0, y: 6.3, w: 6.6, h: 1.4 }, c(3), 35);
      return;
    }
    // The project and the title: leaves, a ring, sparkles and a field of dots.
    shape(slide, S.donut, { x: 9.3, y: -1.5, w: 5.2, h: 5.2 }, c(1), 30);
    shape(slide, S.ellipse, { x: 10.9, y: 4.4, w: 3.6, h: 3.6 }, c(2), 25);
    [[8.4, 3.2, 0], [9.6, 4.6, 90], [7.6, 5.0, 200], [11.6, 2.6, 300]].forEach(([x, y, rotate], n) => {
      shape(slide, S.teardrop, { x, y, w: 1.25, h: 1.25, rotate }, c(n + 3), 10 + n * 8);
    });
    shape(slide, S.star4, { x: 8.1, y: 1.5, w: 0.7, h: 0.7 }, 'FFFFFF', 25);
    shape(slide, S.star4, { x: 12.3, y: 6.5, w: 0.45, h: 0.45 }, 'FFFFFF', 35);
    for (let r = 0; r < 4; r++) for (let q = 0; q < 7; q++) shape(slide, S.ellipse, { x: 8.2 + q * 0.3, y: 0.5 + r * 0.3, w: 0.08, h: 0.08 }, 'FFFFFF', 55);
  };

  /** The title band and the tinted ground of a content slide. Returns the ground and the area under the band. */
  const frame = (slide, s, i) => {
    const band = deep(i);
    const ground = tint(band, 0.9);
    slide.background = { color: ground };
    shape(slide, S.rect, { x: 0, y: 0, w: W, h: 1.15 }, band);
    shape(slide, S.ellipse, { x: W - 4.6, y: -0.75, w: 1.6, h: 1.6 }, colourAt(i + 1), 45);
    shape(slide, S.teardrop, { x: W - 3.35, y: 0.55, w: 0.7, h: 0.7, rotate: 45 }, colourAt(i + 2), 35);
    slide.addText(clip(s.title, 60), { ...T, x: 0.7, y: 0.15, w: W - 5.2, h: 0.85, fontSize: 30, bold: true, color: 'FFFFFF', valign: 'middle', fit: 'shrink' });
    corner(slide);
    const muted = readableOn(palette.muted, ground);
    const seg = W / P.length;
    P.forEach((p, n) => shape(slide, S.rect, { x: n * seg, y: H - 0.12, w: seg, h: 0.12 }, p));
    slide.addText(`${clip(project, 60)}  ·  ${date}`, { ...T, x: 0.7, y: 6.98, w: 9, h: 0.3, fontSize: 10, color: muted });
    slide.addText(`${i + 1} / ${total}`, { ...T, x: W - 2.2, y: 6.98, w: 1.5, h: 0.3, fontSize: 10, color: muted, align: 'right' });
    return { ground, top: 1.45, bottom: 6.8 };
  };

  /** A white card with a coloured edge. */
  const card = (slide, o, colour, edge = 'top') => {
    shape(slide, S.roundRect, { ...o, rectRadius: 0.1 }, 'FFFFFF');
    if (edge === 'top') shape(slide, S.rect, { x: o.x + 0.1, y: o.y, w: o.w - 0.2, h: 0.09 }, colour);
    else shape(slide, S.rect, { x: o.x, y: o.y + 0.1, w: 0.09, h: o.h - 0.2 }, colour);
  };
  /** A round badge with a number or a sign. */
  const badge = (slide, x, y, d, colour, text) => {
    shape(slide, S.ellipse, { x, y, w: d, h: d }, colour);
    slide.addText(text, { ...T, x, y, w: d, h: d, fontSize: Math.round(d * 28), bold: true, color: textOn(colour, ink), align: 'center', valign: 'middle' });
  };
  /** Tiles of big numbers or short goals, laid out in `cols` columns inside a box. */
  const tiles = (slide, items, box, cols) => {
    const rows = Math.ceil(items.length / cols);
    const gap = 0.25;
    const w = (box.w - (cols - 1) * gap) / cols;
    const h = (box.h - (rows - 1) * gap) / rows;
    items.forEach((t, n) => {
      const colour = colourAt(n + 1);
      const x = box.x + (n % cols) * (w + gap);
      const y = box.y + Math.floor(n / cols) * (h + gap);
      card(slide, { x, y, w, h }, colour);
      if (t.value !== undefined) {
        slide.addText(clip(t.value, 22), { ...T, x: x + 0.3, y: y + 0.25, w: w - 0.6, h: h * 0.5, fontSize: 40, bold: true, color: readableOn(colour, 'FFFFFF'), valign: 'middle', fit: 'shrink' });
        slide.addText(clip(t.label, 60), { ...T, x: x + 0.3, y: y + 0.25 + h * 0.5, w: w - 0.6, h: h * 0.5 - 0.4, fontSize: 15, color: ink, valign: 'top', fit: 'shrink' });
      } else {
        badge(slide, x + 0.3, y + 0.3, 0.55, solid(colour), String(n + 1));
        const runs = [{ text: t.goal, options: { bold: true, fontSize: 22, color: ink, breakLine: Boolean(t.target), paraSpaceAfter: 12 } }];
        if (t.target) runs.push({ text: t.target, options: { fontSize: 18, color: readableOn(colour, 'FFFFFF') } });
        slide.addText(runs, { ...T, x: x + 0.3, y: y + 1.05, w: w - 0.6, h: h - 1.25, valign: 'top', fit: 'shrink' });
      }
    });
  };
  /** A white card holding a bulleted list, the text sized to the card. */
  const bulletCard = (slide, items, box, colour, size = 18) => {
    card(slide, box, colour, 'left');
    const runs = items.map((b, n) => ({ text: b, options: { bullet: { indent: 20 }, paraSpaceAfter: 12, breakLine: n < items.length - 1 } }));
    slide.addText(runs, { ...T, x: box.x + 0.35, y: box.y + 0.3, w: box.w - 0.6, h: box.h - 0.6, fontSize: size, valign: 'top', fit: 'shrink' });
  };
  /** The everyday image of a section, in a tinted box. */
  const image = (slide, text, box, colour) => {
    shape(slide, S.roundRect, { ...box, rectRadius: 0.1 }, solid(colour));
    shape(slide, S.teardrop, { x: box.x + 0.25, y: box.y + (box.h - 0.5) / 2, w: 0.5, h: 0.5, rotate: 45 }, 'FFFFFF', 20);
    slide.addText([{ text: `${labels.image}  `, options: { bold: true } }, { text: clip(text, 170) }], { ...T, x: box.x + 0.95, y: box.y + 0.1, w: box.w - 1.2, h: box.h - 0.2, fontSize: 15, color: 'FFFFFF', valign: 'middle', fit: 'shrink' });
  };

  slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    if (s.kind === 'title') {
      slide.background = { color: deep(0, 7) };
      motif(slide, 'title', 0);
      const pic = picture(logo, 3.2, 0.9);
      if (pic) {
        shape(slide, S.roundRect, { x: 0.8, y: 0.75, w: pic.w + 0.5, h: pic.h + 0.4, rectRadius: 0.12 }, 'FFFFFF');
        slide.addImage({ data: pic.data, x: 1.05, y: 0.95, w: pic.w, h: pic.h });
      }
      slide.addText(clip(s.kicker, 60).toUpperCase(), { ...T, x: 0.8, y: 2.35, w: 7.4, h: 0.4, fontSize: 15, bold: true, color: 'FFFFFF', charSpacing: 2 });
      slide.addText(clip(s.title, 80), { ...T, x: 0.8, y: 2.8, w: 7.6, h: 1.5, fontSize: 54, bold: true, color: 'FFFFFF', valign: 'top', fit: 'shrink' });
      if (s.lede) slide.addText(clip(s.lede, 220), { ...T, x: 0.8, y: 4.4, w: 7.2, h: 1.2, fontSize: 20, color: 'FFFFFF', valign: 'top', fit: 'shrink' });
      shape(slide, S.rect, { x: 0.8, y: 5.85, w: 1.2, h: 0.08 }, colourAt(1));
      slide.addText(`${s.subtitle}  ·  ${s.date}`, { ...T, x: 0.8, y: 6.0, w: 7, h: 0.4, fontSize: 16, color: 'FFFFFF' });
      return;
    }
    if (s.kind === 'divider') {
      const seed = parts[s.part] ?? Number(s.number) - 1;
      slide.background = { color: deep(seed + 1, 7) };
      motif(slide, s.part === 'tech' ? 'tech' : s.part === 'delivery' ? 'delivery' : 'project', seed + 1);
      slide.addText(s.number, { ...T, x: 0.8, y: 1.2, w: 4, h: 1.7, fontSize: 110, bold: true, color: 'FFFFFF' });
      slide.addText(clip(s.title, 50), { ...T, x: 0.8, y: 3.0, w: 6.8, h: 1, fontSize: 44, bold: true, color: 'FFFFFF' });
      const runs = s.items.map((t, n) => ({ text: clip(t, 50), options: { bullet: { indent: 18 }, breakLine: n < s.items.length - 1 } }));
      slide.addText(runs, { ...T, x: 0.8, y: 4.2, w: 6.6, h: 2.4, fontSize: 20, color: 'FFFFFF', valign: 'top', paraSpaceAfter: 8 });
      corner(slide, 0.35);
      return;
    }
    const { top, bottom } = frame(slide, s, i);
    const W0 = 0.7;
    const WW = W - 1.4;
    if (s.kind === 'context') {
      let y = top;
      const hero = s.lede || s.bullets[0] || '';
      if (hero) {
        const fill = deep(i + 1);
        shape(slide, S.roundRect, { x: W0, y, w: WW, h: 1.75, rectRadius: 0.12 }, fill);
        shape(slide, S.donut, { x: W - 2.6, y: y + 0.2, w: 1.35, h: 1.35 }, 'FFFFFF', 70);
        slide.addText(clip(hero, 240), { ...T, x: W0 + 0.4, y: y + 0.15, w: WW - 2.9, h: 1.45, fontSize: 24, bold: true, color: 'FFFFFF', valign: 'middle', fit: 'shrink' });
        y += 2.0;
      }
      const recap = s.lede ? s.bullets : s.bullets.slice(1);
      const items = [...(s.facts ?? []), ...(s.objectives ?? [])].slice(0, 4);
      if (s.picture && items.length + recap.length > 0) {
        image(slide, s.picture, { x: W0, y: bottom - 0.9, w: WW, h: 0.9 }, colourAt(i + 2));
      }
      const end = s.picture && items.length + recap.length > 0 ? bottom - 1.1 : bottom;
      const box = { x: W0, y, w: WW, h: end - y };
      if (recap.length > 0 && items.length > 0) {
        bulletCard(slide, recap, { ...box, w: 6.0 }, colourAt(i + 1), 17);
        tiles(slide, items, { x: W0 + 6.3, y, w: WW - 6.3, h: box.h }, items.length > 1 ? 2 : 1);
      } else if (items.length > 0) {
        tiles(slide, items, box, items.length);
      } else if (recap.length > 0) {
        bulletCard(slide, recap, box, colourAt(i + 1), 20);
      } else if (s.picture) {
        image(slide, s.picture, { x: W0, y, w: WW, h: Math.min(1.6, box.h) }, colourAt(i + 2));
      }
    } else if (s.kind === 'stats') {
      tiles(slide, s.stats, { x: W0, y: top + 0.4, w: WW, h: bottom - top - 0.8 }, s.stats.length);
    } else if (s.kind === 'cards') {
      const cols = s.items.length <= 2 ? s.items.length : s.items.length <= 4 ? 2 : 3;
      const rows = Math.ceil(s.items.length / cols);
      const gap = 0.3;
      const w = (WW - (cols - 1) * gap) / cols;
      const h = (bottom - top - (rows - 1) * gap) / rows;
      s.items.forEach((item, k) => {
        const colour = colourAt(i + k);
        const x = W0 + (k % cols) * (w + gap);
        const y = top + Math.floor(k / cols) * (h + gap);
        card(slide, { x, y, w, h }, colour);
        shape(slide, S.teardrop, { x: x + w - 0.75, y: y + 0.3, w: 0.45, h: 0.45, rotate: 45 }, colour, 30);
        badge(slide, x + 0.3, y + 0.35, 0.65, solid(colour), String(k + 1));
        slide.addText(item.name, { ...T, x: x + 1.15, y: y + 0.3, w: w - 2.0, h: 0.75, fontSize: 24, bold: true, color: ink, valign: 'middle', fit: 'shrink' });
        if (item.text) slide.addText(item.text, { ...T, x: x + 0.3, y: y + 1.25, w: w - 0.6, h: h - 1.45, fontSize: 20, color: ink, valign: 'top', fit: 'shrink' });
      });
    } else if (s.kind === 'steps') {
      const facts = s.facts ?? [];
      const right = facts.length > 0 ? 4.2 : 0;
      let y = top;
      if (s.lede) {
        const fill = deep(i + 1);
        shape(slide, S.roundRect, { x: W0, y, w: WW, h: 1.05, rectRadius: 0.1 }, fill);
        slide.addText(clip(s.lede, 200), { ...T, x: W0 + 0.35, y, w: WW - 0.7, h: 1.05, fontSize: 21, bold: true, color: 'FFFFFF', valign: 'middle', fit: 'shrink' });
        y += 1.3;
      }
      if (s.picture) {
        image(slide, s.picture, { x: W0, y, w: WW - right, h: 0.85 }, colourAt(i + 2));
        y += 1.05;
      }
      const items = s.bullets.slice(0, 5);
      const gap = 0.18;
      const h = Math.min(1.35, (bottom - y - (items.length - 1) * gap) / Math.max(1, items.length));
      const w = WW - right;
      items.forEach((b, k) => {
        const colour = colourAt(i + k + 1);
        const by = y + k * (h + gap);
        card(slide, { x: W0, y: by, w, h }, colour, 'left');
        badge(slide, W0 + 0.3, by + (h - 0.55) / 2, 0.55, solid(colour), String(k + 1));
        slide.addText(b, { ...T, x: W0 + 1.1, y: by + 0.06, w: w - 1.35, h: h - 0.12, fontSize: 17, color: ink, valign: 'middle', fit: 'shrink' });
      });
      if (facts.length > 0) tiles(slide, facts.slice(0, 3), { x: W0 + w + 0.3, y, w: right - 0.3, h: bottom - y }, 1);
    } else if (s.kind === 'picture') {
      const caption = s.caption ? 0.55 : 0;
      const box = { x: W0, y: top - 0.1, w: WW, h: bottom - top + 0.1 - caption };
      shape(slide, S.roundRect, { ...box, rectRadius: 0.1 }, 'FFFFFF');
      const pic = picture(images[s.image], box.w - 0.4, box.h - 0.4);
      slide.addImage({ data: pic.data, x: box.x + (box.w - pic.w) / 2, y: box.y + (box.h - pic.h) / 2, w: pic.w, h: pic.h });
      if (caption) slide.addText(clip(s.caption, 160), { ...T, x: W0, y: bottom - 0.45, w: WW, h: 0.45, fontSize: 15, bold: true, color: readableOn(colourAt(i), tint(colourAt(i), 0.9)), valign: 'middle' });
    } else if (s.kind === 'timeline') {
      if (s.lots.length <= 10) {
        const n = s.lots.length;
        const rows = n <= 5 ? 1 : 2;
        const perRow = Math.ceil(n / rows);
        const rowH = (bottom - top - (rows - 1) * 0.25) / rows;
        const w = WW / perRow;
        s.lots.forEach((lot, k) => {
          const colour = colourAt(i + k);
          const fill = solid(colour);
          const col = k % perRow;
          const x = W0 + col * w;
          const y = top + Math.floor(k / perRow) * (rowH + 0.25);
          card(slide, { x: x + 0.05, y: y + 0.5, w: w - 0.2, h: rowH - 0.5 }, colour, 'none');
          slide.addShape(col === 0 ? S.homePlate : S.chevron, { x, y, w: w + 0.15, h: 0.9, fill: { color: fill }, line: { color: tint(colour, 0.9), width: 2 } });
          slide.addText(lot.name === lot.code ? lot.code : lot.name, { ...T, x: x + (col === 0 ? 0.25 : 0.5), y, w: w - 0.75, h: 0.9, fontSize: perRow > 4 ? 15 : 18, bold: true, color: 'FFFFFF', valign: 'middle', fit: 'shrink' });
          const line = [];
          if (lot.name !== lot.code) line.push({ text: `${lot.code}  `, options: { fontSize: 12, bold: true, color: fill } });
          if (lot.estimate) line.push({ text: lot.estimate, options: { fontSize: 28, bold: true, color: fill } });
          if (line.length > 0) slide.addText(line, { ...T, x: x + 0.3, y: y + 1.05, w: w - 0.6, h: 0.65, valign: 'middle' });
          slide.addText(lot.goal, { ...T, x: x + 0.3, y: y + 1.75, w: w - 0.6, h: rowH - 1.9, fontSize: 14, color: ink, valign: 'top', fit: 'shrink' });
        });
      } else {
        const head = s.header.map((h) => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: deep(i, 7) } } }));
        const shown = s.lots.slice(0, 11);
        const rows = shown.map((l, n) => [`${l.name} (${l.code})`, l.goal, l.estimate].map((text) => ({ text, options: { fill: { color: n % 2 ? tint(colourAt(i + 1), 0.85) : 'FFFFFF' } } })));
        if (s.lots.length > shown.length) rows.push([{ text: labels.more.replace('{n}', String(s.lots.length - shown.length)) }, { text: '' }, { text: '' }]);
        slide.addTable([head, ...rows], { x: W0, y: top, w: WW, colW: [3.4, 6.73, 1.8], fontFace: FONT, fontSize: 13, color: ink, valign: 'middle', border: { type: 'solid', pt: 0.75, color: palette.rule }, margin: 0.07, autoPage: false });
      }
    } else if (s.kind === 'decisions') {
      const openColour = colourAt(i + 1);
      const tileH = (bottom - top - 0.3) / 2;
      [[s.closed, labels.closedLabel, deep(i + 1)], [s.openCount, labels.openLabel, deep(i + 2)]].forEach(([value, label, fill], k) => {
        const y = top + k * (tileH + 0.3);
        shape(slide, S.roundRect, { x: W0, y, w: 3.8, h: tileH, rectRadius: 0.12 }, fill);
        shape(slide, S.donut, { x: W0 + 2.3, y: y + 0.25, w: 1.2, h: 1.2 }, 'FFFFFF', 70);
        slide.addText(String(value), { ...T, x: W0 + 0.35, y: y + 0.15, w: 3.1, h: tileH * 0.62, fontSize: 72, bold: true, color: 'FFFFFF', valign: 'middle' });
        slide.addText(label, { ...T, x: W0 + 0.35, y: y + tileH * 0.65, w: 3.1, h: tileH * 0.3, fontSize: 20, color: 'FFFFFF', valign: 'middle' });
      });
      const x = W0 + 4.15;
      const w = WW - 4.15;
      if (s.open.length === 0) {
        card(slide, { x, y: top, w, h: bottom - top }, colourAt(i), 'top');
        badge(slide, x + w / 2 - 0.9, top + 0.9, 1.8, deep(i), '✓');
        slide.addText(labels.noOpenDecision, { ...T, x: x + 0.4, y: top + 3.0, w: w - 0.8, h: 1.2, fontSize: 26, bold: true, color: ink, align: 'center', valign: 'middle' });
      } else {
        const gap = 0.2;
        const n = s.open.length + (s.more ? 1 : 0);
        const h = Math.min(1.4, (bottom - top - (n - 1) * gap) / n);
        s.open.forEach((d, k) => {
          const y = top + k * (h + gap);
          card(slide, { x, y, w, h }, openColour, 'left');
          slide.addText([{ text: `${d.id}  `, options: { bold: true, color: readableOn(openColour, 'FFFFFF') } }, { text: d.text }], { ...T, x: x + 0.35, y: y + 0.08, w: w - 0.6, h: h - 0.16, fontSize: 17, valign: 'middle', fit: 'shrink' });
        });
        if (s.more) slide.addText(s.more, { ...T, x, y: top + s.open.length * (h + gap), w, h: 0.5, fontSize: 15, color: ink });
      }
    } else if (s.kind === 'risks') {
      const lede = deep(i + 1);
      shape(slide, S.roundRect, { x: W0, y: top, w: WW, h: 0.85, rectRadius: 0.1 }, lede);
      badge(slide, W0 + 0.2, top + 0.15, 0.55, 'FFFFFF', '!');
      slide.addText(s.lede, { ...T, x: W0 + 1.0, y: top, w: WW - 1.2, h: 0.85, fontSize: 21, bold: true, color: 'FFFFFF', valign: 'middle' });
      const items = s.items.length > 0 ? s.items : [];
      const y0 = top + 1.1;
      const rows = Math.max(1, Math.ceil(items.length / 2));
      const gap = 0.22;
      const h = Math.min(1.6, (bottom - y0 - (s.more ? 0.4 : 0) - (rows - 1) * gap) / rows);
      const w = (WW - 0.3) / 2;
      items.forEach((r, k) => {
        const colour = colourAt(i + 1 + (k % 2));
        const x = W0 + (k % 2) * (w + 0.3);
        const y = y0 + Math.floor(k / 2) * (h + gap);
        card(slide, { x, y, w, h }, colour, 'left');
        shape(slide, S.triangle, { x: x + 0.3, y: y + (h - 0.55) / 2, w: 0.62, h: 0.55 }, solid(colour));
        slide.addText('!', { ...T, x: x + 0.3, y: y + (h - 0.55) / 2 + 0.12, w: 0.62, h: 0.42, fontSize: 15, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' });
        slide.addText([{ text: `${r.id}  `, options: { bold: true, color: readableOn(colour, 'FFFFFF') } }, { text: r.text, options: { breakLine: Boolean(r.due) } }, ...(r.due ? [{ text: r.due, options: { color: readableOn(palette.muted, 'FFFFFF'), fontSize: 13 } }] : [])],
          { ...T, x: x + 1.15, y: y + 0.08, w: w - 1.35, h: h - 0.16, fontSize: 17, valign: 'middle', fit: 'shrink' });
      });
      if (s.more) slide.addText(s.more, { ...T, x: W0, y: bottom - 0.35, w: 6, h: 0.35, fontSize: 14, color: ink });
    } else if (s.kind === 'next') {
      let y = top;
      if (s.gate) {
        const fill = deep(i + 1, 7);
        shape(slide, S.roundRect, { x: W0, y, w: WW, h: 1.3, rectRadius: 0.12 }, fill);
        shape(slide, S.rightArrow, { x: W0 + 0.35, y: y + 0.3, w: 1.0, h: 0.7 }, 'FFFFFF');
        slide.addText(clip(s.gate, 120), { ...T, x: W0 + 1.65, y, w: WW - 2, h: 1.3, fontSize: 26, bold: true, color: 'FFFFFF', valign: 'middle', fit: 'shrink' });
        y += 1.6;
      }
      const m = s.milestones;
      if (m.length > 0) {
        card(slide, { x: W0, y, w: WW, h: bottom - y }, colourAt(i), 'top');
        slide.addText(s.milestonesTitle, { ...T, x: W0 + 0.4, y: y + 0.25, w: 6, h: 0.45, fontSize: 18, bold: true, color: ink });
        const lineY = y + 1.75;
        shape(slide, S.rect, { x: W0 + 0.5, y: lineY - 0.04, w: WW - 1, h: 0.08 }, tint(colourAt(i), 0.6));
        const step = (WW - 1) / m.length;
        m.forEach((ms, k) => {
          const cx = W0 + 0.5 + step * k + step / 2;
          const colour = solid(colourAt(i + k));
          shape(slide, S.ellipse, { x: cx - 0.3, y: lineY - 0.3, w: 0.6, h: 0.6 }, colour);
          shape(slide, S.ellipse, { x: cx - 0.12, y: lineY - 0.12, w: 0.24, h: 0.24 }, 'FFFFFF');
          slide.addText(ms.date, { ...T, x: cx - step / 2 + 0.1, y: lineY - 0.95, w: step - 0.2, h: 0.5, fontSize: 18, bold: true, color: colour, align: 'center' });
          slide.addText([...(ms.id ? [{ text: `${ms.id}  `, options: { bold: true, color: colour } }] : []), { text: ms.text }], { ...T, x: cx - step / 2 + 0.15, y: lineY + 0.5, w: step - 0.3, h: bottom - lineY - 0.7, fontSize: 15, color: ink, align: 'center', valign: 'top', fit: 'shrink' });
        });
      }
    }
  });

  const bytes = await pptx.write({ outputType: 'nodebuffer' });
  return settle(bytes, date, { title, author: 'Recade' });
}
