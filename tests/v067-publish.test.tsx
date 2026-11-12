// A machine with many sessions built a 7 MB snapshot; the host refuses a state value over 4,194,304
// characters, so the snapshot never published and the pane stayed on "no data yet".
import { expect, enTest as test } from './locale-test'
import { world } from './world'
import { publishable, PUBLISH_BUDGET } from '../hooks/publish'
import type { SessionView, Snapshot } from '../types'

const NOW = 1_800_000_000_000
const DAY = 24 * 3600_000

function session(id: string, over: Record<string, unknown> = {}): SessionView {
  return {
    v: 1, id, kind: 'normal', startedAt: NOW - DAY, cwd: '/w', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW - DAY, lastUserInput: NOW - DAY, limits: [],
    isAlive: true, isSelf: false, cwdMissing: false, attribution: { confident: [], speculative: [] }, ...over,
  } as unknown as SessionView
}
const snapOf = (sessions: SessionView[]): Snapshot =>
  ({ now: NOW, selfId: 'self', focusPlan: null, repoPlans: [], plans: [], sessions, waiting: [], recent: [] })
const filler = (n: number) => 'x'.repeat(n)

test('V067 the published snapshot drops fields no drawing reads and events older than a week', async () => {
  const s = session('a', {
    messages: [{ text: filler(100) }], waitingState: { x: 1 }, stepLog: [{ at: NOW }], ownQuotes: [{ text: 'q' }],
    activityEvents: [{ at: NOW - 8 * DAY, text: 'old' }, { at: NOW - DAY, text: 'new' }],
  })
  const out = publishable(snapOf([s]))!.sessions[0] as SessionView & Record<string, unknown>
  for (const key of ['messages', 'waitingState', 'stepLog', 'ownQuotes']) expect(key in out).toBe(false)
  expect(out.activityEvents?.map(e => e.text)).toEqual(['new'])
})

test('V067 an oversized snapshot fits the budget by dropping the longest-ended sessions first', async () => {
  const self = session('self', { isSelf: true, steps: [{ title: filler(1000), status: 'doing' }] })
  const live = session('live', { steps: [{ title: filler(1000), status: 'doing' }] })
  const ended = Array.from({ length: 1000 }, (_, i) => session(`e${i}`, {
    isAlive: false, endedAt: NOW - DAY + i, steps: [{ title: filler(7000), status: 'done' }],
  }))
  const big = snapOf([self, live, ...ended])
  expect(JSON.stringify(big).length).toBeGreaterThan(7_000_000)
  const started = Date.now()
  const out = publishable(big)!
  expect(Date.now() - started).toBeLessThan(3000)
  expect(JSON.stringify(out).length).toBeLessThanOrEqual(PUBLISH_BUDGET)
  const ids = new Set(out.sessions.map(s => s.id))
  expect(ids.has('self')).toBe(true)
  expect(ids.has('live')).toBe(true)
  expect(ids.has('e0')).toBe(false)
  expect(ids.has('e999')).toBe(true)
})

test('V067 a small snapshot keeps every session', async () => {
  const out = publishable(snapOf([session('self', { isSelf: true }), session('x', { isAlive: false, endedAt: NOW - DAY })]))!
  expect(out.sessions.map(s => s.id)).toEqual(['self', 'x'])
})

test('V067 a refresh that cannot publish shows why on the pane', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }))
  on('state.set', async (_, e, next) => {
    const ev = e as { key?: string; ref?: { key: string } }
    if ((ev.key ?? ev.ref?.key) === 'snapshot') return { deny: 'the value is over the limit' } as never
    return next(e)
  })
  await $.session.start({ sessionId: 's1', cwd: '/w', isInteractive: true, isResume: false } as never)
  await w.clock.settle()
  const ui = await $.ui.mount({
    plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
    props: { title: 'progress', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  await w.clock.settle()
  const text = (await ui.findAll({ type: 'Text' })).map((t: { text?: string }) => t.text ?? '').join('\n')
  expect(text).toContain('Refresh failed at publish')
  expect(text).toContain('over the limit')
  await ui.unmount()
})

test('V067 the activity list counts toward the budget and keeps its newest rows', async () => {
  const live = Array.from({ length: 3 }, (_, i) => session(`s${i}`, { isSelf: i === 0 }))
  const activity = Array.from({ length: 13_500 }, (_, i) => ({ id: `a${i}`, at: NOW - i, by: 'x', kind: 'event', verb: 'updated', text: filler(240) }))
  const big = { ...snapOf(live), activity } as unknown as Snapshot
  expect(JSON.stringify(big).length).toBeGreaterThan(4_194_304)
  const out = publishable(big)! as Snapshot & { activity: { id: string }[] }
  expect(JSON.stringify(out).length).toBeLessThanOrEqual(PUBLISH_BUDGET)
  expect(out.activity[0]!.id).toBe('a0')
  expect(out.activity.length).toBeGreaterThanOrEqual(40)
})

test('V067 trimming background history never cuts a running task', async () => {
  const bg = [{ id: 'running', kind: 'agent', name: 'long', startedAt: NOW - 1000 },
    ...Array.from({ length: 10_000 }, (_, i) => ({ id: `b${i}`, kind: 'bash', name: filler(240), startedAt: NOW - 1000, endedAt: NOW }))]
  const out = publishable(snapOf([session('self', { isSelf: true, bg })]))!
  const kept = out.sessions[0]!.bg
  expect(kept.filter(b => b.endedAt === undefined).map(b => b.id)).toEqual(['running'])
  expect(JSON.stringify(out).length).toBeLessThanOrEqual(PUBLISH_BUDGET)
})
