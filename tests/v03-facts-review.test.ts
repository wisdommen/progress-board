import { expect, test } from './locale-test'
import type { Plan, SessionView } from '../types'
import { pollFacts } from '../hooks/facts'
import { Paths } from '../hooks/store'
import { MemIo } from './memio'
import { isolatedMonitorEngine, seedPlan, world } from './world'
import { claim, NOW, PLAN, plan, savedPlan, session } from './v03-fixtures'

const MIN = 60_000
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
const sha = 'a'.repeat(40)
const view = (at = NOW): SessionView => ({ ...session({ claims: [claim()], repoRoot: '/w/acme' }), lastActivity: at,
  isSelf: true, isAlive: true, cwdMissing: false, attribution: { confident: [{ plan: PLAN, source: 'claim' }], speculative: [] } })
const itemOf = async (io: MemIo, paths: Paths) => (JSON.parse((await io.read(paths.planJson(PLAN)))!) as Plan).phases[0]!.items[0]!

for (const mode of ['old', 'wrong-sha', 'wrong-branch', 'no-date', 'missing-head', 'valid']) {
  test(`WR-04 branch merge requires current head and attachment time: ${mode}`, async ($, on) => {
    const w = world(on, { coarseClock: true }), io = new MemIo(), paths = Paths.forHome('/h')
    io.clock = NOW
    const p = plan({ repos: ['/w/acme'], auto_done_on_merge: true })
    Object.assign(p.phases[0]!.items[0]!, { refs: { branch: ['feature/login'] }, branchAddedAt: { 'feature/login': NOW - MIN } })
    await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
    w.processReply = argv => argv.includes('ls-remote') ? ok(mode === 'missing-head' ? '' : `${sha}\trefs/heads/feature/login\n`) : argv[0] === 'gh' ? ok(JSON.stringify([{
      number: 8, mergedAt: mode === 'no-date' ? null : new Date(NOW - (mode === 'old' ? 2 * MIN : 1)).toISOString(),
      headRefName: mode === 'wrong-branch' ? 'feature/other' : 'feature/login', headRefOid: mode === 'wrong-sha' ? 'b'.repeat(40) : sha,
    }])) : undefined
    await pollFacts(isolatedMonitorEngine(w), io, paths, PLAN, [view()], () => false)
    expect((await itemOf(io, paths)).status).toBe(mode === 'valid' ? 'done' : 'todo')
    expect(w.processCalls.find(c => c.argv[0] === 'gh')?.argv).toContain('--head=feature/login')
  })
}

test('WR-04 branch attachment timestamps are retained per item without changing refs shape', async ($, on) => {
  const w = world(on, { coarseClock: true }); seedPlan(w, '/h', plan())
  on('tool.call', () => ({ result: {} }))
  const attach = () => $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-1', refs: { branch: ['feature/login'] } } as never)
  await attach()
  expect((savedPlan(w).phases[0]!.items[0] as unknown as { branchAddedAt: Record<string, number> }).branchAddedAt?.['feature/login']).toBe(NOW)
  await w.clock.advance(MIN); await attach()
  expect((savedPlan(w).phases[0]!.items[0] as unknown as { branchAddedAt: Record<string, number> }).branchAddedAt?.['feature/login']).toBe(NOW)
})

test('WR-09 idle plans back off open refs to one hour and cache closed refs', async ($, on) => {
  const w = world(on, { coarseClock: true }), io = new MemIo(), paths = Paths.forHome('/h')
  io.clock = NOW
  const p = plan(); p.phases[0]!.items[0]!.refs = { pr: [{ repo: 'acme/app', number: 1 }, { repo: 'acme/app', number: 2 }] }
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  w.processReply = argv => argv[0] === 'gh' ? ok(JSON.stringify({ state: argv[3] === '2' ? 'CLOSED' : 'OPEN', isDraft: true })) : undefined
  const engine = isolatedMonitorEngine(w)
  for (let n = 0; n < 6; n++) { io.clock = NOW + n * 6 * MIN; await pollFacts(engine, io, paths, PLAN, [view()], () => false) }
  expect(w.processCalls.filter(c => c.argv[0] === 'gh').length).toBe(2)
  io.clock = NOW + 60 * MIN; await pollFacts(engine, io, paths, PLAN, [view()], () => false)
  expect(w.processCalls.filter(c => c.argv[0] === 'gh').length).toBe(3)
})

for (const mode of ['opt-in', 'last-station']) {
  test(`WR-12 all PRs must merge before done and closed PRs are ignored: ${mode}`, async ($, on) => {
    const w = world(on, { coarseClock: true }), io = new MemIo(), paths = Paths.forHome('/h'); io.clock = NOW
    const p = plan(mode === 'opt-in' ? { auto_done_on_merge: true } : { milestones: ['开 PR', '合并'] })
    p.phases[0]!.items[0]!.refs = { pr: [1, 2, 3].map(number => ({ repo: 'acme/app', number })) }
    await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
    let second = 'OPEN'
    w.processReply = argv => argv[0] === 'gh' ? ok(JSON.stringify({ state: argv[3] === '1' ? 'MERGED' : argv[3] === '2' ? second : 'CLOSED', isDraft: false })) : undefined
    const engine = isolatedMonitorEngine(w)
    await pollFacts(engine, io, paths, PLAN, [view()], () => false)
    expect((await itemOf(io, paths)).status).toBe('wrapping')
    second = 'MERGED'; io.clock += 5 * MIN
    await pollFacts(engine, io, paths, PLAN, [view(io.clock)], () => false)
    expect((await itemOf(io, paths)).status).toBe('done')
    expect(w.processCalls.filter(c => c.argv[0] === 'gh').map(c => c.argv[3])).toEqual(['1', '2', '3', '2'])
  })
}

test('WR-12 a final closed result completes only the already-merged remainder; all closed never advances', async ($, on) => {
  const w = world(on, { coarseClock: true }), io = new MemIo(), paths = Paths.forHome('/h'); io.clock = NOW
  const p = plan({ auto_done_on_merge: true })
  p.phases[0]!.items[0]!.refs = { pr: [1, 2].map(number => ({ repo: 'acme/app', number })) }
  p.phases[0]!.items[1]!.refs = { pr: [{ repo: 'acme/app', number: 2 }] }
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  w.processReply = argv => argv[0] === 'gh' ? ok(JSON.stringify({ state: argv[3] === '1' ? 'MERGED' : 'CLOSED', isDraft: false })) : undefined
  await pollFacts(isolatedMonitorEngine(w), io, paths, PLAN, [view()], () => false)
  expect((await itemOf(io, paths)).status).toBe('done')
  const out = JSON.parse((await io.read(paths.planJson(PLAN)))!) as Plan
  expect(out.phases[0]!.items[1]!.status).toBe('todo')
  expect(w.processCalls.filter(c => c.argv[0] === 'gh').map(c => c.argv[3])).toEqual(['1', '2'])
})

test('IN-01 persisted refs are revalidated before reaching argv', async ($, on) => {
  const w = world(on, { coarseClock: true }), io = new MemIo(), paths = Paths.forHome('/h'); io.clock = NOW
  const p = plan({ repos: ['/w/acme'] })
  p.phases[0]!.items[0]!.refs = { pr: [{ repo: '--help', number: 1 }, { repo: 'acme/app', number: -1 }], branch: ['--upload-pack=x', 'a*'] }
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  await pollFacts(isolatedMonitorEngine(w), io, paths, PLAN, [view()], () => false)
  expect(w.processCalls.length).toBe(0)
})

test('IN-05 checks drop removed refs even when no targets remain', async ($, on) => {
  const w = world(on, { coarseClock: true }), io = new MemIo(), paths = Paths.forHome('/h'); io.clock = NOW
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(plan()))
  await io.writeAtomic(paths.checks(PLAN), JSON.stringify({ stale: { lastCheckedAt: NOW, state: 'closed' } }))
  await pollFacts(isolatedMonitorEngine(w), io, paths, PLAN, [view()], () => false)
  expect(JSON.parse((await io.read(paths.checks(PLAN)))!)).toEqual({})
})
