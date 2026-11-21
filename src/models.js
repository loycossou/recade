/**
 * The models the owner chooses from for the writer tier (the agents that write and review the documents).
 * The alias is what a dispatch passes as `model`; the id is what a roster row and a model table write.
 * `fable` is the default, and `agents/models.json` holds the same id as the fallback of the agent files.
 */
export const WRITER_MODELS = Object.freeze({
  fable: 'claude-fable-5-2',
  opus: 'claude-opus-5-5',
});

export const WRITER_CHOICES = Object.freeze(Object.keys(WRITER_MODELS));

/** True when `value` is one of the aliases the owner can choose. */
export const isWriterChoice = (value) => typeof value === 'string' && Object.hasOwn(WRITER_MODELS, value);
