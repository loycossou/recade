import { basename } from 'node:path';
import ExcelJS from 'exceljs';
import { plainText } from './inline.js';
import { chartFill, themeStyle } from './theme.js';

const HEADER_ROW = 4;
const FIRST_ROW = 5;
const MIN_WIDTH = 8;
const MAX_WIDTH = 60;
// Rules, lists and input fills reach this many rows below the data, for rows the owner adds.
const SPARE_ROWS = 50;

const BACKLOG_STATUSES = ['Backlog', 'Ready', 'In progress', 'Review', 'Done', 'Blocked'];
const MILESTONE_STATUSES = ['Upcoming', 'In progress', 'Reached', 'Slipped'];

const RED = 'F9D2D2';
const AMBER = 'FDD663';
const GREEN = 'CEEAD6';
const BLUE = 'EEF0FD';
const SCORE_HIGH = 'F28B82';

/**
 * The sheets of the delivery plan workbook, in order, with their expected columns.
 * RACI and Gantt only fix their leading columns: roles and sprints come from the data.
 * @type {{name: string, columns: string[]}[]}
 */
export const PLAN_SHEETS = [
  { name: 'Summary', columns: ['Item', 'Value'] },
  { name: 'Backlog', columns: ['ID', 'Lot', 'Item', 'Size', 'Points', 'Depends on', 'Sprint', 'Phase', 'Status', 'Comment'] },
  { name: 'Sprints', columns: ['Sprint', 'Start', 'End', 'Theme', 'Planned points', 'Capacity', 'Margin', 'Milestone'] },
  { name: 'Milestones', columns: ['ID', 'Date', 'What is true that day', 'Criterion', 'Status'] },
  { name: 'External dependencies', columns: ['ID', 'What', 'From whom', 'Due', 'Blocks', 'Plan B', 'Status', 'Received'] },
  { name: 'Decisions', columns: ['ID', 'Question', 'Option A', 'Option B', 'Recommendation', 'Due', 'Decision', 'Date'] },
  { name: 'Risks', columns: ['ID', 'Risk', 'P', 'I', 'Score', 'Mitigation', 'Warning signal', 'Owner'] },
  { name: 'RACI', columns: ['Activity'] },
  { name: 'Gantt', columns: ['Item', 'First sprint', 'Last sprint'] },
];

const norm = (s) => String(s).trim().toLowerCase();
const argb = (hex) => `FF${hex.toUpperCase()}`;
const solid = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } });
const cfFill = (hex) => ({ fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb(hex) } } });

/** 1-based column number to its letters (1 -> A, 27 -> AA). */
function letter(n) {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

/** Column number (1-based) of the named column, or 0. */
const find = (columns, name) => columns.findIndex((c) => norm(c) === norm(name)) + 1;

// Columns that identify things: kept as text even when they look like numbers.
const TEXT_COLUMNS = new Set(['id', 'sprint', 'first sprint', 'last sprint']);

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
// Only canonical numbers: `1.0`, `2.50` and `007` keep their text.
const isCanonicalNumber = (text) => NUMBER.test(text) && String(Number(text)) === text;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The value written in a cell: a number, a Date, or the text itself (never a formula). */
function cellValue(text, forceText) {
  if (text === '') return { value: null };
  if (!forceText) {
    if (isCanonicalNumber(text)) return { value: Number(text) };
    const m = DATE.exec(text);
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const date = new Date(Date.UTC(y, mo - 1, d));
      if (date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d) {
        return { value: date, numFmt: 'yyyy-mm-dd' };
      }
    }
  }
  return { value: text };
}

const POINTS = { S: 1, M: 2, L: 3 };
const sizePoints = (size) => POINTS[String(size).trim().toUpperCase()] ?? 0;

/**
 * Collect, for each sheet, the first table of the first H2 section whose title matches the sheet name.
 * @returns {Map<string, any>}
 */
function collectTables(doc) {
  const byName = new Map(PLAN_SHEETS.map((s) => [norm(s.name), s.name]));
  const found = new Map();
  let current = null;
  for (const block of doc.blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      const title = norm(plainText(block.runs)).replace(/^\d+\s*[.)]?\s*/, '');
      const sheet = block.level === 2 ? byName.get(title) : undefined;
      current = sheet && !found.has(sheet) ? sheet : null;
    } else if (block.type === 'table' && current && !found.has(current)) {
      found.set(current, block);
    }
  }
  return found;
}

const sameColumns = (a, b) => a.length === b.length && a.every((c, i) => norm(c) === norm(b[i]));

/** Does the table header fit what the sheet expects? */
function columnsFit(sheet, header) {
  if (sheet === 'RACI') return header.length >= 2 && norm(header[0]) === 'activity';
  const spec = PLAN_SHEETS.find((s) => s.name === sheet).columns;
  if (sheet === 'Gantt') return header.length >= spec.length && sameColumns(header.slice(0, spec.length), spec);
  return sameColumns(header, spec);
}

/**
 * Render the delivery plan workbook (PLAN document) to an xlsx buffer.
 * @param {{meta: any, blocks: any[], file: string}} doc
 * @param {{theme: any, labels: Record<string,string>}} ctx
 * @returns {Promise<{buffer: Buffer, warnings: any[]}>}
 */
export async function renderPlanWorkbook(doc, { theme, labels }) {
  const tables = collectTables(doc);
  const warnings = [];
  const font = { name: theme.font.family, size: theme.size.body };

  // 1. Resolve each sheet's columns and rows as plain text.
  const sheets = new Map();
  for (const spec of PLAN_SHEETS) {
    const table = tables.get(spec.name);
    let columns = [...spec.columns];
    let rows = [];
    if (table) {
      columns = table.header.map((runs) => plainText(runs).trim());
      rows = table.rows.map((row) => columns.map((_, i) => plainText(row[i] ?? []).trim()));
      if (!columnsFit(spec.name, columns)) {
        const expected = spec.name === 'RACI' ? 'Activity, then one column per role' : spec.columns.join(', ');
        warnings.push({
          file: doc.file,
          line: table.line,
          column: 1,
          rule: 'plan-columns',
          severity: 'warn',
          message: `Sheet "${spec.name}": expected columns ${expected}; found ${columns.join(', ')}`,
        });
      }
    }
    sheets.set(spec.name, { spec, columns, rows, sprintColumns: 0 });
  }

  // 2. The Gantt gets one column per sprint of the Sprints sheet.
  const sprints = sheets.get('Sprints');
  const sprintCol = find(sprints.columns, 'Sprint') || 1;
  const sprintNames = sprints.rows.map((r) => r[sprintCol - 1]).filter((n) => n !== '');
  const gantt = sheets.get('Gantt');
  const keep = gantt.columns.map((c, i) => i).filter((i) => !sprintNames.some((n) => norm(n) === norm(gantt.columns[i])));
  gantt.rows = gantt.rows.map((r) => keep.map((i) => r[i]));
  gantt.columns = keep.map((i) => gantt.columns[i]);
  gantt.firstSprintColumn = gantt.columns.length + 1;
  gantt.columns.push(...sprintNames);
  gantt.rows = gantt.rows.map((r) => [...r, ...sprintNames.map(() => '')]);
  gantt.sprintColumns = sprintNames.length;

  // Backlog points per sprint, for the cached results of the Sprints formulas.
  const backlog = sheets.get('Backlog');
  const bSize = find(backlog.columns, 'Size');
  const bPoints = find(backlog.columns, 'Points');
  const bSprint = find(backlog.columns, 'Sprint');
  const backlogPoints = backlog.rows.map((r) => ({
    sprint: bSprint ? r[bSprint - 1] : '',
    points: bSize ? sizePoints(r[bSize - 1]) : Number(r[bPoints - 1]) || 0,
  }));

  // 3. Build the workbook.
  const workbook = new ExcelJS.Workbook();
  workbook.creator = doc.meta.author || doc.meta.project;
  workbook.title = doc.meta.title;
  workbook.calcProperties.fullCalcOnLoad = true;
  const source = basename(doc.file);

  for (const { spec, columns, rows } of sheets.values()) {
    const sheet = spec.name;
    const ws = workbook.addWorksheet(sheet, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: HEADER_ROW, topLeftCell: `B${FIRST_ROW}`, activeCell: `B${FIRST_ROW}`, showGridLines: false }],
    });
    const nCols = columns.length;
    const last = FIRST_ROW + rows.length - 1;
    const end = last + SPARE_ROWS;

    ws.getCell('A1').value = `${doc.meta.project}${themeStyle(theme).headerSeparator}${sheet}`;
    ws.getCell('A1').font = { ...font, size: 14, bold: true };
    ws.getCell('A2').value = `${labels.sourceOfTruth} (${source})`;
    ws.getCell('A2').font = { ...font, color: { argb: argb(theme.color.muted) } };

    columns.forEach((name, i) => {
      const cell = ws.getCell(HEADER_ROW, i + 1);
      cell.value = name;
      cell.font = { ...font, bold: true, color: { argb: argb(theme.color.headerText) } };
      cell.fill = solid(theme.color.headerFill);
      cell.alignment = { vertical: 'middle', wrapText: true };
    });

    const col = (name) => find(columns, name);
    const widths = columns.map((name) => name.length);

    rows.forEach((row, r) => {
      const n = FIRST_ROW + r;
      row.forEach((text, i) => {
        const cell = ws.getCell(n, i + 1);
        const { value, numFmt } = cellValue(text, TEXT_COLUMNS.has(norm(columns[i])));
        cell.value = value;
        if (numFmt) cell.numFmt = numFmt;
        cell.font = font;
        cell.alignment = { vertical: 'top', wrapText: true };
        widths[i] = Math.max(widths[i], text.length);
      });

      const formula = (name, f, result) => {
        const c = col(name);
        if (!c) return;
        ws.getCell(n, c).value = { formula: f, result };
        widths[c - 1] = Math.max(widths[c - 1], String(result ?? '').length);
      };
      const ref = (name) => `${letter(col(name))}${n}`;
      const num = (name) => Number(row[col(name) - 1]) || 0;

      if (sheet === 'Backlog' && col('Size') && col('Points')) {
        const s = ref('Size');
        formula('Points', `IF(${s}="S",1,IF(${s}="M",2,IF(${s}="L",3,0)))`, sizePoints(row[col('Size') - 1]));
      }
      if (sheet === 'Sprints') {
        const bs = find(backlog.columns, 'Sprint');
        const bp = find(backlog.columns, 'Points');
        const planned = col('Planned points');
        if (col('Sprint') && planned && bs && bp) {
          const name = row[col('Sprint') - 1];
          const total = backlogPoints.filter((b) => b.sprint === name).reduce((sum, b) => sum + b.points, 0);
          const L = letter;
          formula('Planned points', `SUMIF(Backlog!${L(bs)}:${L(bs)},${ref('Sprint')},Backlog!${L(bp)}:${L(bp)})`, total);
        }
        if (planned && col('Capacity') && col('Margin')) {
          const total = backlogPoints.filter((b) => b.sprint === row[col('Sprint') - 1]).reduce((sum, b) => sum + b.points, 0);
          formula('Margin', `${ref('Capacity')}-${ref('Planned points')}`, num('Capacity') - total);
        }
      }
      if (sheet === 'Risks' && col('P') && col('I') && col('Score')) {
        formula('Score', `${ref('P')}*${ref('I')}`, num('P') * num('I'));
      }
    });

    // Input cells and Status lists: one range per column, spare rows included.
    const range = (c1, c2 = c1) => `${letter(c1)}${FIRST_ROW}:${letter(c2)}${end}`;
    if (sheet === 'Decisions') {
      for (const name of ['Decision', 'Date']) {
        if (!col(name)) continue;
        for (let n = FIRST_ROW; n <= end; n += 1) ws.getCell(n, col(name)).fill = solid(theme.color.inputFill);
      }
    }
    const statusList = { Backlog: BACKLOG_STATUSES, Milestones: MILESTONE_STATUSES }[sheet];
    if (statusList && col('Status')) {
      ws.dataValidations.add(range(col('Status')), {
        type: 'list',
        allowBlank: true,
        showErrorMessage: true,
        errorTitle: 'Status',
        error: 'Pick a value from the list.',
        formulae: [`"${statusList.join(',')}"`],
      });
    }

    // Conditional formats.
    const addRules = (ref, rules) => ws.addConditionalFormatting({ ref, rules: rules.map((r, i) => ({ priority: i + 1, ...r })) });
    if (sheet === 'Sprints' && col('Margin')) {
      addRules(range(col('Margin')), [{ type: 'cellIs', operator: 'lessThan', formulae: [0], style: cfFill(RED) }]);
    }
    if (sheet === 'Risks' && col('Score')) {
      // Guarded by ISNUMBER so that the empty spare rows stay unfilled.
      const s = `${letter(col('Score'))}${FIRST_ROW}`;
      addRules(range(col('Score')), [
        { type: 'expression', formulae: [`AND(ISNUMBER(${s}),${s}>=6)`], style: cfFill(SCORE_HIGH) },
        { type: 'expression', formulae: [`AND(ISNUMBER(${s}),${s}>=3,${s}<=5)`], style: cfFill(AMBER) },
        { type: 'expression', formulae: [`AND(ISNUMBER(${s}),${s}<=2)`], style: cfFill(GREEN) },
      ]);
    }
    if (sheet === 'External dependencies' && col('Due') && col('Received')) {
      const due = `$${letter(col('Due'))}${FIRST_ROW}`;
      const got = `$${letter(col('Received'))}${FIRST_ROW}`;
      addRules(range(1, nCols), [{ type: 'expression', formulae: [`AND(ISNUMBER(${due}),${due}<TODAY(),${got}="")`], style: cfFill(RED) }]);
    }
    if (sheet === 'RACI' && nCols >= 2) {
      const tl = `B${FIRST_ROW}`;
      addRules(range(2, nCols), [
        ['R', RED], ['A', AMBER], ['C', GREEN], ['I', BLUE],
      ].map(([l, hex]) => ({ type: 'expression', formulae: [`LEFT(TRIM(${tl}),1)="${l}"`], style: cfFill(hex) })));
    }
    if (sheet === 'Gantt' && sprintNames.length > 0 && col('First sprint') && col('Last sprint')) {
      const c1 = gantt.firstSprintColumn;
      const c2 = c1 + sprintNames.length - 1;
      const heads = `$${letter(c1)}$${HEADER_ROW}:$${letter(c2)}$${HEADER_ROW}`;
      const pos = `COLUMN(${letter(c1)}${FIRST_ROW})-COLUMN($${letter(c1)}${FIRST_ROW})+1`;
      const first = `$${letter(col('First sprint'))}${FIRST_ROW}`;
      const lastS = `$${letter(col('Last sprint'))}${FIRST_ROW}`;
      addRules(range(c1, c2), [{
        type: 'expression',
        formulae: [`AND(${pos}>=MATCH(${first},${heads},0),${pos}<=MATCH(${lastS},${heads},0))`],
        style: cfFill(chartFill(theme)),
      }]);
    }

    columns.forEach((_, i) => {
      ws.getColumn(i + 1).width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, widths[i] + 2));
    });
    ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: Math.max(last, HEADER_ROW), column: nCols } };
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { buffer, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Plain tables: the weighted matrix of the STACK and the decision register. One sheet per table, no formulas.

const SHEET_NAME_MAX = 31;

/** A worksheet name Excel accepts: no `[]:*?/\`, at most 31 characters, not empty, unique ignoring case. */
function sheetName(wanted, taken) {
  const base = String(wanted).replace(/[[\]:*?/\\]+/g, '-').replace(/\s+/g, ' ').replace(/^['\s-]+|['\s-]+$/g, '').trim() || 'Sheet';
  let name = base.slice(0, SHEET_NAME_MAX).trim();
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
    const suffix = ` ${n}`;
    name = `${base.slice(0, SHEET_NAME_MAX - suffix.length).trim()}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

/**
 * The sheets of the STACK matrix workbook: one for each table of section 5 "Weighted matrix" (the number in front of
 * the title does not matter). A sheet takes the name of the sub-heading that holds its table, else "Weighted matrix"
 * when there is one table, else "Matrix n". A STACK with no such table gives no sheet and one warning.
 * @param {{meta: any, blocks: any[], file: string}} doc
 * @returns {{sheets: {name: string, columns: string[], rows: string[][]}[], warnings: any[]}}
 */
export function stackMatrixSheets(doc) {
  const found = [];
  let inside = false;
  let sub = '';
  let at = 0;
  for (const block of doc.blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      const title = norm(plainText(block.runs)).replace(/^\d+\s*[.)]?\s*/, '');
      inside = block.level === 2 && title === 'weighted matrix';
      sub = '';
      if (inside) at = block.line;
    } else if (inside && block.type === 'heading' && block.level === 3) {
      sub = plainText(block.runs).trim();
    } else if (inside && block.type === 'table') {
      found.push({ block, sub });
    }
  }
  if (found.length === 0) {
    return {
      sheets: [],
      warnings: [{
        file: doc.file, line: at || 1, column: 1, rule: 'stack-matrix', severity: 'warn',
        message: 'Section 5 "Weighted matrix" holds no table: no matrix workbook.',
      }],
    };
  }
  const taken = new Set();
  const sheets = found.map(({ block, sub: heading }, i) => {
    const columns = block.header.map((runs) => plainText(runs).trim());
    const rows = block.rows.map((row) => columns.map((_, c) => plainText(row[c] ?? []).trim()));
    const wanted = heading || (found.length === 1 ? 'Weighted matrix' : `Matrix ${i + 1}`);
    return { name: sheetName(wanted, taken), columns, rows };
  });
  return { sheets, warnings: [] };
}

/**
 * A workbook of plain tables, styled like the plan workbook (title, source line, styled header row, frozen panes,
 * filter), with numbers and dates typed and no formula.
 * @param {{meta: any, source: string, sheets: {name: string, columns: string[], rows: string[][]}[]}} content
 * @param {{theme: any, labels: Record<string,string>}} ctx
 * @returns {Promise<Buffer>}
 */
export async function renderTablesWorkbook({ meta, source, sheets }, { theme, labels }) {
  const font = { name: theme.font.family, size: theme.size.body };
  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta.author || meta.project;
  workbook.title = meta.title;
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet', columns: [], rows: [] }];
  for (const { name, columns, rows } of list) {
    const ws = workbook.addWorksheet(name, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: HEADER_ROW, topLeftCell: `B${FIRST_ROW}`, activeCell: `B${FIRST_ROW}`, showGridLines: false }],
    });
    ws.getCell('A1').value = `${meta.project}${themeStyle(theme).headerSeparator}${name}`;
    ws.getCell('A1').font = { ...font, size: 14, bold: true };
    ws.getCell('A2').value = `${labels.sourceOfTruth} (${source})`;
    ws.getCell('A2').font = { ...font, color: { argb: argb(theme.color.muted) } };
    const widths = columns.map((c) => c.length);
    columns.forEach((text, i) => {
      const cell = ws.getCell(HEADER_ROW, i + 1);
      cell.value = text;
      cell.font = { ...font, bold: true, color: { argb: argb(theme.color.headerText) } };
      cell.fill = solid(theme.color.headerFill);
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    rows.forEach((row, r) => {
      row.forEach((text, i) => {
        const cell = ws.getCell(FIRST_ROW + r, i + 1);
        const { value, numFmt } = cellValue(text, TEXT_COLUMNS.has(norm(columns[i])));
        cell.value = value;
        if (numFmt) cell.numFmt = numFmt;
        cell.font = font;
        cell.alignment = { vertical: 'top', wrapText: true };
        widths[i] = Math.max(widths[i], text.length);
      });
    });
    columns.forEach((_, i) => {
      ws.getColumn(i + 1).width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, widths[i] + 2));
    });
    if (columns.length > 0) {
      ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: Math.max(FIRST_ROW + rows.length - 1, HEADER_ROW), column: columns.length } };
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
