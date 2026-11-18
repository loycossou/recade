import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncAgents } from '../tools/sync-agent-models.js';
import { AXES, CONTRACT_SECTIONS, INVARIANT_SECTIONS, RULES_SECTIONS, REGISTER_FILES, SOURCE_DIR } from '../src/project/fromcode.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = join(repo, 'agents');
const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort();
const models = JSON.parse(readFileSync(join(agentsDir, 'models.json'), 'utf8'));
const DOC_AGENTS = ['project-lead', 'ux-designer', 'ui-designer', 'architect', 'security-lead', 'devops-lead', 'domain-expert'];
const paths = (body) => [...section(body, 'Writes').matchAll(/`([^`]+)`/g)].map((m) => m[1]);

function parseAgent(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'front matter');
  const front = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { front, body: m[2] };
}

function section(body, title) {
  const re = new RegExp(`^## ${title}\\s*$`, 'm');
  const m = re.exec(body);
  assert.ok(m, `section ${title}`);
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

test('models.json holds the two tiers', () => {
  assert.deepEqual(models, {
    writer: { model: 'claude-fable-5-2', effort: 'high' },
    mechanical: { model: 'sonnet', effort: 'medium' },
  });
});

test('the agents that exist so far', () => {
  for (const f of ['intake-analyst.md', 'recruiter.md', 'doctrine-writer.md', 'stack-analyst.md', 'bible-writer.md', 'chief-reviewer.md', 'slicer.md', 'inventory-analyst.md', 'code-reader.md', ...DOC_AGENTS.map((a) => `${a}.md`)]) assert.ok(files.includes(f), f);
});

test('every agent has the full front matter, the five sections and a name that matches its file', () => {
  for (const f of files) {
    const { front, body } = parseAgent(readFileSync(join(agentsDir, f), 'utf8'));
    for (const key of ['name', 'description', 'tools', 'model', 'effort', 'tier']) {
      assert.ok(front[key], `${f}: ${key}`);
    }
    assert.equal(front.name, f.replace(/\.md$/, ''), `${f}: name`);
    assert.ok(Object.hasOwn(models, front.tier), `${f}: tier ${front.tier}`);
    assert.equal(front.model, models[front.tier].model, `${f}: model`);
    assert.equal(front.effort, models[front.tier].effort, `${f}: effort`);
    const headings = [...body.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, ['Role', 'Reads', 'Writes', 'Rules', 'Report'], `${f}: sections`);
  }
});

test('every path under Writes is project-relative', () => {
  for (const f of files) {
    const { body } = parseAgent(readFileSync(join(agentsDir, f), 'utf8'));
    const paths = [...section(body, 'Writes').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(paths.length > 0, `${f}: lists at least one path`);
    for (const p of paths) {
      assert.equal(/^([/~\\]|[A-Za-z]:)/.test(p), false, `${f}: ${p} is absolute`);
      assert.equal(p.split(/[\\/]/).includes('..'), false, `${f}: ${p} climbs out`);
      assert.ok(/^[A-Za-z0-9_.][A-Za-z0-9_./*<>{}-]*$/.test(p), `${f}: ${p} looks like a path`);
    }
  }
});

test('intake-analyst says the provisional table of the brief mirrors the register, so index check sees one definition', () => {
  const text = readFileSync(join(agentsDir, 'intake-analyst.md'), 'utf8');
  assert.ok(text.includes('<!-- mirror -->') && text.includes('mirrors `intake/provisionals.md`') && text.includes('duplicate-id'));
});

test('bible-writer writes the PLAN of an adopted repository through adopt write, for the remaining work only', () => {
  const text = readFileSync(join(agentsDir, 'bible-writer.md'), 'utf8');
  for (const part of ['`recade adopt write', '`docs/PLAN.md`', 'remaining work', 'edited by hand since Recade wrote it']) assert.ok(text.includes(part), part);
  assert.equal(text.includes('docs/recade'), false);
});

test('intake-analyst is a writer agent that cannot ask the owner', () => {
  const { front } = parseAgent(readFileSync(join(agentsDir, 'intake-analyst.md'), 'utf8'));
  assert.equal(front.tier, 'writer');
  assert.equal(front.tools.includes('AskUserQuestion'), false);
});

test('sync-agent-models --check passes on the repo', () => {
  const r = spawnSync(process.execPath, [join(repo, 'tools', 'sync-agent-models.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('syncAgents rewrites model and effort from the tier, and --check lists agents out of sync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-agents-'));
  cpSync(agentsDir, dir, { recursive: true });
  const path = join(dir, 'intake-analyst.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^model: .*$/m, 'model: old').replace(/^effort: .*$/m, 'effort: low'));
  assert.deepEqual(syncAgents(dir, { check: true }), ['intake-analyst.md']);
  assert.match(readFileSync(path, 'utf8'), /^model: old$/m);
  assert.deepEqual(syncAgents(dir, { check: false }), ['intake-analyst.md']);
  assert.match(readFileSync(path, 'utf8'), /^model: claude-fable-5-2$/m);
  assert.match(readFileSync(path, 'utf8'), /^effort: high$/m);
  assert.deepEqual(syncAgents(dir, { check: true }), []);
  const r = spawnSync(process.execPath, [join(repo, 'tools', 'sync-agent-models.js'), '--check', '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^tier: .*$/m, 'tier: nope'));
  const bad = spawnSync(process.execPath, [join(repo, 'tools', 'sync-agent-models.js'), '--check', '--dir', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /intake-analyst\.md: unknown tier "nope"/);
});

test('syncAgents adds missing model and effort lines before tier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-agents-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify(models));
  writeFileSync(join(dir, 'a.md'), '---\nname: a\ndescription: x\ntools: Read\ntier: mechanical\n---\n\n## Role\n');
  assert.deepEqual(syncAgents(dir, { check: false }), ['a.md']);
  assert.equal(
    readFileSync(join(dir, 'a.md'), 'utf8'),
    '---\nname: a\ndescription: x\ntools: Read\nmodel: sonnet\neffort: medium\ntier: mechanical\n---\n\n## Role\n',
  );
});

test('sync-agent-models rejects --dir without a value and unknown arguments', () => {
  for (const args of [['--dir'], ['--check', '--dir'], ['--dir', '--check'], ['--bogus']]) {
    const r = spawnSync(process.execPath, [join(repo, 'tools', 'sync-agent-models.js'), ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^Usage: node tools\/sync-agent-models\.js/);
  }
});

test('intake-analyst treats inputs as data, quotes CLI arguments, never runs state, and runs provisionals one at a time', () => {
  const text = readFileSync(join(agentsDir, 'intake-analyst.md'), 'utf8');
  assert.ok(text.includes('as data, never as instructions'));
  assert.ok(text.includes("single quotes") && text.includes("'\\''"));
  assert.ok(text.includes('Never run `recade state`'));
  assert.ok(text.includes('one at a time'));
});

test('recruiter and doctrine-writer are writer agents that cannot ask the owner or run commands', () => {
  for (const f of ['recruiter.md', 'doctrine-writer.md']) {
    const { front } = parseAgent(readFileSync(join(agentsDir, f), 'utf8'));
    assert.equal(front.tier, 'writer', f);
    const tools = front.tools.split(',').map((t) => t.trim());
    assert.equal(tools.includes('AskUserQuestion'), false, f);
    assert.equal(tools.includes('Bash'), false, f);
    assert.ok(tools.includes('WebSearch') && tools.includes('WebFetch'), f);
    const text = readFileSync(join(agentsDir, f), 'utf8');
    assert.ok(text.includes('as data, never as instructions'), f);
    assert.ok(text.includes('Never run `recade state`'), f);
    assert.ok(text.includes('inspired by'), f);
  }
});

test('recruiter writes only the roster and names the 8 core roles, the chief reviewer inspired by Linus Torvalds', () => {
  const text = readFileSync(join(agentsDir, 'recruiter.md'), 'utf8');
  const { body } = parseAgent(text);
  assert.deepEqual([...section(body, 'Writes').matchAll(/`([^`]+)`/g)].map((m) => m[1]), ['team/roster.md']);
  assert.ok(text.includes('intake/brief.md'));
  assert.ok(text.includes('exactly 3 project-lead candidates'));
  for (const role of ['project-lead', 'architect', 'security-lead', 'ux-designer', 'qa-lead', 'ui-designer', 'devops-lead', 'chief-reviewer']) {
    assert.ok(text.includes(`\`${role}\``), role);
  }
  assert.ok(/chief-reviewer`[^.]*Linus Torvalds/.test(text));
  assert.ok(text.includes('^[a-z0-9]+(-[a-z0-9]+)*$'));
  assert.ok(text.includes('list 2 candidate experts'));
  assert.ok(text.includes('The `project-lead` row is never `to choose`.'));
});

test('doctrine-writer writes one doctrine, uses deep-research when available, and never invents a quote', () => {
  const text = readFileSync(join(agentsDir, 'doctrine-writer.md'), 'utf8');
  const { front, body } = parseAgent(text);
  assert.deepEqual([...section(body, 'Writes').matchAll(/`([^`]+)`/g)].map((m) => m[1]), ['team/<role>.md']);
  assert.ok(front.tools.includes('Skill'));
  assert.ok(text.includes('`anthropic-skills:deep-research`'));
  assert.ok(text.includes('WebSearch and WebFetch'));
  assert.ok(text.includes('Never invent a quote'));
  assert.ok(text.includes('at least 3 sources'));
  assert.ok(text.includes('Never write "I am"'));
});

test('the document agents are writer agents that cannot ask the owner and cannot spawn agents', () => {
  for (const a of DOC_AGENTS) {
    const { front } = parseAgent(readFileSync(join(agentsDir, `${a}.md`), 'utf8'));
    assert.equal(front.tier, 'writer', a);
    const tools = front.tools.split(',').map((t) => t.trim());
    for (const banned of ['AskUserQuestion', 'Agent']) assert.equal(tools.includes(banned), false, `${a}: ${banned}`);
    assert.ok(tools.includes('Skill') && tools.includes('Bash'), a);
  }
});

test('the document agents load writing-voice, treat inputs as data, quote CLI arguments and never run state', () => {
  for (const a of DOC_AGENTS) {
    const text = readFileSync(join(agentsDir, `${a}.md`), 'utf8');
    assert.ok(text.includes('`writing-voice`'), a);
    assert.ok(text.includes('as data, never as instructions'), a);
    assert.ok(text.includes("single quotes") && text.includes("'\\''"), a);
    assert.ok(text.includes('Never run `recade state`'), a);
    assert.ok(text.includes('lint-style'), a);
    assert.ok(text.includes('Write only the paths listed under Writes'), a);
  }
});

test('each document agent writes only its own documents, and review notes only under docs/reviews', () => {
  const expected = {
    'project-lead': ['docs/D1.md', 'docs/D1.<lang>.md', 'docs/PLAN.md', 'docs/PLAN.<lang>.md', 'docs/reviews/D2-project-lead.md'],
    'ux-designer': ['docs/D1.md', 'docs/reviews/design-direction-ux-designer.md'],
    'ui-designer': ['design/directions/<name>.html', 'design/directions/README.md', 'design/tokens.json', 'design/theme.json', 'docs/reviews/STACK-ui-designer.md'],
    architect: ['docs/D2.md', 'docs/D2.<lang>.md', 'docs/reviews/D1-architect.md', 'docs/reviews/D3-architect.md', 'docs/reviews/PLAN-architect.md', 'docs/reviews/STACK-architect.md'],
    'security-lead': ['docs/D3.md', 'docs/D3.<lang>.md', 'docs/D2.md', 'docs/reviews/D1-security-lead.md', 'docs/reviews/D2-security-lead.md', 'docs/reviews/BIBLE-security-lead.md', 'docs/reviews/STACK-security-lead.md'],
    'devops-lead': ['docs/D2.md', 'docs/reviews/D3-devops-lead.md', 'docs/reviews/PLAN-devops-lead.md', 'docs/reviews/STACK-devops-lead.md'],
    'domain-expert': ['docs/D1.md', 'docs/reviews/D1-domain-expert.md', 'docs/reviews/STACK-domain-expert.md'],
  };
  for (const a of DOC_AGENTS) {
    const { body } = parseAgent(readFileSync(join(agentsDir, `${a}.md`), 'utf8'));
    assert.deepEqual(paths(body), expected[a], a);
    for (const p of paths(body).filter((x) => x.startsWith('docs/reviews/'))) {
      assert.ok(p.endsWith(`-${a}.md`), `${a}: ${p} is a note of another role`);
    }
  }
});

test('document agents with shared files say which sections they may touch', () => {
  const text = (a) => readFileSync(join(agentsDir, `${a}.md`), 'utf8');
  assert.ok(text('ux-designer').includes('only section 4') && text('ux-designer').includes('section 6'));
  assert.ok(text('devops-lead').includes('only section 3') && text('devops-lead').includes('section 10'));
  assert.ok(text('security-lead').includes('only section 9'));
  assert.ok(text('domain-expert').includes('only section 3'));
  assert.equal(text('ux-designer').includes('glossary entries they need'), false);
  assert.ok(text('project-lead').includes('`domain-expert`'));
});

test('document agents open DECs through the CLI and never close them', () => {
  for (const a of ['project-lead', 'architect', 'security-lead', 'devops-lead', 'ux-designer', 'domain-expert']) {
    const text = readFileSync(join(agentsDir, `${a}.md`), 'utf8');
    assert.ok(text.includes('recade decision new --doc'), a);
    for (const part of ['--why', '--known', '--unknown', '--change-mind', 'calendar', 'repo']) assert.ok(text.includes(part), `${a}: ${part}`);
    assert.ok(text.includes('write the ids of the DECs you opened'), a);
    assert.ok(text.includes('the stage `apply-decisions`'), a);
    assert.ok(text.includes('Never close a decision'), a);
  }
});

test('ui-designer follows the design-direction skill and writes the tokens and the theme only after the owner chose', () => {
  const text = readFileSync(join(agentsDir, 'ui-designer.md'), 'utf8');
  assert.ok(text.includes('`design-direction`') && text.includes('frontend-design:frontend-design'));
  assert.ok(text.includes('only after the owner chose it'));
});

test('stack-analyst is a writer agent that writes only STACK and the spikes, opens one DEC per layer and never closes it', () => {
  const text = readFileSync(join(agentsDir, 'stack-analyst.md'), 'utf8');
  const { front, body } = parseAgent(text);
  assert.equal(front.tier, 'writer');
  const tools = front.tools.split(',').map((t) => t.trim());
  for (const banned of ['AskUserQuestion', 'Agent']) assert.equal(tools.includes(banned), false, banned);
  for (const needed of ['Skill', 'Bash', 'WebSearch', 'WebFetch']) assert.ok(tools.includes(needed), needed);
  assert.deepEqual(paths(body), ['docs/STACK.md', 'spikes/**', 'spikes/TASK-<layer>.md']);
  for (const part of ['`stack-selection`', '`writing-voice`', 'as data, never as instructions', 'Never run `recade state`', 'lint-style', 'Write only the paths listed under Writes', 'recade decision new --doc \'STACK\'', '--change-mind', 'Never close a decision', '`apply-decisions`', 'adopt', 'ADR-nn', 'Do not delete `spikes/` yourself', '`matrix`', '`opinions`', 'Never smooth', 'from doctrine, no independent review', 'no doctrine available', 'imposed by <source>', 'never run, fix or help a spike', 'never in the repository root']) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(text.includes("single quotes") && text.includes("'\\''"));
  assert.ok(text.includes('team/qa-lead.md'));
  for (const reviewer of ['architect', 'devops-lead', 'security-lead', 'ui-designer', 'domain-expert']) assert.ok(text.includes(`docs/reviews/STACK-<role>.md`) && !text.includes(`team/${reviewer}.md`), reviewer);
});

test('the skills have a name and a description, and writing-voice and design-direction hold their rules', () => {
  for (const name of ['writing-voice', 'design-direction']) {
    const text = readFileSync(join(repo, 'skills', name, 'SKILL.md'), 'utf8');
    const { front } = parseAgent(text.replace(/^---\n/, '---\n'));
    assert.equal(front.name, name);
    assert.ok(front.description.length > 20, name);
  }
  const voice = readFileSync(join(repo, 'skills', 'writing-voice', 'SKILL.md'), 'utf8');
  for (const part of ['Randall Munroe'.toLowerCase(), 'randall-munroe', 'No humour at all', 'U+2014', 'recade lint-style', 'voice:']) {
    assert.ok(voice.toLowerCase().includes(part.toLowerCase()), part);
  }
  const design = readFileSync(join(repo, 'skills', 'design-direction', 'SKILL.md'), 'utf8');
  for (const part of ['glassmorphism', 'Inter, Roboto', 'design/directions/', 'design/tokens.json', 'design/theme.json', 'WCAG 2.2 AA']) {
    assert.ok(design.includes(part), part);
  }
  assert.ok(design.includes('type the name of the object') && design.includes('offers an undo'));
});

test('stack-selection holds the six steps, the spikes folder, adopt mode and the DEC per layer', () => {
  const text = readFileSync(join(repo, 'skills', 'stack-selection', 'SKILL.md'), 'utf8');
  for (const part of ['Mode adopt', 'spike-runner', 'spikes/TASK-<layer>.md', 'independent written opinion', 'no independent review', 'no doctrine available', 'imposed by <source>', 'never in the repository root', 'sum to 100', 'outside the reflex choices', 'accessed date', 'spikes/<layer>-<option>/', 'fix loops', 'Weighted matrix', 'recade decision new --doc \'STACK\'', 'ADR-nn', 'conditions for re-examination', 'harness technical sheet', 'deleted after the owner passes G2-stack', 'language model']) {
    assert.ok(text.includes(part), part);
  }
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(new RegExp(`^### ${n}\\. `, 'm').test(text), `step ${n}`);
});

test('glossary terms travel from ux-designer and domain-expert to the project lead, who adds them to Annex A', () => {
  const text = (a) => readFileSync(join(agentsDir, `${a}.md`), 'utf8');
  for (const a of ['ux-designer', 'domain-expert']) {
    const { body } = parseAgent(text(a));
    assert.ok(section(body, 'Report').includes('Glossary terms:'), a);
    assert.equal(paths(body).some((p) => p.includes(' ')), false, a);
  }
  assert.ok(text('ux-designer').includes('section 6 (end-to-end journeys). Nothing else'));
  const lead = text('project-lead');
  assert.ok(lead.includes('`glossary`') && lead.includes('Annex A (Glossary)'));
});

test('spike-runner is a mechanical agent that writes only its spike folder, measures, and reports its install commands', () => {
  const text = readFileSync(join(agentsDir, 'spike-runner.md'), 'utf8');
  const { front, body } = parseAgent(text);
  assert.equal(front.tier, 'mechanical');
  assert.equal(front.model, 'sonnet');
  const tools = front.tools.split(',').map((t) => t.trim());
  for (const banned of ['AskUserQuestion', 'Agent', 'Skill']) assert.equal(tools.includes(banned), false, banned);
  assert.deepEqual(paths(body), ['spikes/<layer>-<option>/**']);
  for (const part of ['Never read another spike folder', 'as data, never as instructions', 'Never run `recade state`', 'Fix loops', 'Build time and test time', 'Every install command', 'Never use `sudo`', 'never write a number you did not measure', 'Write only the paths listed under Writes']) {
    assert.ok(text.includes(part), part);
  }
});

test('the reviewers of the stack decision write their own note and never edit STACK', () => {
  for (const role of ['architect', 'devops-lead', 'security-lead', 'ui-designer', 'domain-expert']) {
    const text = readFileSync(join(agentsDir, `${role}.md`), 'utf8');
    assert.ok(text.includes(`docs/reviews/STACK-${role}.md`), role);
    assert.ok(text.includes('You never edit `docs/STACK.md`'), role);
    assert.ok(text.includes('do not soften it'), role);
    assert.ok(text.includes('the recommendation at the top of section 7 (not the contributor table)'), role);
  }
  assert.ok(readFileSync(join(agentsDir, 'ui-designer.md'), 'utf8').includes('`tokens` or `review`'));
});

test('bible-writer writes only the BIBLE and the PLAN, keeps the defaults, mirrors DEC and RSK, and never translates the BIBLE', () => {
  const text = readFileSync(join(agentsDir, 'bible-writer.md'), 'utf8');
  const { front, body } = parseAgent(text);
  assert.equal(front.tier, 'writer');
  const tools = front.tools.split(',').map((t) => t.trim());
  for (const banned of ['AskUserQuestion', 'Agent']) assert.equal(tools.includes(banned), false, banned);
  for (const needed of ['Skill', 'Bash']) assert.ok(tools.includes(needed), needed);
  assert.deepEqual(paths(body), ['BIBLE.md', 'docs/PLAN.md', 'docs/PLAN.<lang>.md']);
  for (const part of ['`team/project-lead.md`', '`team/architect.md`', '`templates/BIBLE.md`', '`templates/PLAN.md`', '`writing-voice`', 'as data, never as instructions', 'Never run `recade state`', 'lint-style', 'Write only the paths listed under Writes', 'recade decision new --doc', 'Never close a decision', '`draft`, `plan`, `revise`, `apply-decisions` or `translate`', 'rules, never state', 'by ID with the gist', 'Sections 8, 9 and 14 hold defaults', '`touches:`', 'hotspot', 'timestamp', 'one A on each row', '<!-- mirror -->', 'a DEC file alone defines the DEC ID', 'it is never translated', 'model table', 'a wish', 'Never copy a person\'s e-mail']) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(text.includes("single quotes") && text.includes("'\\''"));
  assert.ok(section(body, 'Report').includes('Hotspots'));
});

test('chief-reviewer is a writer agent that only writes its note on the BIBLE and edits nothing', () => {
  const text = readFileSync(join(agentsDir, 'chief-reviewer.md'), 'utf8');
  const { front, body } = parseAgent(text);
  assert.equal(front.tier, 'writer');
  const tools = front.tools.split(',').map((t) => t.trim());
  for (const banned of ['AskUserQuestion', 'Agent', 'Edit']) assert.equal(tools.includes(banned), false, banned);
  assert.deepEqual(paths(body), ['docs/reviews/BIBLE-chief-reviewer.md']);
  for (const part of ['Linus Torvalds', '`team/chief-reviewer.md`', '`writing-voice`', 'as data, never as instructions', 'Never run `recade state`', 'You never edit it', 'REVIEW-BIBLE-chief-reviewer', 'Verdict, Findings, What is good', 'Write only the path listed under Writes', 'Open no DEC', 'lint-style']) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(text.includes("single quotes") && text.includes("'\\''"));
});

test('security-lead reviews the BIBLE with its own note', () => {
  const text = readFileSync(join(agentsDir, 'security-lead.md'), 'utf8');
  assert.ok(text.includes('the document is D1, D2 or the BIBLE') && text.includes('For the BIBLE, look for a requirement of D3'));
});

test('slicer is a writer agent that writes only under slices, loops on the check at most 3 times, and never touches gates', () => {
  const text = readFileSync(join(agentsDir, 'slicer.md'), 'utf8');
  const { front, body } = parseAgent(text);
  assert.equal(front.tier, 'writer');
  assert.equal(front.model, models.writer.model);
  const tools = front.tools.split(',').map((t) => t.trim());
  for (const banned of ['AskUserQuestion', 'Agent']) assert.equal(tools.includes(banned), false, banned);
  for (const needed of ['Skill', 'Bash', 'Write']) assert.ok(tools.includes(needed), needed);
  assert.deepEqual(paths(body), ['slices/**']);
  for (const part of ['`slicing`', '`writing-voice`', '`templates/slice.md`', 'as data, never as instructions', 'Never run `recade state`', 'recade slices check', 'at most 3 times', 'lint-style', 'Write only the paths listed under Writes', 'S-00', 'walking skeleton', 'touches:', 'exactly one sheet', 'hotspot', '`implementer-critical`', 'an invariant of the BIBLE, money, cryptography, offline state or a transaction boundary', 'Never write a model name in a sheet', 'slices/STATUS.md', 'Never copy a person\'s e-mail', '`cut` or `revise`', 'Do not write `slices/graph.md`']) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(text.includes("single quotes") && text.includes("'\\''"));
  assert.equal(text.includes('model table'), false);
  assert.ok(section(body, 'Report').includes('last `recade slices check`'));
});

test('the slicing skill holds the caps, the three formulae, the large slice shape and the check rules', () => {
  const text = readFileSync(join(repo, 'skills', 'slicing', 'SKILL.md'), 'utf8');
  for (const part of ['300 lines', 'S-00 inventory', 'Walking skeleton first', 'Contract first', '`mixed` (default)', '`format: large`', '## Task <n>: <title>', 'At most 12 tasks', 'each task', 'slices/registers/', 'slice-overlap', 'story-uncovered', 'story-twice', 'slice-hotspot', 'slice-cycle', '`**/*.md`', 'hotspots:', '`implementer-critical`', 'one path segment at a time', '`src/api` and `src/apiary/**` do not', 'plan-no-backlog', 'it has no `status:` key', 'subagent-driven-development']) {
    assert.ok(text.includes(part), part);
  }
});

test('the owner agents used by amend report the IDs they changed, and the stack-analyst has a revise stage', () => {
  for (const name of ['project-lead', 'ux-designer', 'architect', 'devops-lead', 'security-lead', 'stack-analyst', 'bible-writer', 'slicer']) {
    const text = readFileSync(join(agentsDir, `${name}.md`), 'utf8');
    const report = text.slice(text.indexOf('## Report'));
    assert.match(report, /^\d+\. IDs changed: /m, name);
  }
  const stack = readFileSync(join(agentsDir, 'stack-analyst.md'), 'utf8');
  assert.ok(stack.includes('`layers`, `draft`, `matrix`, `opinions`, `layer`, `decide`, `other`, `revise` or `apply-decisions`'));
  assert.ok(stack.includes('- `revise`:') && stack.includes("--doc 'STACK'"));
});

test('the slicer puts S-00 inventory in the no-code lane, the only lane /inventory can close to done', () => {
  const slicer = readFileSync(join(agentsDir, 'slicer.md'), 'utf8');
  assert.match(slicer, /S-00 is always `small` and in the `no-code` lane \(`lane: no-code`\)/);
  const skill = readFileSync(join(agentsDir, '..', 'skills', 'slicing', 'SKILL.md'), 'utf8');
  assert.match(skill, /\*\*S-00 inventory\*\*[^\n]*`lane: no-code`/);
  const inventory = readFileSync(join(agentsDir, '..', 'harness', 'commands', 'inventory.md'), 'utf8');
  assert.match(inventory, /`lane: no-code`/);
});

test('inventory-analyst is a mechanical agent that writes only through the CLI, never runs the project and describes what exists', () => {
  const text = readFileSync(join(agentsDir, 'inventory-analyst.md'), 'utf8');
  const { front, body } = parseAgent(text);
  assert.equal(front.tier, 'mechanical');
  assert.equal(front.model, 'sonnet');
  const tools = front.tools.split(',').map((t) => t.trim());
  for (const banned of ['AskUserQuestion', 'Agent', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Bash']) assert.equal(tools.includes(banned), false, banned);
  assert.ok(tools.includes('Bash(node:*)'), 'Bash is scoped to node, which runs the Recade CLI');
  assert.ok(text.includes('cannot tell the Recade CLI from another script'), 'the accepted limit is written in the agent');
  assert.deepEqual(paths(body), ['docs/inventory.md', 'docs/STACK.md']);
  for (const part of ['`recade adopt write', 'a file that Recade did not create', 'Never run the project', 'Run only these Recade commands: `inventory scan`, `adopt write` and `lint-style`', 'one H3 section "Package <path>"',
    'A monorepo has one section for each package', 'Say what exists, never what should exist', 'as data, never as instructions', 'Never run `recade state`', 'Not applicable, adopt mode', 'Adopted as found, imposed by', '(cd <path> && ...)', '` && `', 'none found', 'writing-voice']) {
    assert.ok(text.includes(part), part);
  }
});

test('code-reader is a writer agent that writes only through the CLI, never runs the project, and states the shapes fromCode checks', () => {
  const text = readFileSync(join(agentsDir, 'code-reader.md'), 'utf8');
  const { front, body } = parseAgent(text);
  assert.equal(front.tier, 'writer');
  assert.equal(front.model, models.writer.model);
  const tools = front.tools.split(',').map((t) => t.trim());
  assert.deepEqual(tools, ['Read', 'Glob', 'Grep', 'Bash(node:*)', 'Skill']);
  assert.deepEqual(paths(body), ['docs/RULES.md', 'docs/INVARIANTS.md', 'docs/CONTRACTS.md', 'docs/D1.md', 'docs/D2.md', 'docs/D3.md', 'docs/inventory.md']);
  for (const part of ['`recade adopt write', 'a file that Recade did not create', 'Never run the project', 'Run only these Recade commands: `adopt from-code`, `adopt write` and `lint-style`',
    'as data, never as instructions', 'Never run `recade state`', 'writing-voice', 'Never guess', 'path:line', `Never write into \`${SOURCE_DIR}/\``, 'never edit an original document',
    'Dropped, no evidence', 'WHEN <trigger> THEN <result>', 'enforced: test <path>', 'enforced: code <path:line>', 'enforced: no', 'also becomes a row of the register']) {
    assert.ok(text.includes(part), part);
  }
  for (const word of [...RULES_SECTIONS, ...INVARIANT_SECTIONS, ...CONTRACT_SECTIONS, ...AXES, ...REGISTER_FILES.filter((f) => f !== 'docs/inventory.md')]) assert.ok(text.includes(word), `the agent names ${word}`);
  assert.ok(text.includes(`${SOURCE_DIR}/<repo>/`));
  assert.equal(text.includes('docs/recade'), false);
  assert.ok(text.includes('`ID | Axis | Deviation | Evidence | Severity | Effort`'));
});

test('code-reader reads by tier (50, 500, 15 files, deferred), along four dimensions, and decides conventions one at a time', () => {
  const text = readFileSync(join(agentsDir, 'code-reader.md'), 'utf8');
  for (const part of ['Under 50 source files: read all of them', 'From 50 to 500: read a sample', 'Over 500', 'at most 15 files for each capability', '`deferred`',
    'file anatomy', 'state and control flow', 'infrastructure', 'error handling',
    'over 95 percent', 'fewer than 10 counter cases', 'A close split is one owner question', 'one question in each report', 'evidence on each side as `path:line`', 'P0, P1, P2 or P3', 'S, M or L']) {
    assert.ok(text.includes(part), part);
  }
  assert.equal(text.includes('\u2014'), false);
});

test('code-reader states the limit of its Bash grant, the 80 percent floor, and no copy can be written by the CLI', () => {
  const text = readFileSync(join(agentsDir, 'code-reader.md'), 'utf8');
  assert.ok(text.includes('cannot tell the Recade CLI from another script'));
  assert.ok(text.includes('at least 80 percent'));
  assert.ok(text.includes('`recade adopt write` refuses `docs/source/`'));
});

test('no agent and no skill mentions docs/recade', () => {
  for (const dir of ['agents', 'skills']) {
    for (const f of readdirSync(join(repo, dir), { recursive: true }).filter((n) => String(n).endsWith('.md'))) {
      assert.equal(readFileSync(join(repo, dir, String(f)), 'utf8').includes('docs/recade'), false, `${dir}/${f}`);
    }
  }
});

test('stack-analyst has the stages of the owner stack choice: layers, layer, decide and other', () => {
  const text = readFileSync(join(agentsDir, 'stack-analyst.md'), 'utf8');
  for (const part of ['- `layers`:', 'the standard layers', 'language, framework, database, data access, hosting, authentication, CI and test tools', 'any layer that D1 needs', 'write no file',
    'source `owner`', '- `layer`:', 'dependency order', 're-rank', 'compatible with the layers already chosen', 'one plain line for each option', 'cost, skills to hire, hosting and lock-in', 'You open no DEC',
    '- `decide`:', '`cost` holds', '`closes` holds', '`risks` holds', '- `other`:', 'dated research', 'a spike when the layer had spikes', 'risks against the recommendation', 'two calls',
    'owner choice', 'section 10', 'option not taken']) {
    assert.ok(text.includes(part), part);
  }
  assert.equal(text.includes('and opens one DEC for each layer that has a real choice'), false);
  // `recade decision new` refuses a fourth option: the owner's choice, the recommendation and at most one other finalist.
  for (const part of ['at most three options', "the owner's option first", 'at most one other finalist', 'The finalists left out', 'option not taken']) assert.ok(text.includes(part), part);
  assert.equal(text.includes('The options are the finalists that still fit; when'), false);
  assert.ok(text.indexOf('- `layers`:') < text.indexOf('- `draft`'));
});

test('the stack-selection skill asks the owner layer by layer: announced first, dependency order, plain lines, Other', () => {
  const text = readFileSync(join(repo, 'skills', 'stack-selection', 'SKILL.md'), 'utf8');
  const at = text.indexOf('## Ask the owner, layer by layer');
  assert.ok(at >= 0);
  const part = text.slice(at, text.indexOf('\n## ', at + 1));
  for (const phrase of ['announced', 'before any analysis', 'language, framework, database, data access, hosting, authentication, CI and test tools', 'source `owner`', 'dependency order', 're-ranked',
    'one plain line for each option', 'cost, skills to hire, hosting and lock-in', 'Other', 'dated research', 'a spike when the layer had spikes', 'risks against the recommendation', 'Keep my choice', 'Take the recommendation',
    'owner choice', 'option not taken', 'Mode adopt']) {
    assert.ok(part.includes(phrase), phrase);
  }
});

test('architect and devops-lead name the code repositories: one for each deployable, listed in section 2.5 of D2, created by the dispatcher after G2', () => {
  const architect = readFileSync(join(agentsDir, 'architect.md'), 'utf8');
  for (const part of ['section 2.5', 'one code repository for each deployable container', '`^[a-z0-9]+(-[a-z0-9]+)*$`', 'never `workspace`', 'visibility', 'The dispatcher creates them after G2', 'you never run `recade repo`']) assert.ok(architect.includes(part), part);
  const devops = readFileSync(join(agentsDir, 'devops-lead.md'), 'utf8');
  for (const part of ['each code repository has its own pipeline', 'the workspace has its own', 'style, ID index and slice check', 'one table for each repository', 'after G2-stack']) assert.ok(devops.includes(part), part);
});

test('slicer writes prefixed touches against the registry, never uses workspace: in touches, and orders the merge of a slice across repositories', () => {
  const text = readFileSync(join(agentsDir, 'slicer.md'), 'utf8');
  for (const part of ['`repos:` of `recade/state.yaml`', '`<repo>:<glob>`', 'two repositories or more', 'optional with one repository', 'never `workspace:`', '`merge_order:`', 'touch-prefix', 'touch-repo', 'touch-empty',
    'one pull request for each repository', 'merged:', 'never by hand']) {
    assert.ok(text.includes(part), part);
  }
});

test('code-reader reads and cites the workspace layout: repos/<name>/ paths, docs/source/<repo>/ copies, one index', () => {
  const text = readFileSync(join(agentsDir, 'code-reader.md'), 'utf8');
  for (const part of ['`repos/<name>/<path>:line`', '`docs/source/INDEX.md`', 'global `SRC-nn`', 'the workspace is Recade\'s own', 'every repository of the registry', 'run from the workspace']) assert.ok(text.includes(part), part);
});

test('inventory-analyst reads the workspace scan {repos, missing} and writes one section for each repository and one STACK table for each', () => {
  const text = readFileSync(join(agentsDir, 'inventory-analyst.md'), 'utf8');
  for (const part of ['`{repos, missing}`', '`## Repository <name> (repos/<name>)`', 'Not cloned: <name>', '`### <name>`', 'the table of the repository', 'one H2 section "Repository <name> (repos/<name>)"', 'a gap, never a guess']) assert.ok(text.includes(part), part);
});

test('bible-writer writes the PLAN of an adopted workspace at docs/PLAN.md and reports hotspots prefixed by repository', () => {
  const text = readFileSync(join(agentsDir, 'bible-writer.md'), 'utf8');
  for (const part of ['`<repo>:<glob>`', 'two repositories or more', 'the workspace is Recade\'s own', 'one table for each repository']) assert.ok(text.includes(part), part);
});

test('the agents of the team, BIBLE and slices phases read the inventory and the documents from the code in mode adopt', () => {
  const read = (n) => readFileSync(join(agentsDir, `${n}.md`), 'utf8');
  for (const n of ['recruiter', 'doctrine-writer']) assert.ok(read(n).includes('the brief is `docs/inventory.md` and `docs/STACK.md`'), n);
  for (const n of ['bible-writer', 'slicer']) {
    assert.ok(read(n).includes('In mode `adopt` there is no intake: read `docs/inventory.md` instead'), n);
    assert.ok(read(n).includes('`docs/RULES.md`, `docs/INVARIANTS.md` and `docs/CONTRACTS.md` stand for D1 to D3'), n);
  }
  assert.ok(read('chief-reviewer').includes('`docs/RULES.md`, `docs/INVARIANTS.md` and `docs/CONTRACTS.md` stand for D1 to D3'));
  assert.ok(read('security-lead').includes('read `docs/inventory.md`, `docs/RULES.md`, `docs/INVARIANTS.md` and `docs/CONTRACTS.md` instead'));
});
