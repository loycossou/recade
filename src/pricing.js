/**
 * The price of each model the agents of Recade run on, for `recade cost estimate`.
 * Prices of 2026-11-03, Anthropic API, per million tokens: fresh input, output, cache write and cache read.
 * On a Claude subscription the same work counts against the usage limits instead of costing these dollars.
 * Update the date and the rows together when the prices change.
 */
export const PRICES_DATE = '2026-11-03';

/** Where the prices come from, as the estimate prints it. */
export const PRICES_SOURCE = `prices of ${PRICES_DATE}, Anthropic API, per million tokens`;

/** Dollars per million tokens, by full model id. */
export const PRICES = Object.freeze({
  'claude-opus-5-5': Object.freeze({ input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.2 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.1 }),
  'claude-haiku-5-5': Object.freeze({ input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 }),
  'claude-fable-5-2': Object.freeze({ input: 8.0, output: 40.0, cacheWrite: 10.0, cacheRead: 0.2 }),
});

/**
 * The aliases used in the repository: the `model` of a dispatch (`recade models writer`), the mechanical tier of
 * `agents/models.json` and the rows of `harness/models.yaml`.
 */
export const MODEL_ALIASES = Object.freeze({
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-2',
});

/**
 * The full id of a model id or alias. Throws on a model with no price.
 * @param {string} model
 * @returns {string}
 */
export function modelId(model) {
  if (typeof model === 'string' && Object.hasOwn(MODEL_ALIASES, model)) return MODEL_ALIASES[model];
  if (typeof model === 'string' && Object.hasOwn(PRICES, model)) return model;
  throw new Error(`No price for the model ${JSON.stringify(model)}. Known: ${[...Object.keys(MODEL_ALIASES), ...Object.keys(PRICES)].join(', ')}.`);
}

/**
 * The price row of a model id or alias.
 * @param {string} model
 * @returns {{input: number, output: number, cacheWrite: number, cacheRead: number}}
 */
export const priceOf = (model) => PRICES[modelId(model)];

/**
 * Dollars for a count of tokens of each kind on one model.
 * @param {string} model id or alias
 * @param {{input?: number, output?: number, cacheWrite?: number, cacheRead?: number}} tokens
 * @returns {number}
 */
export function dollarsOf(model, tokens) {
  const price = priceOf(model);
  let total = 0;
  for (const kind of ['input', 'output', 'cacheWrite', 'cacheRead']) total += ((tokens[kind] ?? 0) * price[kind]) / 1e6;
  return total;
}
