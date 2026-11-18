// No imports here. bin/recade-hook.js loads this file in a plugin install without node_modules.

export const SESSION_START_MESSAGE =
  'Recade is installed but not set up. Run /recade:start (about two minutes).';

/** The JSON the SessionStart hook prints when the user has not run /recade:start yet. */
export const SESSION_START_JSON = JSON.stringify({ systemMessage: SESSION_START_MESSAGE });
