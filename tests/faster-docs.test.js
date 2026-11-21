import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGETS } from '../src/budgets.js';

// The documents phase is short: budgets, one reviewer and one round, fewer questions for the owner, a progress line.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const between = (text, from, to) => text.slice(text.indexOf(from), to === undefined ? undefined : text.indexOf(to));

const WRITERS = ['project-lead', 'architect', 'security-lead', 'devops-lead', 'domain-expert', 'ux-designer', 'bible-writer', 'stack-analyst'];
const REVIEWERS = ['project-lead', 'architect', 'security-lead', 'devops-lead', 'domain-expert', 'ux-designer', 'chief-reviewer'];
const NAMES = { D1: 'D1', D2: 'D2', D3: 'D3', PLAN: 'PLAN', STACK: 'STACK', BIBLE: 'BIBLE' };

test('every main step of docs.md and bible.md opens with a progress line that says where we are and what comes next', () => {
  for (const [file, first] of [['commands/docs.md', 3], ['commands/bible.md', 3]]) {
    const text = read(file);
    for (let n = first; n <= 9; n++) {
      const start = text.indexOf(`## Step ${n}. `);
      assert.ok(start > 0, `${file} step ${n}`);
      const end = text.indexOf('\n## ', start + 5);
      const step = text.slice(start, end === -1 ? undefined : end);
      assert.ok(step.includes('Start with the progress line'), `${file} step ${n} progress line`);
      assert.match(step, new RegExp(`\`Step ${n} of 9: [^\`]+\\. Next: [^\`]+\``), `${file} step ${n} says where we are and what is next`);
    }
    assert.ok(text.includes('**Progress line.**'), file);
  }
});

test('docs.md gives each document one reviewer', () => {
  const text = read('commands/docs.md');
  const step = (n) => text.slice(text.indexOf(`## Step ${n}. `), text.indexOf(`## Step ${n + 1}. `));
  assert.match(step(3), /author `project-lead`, one reviewer: the `domain-expert` when the roster has one, otherwise the `architect`/);
  assert.match(step(4), /author `ui-designer`, one reviewer `ux-designer`, document `design-direction`/);
  assert.match(step(6), /author `architect`, one reviewer `security-lead`/);
  assert.match(step(7), /author `security-lead`, one reviewer `architect`/);
  assert.match(step(8), /author `project-lead`, one reviewer `architect`/);
  for (const n of [3, 6, 7, 8]) assert.equal(/reviewers `/.test(step(n)), false, `step ${n} has no panel`);
  const stack = step(5);
  assert.ok(stack.includes('They are two, not a panel: the `architect`, and at most one other role'));
  assert.equal(stack.includes('Dispatch in one message, so they run in parallel, the `architect`, `devops-lead`, `security-lead` and `ui-designer`'), false);
});

test('bible.md gives the BIBLE one reviewer, the chief reviewer, and asks for no security-lead note', () => {
  const text = read('commands/bible.md');
  assert.ok(text.includes('one reviewer `chief-reviewer`'));
  assert.equal(text.includes('security-lead'), false);
  assert.equal(text.includes('BIBLE-security-lead'), false);
  assert.ok(read('agents/chief-reviewer.md').includes('You are the only reviewer of the BIBLE: its security points are yours.'));
});

test('the review procedure: one review, blockers and should-fix in one round, nits listed, a second round only for a blocker', () => {
  for (const file of ['commands/docs.md', 'commands/bible.md']) {
    const text = read(file);
    const review = between(text, '### Review procedure', '### Decision procedure');
    assert.ok(review.includes('one reviewer and one review'), file);
    assert.ok(review.includes('Every `blocker` and every `should fix` is applied in this single round; a `nit` is listed in the author\'s report and never applied.'), file);
    assert.ok(review.includes('The note is not reviewed again.'), file);
    assert.ok(review.includes('At most 1 more round of `Revise once more`'), file);
    assert.equal(review.includes('Revise again'), false, file);
    assert.ok(review.includes('`Keep it and note it`') && review.includes('`Stop here`'), file);
  }
});

test('the decision procedure asks in batches of up to 4 questions and names the team decisions procedure', () => {
  for (const file of ['commands/docs.md', 'commands/bible.md']) {
    const text = read(file);
    const dec = between(text, '### Decision procedure', '## Step 3.');
    assert.ok(dec.includes('in batches: up to 4 questions in one call'), file);
    assert.ok(dec.includes('the letter, never the position') && dec.includes('show the mapping'), file);
    assert.ok(dec.includes('### Team decisions'), file);
    assert.ok(dec.includes('recade decision team list --json --project'), file);
    assert.ok(dec.includes('recade decision team challenge'), file);
    assert.ok(text.includes('**Owner or team.**') && text.includes('`owner`: costly, binding for the client, irreversible, legal') && text.includes('`team`: reversible, a technical detail or a convention'), file);
    assert.ok(text.includes('10 owner DECs') || text.includes('the aim of 10'), file);
    assert.ok(text.includes('recade decision team add --doc'), file);
    assert.ok(text.includes('cited once, where it applies'), file);
  }
});

test('the owner sees the team decisions as one list at G2 and at G3, and can challenge them in one go', () => {
  const docs = between(read('commands/docs.md'), '## Step 9.');
  assert.ok(docs.includes('"Decided by the team, without asking you"') && docs.includes('"These were decided by the team. Challenge any?"'));
  assert.ok(docs.indexOf('Challenge any?') < docs.indexOf('Pass G2?'));
  const bible = between(read('commands/bible.md'), '## Step 9.');
  assert.ok(bible.includes('"Decided by the team, without asking you"') && bible.includes('"These were decided by the team. Challenge any?"'));
  assert.ok(bible.indexOf('Challenge any?') < bible.indexOf('Pass G3?'));
  assert.ok(read('commands/docs.md').includes('Add the layers the team decided itself'));
});

test('the dispatcher gives the budget, the owner-DEC count and the words left, and checks the size after each document', () => {
  const docs = read('commands/docs.md');
  assert.ok(docs.includes('`recade docs budgets --project') && docs.includes('Budget: <doc>, <n> words, code blocks excluded'));
  assert.ok(docs.includes('the words left'));
  for (const doc of ['D1', 'D2 D3', 'PLAN']) assert.ok(docs.includes(`recade docs size ${doc} --project`), doc);
  assert.ok(docs.includes('recade docs size STACK --project') && docs.includes('recade docs size D1 D2 D3 PLAN --project'));
  assert.ok(docs.indexOf('recade docs size STACK') < docs.indexOf('Pass G2-stack?'));
  assert.ok(docs.includes('"cut, do not summarise the cut"'));
  assert.ok(read('commands/bible.md').includes('recade docs size BIBLE PLAN --project'));
  assert.ok(read('commands/bible.md').includes('Budget: <BIBLE or PLAN>, <n> words'));
});

test('every writing agent sorts questions, may record a team decision and checks its size', () => {
  for (const name of WRITERS) {
    const text = read(`agents/${name}.md`);
    assert.ok(text.includes('- Sort every question before you act on it'), name);
    assert.ok(text.includes('recade decision team add --doc '), name);
    assert.ok(text.includes('- Every `owner` question is a DEC.'), name);
    assert.ok(text.includes('other than `decision new`, `decision team add`, `docs size`'), name);
    assert.ok(text.includes('- Size and audience.') && text.includes('recade docs size'), name);
    assert.equal(text.includes('Every choice the owner must make is a DEC'), false, name);
    assert.ok(/^2\. The DEC ids you opened:.*the ref \(TD-nn\)/m.test(text), name);
  }
});

test('every reviewing agent knows the severities, caps its findings and revises in one round', () => {
  for (const name of REVIEWERS) {
    const text = read(`agents/${name}.md`);
    assert.ok(text.includes('At most 10 findings, the blockers first. `blocker`: the document cannot be approved or built as written. `should fix`: a real defect. `nit`: taste, which is listed and never applied.'), name);
    if (name !== 'chief-reviewer') assert.ok(text.includes('Apply every `blocker` and every `should fix` in one pass') || !/^- `revise`:/m.test(text), name);
  }
  for (const name of ['project-lead', 'architect', 'security-lead', 'bible-writer']) assert.ok(read(`agents/${name}.md`).includes('List each `nit` in the Report and do not apply it.'), name);
});

test('the stack analyst sorts layers, records a team layer, and lists only the reviewers that were asked', () => {
  const text = read('agents/stack-analyst.md');
  assert.ok(text.includes('Language, framework, database, data access and hosting are always `owner`'));
  assert.ok(text.includes('`Class: team`') && text.includes('`Class: owner`'));
  assert.ok(text.includes('A role that was not asked has no row.'));
  assert.ok(text.includes('"decided by the team"'));
  const skill = read('skills/stack-selection/SKILL.md');
  assert.ok(skill.includes('There are two contributors, not a panel') && skill.includes('- **Owner or team.**'));
});

test('the writing voice, the templates and the documents state the budgets of the code', () => {
  const voice = read('skills/writing-voice/SKILL.md');
  const text = Object.entries(DEFAULT_BUDGETS).map(([doc, words]) => `${doc} ${words.toLocaleString('en-US')}`).join(', ');
  assert.ok(voice.includes(text), 'writing-voice lists the budgets');
  assert.ok(voice.includes('## Size and audience') && voice.includes('recade docs size'));
  assert.ok(voice.includes('Over the budget is a warning, over 150% of it an error.'));
  for (const doc of Object.keys(NAMES)) assert.ok(read(`templates/${doc}.md`).includes(`the word budget of ${doc} (code blocks excluded)`), doc);
  for (const file of ['README.md', 'docs/design.md', 'CHANGELOG.md']) {
    const doc = read(file);
    assert.ok(doc.includes(text) || doc.includes(text.replaceAll(', ', ', ').replace(/, BIBLE/, ' and BIBLE')), file);
    assert.ok(doc.includes('recade docs size'), file);
    assert.ok(doc.includes('decisions/TEAM.md'), file);
  }
});

test('review fixes: challenged team decisions redo the translations, STACK DECs are never batched, the right author fixes a size error', () => {
  const docs = read('commands/docs.md');
  const g2 = between(docs, '## Step 9.');
  const challenge = g2.slice(g2.indexOf('7. Show the team decisions'), g2.indexOf('8. Ask with'));
  assert.ok(challenge.indexOf('do point 2 again for every source that was revised') > 0 && challenge.indexOf('do point 2 again') < challenge.indexOf('go back to point 3'));
  const bible = between(read('commands/bible.md'), '4. Show the team decisions');
  assert.ok(bible.indexOf('do Step 7 again') > 0 && bible.indexOf('do Step 7 again') < bible.indexOf('go back to Step 8'));
  assert.ok(docs.includes('The DECs of `STACK` are the exception: they are always asked one at a time') && docs.includes('Never batch them.'));
  assert.ok(docs.includes('a size error of D2 goes to `architect`, one of D3 to `security-lead`'));
  assert.ok(docs.includes('Run the three again until none prints an `error`.') && docs.includes('Run both again until neither') === false);
  for (const file of ['commands/docs.md', 'commands/bible.md']) assert.ok(read(file).includes('except to rewrite its own note when the style check refuses it'), file);
  assert.ok(docs.includes("recorded under `--doc 'D1'`"));
  assert.equal(read('commands/slices.md').includes('Step 9 point 11'), false);
  assert.ok(read('commands/slices.md').includes('the point "Code repositories" of Step 9'));
});

test('review fixes: the chief reviewer owns the BIBLE security points, and the other agents drop their stale review lines', () => {
  const chief = read('agents/chief-reviewer.md');
  assert.ok(chief.includes('a precedence that puts a document above D3') && chief.includes('a definition of done that lets a security check be skipped'));
  const sec = read('agents/security-lead.md');
  assert.equal(/BIBLE-security-lead|reviews D1, D2 and the BIBLE|For the BIBLE, look for/.test(sec), false);
  assert.equal(/reviews D2\./.test(read('agents/project-lead.md').split('\n')[2]), false);
  assert.equal(/reviews D3 and the PLAN/.test(read('agents/devops-lead.md')), false);
});
