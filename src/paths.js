import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Expand a leading `~` or `~/` using `env.HOME`. Other paths are returned unchanged.
 * @param {string} p
 * @param {Record<string,string|undefined>} env
 * @returns {string}
 */
export function expandHome(p, env) {
  const home = env.HOME;
  if (!home) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/**
 * Directory that holds the user configuration. Always an absolute path.
 * @param {Record<string,string|undefined>} env
 * @returns {string}
 */
export function configDir(env) {
  if (env.RECADE_CONFIG_DIR) return env.RECADE_CONFIG_DIR;
  let base = env.XDG_CONFIG_HOME;
  if (!base) {
    const home = env.HOME || homedir();
    if (!home || !isAbsolute(home)) {
      throw new Error('Cannot find your home directory. Set RECADE_CONFIG_DIR.');
    }
    base = join(home, '.config');
  }
  return join(base, 'recade');
}
