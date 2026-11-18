import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository of the adopt example: a tiny fictional Node service, the desk of the Fernhill Tool Library
 * (members borrow tools for 7 days). It has code, tests, an ADR, its own CI file and a short Git history,
 * so adopt has something real to respect. `buildAdoptRepo` writes it into `dir` and commits it on `main`.
 * Nothing here touches a network: the remote is only a name in the local config, and its branch is a local reference.
 */

const PACKAGE = {
  name: 'fernhill-desk',
  version: '0.3.0',
  private: true,
  type: 'module',
  description: 'Loan desk of the Fernhill Tool Library',
  engines: { node: '>=20' },
  scripts: { start: 'node src/server.js', test: 'node --test' },
};

const FILES = {
  'package.json': `${JSON.stringify(PACKAGE, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
  'README.md': `# Fernhill desk

The loan desk of the Fernhill Tool Library. Members borrow a tool for 7 days. Volunteers register loans and returns.

Run it with \`npm start\`. Run the tests with \`npm test\`.
`,
  'docs/adr/0001-plain-node.md': `# ADR 0001: plain Node, no framework

The desk is a small service for one library. We use \`node:http\` and \`node:test\` and no framework,
so there is nothing to upgrade. Revisit this when a second service appears.
`,
  '.github/workflows/ci.yml': `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
`,
  'src/ledger.js': `/** The loan ledger. It lives in memory: a restart forgets every loan. */
const loans = new Map();

export function lend(toolId, memberId, today) {
  if (loans.has(toolId)) throw new Error(\`Tool \${toolId} is already out\`);
  loans.set(toolId, { toolId, memberId, since: today });
  return loans.get(toolId);
}

export function giveBack(toolId) {
  const loan = loans.get(toolId);
  if (!loan) throw new Error(\`Tool \${toolId} is not out\`);
  loans.delete(toolId);
  return loan;
}

export const openLoans = () => [...loans.values()];
`,
  'src/loans.js': `import { lend, giveBack } from './ledger.js';

export const LOAN_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

export function borrow(toolId, memberId, today = new Date()) {
  const loan = lend(toolId, memberId, today);
  return { ...loan, dueOn: new Date(today.getTime() + LOAN_DAYS * DAY) };
}

// TODO: the board has not voted a cap for the late fee, so it grows without limit
export function lateFee(dueOn, returnedOn) {
  const lateDays = Math.max(0, Math.ceil((returnedOn - dueOn) / DAY));
  return lateDays * 2;
}

export function giveBackTool(toolId, today = new Date()) {
  const loan = giveBack(toolId);
  const dueOn = new Date(loan.since.getTime() + LOAN_DAYS * DAY);
  return { toolId, fee: lateFee(dueOn, today) };
}
`,
  'src/members.js': `const members = new Map();

export function join(id, name) {
  if (!id || !name) throw new Error('A member needs an id and a name');
  members.set(id, { id, name });
  return members.get(id);
}

// FIXME: a member who joins twice silently replaces the first record
export const find = (id) => members.get(id) ?? null;
`,
  'src/server.js': `import { createServer } from 'node:http';
import { borrow, giveBackTool } from './loans.js';
import { join } from './members.js';

export const server = createServer((req, res) => {
  const [, route, id] = req.url.split('/');
  res.setHeader('content-type', 'application/json');
  try {
    if (req.method === 'POST' && route === 'members') return res.end(JSON.stringify(join(id, 'unnamed')));
    if (req.method === 'POST' && route === 'loans') return res.end(JSON.stringify(borrow(id, req.headers['x-member'])));
    if (req.method === 'DELETE' && route === 'loans') return res.end(JSON.stringify(giveBackTool(id)));
    res.statusCode = 404;
    return res.end('{"error":"not found"}');
  } catch (err) {
    res.statusCode = 409;
    return res.end(JSON.stringify({ error: err.message }));
  }
});

if (process.argv[1] === new URL(import.meta.url).pathname) server.listen(3000);
`,
  'test/loans.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lateFee, LOAN_DAYS } from '../src/loans.js';

test('a loan lasts 7 days', () => assert.equal(LOAN_DAYS, 7));

test('a return on time costs nothing', () => {
  const due = new Date('2026-11-10');
  assert.equal(lateFee(due, due), 0);
});

test('each late day costs 2', () => {
  assert.equal(lateFee(new Date('2026-11-10'), new Date('2026-11-13')), 6);
});
`,
  'test/members.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, find } from '../src/members.js';

test('a member needs an id and a name', () => assert.throws(() => join('', 'Ada')));

test('a joined member can be found', () => {
  join('m-1', 'Ada');
  assert.equal(find('m-1').name, 'Ada');
});
`,
};

/** The commits of the history, in order: each writes the files it names and carries its own message. */
const HISTORY = [
  ['chore: start the loan desk', ['package.json', '.gitignore', 'README.md', 'src/ledger.js', 'src/loans.js', 'src/server.js']],
  ['feat: members and their tests', ['src/members.js', 'test/members.test.js', 'test/loans.test.js']],
  ['docs: record the choice of plain Node', ['docs/adr/0001-plain-node.md', '.github/workflows/ci.yml']],
];

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Fernhill CI', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim().split('\n')[0]}`);
};

/**
 * Write the example repository into `dir` (an existing, empty folder) and commit it on `main`.
 * @param {string} dir
 * @returns {{dir: string, files: string[]}} the files of the repository, sorted
 */
export function buildAdoptRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  for (const [message, names] of HISTORY) {
    for (const name of names) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), FILES[name]);
    }
    git(dir, 'add', '--', ...names);
    git(dir, 'commit', '-q', '-m', message);
  }
  git(dir, 'remote', 'add', 'origin', 'https://github.com/fernhill/fernhill-desk.git');
  // Everything is pushed: the remote-tracking branch is where the history is, and `main` follows it. A workspace is cloned from the remote.
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  return { dir, files: Object.keys(FILES).sort() };
}

// Run directly: node example/adopt/build.js <empty folder>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (target === undefined) {
    process.stderr.write('Usage: node example/adopt/build.js <empty folder>\n');
    process.exitCode = 2;
  } else {
    mkdirSync(target, { recursive: true });
    process.stdout.write(`${buildAdoptRepo(target).files.join('\n')}\n`);
  }
}
