import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { FONT_DIR, RENDER_DIR, loadLabels, normalizeLanguage } from './theme.js';
import { deliverableName } from './names.js';
import { bookmarkName, isSafeLink } from './bookmarks.js';
import { captionSeparator, defaultWidths, isIdHeader, keyColumn, planTerm, provisionalText, splitIds } from './look.js';
import { headingParts, matchSections } from './story.js';

/**
 * The HTML dossier of a document: one self-contained page to read on a screen, beside the Word and Excel files. It is
 * built from the parsed document and, when there is one, its companion (`story.js`): a header with a kicker, the title,
 * a lede and fact chips, the recap in N sentences, then each main section with its number, its image (an everyday
 * analogy), the real text, and its stat tiles or before and after rows. Fonts, figures and styles travel inside the
 * file, and a Content-Security-Policy forbids any fetch, so the page opens offline and never calls the network.
 */

/**
 * The file name of the index page in a language: `INDEX_The-Project-Documents.html`, through the same naming helper as
 * the other deliverables, so it sorts first and reads in the language of the documents.
 * @param {Record<string,any>} labels
 */
export const indexFileName = (labels) => `${deliverableName('INDEX', { title: labels.dossier?.indexKicker ?? 'Index' })}.html`;
const isIndexName = (name) => /^INDEX(_.*)?\.html$/.test(name);
const META_NAME = 'recade-dossier';
const ORDER = ['D1', 'D2', 'D3', 'PLAN', 'BIBLE', 'STACK'];
const CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (text) => String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
const unesc = (text) => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
const plain = (runs) => (runs ?? []).map((r) => r.text).join('');
const asRuns = (text) => [{ text: String(text ?? '') }];
const hex = (value, fallback) => (/^[0-9A-Fa-f]{6}$/.test(String(value ?? '')) ? String(value) : fallback);
const cssFamily = (name) => String(name).replace(/[^\w .-]/g, '');

/** Mix two 6-digit colours: `t` 0 gives `a`, 1 gives `b`. */
function mix(a, b, t) {
  const pa = [0, 2, 4].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [0, 2, 4].map((i) => parseInt(b.slice(i, i + 2), 16));
  return pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Relative luminance of a 6-digit colour, from 0 (black) to 1 (white). */
function luminance(c) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The section number as shown: `2` gives `02`, a letter stays. */
const shownNumber = (n) => (n === null ? '' : /^\d$/.test(n) ? `0${n}` : n);

// ---------------------------------------------------------------------------------------------------------------
// Inline and blocks

function inline(runs, ctx) {
  return (runs ?? []).map((run) => {
    let out;
    if (run.provisional) out = esc(provisionalText(run, ctx.labels));
    else if (run.code) out = esc(run.text);
    else out = splitIds(run.text, ctx.lots).map((p) => (p.id ? `<span class="id">${esc(p.text)}</span>` : esc(p.text).replace(/\n/g, '<br>'))).join('');
    if (run.code) out = `<code>${out}</code>`;
    if (run.bold) out = `<strong>${out}</strong>`;
    if (run.italic) out = `<em>${out}</em>`;
    if (run.provisional) out = `<mark class="prv">${out}</mark>`;
    if (run.link && isSafeLink(run.link)) {
      const href = run.link.startsWith('#') ? `#${bookmarkName(run.link.slice(1))}` : run.link;
      out = `<a href="${esc(href)}">${out}</a>`;
    }
    return out;
  }).join('');
}

/** The PLAN's fixed terms (sheet titles, column titles) in the document language. */
function planRuns(ctx, runs) {
  if (ctx.doc.meta.doc_id !== 'PLAN') return runs;
  const text = plain(runs);
  const shown = planTerm(text, ctx.labels);
  return shown === text ? runs : [{ ...(runs[0] ?? {}), text: shown }];
}

function colgroup(count, widths) {
  if (!widths || widths.length !== count) return '';
  const sum = widths.reduce((a, b) => a + b, 0) || count;
  return `<colgroup>${widths.map((w) => `<col style="width:${Math.round((w / sum) * 10000) / 100}%">`).join('')}</colgroup>`;
}

function table(ctx, { header, rows, widths, anchors, className }) {
  const count = header ? header.length : Math.max(1, ...rows.map((r) => r.length));
  const fit = (row) => Array.from({ length: count }, (_, i) => row[i] ?? []);
  const idCol = isIdHeader(header);
  const key = className ? -1 : keyColumn(header, count);
  const klass = (i) => (idCol && i === 0 ? ' class="idcol"' : i === key ? ` class="key${idCol ? ' plain' : ''}"` : '');
  const head = header ? `<thead><tr>${fit(header.map((h) => planRuns(ctx, h))).map((runs) => `<th>${inline(runs, ctx)}</th>`).join('')}</tr></thead>` : '';
  const body = rows.map((row, r) => {
    const name = anchors?.[r] ? bookmarkName(anchors[r]) : null;
    const id = name && claim(ctx, name) ? ` id="${esc(name)}"` : '';
    return `<tr${id}>${fit(row).map((runs, i) => `<td${klass(i)}>${inline(runs, ctx)}</td>`).join('')}</tr>`;
  }).join('');
  const wide = count >= 4 ? ' wide' : '';
  return `<div class="tw${wide}"><table${className ? ` class="${className}"` : ''}>${colgroup(count, widths ?? defaultWidths(header, count, rows))}${head}<tbody>${body}</tbody></table></div>`;
}

function claim(ctx, id) {
  if (ctx.ids.has(id)) return false;
  ctx.ids.add(id);
  return true;
}

function figure(ctx, b) {
  const image = ctx.figures.get(b.id);
  if (!image) return '';
  const width = Math.max(1, Math.round(image.width / 2));
  const height = Math.max(1, Math.round(image.height / 2));
  const label = `<span class="fig-label">${esc(ctx.labels.figure)} ${b.number}</span>${esc(captionSeparator(ctx.labels))}`;
  const src = `data:image/png;base64,${image.png.toString('base64')}`;
  return `<figure><div class="frame"><img src="${src}" width="${width}" height="${height}" alt="${esc(plain(b.caption))}"></div><figcaption>${label}${inline(b.caption, ctx)}</figcaption></figure>`;
}

function callout(ctx, b) {
  const label = { text: ctx.labels[b.kind] ?? b.kind, bold: true };
  const [first, ...rest] = b.blocks;
  const content = first?.type === 'paragraph'
    ? [{ ...first, runs: [label, { text: ' ' }, ...first.runs] }, ...rest]
    : [{ type: 'paragraph', runs: [label] }, ...b.blocks];
  return `<aside class="callout ${esc(b.kind)}">${blocks(ctx, content)}</aside>`;
}

function heading(ctx, b) {
  const level = Math.min(Math.max(b.level, 3), 4);
  const name = bookmarkName(b.anchor);
  const id = claim(ctx, name) ? ` id="${esc(name)}"` : '';
  return `<h${level}${id}>${inline(b.runs, ctx)}</h${level}>`;
}

const BLOCKS = {
  heading,
  paragraph: (ctx, b) => `<p>${inline(b.runs, ctx)}</p>`,
  list: (ctx, b) => {
    const tag = b.ordered ? 'ol' : 'ul';
    return `<${tag}>${b.items.map((item) => `<li>${inline(item.runs, ctx)}${blocks(ctx, item.children)}</li>`).join('')}</${tag}>`;
  },
  table: (ctx, b) => table(ctx, { header: b.header, rows: b.rows, widths: b.widths, anchors: b.rowAnchors }),
  callout,
  code: (ctx, b) => `<pre><code>${esc(b.text.replace(/\t/g, '    '))}</code></pre>`,
  figure,
  pagebreak: () => '',
};

function blocks(ctx, list) {
  return (list ?? []).map((b) => (BLOCKS[b.type] ? BLOCKS[b.type](ctx, b) : '')).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Sections

/** The main headings of a document: the smallest heading level it uses (H1 or H2 in practice). */
function splitSections(doc) {
  const levels = doc.blocks.filter((b) => b.type === 'heading').map((b) => b.level);
  const main = levels.length ? Math.min(...levels) : 0;
  const intro = [];
  const sections = [];
  for (const block of doc.blocks) {
    if (block.type === 'heading' && block.level === main) sections.push({ heading: block, blocks: [] });
    else if (sections.length === 0) intro.push(block);
    else sections.at(-1).blocks.push(block);
  }
  return { intro, sections };
}

function imageBox(ctx, runs) {
  return `<div class="image"><span class="tag">${esc(ctx.dl.image)}</span><p>${inline(runs, ctx)}</p></div>`;
}

function statTiles(ctx, stats) {
  return `<div class="stats">${stats.map((s) => `<div class="stat"><span class="v">${inline(s.value, ctx)}</span><span class="l">${inline(s.label, ctx)}</span></div>`).join('')}</div>`;
}

function beforeAfter(ctx, rows) {
  return table(ctx, {
    header: [asRuns(ctx.dl.before), asRuns(ctx.dl.after)],
    rows: rows.map((r) => [r.before, r.after]),
    className: 'ba',
  });
}

function sectionHtml(ctx, section, extra) {
  const text = plain(planRuns(ctx, section.heading.runs));
  const { number, title } = headingParts(text);
  const name = bookmarkName(section.heading.anchor);
  const id = claim(ctx, name) ? name : `s-${ctx.nav.length + 1}`;
  ctx.nav.push({ id, number, title });
  const head = `<div class="sec-head"><span class="num">${esc(shownNumber(number))}</span><h2>${esc(title)}</h2></div>`;
  let body = section.blocks;
  const parts = [];
  if (extra?.image) {
    parts.push(imageBox(ctx, extra.image), `<span class="tag real">${esc(ctx.dl.real)}</span>`);
  }
  // The summary layer of the section comes after its opening sentence, before the detail.
  const opening = body[0]?.type === 'paragraph' ? [body[0]] : [];
  body = body.slice(opening.length);
  parts.push(blocks(ctx, opening));
  if (extra?.stats?.length) parts.push(statTiles(ctx, extra.stats));
  if (extra?.beforeAfter?.length) parts.push(beforeAfter(ctx, extra.beforeAfter));
  parts.push(blocks(ctx, body));
  return `<section class="sec" id="${esc(id)}">\n${head}\n<div class="body">\n${parts.filter(Boolean).join('\n')}\n</div>\n</section>`;
}

function recapHtml(ctx, story) {
  if (!story?.recap?.length) return '';
  const n = story.recap.length;
  ctx.nav.push({ id: 'recap', number: '0', title: ctx.dl.recap.replace('{n}', String(n)) });
  const items = story.recap.map((runs, i) => `<li><span class="n">${String(i + 1).padStart(2, '0')}</span><span>${inline(runs, ctx)}</span></li>`).join('');
  let out = `<section class="sec" id="recap">\n<div class="sec-head"><span class="num">00</span><h2>${esc(ctx.dl.recap.replace('{n}', String(n)))}</h2></div>\n<p class="sec-sub">${esc(ctx.dl.recapSub)}</p>\n<ol class="recap">${items}</ol>`;
  if (story.decisions?.length) {
    out += `\n<div class="body wide decisions-block"><h3>${esc(ctx.dl.decisions)}</h3>${table(ctx, {
      header: [asRuns(ctx.dl.decision), asRuns(ctx.dl.why)],
      rows: story.decisions.map((d) => [d.decision, d.why]),
      widths: [42, 58],
      className: 'decisions',
    })}</div>`;
  }
  return `${out}\n</section>`;
}

function aboutHtml(ctx) {
  const { meta } = ctx.doc;
  const { labels } = ctx;
  const pair = (label, value) => [asRuns(label), asRuns(value)];
  const rows = [
    pair(labels.document, meta.doc_id),
    pair(labels.project, meta.project),
    pair(labels.version, meta.version),
    pair(labels.date, meta.date),
    pair(labels.status, meta.status),
    ...(meta.author ? [pair(labels.author, meta.author)] : []),
    ...(meta.approver ? [pair(labels.approver, meta.approver)] : []),
    ...(meta.companions?.length ? [pair(labels.companions, meta.companions.join(', '))] : []),
    ...(meta.classification ? [pair(labels.classification, meta.classification)] : []),
  ];
  const parts = [table(ctx, { rows, widths: [30, 70], className: 'meta' })];
  if (meta.revisions?.length) {
    parts.push(`<h3>${esc(labels.revisionHistory)}</h3>`, table(ctx, {
      header: [labels.version, labels.date, labels.author, labels.change].map(asRuns),
      rows: meta.revisions.map((r) => [r.version, r.date, r.author, r.change].map(asRuns)),
      className: 'meta',
    }));
  }
  if (meta.approvals?.length) {
    parts.push(`<h3>${esc(labels.approval)}</h3>`, table(ctx, {
      header: [labels.role, labels.name, labels.date].map(asRuns),
      rows: meta.approvals.map((a) => [a.role, a.name, a.date].map(asRuns)),
      className: 'meta',
    }));
  }
  parts.push(`<p class="source">${esc(labels.sourceOfTruth)}</p>`);
  return `<details class="about"><summary>${esc(ctx.dl.about)}</summary>\n<div class="body">${parts.join('\n')}</div>\n</details>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Page shell

let titleFont;
/**
 * The faces of the bundled Inter Tight, as data: URLs: the whole page uses it, titles and body. Arial takes over where the
 * font cannot load. A theme with another family embeds nothing.
 */
function titleFontCss(theme) {
  if ((theme.font?.family ?? 'Inter Tight') !== 'Inter Tight') return '';
  const face = (file, weight, style) => `@font-face{font-family:"Inter Tight";font-weight:${weight};font-style:${style};src:url(data:font/ttf;base64,${readFileSync(join(FONT_DIR, file)).toString('base64')}) format("truetype");}`;
  titleFont ??= [face('InterTight-Regular.ttf', 400, 'normal'), face('InterTight-Italic.ttf', 400, 'italic'),
    face('InterTight-SemiBold.ttf', 600, 'normal'), face('InterTight-Bold.ttf', 700, 'normal')].join('');
  return titleFont;
}

/** The colours of the page, light and dark, from the theme. */
export function dossierCss(theme) {
  const c = theme.color ?? {};
  const ink = hex(c.ink, '0F1A22');
  const muted = hex(c.muted, '5A6672');
  const rule = hex(c.rule, 'D9DFE4');
  const accent = hex(c.accent, '1F3864');
  const heading = hex(c.heading, accent);
  const tint = hex(c.calloutNote, mix(accent, 'FFFFFF', 0.85));
  const family = theme.font?.family ?? 'Inter Tight';
  const fallback = cssFamily(theme.font?.fallback ?? 'Arial');
  const light = {
    bg: mix(heading, 'FFFFFF', 0.965), paper: 'FFFFFF', ink, muted, rule, accent, heading, link: heading, tint,
    'nav-bg': mix(heading, 'FFFFFF', 0.965), 'chip-bg': mix(heading, 'FFFFFF', 0.9), 'th-bg': mix(heading, 'FFFFFF', 0.93),
    'code-bg': mix(heading, 'FFFFFF', 0.92), 'pre-bg': '161B22', 'pre-ink': 'E6E9EC',
    'note-bg': hex(c.calloutNote, tint), 'warn-bg': hex(c.calloutWarning, 'FBEBD7'), 'warn-bar': 'A66A24',
    'ok-bg': hex(c.calloutDecision, 'DFF1EA'), 'ok-bar': '2E7D5B',
    'prv-bg': hex(c.provisional, 'FBEBD7'), 'prv-ink': hex(c.provisionalText, '8A5A1E'),
    'on-accent': luminance(accent) > 0.45 ? '0F1A22' : 'FFFFFF',
  };
  const darkPaper = '1A2027';
  const darkAccent = luminance(accent) < 0.25 ? mix(accent, 'FFFFFF', 0.5) : accent;
  const darkHeading = luminance(heading) < 0.25 ? mix(heading, 'FFFFFF', 0.55) : heading;
  const dark = {
    bg: '12161B', paper: darkPaper, ink: 'E6E9EC', muted: '9AA5B1', rule: '2C343D', accent: darkAccent, heading: darkHeading,
    link: darkHeading, tint: mix(darkAccent, darkPaper, 0.84), 'nav-bg': '12161B', 'chip-bg': '222A33', 'th-bg': '1F262E',
    'code-bg': '222A33', 'pre-bg': '0D1117', 'pre-ink': 'E6E9EC',
    'note-bg': mix(darkAccent, darkPaper, 0.86), 'warn-bg': mix('E0A060', darkPaper, 0.86), 'warn-bar': 'E0A060',
    'ok-bg': mix('5FBF94', darkPaper, 0.86), 'ok-bar': '5FBF94', 'prv-bg': '4A3A22', 'prv-ink': 'F2CF9B',
    'on-accent': luminance(darkAccent) > 0.45 ? '0F1A22' : 'FFFFFF',
  };
  const vars = (set) => Object.entries(set).map(([k, v]) => `--${k}:#${v}`).join(';');
  // One family for the whole page, Inter Tight by default, then Arial when it is missing (the body reads var(--serif)).
  // IDs, chips, numbers and links use it too, with tabular figures where they line up; monospace is for code only.
  const sans = `"${cssFamily(family)}", ${fallback}, sans-serif`;
  const fonts = `--sans:${sans};--serif:${sans};`
    + '--mono:ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace';
  return `:root{${fonts};${vars(light)};color-scheme:light}\n`
    + `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${vars(dark)};color-scheme:dark}}\n`
    + `:root[data-theme="dark"]{${vars(dark)};color-scheme:dark}`;
}

const TOGGLE_JS = "(function(){var r=document.documentElement,k='recade-theme';try{var s=localStorage.getItem(k);if(s==='light'||s==='dark')r.setAttribute('data-theme',s);}catch(e){}"
  + "document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-toggle-theme]');if(!b)return;"
  + "var t=r.getAttribute('data-theme'),d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;var n=d?'light':'dark';"
  + "r.setAttribute('data-theme',n);try{localStorage.setItem(k,n);}catch(e){}});})();";

function shell(ctx, { title, meta, nav, main }) {
  const css = readFileSync(join(RENDER_DIR, 'dossier.css'), 'utf8');
  return `<!doctype html>
<html lang="${esc(ctx.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
${meta ? `<meta name="${META_NAME}" content="${esc(JSON.stringify(meta))}">\n` : ''}<title>${esc(title)}</title>
<style>
${titleFontCss(ctx.theme)}
${dossierCss(ctx.theme)}
${css}
</style>
<script>${TOGGLE_JS}</script>
</head>
<body>
<nav class="topnav"><div class="in">${nav}<button class="toggle" type="button" data-toggle-theme title="${esc(ctx.dl.theme)}" aria-label="${esc(ctx.dl.theme)}">&#9680;</button></div></nav>
<main class="page">
${main}
</main>
</body>
</html>
`;
}

function chips(ctx, story) {
  const facts = story?.facts?.length
    ? story.facts.map((f) => `<li>${inline(f.label, ctx)} <b>${inline(f.value, ctx)}</b></li>`)
    : [[ctx.labels.version, ctx.doc.meta.version], [ctx.labels.date, ctx.doc.meta.date], [ctx.labels.status, ctx.doc.meta.status]]
      .map(([l, v]) => `<li>${esc(l)} <b>${esc(v)}</b></li>`);
  return `<ul class="chips">${facts.join('')}</ul>`;
}

/**
 * Render the dossier of a document.
 * @param {{meta:any, blocks:any[], file:string}} doc
 * @param {{theme:any, labels:Record<string,any>, figures?:Map<string,{png:Buffer,width:number,height:number}>, lots?:string[],
 *   story?: import('./story.js').Story|null, storyRel?: string}} options
 * @returns {{html: string, warnings: import('./story.js').Finding[]}}
 */
export function renderDossier(doc, options) {
  const { theme, labels, story = null } = options;
  const ctx = {
    doc, theme, labels, dl: labels.dossier ?? {}, lang: normalizeLanguage(doc.meta.language),
    figures: options.figures ?? new Map(), lots: options.lots ?? [], ids: new Set(['recap']), nav: [],
  };
  const { meta } = doc;
  const { intro, sections } = splitSections(doc);
  const { bySection, warnings } = matchSections(story, sections.map((s) => ({ text: plain(s.heading.runs) })), options.storyRel ?? doc.file);

  const kicker = story?.kicker ? inline(story.kicker, ctx) : esc(`${meta.doc_id} · ${meta.project}`);
  const hasImages = bySection.some((s) => s?.image);
  const hero = [
    `<header class="hero">`,
    `<p class="kicker">${kicker}</p>`,
    `<h1 class="title">${esc(meta.title)}</h1>`,
    story?.lede ? `<p class="lede">${inline(story.lede, ctx)}</p>` : '',
    hasImages ? `<p class="howto"><strong>${esc(ctx.dl.howToReadLead)}</strong> ${esc(ctx.dl.howToRead)}</p>` : '',
    chips(ctx, story),
    `</header>`,
  ].filter(Boolean).join('\n');

  const recap = recapHtml(ctx, story);
  const introHtml = intro.length ? `<div class="body">${blocks(ctx, intro)}</div>` : '';
  const body = sections.map((s, i) => sectionHtml(ctx, s, bySection[i])).join('\n');
  const navLinks = ctx.nav.map((n) => `<a href="#${esc(n.id)}">${esc(n.number === null ? n.title : `${shownNumber(n.number)} · ${n.title}`)}</a>`).join('');
  const nav = `<a class="brand" href="${esc(encodeURI(indexFileName(labels)))}">${esc(ctx.dl.index)}</a><div class="navlinks">${navLinks}</div>`;
  const entry = {
    doc: meta.doc_id, title: meta.title, project: meta.project, language: ctx.lang, ...(options.source ? { source: options.source } : {}),
    kicker: story?.kicker ? plain(story.kicker) : '', lede: story?.lede ? plain(story.lede) : '',
  };
  const html = shell(ctx, { title: meta.title, meta: entry, nav, main: `${hero}\n${introHtml}\n${recap}\n${body}\n${aboutHtml(ctx)}` });
  return { html, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Index

/** The dossier entry of an HTML file, or null when the file is not a dossier. */
export function dossierEntry(html) {
  const m = new RegExp(`<meta name="${META_NAME}" content="([^"]*)">`).exec(String(html));
  if (!m) return null;
  try {
    const entry = JSON.parse(unesc(m[1]));
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

const rank = (entry) => {
  const at = ORDER.indexOf(String(entry.doc));
  return at < 0 ? ORDER.length : at;
};

/**
 * Render the index page of a folder of dossiers, in the language `lang` (its dossiers first).
 * @param {{file: string, entry: any, others: string[]}[]} items `file` is the dossier's name, `others` the names of the
 *   files beside it with the same base (the Word, Excel and PDF files)
 * @param {{theme:any, labels:Record<string,any>}} options
 */
export function renderIndex(items, { theme, labels, lang }) {
  const own = (item) => (lang && item.entry.language !== lang ? 1 : 0);
  const sorted = [...items].sort((a, b) => own(a) - own(b) || rank(a.entry) - rank(b.entry) || a.file.localeCompare(b.file));
  const first = sorted[0]?.entry ?? {};
  const ctx = { theme, labels, dl: labels.dossier ?? {}, lang: lang ?? normalizeLanguage(first.language), lots: [] };
  const cards = sorted.map(({ file, entry, others }) => {
    const kicker = entry.kicker || `${entry.doc ?? ''}`;
    const links = [`<li><a class="main" href="${esc(encodeURI(file))}">${esc(ctx.dl.read)}</a></li>`,
      ...others.map((o) => `<li><a href="${esc(encodeURI(o))}">${esc(extname(o).slice(1).toUpperCase())}</a></li>`)];
    return `<li class="card"><p class="kicker">${esc(kicker)}</p><h2><a href="${esc(encodeURI(file))}">${esc(entry.title ?? file)}</a></h2>`
      + `<p>${esc(entry.lede ?? '')}</p><ul class="files">${links.join('')}</ul></li>`;
  }).join('\n');
  const main = `<header class="hero"><p class="kicker">${esc(ctx.dl.indexKicker)}</p><h1 class="title">${esc(first.project ?? '')}</h1>`
    + `<p class="lede">${esc(ctx.dl.indexLede)}</p></header>\n<ul class="cards">\n${cards}\n</ul>`;
  const nav = `<a class="brand" href="${esc(encodeURI(indexFileName(labels)))}">${esc(first.project ?? ctx.dl.index)}</a><div class="navlinks"></div>`;
  return shell(ctx, { title: first.project ? `${first.project} · ${ctx.dl.indexKicker}` : ctx.dl.indexKicker, meta: null, nav, main });
}

/**
 * The index pages of each folder that gets a dossier in `files`, built from the dossiers already in the folder and the
 * new ones: one page for each language of the dossiers, so each dossier links to the index of its own language. Returns
 * the outputs to add (`{file, bytes}`), written with the rest, all or nothing.
 * @param {{file: string, bytes: Buffer|string}[]} files every output of the run
 * @param {{theme:any, exclude?: Set<string>}} options `exclude`: the dossiers of an older name, left out of the index
 */
export function indexOutputs(files, { theme, exclude = new Set() }) {
  const out = [];
  const dirs = new Map();
  for (const f of files) {
    if (extname(f.file) !== '.html' || isIndexName(basename(f.file))) continue;
    const dir = dirname(f.file);
    if (!dirs.has(dir)) dirs.set(dir, new Map());
    dirs.get(dir).set(basename(f.file), String(f.bytes));
  }
  for (const [dir, fresh] of dirs) {
    const names = new Set([...(existsSync(dir) ? readdirSync(dir) : []), ...files.filter((f) => dirname(f.file) === dir).map((f) => basename(f.file))]);
    const items = [];
    for (const name of names) {
      if (extname(name) !== '.html' || isIndexName(name) || exclude.has(join(dir, name))) continue;
      let html = fresh.get(name);
      if (html === undefined) {
        try { html = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
      }
      const entry = dossierEntry(html);
      if (!entry) continue;
      const base = basename(name, '.html');
      const others = [...names].filter((n) => n !== name && extname(n) !== '.html' && basename(n, extname(n)) === base).sort();
      items.push({ file: name, entry, others });
    }
    const languages = [...new Set(items.map((i) => normalizeLanguage(i.entry.language)))].sort();
    const written = new Set();
    for (const lang of languages) {
      const labels = loadLabels(lang);
      // A language without labels falls back to English: one page for both.
      if (written.has(indexFileName(labels))) continue;
      written.add(indexFileName(labels));
      out.push({ file: join(dir, indexFileName(labels)), bytes: Buffer.from(renderIndex(items, { theme, labels, lang })) });
    }
  }
  return out;
}
