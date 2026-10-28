import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { MemIo } from './memio'
import { Paths, readPlan, readLogTail } from '../hooks/store'
import { t } from '../hooks/i18n'
import { markdown, gsd, specs, taskmaster, milestones, issues, timeline, planMode } from './fixtures/v05/sources'

import * as importers from '../hooks/importers'
const load = async () => importers
const cwd = '/work/app', paths = new Paths('/board')
function setup() {
  const io = new MemIo(), calls: { argv: readonly string[]; cwd?: string }[] = []
  let github = false, broken = false
  const engine = { session: { cwd: async () => cwd }, fs: { stat: async (path: string) => {
    const f = io.files.get(path)
    if (!f && path !== cwd && ![...io.files.keys()].some(p => p.startsWith(path + '/'))) throw new Error('ENOENT')
    return { kind: f ? 'file' : 'dir', size: f?.text.length ?? 0, mtimeMs: 1, isLink: false, realPath: path }
  } }, process: { run: async (argv: readonly string[], init?: { cwd?: string }) => {
    calls.push({ argv, cwd: init?.cwd })
    if (argv[0] === 'git' || !github || broken) return { exitCode: 1, stdout: '', stderr: 'unavailable' }
    let value: unknown
    if (argv[1] === 'pr') value = timeline[0]!.pullRequest
    else if (argv[1] === 'repo') value = { nameWithOwner: 'acme/app' }
    else if (String(argv[2]).includes('/milestones')) value = [milestones]
    else if (String(argv[2]).includes('/timeline')) value = String(argv[2]).includes('/11/') ? [timeline] : [[]]
    else value = [issues]
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' }
  } } } as unknown as EngineInterface
  const put = async (path: string, text: string) => io.writeAtomic(path.startsWith('/') ? path : `${cwd}/${path}`, text)
  const mount = async (files: Record<string, string>) => { for (const [path, text] of Object.entries(files)) await put(path, text) }
  return { io, engine, calls, put, mount, github: () => { github = true }, broken: () => { broken = true } }
}
const all = (plan: { phases: { items: unknown[] }[] }) => plan.phases.flatMap(p => p.items)

test('importers markdown fixture flattens parents, preserves line evidence and ignores fences', async () => {
  const { parseMarkdown } = await load(), doc = parseMarkdown(markdown, '/work/app/TODO.md')
  expect(doc.phases.map(p => p.name)).toEqual(['Build', 'Ship'])
  expect(doc.phases[0]!.items.map(i => i.title)).toEqual(['Parent', 'Parent > Child', 'Stable'])
  expect(doc.phases[0]!.items[1]!.status).toBe('done')
  expect(doc.phases[0]!.items[1]!.source.line).toBe(5)
  expect(doc.phases[0]!.items[1]!.source.file).toBe('/work/app/TODO.md')
})
test('importers markdown identity survives status toggles and inserted lines; duplicate titles remain distinct', async () => {
  const { parseMarkdown } = await load()
  const a = parseMarkdown('## Work\n- [ ] Same\n- [ ] Same\n', '/p.md')
  const b = parseMarkdown('\n## Work\n- [x] New\n- [x] Same\n- [ ] Same\n', '/p.md')
  expect(a.phases[0]!.items.map(i => i.source.key)).toEqual(b.phases[0]!.items.slice(1).map(i => i.source.key))
  expect(a.phases[0]!.items[0]!.source.key === a.phases[0]!.items[1]!.source.key).toBe(false)
})
test('importers markdown handles tilde fences and ordinary list ancestor prefixes', async () => {
  const { parseMarkdown } = await load()
  const doc = parseMarkdown('- Group\n  - [ ] A\n~~~\n- [x] Fake\n~~~\n- [ ] B\n', '/p.md')
  expect(all(doc).length).toBe(2)
  expect(doc.phases[0]!.items[0]!.title).toBe('Group > A')
})
test('importers GSD fixture uses plan files and SUMMARY, with roadmap checklist fallback', async () => {
  const { parseGsd } = await load(), doc = parseGsd(gsd, cwd)
  expect(doc.phases.map(p => p.name)).toEqual(['Foundation', 'Delivery'])
  expect(doc.phases[0]!.items.map(i => i.status)).toEqual(['done', 'todo'])
  expect(doc.phases[0]!.items[0]!.source.file).toBe(`${cwd}/.planning/phases/01-foundation/01-01-PLAN.md`)
  expect(doc.phases[1]!.items[0]!.title).toBe('Release checklist')
})
test('importers spec-kit and Kiro fixtures yield one phase per spec and stable explicit task ids', async () => {
  const { parseSpecs } = await load(), doc = parseSpecs(specs, cwd)
  expect(doc.phases.length).toBe(2)
  const login = doc.phases.find(p => p.name === '001-login')!
  expect(login.items.length).toBe(3)
  expect(login.items[0]!.status).toBe('done')
  const changed = parseSpecs({ ...specs, 'specs/001-login/tasks.md': '\n- [ ] T001 Renamed schema\n' }, cwd)
  expect(login.items[0]!.source.key).toBe(changed.phases.find(p => p.name === '001-login')!.items[0]!.source.key)
  expect(doc.phases.find(p => p.name === 'search')!.items.length).toBe(3)
})
test('importers Taskmaster fixture preserves tags, subtasks, in-progress mapping and file evidence', async () => {
  const { parseTaskmaster } = await load(), doc = parseTaskmaster(taskmaster, '/tasks.json')
  expect(doc.phases.map(p => p.name)).toEqual(['backend', 'frontend'])
  expect(doc.phases[0]!.items.map(i => i.status)).toEqual(['wrapping', 'done', 'todo', 'done'])
  expect(doc.phases[0]!.items[1]!.title).toBe('API > Schema')
  expect(doc.phases[0]!.items.every(i => i.source.file === '/tasks.json' && (i.source.line ?? 0) > 0)).toBe(true)
  expect(new Set(all(doc).map(i => (i as { source: { key: string } }).source.key)).size).toBe(5)
})
test('importers Taskmaster accepts untagged and current tag-keyed layouts', async () => {
  const { parseTaskmaster } = await load()
  expect(parseTaskmaster('{"tasks":[{"id":1,"title":"A","status":"done"}]}', '/t.json').phases[0]!.items[0]!.status).toBe('done')
  expect(parseTaskmaster('{"master":{"tasks":[{"id":1,"title":"A","status":"pending"}]}}', '/t.json').phases[0]!.name).toBe('master')
})
test('importers GitHub fixture filters PRs and maps closed and linked PR statuses', async () => {
  const { parseGitHub } = await load(), doc = parseGitHub('acme/app', milestones, issues, { 11: timeline })
  expect(doc.phases[0]!.items.map(i => i.status)).toEqual(['done', 'wrapping', 'todo'])
  expect(doc.phases[0]!.items[1]!.source.url).toBe('https://github.com/acme/app/issues/11')
})
test('importers detection lists all sources in specified order without writing a plan', async () => {
  const m = await load(), f = setup(); await f.mount(gsd); await f.mount(specs); await f.put('.taskmaster/tasks/tasks.json', taskmaster); await f.put('TODO.md', markdown); f.github()
  const candidates = await m.detectSources(f.engine, f.io, cwd)
  expect(candidates.map(c => c.kind)).toEqual(['gsd', 'specs', 'kiro', 'taskmaster', 'markdown', 'github'])
  const out = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's' })
  expect(out.plan).toBe(undefined)
  expect(out.text.includes('gsd:')).toBe(true)
  expect((await f.io.list(paths.plans)).length).toBe(0)
})
test('importers a single Markdown source creates only a draft with source metadata and no closeout', async () => {
  const m = await load(), f = setup(); await f.put('TODO.md', markdown)
  const out = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's' })
  expect(out.plan!.status).toBe('draft'); expect(out.plan!.approval).toBe(undefined)
  expect(out.plan!.phases.length).toBe(2)
  expect((out.plan as import('../hooks/importers').ImportedPlan).source!.kind).toBe('markdown')
})
test('importers manual repeat is idempotent without plan id and retains the same plan identity', async () => {
  const m = await load(), f = setup(); await f.put('TODO.md', markdown)
  const a = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 'a', path: 'TODO.md' })
  const b = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 'b', path: 'TODO.md' })
  expect(a.plan!.id).toBe(b.plan!.id); expect(all(b.plan!).length).toBe(4)
  expect((await f.io.list(paths.plans)).length).toBe(1)
})
test('importers reimport preserves human fields, adds items, advances only, logs removals once', async () => {
  const m = await load(), f = setup(); await f.put('TODO.md', markdown)
  const a = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 'a', planId: 'app/work', path: 'TODO.md' })
  const p = a.plan!; p.title = 'Human plan'; p.goal = 'Human goal'; p.status = 'active'; p.milestones = ['Review', 'Ship']
  p.phases[0]!.name = 'Human phase'; p.phases[0]!.priority = 'high'
  const it = p.phases[0]!.items[0]!; it.title = 'Human item'; it.priority = 'pinned'; it.refs = { branch: ['work'] }
  await f.io.writeAtomic(paths.planJson(p.id), JSON.stringify(p))
  await f.put('TODO.md', '# Delivery\n## Build\n- [x] Parent\n  - [ ] Child\n- [ ] New work\n')
  const b = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 'b', planId: p.id })
  expect(b.plan!.title).toBe('Human plan'); expect(b.plan!.goal).toBe('Human goal'); expect(b.plan!.status).toBe('active')
  expect(b.plan!.phases[0]!.name).toBe('Human phase'); expect(b.plan!.phases[0]!.priority).toBe('high')
  expect(b.plan!.phases[0]!.items[0]!.title).toBe('Human item'); expect(b.plan!.phases[0]!.items[0]!.priority).toBe('pinned')
  expect(b.plan!.phases[0]!.items[0]!.refs).toEqual({ branch: ['work'] })
  expect(b.plan!.phases[0]!.items[0]!.status).toBe('done'); expect(b.plan!.phases[0]!.items[0]!.milestone).toBe(2)
  expect(b.plan!.phases[0]!.items[1]!.status).toBe('done'); expect(all(b.plan!).length).toBe(5)
  const logs = await readLogTail(f.io, paths, p.id, 100), removed = logs.filter(l => l.action === 'import-removed')
  expect(removed.length).toBe(2); expect(logs.some(l => l.action === 'import-reconcile')).toBe(true)
  await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 'c', planId: p.id })
  expect((await readLogTail(f.io, paths, p.id, 100)).filter(l => l.action === 'import-removed').length).toBe(2)
})
test('importers removed/reappearing items reuse their identity; manual void remains void', async () => {
  const m = await load(), f = setup(); await f.put('TODO.md', '- [ ] A\n')
  const a = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: 'TODO.md' }); const p = a.plan!
  p.phases[0]!.items[0]!.status = 'void'; await f.io.writeAtomic(paths.planJson(p.id), JSON.stringify(p))
  await f.put('TODO.md', '# Empty\n'); await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', planId: p.id })
  await f.put('TODO.md', '- [x] A\n'); const b = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', planId: p.id })
  expect(all(b.plan!).length).toBe(1); expect(b.plan!.phases[0]!.items[0]!.status).toBe('void')
})
test('importers given plan-mode path outside project is refused without discovery', async () => {
  const m = await load(), f = setup(); await f.put('/plans/design.md', planMode)
  const out = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: '/plans/design.md', source: 'plan-mode' })
  expect(out.plan).toBeUndefined(); expect(f.calls.some(c => c.argv[0] === 'gh')).toBe(false)
})
test('importers fake gh uses argv and cwd, paginates all milestones/issues and observes linked PR evidence', async () => {
  const m = await load(), f = setup(); f.github()
  const out = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', source: 'github:acme/app' })
  expect(out.plan!.phases[0]!.items.map(i => i.status)).toEqual(['done', 'wrapping', 'todo'])
  expect(f.calls.filter(c => c.argv[0] === 'gh').every(c => c.cwd === cwd)).toBe(true)
  expect(f.calls.filter(c => c.argv[1] === 'api').every(c => c.argv.includes('--paginate') && c.argv.includes('--slurp'))).toBe(true)
})
test('importers malformed JSON, missing explicit file and failed gh never create plans', async () => {
  const m = await load(), f = setup(); await f.put('.taskmaster/tasks/tasks.json', '{oops')
  for (const ctx of [{ source: 'taskmaster' }, { path: 'missing.md' }, { source: 'github:acme/app' }]) {
    const out = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', ...ctx })
    expect(out.plan).toBe(undefined); expect(out.text.length > 0).toBe(true)
  }
  expect((await f.io.list(paths.plans)).length).toBe(0)
})
test('importers reconcile only runs with stored source after 30 minutes and locks out concurrent sessions', async () => {
  const m = await load(), f = setup(); await f.put('TODO.md', '- [ ] A\n')
  const p = (await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: 'TODO.md' })).plan!
  await f.put('TODO.md', '- [x] A\n'); const writes = f.io.writes
  await m.reconcileImports(f.engine, f.io, paths, p, 's'); expect(f.io.writes).toBe(writes)
  f.io.clock += 30 * 60_000
  await Promise.all(['a', 'b', 'c'].map(s => m.reconcileImports(f.engine, f.io, paths, p, s)))
  const next = (await readPlan(f.io, paths, p.id))!
  expect(next.phases[0]!.items[0]!.status).toBe('done')
  expect((await readLogTail(f.io, paths, p.id, 100)).filter(l => l.action === 'import-reconcile').length).toBe(1)
  const bare = { ...p }; delete (bare as import('../hooks/importers').ImportedPlan).source
  const after = f.io.writes; await m.reconcileImports(f.engine, f.io, paths, bare, 's'); expect(f.io.writes).toBe(after)
})
test('importers automatic reconcile uses latest locked plan and does not resurrect a removed source', async () => {
  const m = await load(), f = setup(); await f.put('TODO.md', '- [ ] A\n')
  const p = (await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: 'TODO.md' })).plan!
  const bare = { ...p }; delete (bare as import('../hooks/importers').ImportedPlan).source
  await f.io.writeAtomic(paths.planJson(p.id), JSON.stringify(bare)); f.io.clock += 1_800_000
  const reads = f.io.read.bind(f.io); let sourceReads = 0
  f.io.read = async path => { if (path === `${cwd}/TODO.md`) sourceReads++; return reads(path) }
  await m.reconcileImports(f.engine, f.io, paths, p, 's'); expect(sourceReads).toBe(0)
  expect((await readPlan(f.io, paths, p.id) as import('../hooks/importers').ImportedPlan).source).toBe(undefined)
})
test('importers automatic read failure preserves plan/source watermark and logs no false removals', async () => {
  const m = await load(), f = setup(); await f.put('TODO.md', '- [ ] A\n')
  const p = (await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: 'TODO.md' })).plan!
  f.io.files.delete(`${cwd}/TODO.md`); f.io.clock += 1_800_000
  await m.reconcileImports(f.engine, f.io, paths, p, 's')
  expect(await readPlan(f.io, paths, p.id)).toEqual(p)
  expect((await readLogTail(f.io, paths, p.id, 100)).filter(l => l.action === 'import-removed').length).toBe(0)
})
test('importers a given GSD roadmap path selects the GSD adapter rather than ordinary Markdown', async () => {
  const m = await load(), f = setup(); await f.mount(gsd)
  const out = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path: '.planning/ROADMAP.md' })
  expect((out.plan as import('../hooks/importers').ImportedPlan).source!.kind).toBe('gsd')
  expect(out.plan!.phases[0]!.items.map(i => i.status)).toEqual(['done', 'todo'])
})
test('importers Markdown title is not mistaken for a numeric task id when numbers start prose', async () => {
  const { parseMarkdown } = await load()
  const a = parseMarkdown('- [ ] 10 users can log in\n', '/TODO.md')
  const b = parseMarkdown('- [ ] 10 failures are visible\n', '/TODO.md')
  expect(a.phases[0]!.items[0]!.source.key === b.phases[0]!.items[0]!.source.key).toBe(false)
})
test('importers explicit paths route Taskmaster, spec-kit roots and individual Kiro tasks to their adapters', async () => {
  const m = await load(), f = setup(); await f.mount(specs); await f.put('.taskmaster/tasks/tasks.json', taskmaster)
  for (const [path, kind, count] of [['.taskmaster/tasks/tasks.json', 'taskmaster', 5], ['specs', 'specs', 3], ['.kiro/specs/search/tasks.md', 'kiro', 3]] as const) {
    const out = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', path })
    expect((out.plan as import('../hooks/importers').ImportedPlan).source!.kind).toBe(kind)
    expect(all(out.plan!).length).toBe(count)
  }
})
test('importers displayed source tokens and raw source paths select without changing source identity', async () => {
  const m = await load(), f = setup(); await f.put('.taskmaster/tasks/tasks.json', taskmaster)
  const a = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', source: 'taskmaster' })
  const b = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 's', source: '.taskmaster/tasks/tasks.json' })
  expect(b.plan!.id).toBe(a.plan!.id); expect(all(b.plan!).length).toBe(5)
})
test('importers repeating a source reuses an existing custom-id plan rather than creating a second draft', async () => {
  const m = await load(), f = setup(); await f.put('TODO.md', '- [ ] A\n')
  const a = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 'a', planId: 'app/custom', path: 'TODO.md' })
  await f.put('TODO.md', '- [x] A\n- [ ] B\n')
  const b = await m.importSource(f.engine, f.io, paths, { cwd, sessionId: 'b', path: 'TODO.md' })
  expect(b.plan!.id).toBe(a.plan!.id)
  expect(all(b.plan!).length).toBe(2)
  expect(b.plan!.phases[0]!.items[0]!.status).toBe('done')
  expect((await f.io.list(paths.plans)).length).toBe(1)
})
test('importers concurrent first imports never merge an older parse: one wins and the rest are told to retry', async () => {
  const m = await load(), f = setup(); await f.put('TODO.md', markdown)
  const out = await Promise.all(['a', 'b', 'c'].map(sessionId => m.importSource(f.engine, f.io, paths, { cwd, sessionId, path: 'TODO.md' })))
  const won = out.filter(r => r.plan)
  expect(won.length).toBeGreaterThanOrEqual(1)
  expect(won.every(r => r.plan!.id === 'app/todo')).toBe(true)
  // A parse taken before the winner existed is never merged into it: that caller is told to retry.
  expect(out.filter(r => !r.plan).every(r => r.text === t('import.retry'))).toBe(true)
  expect(all((await readPlan(f.io, paths, 'app/todo'))!).length).toBe(4)
  expect((await f.io.list(paths.plans)).length).toBe(1)
})
