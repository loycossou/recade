import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { expandHome, configDir } from '../src/paths.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig, setConfigValue } from '../src/config.js';
import { initState, loadState, saveState } from '../src/state.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'recade-config-'));

function makeIO(cwd, env) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('defaults when no config file', () => {
  const dir = tmp();
  const { config, warnings } = loadConfig({ RECADE_CONFIG_DIR: dir });
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(warnings, []);
  assert.equal(existsSync(join(dir, 'config.yaml')), false);
  rmSync(dir, { recursive: true });
});

test('DEFAULT_CONFIG has the documented values', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    version: 1,
    started: false,
    languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] },
    github_owner: null,
    projects_root: '~/projects',
    voice: 'randall-munroe',
  });
});

test('corrupt YAML falls back to defaults with a warning', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.yaml'), 'languages: [unclosed\n  : : :\n');
  const { config, warnings } = loadConfig({ RECADE_CONFIG_DIR: dir });
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(warnings, [
    `config.yaml is not valid YAML; using defaults. Fix or delete ${join(dir, 'config.yaml')}.`,
  ]);
  rmSync(dir, { recursive: true });
});

test('a config file that is not a mapping falls back to defaults with a warning', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.yaml'), '- a\n- b\n');
  const { config, warnings } = loadConfig({ RECADE_CONFIG_DIR: dir });
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(warnings.length, 1);
  rmSync(dir, { recursive: true });
});

test('partial config is merged over defaults and unknown keys are kept', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.yaml'), 'voice: plain\nlanguages:\n  chat: fr\nextra: 1\n');
  const { config, warnings } = loadConfig({ RECADE_CONFIG_DIR: dir });
  assert.deepEqual(warnings, []);
  assert.equal(config.voice, 'plain');
  assert.equal(config.languages.chat, 'fr');
  assert.equal(config.languages.work, 'en');
  assert.equal(config.extra, 1);
  rmSync(dir, { recursive: true });
});

test('expandHome keeps spaces and expands ~', () => {
  assert.equal(expandHome('~/my projects', { HOME: '/home/u' }), '/home/u/my projects');
  assert.equal(expandHome('~', { HOME: '/home/u' }), '/home/u');
  assert.equal(expandHome('/abs/~/x', { HOME: '/home/u' }), '/abs/~/x');
  assert.equal(expandHome('~other/x', { HOME: '/home/u' }), '~other/x');
});

test('configDir honours RECADE_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config', () => {
  assert.equal(configDir({ RECADE_CONFIG_DIR: '/c', XDG_CONFIG_HOME: '/x', HOME: '/h' }), '/c');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x', HOME: '/h' }), '/x/recade');
  assert.equal(configDir({ HOME: '/h' }), '/h/.config/recade');
});

test('saveConfig creates the directory and round-trips', () => {
  const dir = join(tmp(), 'nested', 'recade');
  const env = { RECADE_CONFIG_DIR: dir };
  const config = setConfigValue(DEFAULT_CONFIG, 'voice', 'plain');
  saveConfig(config, env);
  assert.deepEqual(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')), config);
  assert.deepEqual(loadConfig(env).config, config);
});

test('set languages.deliverables "en,fr" stores an array', () => {
  const next = setConfigValue(DEFAULT_CONFIG, 'languages.deliverables', 'en, fr');
  assert.deepEqual(next.languages.deliverables, ['en', 'fr']);
  assert.deepEqual(DEFAULT_CONFIG.languages.deliverables, ['en']);
});

test('set parses booleans and plain strings', () => {
  assert.equal(setConfigValue(DEFAULT_CONFIG, 'started', 'true').started, true);
  assert.equal(setConfigValue({ ...DEFAULT_CONFIG, started: true }, 'started', 'false').started, false);
  assert.equal(setConfigValue(DEFAULT_CONFIG, 'github_owner', 'someone').github_owner, 'someone');
  assert.equal(setConfigValue(DEFAULT_CONFIG, 'languages.chat', 'fr').languages.chat, 'fr');
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'started', 'yes'), /true or false/);
});

test('invalid language code is rejected', () => {
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'languages.chat', 'french'), /language code/i);
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'languages.deliverables', 'en,FR'), /language code/i);
});

test('empty lists, empty voice and unknown keys are rejected', () => {
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'languages.deliverables', ''), /at least one/i);
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'languages.product_ui', ' , '), /at least one/i);
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'voice', '  '), /voice/);
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'nope', 'x'), /Unknown key: nope/);
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'languages.nope', 'x'), /Unknown key: languages\.nope/);
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'languages', 'x'), /languages\./);
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'version', '2'), /version/);
  assert.throws(
    () => setConfigValue(DEFAULT_CONFIG, 'languages.chat', 'french'),
    (err) => !err.message.includes('\n'),
  );
});

test('initState copies languages and voice from config', () => {
  const config = setConfigValue(setConfigValue(DEFAULT_CONFIG, 'languages.chat', 'fr'), 'voice', 'plain');
  const state = initState('/p', { mode: 'adopt' }, config);
  assert.deepEqual(state, {
    version: 1,
    mode: 'adopt',
    phase: 0,
    gates: {},
    next_action: null,
    voice: 'plain',
    languages: config.languages,
    lots: [],
    slicing: 'mixed',
  });
  state.languages.chat = 'de';
  assert.equal(config.languages.chat, 'fr');
  assert.throws(() => initState('/p', { mode: 'nope' }, config), /mode/);
});

test('saveState writes recade/state.yaml and loadState reads it back', () => {
  const dir = tmp();
  assert.equal(loadState(dir), null);
  const state = initState(dir, { mode: 'scratch' }, DEFAULT_CONFIG);
  saveState(dir, state);
  assert.equal(existsSync(join(dir, 'recade', 'state.yaml')), true);
  assert.deepEqual(loadState(dir), state);
  writeFileSync(join(dir, 'recade', 'state.yaml'), 'a: [unclosed\n  : :\n');
  assert.throws(() => loadState(dir), /state\.yaml is not valid YAML/);
  rmSync(dir, { recursive: true });
});

test('recade config path, get, set work against RECADE_CONFIG_DIR', async () => {
  const dir = tmp();
  const env = { RECADE_CONFIG_DIR: dir };
  const path = makeIO(dir, env);
  assert.equal(await run(['config', 'path'], path.io), 0);
  assert.equal(path.stdout().trim(), join(dir, 'config.yaml'));

  const all = makeIO(dir, env);
  assert.equal(await run(['config', 'get'], all.io), 0);
  assert.deepEqual(parse(all.stdout()), DEFAULT_CONFIG);

  const set = makeIO(dir, env);
  assert.equal(await run(['config', 'set', 'languages.deliverables', 'en,fr'], set.io), 0);
  const one = makeIO(dir, env);
  assert.equal(await run(['config', 'get', 'languages.deliverables'], one.io), 0);
  assert.deepEqual(parse(one.stdout()), ['en', 'fr']);
  const scalar = makeIO(dir, env);
  assert.equal(await run(['config', 'get', 'voice'], scalar.io), 0);
  assert.equal(scalar.stdout().trim(), 'randall-munroe');
  rmSync(dir, { recursive: true });
});

test('recade config usage errors exit 2 and leave the file alone', async () => {
  const dir = tmp();
  const env = { RECADE_CONFIG_DIR: dir };
  const bad = makeIO(dir, env);
  assert.equal(await run(['config', 'set', 'languages.chat', 'french'], bad.io), 2);
  assert.match(bad.stderr(), /language code/i);
  assert.equal(existsSync(join(dir, 'config.yaml')), false);
  for (const args of [[], ['nope'], ['set'], ['set', 'voice'], ['get', 'a', 'b'], ['path', 'x'], ['get', 'nope']]) {
    const t = makeIO(dir, env);
    assert.equal(await run(['config', ...args], t.io), 2, args.join(' '));
    assert.notEqual(t.stderr(), '');
  }
  rmSync(dir, { recursive: true });
});

test('recade config get prints the corrupt-file warning on stderr', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.yaml'), 'a: [unclosed\n  : :\n');
  const t = makeIO(dir, { RECADE_CONFIG_DIR: dir });
  assert.equal(await run(['config', 'get', 'voice'], t.io), 0);
  assert.match(t.stderr(), /not valid YAML; using defaults/);
  assert.equal(t.stdout().trim(), 'randall-munroe');
  rmSync(dir, { recursive: true });
});

test('index check reads lots from recade/state.yaml when --lots is absent', async () => {
  const root = tmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'backlog.md'), '| ID | Title |\n|---|---|\n| BKL-01 | Set up CI |\n');
  writeFileSync(join(root, 'a.md'), 'Do BKL-01 (set up CI) then BKL-02 (ghost).\n');
  const none = makeIO(root, {});
  assert.equal(await run(['index', 'check'], none.io), 0);
  saveState(root, { ...initState(root, { mode: 'scratch' }, DEFAULT_CONFIG), lots: ['BKL'] });
  const fromState = makeIO(root, {});
  assert.equal(await run(['index', 'check'], fromState.io), 1);
  assert.match(fromState.stdout(), /BKL-02/);
  const override = makeIO(root, {});
  assert.equal(await run(['index', 'check', '--lots', 'OPS'], override.io), 0);
  rmSync(root, { recursive: true });
});

test('index check without lots in state, or with a corrupt state, still runs', async () => {
  const root = tmp();
  writeFileSync(join(root, 'a.md'), 'Nothing here.\n');
  mkdirSync(join(root, 'recade'));
  writeFileSync(join(root, 'recade', 'state.yaml'), 'version: 1\n');
  assert.equal(await run(['index', 'check'], makeIO(root, {}).io), 0);
  writeFileSync(join(root, 'recade', 'state.yaml'), 'a: [unclosed\n  : :\n');
  const t = makeIO(root, {});
  assert.equal(await run(['index', 'check'], t.io), 0);
  assert.match(t.stderr(), /state\.yaml is not valid YAML/);
  rmSync(root, { recursive: true });
});

test('config set on a config that does not parse leaves the file untouched and exits 1', async () => {
  const dir = tmp();
  const file = join(dir, 'config.yaml');
  const bytes = 'languages: [unclosed\n  : : :\nvoice: keep-me\n';
  writeFileSync(file, bytes);
  const t = makeIO(dir, { RECADE_CONFIG_DIR: dir });
  assert.equal(await run(['config', 'set', 'voice', 'plain'], t.io), 1);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(t.stderr(), `config.yaml is not valid YAML. Fix or delete ${file}, then try again.\n`);
  rmSync(dir, { recursive: true });
});

test('config get and set report an unreadable config on one line and exit 1', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'config.yaml'));
  for (const args of [['get'], ['get', 'voice'], ['set', 'voice', 'plain']]) {
    const t = makeIO(dir, { RECADE_CONFIG_DIR: dir });
    assert.equal(await run(['config', ...args], t.io), 1, args.join(' '));
    assert.equal(t.stderr().trim().split('\n').length, 1);
    assert.match(t.stderr(), /^Cannot read /);
    assert.equal(t.stdout(), '');
  }
  rmSync(dir, { recursive: true });
});

test('config set reports a write failure on one line and exits 1', async () => {
  const dir = tmp();
  // A dangling symlink reads as missing, but the write fails because its target directory is absent.
  symlinkSync(join(dir, 'no-such-dir', 'config.yaml'), join(dir, 'config.yaml'));
  const t = makeIO(dir, { RECADE_CONFIG_DIR: dir });
  assert.equal(await run(['config', 'set', 'voice', 'plain'], t.io), 1);
  assert.match(t.stderr(), /^Cannot write /);
  assert.equal(t.stderr().trim().split('\n').length, 1);
  rmSync(dir, { recursive: true });
});

test('configDir falls back to the OS home directory and never returns a relative path', () => {
  const saved = process.env.HOME;
  delete process.env.HOME;
  try {
    const dir = configDir({});
    assert.ok(isAbsolute(dir), dir);
    assert.equal(dir, join(homedir(), '.config', 'recade'));
    assert.equal(configDir({ HOME: '' }), join(homedir(), '.config', 'recade'));
  } finally {
    if (saved !== undefined) process.env.HOME = saved;
  }
});

test('deliverables and product_ui accept BCP 47 tags, the other keys stay two letters', () => {
  for (const key of ['languages.deliverables', 'languages.product_ui']) {
    assert.deepEqual(setConfigValue(DEFAULT_CONFIG, key, 'en,pt-BR,zh-Hant-TW').languages[key.split('.')[1]],
      ['en', 'pt-BR', 'zh-Hant-TW']);
    assert.deepEqual(setConfigValue(DEFAULT_CONFIG, key, 'fil').languages[key.split('.')[1]], ['fil']);
    for (const bad of ['EN', 'e', 'pt_BR', 'pt-', 'pt-B', 'english', 'pt-BR-x1234567890']) {
      assert.throws(() => setConfigValue(DEFAULT_CONFIG, key, bad), /language code/i, bad);
    }
  }
  for (const key of ['languages.chat', 'languages.work', 'languages.code']) {
    assert.throws(() => setConfigValue(DEFAULT_CONFIG, key, 'pt-BR'), /language code/i, key);
    assert.throws(() => setConfigValue(DEFAULT_CONFIG, key, 'fil'), /language code/i, key);
  }
});
