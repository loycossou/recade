import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AlignmentType, BorderStyle, Bookmark, Document, ExternalHyperlink, ImageRun, InternalHyperlink, LevelFormat, Packer,
  PageBreak, PageNumber, Paragraph, SectionType, ShadingType, SimpleField, Footer, Header, Tab, TabStopType, Table,
  TableCell, TableLayoutType, TableOfContents, TableRow, TextRun, VerticalAlign, WidthType,
} from 'docx';
import JSZip from 'jszip';
import { FONT_DIR, normalizeLanguage, themeStyle } from './theme.js';
import { collectFigures } from './figures.js';
import { bookmarkName, isSafeLink } from './bookmarks.js';

export { bookmarkName };

const MONO = 'Consolas';
const FIGURE_SCALE = 2;
const PAGES = { A4: [11906, 16838], Letter: [12240, 15840] };
const FONT_FILES = { data: 'InterTight-Regular.ttf', bold: 'InterTight-Bold.ttf', italic: 'InterTight-Italic.ttf' };
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' };

// ---------------------------------------------------------------------------------------------------------------
// Context and small helpers

const halfPoints = (pt) => Math.round(pt * 2);
const twips = (cm) => Math.round((cm / 2.54) * 1440);
/** Word proofing language of a document: `en` is British English, `fr` is France French, other codes stay as given. */
const proofingLanguage = (code) => ({ en: 'en-GB', fr: 'fr-FR' })[code] ?? code;
const clean = (text) => String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
const plain = (runs) => (runs ?? []).map((r) => r.text).join('');
const asRuns = (text) => [{ text: clean(text) }];

function buildContext(doc, { theme, labels, figures }) {
  const [width, height] = PAGES[theme.page?.size] ?? PAGES.A4;
  const margin = twips(theme.page?.marginCm ?? 2);
  return {
    doc,
    theme,
    labels,
    figures: figures ?? new Map(),
    color: theme.color,
    size: theme.size,
    style: themeStyle(theme),
    language: proofingLanguage(normalizeLanguage(doc.meta.language)),
    family: theme.font?.family ?? 'Inter Tight',
    fallback: theme.font?.fallback ?? 'Arial',
    page: { width, height, margin },
    textWidth: width - 2 * margin,
    textHeight: height - 2 * margin,
    bookmarks: new Set(),
    listInstances: 0,
  };
}

/** Claims a bookmark name for the document: false when it is taken (Word names are case-insensitive). */
function claimBookmark(ctx, name) {
  const key = name.toLowerCase();
  if (ctx.bookmarks.has(key)) return false;
  ctx.bookmarks.add(key);
  return true;
}

function bookmarked(ctx, anchor, children) {
  const name = bookmarkName(anchor);
  return claimBookmark(ctx, name) ? [new Bookmark({ id: name, children })] : children;
}

/** Inline runs to docx paragraph children. `base` is the run formatting every run starts from. */
function inline(runs, ctx, base = {}) {
  return (runs ?? []).flatMap((run) => {
    const props = { ...base };
    if (run.bold) props.bold = true;
    if (run.italic) props.italics = true;
    if (run.code) props.font = MONO;
    if (run.provisional) props.shading = { type: ShadingType.CLEAR, fill: ctx.color.provisional, color: 'auto' };
    // An unsafe link (javascript:, data:...) is plain text, as in the HTML output.
    const link = isSafeLink(run.link) ? run.link : null;
    if (link) props.underline = { type: 'single' };
    const lines = clean(run.text).split('\n');
    const texts = lines.map((text, i) => new TextRun({ ...props, text, break: i > 0 ? 1 : undefined }));
    if (!link) return texts;
    if (link.startsWith('#')) return [new InternalHyperlink({ anchor: bookmarkName(link.slice(1)), children: texts })];
    return [new ExternalHyperlink({ link, children: texts })];
  });
}

const spacer = () => new Paragraph({ spacing: { before: 0, after: 80 }, run: { size: 8 }, children: [] });

/** Table cells must end with a paragraph, and two tables in a row would merge in Word. */
function endWithParagraph(elements) {
  return elements.length === 0 || elements.at(-1) instanceof Table ? [...elements, spacer()] : elements;
}

function border(color, size = 4) {
  return { style: BorderStyle.SINGLE, size, color, space: 0 };
}

/** A width in points as a Word border size, in eighths of a point (Word takes 2 to 96); 0 gives no border. */
const eighths = (pt) => (pt > 0 ? Math.min(96, Math.max(2, Math.round(pt * 8))) : 0);

// ---------------------------------------------------------------------------------------------------------------
// Tables

/** Column widths in twips summing to the text width: from `widths` (percentages) or equal. */
function columnWidths(count, widths, total) {
  const weights = widths && widths.length === count ? widths : Array(count).fill(1);
  const sum = weights.reduce((a, b) => a + b, 0) || count;
  const cols = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - cols.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i = (i + 1) % count, rest--) cols[i] += 1;
  return cols;
}

function cell(ctx, runs, width, { fill, base, anchor, bold }) {
  const children = inline(runs, ctx, { size: halfPoints(ctx.size.table), ...base, ...(bold ? { bold: true } : {}) });
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    verticalAlign: VerticalAlign.TOP,
    children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: anchor ? bookmarked(ctx, anchor, children) : children })],
  });
}

/**
 * One table for the data tables and the cover tables. `header` is an optional row of runs; `firstColumnFill` fills
 * the first column of the body (the metadata table). Rows are padded or cut to the number of columns.
 */
function dataTable(ctx, { header, rows, widths, anchors, firstColumnFill }) {
  const count = header ? header.length : Math.max(1, ...rows.map((r) => r.length));
  const cols = columnWidths(count, widths, ctx.textWidth);
  const fit = (row) => Array.from({ length: count }, (_, i) => row[i] ?? []);
  const c = ctx.color;
  const tableRows = [];
  if (header) {
    tableRows.push(new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: fit(header).map((runs, i) => cell(ctx, runs, cols[i], { fill: c.headerFill, base: { color: c.headerText }, bold: true })),
    }));
  }
  rows.forEach((row, r) => {
    const fill = r % 2 === 1 ? c.zebra : undefined;
    tableRows.push(new TableRow({
      cantSplit: true,
      children: fit(row).map((runs, i) => cell(ctx, runs, cols[i], {
        fill: firstColumnFill && i === 0 ? c.zebra : fill,
        anchor: i === 0 ? anchors?.[r] : undefined,
        bold: firstColumnFill && i === 0,
      })),
    }));
  });
  const line = border(c.rule);
  const side = ctx.style.tableRules === 'horizontal' ? NO_BORDER : line;
  return new Table({
    width: { size: ctx.textWidth, type: WidthType.DXA },
    columnWidths: cols,
    layout: TableLayoutType.FIXED,
    borders: { top: line, bottom: line, left: side, right: side, insideHorizontal: line, insideVertical: side },
    rows: tableRows,
  });
}

const tableBlock = (ctx, b) => [dataTable(ctx, { header: b.header, rows: b.rows, widths: b.widths, anchors: b.rowAnchors }), spacer()];

/** A single-cell table: callouts and code blocks. */
function boxTable(ctx, { fill, left, children, cantSplit }) {
  const none = { top: NO_BORDER, bottom: NO_BORDER, right: NO_BORDER, left: left ?? NO_BORDER };
  return new Table({
    width: { size: ctx.textWidth, type: WidthType.DXA },
    columnWidths: [ctx.textWidth],
    layout: TableLayoutType.FIXED,
    borders: { ...none, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
    rows: [new TableRow({
      cantSplit,
      children: [new TableCell({
        width: { size: ctx.textWidth, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill },
        borders: none,
        margins: { top: 100, bottom: 100, left: 160, right: 140 },
        children: endWithParagraph(children),
      })],
    })],
  });
}

function calloutBlock(ctx, b) {
  const label = { text: ctx.labels[b.kind] ?? b.kind, bold: true };
  const [first, ...rest] = b.blocks;
  const blocks = first?.type === 'paragraph'
    ? [{ ...first, runs: [label, { text: ' ' }, ...first.runs] }, ...rest]
    : [{ type: 'paragraph', runs: [label], line: b.line }, ...b.blocks];
  const fill = ctx.color[`callout${b.kind[0].toUpperCase()}${b.kind.slice(1)}`] ?? ctx.color.calloutNote;
  const bar = eighths(ctx.style.calloutBar);
  const left = bar > 0 ? border(ctx.color.accent, bar) : undefined;
  return [boxTable(ctx, { fill, left, cantSplit: true, children: blockList(ctx, blocks) }), spacer()];
}

function codeBlock(ctx, b) {
  const lines = clean(b.text).replace(/\t/g, '    ').split('\n');
  const children = lines.map((text) => new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    keepLines: true,
    children: [new TextRun({ text, font: MONO, size: halfPoints(ctx.size.code) })],
  }));
  return [boxTable(ctx, { fill: ctx.color.zebra, children }), spacer()];
}

// ---------------------------------------------------------------------------------------------------------------
// Other blocks

function headingBlock(ctx, b) {
  const level = Math.min(Math.max(b.level, 1), 4);
  return [new Paragraph({
    heading: `Heading${level}`,
    children: bookmarked(ctx, b.anchor, inline(b.runs, ctx)),
  })];
}

const BODY_SPACING = { before: 0, after: 120, line: 276 };

function paragraphBlock(ctx, b) {
  return [new Paragraph({ spacing: BODY_SPACING, children: inline(b.runs, ctx) })];
}

function listBlock(ctx, b, depth = 0) {
  ctx.listInstances += 1;
  const numbering = { reference: b.ordered ? 'ordered' : 'bullets', level: Math.min(depth, 5), instance: ctx.listInstances };
  return b.items.flatMap((item) => [
    new Paragraph({ numbering, spacing: { before: 0, after: 60, line: 276 }, children: inline(item.runs, ctx) }),
    ...item.children.flatMap((child) => (child.type === 'list' ? listBlock(ctx, child, depth + 1) : blockElements(ctx, child))),
  ]);
}

function figureBlock(ctx, b) {
  const image = ctx.figures.get(b.id);
  if (!image) throw new Error(`${ctx.doc.file}:${b.line}: figure ${b.id} was not rendered`);
  // Figures are captured at device scale factor 2: the natural size is half the PNG, in CSS pixels (96 to the inch).
  // A small figure keeps its natural size; a large one is capped at the text width and at a page's height.
  const maxWidth = Math.min(ctx.textWidth / 15, image.width / FIGURE_SCALE);
  const maxHeight = (ctx.textHeight - 1200) / 15;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const caption = { size: halfPoints(ctx.size.caption), color: ctx.color.muted, italics: true };
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      keepNext: true,
      spacing: { before: 120, after: 80 },
      children: [new ImageRun({
        type: 'png',
        data: image.png,
        transformation: { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) },
        altText: { name: b.id, title: plain(b.caption), description: plain(b.caption) },
      })],
    }),
    new Paragraph({
      style: 'Caption',
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 200 },
      children: [
        new TextRun({ text: `${ctx.labels.figure} `, ...caption }),
        new SimpleField('SEQ Figure \\* ARABIC', String(b.number)),
        new TextRun({ text: ': ', ...caption }),
        ...inline(b.caption, ctx, caption),
      ],
    }),
  ];
}

const BLOCKS = {
  heading: headingBlock,
  paragraph: paragraphBlock,
  list: (ctx, b) => listBlock(ctx, b),
  table: tableBlock,
  callout: calloutBlock,
  code: codeBlock,
  figure: figureBlock,
  pagebreak: () => [new Paragraph({ children: [new PageBreak()] })],
};

function blockElements(ctx, block) {
  const render = BLOCKS[block.type];
  if (!render) throw new Error(`${ctx.doc.file}:${block.line}: cannot render a ${block.type} block`);
  return render(ctx, block);
}

/** Blocks to docx elements. A page break right before an H1 is dropped: the H1 starts a page anyway. */
function blockList(ctx, blocks) {
  return blocks.flatMap((block, i) => {
    const next = blocks[i + 1];
    if (block.type === 'pagebreak' && next?.type === 'heading' && next.level === 1) return [];
    return blockElements(ctx, block);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Cover, contents, header and footer

const text = (ctx, value, props = {}) => new Paragraph({
  spacing: { before: 0, after: 0 },
  ...props.paragraph,
  children: [new TextRun({ text: clean(value), ...props.run })],
});

function coverChildren(ctx) {
  const { meta } = ctx.doc;
  const { labels, color, size } = ctx;
  const heading = (value) => text(ctx, value, {
    paragraph: { spacing: { before: 360, after: 120 }, keepNext: true },
    run: { bold: true, size: halfPoints(size.h3), color: color.muted },
  });
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
  const out = [];
  if (meta.org) {
    out.push(text(ctx, meta.org, { paragraph: { spacing: { before: 2400, after: 120 } }, run: { smallCaps: true, characterSpacing: 40, color: color.muted, size: halfPoints(size.body) } }));
  }
  out.push(
    text(ctx, meta.project, { paragraph: { spacing: { before: meta.org ? 0 : 2400, after: 60 } }, run: { size: halfPoints(size.h2), color: color.ink } }),
    text(ctx, meta.title, { paragraph: { spacing: { before: 0, after: 480 } }, run: { bold: true, size: halfPoints(size.h1 * 1.6), color: color.ink } }),
    dataTable(ctx, { rows: metaRows, widths: [30, 70], firstColumnFill: true }),
  );
  if (meta.revisions?.length) {
    out.push(
      heading(labels.revisionHistory),
      dataTable(ctx, {
        header: [labels.version, labels.date, labels.author, labels.change].map(asRuns),
        rows: meta.revisions.map((r) => [r.version, r.date, r.author, r.change].map(asRuns)),
        widths: [12, 16, 22, 50],
      }),
    );
  }
  if (meta.approvals?.length) {
    out.push(
      heading(labels.approval),
      dataTable(ctx, {
        header: [labels.role, labels.name, labels.date].map(asRuns),
        rows: meta.approvals.map((a) => [a.role, a.name, a.date].map(asRuns)),
        widths: [30, 45, 25],
      }),
    );
  }
  out.push(text(ctx, labels.sourceOfTruth, {
    paragraph: { spacing: { before: 360, after: 0 } },
    run: { italics: true, color: color.muted, size: halfPoints(size.caption) },
  }));
  return out;
}

function contentsChildren(ctx, hasFigures) {
  const title = (value) => new Paragraph({ style: 'ContentsTitle', children: [new TextRun({ text: value })] });
  const out = [title(ctx.labels.contents), new TableOfContents(ctx.labels.contents, { hyperlink: true, headingStyleRange: '1-2' })];
  if (hasFigures) {
    out.push(title(ctx.labels.figures), new TableOfContents(ctx.labels.figures, { hyperlink: true, captionLabelIncludingNumbers: 'Figure' }));
  }
  return out;
}

/**
 * Header and footer of a section. Built once per section: docx parts cannot be shared. With `blankFirst` the first page
 * (the cover) gets an empty header and footer.
 */
function pageChrome(ctx, { blankFirst = false } = {}) {
  const { meta } = ctx.doc;
  const small = { size: halfPoints(ctx.size.caption), color: ctx.color.muted };
  const header = new Header({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: ctx.textWidth }],
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, space: 4, color: ctx.color.rule } },
      children: [
        new TextRun({ text: clean(`${meta.project}${ctx.style.headerSeparator}${meta.title}`), ...small }),
        new TextRun({ children: [new Tab(), clean(`v${meta.version}${ctx.style.headerSeparator}${meta.status}`)], ...small }),
      ],
    })],
  });
  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: [`${ctx.labels.page} `, PageNumber.CURRENT, ` ${ctx.labels.of} `, PageNumber.TOTAL_PAGES], ...small })],
    })],
  });
  if (!blankFirst) return { headers: { default: header }, footers: { default: footer } };
  const blank = (Part) => new Part({ children: [new Paragraph({ children: [] })] });
  return { headers: { default: header, first: blank(Header) }, footers: { default: footer, first: blank(Footer) } };
}

// ---------------------------------------------------------------------------------------------------------------
// Styles, numbering, fonts

function styles(ctx) {
  const { color, size } = ctx;
  const font = ctx.family;
  const h1Rule = eighths(ctx.style.h1Rule);
  const heading = (pt, extra = {}, paragraph = {}) => ({
    run: { font, size: halfPoints(pt), bold: true, color: color.ink, ...extra },
    paragraph: { keepNext: true, keepLines: true, spacing: { before: 280, after: 120 }, ...paragraph },
  });
  return {
    default: {
      document: { run: { font, size: halfPoints(size.body), color: color.ink, language: { value: ctx.language } }, paragraph: { spacing: BODY_SPACING } },
      heading1: heading(size.h1, {}, {
        pageBreakBefore: true,
        spacing: { before: 0, after: 200 },
        ...(h1Rule > 0 ? { border: { bottom: { style: BorderStyle.SINGLE, size: h1Rule, space: 4, color: color.accent } } } : {}),
      }),
      heading2: heading(size.h2),
      heading3: heading(size.h3, { color: color.muted }),
      heading4: heading(size.h4),
    },
    paragraphStyles: [
      {
        id: 'ContentsTitle', name: 'Contents Title', basedOn: 'Normal', next: 'Normal',
        run: { font, bold: true, size: halfPoints(size.h2), color: color.ink },
        paragraph: { keepNext: true, spacing: { before: 240, after: 160 } },
      },
      {
        id: 'Caption', name: 'caption', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font, italics: true, size: halfPoints(size.caption), color: color.muted },
        paragraph: { alignment: AlignmentType.CENTER },
      },
    ],
  };
}

function numbering() {
  const levels = (reference) => Array.from({ length: 6 }, (_, level) => {
    const bullet = reference === 'bullets';
    return {
      level,
      format: bullet ? LevelFormat.BULLET : [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
      text: bullet ? ['•', '–', '▪'][level % 3] : `%${level + 1}.`,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 400 + level * 360, hanging: 280 } } },
    };
  });
  return { config: ['bullets', 'ordered'].map((reference) => ({ reference, levels: levels(reference) })) };
}

let fontFaces;
/** The Inter Tight faces to embed, or undefined when the theme uses another family. Read once. */
function embeddedFonts(ctx) {
  if (ctx.family !== 'Inter Tight') return undefined;
  fontFaces ??= [{ name: 'Inter Tight', ...Object.fromEntries(Object.entries(FONT_FILES).map(([k, f]) => [k, readFileSync(join(FONT_DIR, f))])) }];
  return fontFaces;
}

const xmlAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * docx-js cannot declare an alternate font, so the font table is patched: the family gets `w:altName` (the fallback,
 * Arial by default) and `w:family` swiss. Schema order inside w:font: altName, panose1, charset, family, ...
 */
async function declareFallback(buffer, ctx) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/fontTable.xml');
  if (!file) return buffer;
  const xml = await file.async('string');
  const name = xmlAttr(ctx.family);
  const alt = `<w:altName w:val="${xmlAttr(ctx.fallback)}"/><w:family w:val="swiss"/>`;
  const open = `<w:font w:name="${name}">`;
  let patched;
  if (xml.includes(open)) patched = xml.replace(open, open + alt).replace(`${alt}<w:family w:val="auto"/>`, alt);
  else {
    // Without embedded fonts docx writes an empty, self-closing <w:fonts/>.
    const entry = `<w:font w:name="${name}">${alt}</w:font>`;
    patched = xml.includes('</w:fonts>') ? xml.replace('</w:fonts>', `${entry}</w:fonts>`) : xml.replace(/<w:fonts([^>]*?)\/>/, `<w:fonts$1>${entry}</w:fonts>`);
  }
  zip.file('word/fontTable.xml', patched, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Renders a document to a .docx package.
 * @param {import('./parse.js').Doc} doc
 * @param {{theme:any, labels:Record<string,string>, figures?:Map<string,{png:Buffer,width:number,height:number}>}} options
 * @returns {Promise<Buffer>}
 */
export async function renderDocx(doc, options) {
  const ctx = buildContext(doc, options);
  const { meta } = doc;
  const body = blockList(ctx, doc.blocks);
  const properties = {
    page: {
      size: { width: ctx.page.width, height: ctx.page.height },
      margin: { top: ctx.page.margin, right: ctx.page.margin, bottom: ctx.page.margin, left: ctx.page.margin, header: 567, footer: 567 },
    },
  };
  const document = new Document({
    title: clean(meta.title),
    creator: clean(meta.author ?? meta.org ?? 'Recade'),
    lastModifiedBy: clean(meta.author ?? meta.org ?? 'Recade'),
    features: { updateFields: true },
    fonts: embeddedFonts(ctx),
    styles: styles(ctx),
    numbering: numbering(),
    sections: [
      { properties: { ...properties, titlePage: true }, ...pageChrome(ctx, { blankFirst: true }), children: coverChildren(ctx) },
      {
        properties: { ...properties, type: SectionType.NEXT_PAGE },
        ...pageChrome(ctx),
        children: [...contentsChildren(ctx, collectFigures(doc.blocks).length > 0), ...body],
      },
    ],
  });
  return declareFallback(await Packer.toBuffer(document), ctx);
}
