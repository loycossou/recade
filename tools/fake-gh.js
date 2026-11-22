import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * A fake `gh` for the end-to-end driver. It keeps a small GitHub in memory (its repositories, one Projects v2 board,
 * the issues of each repository, the pull requests of each code repository) and records every call, so a run can show
 * what Recade would have asked GitHub to do without ever reaching it. The `git` commands that would leave the machine
 * (push, ls-remote, fetch, pull, clone) are answered here too and recorded with the folder they ran in; every other
 * `git` command is real, because the example repositories are real local ones. A clone of a URL listed in `remotes`
 * is a real clone of the local folder it maps to, and keeps the URL as its `origin`.
 *
 * Two runners share one state: `exec(cmd, args, timeout)` is the asynchronous one of `io.exec`, `run(argv, {cwd})` is
 * the synchronous one of `io.run` (the commit and push calls, the board, the harness install).
 */

const ok = (data) => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
const fail = (stderr) => ({ code: 1, stdout: '', stderr });
const flag = (args, name) => args[args.indexOf(name) + 1];

/** The `git` subcommands that touch a remote. The fake answers them and the base runner never sees them. */
const NETWORK_GIT = new Set(['push', 'ls-remote', 'fetch', 'pull', 'clone']);

/** The subcommand of a `git -C <dir> <sub> ...` call. */
const gitSub = (args) => (args[0] === '-C' ? args[2] : args[0]);

/** A real local git command, synchronous, in `cwd`. */
const localGit = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** `acme/api` of `https://github.com/acme/api.git`, or null. */
const repoOfUrl = (url) => /github\.com[:/](.+?)(?:\.git)?$/.exec(String(url).trim())?.[1] ?? null;

/**
 * @param {{
 *   base: (cmd: string, args: string[], timeout?: number) => Promise<{code: number, stdout?: string, stderr?: string}>,
 *   existing?: {repo: string, visibility?: string, projects?: object[], fields?: object[], issues?: object[]},
 *   remotes?: Record<string, string>,
 * }} options `base` runs the local `git` commands of `exec`. `existing` is a repository that GitHub already holds, with its
 *   boards and open issues (the adopted project; an issue says which repository it is in with `repo`, by default the
 *   existing one); without it GitHub is empty and the first `repo create` makes the repository. `remotes` maps a remote
 *   URL to a local folder: a clone of that URL is a real local clone from the folder.
 */
export function createFakeGh({ base, existing = null, remotes = {} }) {
  const gh = {
    calls: [],
    gitRefused: [],
    /** The remote git calls the fake answered, with the folder they ran in: `{sub, cwd, args}`. Nothing went further. */
    network: [],
    repos: new Map(existing === null ? [] : [[existing.repo, existing.visibility ?? 'PRIVATE']]),
    projects: [...(existing?.projects ?? [])],
    fields: [...(existing?.fields ?? [])],
    issues: (existing?.issues ?? []).map((i) => ({ repo: existing.repo, state: 'OPEN', ...i })),
    items: [],
    /** The labels: `{repo, name}`. */
    labels: [],
    /** The pull requests: `{repo (folder name), full, number, branch, base, state, sha}`. */
    prs: [],
    nextId: 100,
  };

  /** The `owner/name` of the code repository in `cwd`, from its origin. */
  const fullOf = (cwd) => repoOfUrl(localGit(cwd, ['remote', 'get-url', 'origin']).stdout) ?? basename(cwd);

  const handle = (args, cwd) => {
    const [a, b] = args;
    if (a === 'repo' && b === 'view') {
      const name = args[2];
      return gh.repos.has(name)
        ? ok({ name: name.split('/')[1], visibility: gh.repos.get(name) })
        : fail(`GraphQL: Could not resolve to a Repository with the name '${name}'. (repository)`);
    }
    if (a === 'repo' && b === 'create') {
      gh.repos.set(args[2], 'PRIVATE');
      const source = flag(args, '--source');
      if (source !== undefined) localGit(source, ['remote', 'add', 'origin', `https://github.com/${args[2]}.git`]);
      return ok(`https://github.com/${args[2]}\n`);
    }
    if (a === 'project' && b === 'list') return ok({ projects: gh.projects, totalCount: gh.projects.length });
    if (a === 'project' && b === 'view') {
      const p = gh.projects.find((x) => String(x.number) === args[2]);
      return p ? ok(p) : fail(`GraphQL: Could not resolve to a ProjectV2 with the number ${args[2]}.`);
    }
    if (a === 'project' && b === 'create') {
      const p = { number: gh.projects.length + 1, id: `PVT_${gh.nextId++}`, title: flag(args, '--title'), closed: false };
      gh.projects.push(p);
      if (gh.fields.length === 0) {
        gh.fields.push({ id: 'F_status', name: 'Status', type: 'ProjectV2SingleSelectField', options: ['Todo', 'In Progress', 'Done'].map((n, i) => ({ id: `O_${i}`, name: n })) });
      }
      return ok(p);
    }
    if (a === 'project' && b === 'field-list') return ok({ fields: gh.fields, totalCount: gh.fields.length });
    if (a === 'project' && b === 'field-create') {
      const type = flag(args, '--data-type');
      const f = { id: `F_${gh.nextId++}`, name: flag(args, '--name'), type: type === 'SINGLE_SELECT' ? 'ProjectV2SingleSelectField' : 'ProjectV2Field' };
      if (type === 'SINGLE_SELECT') f.options = flag(args, '--single-select-options').split(',').map((n) => ({ id: `O_${gh.nextId++}`, name: n }));
      gh.fields.push(f);
      return ok(f);
    }
    if (a === 'api' && b === 'graphql') {
      const query = args.find((x) => x.startsWith('query='));
      if (query.includes('createProjectV2Field')) {
        gh.fields.push({ id: `F_${gh.nextId++}`, name: 'Sprint', type: 'ProjectV2IterationField' });
      } else {
        const status = gh.fields.find((f) => f.name === 'Status');
        status.options = ['Backlog', ...status.options.map((o) => o.name)].map((n) => ({ id: `O_${gh.nextId++}`, name: n }));
      }
      return ok({ data: {} });
    }
    if (a === 'issue' && b === 'list') {
      const repo = args.includes('--repo') ? flag(args, '--repo') : null;
      const state = args.includes('--state') ? flag(args, '--state') : 'open';
      return ok(gh.issues.filter((i) => (repo === null || i.repo === repo) && (state === 'all' || i.state === state.toUpperCase())));
    }
    if (a === 'issue' && b === 'create') {
      const repo = flag(args, '--repo');
      const number = gh.issues.filter((i) => i.repo === repo).reduce((m, i) => Math.max(m, i.number), 0) + 1;
      const labels = args.includes('--label') ? [{ name: flag(args, '--label') }] : [];
      const issue = { repo, number, title: flag(args, '--title'), body: flag(args, '--body') ?? '', url: `https://github.com/${repo}/issues/${number}`, labels, state: 'OPEN' };
      gh.issues.push(issue);
      return ok(`${issue.url}\n`);
    }
    if (a === 'issue' && ['view', 'close', 'comment', 'edit', 'reopen'].includes(b)) {
      const target = args[2];
      const repo = args.includes('--repo') ? flag(args, '--repo') : null;
      const issue = gh.issues.find((i) => (/^\d+$/.test(target) ? i.repo === repo && String(i.number) === target : i.url === target));
      if (issue === undefined) return fail(`could not resolve to an issue: ${target}`);
      if (b === 'close') issue.state = 'CLOSED';
      if (b === 'reopen') issue.state = 'OPEN';
      if (b === 'comment') (issue.comments ??= []).push(flag(args, '--body'));
      if (b === 'edit') {
        if (args.includes('--title')) issue.title = flag(args, '--title');
        if (args.includes('--body')) issue.body = flag(args, '--body');
      }
      return ok(b === 'view' ? { number: issue.number, state: issue.state } : '');
    }
    if (a === 'label' && b === 'list') {
      const repo = flag(args, '--repo');
      return ok(gh.labels.filter((l) => l.repo === repo).map((l) => ({ name: l.name })));
    }
    if (a === 'label' && b === 'create') {
      gh.labels.push({ repo: flag(args, '--repo'), name: args[2] });
      return ok('');
    }
    if (a === 'api' && b !== 'graphql') {
      // The REST calls of the epics: the numeric id of an issue (`--jq .id`), the sub-issues of an issue, and a new sub-issue.
      // GitHub keeps one parent for each issue, and moves it only with `replace_parent`.
      const method = args.includes('--method') ? flag(args, '--method') : 'GET';
      const path = args.find((x) => x.startsWith('repos/')) ?? '';
      const m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/sub_issues)?(?:\?.*)?$/.exec(path);
      if (m === null) return fail(`unexpected gh api call: ${args.join(' ')}`);
      const issue = gh.issues.find((i) => i.repo === m[1] && String(i.number) === m[2]);
      if (issue === undefined) return fail('gh: Not Found (HTTP 404)');
      issue.id ??= gh.nextId++;
      if (m[3] === undefined) return ok(`${issue.id}\n`);
      if (method === 'GET') return ok(gh.issues.filter((i) => i.parent === issue.url).map((i) => ({ id: i.id, number: i.number, html_url: i.url, title: i.title })));
      const id = Number(args.find((x) => x.startsWith('sub_issue_id=')).split('=')[1]);
      const sub = gh.issues.find((i) => i.id === id);
      if (sub === undefined) return fail('gh: Not Found (HTTP 404)');
      if (sub.parent !== undefined && !args.includes('replace_parent=true')) return fail('gh: Validation Failed (HTTP 422)');
      sub.parent = issue.url;
      return ok({ id: issue.id, number: issue.number });
    }
    if (a === 'project' && b === 'item-list') return ok({ items: gh.items, totalCount: gh.items.length });
    if (a === 'project' && b === 'item-add') {
      const url = flag(args, '--url');
      const issue = gh.issues.find((i) => i.url === url);
      if (issue === undefined) return fail(`could not resolve ${url}`);
      const item = { id: `PVTI_${gh.nextId++}`, title: issue.title, content: { url, number: issue.number, type: 'Issue', title: issue.title } };
      gh.items.push(item);
      return ok(item);
    }
    if (a === 'project' && b === 'item-edit') {
      const item = gh.items.find((i) => i.id === flag(args, '--id'));
      const field = gh.fields.find((f) => f.id === flag(args, '--field-id'));
      if (item === undefined || field === undefined) return fail('item or field not found');
      const optionId = args.includes('--single-select-option-id') ? flag(args, '--single-select-option-id') : null;
      item[field.name.toLowerCase()] = optionId === null
        ? (args.includes('--number') ? Number(flag(args, '--number')) : flag(args, '--text') ?? flag(args, '--date'))
        : field.options.find((o) => o.id === optionId).name;
      return ok({});
    }
    // Pull requests are those of the code repository folder the command runs in (`cwd`), told apart by its name.
    if (a === 'pr' && b === 'create') {
      if (cwd === undefined) return fail('gh pr create needs the folder of a code repository');
      const repo = basename(cwd);
      const branch = flag(args, '--head');
      const base = flag(args, '--base') ?? 'main';
      if (gh.prs.some((p) => p.repo === repo && p.branch === branch && p.state === 'OPEN')) return fail(`a pull request for branch "${branch}" already exists`);
      const number = gh.prs.filter((p) => p.repo === repo).length + 1;
      const pr = { repo, full: fullOf(cwd), number, branch, base, body: flag(args, '--body') ?? '', state: 'OPEN', sha: localGit(cwd, ['rev-parse', branch]).stdout.trim() };
      gh.prs.push(pr);
      return ok(`https://github.com/${pr.full}/pull/${number}\n`);
    }
    if (a === 'pr' && b === 'view') {
      const repo = cwd === undefined ? null : basename(cwd);
      const pr = gh.prs.filter((p) => p.repo === repo && p.branch === args[2]).at(-1);
      if (pr === undefined) return fail(`no pull requests found for branch "${args[2]}"`);
      const merged = pr.state === 'MERGED';
      return ok({
        number: pr.number, state: pr.state, mergedAt: merged ? '2026-11-18T12:00:00Z' : null, url: `https://github.com/${pr.full}/pull/${pr.number}`,
        mergeCommit: merged ? { oid: pr.sha } : null, headRefOid: pr.sha, baseRefName: pr.base, isDraft: false,
        reviewDecision: 'APPROVED', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      });
    }
    return fail(`unexpected gh call: ${args.join(' ')}`);
  };

  /** The answer to a `git` call that would leave the machine, and the trace of it. `args` are as given, `cwd` the folder. */
  const network = (args, cwd) => {
    const dashC = args[0] === '-C';
    const dir = dashC ? args[1] : cwd;
    const sub = gitSub(args);
    gh.gitRefused.push(sub);
    gh.network.push({ sub, cwd: dir, args });
    if (sub === 'ls-remote') {
      const url = localGit(dir, ['remote', 'get-url', 'origin']).stdout.trim();
      const name = repoOfUrl(url);
      return ok(name !== null && gh.repos.has(name) ? 'abc123\trefs/heads/main\n' : '');
    }
    return ok('');
  };

  /** A clone of a mapped URL is a real clone from the local folder; the clone keeps the URL as its origin. */
  const clone = (args) => {
    const at = args.indexOf('--');
    const [source, dest] = at === -1 ? args.slice(1) : args.slice(at + 1);
    const local = remotes[source];
    if (local === undefined) return null;
    gh.network.push({ sub: 'clone', cwd: null, args });
    const r = spawnSync('git', ['clone', '-q', '--', local, dest], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.status !== 0) return { code: r.status ?? 1, stdout: '', stderr: r.stderr ?? '' };
    return localGit(dest, ['remote', 'set-url', 'origin', source]);
  };

  /** The runner to hand to the CLI as `io.exec`: `gh` is the fake, a remote `git` is refused, any other `git` is real. */
  gh.exec = async (cmd, args, timeout) => {
    if (cmd === 'git') {
      const sub = gitSub(args);
      if (sub === 'clone') {
        const done = clone(args);
        if (done !== null) return done;
      }
      if (NETWORK_GIT.has(sub)) return network(args, process.cwd());
      return base(cmd, args, timeout);
    }
    if (cmd !== 'gh') return base(cmd, args, timeout);
    gh.calls.push(args);
    return handle(args);
  };

  /** The synchronous runner to hand to the CLI as `io.run` (`argv`, `{cwd}`): same rules, and `gh` knows the folder it runs in. */
  gh.run = (argv, { cwd } = {}) => {
    const [cmd, ...args] = argv;
    if (cmd === 'gh') {
      gh.calls.push(args);
      return handle(args, cwd);
    }
    if (cmd === 'git') {
      const sub = gitSub(args);
      if (sub === 'clone') {
        const done = clone(args);
        if (done !== null) return done;
      }
      if (NETWORK_GIT.has(sub)) return network(args, cwd);
    }
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.error) return { code: 127, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error.message}\n` };
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  /** Merge the pull request of a branch in a code repository: GitHub marks it merged and the local default branch follows (fast-forward). */
  gh.mergePr = (repo, branch) => {
    const pr = gh.prs.filter((p) => p.repo === repo && p.branch === branch).at(-1);
    if (pr === undefined) throw new Error(`no pull request for ${repo} ${branch}`);
    pr.state = 'MERGED';
    return pr;
  };

  /** The calls that change GitHub: repository, board, field, issue, item, pull request and GraphQL writes. */
  gh.writes = () => gh.calls.filter((args) => {
    const [a, b] = args;
    return (a === 'repo' && b === 'create')
      || (a === 'project' && ['create', 'field-create', 'item-add', 'item-edit'].includes(b))
      || (a === 'issue' && ['create', 'edit', 'comment', 'close', 'reopen'].includes(b))
      || (a === 'label' && b === 'create')
      || (a === 'pr' && b === 'create')
      || (a === 'api' && (b === 'graphql' || args.includes('--method')));
  });
  return gh;
}
