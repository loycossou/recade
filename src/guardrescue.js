/**
 * The one command the guard of the plugin lets through when it cannot start (a plugin folder whose dependencies are not
 * installed): the install of those dependencies in the plugin folder, written as the commands write it. Without this,
 * the guard would refuse the very command that repairs it, and the session could not go on.
 * @param {string} command the Bash command of the hook input
 * @param {string} pluginRoot the plugin folder, absolute
 * @returns {boolean}
 */
export function installAllowed(command, pluginRoot) {
  const text = String(command ?? '').trim();
  if (/[;&|`<>\n\r]|\$\(/.test(text)) return false;
  const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const folder = `(?:"${quote(pluginRoot)}"|'${quote(pluginRoot)}'|${quote(pluginRoot)}|"\\$RECADE_PLUGIN_ROOT"|"\\$\\{CLAUDE_PLUGIN_ROOT\\}")`;
  return new RegExp(`^npm ci --omit=dev(?: --ignore-scripts)? --prefix ${folder}$`).test(text);
}

/** The command the deny message gives, for this plugin folder. */
export const installCommand = (pluginRoot) => `npm ci --omit=dev --prefix '${pluginRoot}'`;
