import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem, homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The room a spike needs on this machine. A spike starts runtimes, containers and package caches: below these
 * figures it is skipped with a notice, and the layer is decided from the research.
 */
export const SPIKE_MIN = Object.freeze({ memoryMb: 2048, diskMb: 5120 });

/** The name every container, volume and network of a spike starts with, so that the cleanup can prove it is ours. */
export const SPIKE_PREFIX = 'recade-spike-';

/** The file of a spike folder that lists what the spike created outside its code. */
export const MANIFEST = 'MANIFEST.json';

/** The kinds of things a manifest lists, in the order the cleanup removes them. */
export const MANIFEST_KINDS = Object.freeze(['processes', 'containers', 'networks', 'volumes', 'images', 'paths']);

/** Files the cleanup never removes: the analyst reads them after the spikes. */
const KEPT_FILES = new Set(['RESULT.md', MANIFEST]);

/**
 * The free memory of this machine, in MB: `MemAvailable` of `/proc/meminfo` when it exists (what `free -m` shows as
 * available), the free memory of Node otherwise.
 * @param {{meminfo?: () => string}} [seams]
 * @returns {number}
 */
export function freeMemoryMb({ meminfo } = {}) {
  try {
    const text = meminfo ? meminfo() : readFileSync('/proc/meminfo', 'utf8');
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {
    // no /proc on this system: fall back below
  }
  return Math.floor(freemem() / (1024 * 1024));
}

/**
 * The free disk, in MB, of the filesystem that holds `dir` (what `df -m` shows as available).
 * @param {string} dir
 * @param {{statfs?: (dir: string) => {bavail: number|bigint, bsize: number|bigint}}} [seams]
 * @returns {number|null} null when it cannot be read
 */
export function freeDiskMb(dir, { statfs } = {}) {
  try {
    const s = (statfs ?? statfsSync)(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/**
 * Whether this machine has room for a spike: free memory, and free disk where the spike folder and the user caches live.
 * @param {string} root the project folder
 * @param {{meminfo?: () => string, statfs?: (dir: string) => object, home?: string, min?: {memoryMb: number, diskMb: number}}} [seams]
 * @returns {{ok: boolean, memoryMb: number, diskMb: number|null, min: {memoryMb: number, diskMb: number}, problems: string[]}}
 */
export function spikeRoom(root, seams = {}) {
  const min = seams.min ?? SPIKE_MIN;
  const memoryMb = freeMemoryMb(seams);
  const disks = [root, seams.home ?? homedir()].map((d) => freeDiskMb(d, seams)).filter((n) => n !== null);
  const diskMb = disks.length === 0 ? null : Math.min(...disks);
  const problems = [];
  if (memoryMb < min.memoryMb) problems.push(`Not enough free memory: ${memoryMb} MB, a spike needs ${min.memoryMb} MB.`);
  if (diskMb !== null && diskMb < min.diskMb) problems.push(`Not enough free disk: ${diskMb} MB, a spike needs ${min.diskMb} MB.`);
  return { ok: problems.length === 0, memoryMb, diskMb, min, problems };
}


/**
 * The environment a runner sets before any install, so that the caches and the user-space runtimes of its tools land in
 * its spike folder and nothing lands in a shared cache. Docker keeps its own configuration: pointing `DOCKER_CONFIG`
 * elsewhere would lose the context of Docker Desktop.
 * @param {string} folder the absolute spike folder
 * @returns {Record<string, string>}
 */
export function spikeEnv(folder) {
  const c = (rel) => join(folder, '.recade-cache', rel);
  return {
    TMPDIR: c('tmp'),
    XDG_CACHE_HOME: c('xdg'),
    npm_config_cache: c('npm'),
    npm_config_store_dir: c('pnpm-store'),
    YARN_CACHE_FOLDER: c('yarn'),
    BUN_INSTALL: c('bun'),
    DENO_DIR: c('deno'),
    PLAYWRIGHT_BROWSERS_PATH: c('ms-playwright'),
    PIP_CACHE_DIR: c('pip'),
    UV_CACHE_DIR: c('uv'),
    POETRY_CACHE_DIR: c('poetry'),
    PIPX_HOME: c('pipx'),
    COMPOSER_HOME: c('composer'),
    COMPOSER_CACHE_DIR: c('composer-cache'),
    GOPATH: c('go'),
    GOCACHE: c('go-build'),
    GOMODCACHE: c('go-mod'),
    CARGO_HOME: c('cargo'),
    RUSTUP_HOME: c('rustup'),
    GRADLE_USER_HOME: c('gradle'),
    MAVEN_OPTS: `-Dmaven.repo.local=${c('m2')}`,
    DOTNET_CLI_HOME: c('dotnet'),
    NUGET_PACKAGES: c('nuget'),
  };
}

/**
 * The places outside a spike folder that a tool may still create on its own, under the home folder. The cleanup removes
 * one of them only when the record taken before the spike says it did not exist, it is a real folder now (not a link),
 * and its real parent is inside the home folder. Anything else outside the spike folder is never removed.
 */
export const OUTSIDE_CACHES = Object.freeze([
  '.npm', '.yarn', '.bun', '.deno', '.cache/ms-playwright', '.cache/pip', '.cache/composer', '.cache/go-build', '.composer',
  '.config/composer', '.cargo', '.rustup', '.gradle', '.m2', '.nuget', '.dotnet', '.sdkman', '.pyenv', '.nvm', 'go',
]);

/** The file, next to the spike folders, that records the machine before one spike. Outside the runner's folder. */
export const beforeFile = (root, name) => join(root, 'spikes', `${name}.before.json`);

const SPIKE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** A path is there, even as a broken symbolic link. */
const present = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
/** The real location of a folder, or null when it cannot be read. */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
const IMAGE_ID = /^(sha256:)?[0-9a-f]{12,64}$/;
const fullId = (id) => (id.startsWith('sha256:') ? id : `sha256:${id}`);

/** Every image ID on this machine, in full, or null when Docker cannot be asked. */
function imageIds(exec, cwd) {
  const r = exec(['docker', 'image', 'ls', '-q', '--no-trunc'], { cwd });
  if (r.code !== 0) return null;
  return [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map(fullId))].sort();
}

/**
 * Record the machine before one spike: the time, the image IDs Docker holds, and which of the outside caches exist.
 * The cleanup trusts this record, written by Recade, and never the runner's word alone.
 * @param {string} root the project folder
 * @param {string} name the spike folder name, `<layer>-<option>`
 * @param {{exec: Function, home?: string, now?: () => number}} options
 * @returns {{file: string, record: object}}
 */
export function recordBefore(root, name, options) {
  if (!SPIKE_NAME.test(name) || name.includes('..')) throw new Error(`not a spike name: ${name}`);
  const home = resolve(options.home ?? homedir());
  const record = {
    version: 1,
    spike: name,
    at: (options.now ?? Date.now)(),
    images: imageIds(options.exec, resolve(root)),
    caches: Object.fromEntries(OUTSIDE_CACHES.map((rel) => [rel, present(join(home, rel))])),
  };
  const file = beforeFile(root, name);
  mkdirSync(join(root, 'spikes'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return { file, record };
}

/** Read the record taken before one spike, or null when there is none or it is broken. */
export function readBefore(root, name) {
  try {
    const data = JSON.parse(readFileSync(beforeFile(root, name), 'utf8'));
    if (data === null || typeof data !== 'object' || !Number.isFinite(data.at)) return null;
    return { at: data.at, images: Array.isArray(data.images) ? data.images.map(String) : null, caches: data.caches && typeof data.caches === 'object' ? data.caches : {} };
  } catch {
    return null;
  }
}

/**
 * Read the manifest of one spike folder. A missing file is an empty manifest; a broken one is an error.
 * @param {string} folder
 * @returns {{manifest: Record<string, any[]>|null, error?: string}}
 */
export function readManifest(folder) {
  const file = join(folder, MANIFEST);
  if (!existsSync(file)) return { manifest: null };
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { manifest: null, error: `${MANIFEST} is not valid JSON: ${err.message}` };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { manifest: null, error: `${MANIFEST} is not a JSON object.` };
  const manifest = {};
  for (const kind of MANIFEST_KINDS) manifest[kind] = Array.isArray(data[kind]) ? data[kind] : [];
  return { manifest };
}

/** The spike folders of a project: every folder under `spikes/`, a hidden one aside. */
export function spikeFolders(root) {
  const dir = join(root, 'spikes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => {
    if (n.startsWith('.')) return false;
    try {
      return lstatSync(join(dir, n)).isDirectory();
    } catch {
      return false;
    }
  }).sort();
}

/**
 * The command line and the start time of a running process, or null when there is none. The start time comes from
 * `ps -o lstart=`, to the second; it is null when it cannot be read.
 */
function defaultProcInfo(pid, exec) {
  let command = null;
  try {
    command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
  } catch {
    if (existsSync('/proc/self')) return null;
    const r = exec(['ps', '-p', String(pid), '-o', 'command='], { cwd: tmpdir() });
    command = r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  }
  if (command === null) return null;
  const s = exec(['env', 'LC_ALL=C', 'ps', '-p', String(pid), '-o', 'lstart='], { cwd: tmpdir() });
  const t = s.code === 0 ? Date.parse(s.stdout.trim()) : NaN;
  return { command, startedAt: Number.isFinite(t) ? t : null };
}

const GONE = /no such|not found|unknown/i;

/**
 * Remove what the spikes created, as their manifests list it, and only what Recade can prove the spike created.
 * When a proof is missing, the item is kept and the reason is given: refuse rather than guess.
 *
 * - A container, a network or a volume is removed only when its name starts with `recade-spike-`.
 * - An image is removed, without force, only when its repository starts with `recade-spike-`, or when its ID was not
 *   on this machine in the record taken before the spike (`recade spikes check --spike`).
 * - A process is stopped only when its command line is exactly the one the manifest recorded, and it started after the
 *   record taken before the spike: a process the owner started is never stopped.
 * - A path is removed when its real location is inside the spike folder (the real path of its parent is checked, so a
 *   link cannot lead outside), and a link is removed as a link, never followed. Outside the spike folder, only a cache
 *   of `OUTSIDE_CACHES` is removed, and only when the record before the spike says it did not exist. `RESULT.md` and
 *   the manifest stay.
 *
 * @param {string} root the project folder
 * @param {{only?: string, exec: (cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}, kill?: (pid: number) => void, procInfo?: (pid: number) => {command: string, startedAt: number|null}|null, home?: string}} options
 * @returns {{folders: string[], removed: {spike: string, kind: string, what: string}[], kept: {spike: string, kind: string, what: string, why: string}[], gone: {spike: string, kind: string, what: string}[], notes: string[]}}
 */
export function cleanSpikes(root, options) {
  const { exec } = options;
  const kill = options.kill ?? ((pid) => process.kill(pid, 'SIGTERM'));
  const procInfo = options.procInfo ?? ((pid) => defaultProcInfo(pid, exec));
  const home = resolve(options.home ?? homedir());
  const project = resolve(root);
  const realProject = real(project) ?? project;
  const realHome = real(home);
  const out = { folders: [], removed: [], kept: [], gone: [], notes: [] };
  let docker = null; // null: not tried yet
  const runDocker = (args) => {
    if (docker === false) return { code: 127, stdout: '', stderr: 'docker not found' };
    const r = exec(['docker', ...args], { cwd: project });
    if (r.code === 127 && docker === null) docker = false;
    else docker = true;
    return r;
  };
  const names = spikeFolders(root).filter((n) => options.only === undefined || n === options.only);
  if (options.only !== undefined && names.length === 0) out.notes.push(`No spike folder spikes/${options.only}.`);
  for (const name of names) {
    const folder = join(project, 'spikes', name);
    const realFolder = real(folder);
    const { manifest, error } = readManifest(folder);
    if (error) {
      out.notes.push(`spikes/${name}: ${error} Nothing was removed for this spike.`);
      continue;
    }
    if (manifest === null) {
      out.notes.push(`spikes/${name}: no ${MANIFEST}, so nothing was recorded and nothing was removed.`);
      continue;
    }
    if (realFolder === null || !inside(realProject, realFolder)) {
      out.notes.push(`spikes/${name}: the folder is not really inside the project, so nothing was removed for this spike.`);
      continue;
    }
    out.folders.push(name);
    const before = readBefore(project, name);
    if (before === null) out.notes.push(`spikes/${name}: no record of the machine before the spike (recade spikes check --spike ${name}), so only what its name or its folder proves is removed.`);
    const keep = (kind, what, why) => out.kept.push({ spike: name, kind, what: String(what), why });
    const done = (kind, what) => out.removed.push({ spike: name, kind, what: String(what) });
    const gone = (kind, what) => out.gone.push({ spike: name, kind, what: String(what) });
    for (const p of manifest.processes) {
      const pid = Number(p?.pid);
      const command = isText(p?.command) ? p.command.trim() : '';
      const label = `${pid} (${command || 'no command'})`;
      if (!Number.isInteger(pid) || pid <= 1 || command === '') {
        keep('process', label, 'a process needs its exact pid and its full command line');
        continue;
      }
      if (pid === process.pid || pid === process.ppid) {
        keep('process', label, 'it is Recade or the session that runs it');
        continue;
      }
      const now = procInfo(pid);
      if (now === null) {
        gone('process', label);
        continue;
      }
      if (now.command.trim() !== command) {
        keep('process', label, `pid ${pid} now runs another command line`);
        continue;
      }
      if (before === null) {
        keep('process', label, 'no record before the spike proves it started during the spike');
        continue;
      }
      if (now.startedAt === null || now.startedAt < Math.floor(before.at / 1000) * 1000) {
        keep('process', label, now.startedAt === null ? 'its start time cannot be read, so it is not proven to be the spike\'s' : 'it started before the spike, so it may be the owner\'s');
        continue;
      }
      try {
        kill(pid);
        done('process', label);
      } catch (err) {
        if (err?.code === 'ESRCH') gone('process', label);
        else keep('process', label, err.message);
      }
    }
    for (const [key, kind, args] of [
      ['containers', 'container', (n) => ['rm', '-f', n]],
      ['networks', 'network', (n) => ['network', 'rm', n]],
      ['volumes', 'volume', (n) => ['volume', 'rm', n]],
      ['images', 'image', (n) => ['image', 'rm', n]],
    ]) {
      for (const raw of manifest[key]) {
        if (!isText(raw)) {
          keep(kind, JSON.stringify(raw), 'not a name');
          continue;
        }
        const n = raw.trim();
        if (n.startsWith('-') || /\s/.test(n)) {
          keep(kind, n, 'not a name');
          continue;
        }
        if (kind === 'image' && !n.startsWith(SPIKE_PREFIX)) {
          // Not named by the spike: removed only when its ID is new since the record before the spike.
          if (before === null || before.images === null) {
            keep(kind, n, `its name does not start with ${SPIKE_PREFIX} and no record before the spike lists the images, so it is not proven to be the spike's`);
            continue;
          }
          let id = null;
          if (IMAGE_ID.test(n)) id = fullId(n);
          else {
            const r = runDocker(['image', 'inspect', '--format', '{{.Id}}', n]);
            if (docker === false) {
              keep(kind, n, 'docker not found');
              continue;
            }
            if (r.code !== 0) {
              if (GONE.test(r.stderr)) gone(kind, n);
              else keep(kind, n, (r.stderr || r.stdout).trim().split('\n')[0] || `docker exited ${r.code}`);
              continue;
            }
            id = fullId(r.stdout.trim());
          }
          if (before.images.some((b) => b === id || b.startsWith(id) || id.startsWith(b))) {
            keep(kind, n, 'it was on this machine before the spike');
            continue;
          }
        } else if (kind !== 'image' && !n.startsWith(SPIKE_PREFIX)) {
          keep(kind, n, `its name does not start with ${SPIKE_PREFIX}, so it is not proven to be a spike's`);
          continue;
        }
        const r = runDocker(args(n));
        if (r.code === 0) done(kind, n);
        else if (docker === false) keep(kind, n, 'docker not found');
        else if (GONE.test(r.stderr)) gone(kind, n);
        else keep(kind, n, (r.stderr || r.stdout).trim().split('\n')[0] || `docker exited ${r.code}`);
      }
    }
    for (const raw of manifest.paths) {
      if (!isText(raw)) {
        keep('path', JSON.stringify(raw), 'not a path');
        continue;
      }
      const given = raw.trim().replace(/^~(?=$|\/)/, home);
      const abs = resolve(folder, given);
      if (!present(abs)) {
        gone('path', raw);
        continue;
      }
      if (abs === folder || abs === realFolder) {
        keep('path', raw, 'it is the spike folder itself, which goes with spikes/ after the gate');
        continue;
      }
      const realParent = real(dirname(abs));
      const target = realParent === null ? null : join(realParent, basename(abs));
      if (target !== null && inside(realFolder, target)) {
        if (KEPT_FILES.has(relative(realFolder, target))) {
          keep('path', raw, 'RESULT.md and the manifest stay for the analyst');
          continue;
        }
        removePath(target, raw);
        continue;
      }
      if (inside(folder, abs)) {
        keep('path', raw, 'it is reached through a link that leads outside the spike folder');
        continue;
      }
      // Outside the spike folder: only a known cache that the record before the spike proves is new.
      const rel = relative(home, abs);
      if (!OUTSIDE_CACHES.includes(rel.split(sep).join('/'))) {
        keep('path', raw, 'it is outside the spike folder and not a known cache, so it is never removed');
        continue;
      }
      if (before === null || before.caches[rel.split(sep).join('/')] !== false) {
        keep('path', raw, before === null ? 'no record before the spike proves the spike created it' : 'it existed before the spike');
        continue;
      }
      if (realHome === null || target === null || realParent !== join(realHome, dirname(rel)) || lstatSync(abs).isSymbolicLink() || !lstatSync(abs).isDirectory()) {
        keep('path', raw, 'it is not a real folder where the cache belongs');
        continue;
      }
      if (target === realProject || inside(target, realProject)) {
        keep('path', raw, 'it holds the project');
        continue;
      }
      removePath(target, raw);
    }
    function removePath(target, raw) {
      try {
        // rmSync works on the link itself and never follows a link it meets inside a folder.
        if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
        else rmSync(target, { recursive: true, force: true });
        done('path', raw);
      } catch (err) {
        keep('path', raw, err.message);
      }
    }
  }
  return out;
}
