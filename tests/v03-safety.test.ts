import { expect, test } from './locale-test'
import type { SessionView } from '../types'
import { pollFacts } from '../hooks/facts'
import { monitorDigest, runMonitor } from '../hooks/monitor'
import { Paths } from '../hooks/store'
import { MemIo } from './memio'
import { isolatedMonitorEngine, seedPlan, world } from './world'
import { claim, NOW, PLAN, plan, planDir, savedPlan, seedSession, session } from './v03-fixtures'

const MIN = 60_000
const reply = { isAnswered: true as const, text: JSON.stringify({ suggestions: [{ item: 'p1-1', status: 'wrapping', reason: '代码交回', evidence: '任务完成通知' }] }), usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
function view(id: string): SessionView {
  return { ...session({ id, claims: [claim()], repoRoot: '/w/acme', repoKey: 'acme' }), isSelf: id === 's1', isAlive: true, cwdMissing: false, attribution: { confident: [{ plan: PLAN, source: 'claim' }], speculative: [] } }
}

test('V03 safety concurrent sessions reserve one PR check and one monitor run', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const io = new MemIo(); io.clock = NOW
  const paths = Paths.forHome('/h')
  const p = plan(); p.phases[0]!.items[0]!.refs = { pr: [{ repo: 'acme/app', number: 7 }] }
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  w.processReply = argv => argv[0] === 'gh' ? { exitCode: 0, stdout: '{"state":"MERGED","mergedAt":"today","isDraft":false}', stderr: '' } : undefined
  const sessions = [view('s1'), view('s2')]
  const engine = isolatedMonitorEngine(w)
  await Promise.all([pollFacts(engine, io, paths, PLAN, sessions, () => false), pollFacts(engine, io, paths, PLAN, sessions, () => false)])
  await Promise.all([runMonitor(engine, io, paths, PLAN, 's1', sessions, 15 * MIN, new AbortController().signal), runMonitor(engine, io, paths, PLAN, 's2', sessions, 15 * MIN, new AbortController().signal)])
  expect(w.processCalls.filter(c => c.argv[0] === 'gh').length).toBe(1)
  expect(JSON.parse((await io.read(paths.planJson(PLAN)))!).phases[0].items[0].status).toBe('wrapping')
  expect(w.modelCalls.length).toBe(1)
})

test('V03 safety subagent-only activity never starts the monitor; a main loop can', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, { coarseClock: true })
  seedPlan(w, '/h', plan()); seedSession(w, session({ envPlan: PLAN }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'child' } as never)
  await w.clock.advance(15 * MIN); expect(w.modelCalls.length).toBe(0)
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  await w.clock.advance(15 * MIN); expect(w.modelCalls.length).toBe(1)
})

test('V03 safety missing interactive surface suppresses the monitor until a surface appears', { timeoutMs: 20000 }, async ($, on) => {
  const surfaces: string[] = []
  const w = world(on, { surfaces, coarseClock: true })
  seedPlan(w, '/h', plan()); seedSession(w, session({ envPlan: PLAN }))
  on('tool.call', () => ({ result: {} }))
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN); expect(w.modelCalls.length).toBe(0)
  surfaces.push('terminal')
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  await w.clock.advance(15 * MIN); expect(w.modelCalls.length).toBe(1)
})

test('V03 safety session end aborts an in-flight monitor and discards its late suggestions', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, { coarseClock: true })
  seedPlan(w, '/h', plan()); seedSession(w, session({ envPlan: PLAN }))
  on('session.end', () => ({ sessionId: 's1' }))
  w.modelReply = async () => {
    await $.session.end({ sessionId: 's1', reason: 'exit' } as never)
    return reply
  }
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN)
  expect(w.modelCalls.length).toBe(1)
  expect(w.files.has(`${planDir}/suggestions.json`)).toBe(false)
  expect(savedPlan(w).phases[0]!.items[0]!.status).toBe('todo')
})

test('V03 safety suggestions go to the session with most claims only when there is no orchestrator', async ($, on) => {
  const w = world(on, { coarseClock: true })
  seedPlan(w, '/h', plan())
  seedSession(w, session({ claims: [claim()] }))
  seedSession(w, session({ id: 's2', claims: [claim(), claim('p1-2')] }))
  w.files.set(`${planDir}/suggestions.json`, { text: JSON.stringify([{ ...JSON.parse(reply.text).suggestions[0], id: 'suggestion-1', created: NOW, by: 'monitor', state: 'open', cost: {} }]), m: NOW })
  on('tool.call', () => ({ result: {} }))
  expect((await $.tool.call({ tool: 'Read', file_path: '/a' } as never)).context?.join('') ?? '').not.toContain('check suggestions')
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', claim: [claim('p1-2'), claim('p1-3')] } as never)
  expect((await $.tool.call({ tool: 'Read', file_path: '/a' } as never)).context?.join('')).toContain('check suggestions')
})

test('V03 safety digest bounds oversized plan metadata as well as items', async () => {
  const p = plan({ milestones: Array.from({ length: 100 }, () => 'long milestone '.repeat(100)) })
  const digest = monitorDigest(p, [view('s1')], {})
  expect(digest.length <= 12000).toBe(true)
  expect(JSON.parse(digest).omitted > 0).toBe(true)
})
