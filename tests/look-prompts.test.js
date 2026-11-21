import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from '../src/render/parse.js';
import { fillTemplate } from '../src/project/scaffold.js';
import { MIN_FIGURES } from '../src/render/figurecheck.js';
import { figureFindings } from '../src/render/figurecheck.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const VALUES = { project: 'Fernhill', title: 'Fernhill', version: '0.1', date: '2026-11-13', author: 'Lead', approver: 'Owner', language: 'en' };

test('every template that asks for figures carries at least that many captioned ones, in the palette classes', () => {
  for (const [id, { count }] of Object.entries(MIN_FIGURES)) {
    const doc = parseDocument(fillTemplate(read('templates', `${id}.md`), VALUES), `docs/${id}.md`);
    const figures = doc.blocks.filter((b) => b.type === 'figure');
    assert.ok(figures.length >= count, `${id} has ${figures.length} figures, wants ${count}`);
    assert.equal(figureFindings(doc).length, 0, `${id}: ${JSON.stringify(figureFindings(doc))}`);
    assert.ok(figures.every((f) => f.source.kind === 'mermaid'));
  }
  assert.match(read('templates', 'D1.md'), /Required figures, at least three: actors and system context \(4\.1\)/);
  assert.match(read('templates', 'D2.md'), /the containers \(2\.2\), the deployment \(3\.1\) and one key sequence \(2\.6\)/);
  assert.match(read('templates', 'D3.md'), /the trust boundaries and the data flows \(2\.4\)/);
  assert.match(read('templates', 'PLAN.md'), /the phases timeline/);
});

test('the agents that write D1, D2 and D3 translate the template headings; none keeps them in English', () => {
  for (const name of ['project-lead', 'ux-designer', 'domain-expert', 'architect', 'devops-lead', 'security-lead']) {
    const text = read('agents', `${name}.md`);
    assert.match(text, /Translate the headings of D1, D2 and D3 into that language/, name);
    assert.doesNotMatch(text, /Keep the headings of the template exactly as they are, in English/, name);
    assert.match(text, /no example row and no example figure/, name);
    assert.match(text, /Open each main section with one plain sentence/, name);
    assert.match(text, /Every other file keeps the English headings of its template/, name);
  }
  for (const name of ['bible-writer', 'stack-analyst', 'doctrine-writer']) assert.match(read('agents', `${name}.md`), /Keep the (?:7 section )?headings of the templates? exactly as they are, in English/, name);
  assert.match(read('agents', 'code-reader.md'), /Keep the headings of every template in English[^.]*D1, D2 and D3 included/);
  assert.match(read('agents', 'slicer.md'), /Keep the headings of a slice sheet in English/);
  assert.match(read('agents', 'project-lead.md'), /PLAN is the one exception: its sheet titles and column titles/);
});

test('the art direction writes only the brand in design/theme.json, not the structure of the documents', () => {
  const skill = read('skills', 'design-direction', 'SKILL.md');
  assert.match(skill, /By default write only the brand/);
  for (const key of ['headerFill', 'zebra', 'keyCell', 'provisionalText', 'figure']) assert.ok(skill.includes(key), key);
  const agent = read('agents', 'ui-designer.md');
  assert.match(agent, /write only the brand: the fonts and the brand colours/);
  assert.match(agent, /Never write the table header, `zebra`, `keyCell`/);
});

test('the writing voice asks for an opening sentence, the gist before the ID, and translated headings of D1, D2 and D3 only', () => {
  const voice = read('skills', 'writing-voice', 'SKILL.md');
  assert.match(voice, /Open each main section of a document with one short sentence/);
  assert.match(voice, /say the gist first and put the ID after it/);
  assert.match(voice, /Translate the headings of D1, D2 and D3/);
  assert.match(voice, /Keep the English headings of the documents that code reads \(the PLAN, the STACK tech sheet, the BIBLE, slice sheets\)/);
  assert.match(voice, /upload a proof of income \(FR-EX-01\)/);
  assert.doesNotMatch(voice, /FR-EX-01 \(upload a proof of income\)/);
});

test('the templates tell the authors to prefer a top-down layout beyond about 8 nodes in a row', () => {
  for (const name of ['D1', 'D2', 'D3']) assert.match(read('templates', `${name}.md`), /beyond about 8 nodes in a row, use a top-down layout \(`flowchart TD`\)/, name);
});
