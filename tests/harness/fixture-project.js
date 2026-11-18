import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli.js';
import { defaultExec as realExec } from '../../src/doctor.js';
import { createWorkspace } from '../../src/workspace/layout.js';
import { addRepo } from '../../src/workspace/repos.js';

/** Helpers shared by the install, verify and cases tests: a fictional project in a temp dir, and the plugin. */
export const plugin = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STACK = readFileSync(join(plugin, 'tests', 'fixtures', 'harness-ci', 'STACK.md'), 'utf8');

export const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  return r;
};

/** A fictional project: a git repository with recade/state.yaml, docs/STACK.md and one slice sheet. */
export function makeProject({ stack = STACK, lane = 'standard', state = 'version: 1\nmode: scratch\nlots: []\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recade-install-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'recade'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'slices'), { recursive: true });
  writeFileSync(join(root, 'recade', 'state.yaml'), state);
  if (stack !== null) writeFileSync(join(root, 'docs', 'STACK.md'), stack);
  writeFileSync(join(root, 'slices', 'S-01-accounts.md'), `---\nid: S-01\ntitle: Accounts\nlane: ${lane}\ntouches: [src/accounts/**]\n---\n\n## Goal\n\nAccounts.\n`);
  return root;
}

export function makeIO(cwd, extra = {}) {
  const out = [];
  const err = [];
  return { io: { cwd, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, ...extra }, out, err };
}

/** Run the CLI and return `{code, stdout, stderr}`. */
export async function cli(cwd, args, extra) {
  const { io, out, err } = makeIO(cwd, extra);
  const code = await run(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** A copy of the plugin pieces the install reads, in a temp dir: a stand-in for a newer plugin version. */
export function fakePlugin(version, edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'recade-plugin-'));
  cpSync(join(plugin, 'harness'), join(root, 'harness'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'recade.js'), '// stand-in\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'recade', version }));
  edit(root);
  return root;
}

/** The rows of the harness technical sheet of STACK, as [item, value] pairs. */
const sheetRows = () => STACK.split('## 12. Harness technical sheet')[1].split('## 13.')[0].split('\n').filter((l) => /^\| /.test(l) && !/^\| (Item|---)/.test(l)).map((l) => l.replace(/^\| /, '').replace(/ \|$/, '').split(/ \| (?=`|[A-Za-z])/));

/**
 * The STACK of a project with several repositories: section 12 holds one table per repository, headed `### <repo>`,
 * each a copy of the base table with the given rows replaced (`{api: {Test: 'npm run test:api'}}`).
 */
export function perRepoStack(overrides) {
  const [head, rest] = STACK.split('## 12. Harness technical sheet');
  const tail = `## 13.${rest.split('## 13.')[1]}`;
  const base = sheetRows();
  const tables = Object.entries(overrides).map(([repo, rows]) => {
    const lines = base.map(([k, v]) => `| ${k} | ${rows[k] ?? v} |`);
    return `### ${repo}\n\n| Item | Value |\n|---|---|\n${lines.join('\n')}\n`;
  });
  return `${head}## 12. Harness technical sheet\n\n${tables.join('\n')}\n${tail}`;
}

/**
 * A workspace with real code repositories under repos/ (git init, first commit, link, registry), the STACK in
 * docs/STACK.md and one slice sheet. `parent` lets a test pick a folder name with spaces and accents.
 */
export async function makeWorkspace({ repos = ['api'], stack = STACK, parent = mkdtempSync(join(tmpdir(), 'recade-ws-')), slug = 'fernhill', mode } = {}) {
  const { dir } = await createWorkspace(parent, slug, { exec: realExec });
  if (stack !== null) writeFileSync(join(dir, 'docs', 'STACK.md'), stack);
  writeFileSync(join(dir, 'slices', 'S-01-accounts.md'), `---\nid: S-01\ntitle: Accounts\nlane: standard\ntouches: [${repos[0]}:src/accounts/**]\n---\n\n## Goal\n\nAccounts.\n`);
  if (mode !== undefined) {
    const file = join(dir, 'recade', 'state.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('kind: workspace', `kind: workspace\nmode: ${mode}`));
  }
  for (const name of repos) await addRepo(dir, name, { new: true }, { exec: realExec });
  return { dir, parent, repo: (name) => join(dir, 'repos', name) };
}
