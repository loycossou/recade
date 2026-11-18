import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, REQUIRED_PLUGINS, OPTIONAL_PLUGINS, SKILL_MARKETPLACE, defaultExec } from '../src/doctor.js';
import { run } from '../src/cli.js';

const OK = { code: 0, stdout: '', stderr: '' };
const ALL_ENABLED = Object.fromEntries(
  [...REQUIRED_PLUGINS, 'postman'].map((n) => [`${n}@claude-plugins-official`, true]),
);

/** Fake exec from a map of "cmd arg arg" to result; anything else is "not found". */
function fakeExec(table) {
  const calls = [];
  const exec = async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    return Object.hasOwn(table, key) ? table[key] : { code: 127, stdout: '', stderr: 'not found' };
  };
  exec.calls = calls;
  return exec;
}

const GOOD_TABLE = {
  'git --version': { ...OK, stdout: 'git version 2.43.0\n' },
  'git config --global user.email': { ...OK, stdout: 'private-value\n' },
  'gh --version': { ...OK, stdout: 'gh version 2.40.0\n' },
  'gh auth status': { ...OK, stdout: "  - Token scopes: 'gist', 'project', 'read:org', 'repo'\n" },
};

const SETTINGS_PATH = '/home/test/.claude/settings.json';
const KNOWN_PATH = '/home/test/.claude/plugins/known_marketplaces.json';

/** Fake readFile over a map of path to content (object, string or undefined for missing). */
function filesReader(files) {
  return async (p) => {
    const v = files[p];
    if (v === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
}

function settingsReader(settings) {
  return filesReader({ [SETTINGS_PATH]: settings });
}

const goodSettings = {
  enabledPlugins: ALL_ENABLED,
  extraKnownMarketplaces: {
    skills: { source: { source: 'github', repo: SKILL_MARKETPLACE } },
  },
};

function base(overrides = {}) {
  return {
    exec: fakeExec(GOOD_TABLE),
    readFile: settingsReader(goodSettings),
    env: { HOME: '/home/test' },
    nodeVersion: '22.22.3',
    ...overrides,
  };
}

const byId = (checks, id) => checks.find((c) => c.id === id);

test('constants list the required and optional plugins and the skills marketplace', () => {
  assert.deepEqual(REQUIRED_PLUGINS, [
    'superpowers', 'frontend-design', 'code-review', 'code-simplifier', 'github', 'chrome-devtools-mcp',
  ]);
  assert.deepEqual(OPTIONAL_PLUGINS, ['postman@claude-plugins-official']);
  assert.equal(SKILL_MARKETPLACE, 'anthropics/skills');
});

test('everything present: all checks ok, in the documented order', async () => {
  const all = await runChecks(base());
  // Render checks (render-*) depend on what is installed on this machine; they have their own tests.
  const checks = all.filter((c) => !c.id.startsWith('render-'));
  assert.deepEqual(
    checks.map((c) => c.id),
    [
      'node', 'git', 'git-email', 'gh', 'gh-auth',
      ...REQUIRED_PLUGINS.map((n) => `plugin:${n}`),
      'plugin:postman', 'skills-marketplace',
    ],
  );
  assert.deepEqual(all.slice(checks.length).map((c) => c.id), ['render-deps', 'render-chromium', 'render-fonts']);
  for (const c of checks) assert.equal(c.status, 'ok', c.id);
  assert.equal(byId(checks, 'node').detail, '22.22.3');
  assert.equal(byId(checks, 'plugin:postman').required, false);
  assert.equal(byId(checks, 'plugin:superpowers').required, true);
});

test('node 18 is missing, node 20 ok', async () => {
  const old = byId(await runChecks(base({ nodeVersion: '18.19.0' })), 'node');
  assert.equal(old.status, 'missing');
  assert.equal(old.required, true);
  assert.ok(old.fix);
  const ok = byId(await runChecks(base({ nodeVersion: '20.0.0' })), 'node');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.fix, null);
});

test('gh absent: gh and gh-auth missing with fixes, no throw', async () => {
  const table = { ...GOOD_TABLE };
  delete table['gh --version'];
  delete table['gh auth status'];
  const checks = await runChecks(base({ exec: fakeExec(table) }));
  const gh = byId(checks, 'gh');
  const auth = byId(checks, 'gh-auth');
  assert.equal(gh.status, 'missing');
  assert.ok(gh.fix);
  assert.equal(auth.status, 'missing');
  assert.equal(auth.fix, 'gh auth login -s project');
});

test('gh-auth missing project scope: missing with a refresh fix', async () => {
  const table = {
    ...GOOD_TABLE,
    'gh auth status': { ...OK, stdout: "  - Token scopes: 'gist', 'read:org', 'read:project', 'repo'\n" },
  };
  const auth = byId(await runChecks(base({ exec: fakeExec(table) })), 'gh-auth');
  assert.equal(auth.status, 'missing');
  assert.equal(auth.fix, 'gh auth refresh -s project');
});

test('gh-auth reads the scopes line on stderr too', async () => {
  const table = {
    ...GOOD_TABLE,
    'gh auth status': { code: 0, stdout: '', stderr: "  - Token scopes: 'project', 'repo'\n" },
  };
  assert.equal(byId(await runChecks(base({ exec: fakeExec(table) })), 'gh-auth').status, 'ok');
});

test('gh auth status failing: missing with a login fix', async () => {
  const table = { ...GOOD_TABLE, 'gh auth status': { code: 1, stdout: '', stderr: 'not logged in' } };
  const auth = byId(await runChecks(base({ exec: fakeExec(table) })), 'gh-auth');
  assert.equal(auth.status, 'missing');
  assert.equal(auth.fix, 'gh auth login -s project');
});

test('git-email unset is a warn and never prints an address', async () => {
  const table = { ...GOOD_TABLE, 'git config --global user.email': { code: 1, stdout: '', stderr: '' } };
  const email = byId(await runChecks(base({ exec: fakeExec(table) })), 'git-email');
  assert.equal(email.status, 'warn');
  assert.equal(email.required, false);
  assert.equal(email.fix, 'git config --global user.email <you>@users.noreply.github.com');
  const set = byId(await runChecks(base()), 'git-email');
  assert.equal(set.status, 'ok');
  assert.ok(!JSON.stringify(set).includes('private-value'));
});

test('plugin checks read enabledPlugins', async () => {
  const enabled = { ...ALL_ENABLED };
  delete enabled['code-review@claude-plugins-official'];
  enabled['github@claude-plugins-official'] = false;
  const checks = await runChecks(base({ readFile: settingsReader({ enabledPlugins: enabled }) }));
  assert.equal(byId(checks, 'plugin:superpowers').status, 'ok');
  const review = byId(checks, 'plugin:code-review');
  assert.equal(review.status, 'missing');
  assert.equal(review.fix, 'claude plugin install code-review@claude-plugins-official');
  const github = byId(checks, 'plugin:github');
  assert.equal(github.status, 'missing');
  assert.equal(github.detail, 'disabled');
  assert.equal(github.fix, 'claude plugin enable github@claude-plugins-official');
});

test('a plugin that is not in enabledPlugins keeps the install fix and no disabled detail', async () => {
  const enabled = { ...ALL_ENABLED };
  delete enabled['github@claude-plugins-official'];
  const github = byId(await runChecks(base({ readFile: settingsReader({ enabledPlugins: enabled }) })), 'plugin:github');
  assert.equal(github.detail, null);
  assert.equal(github.fix, 'claude plugin install github@claude-plugins-official');
});

test('missing postman is reported but not required', async () => {
  const enabled = { ...ALL_ENABLED };
  delete enabled['postman@claude-plugins-official'];
  const checks = await runChecks(base({ readFile: settingsReader({ enabledPlugins: enabled }) }));
  const postman = byId(checks, 'plugin:postman');
  assert.equal(postman.status, 'missing');
  assert.equal(postman.required, false);
});

test('missing or unparsable settings: every plugin check is missing, no throw', async () => {
  for (const settings of [undefined, '{ not json', '[]', 'null']) {
    const checks = await runChecks(base({ readFile: settingsReader(settings) }));
    for (const c of checks.filter((x) => x.id.startsWith('plugin:'))) {
      assert.equal(c.status, 'missing', `${settings} ${c.id}`);
    }
    assert.equal(byId(checks, 'skills-marketplace').status, 'warn');
  }
});

test('skills-marketplace warns without the anthropics/skills repo', async () => {
  const settings = { enabledPlugins: ALL_ENABLED, extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'someone/else' } } } };
  const mp = byId(await runChecks(base({ readFile: settingsReader(settings) })), 'skills-marketplace');
  assert.equal(mp.status, 'warn');
  assert.equal(mp.required, false);
  assert.ok(mp.fix);
});

const skillsEntry = (repo) => ({ skills: { source: { source: 'github', repo }, installLocation: '/x', lastUpdated: 'now' } });
const pluginsOnly = { enabledPlugins: ALL_ENABLED };

test('skills-marketplace is ok via known_marketplaces.json only', async () => {
  const readFile = filesReader({ [SETTINGS_PATH]: pluginsOnly, [KNOWN_PATH]: skillsEntry(SKILL_MARKETPLACE) });
  const mp = byId(await runChecks(base({ readFile })), 'skills-marketplace');
  assert.equal(mp.status, 'ok');
  assert.equal(mp.fix, null);
});

test('skills-marketplace is ok via settings extraKnownMarketplaces only', async () => {
  const readFile = filesReader({ [SETTINGS_PATH]: goodSettings });
  assert.equal(byId(await runChecks(base({ readFile })), 'skills-marketplace').status, 'ok');
});

test('skills-marketplace warns when neither file lists it, or one is unparsable', async () => {
  const readFile = filesReader({ [SETTINGS_PATH]: pluginsOnly, [KNOWN_PATH]: '{ not json' });
  assert.equal(byId(await runChecks(base({ readFile })), 'skills-marketplace').status, 'warn');
  const none = filesReader({ [SETTINGS_PATH]: pluginsOnly });
  assert.equal(byId(await runChecks(base({ readFile: none })), 'skills-marketplace').status, 'warn');
});

test('skills-marketplace compares the repo exactly, not as a substring', async () => {
  for (const repo of ['foo/anthropics/skills-x', 'anthropics/skills-extra', 'Anthropics/Skills', 'x-anthropics/skills']) {
    const readFile = filesReader({
      [SETTINGS_PATH]: { enabledPlugins: ALL_ENABLED, extraKnownMarketplaces: skillsEntry(repo) },
      [KNOWN_PATH]: skillsEntry(repo),
    });
    assert.equal(byId(await runChecks(base({ readFile })), 'skills-marketplace').status, 'warn', repo);
  }
});

test('HOME unset or empty: no file is read and plugin checks are missing', async () => {
  for (const env of [{}, { HOME: '' }]) {
    const reads = [];
    const readFile = async (p) => {
      reads.push(p);
      return JSON.stringify(goodSettings);
    };
    const checks = await runChecks(base({ env, readFile }));
    assert.deepEqual(reads, []);
    assert.equal(byId(checks, 'plugin:superpowers').status, 'missing');
    assert.equal(byId(checks, 'skills-marketplace').status, 'warn');
  }
});

test('exec that rejects does not break runChecks', async () => {
  const exec = async () => {
    throw new Error('boom');
  };
  const checks = await runChecks(base({ exec }));
  assert.equal(byId(checks, 'git').status, 'missing');
});

test('defaultExec maps a missing binary to code 127 and never throws', async () => {
  const r = await defaultExec('recade-no-such-binary', []);
  assert.equal(r.code, 127);
  const ok = await defaultExec(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.deepEqual(ok, { code: 0, stdout: 'hi', stderr: '' });
  const bad = await defaultExec(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(bad.code, 3);
});

function makeIO(extra = {}) {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      cwd: process.cwd(),
      env: { HOME: '/home/test' },
      exec: fakeExec(GOOD_TABLE),
      readFile: settingsReader(goodSettings),
      nodeVersion: '22.22.3',
      ...extra,
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('recade doctor prints one padded line per check and exits 0 when required checks pass', async () => {
  const t = makeIO();
  const code = await run(['doctor'], t.io);
  assert.equal(code, 0);
  const lines = t.stdout().trimEnd().split('\n');
  assert.equal(lines.length, 16);
  assert.equal(lines[0], 'ok      node  22.22.3');
  assert.ok(lines.slice(0, 13).every((l) => l.startsWith('ok      ')));
});

test('recade doctor shows the fix and exits 1 when a required check is missing', async () => {
  const table = { ...GOOD_TABLE, 'gh auth status': { code: 0, stdout: "Token scopes: 'repo'", stderr: '' } };
  const t = makeIO({ exec: fakeExec(table) });
  const code = await run(['doctor'], t.io);
  assert.equal(code, 1);
  assert.match(t.stdout(), /^missing gh-auth {2}fix: gh auth refresh -s project$/m);
});

test('recade doctor says disabled and gives the enable command for an installed but disabled plugin', async () => {
  const t = makeIO({ readFile: settingsReader({ ...goodSettings, enabledPlugins: { ...ALL_ENABLED, 'chrome-devtools-mcp@claude-plugins-official': false } }) });
  assert.equal(await run(['doctor'], t.io), 1);
  assert.match(t.stdout(), /^missing plugin:chrome-devtools-mcp {2}disabled, fix: claude plugin enable chrome-devtools-mcp@claude-plugins-official$/m);
  assert.doesNotMatch(t.stdout(), /plugin install chrome-devtools-mcp/);
});

test('recade doctor exits 0 when only optional checks fail', async () => {
  const table = { ...GOOD_TABLE, 'git config --global user.email': { code: 1, stdout: '', stderr: '' } };
  const t = makeIO({ exec: fakeExec(table) });
  assert.equal(await run(['doctor'], t.io), 0);
  assert.match(t.stdout(), /^warn {4}git-email {2}fix: /m);
});

test('recade doctor --json prints the Check array', async () => {
  const t = makeIO();
  const code = await run(['doctor', '--json'], t.io);
  assert.equal(code, 0);
  const checks = JSON.parse(t.stdout());
  assert.equal(checks.length, 16);
  assert.deepEqual(Object.keys(checks[0]).sort(), ['detail', 'fix', 'id', 'label', 'required', 'status']);
});

test('recade doctor rejects unknown options with exit 2', async () => {
  const t = makeIO();
  assert.equal(await run(['doctor', '--nope'], t.io), 2);
  assert.match(t.stderr(), /Usage: recade doctor/);
});
