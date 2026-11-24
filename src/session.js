import { spawn, spawnSync } from 'node:child_process';

/**
 * The process of the Claude Code session that runs this command: the first process above this one whose command line
 * is the Claude Code CLI (`claude`, or node running the `@anthropic-ai/claude-code` package). Null when none is found.
 * @param {number} pid where to start (the parent of this process)
 * @param {{ps?: (pid: number) => {ppid: number, args: string}|null}} [options]
 * @returns {number|null}
 */
export function sessionProcess(pid, { ps = psOf } = {}) {
  for (let at = pid, hops = 0; at > 1 && hops < 30; hops++) {
    const row = ps(at);
    if (row === null) return null;
    if (isClaude(row.args)) return at;
    at = row.ppid;
  }
  return null;
}

/** Is this command line the Claude Code CLI? */
export const isClaude = (args) => /(^|\/)claude(\s|$)/.test(String(args)) || /@anthropic-ai\/claude-code\//.test(String(args));

/** The parent and the command line of a process, from `ps`. */
function psOf(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.trim());
  return m === null ? null : { ppid: Number(m[1]), args: m[2] };
}

/**
 * Stop the session a moment after this command returns: a detached `kill -TERM` in two seconds, so the tool call ends
 * and its output is shown first.
 * @returns {number|null} the process that will be stopped, or null when none was found
 */
export function endSession({ ps = psOf, schedule = scheduleTerm } = {}) {
  const pid = sessionProcess(process.ppid, { ps });
  if (pid === null) return null;
  schedule(pid);
  return pid;
}

function scheduleTerm(pid) {
  const child = spawn('sh', ['-c', `sleep 2; kill -TERM ${Number(pid)}`], { detached: true, stdio: 'ignore' });
  child.unref();
}
