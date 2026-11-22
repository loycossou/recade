import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTheme, loadLabels, normalizeLanguage, FONT_DIR } from '../../src/render/theme.js';

function projectWith(themeText) {
  const root = mkdtempSync(join(tmpdir(), 'recade-theme-'));
  mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design', 'theme.json'), themeText);
  return root;
}

test('theme loads defaults', () => {
  const t = loadTheme(null);
  assert.equal(t.font.family, 'Inter Tight');
  assert.equal(t.font.fallback, 'Arial');
  assert.equal(t.size.body, 10);
  assert.equal(t.size.table, 8.5);
  assert.equal(t.color.ink, '0F1A22');
  assert.equal(t.color.accent, '1F3864');
  assert.deepEqual(t.page, { size: 'A4', marginCm: 2 });
});

test('theme defaults are returned when the project has no design/theme.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-theme-'));
  try {
    assert.deepEqual(loadTheme(root), loadTheme(null));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('project theme.json overrides one colour and keeps the rest', () => {
  const root = projectWith('{"color":{"accent":"FF0000"}}');
  try {
    const t = loadTheme(root);
    const d = loadTheme(null);
    assert.equal(t.color.accent, 'FF0000');
    assert.equal(t.color.ink, d.color.ink);
    assert.deepEqual(t.size, d.size);
    assert.deepEqual(t.font, d.font);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('loading a project theme does not mutate the defaults', () => {
  const root = projectWith('{"color":{"accent":"FF0000"}}');
  try {
    loadTheme(root);
    assert.equal(loadTheme(null).color.accent, '1F3864');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('invalid theme.json throws a one-line error', () => {
  const root = projectWith('{ not json');
  try {
    assert.throws(() => loadTheme(root), (err) => {
      assert.match(err.message, /^design\/theme\.json is not valid JSON: .+/);
      assert.ok(!err.message.includes('\n'));
      return true;
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('fr labels have every en key', () => {
  const en = loadLabels('en');
  const fr = loadLabels('fr');
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  assert.equal(en.contents, 'Contents');
  assert.equal(fr.contents, 'Sommaire');
  assert.equal(fr.revisionHistory, 'Historique des révisions');
  for (const [k, v] of Object.entries({ ...en, ...fr })) {
    if (k === 'planTerms' || k === 'registers' || k === 'dossier') continue; // maps, checked below
    assert.equal(typeof v, 'string', k);
    assert.ok(v.length > 0, k);
  }
  assert.deepEqual(Object.keys(fr.dossier).sort(), Object.keys(en.dossier).sort());
  for (const v of [...Object.values(en.dossier), ...Object.values(fr.dossier)]) assert.ok(typeof v === 'string' && v.length > 0);
  assert.deepEqual(en.planTerms, {});
  assert.deepEqual(Object.keys(fr.registers).sort(), Object.keys(en.registers).sort());
  assert.equal(fr.registers.decisions, 'registre des décisions');
  assert.equal(fr.planTerms.Milestones, 'Jalons');
});

test('unknown language falls back to en', () => {
  assert.deepEqual(loadLabels('xx'), loadLabels('en'));
  assert.deepEqual(loadLabels(undefined), loadLabels('en'));
  assert.deepEqual(loadLabels('../en'), loadLabels('en'));
});

test('FONT_DIR is the absolute render/fonts folder', () => {
  assert.ok(FONT_DIR.endsWith('render/fonts'));
});

test('normalizeLanguage keeps the lower-case primary subtag and falls back to en', () => {
  assert.equal(normalizeLanguage('fr'), 'fr');
  assert.equal(normalizeLanguage('FR'), 'fr');
  assert.equal(normalizeLanguage('fr-CA'), 'fr');
  assert.equal(normalizeLanguage(' fr_ca '), 'fr');
  for (const bad of [undefined, null, '', 'english', '../en', 'f', 12, '-fr']) assert.equal(normalizeLanguage(bad), 'en', String(bad));
});

test('loadLabels takes FR and fr-CA as French', () => {
  assert.deepEqual(loadLabels('FR'), loadLabels('fr'));
  assert.deepEqual(loadLabels('fr-CA'), loadLabels('fr'));
  assert.notDeepEqual(loadLabels('fr-CA'), loadLabels('en'));
});
