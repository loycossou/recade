import { closeSync, lstatSync, openSync, readSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { listRepos } from '../workspace/repos.js';

/**
 * S-00 inventory scan of an existing repository (spec section 4.1). It reads files and runs read-only `git log` and
 * `git branch` through the injected `exec`; it never runs project code, never installs anything, never writes and never
 * follows a symbolic link. A manifest that does not parse is reported in `problems`, never thrown.
 */

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'target', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.venv', 'venv',
  '__pycache__', '.tox', '.gradle', '.idea', '.cache', 'bower_components', '.recade', 'recade',
]);
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile', 'composer.json', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']);
/** Build files the scan does not understand: listed as problems, so that a repository never looks empty. */
const UNRECOGNISED = /^(Makefile|GNUmakefile|CMakeLists\.txt|mix\.exs|build\.sbt|Package\.swift|pubspec\.yaml|project\.clj|stack\.yaml|setup\.py|setup\.cfg|Pipfile|deno\.jsonc?|.+\.(csproj|fsproj|vbproj|sln|cabal))$/;
const MAX_UNRECOGNISED = 50;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Text with every control character (newlines, escape, bell) replaced by a space, and cut to a sane length. */
const cleanText = (v, max = 300) => (v === null || v === undefined ? v : String(v).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, max));
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock', 'bun.lockb', 'uv.lock']);
const MAX_DEPTH = 8;
const MAX_FILES = 20000;
const MAX_DIRS = 5000;
const MAX_LINE = 4000;
const MAX_GLOB = 500;
const MAX_STARS = 20;
const MAX_READ = 1024 * 1024;
const LARGE_LINES = 1000;
const LARGE_BYTES = 1024 * 1024;
const MAX_LISTED = 20;
const MAX_DOCS = 200;

/** @typedef {{file: string, message: string}} Problem */

/**
 * @typedef {object} Inventory
 * @property {{path: string, name: string|null, manifest: string, language: string, framework: string|null, testCommand: string|null, lintCommand: string|null, buildCommand: string|null}[]} packages
 * @property {{root: string, manager: string, globs: string[], members: string[]}[]} workspaces
 * @property {{file: string, jobs: string[]}[]} ci
 * @property {{commits: {style: string, count: number, conventional: number, examples: string[]}, branches: {style: string, count: number, prefixes: Record<string, number>}, formatter: string[]}} conventions
 * @property {{todo: number, fixme: number, skippedTests: number, largeFiles: {path: string, lines: number|null, bytes: number}[]}} debt
 * @property {string[]} docs
 * @property {Problem[]} problems
 * @property {boolean} truncated
 */

const isTestPath = (p) => /(^|\/)(tests?|__tests__|specs?)\//.test(p) || /[._-](test|spec)\.[a-z]+$/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.go$/.test(p);

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Read a regular file (never a link), at most MAX_READ bytes. Null when it is not a regular file or cannot be read. */
function readText(abs) {
  return safe(() => {
    const st = lstatSync(abs);
    if (!st.isFile()) return null;
    if (st.size > MAX_READ) return { tooLarge: true, size: st.size };
    return { text: readFileSync(abs, 'utf8'), size: st.size };
  }, null);
}

function looksBinary(abs) {
  return safe(() => {
    const fd = openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).includes(0);
    } finally {
      closeSync(fd);
    }
  }, true);
}

/** Every regular file under `repo` as relative paths, links and skipped folders left out, within the limits. */
function walk(repo, { maxDepth, maxFiles, maxDirs }, problems) {
  const files = [];
  let truncated = false;
  let dirs = 0;
  const visit = (rel, depth) => {
    if (truncated) return;
    if (++dirs > maxDirs) {
      truncated = true;
      return;
    }
    const entries = safe(() => readdirSync(join(repo, rel), { withFileTypes: true }), []).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) continue;
      if (CONTROL.test(e.name)) {
        problems.push({ file: cleanText(path), message: 'the path holds a control character and was skipped' });
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (depth >= maxDepth) truncated = true;
        else visit(path, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push(path);
      }
      if (truncated) return;
    }
  };
  visit('', 0);
  return { files, truncated };
}

// ---- a lenient TOML reader: tables and keys, enough to detect a stack. Reports a structure it cannot read. ----

/**
 * @param {string} text
 * @returns {{tables: Map<string, Map<string, string>>, error: string|null}} the raw value text of each key, by table name
 */
export function parseToml(text) {
  const tables = new Map([['', new Map()]]);
  let current = '';
  const lines = text.split(/\r?\n/);
  let pending = null; // an array or multi-line string still open: {key, depthOpen, buf, multi}
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (pending !== null && raw.length > MAX_LINE) return { tables, error: `line ${i + 1}: line too long (more than ${MAX_LINE} characters)` };
    if (pending !== null) {
      pending.buf += `\n${raw}`;
      if (pending.multi !== null) {
        if (raw.includes(pending.multi)) {
          tables.get(current).set(pending.key, pending.buf);
          pending = null;
        }
        continue;
      }
      pending.depth += bracketDelta(raw);
      if (pending.depth <= 0) {
        tables.get(current).set(pending.key, pending.buf);
        pending = null;
      }
      continue;
    }
    if (raw.length > MAX_LINE) return { tables, error: `line ${i + 1}: line too long (more than ${MAX_LINE} characters)` };
    const line = stripComment(raw).trim();
    if (line === '') continue;
    if (line.startsWith('[')) {
      const open = line.startsWith('[[') ? 2 : 1;
      const inner = line.endsWith(']'.repeat(open)) ? line.slice(open, line.length - open).trim() : null;
      if (inner === null || inner === '' || inner.includes('[') || inner.includes(']')) return { tables, error: `line ${i + 1}: table header is not closed` };
      current = inner.split('.').map((part) => part.trim()).join('.').replaceAll('"', '');
      if (!tables.has(current)) tables.set(current, new Map());
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) return { tables, error: `line ${i + 1}: expected key = value` };
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    const value = line.slice(eq + 1).trim();
    if (value === '') return { tables, error: `line ${i + 1}: key ${key} has no value` };
    const multi = /^("""|''')/.exec(value)?.[1] ?? null;
    if (multi !== null && !value.slice(3).includes(multi)) {
      pending = { key, buf: value, multi, depth: 0 };
    } else if (value.startsWith('[') || value.startsWith('{')) {
      const depth = bracketDelta(value);
      if (depth > 0) pending = { key, buf: value, multi: null, depth };
      else tables.get(current).set(key, value);
    } else {
      if ((value.startsWith('"') && !/^"([^"\\]|\\.)*"/.test(value)) || (value.startsWith("'") && !/^'[^']*'/.test(value))) {
        return { tables, error: `line ${i + 1}: string is not closed` };
      }
      tables.get(current).set(key, value);
    }
  }
  if (pending !== null) return { tables, error: `value of ${pending.key} is not closed` };
  return { tables, error: null };
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function bracketDelta(text) {
  let d = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') break;
    else if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
}

/** Every quoted string of a TOML value text. */
const quoted = (v) => [...String(v ?? '').matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
const unquote = (v) => (v === undefined ? null : (quoted(v)[0] ?? null));
const depName = (spec) => /^[A-Za-z0-9_.-]+/.exec(spec.trim())?.[0].toLowerCase().replace(/_/g, '-') ?? '';

// ---- detection per ecosystem ----

const NODE_FRAMEWORKS = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@nestjs/core', 'NestJS'], ['@angular/core', 'Angular'], ['svelte', 'Svelte'],
  ['vue', 'Vue'], ['react', 'React'], ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['@hapi/hapi', 'hapi'],
  ['electron', 'Electron'],
];
const PY_FRAMEWORKS = [['django', 'Django'], ['fastapi', 'FastAPI'], ['flask', 'Flask'], ['starlette', 'Starlette'], ['tornado', 'Tornado'], ['pyramid', 'Pyramid']];
const GO_FRAMEWORKS = [['github.com/gin-gonic/gin', 'Gin'], ['github.com/labstack/echo', 'Echo'], ['github.com/gofiber/fiber', 'Fiber'], ['github.com/go-chi/chi', 'chi']];
const RUST_FRAMEWORKS = [['axum', 'Axum'], ['actix-web', 'Actix Web'], ['rocket', 'Rocket'], ['warp', 'warp']];
const PHP_FRAMEWORKS = [['laravel/framework', 'Laravel'], ['symfony/framework-bundle', 'Symfony'], ['slim/slim', 'Slim']];

const firstMatch = (table, present) => table.find(([dep]) => present(dep))?.[1] ?? null;

const shellQuote = (s) => (/^[A-Za-z0-9_./@%+=:,-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);
/** A command to run from the repository root: `(cd <dir> && <cmd>)` for a package that is not at the root, so commands chain with `&&`. */
const inDir = (dir, cmd) => (cmd === null ? null : dir === '.' ? cmd : `(cd ${shellQuote(dir)} && ${cmd})`);

/** The text without its overlong lines, so that a pattern never backtracks over a megabyte on one line. */
const shortLines = (text) => text.split('\n').filter((l) => l.length <= MAX_LINE).join('\n');

const NPM_NO_TEST = /no test specified/;

function scriptCommand(manager, scripts, name) {
  if (typeof scripts?.[name] !== 'string' || scripts[name].trim() === '') return null;
  if (name === 'test' && NPM_NO_TEST.test(scripts[name])) return null;
  if (name === 'test') return manager === 'yarn' ? 'yarn test' : `${manager} test`;
  return manager === 'yarn' ? `yarn ${name}` : `${manager} run ${name}`;
}

function nodeManager(repo, dir, pkg) {
  const known = ['npm', 'pnpm', 'yarn', 'bun'];
  const declared = (p) => (typeof p?.packageManager === 'string' ? p.packageManager.split('@')[0] : null);
  if (known.includes(declared(pkg))) return declared(pkg);
  const isFile = (rel) => safe(() => lstatSync(join(repo, rel)).isFile(), false);
  // The package itself, then each folder above it up to the repository root: a workspace member uses its root's manager.
  const chain = [];
  for (let d = dir; ; d = posix.dirname(d)) {
    chain.push(d);
    if (d === '.') break;
  }
  const rootDeclared = declared(safe(() => JSON.parse(readText(join(repo, 'package.json'))?.text), null));
  if (known.includes(rootDeclared)) return rootDeclared;
  for (const d of chain) {
    const at = (f) => isFile(d === '.' ? f : `${d}/${f}`);
    if (at('pnpm-lock.yaml') || at('pnpm-workspace.yaml')) return 'pnpm';
    if (at('yarn.lock')) return 'yarn';
    if (at('bun.lockb')) return 'bun';
    if (at('package-lock.json')) return 'npm';
  }
  return 'npm';
}

/** Dependency names of a package.json object (dependencies, devDependencies, peerDependencies). */
function nodeDeps(pkg) {
  const out = new Set();
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (pkg[k] !== null && typeof pkg[k] === 'object' && !Array.isArray(pkg[k])) for (const d of Object.keys(pkg[k])) out.add(d);
  }
  return out;
}

function detectNode(repo, dir, files, text, problems, manifest) {
  let pkg;
  try {
    pkg = JSON.parse(text);
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('the top level is not an object');
  } catch (err) {
    problems.push({ file: manifest, message: `package.json does not parse: ${err.message}` });
    return { name: null, language: 'JavaScript', framework: null, test: null, lint: null, build: null, pkg: null };
  }
  const deps = nodeDeps(pkg);
  const ts = deps.has('typescript') || files.has(posix.join(dir, 'tsconfig.json'));
  const manager = nodeManager(repo, dir, pkg);
  return {
    name: typeof pkg.name === 'string' ? pkg.name : null,
    language: ts ? 'TypeScript' : 'JavaScript',
    framework: firstMatch(NODE_FRAMEWORKS, (d) => deps.has(d)),
    test: inDir(dir, scriptCommand(manager, pkg.scripts, 'test')),
    lint: inDir(dir, scriptCommand(manager, pkg.scripts, 'lint')),
    build: inDir(dir, scriptCommand(manager, pkg.scripts, 'build')),
    pkg,
    manager,
  };
}

function pyDeps(tables, extra = []) {
  const out = new Set(extra.map(depName));
  const project = tables.get('project');
  if (project?.has('dependencies')) for (const s of quoted(project.get('dependencies'))) out.add(depName(s));
  for (const [t, kv] of tables) {
    if (/^project\.optional-dependencies(\.|$)/.test(t) || t === 'dependency-groups') for (const v of kv.values()) for (const s of quoted(v)) out.add(depName(s));
    if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(t) || t === 'tool.poetry.dev-dependencies') for (const k of kv.keys()) out.add(depName(k));
  }
  return out;
}

function detectPython(dir, text, problems, manifest) {
  let tables = new Map();
  let extra = [];
  let name = null;
  if (manifest.endsWith('pyproject.toml')) {
    const parsed = parseToml(text);
    tables = parsed.tables;
    if (parsed.error !== null) problems.push({ file: manifest, message: `pyproject.toml does not parse: ${parsed.error}` });
    name = unquote(tables.get('project')?.get('name')) ?? unquote(tables.get('tool.poetry')?.get('name'));
  } else {
    extra = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l !== '' && !l.startsWith('-'));
  }
  const deps = pyDeps(tables, extra);
  const has = (t) => [...tables.keys()].some((k) => k === t || k.startsWith(`${t}.`));
  const pytest = deps.has('pytest') || has('tool.pytest');
  const lintTool = has('tool.ruff') || deps.has('ruff') ? 'ruff check .' : deps.has('flake8') ? 'flake8' : deps.has('pylint') ? 'pylint .' : null;
  const build = tables.has('build-system') ? 'python -m build' : null;
  return {
    name,
    language: 'Python',
    framework: firstMatch(PY_FRAMEWORKS, (d) => deps.has(d)),
    test: inDir(dir, pytest ? 'python -m pytest' : null),
    lint: inDir(dir, lintTool),
    build: inDir(dir, build),
  };
}

function detectGo(dir, files, rawText) {
  const text = shortLines(rawText);
  const requires = [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v[0-9]/gm)].map((m) => m[1]);
  const lint = [...files].some((f) => posix.dirname(f) === dir && /^\.golangci\.(ya?ml|toml|json)$/.test(posix.basename(f))) ? 'golangci-lint run' : 'go vet ./...';
  return {
    name: /^module\s+(\S+)/m.exec(text)?.[1] ?? null,
    language: 'Go',
    framework: firstMatch(GO_FRAMEWORKS, (d) => requires.some((r) => r === d || r.startsWith(`${d}/`))),
    test: inDir(dir, 'go test ./...'),
    lint: inDir(dir, lint),
    build: inDir(dir, 'go build ./...'),
  };
}

function detectRust(dir, text, problems, manifest) {
  const { tables, error } = parseToml(text);
  if (error !== null) problems.push({ file: manifest, message: `Cargo.toml does not parse: ${error}` });
  const deps = new Set();
  for (const [t, kv] of tables) if (/^(dev-|build-)?dependencies$|^workspace\.dependencies$|^target\..+\.dependencies$/.test(t)) for (const k of kv.keys()) deps.add(k.split('.')[0]);
  return {
    name: unquote(tables.get('package')?.get('name')),
    language: 'Rust',
    framework: firstMatch(RUST_FRAMEWORKS, (d) => deps.has(d)),
    test: inDir(dir, 'cargo test'),
    lint: inDir(dir, 'cargo clippy'),
    build: inDir(dir, 'cargo build'),
    workspace: tables.has('workspace') ? tables : null,
    hasPackage: tables.has('package'),
  };
}

function detectMaven(dir, files, text, problems, manifest) {
  if (!/<project[\s>]/.test(text) || !/<\/project>/.test(text)) problems.push({ file: manifest, message: 'pom.xml does not parse: no <project> element or it is not closed' });
  const parentAt = text.indexOf('<parent>');
  const parentEnd = parentAt < 0 ? -1 : text.indexOf('</parent>', parentAt);
  const withoutParent = parentEnd < 0 ? text : text.slice(0, parentAt) + text.slice(parentEnd + '</parent>'.length);
  const artifact = /<artifactId>([^<]{1,300})<\/artifactId>/.exec(withoutParent)?.[1] ?? null;
  const wrapper = files.has(posix.join(dir, 'mvnw'));
  const mvn = wrapper ? './mvnw' : 'mvn';
  return {
    name: artifact,
    language: 'Java',
    framework: /spring-boot/.test(text) ? 'Spring Boot' : /quarkus/.test(text) ? 'Quarkus' : null,
    test: inDir(dir, `${mvn} test`),
    lint: inDir(dir, /maven-checkstyle-plugin/.test(text) ? `${mvn} checkstyle:check` : null),
    build: inDir(dir, `${mvn} package`),
  };
}

function detectRuby(dir, rawText) {
  const text = shortLines(rawText);
  const gems = new Set([...text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]));
  return {
    name: null,
    language: 'Ruby',
    framework: gems.has('rails') ? 'Rails' : gems.has('sinatra') ? 'Sinatra' : gems.has('hanami') ? 'Hanami' : null,
    test: inDir(dir, gems.has('rspec') || gems.has('rspec-rails') ? 'bundle exec rspec' : gems.has('rails') ? 'bin/rails test' : gems.has('minitest') ? 'bundle exec rake test' : null),
    lint: inDir(dir, gems.has('rubocop') ? 'bundle exec rubocop' : null),
    build: null,
  };
}

function detectPhp(dir, text, problems, manifest) {
  let json;
  try {
    json = JSON.parse(text);
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('the top level is not an object');
  } catch (err) {
    problems.push({ file: manifest, message: `composer.json does not parse: ${err.message}` });
    return { name: null, language: 'PHP', framework: null, test: null, lint: null, build: null };
  }
  const deps = new Set([...Object.keys(json.require ?? {}), ...Object.keys(json['require-dev'] ?? {})]);
  const scripts = json.scripts !== null && typeof json.scripts === 'object' ? json.scripts : {};
  return {
    name: typeof json.name === 'string' ? json.name : null,
    language: 'PHP',
    framework: firstMatch(PHP_FRAMEWORKS, (d) => deps.has(d)),
    test: inDir(dir, 'test' in scripts ? 'composer test' : deps.has('phpunit/phpunit') ? 'vendor/bin/phpunit' : null),
    lint: inDir(dir, 'lint' in scripts ? 'composer lint' : null),
    build: null,
  };
}

function detectGradle(dir, files, text, manifest) {
  const body = shortLines(text);
  let wrapper = null;
  for (let d = dir; wrapper === null; d = posix.dirname(d)) {
    if (files.has(posix.join(d, 'gradlew'))) wrapper = d === dir ? './gradlew' : `${posix.relative(dir, d)}/gradlew`;
    if (d === '.') break;
  }
  const gw = wrapper ?? 'gradle';
  const lintTask = /spotless/.test(body) ? 'spotlessCheck' : /detekt/.test(body) ? 'detekt' : /checkstyle/.test(body) ? 'checkstyleMain' : /ktlint/.test(body) ? 'ktlintCheck' : null;
  return {
    name: null,
    language: manifest.endsWith('.kts') || /kotlin/.test(body) ? 'Kotlin' : 'Java',
    framework: /spring-boot|springframework\.boot/.test(body) ? 'Spring Boot' : /quarkus/.test(body) ? 'Quarkus' : /com\.android\./.test(body) ? 'Android' : null,
    test: inDir(dir, `${gw} test`),
    lint: inDir(dir, lintTask === null ? null : `${gw} ${lintTask}`),
    build: inDir(dir, `${gw} build`),
  };
}

/** The project paths a `settings.gradle(.kts)` includes: `include(":app", ":libs:core")` gives app and libs/core. */
function gradleIncludes(text) {
  const out = [];
  for (const line of shortLines(text).split('\n')) {
    if (!/^\s*include\b/.test(line)) continue;
    for (const m of line.matchAll(/['"]:?([A-Za-z0-9_.:/-]{1,200})['"]/g)) out.push(m[1].replaceAll(':', '/'));
  }
  return out;
}

// ---- workspaces ----

/** One path segment against a pattern with `*` and `?`, iterative with a single backtrack point: no regular expression. */
function matchSegment(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** A glob against a path, by segments; `**` matches one or more segments. Memoised, so the work is bounded by segments squared. */
function matchGlob(glob, path) {
  const g = glob.replace(/^\.\//, '').replace(/\/$/, '').split('/');
  const s = path.split('/');
  const memo = new Map();
  const go = (i, j) => {
    const key = i * (s.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let ok;
    if (i === g.length) ok = j === s.length;
    else if (g[i] === '**') ok = j < s.length && (go(i + 1, j + 1) || go(i, j + 1));
    else ok = j < s.length && matchSegment(g[i], s[j]) && go(i + 1, j + 1);
    memo.set(key, ok);
    return ok;
  };
  return go(0, 0);
}

/** Whether a glob is small enough to match: its length and its number of stars are bounded. */
const sane = (glob) => glob.length <= MAX_GLOB && (glob.match(/\*/g)?.length ?? 0) <= MAX_STARS;

const matchesGlobs = (path, globs) => {
  let ok = false;
  for (const g of globs) {
    if (g.startsWith('!')) {
      if (matchGlob(g.slice(1), path)) ok = false;
    } else if (matchGlob(g, path)) ok = true;
  }
  return ok;
};

/** Workspace globs declared by a package.json (`workspaces` as an array or `{packages}`), by pnpm-workspace.yaml or by Cargo. */
function workspaceGlobs(kind, data) {
  if (kind === 'npm') {
    const w = data?.workspaces;
    const list = Array.isArray(w) ? w : Array.isArray(w?.packages) ? w.packages : null;
    return list === null ? null : list.filter((x) => typeof x === 'string');
  }
  return data;
}

// ---- CI, conventions, debt, docs ----

function scanCi(repo, files, problems) {
  const out = [];
  for (const f of files) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) {
      const r = readText(join(repo, f));
      let jobs = [];
      if (r?.text === undefined) problems.push({ file: f, message: 'workflow file could not be read' });
      else {
        try {
          const doc = parseYaml(r.text);
          if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the top level is not a mapping');
          jobs = doc.jobs !== null && typeof doc.jobs === 'object' && !Array.isArray(doc.jobs) ? Object.keys(doc.jobs) : [];
        } catch (err) {
          problems.push({ file: f, message: `workflow does not parse: ${String(err.message).split('\n')[0]}` });
        }
      }
      out.push({ file: f, jobs });
    } else if (f === '.gitlab-ci.yml' || f === 'Jenkinsfile' || f === '.circleci/config.yml') out.push({ file: f, jobs: [] });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test|tests|ci|build|perf|style|revert)(\([^)]+\))?!?: \S/;
const BRANCH_PREFIXES = ['feat', 'feature', 'fix', 'bugfix', 'hotfix', 'chore', 'docs', 'refactor', 'test', 'release', 'ci'];

async function gitLines(exec, repo, args) {
  try {
    const r = await exec('git', ['-C', repo, '-c', 'log.showSignature=false', ...args]);
    if (r.code !== 0) return null;
    return String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  } catch {
    return null;
  }
}

async function scanConventions(repo, files, manifestInfo, exec) {
  const subjects = await gitLines(exec, repo, ['log', '--no-merges', '--format=%s', '-n', '200']);
  const conventional = (subjects ?? []).filter((s) => CONVENTIONAL.test(s));
  let style = 'unknown';
  if (subjects !== null && subjects.length > 0) style = conventional.length * 2 >= subjects.length ? 'conventional' : 'free-form';
  else if (subjects !== null) style = 'none';
  const branches = await gitLines(exec, repo, ['branch', '-a', '--format=%(refname:short)']);
  const prefixes = {};
  for (const b of branches ?? []) {
    const name = b.replace(/^origin\//, '');
    if (name === 'HEAD' || name.startsWith('(') || name.startsWith('HEAD ')) continue;
    const p = name.includes('/') ? name.split('/')[0] : null;
    if (p !== null && BRANCH_PREFIXES.includes(p)) prefixes[p] = (prefixes[p] ?? 0) + 1;
  }
  const count = (branches ?? []).filter((b) => !/^(origin\/)?HEAD\b|^\(/.test(b)).length;
  const branchStyle = branches === null ? 'unknown' : Object.keys(prefixes).length > 0 ? 'prefixed' : 'plain';
  return {
    commits: { style, count: (subjects ?? []).length, conventional: conventional.length, examples: (subjects ?? []).slice(0, 3) },
    branches: { style: branchStyle, count, prefixes },
    formatter: formatters(files, manifestInfo),
  };
}

function formatters(files, manifestInfo) {
  const out = new Set();
  const names = [...files].filter((f) => !f.includes('/')).map((f) => f);
  const rootFile = (re) => names.some((f) => re.test(f));
  if (rootFile(/^\.prettierrc(\.[a-z]+)?$|^prettier\.config\.[a-z]+$/) || manifestInfo.prettier) out.add('prettier');
  if (rootFile(/^biome\.jsonc?$/)) out.add('biome');
  if (rootFile(/^\.editorconfig$/)) out.add('editorconfig');
  if (rootFile(/^\.?rustfmt\.toml$/)) out.add('rustfmt');
  if (rootFile(/^\.clang-format$/)) out.add('clang-format');
  if (rootFile(/^\.php-cs-fixer(\.dist)?\.php$/)) out.add('php-cs-fixer');
  for (const t of manifestInfo.pyFormatters) out.add(t);
  if (manifestInfo.hasGo) out.add('gofmt');
  return [...out].sort();
}

const SKIP_PATTERNS = [
  /\b(?:it|test|describe)\.skip\s*\(/g, /\bx(?:it|describe|test)\s*\(/g, /@pytest\.mark\.skip\b/g, /@unittest\.skip\b/g,
  /\bt\.Skip(?:Now)?\s*\(/g, /@Disabled\b/g, /@Ignore\b/g,
];
const RUST_IGNORE = /#\[ignore\b/g;
const countMatches = (text, re) => text.match(re)?.length ?? 0;

function scanDebt(repo, files) {
  const debt = { todo: 0, fixme: 0, skippedTests: 0, largeFiles: [] };
  for (const f of files) {
    const base = posix.basename(f);
    if (LOCKFILES.has(base) || /\.(min\.js|map|svg|png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|eot|jar|class|so|dll|exe|wasm|lock)$/i.test(base)) continue;
    const abs = join(repo, f);
    const st = safe(() => lstatSync(abs), null);
    if (st === null || !st.isFile()) continue;
    if (st.size > LARGE_BYTES) {
      debt.largeFiles.push({ path: f, lines: null, bytes: st.size });
      continue;
    }
    if (looksBinary(abs)) continue;
    const r = readText(abs);
    if (r?.text === undefined) continue;
    const { text } = r;
    debt.todo += countMatches(text, /\bTODO\b/g);
    debt.fixme += countMatches(text, /\bFIXME\b/g);
    if (isTestPath(f)) for (const re of SKIP_PATTERNS) debt.skippedTests += countMatches(text, re);
    if (f.endsWith('.rs')) debt.skippedTests += countMatches(text, RUST_IGNORE);
    const lines = text === '' ? 0 : text.split('\n').length;
    if (lines >= LARGE_LINES) debt.largeFiles.push({ path: f, lines, bytes: st.size });
  }
  debt.largeFiles.sort((a, b) => (b.bytes - a.bytes) || (a.path < b.path ? -1 : 1));
  debt.largeFiles = debt.largeFiles.slice(0, MAX_LISTED);
  return debt;
}

const DOC_ROOT = /^(README|CONTRIBUTING|ARCHITECTURE|CHANGELOG|SECURITY|CODE_OF_CONDUCT|CLAUDE|AGENTS)(\.[A-Za-z]+)?$/;
const DOC_EXT = /\.(md|mdx|rst|adoc|txt)$/i;

function scanDocs(files, packageDirs) {
  const out = new Set();
  for (const f of files) {
    const dir = posix.dirname(f);
    const base = posix.basename(f);
    if (dir === '.' && DOC_ROOT.test(base)) out.add(f);
    else if (/^docs?(\/|$)/i.test(dir === '.' ? '' : dir) && DOC_EXT.test(base)) out.add(f);
    else if (/^README(\.[A-Za-z]+)?$/.test(base) && packageDirs.has(dir)) out.add(f);
    else if (/^(adr|adrs|decisions)(\/|$)/i.test(dir) && DOC_EXT.test(base)) out.add(f);
  }
  return [...out].sort().slice(0, MAX_DOCS);
}

// ---- the scan ----

/**
 * Inventory of a repository: its packages (one per manifest, a workspace root with member packages is not a package),
 * its CI files, its conventions, its visible debt and its documents. Read only.
 * @param {string} repo the repository root
 * @param {{exec?: (cmd: string, args: string[]) => Promise<{code: number, stdout?: string}>}} [options]
 * @returns {Promise<Inventory>}
 * @throws {Error} when `repo` is not a readable folder
 */
export async function scan(repo, { exec = async () => ({ code: 127, stdout: '' }), limits = {} } = {}) {
  const st = safe(() => lstatSync(repo), null);
  if (st === null || !st.isDirectory()) throw new Error(`Not a folder: ${repo}`);
  const problems = [];
  const { files, truncated } = walk(repo, { maxDepth: limits.maxDepth ?? MAX_DEPTH, maxFiles: limits.maxFiles ?? MAX_FILES, maxDirs: limits.maxDirs ?? MAX_DIRS }, problems);
  const fileSet = new Set(files);
  const ownCode = new Set();
  const settings = [];

  const packages = [];
  const workspaces = [];
  const roots = [];
  const manifestInfo = { prettier: false, pyFormatters: new Set(), hasGo: false };

  const manifestFiles = files.filter((f) => MANIFESTS.has(posix.basename(f)));
  const pyprojectDirs = new Set(manifestFiles.filter((f) => posix.basename(f) === 'pyproject.toml').map((f) => posix.dirname(f)));
  for (const manifest of manifestFiles) {
    const dir = posix.dirname(manifest);
    const base = posix.basename(manifest);
    if (base === 'requirements.txt' && pyprojectDirs.has(dir)) continue;
    const r = readText(join(repo, manifest));
    if (r === null) continue;
    if (r.tooLarge) {
      problems.push({ file: manifest, message: `${base} is larger than 1 MiB and was not read` });
      continue;
    }
    const { text } = r;
    let found;
    if (base === 'package.json') found = detectNode(repo, dir, fileSet, text, problems, manifest);
    else if (base === 'pyproject.toml' || base === 'requirements.txt') found = detectPython(dir, text, problems, manifest);
    else if (base === 'go.mod') found = detectGo(dir, fileSet, text);
    else if (base === 'Cargo.toml') found = detectRust(dir, text, problems, manifest);
    else if (base === 'pom.xml') found = detectMaven(dir, fileSet, text, problems, manifest);
    else if (base === 'Gemfile') found = detectRuby(dir, text);
    else if (base === 'composer.json') found = detectPhp(dir, text, problems, manifest);
    else if (base.startsWith('settings.gradle')) {
      const globs = gradleIncludes(text);
      roots.push({ root: dir, manager: 'gradle', globs, manifest });
      settings.push({ dir, manifest });
      continue;
    } else found = detectGradle(dir, fileSet, text, manifest);

    if (base === 'package.json' && found.pkg !== null) {
      const globs = workspaceGlobs('npm', found.pkg);
      if (globs !== null) roots.push({ root: dir, manager: found.manager, globs, manifest });
      if (found.pkg.prettier !== undefined || nodeDeps(found.pkg).has('prettier')) manifestInfo.prettier = true;
      if (hasOwnCode(found.pkg)) ownCode.add(manifest);
    }
    if (base === 'pyproject.toml') {
      const { tables } = parseToml(text);
      if ([...tables.keys()].some((k) => k === 'tool.black' || k.startsWith('tool.black.'))) manifestInfo.pyFormatters.add('black');
      if (tables.has('tool.ruff.format') || tables.has('tool.ruff')) manifestInfo.pyFormatters.add('ruff');
    }
    if (base === 'go.mod') manifestInfo.hasGo = true;
    if (base === 'Cargo.toml' && found.workspace !== null) {
      const members = quoted(found.workspace.get('workspace')?.get('members'));
      roots.push({ root: dir, manager: 'cargo', globs: members, manifest });
      if (!found.hasPackage) continue;
    }
    packages.push({
      path: dir, name: cleanText(found.name), manifest, language: found.language, framework: found.framework,
      testCommand: found.test, lintCommand: found.lint, buildCommand: found.build,
    });
  }

  // a Gradle build with a settings file and no build file anywhere is still one package
  if (settings.length > 0 && !packages.some((p) => /build\.gradle(\.kts)?$/.test(p.manifest))) {
    const { dir, manifest } = settings[0];
    const found = detectGradle(dir, fileSet, '', manifest);
    packages.push({ path: dir, name: null, manifest, language: found.language, framework: null, testCommand: found.test, lintCommand: null, buildCommand: found.build });
  }

  // pnpm workspaces
  for (const f of files.filter((x) => posix.basename(x) === 'pnpm-workspace.yaml')) {
    const r = readText(join(repo, f));
    if (r?.text === undefined) continue;
    try {
      const doc = parseYaml(r.text);
      const globs = Array.isArray(doc?.packages) ? doc.packages.filter((x) => typeof x === 'string') : [];
      roots.push({ root: posix.dirname(f), manager: 'pnpm', globs, manifest: f });
    } catch (err) {
      problems.push({ file: f, message: `pnpm-workspace.yaml does not parse: ${String(err.message).split('\n')[0]}` });
    }
  }
  for (const w of roots) {
    const globs = w.globs.filter((g) => {
      if (sane(g)) return true;
      problems.push({ file: w.manifest, message: `workspace glob too long or too complex, ignored: ${cleanText(g, 40)}` });
      return false;
    });
    const members = packages.filter((p) => p.path !== w.root && (w.root === '.' || p.path.startsWith(`${w.root}/`)) && matchesGlobs(w.root === '.' ? p.path : p.path.slice(w.root.length + 1), globs)).map((p) => p.path);
    workspaces.push({ root: w.root, manager: w.manager, globs: w.globs, members });
  }
  // a workspace root that only holds its members (no application code of its own) is not a package
  const rootsWithMembers = new Set(workspaces.filter((w) => w.members.length > 0).map((w) => w.root));
  for (let i = packages.length - 1; i >= 0; i--) {
    const p = packages[i];
    if (p.manifest.endsWith('package.json') && rootsWithMembers.has(p.path) && !ownCode.has(p.manifest)) packages.splice(i, 1);
  }
  packages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.manifest < b.manifest ? -1 : 1));
  workspaces.sort((a, b) => (a.root < b.root ? -1 : 1));

  const ci = scanCi(repo, files, problems);
  const conventions = await scanConventions(repo, fileSet, manifestInfo, exec);
  const debt = scanDebt(repo, files);
  const docs = scanDocs(files, new Set(packages.map((p) => p.path)));
  const packageDirs = new Set(packages.map((p) => p.path));
  const pyprojectIn = new Set(manifestFiles.filter((f) => posix.basename(f) === 'pyproject.toml').map((f) => posix.dirname(f)));
  let unrecognised = 0;
  for (const f of files) {
    const base = posix.basename(f);
    const dir = posix.dirname(f);
    if (!UNRECOGNISED.test(base) || packageDirs.has(dir) || (/^setup\.(py|cfg)$/.test(base) && pyprojectIn.has(dir))) continue;
    if (++unrecognised > MAX_UNRECOGNISED) break;
    problems.push({ file: f, message: 'build file not recognised by the scan: describe it by hand in the inventory' });
  }
  for (const c of ci) c.jobs = c.jobs.map((j) => cleanText(j, 100));
  conventions.commits.examples = conventions.commits.examples.map((e) => cleanText(e, 200));
  const clean = problems.map((p) => ({ file: cleanText(p.file), message: cleanText(p.message) }));
  return { packages, workspaces, ci, conventions, debt, docs, problems: clean, truncated };
}

/** A workspace root that is also an application: it has its own source or framework, so it stays a package. */
function hasOwnCode(pkg) {
  const deps = nodeDeps(pkg);
  return [...deps].some((d) => NODE_FRAMEWORKS.some(([f]) => f === d)) || typeof pkg.main === 'string' || (pkg.bin !== undefined && pkg.bin !== null);
}

/**
 * The inventory as plain lines for the terminal.
 * @param {Inventory} inv
 * @returns {string}
 */
export function renderInventory(inv) {
  const c = (v) => cleanText(v);
  const out = [];
  out.push(`Packages: ${inv.packages.length}`);
  for (const p of inv.packages) {
    out.push(`- ${c(p.path)} (${c(p.manifest)}): ${c(p.language)}${p.framework ? `, ${c(p.framework)}` : ''}`);
    out.push(`  test: ${c(p.testCommand) ?? 'none found'}; lint: ${c(p.lintCommand) ?? 'none found'}; build: ${c(p.buildCommand) ?? 'none found'}`);
  }
  for (const w of inv.workspaces) out.push(`Workspace root ${c(w.root)} (${c(w.manager)}): ${w.members.length} member(s)`);
  out.push(`CI: ${inv.ci.length === 0 ? 'none found' : inv.ci.map((x) => `${c(x.file)} (${x.jobs.length} job(s))`).join(', ')}`);
  const cv = inv.conventions;
  out.push(`Commits: ${cv.commits.style} (${cv.commits.conventional} of ${cv.commits.count} conventional); branches: ${cv.branches.style}; formatter: ${cv.formatter.map(c).join(', ') || 'none found'}`);
  out.push(`Debt: ${inv.debt.todo} TODO, ${inv.debt.fixme} FIXME, ${inv.debt.skippedTests} skipped test(s), ${inv.debt.largeFiles.length} large file(s)`);
  out.push(`Documents: ${inv.docs.length}`);
  for (const p of inv.problems) out.push(`Problem: ${c(p.file)}: ${c(p.message)}`);
  if (inv.truncated) out.push('The scan stopped at its limits (files, folders or depth): the inventory may be incomplete.');
  return `${out.join('\n')}\n`;
}

/**
 * The inventory of a workspace: each repository of the registry, scanned on its own in `repos/<name>/`, in registry
 * order. A registered repository whose folder is missing (not cloned on this machine) is listed in `missing`.
 * @param {string} ws workspace folder
 * @param {{exec?: (cmd: string, args: string[]) => Promise<{code: number, stdout?: string}>, limits?: object}} [options]
 * @returns {Promise<{repos: {name: string, path: string, inventory: Inventory}[], missing: string[]}>}
 */
export async function scanWorkspace(ws, options = {}) {
  const repos = [];
  const missing = [];
  for (const { name } of listRepos(ws)) {
    const dir = join(ws, 'repos', name);
    if (safe(() => lstatSync(dir).isDirectory(), false)) repos.push({ name, path: `repos/${name}`, inventory: await scan(dir, options) });
    else missing.push(name);
  }
  return { repos, missing };
}

/**
 * The workspace inventory as plain lines for the terminal: one section `## Repository <name> (repos/<name>)` for each
 * repository, with what `renderInventory` prints, then a line for each repository that is not cloned.
 * @param {{repos: {name: string, path: string, inventory: Inventory}[], missing: string[]}} result
 * @returns {string}
 */
export function renderWorkspaceInventory({ repos, missing }) {
  const out = repos.map((r) => `## Repository ${cleanText(r.name)} (${cleanText(r.path)})\n\n${renderInventory(r.inventory)}`);
  for (const name of missing) out.push(`Not cloned: ${cleanText(name)} (run recade repo sync)\n`);
  return out.join('\n');
}
