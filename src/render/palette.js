import { chartFill } from './theme.js';

/** The node kinds of a figure: the names an author gives to a Mermaid node with `A:::ok`. */
export const FIGURE_KINDS = ['info', 'ok', 'warm', 'error', 'system'];

/** Fallbacks for a theme with no `figure` group: the pastel palette of the bundled default. */
const FALLBACK = {
  info: { fill: 'DCE6F1', stroke: '1F3864' },
  ok: { fill: 'DFF1EA', stroke: '2E7D5B' },
  warm: { fill: 'FBEBD7', stroke: 'A66A24' },
  error: { fill: 'FBE3E1', stroke: 'B5443C' },
  system: { fill: '1F3864', stroke: '1F3864', text: 'FFFFFF' },
};

/**
 * The colours of a figure, each with its default. `info` is the plain node and takes `color.chartFill` as its fill when
 * the theme sets one, so a project that chose a chart colour keeps it. `text` is the text on a node (ink, or white on
 * the system node), `line` the arrows and the borders of the diagram.
 * @param {any} theme
 * @returns {{info:any, ok:any, warm:any, error:any, system:any, line:string, text:string}}
 */
export function figurePalette(theme) {
  const ink = theme?.color?.ink ?? '0F1A22';
  const group = theme?.figure ?? {};
  const out = {};
  for (const kind of FIGURE_KINDS) {
    const entry = { ...FALLBACK[kind], ...(group[kind] ?? {}) };
    out[kind] = { fill: entry.fill, stroke: entry.stroke, text: entry.text ?? ink };
  }
  if (theme?.color?.chartFill) out.info.fill = chartFill(theme);
  return { ...out, line: group.line ?? theme?.color?.muted ?? '5A6672', text: ink };
}

/** The `themeVariables` of Mermaid (theme `base`) for a theme: pastel nodes, quiet lines, the font of the document. */
export function mermaidThemeVariables(theme, fontFamily) {
  const p = figurePalette(theme);
  const hex = (v) => `#${v}`;
  const rule = theme?.color?.rule ?? 'D9DFE4';
  const zebra = theme?.color?.zebra ?? 'F2F2F2';
  return {
    fontFamily,
    primaryColor: hex(p.info.fill),
    primaryBorderColor: hex(p.info.stroke),
    primaryTextColor: hex(p.text),
    secondaryColor: hex(p.ok.fill),
    secondaryBorderColor: hex(p.ok.stroke),
    secondaryTextColor: hex(p.text),
    tertiaryColor: hex(p.warm.fill),
    tertiaryBorderColor: hex(p.warm.stroke),
    tertiaryTextColor: hex(p.text),
    lineColor: hex(p.line),
    textColor: hex(p.text),
    edgeLabelBackground: '#FFFFFF',
    clusterBkg: hex(zebra),
    clusterBorder: hex(rule),
    noteBkgColor: hex(p.warm.fill),
    noteBorderColor: hex(p.warm.stroke),
    noteTextColor: hex(p.text),
    actorBkg: hex(p.info.fill),
    actorBorder: hex(p.info.stroke),
    actorTextColor: hex(p.text),
    actorLineColor: hex(p.line),
    signalColor: hex(p.line),
    signalTextColor: hex(p.text),
    labelBoxBkgColor: hex(p.ok.fill),
    labelBoxBorderColor: hex(p.ok.stroke),
    labelTextColor: hex(p.text),
    loopTextColor: hex(p.text),
    activationBkgColor: hex(p.ok.fill),
    activationBorderColor: hex(p.ok.stroke),
    sequenceNumberColor: '#FFFFFF',
    taskBkgColor: hex(p.info.fill),
    taskBorderColor: hex(p.info.stroke),
    taskTextColor: hex(p.text),
    taskTextOutsideColor: hex(p.text),
    activeTaskBkgColor: hex(p.ok.fill),
    activeTaskBorderColor: hex(p.ok.stroke),
    doneTaskBkgColor: hex(rule),
    doneTaskBorderColor: hex(p.line),
    critBkgColor: hex(p.error.fill),
    critBorderColor: hex(p.error.stroke),
    gridColor: hex(rule),
    sectionBkgColor: hex(zebra),
    altSectionBkgColor: '#FFFFFF',
    sectionBkgColor2: hex(zebra),
    titleColor: hex(p.text),
    todayLineColor: hex(p.error.stroke),
  };
}

/** The diagram types that take `classDef` lines. */
const CLASS_DEF_TYPES = /^(?:flowchart|graph|stateDiagram(?:-v2)?)\b/;

/**
 * Mermaid source with the classDefs of the palette (`info`, `ok`, `warm`, `error`, `system`) added at the end of a
 * flowchart, a graph or a state diagram, so an author writes `A:::ok` and gets the look without styling by hand. They
 * come last so that the line numbers of a Mermaid error stay the author's. A class the author defines is left alone.
 * Other diagram types are returned as they are.
 * @param {string} text
 * @param {any} theme
 * @returns {string}
 */
export function mermaidSource(text, theme) {
  const source = String(text);
  const lines = source.split('\n');
  let first = 0;
  // A front matter block (`---` ... `---`) and `%%` comments come before the diagram type.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    first = end < 0 ? lines.length : end + 1;
  }
  while (first < lines.length && (lines[first].trim() === '' || lines[first].trim().startsWith('%%'))) first += 1;
  if (first >= lines.length || !CLASS_DEF_TYPES.test(lines[first].trim())) return source;
  const p = figurePalette(theme);
  // `classDef ok,warm fill:...` defines several classes at once: a kind anywhere in the list is the author's.
  const defined = new Set([...source.matchAll(/^\s*classDef\s+(\S+)/gm)].flatMap((m) => m[1].split(',')));
  const defs = FIGURE_KINDS.filter((kind) => !defined.has(kind)).map((kind) => {
    const { fill, stroke, text: color } = p[kind];
    return `  classDef ${kind} fill:#${fill},stroke:#${stroke},color:#${color},stroke-width:1.5px;`;
  });
  return `${source.replace(/\s+$/, '')}\n${defs.join('\n')}\n`;
}
