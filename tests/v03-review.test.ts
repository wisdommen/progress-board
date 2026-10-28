// 审查探针反转：所有断言均要求正确行为，修复前应失败。
import { expect, test } from './locale-test'
import type { SessionView, Suggestion } from '../types'
import { pollFacts } from '../hooks/facts'
import { bashSignal } from '../hooks/freshness'
import { monitorDigest, resolveSuggestion, runMonitor, takeSuggestions } from '../hooks/monitor'
import { Paths } from '../hooks/store'
import { MemIo } from './memio'
import { isolatedMonitorEngine, world } from './world'
import { claim, NOW, PLAN, plan, session } from './v03-fixtures'

const MIN = 60_000
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
function view(id: string, over: Partial<SessionView> = {}): SessionView {
  return { ...session({ id, claims: [claim()], repoRoot: '/w/acme', repoKey: 'acme' }), isSelf: id === 's1', isAlive: true, cwdMissing: false,
    attribution: { confident: [{ plan: PLAN, source: 'claim' }], speculative: [] }, ...over }
}

test('PROBE-1 repo-less refs never use an unrelated live session repository', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const io = new MemIo(); io.clock = NOW
  const paths = Paths.forHome('/h')
  const p = plan({ repos: [], auto_done_on_merge: true }); p.phases[0]!.items[0]!.refs = { pr: [{ number: 12 }] }
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  const unrelated = view('s9', { claims: [], repoRoot: '/w/other-project', repoKey: 'other', attribution: { confident: [], speculative: [] } })
  w.processReply = argv => argv[0] === 'gh' ? ok('{"state":"MERGED","mergedAt":"x","isDraft":false}') : undefined
  await pollFacts(isolatedMonitorEngine(w), io, paths, PLAN, [unrelated], () => false)
  expect(w.processCalls.some(c => c.argv[0] === 'gh')).toBe(false)
  expect(JSON.parse((await io.read(paths.planJson(PLAN)))!).phases[0].items[0].status).toBe('todo')
})

test('PROBE-2 a slow process still permits the next five-minute fact check', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const io = new MemIo(); io.clock = NOW
  const paths = Paths.forHome('/h')
  const p = plan(); p.phases[0]!.items[0]!.refs = { pr: [{ repo: 'acme/app', number: 7 }] }
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  let latency = 1500
  w.processReply = argv => { if (argv[0] === 'gh') { io.clock += latency; return ok('{"state":"OPEN","isDraft":true}') } return undefined }
  const engine = isolatedMonitorEngine(w)
  const t0 = io.clock
  await pollFacts(engine, io, paths, PLAN, [view('s1')], () => false)
  io.clock = t0 + 5 * MIN
  latency = 20
  await pollFacts(engine, io, paths, PLAN, [view('s1', { lastActivity: io.clock })], () => false)
  expect(w.processCalls.filter(c => c.argv[0] === 'gh').length).toBe(2)
})

test('PROBE-3 an open PR does not pass an Approve milestone', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const io = new MemIo(); io.clock = NOW
  const paths = Paths.forHome('/h')
  const p = plan({ milestones: ['Implement', 'Review', 'Approve', 'Merge'] }); p.phases[0]!.items[0]!.refs = { pr: [{ repo: 'acme/app', number: 7 }] }
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  w.processReply = argv => argv[0] === 'gh' ? ok('{"state":"OPEN","isDraft":false}') : undefined
  await pollFacts(isolatedMonitorEngine(w), io, paths, PLAN, [view('s1')], () => false)
  expect(JSON.parse((await io.read(paths.planJson(PLAN)))!).phases[0].items[0].milestone ?? 0).toBe(0)
})

test('PROBE-4 a merged PR also passes the PR station', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const io = new MemIo(); io.clock = NOW
  const paths = Paths.forHome('/h')
  const p = plan({ milestones: ['开 PR', '部署'] }); p.phases[0]!.items[0]!.refs = { pr: [{ repo: 'acme/app', number: 7 }] }
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  w.processReply = argv => argv[0] === 'gh' ? ok('{"state":"MERGED","isDraft":false}') : undefined
  await pollFacts(isolatedMonitorEngine(w), io, paths, PLAN, [view('s1')], () => false)
  const it = JSON.parse((await io.read(paths.planJson(PLAN)))!).phases[0].items[0]
  expect(it.status).toBe('wrapping')
  expect(it.milestone ?? 0).toBe(1)
})

test('PROBE-5 terminal merged refs are not re-polled while wrapping', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const io = new MemIo(); io.clock = NOW
  const paths = Paths.forHome('/h')
  const p = plan(); p.phases[0]!.items[0]!.refs = { pr: [{ repo: 'acme/app', number: 7 }] }
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  w.processReply = argv => argv[0] === 'gh' ? ok('{"state":"MERGED","isDraft":false}') : undefined
  const engine = isolatedMonitorEngine(w)
  for (let i = 0; i < 6; i++) { io.clock = NOW + i * 6 * MIN; await pollFacts(engine, io, paths, PLAN, [view('s1', { lastActivity: io.clock })], () => false) }
  expect(w.processCalls.filter(c => c.argv[0] === 'gh').length).toBe(1)
})

test('PROBE-6 read-only commands are not progress signals', () => {
  expect(bashSignal('git merge-base HEAD origin/main')).toBe(undefined)
  expect(bashSignal('git tag -l')).toBe(undefined)
  expect(bashSignal('git push --dry-run')).toBe(undefined)
  expect(bashSignal('gh pr create --help')).toBe(undefined)
})

test('PROBE-7 digest budgets prioritize current work over completed history', () => {
  const p = plan()
  p.phases[0]!.items = Array.from({ length: 80 }, (_, i) => ({ id: `p1-${i + 1}`, title: `已完成的历史条目编号 ${i + 1} 说明文字`, status: i < 70 ? 'done' as const : 'todo' as const, updatedAt: NOW }))
  const digest = JSON.parse(monitorDigest(p, [view('s1')], {}))
  const ids = new Set(digest.items.map((i: { id: string }) => i.id))
  expect(ids.has('p1-75')).toBe(true)
  expect(digest.items.some((i: { status: string }) => i.status === 'todo')).toBe(true)
})

test('PROBE-8 rejected suggestions stay suppressed across unrelated digest changes', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const io = new MemIo(); io.clock = NOW
  const paths = Paths.forHome('/h')
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(plan()))
  const sugg = { item: 'p1-1', status: 'wrapping', reason: '交回', evidence: '事件' }
  w.modelReply = () => ({ isAnswered: true, text: JSON.stringify({ suggestions: [sugg] }), usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  const engine = isolatedMonitorEngine(w)
  const s1 = view('s1', { kind: 'orchestrator', lastActivity: NOW })
  await runMonitor(engine, io, paths, PLAN, 's1', [s1], 15 * MIN, new AbortController().signal)
  expect(await takeSuggestions(io, paths, PLAN, 's1', [s1])).toContain('check suggestions')
  const first = (JSON.parse((await io.read(paths.suggestions(PLAN)))!) as Suggestion[])[0]!
  expect((await resolveSuggestion(io, paths, PLAN, first.id, false, '尚未验证，不采纳', 's1')).isError).toBe(undefined)
  io.clock = NOW + 16 * MIN
  const s1b = view('s1', { kind: 'orchestrator', lastActivity: io.clock, events: [{ kind: 'bash', text: 'git status', at: io.clock }] })
  await runMonitor(engine, io, paths, PLAN, 's1', [s1b], 15 * MIN, new AbortController().signal)
  expect(w.modelCalls.length).toBe(2)
  expect(await takeSuggestions(io, paths, PLAN, 's1', [s1b])).toBe(undefined)
})

test('PROBE-9 timer jitter does not double the monitor interval', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const io = new MemIo(); io.clock = NOW
  const paths = Paths.forHome('/h')
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(plan()))
  const engine = isolatedMonitorEngine(w)
  await runMonitor(engine, io, paths, PLAN, 's1', [view('s1', { lastActivity: NOW })], 15 * MIN, new AbortController().signal)
  expect(w.modelCalls.length).toBe(1)
  io.clock = NOW + 15 * MIN - 5
  await runMonitor(engine, io, paths, PLAN, 's1', [view('s1', { lastActivity: io.clock, goal: 'changed' })], 15 * MIN, new AbortController().signal)
  expect(w.modelCalls.length).toBe(2)
})
