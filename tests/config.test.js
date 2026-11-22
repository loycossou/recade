import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
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
    models: { writer: 'opus', second_opinion: 'opus' },
    deliverables: { extras: [], pdf: false },
    stack: { prefer: { php: 'symfony' } },
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

test('saveState replaces the file in one step: a reader in another process never sees it empty or half written', async () => {
  const dir = tmp();
  const state = { ...initState(dir, { mode: 'scratch' }, DEFAULT_CONFIG), lots: Array.from({ length: 400 }, (_, i) => `LOT${i}`) };
  saveState(dir, state);
  const writer = spawn(process.execPath, ['--input-type=module', '-e',
    `import { saveState } from ${JSON.stringify(new URL('../src/state.js', import.meta.url).href)};
     const [dir, text] = process.argv.slice(1);
     const state = JSON.parse(text);
     for (let i = 0; i < 1500; i++) saveState(dir, state);`,
    dir, JSON.stringify(state)], { stdio: 'ignore' });
  const done = new Promise((resolve) => writer.on('close', resolve));
  let reads = 0;
  let finished = false;
  done.then(() => { finished = true; });
  while (!finished) {
    assert.deepEqual(loadState(dir), state);
    reads += 1;
    if (reads % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  assert.equal(await done, 0);
  assert.ok(reads > 0);
  assert.deepEqual(readdirSync(join(dir, 'recade')), ['state.yaml']);
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

test('models.writer is fable or opus, and anything else is refused in one line', () => {
  assert.equal(DEFAULT_CONFIG.models.writer, 'opus');
  assert.equal(setConfigValue(DEFAULT_CONFIG, 'models.writer', 'opus').models.writer, 'opus');
  assert.equal(setConfigValue(DEFAULT_CONFIG, 'models.writer', ' fable ').models.writer, 'fable');
  for (const bad of ['sonnet', 'claude-opus-5-5', 'Opus', '']) {
    assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'models.writer', bad), { message: 'models.writer must be fable or opus.' }, bad);
  }
});

test('models.second_opinion is opus or fable, opus by default, and anything else is refused in one line', () => {
  assert.equal(DEFAULT_CONFIG.models.second_opinion, 'opus');
  assert.equal(setConfigValue(DEFAULT_CONFIG, 'models.second_opinion', ' fable ').models.second_opinion, 'fable');
  assert.equal(setConfigValue(DEFAULT_CONFIG, 'models.second_opinion', 'opus').models.second_opinion, 'opus');
  for (const bad of ['sonnet', 'claude-fable-5-2', 'Fable', '']) {
    assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'models.second_opinion', bad), { message: 'models.second_opinion must be opus or fable.' }, bad);
  }
});

test('recade config set models.writer fable is read back by config get and by recade models writer', async () => {
  const dir = tmp();
  const env = { RECADE_CONFIG_DIR: dir };
  const read = async (args) => {
    const t = makeIO(dir, env);
    const code = await run(args, t.io);
    return { code, out: t.stdout(), err: t.stderr() };
  };
  assert.deepEqual(await read(['models', 'writer']), { code: 0, out: 'opus\n', err: '' });
  assert.deepEqual(await read(['models', 'writer', '--id']), { code: 0, out: 'claude-opus-5-5\n', err: '' });
  assert.equal((await read(['config', 'set', 'models.writer', 'fable'])).code, 0);
  assert.equal((await read(['config', 'get', 'models.writer'])).out, 'fable\n');
  assert.deepEqual(await read(['models', 'writer']), { code: 0, out: 'fable\n', err: '' });
  assert.deepEqual(await read(['models', 'writer', '--id']), { code: 0, out: 'claude-fable-5-2\n', err: '' });
  const bad = await read(['config', 'set', 'models.writer', 'gpt']);
  assert.equal(bad.code, 2);
  assert.equal(bad.err, 'models.writer must be fable or opus.\n');
  assert.equal((await read(['models', 'writer'])).out, 'fable\n');
  rmSync(dir, { recursive: true });
});

test('recade models writer names the bad value of a hand-edited config and exits 1; bad usage exits 2', async () => {
  const dir = tmp();
  const env = { RECADE_CONFIG_DIR: dir };
  writeFileSync(join(dir, 'config.yaml'), 'models:\n  writer: gpt\n');
  const t = makeIO(dir, env);
  assert.equal(await run(['models', 'writer'], t.io), 1);
  assert.equal(t.stdout(), '');
  assert.match(t.stderr(), /models\.writer is "gpt" in .*config\.yaml\. Use fable or opus: recade config set models\.writer fable/);
  for (const args of [[], ['reviewer'], ['writer', '--json'], ['writer', '--id', 'x'], ['mechanical', '--id'], ['mechanical', '--effort', 'x']]) {
    const u = makeIO(dir, env);
    assert.equal(await run(['models', ...args], u.io), 2, args.join(' '));
    assert.equal(u.stderr(), 'Usage: recade models writer [--id] | mechanical [--effort]\n');
  }
  rmSync(dir, { recursive: true });
});

test('deliverables.extras is empty by default and takes stack, decisions, design and reviews', () => {
  assert.deepEqual(DEFAULT_CONFIG.deliverables.extras, []);
  assert.deepEqual(setConfigValue(DEFAULT_CONFIG, 'deliverables.extras', 'stack').deliverables.extras, ['stack']);
  assert.deepEqual(setConfigValue(DEFAULT_CONFIG, 'deliverables.extras', 'reviews, stack,design').deliverables.extras, ['stack', 'design', 'reviews']);
  assert.deepEqual(setConfigValue(DEFAULT_CONFIG, 'deliverables.extras', 'stack,stack,decisions').deliverables.extras, ['stack', 'decisions']);
  assert.deepEqual(setConfigValue(DEFAULT_CONFIG, 'deliverables.extras', 'stack,decisions,design,reviews').deliverables.extras, ['stack', 'decisions', 'design', 'reviews']);
});

test('deliverables.extras is cleared by none or an empty value', () => {
  const set = setConfigValue(DEFAULT_CONFIG, 'deliverables.extras', 'stack,design');
  for (const clear of ['none', ' None ', '', '  ', ',']) {
    assert.deepEqual(setConfigValue(set, 'deliverables.extras', clear).deliverables.extras, [], JSON.stringify(clear));
  }
});

test('deliverables.extras refuses an unknown name, none beside a name, and a bare group, each in one line', () => {
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'deliverables.extras', 'stack,slides'), { message: 'Unknown extra deliverable: slides. Use stack, decisions, design, reviews, or none.' });
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'deliverables.extras', 'Stack'), /Unknown extra deliverable: Stack/);
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'deliverables.extras', 'none,stack'), { message: 'none cannot be combined with other extras.' });
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'deliverables', 'stack'), /has sub-keys/);
  assert.throws(() => setConfigValue(DEFAULT_CONFIG, 'deliverables.other', 'x'), /Unknown key/);
});

test('deliverables.pdf is off by default, and config set turns it on and off', async () => {
  const dir = tmp();
  const env = { RECADE_CONFIG_DIR: dir };
  const go = async (args) => {
    const t = makeIO(dir, env);
    const code = await run(args, t.io);
    return { code, out: t.stdout(), err: t.stderr() };
  };
  assert.deepEqual(await go(['config', 'get', 'deliverables.pdf']), { code: 0, out: 'false\n', err: '' });
  assert.equal((await go(['config', 'set', 'deliverables.pdf', 'true'])).code, 0);
  assert.equal((await go(['config', 'get', 'deliverables.pdf'])).out, 'true\n');
  assert.equal((await go(['config', 'set', 'deliverables.pdf', 'yes'])).err, 'deliverables.pdf must be true or false.\n');
  assert.equal((await go(['config', 'set', 'deliverables.pdf', 'false'])).code, 0);
  assert.equal(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).deliverables.pdf, false);
  rmSync(dir, { recursive: true });
});

test('recade config set and get round-trip deliverables.extras, and the file keeps a plain list', async () => {
  const dir = tmp();
  const env = { RECADE_CONFIG_DIR: dir };
  const go = async (args) => {
    const t = makeIO(dir, env);
    const code = await run(args, t.io);
    return { code, out: t.stdout(), err: t.stderr() };
  };
  assert.deepEqual(await go(['config', 'get', 'deliverables.extras']), { code: 0, out: '[]\n', err: '' });
  assert.equal((await go(['config', 'set', 'deliverables.extras', 'design,stack'])).code, 0);
  assert.equal((await go(['config', 'get', 'deliverables.extras'])).out, '- stack\n- design\n');
  assert.deepEqual(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).deliverables, { extras: ['stack', 'design'], pdf: false });
  const bad = await go(['config', 'set', 'deliverables.extras', 'pdf']);
  assert.equal(bad.code, 2);
  assert.equal(bad.err, 'Unknown extra deliverable: pdf. Use stack, decisions, design, reviews, or none.\n');
  assert.equal((await go(['config', 'get', 'deliverables.extras'])).out, '- stack\n- design\n');
  assert.equal((await go(['config', 'set', 'deliverables.extras', 'none'])).code, 0);
  assert.equal((await go(['config', 'get', 'deliverables.extras'])).out, '[]\n');
  rmSync(dir, { recursive: true });
});
