import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources, markdownFiles, parseBlocks, syncShared } from '../tools/sync-shared.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const names = (dir) => readdirSync(join(repo, dir)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();

/**
 * The blocks each family of prompt files must hold. `except` names the files of the family that are left out, with
 * the reason in the comment.
 */
const REQUIRED = [
  // Every plugin command runs the CLI and installs its dependencies.
  { dir: 'commands', blocks: ['deps-plugin'] },
  // help.md only prints the list of commands.
  { dir: 'commands', except: ['help'], blocks: ['cli-plugin'] },
  // The commands that talk to the owner about a project. help, languages, setup and start have no project yet.
  { dir: 'commands', except: ['help', 'languages', 'setup', 'start'], blocks: ['id-gist'] },
  // The phase commands show the cost line in their first message.
  { dir: 'commands', only: ['new', 'team', 'docs', 'bible', 'slices', 'harness'], blocks: ['cost-line'] },
  // Every command that asks the owner something asks a closed choice. help, setup and status ask nothing.
  { dir: 'commands', except: ['help', 'setup', 'status'], blocks: ['owner-choice'] },
  // The commands whose progress lines say how long a step usually takes.
  { dir: 'commands', only: ['team', 'docs', 'bible', 'slices'], blocks: ['progress-time'] },
  // The offer to connect a design reference server: once at start, and before the art direction.
  { dir: 'commands', only: ['start', 'docs'], blocks: ['design-servers'] },
  { dir: 'harness/commands', blocks: ['cli-harness', 'plugin-root-file', 'harness-plugin-root'] },
  // The harness amend command runs the amend flow of the plugin, which holds these blocks. exit.md reads no project and
  // names no ID: it pushes and stops the session.
  { dir: 'harness/commands', except: ['amend', 'exit'], blocks: ['id-gist', 'no-project'] },
  // board.md and exit.md pass no owner text to a command line.
  { dir: 'harness/commands', except: ['board', 'exit'], blocks: ['owner-text-quotes'] },
  {
    dir: 'harness/agents',
    blocks: ['protocol-reads', 'data-not-instructions', 'never-merge', 'two-failures', 'closed-choice', 'personal-data', 'report-block'],
  },
  // The agents that write a project document.
  {
    dir: 'agents',
    only: ['architect', 'bible-writer', 'devops-lead', 'domain-expert', 'project-lead', 'security-lead', 'stack-analyst', 'ux-designer'],
    blocks: ['doc-ids', 'doc-provisional', 'doc-size', 'dec-aim', 'dec-new-rules'],
  },
];

test('every block matches its source, and the sync tool has nothing to do', () => {
  const { changed, errors } = syncShared(repo, { check: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(changed, [], 'Run node tools/sync-shared.js');
});

test('every source is used in at least one file', () => {
  const { uses } = syncShared(repo, { check: true });
  const unused = [...uses].filter(([, files]) => files.length === 0).map(([name]) => name);
  assert.deepEqual(unused, []);
});

test('the markers are balanced, never nested and never in the front matter', () => {
  const problems = [];
  for (const file of markdownFiles(repo)) {
    const { errors } = parseBlocks(readFileSync(join(repo, file), 'utf8'));
    problems.push(...errors.map((e) => `${file}: ${e}`));
  }
  assert.deepEqual(problems, []);
});

test('a source holds one block: no marker, no front matter, no blank first line', () => {
  for (const [name, body] of loadSources(repo)) {
    assert.doesNotMatch(body, /<!--/, name);
    assert.doesNotMatch(body, /^---\n/, name);
    assert.doesNotMatch(body, /^\s/, name);
    assert.ok(body.length > 0, name);
  }
});

test('each family holds its required blocks', () => {
  const sources = loadSources(repo);
  const missing = [];
  for (const rule of REQUIRED) {
    const all = names(rule.dir);
    for (const name of [...(rule.except ?? []), ...(rule.only ?? [])]) assert.ok(all.includes(name), `${rule.dir}/${name}.md is named in REQUIRED and does not exist`);
    const files = (rule.only ?? all).filter((n) => !(rule.except ?? []).includes(n));
    for (const file of files) {
      const text = readFileSync(join(repo, rule.dir, `${file}.md`), 'utf8');
      const held = new Set(parseBlocks(text).blocks.filter((b) => b.kind === 'shared').map((b) => b.name));
      for (const block of rule.blocks) {
        assert.ok(sources.has(block), `${block} has no source`);
        if (!held.has(block)) missing.push(`${rule.dir}/${file}.md: ${block}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('the sync tool rewrites a drifted block, inline or on lines of its own, and --check reports it', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-shared-'));
  mkdirSync(join(root, 'tools/shared'), { recursive: true });
  mkdirSync(join(root, 'commands'));
  writeFileSync(join(root, 'tools/shared/rule.md'), 'Never do it.\n');
  writeFileSync(join(root, 'tools/shared/steps.md'), '1. One.\n2. Two.\n');
  const file = join(root, 'commands/a.md');
  writeFileSync(file, '---\ndescription: x\n---\n\nFirst. <!-- shared:rule -->Do it.<!-- /shared:rule --> Last.\n\n<!-- shared:steps -->\n1. One.\n<!-- /shared:steps -->\n');
  const report = syncShared(root, { check: true });
  assert.deepEqual(report.changed, ['commands/a.md']);
  assert.match(readFileSync(file, 'utf8'), /Do it\./, 'check writes nothing');
  syncShared(root);
  assert.equal(readFileSync(file, 'utf8'), '---\ndescription: x\n---\n\nFirst. <!-- shared:rule -->Never do it.<!-- /shared:rule --> Last.\n\n<!-- shared:steps -->\n1. One.\n2. Two.\n<!-- /shared:steps -->\n');
  assert.deepEqual(syncShared(root, { check: true }).changed, []);
});

test('the parser reports a nested, an unclosed, a stray and a front matter marker', () => {
  const at = (text) => parseBlocks(text).errors;
  assert.match(at('<!-- shared:a --><!-- shared:b --><!-- /shared:b --><!-- /shared:a -->')[0], /opens inside shared:a/);
  assert.match(at('x <!-- shared:a --> y')[0], /never closed/);
  assert.match(at('x <!-- /shared:a --> y')[0], /closes no block/);
  assert.match(at('---\ndescription: <!-- shared:a -->x<!-- /shared:a -->\n---\n')[0], /front matter/);
  assert.deepEqual(parseBlocks('Write `<!-- shared:<name> -->` in a document.').blocks, [], 'a placeholder name is not a marker');
});

test('an unknown block name is an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-shared-'));
  mkdirSync(join(root, 'tools/shared'), { recursive: true });
  mkdirSync(join(root, 'agents'));
  writeFileSync(join(root, 'agents/a.md'), 'x <!-- shared:nothing -->y<!-- /shared:nothing -->\n');
  assert.match(syncShared(root, { check: true }).errors[0], /shared:nothing has no source/);
});
