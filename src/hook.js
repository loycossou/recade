import { SESSION_START_JSON } from './hook-message.js';
import { isStarted } from './started.js';

/**
 * Output of the SessionStart hook: the reminder JSON until the config says `started: true`, then nothing.
 * @param {string | undefined} configText raw text of config.yaml, or undefined when there is none
 * @returns {string}
 */
export function sessionStartOutput(configText) {
  return isStarted(configText) ? '' : SESSION_START_JSON;
}
