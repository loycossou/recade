import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PHASES, GATES, normalizeState, canStart, passGate, nextAction, projectRoot, currentPhase, setSetting, phaseCommand, resetFrom,
} from '../../src/project/state.js';
import { initState, saveState } from '../../src/state.js';
import { run } from '../../src/cli.js';
import { linkRepo } from '../../src/workspace/layout.js';

const CONFIG = { voice: 'randall-munroe', languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] } };
const fresh = () => normalizeState(initState('/p', { mode: 'scratch' }, CONFIG));

function pass(state, ...gates) {
  let s = state;
  for (const g of gates) s = passGate(s, g, '2026-11-13');
  return s;
}

test('PHASES and GATES follow the state contract', () => {
  assert.deepEqual(PHASES.map((p) => [p.id, p.name]), [
    [0, 'Intake'], [1, 'Team'], [2, 'Documents'], [3, 'Bible'], [4, 'Slices'], [5, 'Harness'],
  ]);
  assert.deepEqual(PHASES.map((p) => p.gates), [['G0'], ['G1'], ['G2-stack', 'G2'], ['G3'], ['G4'], ['G5']]);
  assert.deepEqual(GATES, ['G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5']);
});

test('normalizeState fills a legacy plan 1 state without touching what is there', () => {
  const s = normalizeState({ version: 1, mode: 'scratch', phase: 0, gates: {}, lots: ['BKL'], voice: 'v' });
  assert.deepEqual(s.gates, { G0: null, G1: null, 'G2-stack': null, G2: null, G3: null, G4: null, G5: null });
  assert.equal(s.slicing, 'mixed');
  assert.equal(s.second_opinion, 'sensitive');
  assert.deepEqual(s.hotspots, []);
  assert.deepEqual(s.lots, ['BKL']);
  assert.equal(s.voice, 'v');
  const bare = normalizeState({ version: 1, mode: 'adopt' });
  assert.equal(bare.phase, 0);
  assert.deepEqual(bare.lots, []);
  assert.equal(bare.gates['G0-inventory'], null);
  assert.equal('G0' in bare.gates, false);
  assert.equal(bare.next_action, 'Run /recade:adopt to finish the inventory (G0-inventory is open).');
});

test('normalizeState recomputes phase and next_action from the gates', () => {
  const stale = { phase: 4, next_action: 'Run /recade:slices.', gates: { G0: { passed: '2026-11-01', by: 'owner' } } };
  const s = normalizeState(stale);
  assert.equal(s.phase, 1);
  assert.equal(s.next_action, 'Run /recade:team (G0 passed on 2026-11-01).');
  assert.equal(stale.phase, 4);
});

test('PHASES, GATES and their entries are frozen', () => {
  assert.ok(Object.isFrozen(PHASES) && Object.isFrozen(GATES));
  for (const p of PHASES) assert.ok(Object.isFrozen(p) && Object.isFrozen(p.gates));
  assert.throws(() => { PHASES.push({}); }, TypeError);
  assert.throws(() => { PHASES[0].name = 'x'; }, TypeError);
});

test('phaseCommand follows the mode at phase 0 only', () => {
  const s = fresh();
  assert.equal(phaseCommand(s), 'new');
  assert.equal(phaseCommand({ ...s, mode: 'adopt' }), 'adopt');
  assert.equal(phaseCommand({ ...passGate({ ...s, mode: 'adopt' }, 'G0-inventory', '2026-11-13') }), 'team');
});

test('normalizeState keeps passed gates and does not mutate its input', () => {
  const input = { gates: { G0: { passed: '2026-11-01', by: 'owner' } } };
  const s = normalizeState(input);
  assert.deepEqual(s.gates.G0, { passed: '2026-11-01', by: 'owner' });
  assert.deepEqual(Object.keys(input.gates), ['G0']);
});

test('passGate enforces the gate order', () => {
  const s = fresh();
  assert.throws(() => passGate(s, 'G1', '2026-11-13'), /G0/);
  assert.throws(() => passGate(pass(s, 'G0', 'G1'), 'G2', '2026-11-13'), /G2-stack/);
  assert.throws(() => passGate(s, 'G9', '2026-11-13'), /Unknown gate/);
  assert.throws(() => passGate(s, 'G0', 'yesterday'), /date/i);
});

test('passGate records the date and the owner, returns a new state and moves the phase', () => {
  const s = fresh();
  const a = passGate(s, 'G0', '2026-11-13');
  assert.deepEqual(a.gates.G0, { passed: '2026-11-13', by: 'owner' });
  assert.equal(s.gates.G0, null);
  assert.equal(a.phase, 1);
  assert.equal(pass(s, 'G0', 'G1', 'G2-stack').phase, 2);
  assert.equal(pass(s, 'G0', 'G1', 'G2-stack', 'G2').phase, 3);
  assert.equal(pass(s, 'G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5').phase, 5);
  assert.equal(a.next_action, nextAction(a));
});

test('rerun safety: passing a gate twice keeps the first date', () => {
  const once = passGate(fresh(), 'G0', '2026-11-13');
  const twice = passGate(once, 'G0', '2026-12-25');
  assert.equal(twice.gates.G0.passed, '2026-11-13');
  assert.deepEqual(twice, once);
});

test('canStart: phase 0 is always open, later phases need the previous gates', () => {
  const s = fresh();
  assert.deepEqual(canStart(s, 0), { ok: true, missing: null });
  assert.deepEqual(canStart(s, 1), { ok: false, missing: 'G0' });
  assert.deepEqual(canStart(pass(s, 'G0'), 1), { ok: true, missing: null });
  assert.deepEqual(canStart(pass(s, 'G0', 'G1'), 2), { ok: true, missing: null });
  assert.deepEqual(canStart(pass(s, 'G0', 'G1'), 3), { ok: false, missing: 'G2-stack' });
  assert.deepEqual(canStart(pass(s, 'G0', 'G1', 'G2-stack'), 3), { ok: false, missing: 'G2' });
  assert.deepEqual(canStart(pass(s, 'G0', 'G1', 'G2-stack', 'G2'), 3), { ok: true, missing: null });
  assert.deepEqual(canStart(pass(s, 'G0', 'G1', 'G2-stack', 'G2', 'G3'), 5), { ok: false, missing: 'G4' });
  assert.throws(() => canStart(s, 6), /phase/i);
  assert.throws(() => canStart(s, 'x'), /phase/i);
});

test('canStart works on a legacy state', () => {
  assert.deepEqual(canStart({ gates: {} }, 3), { ok: false, missing: 'G0' });
});

test('nextAction after each gate', () => {
  const s = fresh();
  assert.equal(nextAction(s), 'Run /recade:new to finish the intake (G0 is open).');
  assert.equal(nextAction({ ...s, mode: 'adopt' }), 'Run /recade:adopt to finish the inventory (G0-inventory is open).');
  assert.equal(nextAction(pass(s, 'G0')), 'Run /recade:team (G0 passed on 2026-11-13).');
  assert.equal(nextAction(pass(s, 'G0', 'G1')), 'Run /recade:docs (G1 passed on 2026-11-13).');
  assert.equal(nextAction(pass(s, 'G0', 'G1', 'G2-stack')), 'Run /recade:docs to finish the documents (G2-stack passed on 2026-11-13).');
  assert.equal(nextAction(pass(s, 'G0', 'G1', 'G2-stack', 'G2')), 'Run /recade:bible (G2 passed on 2026-11-13).');
  assert.equal(nextAction(pass(s, 'G0', 'G1', 'G2-stack', 'G2', 'G3')), 'Run /recade:slices (G3 passed on 2026-11-13).');
  assert.equal(nextAction(pass(s, 'G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4')), 'Run /recade:harness (G4 passed on 2026-11-13).');
  assert.equal(nextAction(pass(s, 'G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5')), 'The project is set up. Run /status in the project (G5 passed on 2026-11-13).');
});

test('currentPhase is derived from the gates', () => {
  const s = fresh();
  assert.equal(currentPhase(s).id, 0);
  assert.equal(currentPhase(pass(s, 'G0', 'G1')).id, 2);
  assert.equal(currentPhase({ ...pass(s, 'G0', 'G1'), phase: 0 }).id, 2);
  assert.equal(currentPhase(pass(s, 'G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5')).id, 5);
});

test('setSetting validates slicing, second_opinion, hotspots and lots', () => {
  const s = fresh();
  assert.equal(setSetting(s, 'slicing', 'small').slicing, 'small');
  assert.equal(setSetting(s, 'second_opinion', 'off').second_opinion, 'off');
  assert.deepEqual(setSetting(s, 'hotspots', 'src/auth/**, src/ledger/**').hotspots, ['src/auth/**', 'src/ledger/**']);
  assert.deepEqual(setSetting(s, 'lots', 'BKL,OPS').lots, ['BKL', 'OPS']);
  assert.deepEqual(setSetting(s, 'lots', '').lots, []);
  assert.throws(() => setSetting(s, 'slicing', 'huge'), /mixed, small, large/);
  assert.throws(() => setSetting(s, 'second_opinion', 'x'), /always, sensitive, off/);
  assert.throws(() => setSetting(s, 'lots', 'bkl'), /Invalid lot/);
  assert.throws(() => setSetting(s, 'phase', '3'), /slicing, second_opinion, hotspots, lots, docs_step/);
  assert.equal(setSetting(s, 'docs_step', 'stack').docs_step, 'stack');
  assert.throws(() => setSetting(s, 'docs_step', 'later'), /Invalid docs_step/);
  assert.equal(s.slicing, 'mixed');
});

test('projectRoot finds the nearest recade/state.yaml going up', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-root-'));
  try {
    mkdirSync(join(root, 'recade'));
    writeFileSync(join(root, 'recade', 'state.yaml'), 'version: 1\n');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    assert.equal(projectRoot(join(root, 'a', 'b')), root);
    assert.equal(projectRoot(root), root);
    mkdirSync(join(root, 'a', 'recade'));
    writeFileSync(join(root, 'a', 'recade', 'state.yaml'), 'version: 1\n');
    assert.equal(projectRoot(join(root, 'a', 'b')), join(root, 'a'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('projectRoot returns null outside a project (injected exists)', () => {
  assert.equal(projectRoot('/x/y/z', { exists: () => false }), null);
  assert.equal(projectRoot('/x/y/z', { exists: (p) => p === '/x/recade/state.yaml' }), '/x');
});

// --- CLI ---

function makeIO(cwd, extra = {}) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {}, now: () => new Date(2026, 10, 13, 12), ...extra },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function project(legacy = true) {
  const root = mkdtempSync(join(tmpdir(), 'recade-state-'));
  const state = initState(root, { mode: 'scratch' }, CONFIG);
  saveState(root, legacy ? state : normalizeState(state));
  return root;
}
const read = (root) => readFileSync(join(root, 'recade', 'state.yaml'), 'utf8');

test('recade state show prints phase, gates, settings and next action', async () => {
  const root = project();
  try {
    const t = makeIO(root);
    assert.equal(await run(['state', 'show'], t.io), 0);
    const text = t.stdout();
    assert.match(text, /^Phase: 0 Intake$/m);
    assert.match(text, /^G0 +open$/m);
    assert.match(text, /^G2-stack +open$/m);
    assert.match(text, /^Next action: Run \/recade:new to finish the intake \(G0 is open\)\.$/m);
    assert.match(text, /^Slicing: mixed$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade state show --json prints the normalized state and the command availability', async () => {
  const root = project();
  try {
    const t = makeIO(join(root));
    assert.equal(await run(['state', 'show', '--json'], t.io), 0);
    const data = JSON.parse(t.stdout());
    assert.equal(data.phase, 0);
    assert.equal(data.phase_name, 'Intake');
    assert.equal(data.command, 'new');
    assert.equal(data.command_available, true);
    assert.equal(data.gates.G0, null);
    assert.equal(data.second_opinion, 'sensitive');
    assert.match(data.next_action, /^Run \/recade:new/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade state outside a project exits 1 with a hint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-none-'));
  try {
    const t = makeIO(dir, { env: {} });
    assert.equal(projectRoot(dir), null, 'the temp dir must have no recade/ ancestor');
    assert.equal(await run(['state', 'show'], t.io), 1);
    assert.match(t.stderr(), /No Recade project/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recade state show --json and show text use adopt for an adopt project at phase 0', async () => {
  const root = project();
  try {
    saveState(root, { ...initState(root, { mode: 'adopt' }, CONFIG), phase: 3 });
    let t = makeIO(root);
    assert.equal(await run(['state', 'show', '--json'], t.io), 0);
    const data = JSON.parse(t.stdout());
    assert.equal(data.command, 'adopt');
    assert.equal(data.command_available, true);
    assert.equal(data.phase, 0);
    assert.equal(data.phase_name, 'Inventory');
    assert.match(data.next_action, /^Run \/recade:adopt/);
    t = makeIO(root);
    await run(['state', 'show'], t.io);
    assert.match(t.stdout(), /^Command: \/recade:adopt$/m);
    assert.match(t.stdout(), /^G0-inventory +open$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade state show rejects extra arguments and a corrupt state.yaml', async () => {
  const root = project();
  try {
    let t = makeIO(root);
    assert.equal(await run(['state', 'show', 'x'], t.io), 2);
    assert.match(t.stderr(), /^Usage: recade state show/);
    writeFileSync(join(root, 'recade', 'state.yaml'), 'a: [unclosed\n');
    t = makeIO(root);
    assert.equal(await run(['state', 'show'], t.io), 2);
    assert.match(t.stderr(), /not valid YAML/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade state can-start exits 0, or 1 naming the missing gate', async () => {
  const root = project();
  try {
    let t = makeIO(root);
    assert.equal(await run(['state', 'can-start', '0'], t.io), 0);
    t = makeIO(root);
    assert.equal(await run(['state', 'can-start', '3'], t.io), 1);
    assert.match(t.stdout(), /^Cannot start phase 3 \(Bible\). Missing gate: G0\.$/m);
    t = makeIO(root);
    assert.equal(await run(['state', 'can-start', '9'], t.io), 2);
    t = makeIO(root);
    assert.equal(await run(['state', 'can-start'], t.io), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade state pass writes the gate with the date, in order, and is rerun safe', async () => {
  const root = project();
  try {
    let t = makeIO(root);
    assert.equal(await run(['state', 'pass', 'G1'], t.io), 1);
    assert.match(t.stderr(), /G0/);
    t = makeIO(root);
    assert.equal(await run(['state', 'pass', 'G0'], t.io), 0);
    assert.match(t.stdout(), /G0 passed on 2026-11-13/);
    assert.match(read(root), /passed: 2026-11-13/);
    assert.match(read(root), /phase: 1/);
    t = makeIO(root, { now: () => new Date(2027, 0, 5, 12) });
    assert.equal(await run(['state', 'pass', 'G0'], t.io), 0);
    assert.match(read(root), /passed: 2026-11-13/);
    assert.equal(read(root).includes('2027'), false);
    t = makeIO(root);
    assert.equal(await run(['state', 'pass', 'G42'], t.io), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade state set writes validated settings and rejects the rest', async () => {
  const root = project();
  try {
    let t = makeIO(root);
    assert.equal(await run(['state', 'set', 'slicing', 'small'], t.io), 0);
    assert.match(read(root), /slicing: small/);
    t = makeIO(root);
    assert.equal(await run(['state', 'set', 'lots', 'BKL,OPS'], t.io), 0);
    assert.match(read(root), /- BKL/);
    t = makeIO(root);
    assert.equal(await run(['state', 'set', 'hotspots', 'src/auth/**'], t.io), 0);
    t = makeIO(root);
    assert.equal(await run(['state', 'set', 'second_opinion', 'always'], t.io), 0);
    assert.match(read(root), /second_opinion: always/);
    t = makeIO(root);
    assert.equal(await run(['state', 'set', 'slicing', 'huge'], t.io), 2);
    t = makeIO(root);
    assert.equal(await run(['state', 'set', 'phase', '3'], t.io), 2);
    t = makeIO(root);
    assert.equal(await run(['state', 'set', 'slicing'], t.io), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade state set docs_step records the next documents step, show prints it, a bad step exits 2', async () => {
  const root = project();
  try {
    let t = makeIO(root);
    assert.equal(await run(['state', 'show'], t.io), 0);
    assert.doesNotMatch(t.stdout(), /Docs step/);
    t = makeIO(root);
    assert.equal(await run(['state', 'set', 'docs_step', 'direction'], t.io), 0);
    assert.match(read(root), /docs_step: direction/);
    t = makeIO(root);
    assert.equal(await run(['state', 'show'], t.io), 0);
    assert.match(t.stdout(), /^Docs step: direction$/m);
    t = makeIO(root);
    assert.equal(await run(['state', 'show', '--json'], t.io), 0);
    assert.equal(JSON.parse(t.stdout()).docs_step, 'direction');
    t = makeIO(root);
    assert.equal(await run(['state', 'set', 'docs_step', 'd4'], t.io), 2);
    assert.match(t.stderr(), /d1, direction, stack, d2, d3, plan, gate, done/);
    t = makeIO(root);
    assert.equal(await run(['state', 'set', 'docs_step', 'd2'], t.io), 0);
    assert.match(read(root), /docs_step: d2/);
    assert.doesNotMatch(read(root), /docs_step: direction/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade state with an unknown subcommand exits 2 with the usage', async () => {
  const t = makeIO(process.cwd());
  assert.equal(await run(['state', 'nope'], t.io), 2);
  assert.match(t.stderr(), /^Usage: recade state show/);
});

test('resetFrom empties the gate and every later gate, and brings phase and next action up to date', () => {
  const all = pass(fresh(), ...GATES);
  const s = resetFrom(all, 'G3');
  assert.deepEqual(Object.keys(s.gates), [...GATES]);
  for (const g of ['G0', 'G1', 'G2-stack', 'G2']) assert.deepEqual(s.gates[g], { passed: '2026-11-13', by: 'owner' });
  for (const g of ['G3', 'G4', 'G5']) assert.equal(s.gates[g], null);
  assert.equal(s.phase, 3);
  assert.match(s.next_action, /^Run \/recade:bible/);
  assert.notEqual(s, all);
  assert.deepEqual(all.gates.G5, { passed: '2026-11-13', by: 'owner' });
  const stack = resetFrom(all, 'G2-stack');
  assert.equal(stack.gates.G1.by, 'owner');
  assert.equal(stack.gates['G2-stack'], null);
  assert.equal(stack.gates.G2, null);
  assert.equal(stack.phase, 2);
  assert.equal(resetFrom(fresh(), 'G4').gates.G0, null);
  assert.throws(() => resetFrom(all, 'G9'), /Unknown gate: G9/);
});

test('recade state reset-from sets the gate and the later ones to null', async () => {
  const root = project(false);
  try {
    saveState(root, pass(normalizeState(JSON.parse(JSON.stringify(initState(root, { mode: 'scratch' }, CONFIG)))), 'G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4'));
    let t = makeIO(root);
    assert.equal(await run(['state', 'reset-from', 'G3'], t.io), 0);
    assert.match(t.stdout(), /^G3 and every later gate reset\. Run \/recade:bible/);
    assert.match(read(root), /G2:\n {4}passed: 2026-11-13/);
    assert.match(read(root), /G3: null/);
    assert.match(read(root), /G4: null/);
    t = makeIO(root);
    assert.equal(await run(['state', 'show', '--json'], t.io), 0);
    assert.equal(JSON.parse(t.stdout()).phase, 3);
    for (const args of [['reset-from'], ['reset-from', 'G9'], ['reset-from', 'G3', 'G4']]) {
      t = makeIO(root);
      assert.equal(await run(['state', ...args], t.io), 2, args.join(' '));
      assert.match(t.stderr(), /reset-from <gate>/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- plan 5b Task 4: a code repository never falls back to the workspace around it (Task 1 review N2) ---------- */

const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

function linkedWorkspace() {
  const ws = join(realpathSync(mkdtempSync(join(tmpdir(), 'recade-n2-'))), 'fern-workspace');
  mkdirSync(join(ws, 'recade'), { recursive: true });
  writeFileSync(join(ws, 'recade', 'state.yaml'), 'version: 1\nkind: workspace\nrepos:\n  - name: api\n    path: repos/api\n');
  gitIn(ws, 'init', '-q', '-b', 'main');
  const api = join(ws, 'repos', 'api');
  mkdirSync(join(api, 'src'), { recursive: true });
  gitIn(api, 'init', '-q', '-b', 'main');
  return { ws, api };
}

test('projectRoot fails closed in a code repository whose link is missing, stale or points elsewhere', () => {
  const { ws, api } = linkedWorkspace();
  const fails = (dir, reason) => assert.throws(() => projectRoot(dir), (err) => {
    assert.equal(err.code, 'RECADE_LINK');
    assert.match(err.message, new RegExp(reason));
    assert.match(err.message, /recade repo sync/);
    return true;
  });
  fails(api, 'link missing');
  fails(join(api, 'src'), 'link missing');
  linkRepo(ws, api);
  assert.equal(projectRoot(join(api, 'src')), ws);
  assert.equal(projectRoot(join(ws, 'recade')), ws);
  const other = linkedWorkspace();
  writeFileSync(join(api, '.recade', 'workspace'), `${other.ws}\n`);
  fails(api, 'link points elsewhere');
  writeFileSync(join(api, '.recade', 'workspace'), `${join(ws, '..', 'gone-workspace')}\n`);
  fails(api, 'workspace moved');
  // A plain git repository that holds its own legacy project still finds it.
  const legacy = mkdtempSync(join(tmpdir(), 'recade-legacy-'));
  gitIn(legacy, 'init', '-q');
  mkdirSync(join(legacy, 'recade'));
  writeFileSync(join(legacy, 'recade', 'state.yaml'), 'version: 1\n');
  assert.equal(projectRoot(legacy), legacy);
});

test('recade commands from a code repository with a bad link exit 1 and name recade repo sync', async () => {
  const { ws, api } = linkedWorkspace();
  const missing = makeIO(api);
  assert.equal(await run(['state', 'show'], missing.io), 1);
  assert.match(missing.stderr(), /link missing.*recade repo sync/s);
  const other = linkedWorkspace();
  linkRepo(ws, api);
  writeFileSync(join(api, '.recade', 'workspace'), `${other.ws}\n`);
  for (const argv of [['workspace', 'root'], ['repo', 'list'], ['state', 'show']]) {
    const t = makeIO(api);
    assert.equal(await run(argv, t.io), 1, argv.join(' '));
    assert.match(t.stderr(), /link points elsewhere.*recade repo sync/s, argv.join(' '));
    assert.equal(t.stdout(), '', argv.join(' '));
  }
  linkRepo(ws, api);
  const good = makeIO(api);
  assert.equal(await run(['workspace', 'root'], good.io), 0);
  assert.equal(good.stdout(), `${ws}\n`);
});

test('projectRoot fails closed in a worktree of a moved workspace (Task 1 review N3)', () => {
  const { ws, api } = linkedWorkspace();
  writeFileSync(join(api, 'README.md'), 'api\n');
  gitIn(api, 'add', '.');
  gitIn(api, 'commit', '-q', '-m', 'chore: start');
  linkRepo(ws, api);
  gitIn(api, 'worktree', 'add', '-q', '-b', 'slice/S-01-x', join(api, '.claude', 'worktrees', 'S-01'), 'main');
  renameSync(ws, `${ws}-moved`);
  const stale = join(`${ws}-moved`, 'repos', 'api', '.claude', 'worktrees', 'S-01');
  assert.throws(() => projectRoot(stale), (err) => err.code === 'RECADE_LINK' && /recade repo sync/.test(err.message));
});
