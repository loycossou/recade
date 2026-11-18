/**
 * The `touches:` globs of a slice sheet, once they name a code repository: `api:src/orders/**` (spec 6.5, 6.17).
 * This file has no import, so the slice checks, the parallel plan, the guard and the repository registry can all use it.
 */

/** A repository name, which is also what may stand before the colon of a touch. */
export const REPO_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PREFIX = /^([a-z0-9]+(?:-[a-z0-9]+)*):(.*)$/s;
/** The prefix of an agent `## Writes` entry for the workspace itself. It is refused in `touches:`. */
export const WORKSPACE_PREFIX = 'workspace';

const WILD = /[*?[{]/;
const segmentsOf = (glob) => glob.trim().replace(/^\.\//, '').split('/').filter((x) => x !== '');

/**
 * Do two path globs overlap? Deliberately simple and conservative, read one path segment at a time. Two literal
 * segments must be equal. A segment with a wildcard (`*`, `?`, `[`, `{`) is taken to match anything, and so does
 * everything after it. A path that ends first is a folder or a file above the other one, so they overlap.
 * `src/api/**` and `src/api/users/**` overlap. `src/api` and `src/apiary/**` do not. A glob that starts with a
 * wildcard (`**\/*.md`) overlaps every other glob. Globs that differ only after a wildcard are not told apart.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function globsOverlap(a, b) {
  const x = segmentsOf(a);
  const y = segmentsOf(b);
  if (x.length === 0 || y.length === 0) return false;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (WILD.test(x[i]) || WILD.test(y[i])) return true;
    if (x[i] !== y[i]) return false;
  }
  return true;
}

/**
 * Split a touch into its repository and its glob. The prefix is the text before the first `:` when that text is a
 * repository name (lower-case kebab, so it holds no slash); otherwise the whole text is the glob.
 * @param {string} text
 * @returns {{repo: string|null, glob: string}}
 */
export function parseTouch(text) {
  const t = String(text ?? '').trim();
  const m = PREFIX.exec(t);
  return m === null ? { repo: null, glob: t } : { repo: m[1], glob: m[2] };
}

/** The repository names of a state's `repos` registry, in order. Anything that is not an entry with a name is ignored. */
export function registryNames(state) {
  const repos = state?.repos;
  return Array.isArray(repos) ? repos.filter((r) => r !== null && typeof r === 'object' && typeof r.name === 'string').map((r) => r.name) : [];
}

/** The repository of a parsed touch: its prefix, else the only repository of a one-entry registry, else null. */
const repoOfTouch = (parsed, registry) => parsed.repo ?? (registry.length === 1 ? registry[0] : null);

/**
 * The repository a touch (or a hotspot) is in: its prefix, else the only repository of a one-entry registry, else null
 * (unknown). The prefix is not checked against the registry here, see `touchProblems`.
 * @param {string} text
 * @param {string[]} [registry]
 * @returns {string|null}
 */
export const touchRepo = (text, registry = []) => repoOfTouch(parseTouch(text), registry);

/**
 * What is wrong with the repository prefix of each touch, in order. `touch-prefix`: no prefix while the registry has
 * two repositories or more. `touch-repo`: a prefix that is not in the registry, and `workspace:`, which is valid only
 * in the `## Writes` of an agent. `touch-empty`: a prefix with no glob after it. A project with no registry keeps its
 * unprefixed globs. The same list serves the checks of the sheets, the hotspots and the parallel plan.
 * @param {string[]} touches
 * @param {string[]} [registry]
 * @returns {{rule: 'touch-prefix'|'touch-repo'|'touch-empty', touch: string, message: string}[]}
 */
export function touchProblems(touches, registry = []) {
  const known = registry.join(', ');
  const out = [];
  for (const t of touches) {
    const { repo, glob } = parseTouch(t);
    if (repo === null) {
      if (registry.length >= 2) out.push({ rule: 'touch-prefix', touch: t, message: `"${t}" has no repository prefix and the project has ${registry.length} repositories (${known}). Write it as <repository>:<glob>, for example \`${registry[0]}:${t}\`.` });
    } else if (repo === WORKSPACE_PREFIX) {
      out.push({ rule: 'touch-repo', touch: t, message: `"${t}": \`workspace:\` is not allowed here. It is valid only in the \`## Writes\` of an agent.` });
    } else if (!registry.includes(repo)) {
      out.push({ rule: 'touch-repo', touch: t, message: `"${t}" names the repository "${repo}", which is not in the registry (${known === '' ? 'it is empty' : known}). Add it with \`recade repo add\`, or fix the prefix.` });
    } else if (glob.trim() === '') {
      out.push({ rule: 'touch-empty', touch: t, message: `"${t}": the prefix "${repo}:" needs a glob after it, for example \`${repo}:src/**\`.` });
    }
  }
  return out;
}

/**
 * Do two touches overlap? Not when they name different repositories. In the same repository, `globsOverlap` decides.
 * A prefix with an empty glob (an error elsewhere) covers the whole repository. A glob with no prefix belongs to the only repository when the registry has one entry. Otherwise its repository is
 * unknown (a legacy project with no registry, or a sheet that `touch-prefix` already refuses): it is then compared
 * with every repository, which errs on the side of caution.
 * @param {string} a
 * @param {string} b
 * @param {string[]} [registry] the repository names of the project
 * @returns {boolean}
 */
export function touchesOverlap(a, b, registry = []) {
  const x = parseTouch(a);
  const y = parseTouch(b);
  const rx = repoOfTouch(x, registry);
  const ry = repoOfTouch(y, registry);
  if (rx !== null && ry !== null && rx !== ry) return false;
  if (x.glob.trim() === '' || y.glob.trim() === '') return true; // a prefix with no glob (`api:`) is read as the whole repository
  return globsOverlap(x.glob, y.glob);
}

/**
 * The repositories a list of touches names, in order of first appearance, each once. With a one-entry registry the
 * unprefixed globs count for that repository.
 * @param {string[]} touches
 * @param {string[]} [registry]
 * @returns {string[]}
 */
export function reposOf(touches, registry = []) {
  const out = [];
  for (const t of touches) {
    const repo = repoOfTouch(parseTouch(t), registry);
    if (repo !== null && !out.includes(repo)) out.push(repo);
  }
  return out;
}
