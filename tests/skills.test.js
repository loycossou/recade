import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintText } from '../src/style/lint.js';

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const names = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

function front(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'front matter');
  return Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
}

test('the skills that exist so far', () => {
  for (const n of ['writing-voice', 'design-direction', 'stack-selection', 'slicing']) assert.ok(names.includes(n), n);
});

test('every skill has a SKILL.md with a name that matches its folder and a description, and passes lint-style', () => {
  for (const name of names) {
    const file = join(skillsDir, name, 'SKILL.md');
    assert.ok(existsSync(file), `${name}: SKILL.md`);
    const text = readFileSync(file, 'utf8');
    const f = front(text);
    assert.equal(f.name, name, `${name}: name`);
    assert.ok(f.description && f.description.length > 20, `${name}: description`);
    const errors = lintText(text, file).filter((x) => x.severity === 'error');
    assert.deepEqual(errors, [], `${name}: lint-style`);
  }
});
