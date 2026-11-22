import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverableName, documentTitle, oldNames, slugTitle, sourceDeliverableName } from '../../src/render/names.js';

test('slugTitle drops accents, joins words with hyphens and capitalises each word', () => {
  assert.equal(slugTitle('Functional Specifications'), 'Functional-Specifications');
  assert.equal(slugTitle('Spécifications fonctionnelles'), 'Specifications-Fonctionnelles');
  assert.equal(slugTitle('Exigences de sécurité'), 'Exigences-De-Securite');
  assert.equal(slugTitle('plan de livraison'), 'Plan-De-Livraison');
  assert.equal(slugTitle('Größe & Maße: Übersicht'), 'Grosse-Masse-Ubersicht');
  assert.equal(slugTitle("Signal d'alerte / l'API"), 'Signal-D-Alerte-L-API');
  assert.equal(slugTitle('Œuvre, æther, Łódź, Ørsted'), 'Oeuvre-Aether-Lodz-Orsted');
  assert.equal(slugTitle('  spaces   and\ttabs  '), 'Spaces-And-Tabs');
  assert.equal(slugTitle('機能仕様書'), '');
  assert.equal(slugTitle(undefined), '');
});

test('slugTitle keeps at most 60 characters, cut between words', () => {
  const long = slugTitle('one two three four five six seven eight nine ten eleven twelve thirteen');
  assert.ok(long.length <= 60, long);
  assert.ok(long.startsWith('One-Two-Three') && !long.endsWith('-'));
  assert.equal(slugTitle('x'.repeat(80)).length, 60);
});

test('documentTitle drops the project name the templates put first', () => {
  assert.equal(documentTitle({ title: 'Fernhill Lending, Functional Specifications', project: 'Fernhill Lending' }), 'Functional Specifications');
  assert.equal(documentTitle({ title: 'Fernhill Lending: delivery plan', project: 'fernhill lending' }), 'delivery plan');
  assert.equal(documentTitle({ title: 'Other name, stack decision', project: 'Fernhill' }), 'stack decision');
  assert.equal(documentTitle({ title: 'Stack decision', project: 'Fernhill' }), 'Stack decision');
  assert.equal(documentTitle({ title: 'Fernhillside, plan', project: 'Fernhill' }), 'plan');
  assert.equal(documentTitle({}), '');
});

test('deliverableName puts the ID first, and the ID alone when the title gives nothing', () => {
  assert.equal(deliverableName('D1', { title: 'Acme, Functional Specifications', project: 'Acme' }), 'D1_Functional-Specifications');
  assert.equal(deliverableName('D1', { title: 'Acme, Spécifications fonctionnelles', project: 'Acme' }), 'D1_Specifications-Fonctionnelles');
  assert.equal(deliverableName('D1', { title: 'Acme, 機能仕様書', project: 'Acme' }), 'D1');
  assert.equal(deliverableName('D1', {}), 'D1');
});

test('sourceDeliverableName: a language copy takes its own title, or keeps its language when the names meet', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-names-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fm = (title) => `---\ntitle: "${title}"\nproject: Acme\n---\n`;
  writeFileSync(join(dir, 'D1.md'), fm('Acme, Functional Specifications'));
  writeFileSync(join(dir, 'PLAN.md'), fm('Acme, Plan'));
  assert.equal(sourceDeliverableName(join(dir, 'D1.md'), { title: 'Acme, Functional Specifications', project: 'Acme' }), 'D1_Functional-Specifications');
  assert.equal(sourceDeliverableName(join(dir, 'D1.fr.md'), { title: 'Acme, Spécifications fonctionnelles', project: 'Acme' }), 'D1_Specifications-Fonctionnelles');
  assert.equal(sourceDeliverableName(join(dir, 'PLAN.fr.md'), { title: 'Acme, plan', project: 'Acme' }), 'PLAN_Plan.fr');
  assert.equal(sourceDeliverableName(join(dir, 'D3.pt-BR.md'), { title: 'Acme, Requisitos de segurança', project: 'Acme' }), 'D3_Requisitos-De-Seguranca');
  assert.deepEqual(oldNames(join(dir, 'D1.fr.md')), ['D1.fr.docx', 'D1.fr.pdf']);
});
