import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDoctrine, checkTeam, DOCTRINE_SECTIONS } from '../../src/project/doctrine.js';
import { run } from '../../src/cli.js';

const SOURCES = [
  { title: 'The Linux kernel coding style', url: 'https://example.org/kernel-style', accessed: '2026-11-12' },
  { title: 'A talk on code review', url: 'https://example.org/review-talk', accessed: '2026-11-12' },
  { title: 'An interview on small patches', url: 'https://example.org/patches', accessed: '2026-11-13' },
];

function doctrine({ front = {}, drop = [], body = {} } = {}) {
  const meta = { role: 'chief-reviewer', inspired_by: 'Linus Torvalds', model: 'claude-fable-5-2', effort: 'high', sources: SOURCES, ...front };
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (k === 'sources') {
      lines.push('sources:');
      for (const s of v) lines.push(`  - { title: "${s.title}", url: "${s.url}", accessed: "${s.accessed}" }`);
    } else lines.push(`${k}: "${v}"`);
  }
  lines.push('---', '');
  for (const h of DOCTRINE_SECTIONS.filter((s) => !drop.includes(s))) {
    lines.push(`## ${h}`, '', body[h] ?? 'A line that says something.', '');
  }
  return lines.join('\n');
}

const rules = (findings) => findings.map((f) => f.rule);

test('the sections follow spec section 6', () => {
  assert.deepEqual(DOCTRINE_SECTIONS, [
    'Why this profile for this project', 'Convictions (each with its source)', 'Working rules (imperative, verifiable)',
    'Review checklist', 'What they refuse', 'How they settle a disagreement', 'Limits (what not to ask them)',
  ]);
});

test('a valid doctrine has no finding', () => {
  assert.deepEqual(validateDoctrine(doctrine(), 'team/chief-reviewer.md'), []);
});

test('a missing section is an error that names the section', () => {
  const f = validateDoctrine(doctrine({ drop: ['Review checklist'] }), 'team/chief-reviewer.md');
  assert.deepEqual(rules(f), ['doctrine-section']);
  assert.equal(f[0].severity, 'error');
  assert.equal(f[0].file, 'team/chief-reviewer.md');
  assert.match(f[0].message, /Review checklist/);
});

test('two sources are not enough', () => {
  const f = validateDoctrine(doctrine({ front: { sources: SOURCES.slice(0, 2) } }), 'team/chief-reviewer.md');
  assert.deepEqual(rules(f), ['doctrine-sources']);
  assert.match(f[0].message, /3/);
});

test('"I am Linus" in the body is an identity claim', () => {
  const f = validateDoctrine(doctrine({ body: { 'Why this profile for this project': 'I am Linus, and I review code.' } }), 'team/chief-reviewer.md');
  assert.deepEqual(rules(f), ['doctrine-identity']);
  assert.equal(f[0].severity, 'error');
  assert.equal(f[0].line > 1, true);
  assert.equal(rules(validateDoctrine(doctrine({ body: { 'What they refuse': 'i AM the reviewer' } }), 'team/x.md')).includes('doctrine-identity'), true);
});

test('"I am" in the front matter does not count, "I amend" and "Siam" are fine', () => {
  const ok = doctrine({ body: { 'What they refuse': 'Refuse to amend history. I amend nothing. Siam is a place.' } });
  assert.deepEqual(validateDoctrine(ok, 'team/chief-reviewer.md'), []);
});

test('a bad accessed date is an error, also an impossible one', () => {
  for (const accessed of ['yesterday', '12/11/2026', '2026-13-40', '2026-02-30']) {
    const bad = [{ ...SOURCES[0], accessed }, SOURCES[1], SOURCES[2]];
    const f = validateDoctrine(doctrine({ front: { sources: bad } }), 'team/chief-reviewer.md');
    assert.deepEqual(rules(f), ['doctrine-source'], accessed);
    assert.match(f[0].message, /accessed/);
  }
});

test('a source needs a title and an http(s) url', () => {
  const bad = [{ ...SOURCES[0], title: '' }, { ...SOURCES[1], url: 'not a url' }, SOURCES[2]];
  const f = validateDoctrine(doctrine({ front: { sources: bad } }), 'team/chief-reviewer.md');
  assert.deepEqual(rules(f), ['doctrine-source', 'doctrine-source']);
});

test('a missing front matter key is an error per key', () => {
  const f = validateDoctrine(doctrine({ front: { inspired_by: undefined, effort: undefined } }), 'team/chief-reviewer.md');
  assert.deepEqual(rules(f), ['doctrine-front', 'doctrine-front']);
  assert.match(f[0].message + f[1].message, /inspired_by/);
  assert.match(f[0].message + f[1].message, /effort/);
});

test('a role that does not match the file name is an error', () => {
  const f = validateDoctrine(doctrine(), 'team/architect.md');
  assert.deepEqual(rules(f), ['doctrine-role']);
});

test('no front matter and invalid YAML are reported, not thrown', () => {
  assert.deepEqual(rules(validateDoctrine('## Why this profile for this project\n', 'team/a.md')).slice(0, 1), ['doctrine-front']);
  const f = validateDoctrine('---\nrole: [\n---\n', 'team/a.md');
  assert.equal(rules(f)[0], 'doctrine-front');
});

test('empty or comment-only front matter reports every required key and the sources', () => {
  const sections = DOCTRINE_SECTIONS.map((h) => `## ${h}\n\nA line.\n`).join('\n');
  for (const front of ['---\n---\n', '---\n# nothing here\n---\n']) {
    const f = validateDoctrine(`${front}\n${sections}`, 'team/a.md');
    assert.deepEqual(rules(f), ['doctrine-front', 'doctrine-front', 'doctrine-front', 'doctrine-front', 'doctrine-sources']);
  }
});

test('identity claims in English and French are errors, quoted lines are skipped', () => {
  for (const claim of ["I'm the reviewer.", 'I\u2019m the reviewer.', 'Je suis le reviewer.']) {
    const f = validateDoctrine(doctrine({ body: { 'What they refuse': claim } }), 'team/chief-reviewer.md');
    assert.deepEqual(rules(f), ['doctrine-identity'], claim);
  }
  const quoted = doctrine({ body: { 'What they refuse': '> I am a quote from a talk.' } });
  assert.deepEqual(validateDoctrine(quoted, 'team/chief-reviewer.md'), []);
});

test('a placeholder left from the template is an error', () => {
  const f = validateDoctrine(doctrine({ body: { 'What they refuse': 'Refuses {{thing}}.' } }), 'team/chief-reviewer.md');
  assert.deepEqual(rules(f), ['doctrine-placeholder']);
});

test('sections inside a fenced block do not count', () => {
  const text = doctrine({ drop: ['Limits (what not to ask them)'] }) + '\n```\n## Limits (what not to ask them)\n```\n';
  assert.deepEqual(rules(validateDoctrine(text, 'team/chief-reviewer.md')), ['doctrine-section']);
});

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'recade-team-'));
  mkdirSync(join(root, 'team'), { recursive: true });
  mkdirSync(join(root, 'recade'), { recursive: true });
  writeFileSync(join(root, 'recade', 'state.yaml'), 'version: 1\nmode: scratch\nphase: 1\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'team', name), text);
  return root;
}

test('checkTeam skips roster.md and reads every other team file', () => {
  const root = project({
    'roster.md': 'not a doctrine, no front matter',
    'chief-reviewer.md': doctrine(),
    'architect.md': doctrine({ front: { role: 'architect' }, drop: ['What they refuse'] }),
    'notes.txt': 'ignored',
  });
  const f = checkTeam(root);
  assert.deepEqual(rules(f), ['doctrine-section']);
  assert.equal(f[0].file, 'team/architect.md');
});

test('checkTeam fails when there is no doctrine to check', () => {
  assert.deepEqual(rules(checkTeam(project({ 'roster.md': 'x' }))), ['team-empty']);
  assert.deepEqual(rules(checkTeam(mkdtempSync(join(tmpdir(), 'recade-team-')))), ['team-empty']);
});

async function cli(args, cwd) {
  const out = [];
  const err = [];
  const code = await run(args, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {} });
  return { code, out: out.join(''), err: err.join('') };
}

test('recade team check exits 0 on a clean team and prints a summary', async () => {
  const root = project({ 'roster.md': 'x', 'chief-reviewer.md': doctrine() });
  const r = await cli(['team', 'check'], root);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /1 doctrine/);
});

test('recade team check exits 1 on errors and works with --project', async () => {
  const root = project({ 'chief-reviewer.md': doctrine({ front: { sources: SOURCES.slice(0, 1) } }) });
  const r = await cli(['team', 'check', '--project', root], tmpdir());
  assert.equal(r.code, 1);
  assert.match(r.out, /^team\/chief-reviewer\.md:\d+:\d+ error doctrine-sources /m);
});

test('recade team check exits 1 outside a project and 2 on bad usage', async () => {
  const none = await cli(['team', 'check'], mkdtempSync(join(tmpdir(), 'recade-none-')));
  assert.equal(none.code, 1);
  assert.match(none.err, /No Recade project here/);
  const bad = await cli(['team'], tmpdir());
  assert.equal(bad.code, 2);
  assert.match(bad.err, /^Usage: recade team check/);
  assert.equal((await cli(['team', 'check', 'x'], tmpdir())).code, 2);
});
