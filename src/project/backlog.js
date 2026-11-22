/**
 * The content of the backlog of a PLAN, as the GitHub board carries it: each story with what the PLAN says of it, and each
 * lot with its name and goal. The PLAN is read in any of the shapes it is written in:
 * - the Backlog table of the template (ID, Lot, Item, Size, Points, Depends on, Sprint, Phase, Status, Comment);
 * - the same table with more columns (Description or User story, Acceptance criteria, Priority, Increment, Estimate);
 * - a `### Story <ID> <title>` block for a story (or `### <ID> <title>`), anywhere in the PLAN, with its text and an
 *   `Acceptance criteria` list.
 * The increment of a story is its Increment cell, or else the increment that ends at the milestone of its sprint.
 */

const STORY_ID = /^[A-Z][A-Z0-9]*-\d{2,3}$/;
const LOT_CODE = /^[A-Z][A-Z0-9]*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

const plain = (s) => String(s ?? '').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

/** The cells of a table row, with `\|` kept as a pipe, or null for a line that is not a row. */
function cells(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const parts = [];
  let start = 1;
  for (let i = 1; i <= t.length; i++) {
    if (i === t.length || (t[i] === '|' && t[i - 1] !== '\\')) {
      parts.push(t.slice(start, i).replace(/\\\|/g, '|').trim());
      start = i + 1;
    }
  }
  if (parts.length > 0 && parts[parts.length - 1] === '' && t.endsWith('|')) parts.pop();
  return parts;
}

/** The lines of a PLAN without its comments and its fenced blocks (kept as empty lines). */
function lines(planText) {
  const out = [];
  let fence = false;
  for (const line of String(planText ?? '').replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, '')).split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fence = !fence;
      out.push('');
      continue;
    }
    out.push(fence ? '' : line);
  }
  return out;
}

/** The H2 sections of a PLAN: title (lower case) to its lines. */
function sections(all) {
  const out = new Map();
  let current = null;
  for (const line of all) {
    const h = /^##\s+(.*?)\s*#*\s*$/.exec(line);
    if (h && !line.startsWith('###')) {
      current = plain(h[1]).toLowerCase().replace(/^\d+\s*[.)]?\s*/, '');
      if (!out.has(current)) out.set(current, []);
      else current = null; // only the first section of a name counts
      continue;
    }
    if (current !== null) out.get(current).push(line);
  }
  return out;
}

/** The first table of some lines: its header (lower case) and its rows. */
function firstTable(part) {
  const rows = [];
  for (const line of part ?? []) {
    const c = cells(line);
    if (c === null) {
      if (rows.length > 0) break;
      continue;
    }
    if (!SEPARATOR.test(line)) rows.push(c);
  }
  if (rows.length === 0) return { header: [], rows: [] };
  return { header: rows[0].map((h) => plain(h).toLowerCase()), rows: rows.slice(1) };
}

/** The column of the first name found, or -1. */
const column = (header, names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;

/** A list of IDs in a cell: `CAT-01, MEM-01` or `CAT-01 and MEM-01`. */
const idList = (text) => (plain(text).match(/[A-Z][A-Z0-9]*-\d{2,3}/g) ?? []);

/** A list in a cell: split on `;`, `<br>` or a new line. */
const cellList = (text) => String(text ?? '').split(/;|<br\s*\/?>|\n/i).map(plain).filter(Boolean);

/**
 * The `### Story <ID> <title>` blocks of a PLAN: ID to `{description, criteria}`. The description is the text of the block before
 * any criteria; the criteria are the items of the list that follows a line or a heading named `Acceptance criteria`.
 */
function storyBlocks(all) {
  const out = new Map();
  let current = null;
  let inCriteria = false;
  for (const line of all) {
    const h = /^(#{2,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = plain(h[2]);
      // `### Story CAT-01 ...` in the template (a heading that starts with the ID would define it a second time in the index).
      const id = /^(?:[Ss]tory\s+)?([A-Z][A-Z0-9]*-\d{2,3})\b/.exec(text)?.[1];
      if (h[1].length === 3 && id !== undefined && STORY_ID.test(id)) {
        current = { description: [], criteria: [] };
        if (!out.has(id)) out.set(id, current);
        else current = null;
        inCriteria = false;
        continue;
      }
      if (current !== null && h[1].length > 3 && /^acceptance criteria\b/i.test(text)) {
        inCriteria = true;
        continue;
      }
      if (h[1].length <= 3) current = null;
      else {
        // Another part of the block (notes, design) stays in its text, with its heading.
        inCriteria = false;
        current?.description.push(line);
      }
      continue;
    }
    if (current === null) continue;
    const label = /^\s*(?:\*\*|__)?acceptance criteria(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*(.*)$/i.exec(line);
    if (label) {
      inCriteria = true;
      if (plain(label[1]) !== '') current.criteria.push(plain(label[1]));
      continue;
    }
    const item = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (inCriteria) {
      if (item) current.criteria.push(plain(item[1]));
      else if (plain(line) !== '' && current.criteria.length > 0 && /^\s{2,}/.test(line)) current.criteria[current.criteria.length - 1] += ` ${plain(line)}`;
      continue;
    }
    current.description.push(line);
  }
  const result = new Map();
  for (const [id, b] of out) {
    const description = b.description.join('\n').replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n');
    result.set(id, { description, criteria: b.criteria });
  }
  return result;
}

/**
 * The `## Lots` table of a PLAN: code to `{name, goal}`. The code column is `Code` (or `ID`, or the first column).
 * @param {string} planText
 * @returns {Map<string, {name: string, goal: string}>}
 */
export function parseLots(planText) {
  const out = new Map();
  const { header, rows } = firstTable(sections(lines(planText)).get('lots'));
  const codeCol = Math.max(0, column(header, ['code', 'id']));
  const nameCol = column(header, ['lot', 'name']);
  const goalCol = column(header, ['goal', 'objective']);
  for (const r of rows) {
    const code = plain(r[codeCol]);
    if (!LOT_CODE.test(code) || out.has(code)) continue;
    out.set(code, { name: nameCol >= 0 ? plain(r[nameCol]) : '', goal: goalCol >= 0 ? plain(r[goalCol]) : '' });
  }
  return out;
}

const SIZE_POINTS = { S: 1, M: 2, L: 3 };

/**
 * The stories of a PLAN with all the PLAN says of each, in the order of the Backlog table.
 * @param {string} planText
 * @returns {{id: string, lot: string, lotName: string, title: string, description: string, criteria: string[], size: string,
 *   points: number|null, priority: string, increment: string, sprint: string, phase: string, dependsOn: string[], comment: string}[]}
 */
export function parseStories(planText) {
  const all = lines(planText);
  const parts = sections(all);
  const { header, rows } = firstTable(parts.get('backlog'));
  if (header.length === 0) return [];
  const col = {
    id: Math.max(0, column(header, ['id'])),
    lot: column(header, ['lot']),
    title: column(header, ['item', 'title', 'story']),
    description: column(header, ['description', 'user story', 'as a']),
    criteria: column(header, ['acceptance criteria', 'acceptance', 'criteria']),
    size: column(header, ['size']),
    points: column(header, ['points', 'estimate', 'story points']),
    priority: column(header, ['priority']),
    increment: column(header, ['increment']),
    sprint: column(header, ['sprint']),
    phase: column(header, ['phase']),
    depends: column(header, ['depends on', 'dependencies', 'depends']),
    comment: column(header, ['comment', 'notes', 'note']),
  };
  // The increment of a sprint: the one that ends at the milestone of that sprint or of the next sprint that has one.
  const sprints = firstTable(parts.get('sprints'));
  const sprintCol = Math.max(0, column(sprints.header, ['sprint']));
  const milestoneCol = column(sprints.header, ['milestone']);
  const increments = firstTable(parts.get('increments'));
  const incIdCol = Math.max(0, column(increments.header, ['id']));
  const endsCol = column(increments.header, ['ends at', 'milestone']);
  const incrementOfSprint = (sprint) => {
    if (milestoneCol < 0 || endsCol < 0 || sprint === '') return '';
    const at = sprints.rows.findIndex((r) => plain(r[sprintCol]) === sprint);
    if (at < 0) return '';
    const milestone = sprints.rows.slice(at).map((r) => plain(r[milestoneCol])).find((m) => m !== '') ?? '';
    return milestone === '' ? '' : plain(increments.rows.find((r) => plain(r[endsCol]) === milestone)?.[incIdCol] ?? '');
  };
  const blocks = storyBlocks(all);
  const get = (r, i) => (i >= 0 ? plain(r[i]) : '');
  const out = [];
  for (const r of rows) {
    const id = plain(r[col.id]);
    if (!STORY_ID.test(id) || out.some((s) => s.id === id)) continue;
    const block = blocks.get(id) ?? { description: '', criteria: [] };
    const size = get(r, col.size).toUpperCase();
    const pointsText = get(r, col.points);
    const points = /^\d+(\.\d+)?$/.test(pointsText) ? Number(pointsText) : (SIZE_POINTS[size] ?? null);
    const priority = get(r, col.priority).toUpperCase();
    const sprint = get(r, col.sprint);
    out.push({
      id,
      lot: id.slice(0, id.lastIndexOf('-')),
      lotName: col.lot !== col.id ? get(r, col.lot) : '',
      title: get(r, col.title),
      description: block.description || get(r, col.description),
      criteria: block.criteria.length > 0 ? block.criteria : (col.criteria >= 0 ? cellList(r[col.criteria]) : []),
      size: /^[SML]$/.test(size) ? size : '',
      points,
      priority: /^P[0-3]$/.test(priority) ? priority : '',
      increment: get(r, col.increment) || incrementOfSprint(sprint),
      sprint,
      phase: get(r, col.phase),
      dependsOn: col.depends >= 0 ? idList(r[col.depends]) : [],
      comment: get(r, col.comment),
    });
  }
  return out;
}

/** The marker that makes an issue the one Recade made for a story. */
export const storyMarker = (id) => `<!-- recade:story ${id} -->`;
const STORY_MARK = /<!-- recade:story ([A-Z][A-Z0-9]*-\d{2,3}) -->/;
/** The story ID of an issue body Recade wrote, or null. */
export const storyOfBody = (body) => STORY_MARK.exec(String(body ?? ''))?.[1] ?? null;

/**
 * The body of the issue of a story: what the PLAN says of it, rebuilt the same way each time.
 * @param {ReturnType<typeof parseStories>[number]} story
 * @param {string} file the PLAN file
 * @param {string} lotName
 */
export function storyBody(story, file, lotName = story.lotName) {
  const out = [storyMarker(story.id), `Backlog story ${story.id} of ${file}, in the lot ${story.lot}${lotName ? ` (${lotName})` : ''}.`];
  if (story.description !== '') out.push('', story.description);
  if (story.criteria.length > 0) out.push('', 'Acceptance criteria:', ...story.criteria.map((c) => `- ${c}`));
  const facts = [];
  if (story.size !== '' || story.points !== null) facts.push(`- Estimate: ${[story.size, story.points === null ? '' : `${story.points} point${story.points === 1 ? '' : 's'}`].filter(Boolean).join(', ')}`);
  if (story.priority !== '') facts.push(`- Priority: ${story.priority}`);
  if (story.increment !== '') facts.push(`- Increment: ${story.increment}`);
  if (story.sprint !== '') facts.push(`- Sprint: ${story.sprint}`);
  if (story.phase !== '') facts.push(`- Phase: ${story.phase}`);
  if (story.dependsOn.length > 0) facts.push(`- Depends on: ${story.dependsOn.join(', ')}`);
  if (story.comment !== '') facts.push(`- Note: ${story.comment}`);
  if (facts.length > 0) out.push('', ...facts);
  return out.join('\n');
}
