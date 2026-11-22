/**
 * The models the owner chooses from for the writer tier (the agents that write and review the documents).
 * The alias is what a dispatch passes as `model`; the id is what a roster row and a model table write.
 * `opus` is the default choice and `fable` the other one; `agents/models.json` holds `claude-opus-5-5` as the fallback of the agent files, by the owner's decision of 2026-11-21.
 */
export const WRITER_MODELS = Object.freeze({
  fable: 'claude-fable-5-2',
  opus: 'claude-opus-5-5',
});

export const WRITER_CHOICES = Object.freeze(Object.keys(WRITER_MODELS));

/** True when `value` is one of the aliases the owner can choose. */
export const isWriterChoice = (value) => typeof value === 'string' && Object.hasOwn(WRITER_MODELS, value);

/**
 * The framing stages that run on the `mechanical` tier of `agents/models.json` (Sonnet at medium effort) instead of the
 * writing model. Each one carries out what was already decided or approved: it writes no new content and judges
 * nothing. Drafting, contributing, reviewing, revising after a review, cutting a document to its budget and every
 * stage of the stack, the team, the slices and the harness stay on the writing model.
 * `fix` is a `revise` sent back for a finding of `recade lint-style`, `recade index check` or `recade render`
 * (a format fix), never for a review note or a size error.
 */
export const MECHANICAL_STAGES = Object.freeze([
  Object.freeze({ stage: 'translate', agents: Object.freeze(['project-lead', 'architect', 'security-lead', 'bible-writer']), why: 'translation of an approved document' }),
  Object.freeze({ stage: 'glossary', agents: Object.freeze(['project-lead']), why: 'terms the contributors reported, added to Annex A of D1' }),
  Object.freeze({ stage: 'apply-decisions', agents: Object.freeze(['project-lead', 'architect', 'security-lead', 'bible-writer']), why: "the owner's choices carried into the text" }),
  Object.freeze({ stage: 'fix', agents: Object.freeze(['project-lead', 'architect', 'security-lead', 'bible-writer']), why: 'a style, index or render finding fixed in place' }),
]);

/**
 * The tier a framing stage runs on: `mechanical` for the stages of MECHANICAL_STAGES, `writer` for the rest.
 * The `stack-analyst` keeps the writing model at `apply-decisions`: there it writes the ADR sections of the STACK.
 * @param {string} agent
 * @param {string} stage
 * @returns {'writer'|'mechanical'}
 */
export function stageTier(agent, stage) {
  return MECHANICAL_STAGES.some((m) => m.stage === stage && m.agents.includes(agent)) ? 'mechanical' : 'writer';
}
