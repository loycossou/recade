import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../../src/project/scaffold.js';
import { openProvisional, closeProvisional, listProvisionals } from '../../src/project/provisionals.js';
import { run } from '../../src/cli.js';

const CONFIG = {
  voice: 'randall-munroe',
  languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] },
};
const noGit = async () => ({ code: 0, stdout: '', stderr: '' });

async function project() {
  const r = await createProject('Fernhill Lending', {
    root: mkdtempSync(join(tmpdir(), 'recade-prv-')), mode: 'scratch', config: CONFIG, exec: noGit, today: '2026-11-13',
  });
  return r.dir;
}
const NAME = { what: 'Working name', why: 'The client has not chosen one', assumption: 'Fernhill Lending', owner: 'Client' };
const file = (root) => readFileSync(join(root, 'intake', 'provisionals.md'), 'utf8');

test('PRV ids increment, starting at PRV-01', async () => {
  const root = await project();
  assert.equal(openProvisional(root, { ...NAME, due: '2026-12-01' }), 'PRV-01');
  assert.equal(openProvisional(root, { ...NAME, what: 'Palette' }), 'PRV-02');
  assert.equal(openProvisional(root, { ...NAME, what: 'Personas' }), 'PRV-03');
  const list = listProvisionals(root);
  assert.deepEqual(list.map((p) => p.id), ['PRV-01', 'PRV-02', 'PRV-03']);
  assert.deepEqual(list[0], {
    id: 'PRV-01', status: 'open', what: 'Working name', why: 'The client has not chosen one',
    assumption: 'Fernhill Lending', owner: 'Client', due: '2026-12-01',
  });
  assert.equal(list[1].due, '');
});

test('closing keeps history: the row moves to Closed and its id is never reused', async () => {
  const root = await project();
  openProvisional(root, NAME);
  openProvisional(root, { ...NAME, what: 'Palette' });
  closeProvisional(root, 'PRV-01', { value: 'Fernhill Capital', replacedIn: 'D1, design tokens', date: '2026-11-20' });
  const all = listProvisionals(root);
  assert.deepEqual(all.map((p) => [p.id, p.status]), [['PRV-01', 'closed'], ['PRV-02', 'open']]);
  assert.deepEqual(all[0], {
    id: 'PRV-01', status: 'closed', what: 'Working name', value: 'Fernhill Capital',
    closedOn: '2026-11-20', replacedIn: 'D1, design tokens',
  });
  assert.equal(openProvisional(root, { ...NAME, what: 'Logo' }), 'PRV-03');
  const text = file(root);
  assert.match(text, /^\| PRV-01 \| Working name \| Fernhill Capital \| 2026-11-20 \| D1, design tokens \|$/m);
  assert.equal((text.match(/PRV-01/g) ?? []).length, 1);
});

test('list with open: true returns only the open records', async () => {
  const root = await project();
  openProvisional(root, NAME);
  openProvisional(root, { ...NAME, what: 'Palette' });
  closeProvisional(root, 'PRV-02', { value: 'Brand guide' });
  assert.deepEqual(listProvisionals(root, { open: true }).map((p) => p.id), ['PRV-01']);
  assert.equal(listProvisionals(root, { open: true })[0].status, 'open');
});

test('close refuses an unknown or already closed id, and an empty value', async () => {
  const root = await project();
  openProvisional(root, NAME);
  assert.throws(() => closeProvisional(root, 'PRV-09', { value: 'x' }), /No open provisional PRV-09/);
  assert.throws(() => closeProvisional(root, 'PRV-01', { value: ' ' }), /real value/);
  assert.throws(() => closeProvisional(root, 'oops', { value: 'x' }), /Invalid provisional id/);
  closeProvisional(root, 'PRV-01', { value: 'x' });
  assert.throws(() => closeProvisional(root, 'PRV-01', { value: 'y' }), /No open provisional PRV-01/);
});

test('open validates its fields and escapes pipes and line breaks', async () => {
  const root = await project();
  assert.throws(() => openProvisional(root, { ...NAME, what: '' }), /what is required/);
  assert.throws(() => openProvisional(root, { ...NAME, owner: undefined }), /owner is required/);
  assert.throws(() => openProvisional(root, { ...NAME, due: 'soon' }), /due must be YYYY-MM-DD/);
  openProvisional(root, { ...NAME, assumption: 'a | b\nc' });
  assert.equal(listProvisionals(root)[0].assumption, 'a | b c');
});

test('a missing register is created from the template, other text is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-prv-bare-'));
  mkdirSync(join(dir, 'intake'));
  assert.deepEqual(listProvisionals(dir), []);
  assert.equal(openProvisional(dir, NAME), 'PRV-01');
  const text = file(dir);
  assert.match(text, /^doc_id: PROVISIONALS$/m);
  writeFileSync(join(dir, 'intake', 'provisionals.md'), text.replace('## Closed', 'Note kept.\n\n## Closed'));
  openProvisional(dir, { ...NAME, what: 'Logo' });
  assert.match(file(dir), /Note kept\./);
});

function makeIO(cwd) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {},
      now: () => new Date(2026, 10, 20) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('recade provisional open, list and close', async () => {
  const root = await project();
  const t = makeIO(root);
  assert.equal(await run([
    'provisional', 'open', '--what', 'Working name', '--why', 'Not chosen', '--assumption', 'Fernhill',
    '--owner', 'Client', '--due', '2026-12-01',
  ], t.io), 0);
  assert.equal(t.stdout(), 'PRV-01\n');
  const l = makeIO(root);
  assert.equal(await run(['provisional', 'list', '--open', '--json'], l.io), 0);
  assert.equal(JSON.parse(l.stdout())[0].id, 'PRV-01');
  const p = makeIO(root);
  assert.equal(await run(['provisional', 'list'], p.io), 0);
  assert.match(p.stdout(), /^PRV-01\topen\tWorking name\t/m);
  const c = makeIO(root);
  assert.equal(await run(['provisional', 'close', 'PRV-01', '--value', 'Fernhill Capital'], c.io), 0);
  assert.equal(c.stdout(), 'PRV-01 closed on 2026-11-20.\n');
  assert.equal(listProvisionals(root)[0].closedOn, '2026-11-20');
  const again = makeIO(root);
  assert.equal(await run(['provisional', 'close', 'PRV-01', '--value', 'x'], again.io), 1);
  assert.match(again.stderr(), /No open provisional PRV-01/);
});

test('recade provisional: usage errors exit 2, no project exits 1', async () => {
  const root = await project();
  for (const args of [
    ['provisional'], ['provisional', 'nope'], ['provisional', 'open', '--what', 'x'],
    ['provisional', 'close', 'PRV-01'], ['provisional', 'list', '--bogus'], ['provisional', 'open', '--what'],
  ]) {
    const t = makeIO(root);
    assert.equal(await run(args, t.io), 2, args.join(' '));
    assert.match(t.stderr(), /^Usage: recade provisional/);
  }
  const t = makeIO(mkdtempSync(join(tmpdir(), 'recade-none-')));
  assert.equal(await run(['provisional', 'list'], t.io), 1);
  assert.match(t.stderr(), /No Recade project here/);
});

test('--project <dir> points state and provisional at a project from any folder', async () => {
  const root = await project();
  const elsewhere = mkdtempSync(join(tmpdir(), 'recade-elsewhere-'));
  const t = makeIO(elsewhere);
  assert.equal(await run(['provisional', 'open', '--project', root, '--what', 'Logo', '--why', 'None given',
    '--assumption', 'Wordmark', '--owner', 'Client'], t.io), 0);
  assert.equal(t.stdout(), 'PRV-01\n');
  const s = makeIO(elsewhere);
  assert.equal(await run(['state', 'show', '--json', '--project', root], s.io), 0);
  assert.equal(JSON.parse(s.stdout()).phase, 0);
  const bad = makeIO(elsewhere);
  assert.equal(await run(['state', 'show', '--project'], bad.io), 2);
  assert.match(bad.stderr(), /Missing value for --project/);
});

test('two concurrent opens from separate processes get distinct ids and leave no lock or temp file', async () => {
  const root = await project();
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'recade.js');
  const open = (n) => new Promise((resolve) => {
    execFile(process.execPath, [cli, 'provisional', 'open', '--project', root, '--what', `Item ${n}`, '--why', 'w',
      '--assumption', 'a', '--owner', 'o'], (err, stdout, stderr) => resolve({ err, stdout: stdout.trim(), stderr }));
  });
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(open));
  assert.ok(results.every((r) => r.err === null), results.map((r) => r.stderr).join(''));
  assert.deepEqual(results.map((r) => r.stdout).sort(), ['PRV-01', 'PRV-02', 'PRV-03', 'PRV-04', 'PRV-05', 'PRV-06']);
  assert.equal(listProvisionals(root).length, 6);
  assert.deepEqual(readdirSync(join(root, 'intake')).filter((f) => f.includes('lock') || f.includes('tmp')), []);
});

test('a held lock fails with a clear message, a stale lock is dropped', async () => {
  const root = await project();
  const lock = join(root, 'intake', '.provisionals.lock');
  writeFileSync(lock, '');
  assert.throws(
    () => openProvisional(root, NAME, { lockTries: 2, lockWaitMs: 1 }),
    /locked by another command.*\.provisionals\.lock/,
  );
  assert.equal(listProvisionals(root).length, 0);
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  assert.equal(openProvisional(root, NAME, { lockTries: 2, lockWaitMs: 1 }), 'PRV-01');
  assert.ok(!existsSync(lock));
});
