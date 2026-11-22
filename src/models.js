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
