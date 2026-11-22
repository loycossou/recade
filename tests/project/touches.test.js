import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseTouch, touchesOverlap, reposOf, registryNames, touchProblems, touchRepo } from '../../src/project/touches.js';
import { checkSlices, renderStatus } from '../../src/project/slices.js';
import { explainParallel, planParallel } from '../../src/harness/parallel.js';

const two = ['api', 'web'];

test('parseTouch: the prefix is the text before the first colon when it is a repository name', () => {
  assert.deepEqual(parseTouch('api:src/**'), { repo: 'api', glob: 'src/**' });
  assert.deepEqual(parseTouch('  web-app:src/a:b '), { repo: 'web-app', glob: 'src/a:b' });
  assert.deepEqual(parseTouch('src/**'), { repo: null, glob: 'src/**' });
  assert.deepEqual(parseTouch('Api:src'), { repo: null, glob: 'Api:src' }, 'a prefix is lower-case kebab');
  assert.deepEqual(parseTouch('src/a:b/**'), { repo: null, glob: 'src/a:b/**' }, 'a slash before the colon is not a prefix');
  assert.deepEqual(parseTouch('{a,b}:x'), { repo: null, glob: '{a,b}:x' });
});

test('touchesOverlap: different repositories never overlap, the same one compares the globs', () => {
  assert.equal(touchesOverlap('api:src/**', 'web:src/**', two), false);
  assert.equal(touchesOverlap('api:src/a/**', 'api:src/**', two), true);
  assert.equal(touchesOverlap('api:src/a/**', 'api:src/b/**', two), false);
});

test('touchesOverlap: with one repository an unprefixed glob belongs to it', () => {
  assert.equal(touchesOverlap('src/**', 'api:src/**', ['api']), true);
  assert.equal(touchesOverlap('src/a/**', 'api:src/b/**', ['api']), false);
  assert.equal(touchesOverlap('src/**', 'src/a/**', ['api']), true);
});

test('touchesOverlap: without a registry two unprefixed globs compare as before', () => {
  assert.equal(touchesOverlap('src/**', 'src/a/**'), true);
  assert.equal(touchesOverlap('src/a', 'src/b'), false);
});

test('touchesOverlap: an unprefixed glob among several repositories is an error elsewhere, here it is cautious', () => {
  assert.equal(touchesOverlap('src/**', 'web:src/a/**', two), true);
  assert.equal(touchesOverlap('lib/**', 'web:src/a/**', two), false);
});

test('reposOf lists the repositories in order of first appearance, once each', () => {
  assert.deepEqual(reposOf(['web:src/**', 'api:src/**', 'web:docs/**']), ['web', 'api']);
  assert.deepEqual(reposOf(['src/**']), []);
  assert.deepEqual(reposOf(['src/**', 'docs/**'], ['api']), ['api'], 'one repository takes the unprefixed globs');
  assert.deepEqual(reposOf([]), []);
});

test('registryNames reads the names of the registry, and ignores anything else', () => {
  assert.deepEqual(registryNames({ repos: [{ name: 'api' }, { name: 'web' }, { path: 'x' }, null] }), ['api', 'web']);
  assert.deepEqual(registryNames({}), []);
  assert.deepEqual(registryNames(null), []);
});

// ---- checkSlices and planParallel on a real folder ----

function sheet(id, front = {}) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['api'], branch: `slice/${id.toLowerCase()}`, format: 'small', lane: 'standard',
    implementer: 'implementer', increment: 'INC-1', depends_on: [], blocks: [], external_prerequisite: 'none',
    provisionals_used: [], size: 'M', touches: [`api:src/${id.toLowerCase()}/**`], ...front,
  };
  return `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n`;
}

function project({ slices, repos = two, hotspots = [], statuses = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'recade-touches-'));
  mkdirSync(join(root, 'recade'));
  mkdirSync(join(root, 'slices'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({
    version: 1, kind: 'workspace', mode: 'scratch', hotspots, repos: repos.map((name) => ({ name, path: `repos/${name}` })),
  }));
  for (const [name, front] of Object.entries(slices)) writeFileSync(join(root, 'slices', name), sheet(name.slice(0, 4), front));
  const rows = checkSlices(root).status;
  for (const r of rows) r.status = statuses[r.id] ?? 'todo';
  writeFileSync(join(root, 'slices', 'STATUS.md'), renderStatus(rows));
  return root;
}

const byRule = (result, rule) => result.findings.filter((f) => f.rule === rule);

test('checkSlices: touch-prefix fires for an unprefixed glob once the registry has two repositories', () => {
  const root = project({ slices: { 'S-01-a.md': { touches: ['api:src/a/**', 'src/b/**'] } } });
  const found = byRule(checkSlices(root), 'touch-prefix');
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'slices/S-01-a.md');
  assert.equal(found[0].severity, 'error');
  assert.match(found[0].message, /src\/b\/\*\*/);
  assert.match(found[0].message, /api, web/);
});

test('checkSlices: with one repository the prefix is optional', () => {
  const root = project({ repos: ['api'], slices: { 'S-01-a.md': { touches: ['src/a/**'] }, 'S-02-b.md': { touches: ['api:src/b/**'] } } });
  const r = checkSlices(root);
  assert.equal(byRule(r, 'touch-prefix').length, 0);
  assert.equal(byRule(r, 'touch-repo').length, 0);
});

test('checkSlices: touch-repo fires for a prefix that is not in the registry, and names the registry', () => {
  const root = project({ slices: { 'S-01-a.md': { touches: ['mobile:src/**'] } } });
  const found = byRule(checkSlices(root), 'touch-repo');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /mobile/);
  assert.match(found[0].message, /api, web/);
});

test('checkSlices: the workspace prefix is refused in touches, it belongs to an agent Writes', () => {
  const root = project({ slices: { 'S-01-a.md': { touches: ['workspace:docs/**'] } } });
  const found = byRule(checkSlices(root), 'touch-repo');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /workspace/);
  assert.match(found[0].message, /Writes/);
});

test('checkSlices: no rule fires on a project whose registry is empty and whose globs have no prefix', () => {
  const root = project({ repos: [], slices: { 'S-01-a.md': { touches: ['src/a/**'] } } });
  const r = checkSlices(root);
  assert.equal(byRule(r, 'touch-prefix').length + byRule(r, 'touch-repo').length, 0);
});

test('checkSlices: slice-overlap compares repository by repository', () => {
  const root = project({ slices: {
    'S-01-a.md': { touches: ['api:src/**'] },
    'S-02-b.md': { touches: ['web:src/**'] },
    'S-03-c.md': { touches: ['api:src/orders/**'] },
  } });
  const overlaps = byRule(checkSlices(root), 'slice-overlap');
  assert.equal(overlaps.length, 1, 'S-01 and S-03 overlap in api, S-02 is in web');
  assert.match(overlaps[0].message, /S-01 and S-03/);
});

test('checkSlices: a hotspot in a repository warns only the slices of that repository', () => {
  const root = project({ hotspots: ['api:src/routes.ts'], slices: {
    'S-01-a.md': { touches: ['api:src/**'] },
    'S-02-b.md': { touches: ['web:src/**'] },
  } });
  const hot = byRule(checkSlices(root), 'slice-hotspot');
  assert.deepEqual(hot.map((f) => f.file), ['slices/S-01-a.md']);
});

test('planParallel: a hotspot api:src/routes.ts chains two slices that both touch it', () => {
  const root = project({ hotspots: ['api:src/routes.ts'], slices: {
    'S-01-a.md': { size: 'S', touches: ['api:src/routes.ts', 'api:src/a/**'] },
    'S-02-b.md': { size: 'M', touches: ['api:src/routes.ts', 'api:src/b/**'] },
  } });
  const { picked, deferred } = explainParallel(root, {});
  assert.deepEqual(picked.map((p) => p.slice), ['S-01']);
  assert.deepEqual(deferred.map((d) => d.slice), ['S-02']);
});

test('planParallel: two slices in different repositories run together even on the same folder names', () => {
  const root = project({ slices: {
    'S-01-a.md': { touches: ['api:src/**'] },
    'S-02-b.md': { touches: ['web:src/**'] },
  } });
  assert.deepEqual(planParallel(root, {}).map((p) => p.slice), ['S-01', 'S-02']);
});

test('planParallel: a slice that touches api and web gets two worktrees on the same branch', () => {
  const root = project({ slices: {
    'S-03-both.md': { branch: 'slice/s-03-both', touches: ['web:src/pages/**', 'api:src/routes/**', 'web:src/lib/**'] },
  } });
  const [pick] = planParallel(root, {});
  assert.deepEqual(pick.worktrees, [
    { repo: 'web', path: 'worktrees/web/S-03', branch: 'slice/s-03-both' },
    { repo: 'api', path: 'worktrees/api/S-03', branch: 'slice/s-03-both' },
  ]);
});

test('planParallel: with one repository an unprefixed slice gets one worktree in it; without a registry none', () => {
  const one = project({ repos: ['api'], slices: { 'S-01-a.md': { touches: ['src/a/**'] } } });
  assert.deepEqual(planParallel(one, {})[0].worktrees.map((w) => w.path), ['worktrees/api/S-01']);
  const none = project({ repos: [], slices: { 'S-01-a.md': { touches: ['src/a/**'] } } });
  assert.deepEqual(planParallel(none, {})[0].worktrees, []);
});

test('planParallel: a slice with no branch in its header gets slice/<id> in lower case', () => {
  const root = project({ slices: { 'S-04-x.md': { branch: undefined, touches: ['api:src/x/**'] } } });
  assert.equal(planParallel(root, {})[0].worktrees[0].branch, 'slice/s-04');
});

// ---- fix round 1 ----

test('touchProblems: unknown prefix, workspace prefix, empty glob and missing prefix, in one list', () => {
  const found = touchProblems(['workspace:docs/**', 'mobile:x', 'api:', 'api:   ', 'src/a/**', 'api:src/**', 'c:/x'], two);
  assert.deepEqual(found.map((f) => `${f.rule}:${f.touch}`), [
    'touch-repo:workspace:docs/**', 'touch-repo:mobile:x', 'touch-empty:api:', 'touch-empty:api:   ', 'touch-prefix:src/a/**', 'touch-repo:c:/x',
  ]);
  assert.deepEqual(touchProblems(['src/a/**'], ['api']), []);
  assert.deepEqual(touchProblems(['src/a/**'], []), []);
});

test('touchesOverlap: an empty glob after a prefix covers the whole repository', () => {
  assert.equal(touchesOverlap('api:', 'api:src/**', two), true);
  assert.equal(touchesOverlap('api:', 'web:src/**', two), false);
});

test('touchRepo: the prefix, else the only repository, else null', () => {
  assert.equal(touchRepo('web:src/x', two), 'web');
  assert.equal(touchRepo('src/x', ['api']), 'api');
  assert.equal(touchRepo('src/x', two), null);
});

test('checkSlices: an empty glob after a prefix is touch-empty, and nothing else about it', () => {
  const root = project({ slices: { 'S-01-a.md': { touches: ['api:', 'web:   '] } } });
  const found = byRule(checkSlices(root), 'touch-empty');
  assert.equal(found.length, 2);
  assert.match(found[0].message, /needs a glob/);
});

test('checkSlices: c:/x is read as the prefix c, which is not a repository, so it is refused', () => {
  const root = project({ slices: { 'S-01-a.md': { touches: ['c:/x'] } } });
  const found = byRule(checkSlices(root), 'touch-repo');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /"c"/);
});

test('planParallel: a slice with an unknown prefix or workspace: is deferred with its reason and has no worktree', () => {
  const root = project({ slices: {
    'S-01-a.md': { touches: ['workspace:docs/**', 'mobile:x', 'api:src/a/**'] },
    'S-02-b.md': { touches: ['web:src/**'] },
  } });
  const { picked, deferred } = explainParallel(root, {});
  assert.deepEqual(picked.map((p) => p.slice), ['S-02']);
  assert.deepEqual(deferred.map((d) => d.slice), ['S-01']);
  assert.match(deferred[0].reason, /touch-repo|workspace|mobile/);
  assert.match(deferred[0].reason, /touches/);
  assert.deepEqual(picked[0].worktrees.map((w) => w.repo), ['web']);
});

test('planParallel: an empty glob after a prefix defers the slice', () => {
  const root = project({ slices: { 'S-01-a.md': { touches: ['api:'] }, 'S-02-b.md': { touches: ['api:src/**'] } } });
  const { picked, deferred } = explainParallel(root, {});
  assert.deepEqual(picked.map((p) => p.slice), ['S-02']);
  assert.match(deferred[0].reason, /needs a glob/);
});

test('planParallel: a registry-less project with a prefixed touch defers it, it never gets repos/<name> worktrees', () => {
  const root = project({ repos: [], slices: { 'S-01-a.md': { touches: ['api:src/**'] } } });
  const { picked, deferred } = explainParallel(root, {});
  assert.deepEqual(picked, []);
  assert.deepEqual(deferred.map((d) => d.slice), ['S-01']);
});

test('planParallel: an api hotspot and a web hotspot do not serialize, two api hotspots do', () => {
  const hotspots = ['api:src/routes.ts', 'api:src/menu.ts', 'web:src/routes.ts'];
  const root = project({ hotspots, slices: {
    'S-01-a.md': { size: 'S', touches: ['api:src/routes.ts'] },
    'S-02-b.md': { size: 'S', touches: ['web:src/routes.ts'] },
    'S-03-c.md': { size: 'M', touches: ['api:src/menu.ts'] },
  } });
  const { picked, deferred } = explainParallel(root, {});
  assert.deepEqual(picked.map((p) => p.slice), ['S-01', 'S-02']);
  assert.deepEqual(deferred.map((d) => d.slice), ['S-03']);
  assert.match(deferred[0].reason, /S-01/);
});

test('planParallel: a slice under way on an api hotspot does not block a web hotspot slice', () => {
  const hotspots = ['api:src/routes.ts', 'web:src/routes.ts'];
  const root = project({ hotspots, statuses: { 'S-01': 'implementation' }, slices: {
    'S-01-a.md': { touches: ['api:src/routes.ts'] },
    'S-02-b.md': { touches: ['web:src/routes.ts'] },
    'S-03-c.md': { touches: ['api:src/menu.ts', 'api:src/routes.ts'] },
  } });
  const { picked, deferred } = explainParallel(root, {});
  assert.deepEqual(picked.map((p) => p.slice), ['S-02']);
  assert.deepEqual(deferred.map((d) => d.slice), ['S-03']);
});

test('checkSlices: hotspot prefixes are validated like touches, in recade/state.yaml', () => {
  const root = project({ hotspots: ['apii:src/routes.ts', 'src/menu.ts', 'api:', 'web:src/routes.ts'], slices: { 'S-01-a.md': { touches: ['api:src/a/**'] } } });
  const found = checkSlices(root).findings.filter((f) => f.file === 'recade/state.yaml');
  assert.deepEqual(found.map((f) => f.rule), ['touch-repo', 'touch-prefix', 'touch-empty']);
  assert.equal(found.every((f) => f.severity === 'error' && f.line >= 1), true);
  assert.match(found[0].message, /apii/);
  assert.match(found[0].message, /hotspot/i);
});
