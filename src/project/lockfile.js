import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STALE_MS = 30000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `fn` while holding the lock file `<root>/<lock...>`, created with O_EXCL so two Recade commands never
 * change the same register at the same time. Retries a few times, drops a lock older than 30 seconds (its owner
 * died), then fails with a clear message.
 * @template T
 * @param {string} root project folder
 * @param {string[]} lock path of the lock file under `root`, as segments
 * @param {{lockTries?: number, lockWaitMs?: number}} options
 * @param {() => T} fn
 * @param {string} [what] what is locked, for the error message
 * @returns {T}
 */
export function withLock(root, lock, { lockTries = 100, lockWaitMs = 25 } = {}, fn, what = 'The register') {
  const path = join(root, ...lock);
  mkdirSync(dirname(path), { recursive: true });
  let fd = -1;
  for (let attempt = 0; fd < 0; attempt++) {
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
      } catch { /* the owner just released it */ }
      if (attempt >= lockTries) {
        throw new Error(`${what} is locked by another command. Try again, or delete ${path} if no Recade command is running.`);
      }
      sleep(lockWaitMs);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

/** Write `text` to `path` through a temporary file and a rename, so a reader never sees half a file. */
export function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}
