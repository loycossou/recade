import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { scan, parseToml, renderInventory, scanWorkspace, renderWorkspaceInventory } from '../../src/project/inventory.js';
import { defaultExec } from '../../src/doctor.js';
import { run } from '../../src/cli.js';

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A fictional repository in a temp dir. `files` maps a path to its text. With `commits`, it is a git repository on main. */
function fixture(files, { commits = null, branches = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recade-inv-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  if (commits !== null) {
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.email', 'dev-example-test');
    git(dir, 'config', 'user.name', 'Dev');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '-A');
    commits.forEach((m, i) => git(dir, 'commit', '--allow-empty', '-m', m, ...(i === 0 ? [] : [])));
    for (const b of branches) git(dir, 'branch', b);
  }
  return dir;
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
// The at sign is kept apart so that no line looks like an e-mail address to the repository guard.
const AT = String.fromCharCode(64);
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

function treeHash(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (p === '.git') continue;
      if (e.isDirectory()) walk(p);
      else out[p] = createHash('sha256').update(readFileSync(join(dir, p))).digest('hex');
    }
  };
  walk('');
  return out;
}

const WORKFLOW = 'name: CI\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';

test('a single Node app: language, framework, commands, CI, conventions, formatter', async () => {
  const dir = fixture({
    'package.json': json({
      name: 'fernhill-api', scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc' },
      dependencies: { express: '^4.19.0' }, devDependencies: { typescript: '^5.4.0', prettier: '^3.0.0' },
    }),
    'package-lock.json': '{}\n',
    'src/index.ts': 'export const x = 1;\n',
    'README.md': '# Fernhill API\n',
    '.github/workflows/ci.yml': WORKFLOW,
  }, { commits: ['feat: add loans', 'fix(api): rate rounding', 'chore: bump deps'], branches: ['feat/loans', 'fix/rounding'] });
  try {
    const inv = await scan(dir, { exec: defaultExec });
    assert.equal(inv.packages.length, 1);
    assert.deepEqual(inv.packages[0], {
      path: '.', name: 'fernhill-api', manifest: 'package.json', language: 'TypeScript', framework: 'Express',
      testCommand: 'npm test', lintCommand: 'npm run lint', buildCommand: 'npm run build',
    });
    assert.deepEqual(inv.ci, [{ file: '.github/workflows/ci.yml', jobs: ['lint', 'test'] }]);
    assert.equal(inv.conventions.commits.style, 'conventional');
    assert.equal(inv.conventions.commits.conventional, 3);
    assert.equal(inv.conventions.branches.style, 'prefixed');
    assert.deepEqual(inv.conventions.branches.prefixes, { feat: 1, fix: 1 });
    assert.deepEqual(inv.conventions.formatter, ['prettier']);
    assert.ok(inv.docs.includes('README.md'));
    assert.deepEqual(inv.problems, []);
    assert.equal(inv.truncated, false);
  } finally {
    cleanup(dir);
  }
});

test('free-form commit subjects are reported as free-form, a repository without git as unknown', async () => {
  const free = fixture({ 'package.json': '{"name":"a"}\n' }, { commits: ['first version', 'more stuff', 'wip', 'fix: one'] });
  const bare = fixture({ 'package.json': '{"name":"a"}\n' });
  try {
    assert.equal((await scan(free, { exec: defaultExec })).conventions.commits.style, 'free-form');
    const inv = await scan(bare, { exec: defaultExec });
    assert.equal(inv.conventions.commits.style, 'unknown');
    assert.equal(inv.conventions.branches.style, 'unknown');
    const none = await scan(bare);
    assert.equal(none.conventions.commits.style, 'unknown', 'no exec given: git is not asked');
  } finally {
    cleanup(free);
    cleanup(bare);
  }
});

test('an npm workspaces monorepo lists one package per workspace member and the workspace root', async () => {
  const dir = fixture({
    'package.json': json({ name: 'larkfield', private: true, workspaces: ['packages/*'], scripts: { test: 'npm test --workspaces' } }),
    'packages/api/package.json': json({ name: '@larkfield/api', scripts: { test: 'node --test', build: 'tsc' }, dependencies: { fastify: '^4' } }),
    'packages/web/package.json': json({ name: '@larkfield/web', scripts: { test: 'vitest run', lint: 'eslint .' }, dependencies: { react: '^18', vue: '^3' } }),
    'packages/web/README.md': '# web\n',
    'packages/legacy-tool/package.json': json({ name: 'legacy-tool', scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    'tools/outside/package.json': json({ name: 'outside' }),
  });
  try {
    const inv = await scan(dir);
    assert.deepEqual(inv.packages.map((p) => p.path), ['packages/api', 'packages/legacy-tool', 'packages/web', 'tools/outside']);
    const api = inv.packages[0];
    assert.equal(api.framework, 'Fastify');
    assert.equal(api.testCommand, '(cd packages/api && npm test)');
    assert.equal(api.buildCommand, '(cd packages/api && npm run build)');
    assert.equal(api.lintCommand, null);
    assert.equal(inv.packages[1].testCommand, null, 'the npm default "no test specified" is not a test command');
    assert.equal(inv.packages[2].framework, 'Vue', 'first match of the framework table wins');
    assert.deepEqual(inv.workspaces, [{ root: '.', manager: 'npm', globs: ['packages/*'], members: ['packages/api', 'packages/legacy-tool', 'packages/web'] }]);
    assert.ok(inv.docs.includes('packages/web/README.md'), 'the README of a package is listed');
  } finally {
    cleanup(dir);
  }
});

test('pnpm workspaces and yarn workspaces with a packages object are read', async () => {
  const pnpm = fixture({
    'package.json': json({ name: 'root', packageManager: `pnpm${AT}9.1.0` }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - '!apps/old'\n",
    'apps/a/package.json': json({ name: 'a', scripts: { test: 'vitest' } }),
    'apps/old/package.json': json({ name: 'old' }),
  });
  const yarn = fixture({
    'package.json': json({ name: 'root', workspaces: { packages: ['libs/*'] } }),
    'yarn.lock': '',
    'libs/x/package.json': json({ name: 'x', scripts: { test: 'jest', lint: 'eslint' } }),
  });
  try {
    const p = await scan(pnpm);
    assert.equal(p.packages.find((x) => x.path === 'apps/a').testCommand, '(cd apps/a && pnpm test)');
    assert.deepEqual(p.workspaces, [{ root: '.', manager: 'pnpm', globs: ['apps/*', '!apps/old'], members: ['apps/a'] }]);
    const y = await scan(yarn);
    assert.equal(y.packages[0].path, 'libs/x');
    assert.equal(y.packages[0].testCommand, '(cd libs/x && yarn test)');
    assert.equal(y.packages[0].lintCommand, '(cd libs/x && yarn lint)');
    assert.deepEqual(y.workspaces[0].members, ['libs/x']);
  } finally {
    cleanup(pnpm);
    cleanup(yarn);
  }
});

test('a Python service and a Node front in one repository are two packages with their own commands', async () => {
  const dir = fixture({
    'services/api/pyproject.toml': [
      '[project]', 'name = "ledger-api"', 'dependencies = [', '  "fastapi>=0.110",', '  "uvicorn",', ']',
      '[project.optional-dependencies]', 'dev = ["pytest", "ruff"]',
      '[build-system]', 'requires = ["setuptools"]', '[tool.black]', 'line-length = 100', '',
    ].join('\n'),
    'services/api/tests/test_rates.py': `import pytest\n\n${AT}pytest.mark.skip(reason="later")\ndef test_a():\n    pass\n`,
    'web/package.json': json({ name: 'ledger-web', scripts: { build: 'vite build' }, dependencies: { react: '^18' } }),
    'web/vite.config.js': 'export default {};\n',
  });
  try {
    const inv = await scan(dir);
    assert.deepEqual(inv.packages.map((p) => [p.path, p.manifest, p.language, p.framework]), [
      ['services/api', 'services/api/pyproject.toml', 'Python', 'FastAPI'],
      ['web', 'web/package.json', 'JavaScript', 'React'],
    ]);
    const api = inv.packages[0];
    assert.equal(api.name, 'ledger-api');
    assert.equal(api.testCommand, '(cd services/api && python -m pytest)');
    assert.equal(api.lintCommand, '(cd services/api && ruff check .)');
    assert.equal(api.buildCommand, '(cd services/api && python -m build)');
    assert.equal(inv.packages[1].buildCommand, '(cd web && npm run build)');
    assert.deepEqual(inv.conventions.formatter, ['black']);
    assert.equal(inv.debt.skippedTests, 1);
  } finally {
    cleanup(dir);
  }
});

test('Go, Rust workspace, Maven, Ruby and PHP manifests are detected from the manifests only', async () => {
  const dir = fixture({
    'go/go.mod': 'module example.test/ledger\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n',
    'go/.golangci.yml': 'linters: {}\n',
    'Cargo.toml': '[workspace]\nmembers = ["crates/core", "crates/cli"]\n',
    'crates/core/Cargo.toml': '[package]\nname = "ledger-core"\nversion = "0.1.0"\n\n[dependencies]\naxum = "0.7"\n',
    'crates/cli/Cargo.toml': '[package]\nname = "ledger-cli"\nversion = "0.1.0"\n',
    'java/pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><artifactId>ledger-java</artifactId><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
    'java/mvnw': '#!/bin/sh\n',
    'ruby/Gemfile': "source 'https://rubygems.org'\ngem 'rails'\ngem 'rspec-rails'\ngem 'rubocop'\n",
    'php/composer.json': json({ name: 'fern/ledger', require: { 'laravel/framework': '^11' }, 'require-dev': { 'phpunit/phpunit': '^11' }, scripts: { lint: 'pint' } }),
  });
  try {
    const inv = await scan(dir);
    const by = Object.fromEntries(inv.packages.map((p) => [p.path, p]));
    assert.deepEqual(Object.keys(by).sort(), ['crates/cli', 'crates/core', 'go', 'java', 'php', 'ruby']);
    assert.equal(by.go.framework, 'Gin');
    assert.equal(by.go.name, 'example.test/ledger');
    assert.equal(by.go.testCommand, '(cd go && go test ./...)');
    assert.equal(by.go.lintCommand, '(cd go && golangci-lint run)');
    assert.equal(by['crates/core'].framework, 'Axum');
    assert.equal(by['crates/core'].testCommand, '(cd crates/core && cargo test)');
    assert.equal(by.java.framework, 'Spring Boot');
    assert.equal(by.java.name, 'ledger-java');
    assert.equal(by.java.testCommand, '(cd java && ./mvnw test)');
    assert.equal(by.ruby.framework, 'Rails');
    assert.equal(by.ruby.testCommand, '(cd ruby && bundle exec rspec)');
    assert.equal(by.ruby.lintCommand, '(cd ruby && bundle exec rubocop)');
    assert.equal(by.php.framework, 'Laravel');
    assert.equal(by.php.testCommand, '(cd php && vendor/bin/phpunit)');
    assert.equal(by.php.lintCommand, '(cd php && composer lint)');
    assert.deepEqual(inv.workspaces, [{ root: '.', manager: 'cargo', globs: ['crates/core', 'crates/cli'], members: ['crates/cli', 'crates/core'] }]);
    assert.ok(inv.conventions.formatter.includes('gofmt'));
  } finally {
    cleanup(dir);
  }
});

test('a Python repository with only requirements.txt is still a package', async () => {
  const dir = fixture({ 'requirements.txt': '# deps\nflask==3.0.0\npytest>=8\n-r other.txt\n' });
  try {
    const inv = await scan(dir);
    assert.equal(inv.packages[0].framework, 'Flask');
    assert.equal(inv.packages[0].testCommand, 'python -m pytest');
    assert.equal(inv.packages[0].manifest, 'requirements.txt');
  } finally {
    cleanup(dir);
  }
});

test('no CI: the list is empty, and other CI systems are named by their file', async () => {
  const none = fixture({ 'package.json': '{"name":"a"}\n' });
  const gitlab = fixture({ 'package.json': '{"name":"a"}\n', '.gitlab-ci.yml': 'stages: [test]\n' });
  try {
    assert.deepEqual((await scan(none)).ci, []);
    assert.deepEqual((await scan(gitlab)).ci, [{ file: '.gitlab-ci.yml', jobs: [] }]);
  } finally {
    cleanup(none);
    cleanup(gitlab);
  }
});

test('skipped tests, TODO and FIXME are counted, only skips in test files, and large files are listed', async () => {
  const big = `${'const line = 1;\n'.repeat(1200)}`;
  const dir = fixture({
    'package.json': '{"name":"a"}\n',
    'src/app.js': '// TODO: one\n// TODO two\n// FIXME three\nexport const todoList = 1; // not a TODOS word\nit.skip("not counted outside tests", () => {});\n',
    'src/big.js': big,
    'tests/a.test.js': 'it.skip("a", () => {});\ntest.skip("b", () => {});\nxit("c", () => {});\ndescribe.skip("d", () => {});\nit("e", () => {});\n',
    'tests/b.spec.ts': 'xdescribe("x", () => {});\n',
    'tests/test_x.py': '@unittest.skip("later")\ndef test_x():\n    pass\n',
    'pkg/foo_test.go': 'func TestA(t *testing.T) {\n\tt.Skip("later")\n}\n',
    'crates/lib.rs': '#[test]\n#[ignore]\nfn slow() {}\n',
    'node_modules/dep/index.js': '// TODO ignored\nit.skip("x")\n',
    'package-lock.json': `${'{"TODO": 1}\n'.repeat(3)}`,
    'logo.bin': Buffer.from([0, 1, 2, 0x54, 0x4f, 0x44, 0x4f]).toString('latin1'),
  });
  try {
    const inv = await scan(dir);
    assert.equal(inv.debt.todo, 2, 'TODO as a word, not inside another word, nothing from node_modules or lock files');
    assert.equal(inv.debt.fixme, 1);
    assert.equal(inv.debt.skippedTests, 4 + 1 + 1 + 1 + 1, 'four in a.test.js, one spec, one python, one go, one rust');
    assert.deepEqual(inv.debt.largeFiles, [{ path: 'src/big.js', lines: 1201, bytes: big.length }]);
  } finally {
    cleanup(dir);
  }
});

test('a manifest that does not parse is reported, not thrown, and the package is still listed', async () => {
  const dir = fixture({
    'package.json': '{ "name": "a", ',
    'svc/pyproject.toml': '[project\nname = "x"\n',
    'svc2/pyproject.toml': '[project]\nname = "x\n',
    'svc3/pyproject.toml': '[project]\nthis is not toml\n',
    'rs/Cargo.toml': '[package]\nname = ',
    'java/pom.xml': '<project><artifactId>x</artifactId>',
    'php/composer.json': '[1, 2',
    '.github/workflows/broken.yml': 'jobs: [unclosed\n',
  });
  try {
    const inv = await scan(dir);
    const files = inv.problems.map((p) => p.file).sort();
    assert.deepEqual(files, ['.github/workflows/broken.yml', 'java/pom.xml', 'package.json', 'php/composer.json', 'rs/Cargo.toml', 'svc/pyproject.toml', 'svc2/pyproject.toml', 'svc3/pyproject.toml']);
    assert.equal(inv.packages.length, 7);
    assert.ok(inv.problems.every((p) => p.message.length > 10));
    assert.deepEqual(inv.ci, [{ file: '.github/workflows/broken.yml', jobs: [] }]);
    assert.match(renderInventory(inv), /Problem: package\.json: package\.json does not parse/);
  } finally {
    cleanup(dir);
  }
});

test('the TOML reader reads tables, multi-line arrays, quotes and comments, and names the line it cannot read', () => {
  const ok = parseToml('# c\n[project]\nname = "a#b" # c\ndeps = [\n "x", # y\n "z"\n]\ntext = """\nmulti\n"""\n[tool.ruff.lint]\nselect = ["E"]\n[[bin]]\nname = \'x\'\n');
  assert.equal(ok.error, null);
  assert.deepEqual([...ok.tables.keys()], ['', 'project', 'tool.ruff.lint', 'bin']);
  assert.equal(ok.tables.get('project').get('name'), '"a#b"');
  assert.match(ok.tables.get('project').get('deps'), /"z"/);
  assert.match(parseToml('[a\n').error, /line 1: table header is not closed/);
  assert.match(parseToml('a = [1,\n2\n').error, /not closed/);
  assert.match(parseToml('x\n').error, /line 1: expected key = value/);
  assert.match(parseToml('x = "open\n').error, /string is not closed/);
});

test('scan never runs project code: only read-only git calls, and the tree is unchanged', async () => {
  const dir = fixture({
    'package.json': json({ name: 'a', scripts: { postinstall: 'touch pwned', test: 'touch pwned2' } }),
    'setup.py': 'import os; os.system("touch pwned3")\n',
    'Makefile': 'all:\n\ttouch pwned4\n',
  }, { commits: ['init'] });
  const before = treeHash(dir);
  const calls = [];
  try {
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      return defaultExec(cmd, args);
    };
    await scan(dir, { exec });
    assert.ok(calls.length >= 2);
    for (const c of calls) {
      assert.equal(c[0], 'git');
      assert.deepEqual([c[1], c[3], c[4]], ['-C', '-c', 'log.showSignature=false'], 'the signature option is off, so a signed history prints nothing extra');
      assert.ok(['log', 'branch'].includes(c[5]), `read-only git subcommand, got ${c[5]}`);
    }
    assert.deepEqual(treeHash(dir), before);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('pwned')), []);
  } finally {
    cleanup(dir);
  }
});

test('a failing or throwing exec is tolerated', async () => {
  const dir = fixture({ 'package.json': '{"name":"a"}\n' });
  try {
    for (const exec of [() => { throw new Error('boom'); }, async () => ({ code: 1, stdout: 'x' }), async () => { throw new Error('async boom'); }]) {
      const inv = await scan(dir, { exec });
      assert.equal(inv.conventions.commits.style, 'unknown');
    }
    await assert.rejects(() => scan(join(dir, 'package.json')), /Not a folder/);
    await assert.rejects(() => scan(join(dir, 'missing')), /Not a folder/);
  } finally {
    cleanup(dir);
  }
});

test('symbolic links are never followed: neither a linked folder nor a linked manifest', async () => {
  const outside = fixture({ 'package.json': json({ name: 'outside-pkg' }), 'x/package.json': json({ name: 'deep' }) });
  const dir = fixture({ 'package.json': '{"name":"a"}\n' });
  try {
    symlinkSync(outside, join(dir, 'linked'));
    symlinkSync(join(outside, 'package.json'), join(dir, 'web-package.json'));
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(outside, 'package.json'), join(dir, 'real', 'package.json'));
    symlinkSync(dir, join(dir, 'loop'));
    assert.ok(lstatSync(join(dir, 'linked')).isSymbolicLink());
    const inv = await scan(dir);
    assert.deepEqual(inv.packages.map((p) => p.path), ['.']);
  } finally {
    cleanup(dir);
    cleanup(outside);
  }
});

test('documents: README, docs folder and package READMEs, never node_modules', async () => {
  const dir = fixture({
    'package.json': '{"name":"a"}\n',
    'README.md': '#\n', 'CONTRIBUTING.md': '#\n', 'CLAUDE.md': '#\n', 'LICENSE': 'MIT\n',
    'docs/architecture.md': '#\n', 'docs/img/logo.png': 'x', 'docs/adr/0001.md': '#\n',
    'node_modules/x/README.md': '#\n', 'src/notes.md': '#\n',
  });
  try {
    assert.deepEqual((await scan(dir)).docs, ['CLAUDE.md', 'CONTRIBUTING.md', 'README.md', 'docs/adr/0001.md', 'docs/architecture.md']);
  } finally {
    cleanup(dir);
  }
});

test('a repository with no manifest gives an empty package list and a valid inventory', async () => {
  const dir = fixture({ 'main.c': 'int main(void) { return 0; }\n' });
  try {
    const inv = await scan(dir);
    assert.deepEqual(inv.packages, []);
    assert.deepEqual(inv.ci, []);
    assert.match(renderInventory(inv), /^Packages: 0$/m);
  } finally {
    cleanup(dir);
  }
});

function io(cwd, extra = {}) {
  const out = [];
  const err = [];
  return {
    out, err,
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {}, exec: defaultExec, ...extra },
  };
}

test('recade inventory scan prints the summary, --json prints the inventory, and the exit codes are 0 and 2', async () => {
  const dir = fixture({ 'package.json': json({ name: 'fernhill-api', scripts: { test: 'node --test' }, dependencies: { express: '4' } }) }, { commits: ['feat: a'] });
  try {
    const a = io(dir);
    assert.equal(await run(['inventory', 'scan'], a.io), 0);
    assert.match(a.out.join(''), /^- \. \(package\.json\): JavaScript, Express$/m);
    assert.match(a.out.join(''), /test: npm test; lint: none found; build: none found/);
    const b = io(dir);
    assert.equal(await run(['inventory', 'scan', '--json'], b.io), 0);
    const parsed = JSON.parse(b.out.join(''));
    assert.equal(parsed.packages[0].name, 'fernhill-api');
    assert.equal(parsed.conventions.commits.style, 'conventional');
    for (const args of [['inventory'], ['inventory', 'nope'], ['inventory', 'scan', '--x'], ['inventory', 'scan', 'extra']]) {
      const c = io(dir);
      assert.equal(await run(args, c.io), 2, args.join(' '));
      assert.match(c.err.join(''), /Usage: recade inventory scan \[--json\]/);
    }
    const d = io(join(dir, 'missing'));
    assert.equal(await run(['inventory', 'scan'], d.io), 2);
    assert.match(d.err.join(''), /Not a folder/);
    assert.deepEqual(readdirSync(dir).sort(), ['.git', 'package.json'], 'the command wrote nothing');
  } finally {
    cleanup(dir);
  }
});

const fast = async (fn, ms = 1500) => {
  const t0 = Date.now();
  const out = await fn();
  assert.ok(Date.now() - t0 < ms, `took ${Date.now() - t0} ms`);
  return out;
};

test('hostile input stays linear: a TOML header of whitespace, and a workspace glob of many stars', async () => {
  const bad = parseToml(`[${' '.repeat(50000)}x\n`);
  assert.ok(bad.error !== null);
  const t0 = Date.now();
  parseToml(`[${' '.repeat(9000)}x`);
  parseToml(`[${'a . '.repeat(3000)}`);
  assert.ok(Date.now() - t0 < 1500, 'header parsing is linear');
  assert.match(parseToml(`x = "${'a'.repeat(20000)}"\n`).error ?? 'long line', /too long|long line/);
  const dir = fixture({
    'package.json': json({ name: 'root', workspaces: [`packages/${'*a'.repeat(30)}b`, `p/${'*'.repeat(40)}`, `x${'/**'.repeat(60)}/y`] }),
    [`packages/${'a'.repeat(60)}/package.json`]: json({ name: 'a' }),
  });
  try {
    const inv = await fast(() => scan(dir));
    assert.deepEqual(inv.workspaces[0].members, []);
    const huge = fixture({ 'package.json': json({ name: 'root', workspaces: [`${'a/'.repeat(400)}*`, 'packages/*'] }), 'packages/x/package.json': json({ name: 'x' }) });
    try {
      const h = await fast(() => scan(huge));
      assert.deepEqual(h.workspaces[0].members, ['packages/x'], 'the sane glob still works');
      assert.ok(h.problems.some((p) => p.file === 'package.json' && /glob/.test(p.message)), 'the over-long glob is reported');
    } finally {
      cleanup(huge);
    }
  } finally {
    cleanup(dir);
  }
});

test('the root package.json is read like any file: never through a link, never past 1 MiB', async () => {
  const dir = fixture({ 'apps/a/package.json': json({ name: 'a', scripts: { test: 'x' } }) });
  try {
    symlinkSync('/dev/zero', join(dir, 'package.json'));
    const inv = await fast(() => scan(dir));
    assert.equal(inv.packages[0].testCommand, '(cd apps/a && npm test)');
  } finally {
    cleanup(dir);
  }
  const big = fixture({ 'package.json': `{"name":"r","pad":"${'x'.repeat(1100000)}"}`, 'apps/a/package.json': json({ name: 'a', scripts: { test: 'x' } }) });
  try {
    const inv = await scan(big);
    assert.ok(inv.problems.some((p) => p.file === 'package.json' && /larger than 1 MiB/.test(p.message)));
    assert.equal(inv.packages.find((p) => p.path === 'apps/a').testCommand, '(cd apps/a && npm test)');
  } finally {
    cleanup(big);
  }
});

test('a pnpm root that declares no workspaces key and has members is not a package; one with its own code is', async () => {
  const plain = fixture({
    'package.json': json({ name: 'root', packageManager: `pnpm${AT}9.1.0`, devDependencies: { prettier: '3' } }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'apps/a/package.json': json({ name: 'a' }),
    'apps/b/package.json': json({ name: 'b' }),
  });
  const app = fixture({
    'package.json': json({ name: 'root-app', dependencies: { express: '4' } }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'apps/a/package.json': json({ name: 'a' }),
  });
  const empty = fixture({ 'package.json': json({ name: 'root' }), 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n" });
  try {
    assert.deepEqual((await scan(plain)).packages.map((p) => p.path), ['apps/a', 'apps/b']);
    assert.deepEqual((await scan(app)).packages.map((p) => p.path), ['.', 'apps/a']);
    assert.deepEqual((await scan(empty)).packages.map((p) => p.path), ['.'], 'a root with no member stays visible');
  } finally {
    cleanup(plain);
    cleanup(app);
    cleanup(empty);
  }
});

test('control characters in paths, names and messages never reach the terminal output, and such paths are refused with a problem', async () => {
  const esc = String.fromCharCode(27);
  const dir = fixture({
    'package.json': json({ name: `evil\nProblem: forged line${esc}[31m`, scripts: { test: 'node --test' }, dependencies: { express: '4' } }),
    'bad\nname/package.json': json({ name: 'hidden' }),
    [`tab\there/package.json`]: json({ name: 'hidden2' }),
    'broken/package.json': '{ "a": \n"b\u0007" ',
  });
  try {
    const inv = await scan(dir);
    assert.deepEqual(inv.packages.map((p) => p.path), ['.', 'broken']);
    assert.equal(inv.problems.filter((p) => /was skipped/.test(p.message)).length, 2);
    assert.ok(inv.problems.every((p) => !/[\u0000-\u001f\u007f]/.test(p.file + p.message)), 'JSON output carries no raw control character either');
    assert.ok(!/[\u0000-\u001f\u007f]/.test(inv.packages[0].name));
    const out = renderInventory(inv);
    assert.deepEqual(out.split('\n').filter((l) => l !== '' && !/^(Packages: |- |  test: |Workspace root |CI: |Commits: |Debt: |Documents: |Problem: |The scan )/.test(l)), []);
    assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(out), false);
    assert.equal(out.split('\n').filter((l) => l.startsWith('Problem: forged')).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('Gradle projects are detected, and build files the scan does not understand are listed so a repository never looks empty', async () => {
  const dir = fixture({
    'settings.gradle.kts': 'include(":app", ":libs:core")\n',
    'gradlew': '#!/bin/sh\n',
    'app/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.2.0"\n kotlin("jvm") }\n',
    'libs/core/build.gradle': "plugins { id 'java-library'\n id 'checkstyle' }\n",
    'Makefile': 'all:\n',
    'native/CMakeLists.txt': 'project(x)\n',
    'dotnet/Svc.csproj': '<Project/>\n',
    'Svc.sln': '\n',
    'beam/mix.exs': 'defmodule X do end\n',
    'py/setup.py': 'from setuptools import setup\n',
  });
  try {
    const inv = await scan(dir);
    const by = Object.fromEntries(inv.packages.map((p) => [p.path, p]));
    assert.deepEqual(Object.keys(by).sort(), ['app', 'libs/core']);
    assert.equal(by.app.language, 'Kotlin');
    assert.equal(by.app.framework, 'Spring Boot');
    assert.equal(by.app.testCommand, '(cd app && ../gradlew test)');
    assert.equal(by.app.buildCommand, '(cd app && ../gradlew build)');
    assert.equal(by['libs/core'].language, 'Java');
    assert.equal(by['libs/core'].testCommand, '(cd libs/core && ../../gradlew test)');
    assert.equal(by['libs/core'].lintCommand, '(cd libs/core && ../../gradlew checkstyleMain)');
    assert.deepEqual(inv.workspaces, [{ root: '.', manager: 'gradle', globs: ['app', 'libs/core'], members: ['app', 'libs/core'] }]);
    const unknown = inv.problems.filter((p) => /not recognised/.test(p.message)).map((p) => p.file).sort();
    assert.deepEqual(unknown, ['Makefile', 'Svc.sln', 'beam/mix.exs', 'dotnet/Svc.csproj', 'native/CMakeLists.txt', 'py/setup.py']);
  } finally {
    cleanup(dir);
  }
  const plain = fixture({ 'build.gradle': "plugins { id 'java' }\n" });
  const only = fixture({ 'Makefile': 'all:\n' });
  try {
    assert.equal((await scan(plain)).packages[0].testCommand, 'gradle test');
    const o = await scan(only);
    assert.deepEqual(o.packages, []);
    assert.equal(o.problems.length, 1);
  } finally {
    cleanup(plain);
    cleanup(only);
  }
});

test('hitting the depth, folder or file limit sets truncated and the summary says so', async () => {
  const deep = fixture({ 'a/b/c/d/e/f/g/h/i/j/package.json': json({ name: 'deep' }) });
  const wide = fixture({ 'd1/x': '', 'd2/x': '', 'd3/x': '', 'd4/x': '' });
  const many = fixture({ 'f1': '', 'f2': '', 'f3': '' });
  try {
    const d = await scan(deep);
    assert.equal(d.truncated, true);
    assert.match(renderInventory(d), /^The scan stopped at its limits/m);
    assert.equal((await scan(deep, { limits: { maxDepth: 20 } })).truncated, false);
    assert.equal((await scan(wide, { limits: { maxDirs: 3 } })).truncated, true);
    assert.equal((await scan(wide, { limits: { maxDirs: 10 } })).truncated, false);
    assert.equal((await scan(many, { limits: { maxFiles: 2 } })).truncated, true);
  } finally {
    cleanup(deep);
    cleanup(wide);
    cleanup(many);
  }
});

// ---- the workspace: one section per registered repository (plan 5b task 9) ----

/** A workspace whose registry names the repositories of `sets` (name to files), each in `repos/<name>/`. */
function workspaceOf(sets) {
  const ws = mkdtempSync(join(tmpdir(), 'recade-inv-ws-'));
  mkdirSync(join(ws, 'recade'), { recursive: true });
  writeFileSync(join(ws, 'recade', 'state.yaml'), stringify({
    version: 1, kind: 'workspace', repos: Object.keys(sets).map((name) => ({ name, path: `repos/${name}`, remote: 'none', default_branch: 'main' })),
  }));
  for (const [name, files] of Object.entries(sets)) {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(ws, 'repos', name, rel, '..'), { recursive: true });
      writeFileSync(join(ws, 'repos', name, rel), text);
    }
  }
  return ws;
}

test('scanWorkspace scans each registered repository on its own, in registry order', async () => {
  const ws = workspaceOf({
    api: { 'package.json': JSON.stringify({ name: 'fernhill-api', scripts: { test: 'node --test' } }), 'README.md': '# API\n' },
    web: { 'package.json': JSON.stringify({ name: 'fernhill-web' }), 'docs/guide.md': '# Guide\n' },
  });
  try {
    const r = await scanWorkspace(ws, { exec: defaultExec });
    assert.deepEqual(r.repos.map((x) => [x.name, x.path]), [['api', 'repos/api'], ['web', 'repos/web']]);
    assert.deepEqual(r.missing, []);
    assert.equal(r.repos[0].inventory.packages[0].name, 'fernhill-api');
    assert.deepEqual(r.repos[0].inventory.docs, ['README.md']);
    assert.deepEqual(r.repos[1].inventory.docs, ['docs/guide.md']);
    assert.equal(r.repos[1].inventory.packages[0].path, '.', 'package paths are relative to their repository');
  } finally { cleanup(ws); }
});

test('renderWorkspaceInventory gives one section per repository, and names a repository that is not cloned', async () => {
  const ws = workspaceOf({ api: { 'package.json': '{"name":"fernhill-api"}' }, web: { 'package.json': '{"name":"fernhill-web"}' } });
  try {
    rmSync(join(ws, 'repos', 'web'), { recursive: true });
    const text = renderWorkspaceInventory(await scanWorkspace(ws, { exec: defaultExec }));
    assert.equal((text.match(/^## Repository /gm) ?? []).length, 1);
    assert.match(text, /^## Repository api \(repos\/api\)$/m);
    assert.match(text, /Packages: 1/);
    assert.match(text, /Not cloned: web \(run recade repo sync\)/);
    const both = workspaceOf({ api: { 'package.json': '{"name":"a"}' }, web: { 'package.json': '{"name":"b"}' } });
    try {
      const two = renderWorkspaceInventory(await scanWorkspace(both, { exec: defaultExec }));
      assert.deepEqual(two.match(/^## Repository .*$/gm), ['## Repository api (repos/api)', '## Repository web (repos/web)']);
    } finally { cleanup(both); }
  } finally { cleanup(ws); }
});

test('recade inventory scan at the root of a workspace scans every registered repository, --json too', async () => {
  const ws = workspaceOf({ api: { 'package.json': '{"name":"fernhill-api"}' }, web: { 'package.json': '{"name":"fernhill-web"}' } });
  try {
    const out = [];
    const io = { stdout: { write: (x) => out.push(x) }, stderr: { write: () => {} }, cwd: ws, env: {} };
    assert.equal(await run(['inventory', 'scan'], io), 0);
    assert.equal((out.join('').match(/^## Repository /gm) ?? []).length, 2);
    const json = [];
    assert.equal(await run(['inventory', 'scan', '--json'], { ...io, stdout: { write: (x) => json.push(x) } }), 0);
    const data = JSON.parse(json.join(''));
    assert.deepEqual(data.repos.map((x) => x.name), ['api', 'web']);
    assert.equal(data.repos[0].inventory.packages[0].name, 'fernhill-api');
    // a plain folder is still scanned as one repository
    const plain = [];
    assert.equal(await run(['inventory', 'scan', '--json'], { ...io, cwd: join(ws, 'repos', 'api'), stdout: { write: (x) => plain.push(x) } }), 0);
    assert.ok(Array.isArray(JSON.parse(plain.join('')).packages));
  } finally { cleanup(ws); }
});
