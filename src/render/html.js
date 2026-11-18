import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RENDER_DIR, normalizeLanguage } from './theme.js';
import { fontFaceCss } from './figures.js';
import { bookmarkName, isSafeLink } from './bookmarks.js';

const FIGURE_SCALE = 2;
const PX_PER_CM = 96 / 2.54;
const PAGES = { A4: { css: 'A4', cm: [21, 29.7] }, Letter: { css: 'Letter', cm: [21.59, 27.94] } };

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text and attribute values: control characters are dropped, the five markup characters become entities. */
const esc = (text) => String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
const plain = (runs) => (runs ?? []).map((r) => r.text).join('');
const asRuns = (text) => [{ text: String(text ?? '') }];
const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Page geometry of a theme: CSS size keyword, size and margin in centimetres. Shared with pdf.js. */
export function pageGeometry(theme) {
  const page = PAGES[theme.page?.size] ?? PAGES.A4;
  const marginCm = Number(theme.page?.marginCm ?? 2);
  return { size: page.css, widthCm: page.cm[0], heightCm: page.cm[1], marginCm: Number.isFinite(marginCm) ? marginCm : 2 };
}

function buildContext(doc, { theme, labels, figures }) {
  const lang = normalizeLanguage(doc.meta.language);
  const page = pageGeometry(theme);
  return {
    doc,
    theme,
    labels,
    lang,
    page,
    figures: figures ?? new Map(),
    textWidthPx: (page.widthCm - 2 * page.marginCm) * PX_PER_CM,
    textHeightPx: (page.heightCm - 2 * page.marginCm) * PX_PER_CM,
    ids: new Set(),
    headings: [],
    figureList: [],
  };
}

/** Claims an element id for the document: false when it is taken. */
function claim(ctx, id) {
  if (ctx.ids.has(id)) return false;
  ctx.ids.add(id);
  return true;
}

const idAttr = (ctx, id) => (claim(ctx, id) ? ` id="${esc(id)}"` : '');

// ---------------------------------------------------------------------------------------------------------------
// Inline

function inline(runs) {
  return (runs ?? []).map((run) => {
    let out = esc(run.text).replace(/\n/g, '<br>');
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

/** Inline runs without their links: contents entries are links themselves, anchors cannot nest. */
const unlinked = (runs) => inline((runs ?? []).map((r) => ({ ...r, link: undefined })));

// ---------------------------------------------------------------------------------------------------------------
// Tables

/** Column widths as percentages: from `widths` or equal. */
function colgroup(count, widths) {
  const weights = widths && widths.length === count ? widths : Array(count).fill(1);
  const sum = weights.reduce((a, b) => a + b, 0) || count;
  return `<colgroup>${weights.map((w) => `<col style="width:${Math.round((w / sum) * 10000) / 100}%">`).join('')}</colgroup>`;
}

/** One table for the data tables and the cover tables. Rows are padded or cut to the number of columns. */
function table(ctx, { header, rows, widths, anchors, className }) {
  const count = header ? header.length : Math.max(1, ...rows.map((r) => r.length));
  const fit = (row) => Array.from({ length: count }, (_, i) => row[i] ?? []);
  const head = header ? `<thead><tr>${fit(header).map((runs) => `<th>${inline(runs)}</th>`).join('')}</tr></thead>` : '';
  const body = rows.map((row, r) => {
    const id = anchors?.[r] ? idAttr(ctx, bookmarkName(anchors[r])) : '';
    return `<tr${id}>${fit(row).map((runs) => `<td>${inline(runs)}</td>`).join('')}</tr>`;
  }).join('');
  return `<table${className ? ` class="${className}"` : ''}>${colgroup(count, widths)}${head}<tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks

function heading(ctx, b) {
  const level = Math.min(Math.max(b.level, 1), 4);
  const name = bookmarkName(b.anchor);
  const id = claim(ctx, name) ? name : null;
  ctx.headings.push({ level, runs: b.runs, id });
  return `<h${level}${id ? ` id="${esc(id)}"` : ''}>${inline(b.runs)}</h${level}>`;
}

function list(ctx, b) {
  const tag = b.ordered ? 'ol' : 'ul';
  const items = b.items.map((item) => `<li>${inline(item.runs)}${blocks(ctx, item.children)}</li>`).join('');
  return `<${tag}>${items}</${tag}>`;
}

function callout(ctx, b) {
  const label = { text: ctx.labels[b.kind] ?? b.kind, bold: true };
  const [first, ...rest] = b.blocks;
  const content = first?.type === 'paragraph'
    ? [{ ...first, runs: [label, { text: ' ' }, ...first.runs] }, ...rest]
    : [{ type: 'paragraph', runs: [label], line: b.line }, ...b.blocks];
  return `<aside class="callout ${esc(b.kind)}">${blocks(ctx, content)}</aside>`;
}

function code(ctx, b) {
  const text = b.text.replace(/\t/g, '    ');
  return `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ''}>${esc(text)}</code></pre>`;
}

function figure(ctx, b) {
  const image = ctx.figures.get(b.id);
  if (!image) throw new Error(`${ctx.doc.file}:${b.line}: figure ${b.id} was not rendered`);
  // Figures are captured at device scale factor 2: the natural size is half the PNG, in CSS pixels. A small figure
  // keeps its natural size; a large one is capped at the text width and at a page's height.
  const maxWidth = Math.min(ctx.textWidthPx, image.width / FIGURE_SCALE);
  const maxHeight = Math.max(ctx.textHeightPx - 80, ctx.textHeightPx / 2);
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const id = `figure_${b.id.replace(/[^A-Za-z0-9]/g, '_')}`;
  const attr = idAttr(ctx, id);
  const label = `${esc(ctx.labels.figure)} ${b.number}: `;
  const caption = `${label}${inline(b.caption)}`;
  ctx.figureList.push({ id: attr ? id : null, caption: `${label}${unlinked(b.caption)}` });
  const src = `data:image/png;base64,${image.png.toString('base64')}`;
  return `<figure${attr}><img src="${src}" width="${width}" height="${height}" alt="${esc(plain(b.caption))}"><figcaption>${caption}</figcaption></figure>`;
}

const BLOCKS = {
  heading,
  paragraph: (ctx, b) => `<p>${inline(b.runs)}</p>`,
  list,
  table: (ctx, b) => table(ctx, { header: b.header, rows: b.rows, widths: b.widths, anchors: b.rowAnchors }),
  callout,
  code,
  figure,
  pagebreak: () => '<div class="pagebreak"></div>',
};

function blockHtml(ctx, block) {
  const render = BLOCKS[block.type];
  if (!render) throw new Error(`${ctx.doc.file}:${block.line}: cannot render a ${block.type} block`);
  return render(ctx, block);
}

/** Blocks to markup. A page break right before an H1 is dropped: the H1 starts a page anyway. */
function blocks(ctx, list_) {
  return list_.map((block, i) => {
    const next = list_[i + 1];
    if (block.type === 'pagebreak' && next?.type === 'heading' && next.level === 1) return '';
    return blockHtml(ctx, block);
  }).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Cover, contents, stylesheet

function cover(ctx) {
  const { meta } = ctx.doc;
  const { labels } = ctx;
  const pair = (label, value) => [asRuns(label), asRuns(value)];
  const metaRows = [
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
  const parts = [];
  if (meta.org) parts.push(`<p class="org">${esc(meta.org)}</p>`);
  parts.push(
    `<p class="project"${meta.org ? '' : ' style="margin-top:120pt"'}>${esc(meta.project)}</p>`,
    `<p class="title">${esc(meta.title)}</p>`,
    `<table class="meta">${colgroup(2, [30, 70])}<tbody>${metaRows.map(([l, v]) => `<tr><th>${inline(l)}</th><td>${inline(v)}</td></tr>`).join('')}</tbody></table>`,
  );
  if (meta.revisions?.length) {
    parts.push(
      `<h2>${esc(labels.revisionHistory)}</h2>`,
      table(ctx, {
        header: [labels.version, labels.date, labels.author, labels.change].map(asRuns),
        rows: meta.revisions.map((r) => [r.version, r.date, r.author, r.change].map(asRuns)),
        widths: [12, 16, 22, 50],
      }),
    );
  }
  if (meta.approvals?.length) {
    parts.push(
      `<h2>${esc(labels.approval)}</h2>`,
      table(ctx, {
        header: [labels.role, labels.name, labels.date].map(asRuns),
        rows: meta.approvals.map((a) => [a.role, a.name, a.date].map(asRuns)),
        widths: [30, 45, 25],
      }),
    );
  }
  parts.push(`<p class="source">${esc(labels.sourceOfTruth)}</p>`);
  return `<section class="cover">\n${parts.join('\n')}\n</section>`;
}

/** Contents (levels 1 and 2, links to the heading anchors, no page numbers) and the list of figures. */
function contents(ctx) {
  const link = (id, text) => (id ? `<a href="#${esc(id)}">${text}</a>` : text);
  const items = ctx.headings.filter((h) => h.level <= 2).map((h) => `<li class="l${h.level}">${link(h.id, unlinked(h.runs))}</li>`);
  let out = `<nav class="contents">\n<p class="toc-title">${esc(ctx.labels.contents)}</p>\n<ul>${items.join('\n')}</ul>\n</nav>`;
  if (ctx.figureList.length > 0) {
    const figs = ctx.figureList.map((f) => `<li>${link(f.id, f.caption)}</li>`);
    out += `\n<nav class="figures">\n<p class="toc-title">${esc(ctx.labels.figures)}</p>\n<ul>${figs.join('\n')}</ul>\n</nav>`;
  }
  return out;
}

const HEX = /^[0-9A-Fa-f]{3,8}$/;
const cssFamily = (name) => String(name).replace(/[^\w .-]/g, '');

/** A CSS string literal: quotes, backslashes and markup characters become hex escapes, line breaks become spaces. */
const cssString = (text) => `"${String(text ?? '').replace(/[\r\n\f\v\u2028\u2029]+/g, ' ').replace(/[\\"<>&]/g, (c) => `\\${c.codePointAt(0).toString(16)} `)}"`;

/**
 * The @page rules: size and margins from the theme, and the running header and footer as CSS page-margin boxes, with
 * the same texts as the DOCX. Margin boxes use the page's own fonts (Chromium's header and footer templates cannot
 * load a font) and `counter(page)` and `counter(pages)` give the page numbers. `:first` empties them: no running
 * header and footer on the cover.
 */
function pageCss(ctx) {
  const { theme, page, labels, doc } = ctx;
  const { meta } = doc;
  const small = `font-family:inherit;font-size:${Number(theme.size?.caption) || 8.5}pt;color:var(--muted)`;
  const header = `${small};vertical-align:bottom;padding-bottom:8pt;border-bottom:0.5pt solid var(--rule)`;
  const footer = `${small};vertical-align:top;padding-top:8pt`;
  const left = cssString(`${meta.project} \u00b7 ${meta.title}`);
  const right = cssString(`v${meta.version} \u00b7 ${meta.status}`);
  const pageOf = `${cssString(`${labels.page} `)} counter(page) ${cssString(` ${labels.of} `)} counter(pages)`;
  return `@page{size:${page.size};margin:${page.marginCm}cm;`
    + `@top-left{content:${left};${header}}@top-center{content:"";${header}}@top-right{content:${right};${header}}`
    + `@bottom-center{content:${pageOf};${footer}}}\n`
    + '@page :first{@top-left{content:none;border:0}@top-center{content:none;border:0}@top-right{content:none;border:0}@bottom-center{content:none}}';
}

/** Theme tokens as CSS variables on :root, the generated @page rules, and a family override for custom fonts. */
function themeCss(ctx) {
  const { theme } = ctx;
  const vars = [];
  for (const [key, value] of Object.entries(theme.color ?? {})) if (HEX.test(String(value))) vars.push(`--${kebab(key)}:#${value}`);
  for (const [key, value] of Object.entries(theme.size ?? {})) if (Number.isFinite(Number(value))) vars.push(`--size-${kebab(key)}:${Number(value)}pt`);
  const family = theme.font?.family ?? 'Inter Tight';
  const fallback = cssFamily(theme.font?.fallback ?? 'Arial');
  const override = family === 'Inter Tight' ? '' : `\nhtml,body{font-family:"${cssFamily(family)}", ${fallback}, sans-serif}`;
  return `:root{${vars.join(';')}}\n${pageCss(ctx)}${override}`;
}

/**
 * Renders a document to one self-contained HTML page: fonts and figures travel as data: URLs, the theme tokens as
 * CSS variables, the layout mirrors the DOCX (cover, contents, list of figures, body).
 * @param {import('./parse.js').Doc} doc
 * @param {{theme:any, labels:Record<string,string>, figures?:Map<string,{png:Buffer,width:number,height:number}>}} options
 * @returns {string}
 */
export function renderHtml(doc, options) {
  const ctx = buildContext(doc, options);
  const body = blocks(ctx, doc.blocks);
  const printCss = readFileSync(join(RENDER_DIR, 'print.css'), 'utf8');
  return `<!doctype html>
<html lang="${esc(ctx.lang)}">
<head>
<meta charset="utf-8">
<title>${esc(doc.meta.title)}</title>
<style>
${fontFaceCss()}
${themeCss(ctx)}
${printCss}
</style>
</head>
<body>
${cover(ctx)}
${contents(ctx)}
<main>
${body}
</main>
</body>
</html>
`;
}
