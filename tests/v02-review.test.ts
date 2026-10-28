// Reviewer probes: each test asserts the CORRECT behaviour; a failure confirms a defect.

import { expect, test } from './locale-test'

import type { Plan, SessionRec, SessionView } from '../types'
import { worktreePhaseOf } from '../hooks/attrib'
import { changeItem, dispatchItemOf, newPlan, waitingItems } from '../hooks/model'
import { normQuestion, parsePastTime } from '../hooks/util'
import { seedPlan, world } from './world'

const NOW = 1_800_000_000_000
const HOME = '/h'
const MIN = 60_000
const HOUR = 60 * MIN
const DIR = `${HOME}/.claude/progress-board/sessions`

function session(over: Partial<SessionRec> = {}): SessionRec {
  return {
    v: 1, id: 's1', kind: 'normal', startedAt: NOW - 10 * HOUR, cwd: '/w/acme', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [], ...over,
  }
}
function view(s: SessionRec, over: Partial<SessionView> = {}): SessionView {
  return { ...s, isAlive: true, isSelf: s.id === 's1', cwdMissing: false, attribution: { confident: [], speculative: [] }, ...over }
}
const json = (w: ReturnType<typeof world>, id = 's1'): SessionRec => JSON.parse(w.files.get(`${DIR}/${id}.json`)?.text ?? '{}') as SessionRec
function seed(w: ReturnType<typeof world>, rec: SessionRec): void {
  w.dirs.add(`${HOME}/.claude/progress-board`); w.dirs.add(DIR)
  w.files.set(`${DIR}/${rec.id}.json`, { text: JSON.stringify(rec), m: NOW })
}
const activePlan = (id: string, over: Partial<Plan> = {}): Plan => ({
  ...newPlan({ id, goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['a', 'b'] }], includeRelease: false, by: 'x', now: NOW }),
  status: 'active', ...over,
})

test('P1 answering q1 in one session must not hide another session’s different q1', async () => {
  const a = view(session({ asks: [{ id: 'q1', question: '用哪个库？', at: NOW }], answered: ['q1'] }))
  const b = view(session({ id: 's2', asks: [{ id: 'q1', question: '要不要今晚发版？', at: NOW }] }), { isSelf: false })
  expect(waitingItems([], [a, b]).filter(x => x.kind === 'ask').length).toBe(1)
})

test('P2 an answer must survive the answering session ending', async () => {
  const a = view(session({ asks: [{ id: 'q1', question: '用哪个库？', at: NOW }], answered: [normQuestion('用哪个库？')] }), { isAlive: false, endedAt: NOW, isSelf: false })
  const b = view(session({ id: 's2', asks: [{ id: 'q1', question: '用哪个库', at: NOW }] }), { isSelf: true })
  expect(waitingItems([], [a, b]).filter(x => x.kind === 'ask').length).toBe(0)
})

test('P3 a task-notification while away must not erase the away window', async ($, on) => {
  const w = world(on)
  seed(w, session({ lastUserInput: NOW - 8 * HOUR, lastActivity: NOW - 8 * HOUR }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('tool.call', () => ({ result: {} }))
  await $.prompt.submit({ text: '<task-notification>agent done</task-notification>', origin: { kind: 'task-notification' } } as never)

  await $.prompt.submit({ text: '我回来了，进度如何', origin: { kind: 'composer' } } as never)
  expect(json(w).away).toBeDefined()
  expect(json(w).away?.from).toBe(NOW - 8 * HOUR)
})

test('P4 a stale leave-authorization time must not stretch a later window', async ($, on) => {
  const w = world(on)
  seed(w, session({ lastUserInput: NOW - 1 * HOUR, lastActivity: NOW - 1 * HOUR, awayAuthAt: NOW - 48 * HOUR }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('tool.call', () => ({ result: {} }))
  await $.prompt.submit({ text: '我回来了，进度如何', origin: { kind: 'composer' } } as never)
  expect(json(w).away?.from).toBe(NOW - 1 * HOUR)
})

test('P5 worktree v1.43 must not be attributed to plan v1.4', async () => {
  const phases = Array.from({ length: 5 }, (_, i) => ({ id: `p${i + 1}`, name: `阶段 ${i + 1}`, addedAt: NOW, items: [] }))
  const p14 = { ...activePlan('x/v1.4'), phases }
  expect(worktreePhaseOf('/w/agent-v143-p3', [p14])).toBeUndefined()
})

test('P6 dispatch naming a finished item and the target picks the target', async () => {
  const plan = activePlan('acme/v1', { phases: [{ id: 'p1', name: 'A', addedAt: NOW, items: [
    { id: 'p1-1', title: 'a', status: 'done', updatedAt: NOW, doneAt: NOW },
    { id: 'p1-2', title: 'b', status: 'todo', updatedAt: NOW },
  ] }] })
  expect(dispatchItemOf('p1-1 已合并；现在实现 p1-2', [plan], ['acme/v1'])?.item).toBe('p1-2')
})

test('P7 reverting done → todo must not keep every milestone passed', async () => {
  let plan = activePlan('acme/v1', { milestones: ['PR', 'CI', '合并'] })
  const r1 = changeItem(plan, undefined, 'p1-1', { status: 'done', meetsCriteria: true }, NOW)
  if ('error' in r1) throw new Error(r1.error)
  plan = r1.plan
  const r2 = changeItem(plan, undefined, 'p1-1', { status: 'todo', reason: '回归' }, NOW)
  if ('error' in r2) throw new Error(r2.error)
  const it = r2.plan.phases[0]?.items[0]
  expect(it?.milestone).not.toBe(3)
})

test('P8 epoch seconds are not silently read as 1970 ms', async () => {
  expect('error' in parsePastTime(1_761_500_000, NOW)).toBe(true)
})

test('P9 re-asking an answered question in the same session queues it again', async ($, on) => {
  const w = world(on)
  seed(w, session({ asks: [{ id: 'q1', question: '用哪个库？', at: NOW - HOUR }], askSeq: 1, answered: ['q1'] }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', ask_user: [{ question: '用哪个库？' }] } as never)
  const s = json(w)
  expect(waitingItems([], [view(s)]).filter(x => x.kind === 'ask').length).toBe(1)
})

test('P10 an async agent whose end is seen only by Stop releases its claim', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/v1'))
  on('tool.call', (_, e) => (e.tool === 'Agent' ? { result: { status: 'async_launched', agentId: 'a9' } } : { result: {} }) as never)
  on('classic.Stop', () => ({}) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '统筹', claim: [{ plan: 'acme/v1' }] } as never)
  await $.tool.call({ tool: 'Agent', description: '实现 p1-2', prompt: '做 p1-2' } as never)
  expect(json(w).claims.some(c => c.item === 'p1-2')).toBe(true)
  await $.classic.Stop({ background_tasks: [] } as never)
  expect(json(w).claims.some(c => c.item === 'p1-2')).toBe(false)
})

test('P11 a short title must not be claimed from a long prompt that merely contains it', async () => {
  const plan = activePlan('acme/v1', { phases: [{ id: 'p1', name: 'A', addedAt: NOW, items: [{ id: 'p1-1', title: '测试', status: 'todo', updatedAt: NOW }] }] })
  expect(dispatchItemOf('读一下仓库，跑测试看看有没有回归', [plan], ['acme/v1'])).toBeUndefined()
})
