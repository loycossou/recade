import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { budgetsOf } from './budgets.js';
import { dollarsOf, modelId, PRICES_SOURCE } from './pricing.js';
import { stageTier } from './models.js';

/**
 * `recade cost estimate`: what a phase, or the delivery of one slice, should cost, before it runs.
 * An estimate is a range built from the constants below, never a measure: `recade cost record` measures a slice.
 * Every assumption is a named constant, so it can be tuned against the measured cost of real projects.
 * A pair is `{ low, high }`: the low figure uses every low value, the high figure every high value.
 */

const pair = (low, high = low) => Object.freeze({ low, high });
const pick = (value, bound) => (typeof value === 'number' ? value : value[bound]);
const BOUNDS = ['low', 'high'];

// ---------------------------------------------------------------------------------------------------------
// Tokens of one run
// ---------------------------------------------------------------------------------------------------------

/** Tokens for one word of prose, in English or French. Code blocks and tables run a little higher. */
export const TOKENS_PER_WORD = 1.4;

/** The system prompt, the tool definitions, the agent file and the skills it loads: read again on every turn, from the cache. */
export const SYSTEM_TOKENS = pair(18000, 24000);

/** The prompt the dispatcher writes: stage, paths, languages, budgets, rules. */
export const PROMPT_TOKENS = 2000;

/** The output of one tool call (a Read, a Bash line, a Write header). The text a Write carries is counted apart. */
export const TOOL_CALL_TOKENS = 150;

/** Fresh input on each turn, after the last cache breakpoint. Everything before it is a cache read. */
export const UNCACHED_INPUT_PER_TURN = 300;

/** The report an agent ends with. */
export const REPORT_WORDS = 400;

/** Thinking tokens on each turn, by effort. Thinking is billed as output. */
export const THINKING_PER_TURN = Object.freeze({ high: pair(600, 1200), medium: pair(300, 600), low: pair(100, 250) });

/**
 * How a run works, by kind: its number of turns, and the new context each turn brings (tool results, files read
 * beyond the documents counted in `reads`, command output, web pages).
 */
export const PROFILES = Object.freeze({
  write: Object.freeze({ turns: pair(18, 30), toolTokens: pair(1200, 2000) }),
  edit: Object.freeze({ turns: pair(8, 15), toolTokens: pair(800, 1500) }),
  review: Object.freeze({ turns: pair(10, 20), toolTokens: pair(1000, 2000) }),
  reply: Object.freeze({ turns: pair(3, 6), toolTokens: pair(600, 1200) }),
  research: Object.freeze({ turns: pair(30, 50), toolTokens: pair(3000, 5000) }),
  spike: Object.freeze({ turns: pair(30, 60), toolTokens: pair(1500, 2500) }),
  code: Object.freeze({ turns: pair(30, 60), toolTokens: pair(2000, 3000) }),
});

// ---------------------------------------------------------------------------------------------------------
// What the runs read and write, in words, beyond the budgets of `src/budgets.js`
// ---------------------------------------------------------------------------------------------------------

/** The intake brief and the gap list the intake-analyst writes. */
export const BRIEF_WORDS = 2500;
/** The questionnaire and the client files the intake-analyst reads. */
export const INTAKE_INPUT_WORDS = pair(2000, 12000);
/** A template of `templates/`, read by the agent that fills it. */
export const TEMPLATE_WORDS = 1500;
/** One doctrine of `team/`, written by a doctrine-writer and read by its role in every run. */
export const DOCTRINE_WORDS = 2000;
/** A review note: at most 10 findings. */
export const REVIEW_NOTE_WORDS = 800;
/** The DEC files an apply-decisions stage reads. */
export const DEC_WORDS = pair(300, 1200);
/** The share of a document a revise round rewrites. */
export const REVISE_SHARE = pair(0.2, 0.4);
/** The share of a document an apply-decisions stage changes. */
export const APPLY_SHARE = pair(0.05, 0.15);
/** The words a format fix (style, index, render) changes. */
export const FIX_WORDS = 300;
/** The share of D1, D2 and their sections that the author drafts; the contributors write the rest. */
export const DRAFT_SHARE = 0.75;
/** The roles of a team when there is no roster yet: the 8 core roles, plus 1 to 3 the project needs. */
export const DEFAULT_ROLES = pair(9, 11);
/** The short track: the 8 core roles, plus a role only for payments, health data or regulated data. */
export const SHORT_ROLES = pair(8, 9);
/** The words of the recruiter's candidates and of its roster. */
export const CANDIDATES_WORDS = 600;
export const ROSTER_WORDS = 1200;
/** The doctrines that fail `recade team check` and are written again. */
export const DOCTRINE_RETRIES = pair(0, 2);
/** The art direction: boards (HTML, counted in words), then the tokens and the theme. */
export const BOARDS = pair(2, 3);
/** The short track offers exactly two directions. */
export const SHORT_BOARDS = pair(2);
export const BOARD_WORDS = 2500;
export const TOKENS_WORDS = 1500;
/** The stack: layers with spikes, finalists spiked per layer, layer stages and the layers the owner answers. */
export const SPIKE_LAYERS = pair(3, 5);
export const FINALISTS = pair(2, 3);
/**
 * The short track decides from the research by default: spikes run only when a layer is close (its two best totals
 * within 10 percent) and the owner then chooses to run them. The estimate counts none.
 */
export const SHORT_SPIKES = pair(0);
/**
 * The short track when the owner chose to run the spikes (`spikes: run` in the state): one or two close layers, two
 * finalists each. A project whose analyst already wrote its tasks counts two finalists for each `spikes/TASK-<layer>.md`.
 */
export const SHORT_SPIKES_RUN = pair(2, 4);
export const SPIKE_RESULT_WORDS = 800;
export const LAYER_STAGES = pair(6, 9);
export const OWNER_LAYERS = 5;
/** The owner's own options in the layer loop, researched with the stage `other`. */
export const OTHER_OPTIONS = pair(0, 2);
/** The companion of a document (`<doc>.story.yaml`): a kicker, a lede, key facts, a recap. One run writes it for every language. */
export const STORY_WORDS = 400;
/** The next increment of the short track: at most 5 slices cut from the backlog, the backlog rewritten. */
export const NEXT_SLICES = pair(3, 5);
/** The slices of a PLAN, and the words of one sheet. */
export const SLICES = pair(12, 25);
/** The short track cuts the first increment only: the walking skeleton and at most 5 slices, the rest in a backlog. */
export const SHORT_SLICES = pair(4, 6);
/** The backlog of the short track: one line for each later slice. */
export const BACKLOG_WORDS = 300;
export const SHEET_WORDS = 600;
/** The text each role replies with when it specialises the harness. */
export const HARNESS_REPLY_WORDS = 500;
/** What the delivery agents of a slice read and write in code, in tokens. */
export const SLICE_SPEC_WORDS = Object.freeze({ standard: 800, sensitive: 2000 });
export const SLICE_CODE_READ_TOKENS = pair(20000, 50000);
export const SLICE_TESTS_TOKENS = pair(3000, 8000);
export const SLICE_CODE_TOKENS = pair(6000, 15000);
/** The short track sends a document back to its author only for a blocker: its revise round may not run. */
export const SHORT_REVISE = pair(0, 1);
/** FIX loops of a slice: the implementer and the reviewer run again. */
export const FIX_LOOPS = pair(0, 2);

/** The phases the estimate knows, in order, with the gates that end each one. */
export const ESTIMATE_PHASES = Object.freeze([
  Object.freeze({ id: 'intake', name: 'Intake', command: 'new', gates: Object.freeze(['G0']) }),
  Object.freeze({ id: 'team', name: 'Team', command: 'team', gates: Object.freeze(['G1']) }),
  Object.freeze({ id: 'docs', name: 'Documents', command: 'docs', gates: Object.freeze(['G2-stack', 'G2']) }),
  Object.freeze({ id: 'bible', name: 'Bible', command: 'bible', gates: Object.freeze(['G3']) }),
  Object.freeze({ id: 'slices', name: 'Slices', command: 'slices', gates: Object.freeze(['G4']) }),
  Object.freeze({ id: 'harness', name: 'Harness', command: 'harness', gates: Object.freeze(['G5']) }),
]);
export const PHASE_IDS = Object.freeze(ESTIMATE_PHASES.map((p) => p.id));
/**
 * Estimates asked by name only, never part of the list of phases left: the next increment of the short track, cut by
 * `/recade:slices` with the stage `next` once G4 is passed.
 */
export const EXTRA_ESTIMATES = Object.freeze([
  Object.freeze({ id: 'next', name: 'Next increment', command: 'slices', gates: Object.freeze([]) }),
]);
export const ESTIMATE_IDS = Object.freeze([...PHASE_IDS, ...EXTRA_ESTIMATES.map((p) => p.id)]);

/**
 * The spikes the stack step counts: none when the owner chose to decide from the research (`spikes: none`); in the
 * short track, none by default and SHORT_SPIKES_RUN (or two for each task already written) when the owner chose to
 * run them; in the full track, every finalist of the layers with a choice.
 */
export function spikesOf(facts) {
  if (facts.spikes === 'none') return pair(0);
  const tasks = facts.spikeTasks ?? 0;
  if (facts.track === 'short') {
    if (facts.spikes !== 'run') return SHORT_SPIKES;
    return tasks > 0 ? pair(2 * tasks) : SHORT_SPIKES_RUN;
  }
  return tasks > 0 ? scale(pair(tasks), FINALISTS) : scale(SPIKE_LAYERS, FINALISTS);
}
export const SLICE_LANES = Object.freeze(['standard', 'sensitive']);

// ---------------------------------------------------------------------------------------------------------
// The runs of each phase, from what the commands dispatch
// ---------------------------------------------------------------------------------------------------------

/**
 * One kind of agent run. `writes` and `reads` are words, `writeTokens` and `readTokens` tokens (for code); each may be a
 * number or a pair. `count` is how many times it runs. `tier` is `writer`, `mechanical`, or `lane` for a harness agent.
 * @typedef {{agent: string, stage: string, profile: string, count: any, writes?: any, reads?: any, writeTokens?: any, readTokens?: any, tier: string}} Run
 */

const scale = (value, factor) => (typeof value === 'number' && typeof factor === 'number' ? value * factor
  : pair(pick(value, 'low') * pick(factor, 'low'), pick(value, 'high') * pick(factor, 'high')));
const sum = (...values) => pair(...BOUNDS.map((b) => values.reduce((n, v) => n + pick(v, b), 0)));

/** A framing run: its tier follows MECHANICAL_STAGES (`fix` stands for a revise sent back for a format finding). */
const framing = (agent, stage, profile, { count = 1, writes = 0, reads = 0 } = {}) =>
  ({ agent, stage, profile, count, writes, reads, tier: stageTier(agent, stage) });

/**
 * The runs around one document: draft, contributions, one review, one revise round (0 to 1 in the short track, which
 * revises only for a blocker), a second round when a blocker remains, the decisions applied, the format fixes and a
 * cut when it is over budget.
 */
function documentRuns(doc, budget, author, { draft = 'draft', reviewer, reads, contributors = [], short = false }) {
  const runs = [];
  const share = contributors.length > 0 ? DRAFT_SHARE : 1;
  runs.push(framing(author, draft, 'write', { writes: budget * share, reads: sum(reads, TEMPLATE_WORDS, DOCTRINE_WORDS) }));
  for (const c of contributors) {
    runs.push(framing(c.agent, 'contribute', 'write', { count: c.count ?? 1, writes: (budget * (1 - DRAFT_SHARE)) / contributors.length, reads: budget + DOCTRINE_WORDS }));
  }
  runs.push(framing(reviewer, 'review', 'review', { writes: REVIEW_NOTE_WORDS, reads: sum(budget, reads, DOCTRINE_WORDS) }));
  runs.push(framing(author, 'revise', 'edit', { count: short ? SHORT_REVISE : 1, writes: scale(budget, REVISE_SHARE), reads: budget + REVIEW_NOTE_WORDS + DOCTRINE_WORDS }));
  if (contributors.length > 0) runs.push(framing(contributors[0].agent, 'revise', 'edit', { count: pair(0, 1), writes: scale(budget * (1 - DRAFT_SHARE), REVISE_SHARE), reads: budget + REVIEW_NOTE_WORDS }));
  runs.push(framing(author, 'revise', 'edit', { count: pair(0, 1), writes: scale(budget, 0.1), reads: budget + REVIEW_NOTE_WORDS }));
  runs.push(framing(author, 'apply-decisions', 'edit', { writes: scale(budget, APPLY_SHARE), reads: sum(budget, DEC_WORDS) }));
  runs.push(framing(author, 'fix', 'edit', { count: pair(0, 2), writes: FIX_WORDS, reads: budget }));
  runs.push(framing(author, 'revise', 'edit', { count: pair(0, 1), writes: scale(budget, 0.3), reads: budget }));
  // The step of the documents phase each run belongs to, for the durations: `d1`, `d2`, `d3` or `plan`.
  return runs.map((r) => ({ ...r, step: doc.toLowerCase() }));
}

/** The runs of one phase for the facts of a project. */
function phaseRuns(phase, facts) {
  const B = facts.budgets;
  const domain = facts.domainExpert;
  const roles = facts.roles;
  const short = facts.track === 'short';
  switch (phase) {
    case 'intake':
      return [framing('intake-analyst', 'analysis', 'write', { count: pair(1, 2), writes: BRIEF_WORDS, reads: sum(INTAKE_INPUT_WORDS, TEMPLATE_WORDS) })];
    case 'team':
      return [
        framing('recruiter', 'candidates', 'research', { writes: CANDIDATES_WORDS, reads: BRIEF_WORDS }),
        framing('recruiter', 'roster', 'research', { writes: ROSTER_WORDS, reads: BRIEF_WORDS + CANDIDATES_WORDS }),
        framing('doctrine-writer', 'doctrine', 'research', { count: sum(roles, DOCTRINE_RETRIES), writes: DOCTRINE_WORDS, reads: BRIEF_WORDS + TEMPLATE_WORDS }),
      ];
    case 'docs': {
      const t = facts.translations;
      // The short track: two boards, a revise only for a blocker, spikes only for a close layer, the architect's opinion alone.
      const boards = short ? SHORT_BOARDS : BOARDS;
      const spikes = spikesOf(facts);
      const opinions = short ? 1 : 2;
      const d1Reviewer = domain.high > 0 && domain.low > 0 ? 'domain-expert' : 'architect';
      const runs = [
        ...documentRuns('D1', B.D1, 'project-lead', {
          draft: 'draft-d1', reviewer: d1Reviewer, reads: BRIEF_WORDS, short,
          contributors: [{ agent: 'ux-designer' }, { agent: 'domain-expert', count: domain }],
        }),
        framing('project-lead', 'glossary', 'edit', { writes: 200, reads: B.D1 }),
        framing('ui-designer', 'directions', 'write', { writes: scale(BOARD_WORDS, boards), reads: B.D1 + BRIEF_WORDS + DOCTRINE_WORDS }),
        framing('ux-designer', 'review', 'review', { writes: REVIEW_NOTE_WORDS, reads: scale(BOARD_WORDS, boards) }),
        framing('ui-designer', 'revise', 'edit', { count: short ? SHORT_REVISE : pair(1, 2), writes: scale(BOARD_WORDS, REVISE_SHARE), reads: scale(BOARD_WORDS, boards) }),
        framing('ui-designer', 'tokens', 'edit', { writes: TOKENS_WORDS, reads: BOARD_WORDS }),
        framing('stack-analyst', 'layers', 'reply', { writes: 300, reads: B.D1 + BRIEF_WORDS }),
        framing('stack-analyst', 'draft', 'research', { writes: B.STACK * 0.5, reads: B.D1 + BRIEF_WORDS + TEMPLATE_WORDS }),
        { agent: 'spike-runner', stage: 'spike', profile: 'spike', count: spikes, writes: SPIKE_RESULT_WORDS, reads: 500, tier: 'mechanical' },
        framing('stack-analyst', 'matrix', 'edit', { writes: B.STACK * 0.2, reads: sum(B.STACK * 0.5, scale(SPIKE_RESULT_WORDS, spikes)) }),
        framing('architect', 'review', 'review', { writes: REVIEW_NOTE_WORDS, reads: B.STACK + B.D1 + DOCTRINE_WORDS }),
        framing('devops-lead', 'review', 'review', { count: short ? 0 : 1, writes: REVIEW_NOTE_WORDS, reads: B.STACK + B.D1 + DOCTRINE_WORDS }),
        framing('stack-analyst', 'opinions', 'edit', { writes: 400, reads: B.STACK + opinions * REVIEW_NOTE_WORDS }),
        framing('stack-analyst', 'layer', 'reply', { count: LAYER_STAGES, writes: 500, reads: B.STACK }),
        framing('stack-analyst', 'decide', 'reply', { count: OWNER_LAYERS, writes: 300, reads: B.STACK }),
        framing('stack-analyst', 'other', 'research', { count: OTHER_OPTIONS, writes: 500, reads: B.STACK }),
        framing('stack-analyst', 'apply-decisions', 'edit', { count: pair(1, 2), writes: B.STACK * 0.3, reads: B.STACK }),
        framing('doctrine-writer', 'doctrine', 'research', { count: pair(0, 1), writes: DOCTRINE_WORDS, reads: TEMPLATE_WORDS }),
        ...documentRuns('D2', B.D2, 'architect', {
          reviewer: 'security-lead', reads: B.D1 + B.STACK, short,
          contributors: [{ agent: 'devops-lead' }],
        }),
        ...documentRuns('D3', B.D3, 'security-lead', { reviewer: 'architect', reads: B.D1 + B.D2, short }),
        framing('architect', 'link', 'edit', { writes: 300, reads: B.D2 + B.D3 }),
        framing('security-lead', 'contribute', 'edit', { writes: B.D2 * 0.1, reads: B.D2 + B.D3 }),
        ...documentRuns('PLAN', B.PLAN, 'project-lead', { draft: 'draft-plan', reviewer: 'architect', reads: B.D1 + B.D2 + B.D3 + B.STACK, short }),
        framing('stack-analyst', 'revise', 'edit', { count: pair(0, 1), writes: B.STACK * 0.1, reads: B.STACK + B.D2 }),
      ];
      if (t > 0) {
        runs.push(
          framing('project-lead', 'translate', 'edit', { count: 2 * t, writes: (B.D1 + B.PLAN) / 2, reads: (B.D1 + B.PLAN) / 2 }),
          framing('architect', 'translate', 'edit', { count: t, writes: B.D2, reads: B.D2 }),
          framing('security-lead', 'translate', 'edit', { count: t, writes: B.D3, reads: B.D3 }),
        );
      }
      // The companions of Step 9, on the mechanical model: one run for each document, its translations included.
      runs.push(
        framing('project-lead', 'story', 'edit', { count: 2, writes: STORY_WORDS * (1 + t), reads: (B.D1 + B.PLAN) / 2 }),
        framing('architect', 'story', 'edit', { writes: STORY_WORDS * (1 + t), reads: B.D2 }),
        framing('security-lead', 'story', 'edit', { writes: STORY_WORDS * (1 + t), reads: B.D3 }),
      );
      return runs;
    }
    case 'bible': {
      const all = B.D1 + B.D2 + B.D3 + B.STACK + B.PLAN;
      const runs = [
        framing('bible-writer', 'draft', 'write', { writes: B.BIBLE, reads: all + TEMPLATE_WORDS + 2 * DOCTRINE_WORDS }),
        framing('bible-writer', 'plan', 'edit', { writes: B.PLAN * 0.3, reads: B.BIBLE + B.PLAN }),
        framing('chief-reviewer', 'review', 'review', { writes: REVIEW_NOTE_WORDS, reads: B.BIBLE + B.PLAN + DOCTRINE_WORDS }),
        framing('bible-writer', 'revise', 'edit', { count: short ? SHORT_REVISE : 1, writes: scale(B.BIBLE, REVISE_SHARE), reads: B.BIBLE + REVIEW_NOTE_WORDS }),
        framing('bible-writer', 'revise', 'edit', { count: pair(0, 1), writes: B.BIBLE * 0.1, reads: B.BIBLE + REVIEW_NOTE_WORDS }),
        framing('bible-writer', 'apply-decisions', 'edit', { count: pair(1, 2), writes: scale(B.BIBLE, APPLY_SHARE), reads: sum(B.BIBLE + B.PLAN, DEC_WORDS) }),
        framing('bible-writer', 'fix', 'edit', { count: pair(0, 2), writes: FIX_WORDS, reads: B.BIBLE }),
      ];
      if (facts.translations > 0) runs.push(framing('bible-writer', 'translate', 'edit', { count: facts.translations, writes: B.PLAN, reads: B.PLAN }));
      // The companions of the BIBLE and of the PLAN, in one run on the mechanical model.
      runs.push(framing('bible-writer', 'story', 'edit', { writes: STORY_WORDS * (2 + facts.translations), reads: B.BIBLE + B.PLAN }));
      return runs;
    }
    case 'slices': {
      const sheets = scale(SHEET_WORDS, short ? SHORT_SLICES : SLICES);
      return [
        framing('slicer', 'cut', 'write', { writes: short ? sum(sheets, BACKLOG_WORDS) : sheets, reads: B.PLAN + B.BIBLE + B.D1 + B.D2 + B.D3 + B.STACK + TEMPLATE_WORDS }),
        framing('slicer', 'revise', 'edit', { count: pair(0, 2), writes: scale(sheets, 0.2), reads: sum(sheets, B.PLAN) }),
      ];
    }
    case 'next': {
      // The next increment: the slicer cuts it from the backlog with the stage `next`, then the checks loop.
      const sheets = scale(SHEET_WORDS, NEXT_SLICES);
      const existing = scale(SHEET_WORDS, SHORT_SLICES);
      return [
        framing('slicer', 'next', 'write', { writes: sum(sheets, BACKLOG_WORDS), reads: sum(B.PLAN + B.BIBLE + B.D1 + B.D2 + B.D3 + B.STACK + TEMPLATE_WORDS + BACKLOG_WORDS, existing) }),
        framing('slicer', 'revise', 'edit', { count: pair(0, 2), writes: scale(sheets, 0.2), reads: sum(sheets, B.PLAN) }),
      ];
    }
    case 'harness': {
      const replies = 4 + (domain.low > 0 ? 1 : 0);
      return [
        framing('team', 'harness', 'edit', { count: pair(replies, 4 + domain.high), writes: HARNESS_REPLY_WORDS, reads: B.BIBLE + B.D2 + DOCTRINE_WORDS }),
        framing('team', 'harness', 'edit', { count: pair(0, 2), writes: HARNESS_REPLY_WORDS, reads: B.BIBLE + DOCTRINE_WORDS }),
      ];
    }
    default:
      throw new Error(`Unknown phase: ${phase}. Use ${ESTIMATE_IDS.join(', ')}.`);
  }
}

/** The runs of the delivery of one slice in a lane, after the chain of `harness/protocol.md`. */
function sliceRuns(lane, secondOpinion) {
  const code = SLICE_CODE_READ_TOKENS;
  const agent = (name, profile, extra) => ({ agent: name, stage: lane, profile, count: 1, tier: 'lane', readTokens: code, ...extra });
  const screen = pair(0, 1);
  const second = secondOpinion === 'off' ? 0 : secondOpinion === 'always' || lane === 'sensitive' ? 1 : pair(0, 1);
  const implementer = lane === 'sensitive' ? 'implementer-critical' : 'implementer';
  const runs = [];
  if (lane === 'sensitive') {
    runs.push(agent('ux-designer', 'write', { count: screen, writes: 1500, readTokens: 5000 }));
    runs.push(agent('ui-designer', 'write', { count: screen, writes: 1500, readTokens: 5000 }));
  }
  runs.push(agent('spec-writer', 'review', { writes: SLICE_SPEC_WORDS[lane], readTokens: 8000 }));
  if (lane === 'sensitive') runs.push(agent('domain-reviewer', 'review', { writes: REVIEW_NOTE_WORDS, readTokens: 8000 }));
  runs.push(agent('test-engineer', 'code', { writeTokens: SLICE_TESTS_TOKENS }));
  runs.push(agent(implementer, 'code', { writeTokens: SLICE_CODE_TOKENS }));
  runs.push(agent('reviewer', 'code', { writes: REVIEW_NOTE_WORDS }));
  if (lane === 'sensitive') runs.push(agent('security-reviewer', 'code', { writes: REVIEW_NOTE_WORDS }));
  runs.push(agent('design-reviewer', 'review', { count: screen, writes: REVIEW_NOTE_WORDS }));
  runs.push(agent('product-reviewer', 'review', { count: screen, writes: REVIEW_NOTE_WORDS }));
  runs.push(agent('doc-writer', 'edit', { writes: 500, readTokens: 10000 }));
  runs.push(agent('release-manager', 'edit', { writes: 300, readTokens: 5000 }));
  runs.push(agent('second-opinion', 'code', { count: second, writes: REVIEW_NOTE_WORDS }));
  runs.push(agent(implementer, 'code', { count: FIX_LOOPS, writeTokens: scale(SLICE_CODE_TOKENS, 0.3) }));
  runs.push(agent('reviewer', 'code', { count: FIX_LOOPS, writes: REVIEW_NOTE_WORDS }));
  return runs;
}

// ---------------------------------------------------------------------------------------------------------
// Pricing the runs
// ---------------------------------------------------------------------------------------------------------

/**
 * The tokens of one run, by kind. The context builds up over the turns: each new piece (a document read, a tool
 * result, what the agent wrote) is written to the cache once and read back on every later turn.
 * @returns {{input: number, output: number, cacheWrite: number, cacheRead: number}}
 */
export function runTokens(run, effort, bound) {
  const profile = PROFILES[run.profile];
  const turns = pick(profile.turns, bound);
  const base = pick(SYSTEM_TOKENS, bound) + PROMPT_TOKENS;
  const reads = pick(run.reads ?? 0, bound) * TOKENS_PER_WORD + pick(run.readTokens ?? 0, bound);
  const written = pick(run.writes ?? 0, bound) * TOKENS_PER_WORD + pick(run.writeTokens ?? 0, bound) + REPORT_WORDS * TOKENS_PER_WORD;
  const tools = turns * pick(profile.toolTokens, bound);
  const calls = turns * TOOL_CALL_TOKENS;
  const added = reads + tools + written + calls;
  return {
    input: turns * UNCACHED_INPUT_PER_TURN,
    output: written + calls + turns * pick(THINKING_PER_TURN[effort] ?? THINKING_PER_TURN.high, bound),
    cacheWrite: base + added,
    cacheRead: turns * base + (added * turns) / 2,
  };
}

/** The model and effort a run runs on. */
function modelOf(run, ctx) {
  if (run.tier === 'lane') {
    const entry = ctx.harnessModels?.agents?.[run.agent]?.[run.stage];
    if (entry === undefined) throw new Error(`harness/models.yaml has no ${run.stage} lane for ${run.agent}.`);
    return { model: modelId(entry.model), effort: entry.effort };
  }
  if (run.tier === 'mechanical') return { model: modelId(ctx.tiers.mechanical.model), effort: ctx.tiers.mechanical.effort };
  return { model: modelId(ctx.writer), effort: ctx.tiers.writer.effort };
}

/** Price a list of runs: the number of runs and the dollars, low and high, and one line per kind of run. */
function priceRuns(runs, ctx) {
  const runsCount = { low: 0, high: 0 };
  const dollars = { low: 0, high: 0 };
  const items = [];
  for (const run of runs) {
    const { model, effort } = modelOf(run, ctx);
    const item = { agent: run.agent, stage: run.stage, model, effort, runs: {}, dollars: {} };
    for (const b of BOUNDS) {
      const count = pick(run.count, b);
      const cost = count === 0 ? 0 : count * dollarsOf(model, runTokens(run, effort, b));
      item.runs[b] = count;
      item.dollars[b] = cost;
      runsCount[b] += count;
      dollars[b] += cost;
    }
    if (item.runs.high > 0) items.push(item);
  }
  return { runs: runsCount, dollars, items };
}

/**
 * Round a figure for the owner: the low one down, the high one up, to a step that grows with the figure.
 * @param {number} value
 * @param {'down'|'up'} way
 */
export function roundDollars(value, way) {
  const step = value < 2 ? 0.1 : value < 20 ? 1 : value < 200 ? 5 : 10;
  const n = (way === 'down' ? Math.floor(value / step + 1e-9) : Math.ceil(value / step - 1e-9)) * step;
  return Math.round(n * 100) / 100;
}

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const runsText = (r) => (r.low === r.high ? `${r.low} agent run${r.low === 1 ? '' : 's'}` : `${r.low} to ${r.high} agent runs`);

/** One line: "about $12 to $30, 14 to 18 agent runs", or "about $12 to $30 and 1 to 2 hours, 14 to 18 agent runs" with a duration. */
export function formatRange(entry) {
  const time = entry.minutes === undefined ? '' : ` and ${formatDuration(entry.minutes)}`;
  return `about ${money(entry.rounded.low)} to ${money(entry.rounded.high)}${time}, ${runsText(entry.runs)}`;
}

const finish = (priced) => ({
  ...priced,
  dollars: { low: Math.round(priced.dollars.low * 100) / 100, high: Math.round(priced.dollars.high * 100) / 100 },
  rounded: { low: roundDollars(priced.dollars.low, 'down'), high: roundDollars(priced.dollars.high, 'up') },
});

// ---------------------------------------------------------------------------------------------------------
// Facts of a project
// ---------------------------------------------------------------------------------------------------------

/** The roles of `team/roster.md`, from the first cell of each row of its table, or null when there is no roster. */
export function rosterRoles(root) {
  const path = join(root, 'team', 'roster.md');
  if (!existsSync(path)) return null;
  const roles = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*`?([a-z0-9]+(?:-[a-z0-9]+)*)`?\s*\|(.*)$/.exec(line);
    if (m === null) continue;
    roles.push({ role: m[1], domain: m[1] === 'domain-expert' || /domain expert/i.test(m[2]) });
  }
  return roles.length > 0 ? roles : null;
}

/**
 * The facts the estimate reads from a project: track, budgets, team size, domain expert, translations, second opinion.
 * @param {string|null} root
 * @param {object|null} state
 * @param {{deliverables?: string[]}} [fallback] the languages of the user config when the state has none
 */
export function projectFacts(root, state, fallback = {}) {
  const roster = root === null ? null : rosterRoles(root);
  const deliverables = state?.languages?.deliverables ?? fallback.deliverables ?? ['en'];
  const hasDomain = roster?.some((r) => r.domain) ? 1 : 0;
  const track = state?.track === 'short' ? 'short' : 'full';
  return {
    track,
    budgets: budgetsOf(state),
    roles: roster === null ? (track === 'short' ? SHORT_ROLES : DEFAULT_ROLES) : pair(roster.length),
    domainExpert: roster === null ? pair(0, 1) : pair(hasDomain),
    translations: Math.max(0, (Array.isArray(deliverables) ? deliverables.length : 1) - 1),
    secondOpinion: state?.second_opinion ?? 'sensitive',
    spikes: state?.spikes === 'run' || state?.spikes === 'none' ? state.spikes : null,
    spikeTasks: root === null ? 0 : spikeTasksOf(root),
    fromRoster: roster !== null,
  };
}

/** The tasks of the spikes the analyst wrote, `spikes/TASK-<layer>.md`: 0 when there is none yet. */
function spikeTasksOf(root) {
  try {
    return readdirSync(join(root, 'spikes')).filter((n) => /^TASK-[^/]+\.md$/.test(n)).length;
  } catch {
    return 0;
  }
}

/** True when every gate of the phase is passed in the state. */
const passed = (state, phase) => phase.gates.every((g) => typeof state?.gates?.[g]?.passed === 'string');

/**
 * Estimate phases of a project.
 * @param {object} facts from projectFacts
 * @param {object|null} state
 * @param {{writer: string, tiers: {writer: {effort: string}, mechanical: {model: string, effort: string}}, phases?: string[]}} ctx
 */
export function estimatePhases(facts, state, ctx) {
  let ids = ctx.phases;
  if (ids === undefined) {
    ids = ESTIMATE_PHASES.filter((p) => !passed(state, p) && !(p.id === 'intake' && state?.mode === 'adopt')).map((p) => p.id);
  }
  const phases = ids.map((id) => {
    const phase = [...ESTIMATE_PHASES, ...EXTRA_ESTIMATES].find((p) => p.id === id);
    if (phase === undefined) throw new Error(`Unknown phase: ${id}. Use ${ESTIMATE_IDS.join(', ')}.`);
    return { phase: id, name: phase.name, ...finish(priceRuns(phaseRuns(id, facts), ctx)), ...phaseDuration(id, facts) };
  });
  const total = finish({
    runs: { low: phases.reduce((n, p) => n + p.runs.low, 0), high: phases.reduce((n, p) => n + p.runs.high, 0) },
    dollars: { low: phases.reduce((n, p) => n + p.dollars.low, 0), high: phases.reduce((n, p) => n + p.dollars.high, 0) },
  });
  const minutes = roundPair({ low: phases.reduce((n, p) => n + p.minutes.low, 0), high: phases.reduce((n, p) => n + p.minutes.high, 0) });
  return { estimate: true, prices: PRICES_SOURCE, writer: ctx.writer, phases, total: { runs: total.runs, dollars: total.dollars, rounded: total.rounded, minutes } };
}

/**
 * Estimate the delivery of one slice in a lane, with the models of `harness/models.yaml`.
 * @param {'standard'|'sensitive'} lane
 * @param {{harnessModels: object, secondOpinion?: string}} ctx
 */
export function estimateSlice(lane, ctx) {
  if (!SLICE_LANES.includes(lane)) throw new Error(`Unknown lane: ${lane}. Use ${SLICE_LANES.join(' or ')}.`);
  const priced = finish(priceRuns(sliceRuns(lane, ctx.secondOpinion ?? 'sensitive'), ctx));
  return { estimate: true, prices: PRICES_SOURCE, slice: lane, ...priced };
}

// ---------------------------------------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------------------------------------

/**
 * Wall-clock minutes of each step in a real short-track framing (trust mode, 57 agent runs, the owner's answers
 * included): the reference every duration scales from. The stack step of that trial ran 3 spikes. The harness was not
 * part of the trial: its figure is an assumption until a project measures it.
 */
export const TRIAL_MINUTES = Object.freeze({
  intake: 10, team: 14, d1: 25, direction: 29, stack: 114, d2: 42, d3: 43, plan: 23, gate: 17, bible: 27, slices: 28, harness: 30,
  // Not measured: the cut, the checks and the issues of the slices phase, with no formula to choose.
  next: 21,
});
export const TRIAL_SPIKES = 3;
/** The minutes of one spike in the trial, run one after the other, and of what any spike needs once: the sentence, the room check, the cleanup. */
export const SPIKE_MINUTES = pair(4, 5);
export const SPIKE_SETUP_MINUTES = 5;
/**
 * The stack step without its spikes: the layers, the research, the matrix, the opinions and the owner's answers. The
 * trial's 114 minutes held 3 spikes of about 4.5 minutes each and their setup.
 */
export const STACK_RESEARCH_MINUTES = TRIAL_MINUTES.stack - TRIAL_SPIKES * ((SPIKE_MINUTES.low + SPIKE_MINUTES.high) / 2) - SPIKE_SETUP_MINUTES;
/** The full track writes and reads documents twice as long: each run takes longer, on top of the extra runs. */
export const FULL_TRACK_TIME = 1.3;
/** The range around the scaled measure: the owner's pace, the machine, a retry. */
export const DURATION_SPREAD = pair(0.85, 1.2);
/**
 * How much of a step's time follows its number of runs. The rest (the owner reading and answering, the checks, the
 * commits) stays: twice the runs is 1.4 times the minutes.
 */
export const RUN_WEIGHT = 0.4;
/** The minutes of one agent run in a step the trial ran with no agent (the translations of the render step). */
export const MINUTES_PER_RUN = 5;

/**
 * The steps of a phase as its command numbers them in its progress lines. The documents phase was measured step by
 * step; the other phases split their measure by `share`, an assumption. Intake and harness have no progress line.
 */
export const PHASE_STEPS = Object.freeze({
  team: Object.freeze([
    { id: 'lead', step: 3, of: 7, name: 'the project lead', share: 0.2 },
    { id: 'roster', step: 4, of: 7, name: 'the roster', share: 0.2 },
    { id: 'doctrines', step: 5, of: 7, name: 'the doctrines', share: 0.45 },
    { id: 'check', step: 6, of: 7, name: 'the check', share: 0.05 },
    { id: 'gate', step: 7, of: 7, name: 'the review and G1', share: 0.1 },
  ]),
  docs: Object.freeze([
    { id: 'd1', step: 3, of: 9, name: 'D1' },
    { id: 'direction', step: 4, of: 9, name: 'the art direction' },
    { id: 'stack', step: 5, of: 9, name: 'the stack decision' },
    { id: 'd2', step: 6, of: 9, name: 'D2' },
    { id: 'd3', step: 7, of: 9, name: 'D3' },
    { id: 'plan', step: 8, of: 9, name: 'the PLAN' },
    { id: 'gate', step: 9, of: 9, name: 'render and G2' },
  ]),
  bible: Object.freeze([
    { id: 'bible', step: 3, of: 9, name: 'the BIBLE', share: 0.35 },
    { id: 'plan', step: 4, of: 9, name: 'the PLAN', share: 0.15 },
    { id: 'review', step: 5, of: 9, name: 'the review', share: 0.15 },
    { id: 'decisions', step: 6, of: 9, name: 'the open decisions', share: 0.15 },
    { id: 'translate', step: 7, of: 9, name: 'the translations', share: 0.05 },
    { id: 'checks', step: 8, of: 9, name: 'the checks and the ID index', share: 0.05 },
    { id: 'gate', step: 9, of: 9, name: 'render and G3', share: 0.1 },
  ]),
  next: Object.freeze([
    { id: 'cut', step: 3, of: 6, name: 'the cut', share: 0.6 },
    { id: 'checks', step: 4, of: 6, name: 'the checks', share: 0.2 },
    { id: 'graph', step: 5, of: 6, name: 'the graph and the status', share: 0.05 },
    { id: 'issues', step: 6, of: 6, name: 'the issues of the new slices', share: 0.15 },
  ]),
  slices: Object.freeze([
    { id: 'formula', step: 2, of: 6, name: 'the slicing formula', share: 0.1 },
    { id: 'cut', step: 3, of: 6, name: 'the cut', share: 0.5 },
    { id: 'checks', step: 4, of: 6, name: 'the checks', share: 0.15 },
    { id: 'graph', step: 5, of: 6, name: 'the graph and the status', share: 0.05 },
    { id: 'gate', step: 6, of: 6, name: 'G4', share: 0.2 },
  ]),
});

/** The step of the documents phase a run belongs to. `documentRuns` tags its own runs. */
function docsStepOf(run) {
  if (run.step !== undefined) return run.step;
  if (run.stage === 'translate' || run.stage === 'story') return 'gate';
  if (run.agent === 'ui-designer' || (run.agent === 'ux-designer' && run.stage === 'review')) return 'direction';
  if (run.agent === 'project-lead' && run.stage === 'glossary') return 'd1';
  if ((run.agent === 'architect' && run.stage === 'link') || (run.agent === 'security-lead' && run.stage === 'contribute')) return 'd3';
  if (run.agent === 'stack-analyst' && run.stage === 'revise') return 'plan';
  return 'stack';
}

/** The runs of a list, low and high. */
const countRuns = (runs) => pair(...BOUNDS.map((b) => runs.reduce((n, r) => n + pick(r.count, b), 0)));

/** The runs of each unit the trial measured: the steps of the documents phase, or the whole phase. */
function measuredUnits(phase, facts) {
  const runs = phaseRuns(phase, facts);
  if (phase !== 'docs') return { [phase]: { all: countRuns(runs), spikes: pair(0) } };
  const units = {};
  for (const { id } of PHASE_STEPS.docs) {
    const mine = runs.filter((r) => docsStepOf(r) === id);
    units[id] = { all: countRuns(mine), spikes: countRuns(mine.filter((r) => r.agent === 'spike-runner')) };
  }
  return units;
}

/**
 * The facts of the trial: short track, no roster yet, documents in one language. Its 57 runs sit at the low count of
 * the model for those facts (no revise round, no retry), plus its 3 spikes, counted apart: that low count is the reference.
 */
const TRIAL_FACTS = () => projectFacts(null, { track: 'short' });

/**
 * Minutes, low and high, of each measured unit of a phase: the trial's minutes, scaled by the runs of this project
 * against the runs of the trial with RUN_WEIGHT, by the track, and spread.
 */
function unitMinutes(phase, facts) {
  const reference = measuredUnits(phase, TRIAL_FACTS());
  const units = measuredUnits(phase, facts);
  const track = facts.track === 'short' ? 1 : FULL_TRACK_TIME;
  const out = {};
  for (const [id, unit] of Object.entries(units)) {
    const ref = reference[id];
    // The spikes are timed apart: the rest of the step scales with its own runs.
    const refRuns = ref.all.low - ref.spikes.low;
    const measured = id === 'stack' ? STACK_RESEARCH_MINUTES : TRIAL_MINUTES[id];
    out[id] = pair(...BOUNDS.map((b) => {
      const runs = unit.all[b] - unit.spikes[b];
      const scaled = refRuns > 0 ? measured * (1 + RUN_WEIGHT * (runs / refRuns - 1)) : measured + runs * MINUTES_PER_RUN;
      const spikes = unit.spikes[b] > 0 ? unit.spikes[b] * SPIKE_MINUTES[b] + SPIKE_SETUP_MINUTES : 0;
      return scaled * track * DURATION_SPREAD[b] + spikes;
    }));
  }
  return out;
}

/**
 * Round a duration for the owner: the low figure down, the high one up, to 5 minutes under an hour and to half an
 * hour above.
 * @param {number} minutes
 * @param {'down'|'up'} way
 */
export function roundMinutes(minutes, way) {
  const step = minutes < 60 ? 5 : 30;
  const n = way === 'down' ? Math.floor(minutes / step + 1e-9) * step : Math.ceil(minutes / step - 1e-9) * step;
  return Math.max(5, n);
}

const roundPair = (p) => ({ low: roundMinutes(p.low, 'down'), high: roundMinutes(p.high, 'up') });

/** The duration of a phase and of each of its steps, rounded: `{minutes, steps?}`. */
function phaseDuration(phase, facts) {
  const units = unitMinutes(phase, facts);
  const steps = PHASE_STEPS[phase];
  if (phase === 'docs') {
    const total = pair(...BOUNDS.map((b) => Object.values(units).reduce((n, u) => n + u[b], 0)));
    return { minutes: roundPair(total), steps: steps.map((s) => ({ ...s, minutes: roundPair(units[s.id]) })) };
  }
  const whole = units[phase];
  if (steps === undefined) return { minutes: roundPair(whole) };
  return {
    minutes: roundPair(whole),
    steps: steps.map(({ share, ...s }) => ({ ...s, minutes: roundPair(pair(whole.low * share, whole.high * share)) })),
  };
}

const hours = (m) => {
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`;
};

/** "20 to 40 minutes", "3 to 5 hours", "45 minutes to 2 hours". */
export function formatDuration({ low, high }) {
  if (high < 60) return low === high ? `${low} minutes` : `${low} to ${high} minutes`;
  if (low < 60) return `${low} minutes to ${hours(high)}`;
  return low === high ? hours(high) : `${hours(low).replace(/ hours?$/, '')} to ${hours(high)}`;
}

/** "Step 3 (D1) 20 to 35 minutes; Step 4 (the art direction) 25 to 45 minutes". */
export function formatSteps(steps) {
  return steps.map((s) => `Step ${s.step} (${s.name}) ${formatDuration(s.minutes)}`).join('; ');
}
