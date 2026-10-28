import { expect, enTest as test } from './locale-test'
import type { EngineInterface } from 'claude-code'
import { importSource, parseMarkdown, parseTaskmaster, parseGitHub, reconcileImports, detectSources } from '../hooks/importers'
import { setLocale } from '../hooks/i18n'
import { MemIo } from './memio'
import { Paths, readPlan, withLock } from '../hooks/store'
import { reportMarkdown } from '../hooks/report'
import { completionHistory } from '../hooks/overview'
import type { Snapshot } from '../types'

const cwd = '/work/app', paths = new Paths('/board')
function fixture() {
  const io = new MemIo(), aliases = new Map<string, string>(), reads: string[] = []
  let root: string | undefined, beforeGh: (() => Promise<void>) | undefined
  const real = (path: string) => {
    for (const [alias, target] of aliases) if (path === alias || path.startsWith(alias + '/')) return target + path.slice(alias.length)
    return path
  }
  const engine = {
    session: { cwd: async () => cwd }, env: { get: async () => '/work' },
    fs: { stat: async (path: string) => {
      const target = real(path), f = io.files.get(target)
      const dir = target === cwd || target === '/work' || target === root || io.dirs.has(target) || [...io.files.keys()].some(p => p.startsWith(target + '/'))
      if (!f && !dir) throw new Error('ENOENT')
      return { kind: f ? 'file' : 'dir', isLink: target !== path, size: f?.text.length ?? 0, mtimeMs: 1, realPath: target }
    } },
    process: { run: async (argv: readonly string[]) => {
      if (argv[0] === 'git') return { exitCode: root ? 0 : 128, stdout: root ? root + '\n' : '', stderr: '' }
      if (argv[0] !== 'gh') throw new Error('unexpected process')
      await beforeGh?.()
      const endpoint = String(argv[2])
      const value = argv[1] === 'pr' ? { state: 'OPEN', mergedAt: null, url: 'https://github.com/acme/app/pull/22', body: 'Fixes #1', closingIssuesReferences: [] }
        : endpoint.includes('/milestones') ? [[{ number: 1, title: 'Launch' }]]
        : endpoint.includes('/timeline') ? [[{ event: 'cross-referenced', source: { issue: { html_url: 'https://github.com/acme/app/pull/22', pull_request: {} } } }]]
        : [[{ number: 1, title: 'A', state: 'open', milestone: { number: 1 } }]]
      return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' }
    } },
  } as unknown as EngineInterface
  const originalRead = io.read.bind(io)
  io.read = async path => { reads.push(path); return originalRead(path) }
  const put = (path: string, text: string) => io.writeAtomic(path.startsWith('/') ? path : `${cwd}/${path}`, text)
  return { io, engine, aliases, reads, put, gitRoot: (value: string) => { root = value }, gh: (fn: () => Promise<void>) => { beforeGh = fn } }
}
const items = (p: { phases: { items: { status: string; doneAt?: number; title: string }[] }[] }) => p.phases.flatMap(ph => ph.items)

test('V06 WR01 initial historical done imports keep doneAt unknown and reports exclude them', async () => {
  const f = fixture(); await f.put('TODO.md', '- [x] Historical\n- [ ] Future\n')
  const first = await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: 'TODO.md' })
  expect(items(first.plan!)[0]!.doneAt).toBeUndefined()
  expect(completionHistory(first.plan!, f.io.clock).reduce((sum, day) => sum + day.count, 0)).toBe(0)
  const snap = { now: f.io.clock, sessions: [], waiting: [], plans: [first.plan!] } as unknown as Snapshot
  expect(reportMarkdown(first.plan!, snap, undefined).includes('- Historical')).toBe(false)
  await f.put('TODO.md', '- [x] Historical\n- [x] Future\n- [x] Newly discovered history\n')
  const next = await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', planId: first.plan!.id })
  expect(items(next.plan!)[1]!.doneAt! > 0).toBe(true)
  expect(items(next.plan!)[2]!.doneAt).toBeUndefined()
  expect(completionHistory(next.plan!, f.io.clock).reduce((sum, day) => sum + day.count, 0)).toBe(1)
})
test('V06 WR02 numeric IDs follow complete heading ancestry, not preceding sections', () => {
  const a = parseMarkdown('# Work\n## A\n### Shared\n- [ ] 1. First\n## B\n### Shared\n- [x] 1. Second\n', '/p.md')
  const b = parseMarkdown('# Work\n## B\n### Shared\n- [x] 1. Renamed\n', '/p.md')
  expect(a.phases.flatMap(ph => ph.items)[1]!.source.key).toBe(b.phases.flatMap(ph => ph.items)[0]!.source.key)
  const c = parseMarkdown('## B\n### Other\n- [ ] 1. Renamed\n', '/p.md')
  expect(b.phases.flatMap(ph => ph.items)[0]!.source.key === c.phases.flatMap(ph => ph.items)[0]!.source.key).toBe(false)
})
test('V06 WR02 globally unique T and dotted IDs survive heading changes', () => {
  const a = parseMarkdown('## A\n- [ ] T001 Task\n- [ ] 1.2 Task\n', '/p.md')
  const b = parseMarkdown('## B\n- [x] T001 Changed\n- [x] 1.2 Changed\n', '/p.md')
  expect(a.phases[0]!.items.map(i => i.source.key)).toEqual(b.phases[0]!.items.map(i => i.source.key))
})
test('V06 WR03 Taskmaster untagged identity is independent of translated labels', () => {
  try {
    setLocale('en', { 'import.tasks': 'Tasks' }); const a = parseTaskmaster('{"tasks":[{"id":1,"title":"A"}]}', '/t.json')
    setLocale('zh-CN', { 'import.tasks': '任务' }); const b = parseTaskmaster('{"tasks":[{"id":1,"title":"A"}]}', '/t.json')
    expect(a.phases[0]!.source.key).toBe(b.phases[0]!.source.key)
    expect(a.phases[0]!.items[0]!.source.key).toBe(b.phases[0]!.items[0]!.source.key)
  } finally { setLocale('en') }
})
test('V06 Taskmaster rejects malformed task and root tags instead of coercing identities', () => {
  for (const tag of [42, {}, [], null]) {
    expect(() => parseTaskmaster(JSON.stringify({ tasks: [{ id: 1, title: 'A', tag }] }), '/t.json')).toThrow()
    expect(() => parseTaskmaster(JSON.stringify({ tag, tasks: [{ id: 1, title: 'A' }] }), '/t.json')).toThrow()
  }
})
test('V06 closed not_planned and Taskmaster cancelled or deferred are void, not done', () => {
  const doc = parseGitHub('acme/app', [{ number: 1, title: 'Launch' }], [{ number: 1, title: 'Skipped', state: 'closed', state_reason: 'not_planned', milestone: { number: 1 } }] as never)
  expect(doc.phases[0]!.items[0]!.status).toBe('void')
  expect(parseTaskmaster('{"tasks":[{"id":1,"title":"A","status":"cancelled"},{"id":2,"title":"B","status":"deferred"}]}', '/t.json').phases[0]!.items.map(i => i.status)).toEqual(['void', 'void'])
})

test('V06 WR04 all GitHub requests and local parsing occur outside the plan lock', async () => {
  const f = fixture(); let calls = 0
  f.gh(async () => { calls++; expect([...f.io.dirs.keys()].some(p => p.endsWith('/.lock'))).toBe(false) })
  const out = await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', source: 'github:acme/app' })
  expect(out.plan).toBeDefined(); expect(calls >= 3).toBe(true)
  f.io.clock += 1_800_000
  await reconcileImports(f.engine, f.io, paths, out.plan!, 's')
  expect(calls >= 6).toBe(true)
  const g = fixture(); await g.put('TODO.md', '- [ ] A\n')
  const read = g.io.read.bind(g.io)
  g.io.read = async path => { if (path === `${cwd}/TODO.md`) expect([...g.io.dirs.keys()].some(p => p.endsWith('/.lock'))).toBe(false); return read(path) }
  expect((await importSource(g.engine, g.io, paths, { cwd, sessionId: 's', path: 'TODO.md' })).plan).toBeDefined()
})
test('V06 WR04 stale fetched snapshots cannot overwrite a newer source watermark or binding', async () => {
  const f = fixture(); let changed = false
  const first = await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', source: 'github:acme/app', planId: 'app/work' })
  f.gh(async () => {
    if (changed) return; changed = true
    await withLock(f.io, paths.planDir('app/work'), async () => {
      const p = (await readPlan(f.io, paths, 'app/work'))!
      p.source!.lastImportedAt += 100_000; p.title = 'Newer import'
      await f.io.writeAtomic(paths.planJson(p.id), JSON.stringify(p))
    })
  })
  const out = await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', planId: first.plan!.id })
  expect(out.plan?.title ?? (await readPlan(f.io, paths, 'app/work'))!.title).toBe('Newer import')
  expect((await readPlan(f.io, paths, 'app/work'))!.source!.lastImportedAt).toBe(first.plan!.source!.lastImportedAt + 100_000)
})
test('V06 WR05 ordinary PR mentions, closed unmerged PRs and foreign PRs never wrap issues', () => {
  const issue = { number: 1, title: 'A', state: 'open', milestone: { number: 1 } }
  for (const pr of [
    { url: 'https://github.com/acme/app/pull/22', state: 'OPEN', body: 'Mentions #1', closingIssuesReferences: [] },
    { url: 'https://github.com/acme/app/pull/22', state: 'CLOSED', body: 'Fixes #1', closingIssuesReferences: [] },
    { url: 'https://github.com/other/repo/pull/22', state: 'OPEN', body: 'Fixes acme/app#1', closingIssuesReferences: [] },
  ]) {
    const ev = { event: 'cross-referenced', source: { issue: { html_url: pr.url, pull_request: {} } }, pullRequest: pr }
    expect(parseGitHub('acme/app', [{ number: 1, title: 'Launch' }], [issue], { 1: [ev] } as never).phases[0]!.items[0]!.status).toBe('todo')
  }
})
test('V06 WR05 same-repo open/merged closing references or keywords wrap the intended issue only', () => {
  const issue = { number: 1, title: 'A', state: 'open', milestone: { number: 1 } }
  for (const pr of [
    { url: 'https://github.com/acme/app/pull/22', state: 'OPEN', body: 'Fixes #1', closingIssuesReferences: [] },
    { url: 'https://github.com/acme/app/pull/22', state: 'MERGED', body: '', closingIssuesReferences: [{ number: 1, url: 'https://github.com/acme/app/issues/1' }] },
  ]) {
    expect(parseGitHub('acme/app', [{ number: 1, title: 'Launch' }], [issue], { 1: [{ event: 'cross-referenced', pullRequest: pr }] } as never).phases[0]!.items[0]!.status).toBe('wrapping')
  }
})
test('V06 WR06 imports outside session root fail before any source read and empty sources make no draft', async () => {
  const f = fixture(); await f.put('/outside/secret.md', '- [ ] Private\n'); await f.put('README.md', '# No tasks\n')
  for (const path of ['/outside/secret.md', '../secret.md', 'README.md']) {
    expect((await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path })).plan).toBeUndefined()
  }
  expect(f.reads.includes('/outside/secret.md')).toBe(false)
  expect((await f.io.list(paths.plans)).length).toBe(0)
})
test('V06 WR06 symlink escapes and recursive GSD escapes fail closed; canonical aliases deduplicate', async () => {
  const f = fixture(); await f.put('/outside/secret.md', '- [ ] Private\n'); await f.put('TODO.md', '- [ ] Safe\n')
  f.aliases.set(`${cwd}/escape.md`, '/outside/secret.md'); f.aliases.set(`${cwd}/alias.md`, `${cwd}/TODO.md`)
  expect((await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: 'escape.md' })).plan).toBeUndefined()
  expect(f.reads.includes('/outside/secret.md')).toBe(false)
  const a = await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: 'alias.md' })
  const b = await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: 'TODO.md' })
  expect(a.plan).toBeDefined(); expect(b.plan).toBeDefined()
  expect(a.plan!.id).toBe(b.plan!.id)
  await f.put('.planning/ROADMAP.md', '# Roadmap\n## Phase 1: Work\n- [ ] A\n')
  await f.put('.planning/phases/01-work/01-01-PLAN.md', '# Secret alias\n')
  f.aliases.set(`${cwd}/.planning/phases/01-work/01-01-PLAN.md`, '/outside/secret.md')
  expect((await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', source: 'gsd' })).plan).toBeUndefined()
})
test('V06 WR06 leading home expands before checking git project boundary', async () => {
  const f = fixture(); f.gitRoot('/work'); await f.put('/work/plans/work.md', '- [ ] A\n')
  const out = await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: '~/plans/work.md' })
  expect(out.plan?.source?.path).toBe('/work/plans/work.md')
})
test('V06 WR06 stored source reconcile cannot read outside the current session project', async () => {
  const f = fixture(); await f.put('TODO.md', '- [ ] A\n')
  const p = (await importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: 'TODO.md' })).plan!
  p.source!.path = '/outside/tasks.md'; p.source!.cwd = '/outside'
  await f.put('/outside/tasks.md', '- [x] A\n'); await f.io.writeAtomic(paths.planJson(p.id), JSON.stringify(p)); f.io.clock += 1_800_000
  await reconcileImports(f.engine, f.io, paths, p, 's')
  expect(f.reads.includes('/outside/tasks.md')).toBe(false)
  expect(await readPlan(f.io, paths, p.id)).toEqual(p)
})
test('V06 WR06 discovery never reads symlinks outside the project root', async () => {
  const f = fixture(); await f.put('/outside/secret.md', '- [ ] Private\n'); f.aliases.set(`${cwd}/TODO.md`, '/outside/secret.md')
  try { await detectSources(f.engine, f.io, cwd) } catch { /* refusing discovery is fail closed */ }
  expect(f.reads.includes(`${cwd}/TODO.md`)).toBe(false)
  expect(f.reads.includes('/outside/secret.md')).toBe(false)
})
