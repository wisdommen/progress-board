// Review regressions beyond the original probes: exercise realistic session ids and hook boundaries.

import { expect, test } from './locale-test'
import type { Plan, SessionRec, SessionView } from '../types'
import { awayReportOf, changeItem, dispatchItemOf, newPlan, waitingItems } from '../hooks/model'
import { worktreePhaseOf } from '../hooks/attrib'
import { mmddhhmm, parsePastTime } from '../hooks/util'
import { Paths } from '../hooks/store'
import { runPlanTool } from '../hooks/tools'
import { MemIo } from './memio'
import { seedPlan, world } from './world'

const NOW = 1_800_000_000_000
const HOUR = 3600_000
const HOME = '/h'
const DIR = `${HOME}/.claude/progress-board/sessions`
const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: '进度', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
function session(over: Partial<SessionRec> = {}): SessionRec {
  return { v: 1, id: 's1', kind: 'normal', startedAt: NOW - 10 * HOUR, cwd: '/w/acme', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [], ...over }
}
function view(s: SessionRec): SessionView {
  return { ...s, isAlive: s.endedAt === undefined, isSelf: s.id === 's1', cwdMissing: false, attribution: { confident: [], speculative: [] } }
}
function plan(id = 'acme/v1', over: Partial<Plan> = {}): Plan {
  return { ...newPlan({ id, goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['实现登录验证', '完善错误处理'] }], includeRelease: false, by: 'x', now: NOW }), status: 'active', ...over }
}
function seed(w: ReturnType<typeof world>, s: SessionRec): void {
  w.dirs.add(DIR)
  w.files.set(`${DIR}/${s.id}.json`, { text: JSON.stringify(s), m: NOW })
}
function saved(w: ReturnType<typeof world>): SessionRec {
  return JSON.parse(w.files.get(`${DIR}/s1.json`)?.text ?? '{}') as SessionRec
}

test('CR-01 peer and scheduled prompts preserve the last own input and away start', async ($, on) => {
  const w = world(on)
  seed(w, session({ lastUserInput: NOW - 8 * HOUR }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  for (const kind of ['task-notification', 'peer', 'scheduled-trigger']) {
    await $.prompt.submit({ text: '后台任务已交回', origin: { kind } } as never)
    expect(saved(w).lastUserInput).toBe(NOW - 8 * HOUR)
  }
  await $.prompt.submit({ text: '我回来了', origin: { kind: 'composer' } } as never)
  expect(saved(w).away?.from).toBe(NOW - 8 * HOUR)
  expect(saved(w).lastUserInput).toBe(NOW)
})

test('CR-02 an answer id is not also a global question text', async () => {
  const a = view(session({ answered: ['q1'] }))
  const b = view(session({ id: 's2', asks: [{ id: 'q2', question: 'q1', at: NOW }] }))
  expect(waitingItems([], [a, b]).filter(x => x.kind === 'ask').length).toBe(1)
})

test('CR-03 an idle failed mutation never records an authorization anchor', async ($, on) => {
  const w = world(on)
  seed(w, session({ lastUserInput: NOW - HOUR }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'confirm', plan: 'missing/v1' } as never)
  expect(saved(w).awayAuthAt).toBeUndefined()
})

test('WR-01 retained answers from invisible ended sessions still clear peer asks in the panel', async ($, on) => {
  const w = world(on)
  seed(w, session({ id: 'ended', endedAt: NOW - 48 * HOUR, answered: ['用哪个库'], lastActivity: NOW - 48 * HOUR }))
  seed(w, session({ goal: '继续实现', asks: [{ id: 'q1', question: '用哪个库？', at: NOW - 50 * HOUR }] }))
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const text = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(text).not.toContain('等你拍板')
  await ui.unmount()
})

test('WR-02 dispatch refuses multiple live items and repeated ids across plans', async () => {
  const p = plan()
  expect(dispatchItemOf('p1-2 依赖 p1-1', [p], [p.id])).toBeUndefined()
  const other = plan('other/v1')
  expect(dispatchItemOf('实现 p1-1', [p, other], [p.id, other.id])).toBeUndefined()
  p.phases[0]!.items[0]!.status = 'void'
  expect(dispatchItemOf('p1-1 作废；实现 p1-2', [p], [p.id])?.item).toBe('p1-2')
})

test('WR-02 dispatch description wins over dependency ids in the prompt', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, plan())
  on('tool.call', (_, e) => ({ result: e.tool === 'Agent' ? { status: 'async_launched', agentId: 'a9' } : {} }) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '统筹', claim: [{ plan: 'acme/v1' }] } as never)
  await $.tool.call({ tool: 'Agent', description: '实现 p1-2', prompt: 'p1-1 是依赖，当前实现 p1-2' } as never)
  expect(saved(w).claims.filter(c => c.by).map(c => c.item)).toEqual(['p1-2'])
})

test('WR-03 title matching requires width and a unique live target', async () => {
  const p = plan()
  expect(dispatchItemOf('实现登录验证，然后完善错误处理', [p], [p.id])).toBeUndefined()
  p.phases[0]!.items[0]!.status = 'done'
  expect(dispatchItemOf('实现登录验证', [p], [p.id])).toBeUndefined()
  for (const title of ['测试', '文档', 'CI']) {
    p.phases[0]!.items[1]!.title = title
    expect(dispatchItemOf(`阅读仓库并检查${title}`, [p], [p.id])).toBeUndefined()
  }
})

test('WR-04 Stop completes and releases each agent once, keeping live agents', async ($, on) => {
  const w = world(on)
  const c = { plan: 'acme/v1', phase: 'p1', item: 'p1-1', at: NOW, source: 'claim' as const, by: '实现' }
  seed(w, session({ claims: [c], bg: [{ id: 't1', taskId: 'a1', name: '实现', kind: 'agent', startedAt: NOW, claim: c }], dispatched: 1 }))
  on('classic.Stop', () => ({}) as never)
  on('classic.SubagentStop', () => ({}) as never)
  await $.classic.Stop({ background_tasks: [{ id: 'a1', description: '实现' }] } as never)
  expect(saved(w).agentsDone).toBe(0)
  await $.classic.Stop({ background_tasks: [] } as never)
  expect(saved(w).agentsDone).toBe(1)
  expect(saved(w).claims.length).toBe(0)
  await $.classic.SubagentStop({ agent_id: 'a1' } as never)
  await $.classic.Stop({ background_tasks: [] } as never)
  expect(saved(w).agentsDone).toBe(1)
})

test('WR-04 session end releases dispatch claims but preserves ordinary claims', async ($, on) => {
  const w = world(on)
  const c = { plan: 'acme/v1', phase: 'p1', item: 'p1-1', at: NOW, source: 'claim' as const, by: '实现' }
  seed(w, session({ claims: [{ plan: 'acme/v1', at: NOW, source: 'claim' }, c], bg: [{ id: 't1', name: '实现', kind: 'agent', startedAt: NOW, claim: c }] }))
  on('tool.call', () => ({ result: {} }))
  on('session.end', () => ({ sessionId: 's1' }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '统筹' } as never)
  await $.session.end({ sessionId: 's1', reason: 'clear' } as never)
  expect(saved(w).claims.map(c => c.by)).toEqual([undefined])
})

test('WR-05 worktree phase name and id both match; ambiguous plans or phases do not', async () => {
  const p = plan('x/v1.43', { phases: [{ id: 'p4', name: '17 实现', addedAt: NOW, items: [] }] })
  expect(worktreePhaseOf('/w/agent-v143-p17', [p])).toEqual({ plan: p.id, phase: 'p4' })
  expect(worktreePhaseOf('/w/agent-v143-p4', [p])).toEqual({ plan: p.id, phase: 'p4' })
  expect(worktreePhaseOf('/w/agent-v143-p17', [p, { ...p, id: 'y/v1.43' }])).toBeUndefined()
  expect(worktreePhaseOf('/w/agent-v143-p17', [{ ...p, phases: [...p.phases, { id: 'p17', name: '其他', addedAt: NOW, items: [] }] }])).toBeUndefined()
  expect(worktreePhaseOf('/w/agent-v1433-p4', [p])).toBeUndefined()
  expect(worktreePhaseOf('/w/agent-v143-p4x', [p])).toBeUndefined()
})

test('WR-06 reopening restores the pre-done milestone and done cannot lower its milestone', async () => {
  const p = plan('acme/v1', { milestones: ['PR', 'CI', '合并'] })
  p.phases[0]!.items[0]!.milestone = 1
  const done = changeItem(p, undefined, 'p1-1', { status: 'done', meetsCriteria: true }, NOW)
  if ('error' in done) throw new Error(done.error)
  const back = changeItem(done.plan, undefined, 'p1-1', { status: 'wrapping', reason: '回归' }, NOW)
  if ('error' in back) throw new Error(back.error)
  expect(back.plan.phases[0]?.items[0]?.milestone).toBe(1)
  const invalid = changeItem(done.plan, undefined, 'p1-1', { status: 'done', milestone: 1, reason: '退回', meetsCriteria: true }, NOW)
  expect('error' in invalid).toBe(true)
  const explicit = changeItem(done.plan, undefined, 'p1-1', { status: 'todo', milestone: 2, reason: '退回' }, NOW)
  if ('error' in explicit) throw new Error(explicit.error)
  expect(explicit.plan.phases[0]?.items[0]?.milestone).toBe(2)
})

test('WR-07 timestamps before 2000 including seconds and year strings are rejected', async () => {
  for (const value of [1_761_500_000, '1761500000', '2026', 0, '1999-12-31T23:59:59Z']) expect('error' in parsePastTime(value, NOW)).toBe(true)
  expect(parsePastTime('2000-01-01T00:00:00Z', NOW)).toEqual({ at: 946684800000 })
  expect(parsePastTime(NOW - HOUR, NOW)).toEqual({ at: NOW - HOUR })
})

test('WR-08 text-answered questions can be requeued and answered again', async ($, on) => {
  const w = world(on)
  seed(w, session({ asks: [{ id: 'q1', question: '用哪个库？', at: NOW - HOUR }], askSeq: 1, answered: ['用哪个库'] }))
  on('tool.call', (_, e) => ({ result: e.tool === 'AskUserQuestion' ? { answers: { '用哪个库？': 'sqlite' } } : {} }) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', ask_user: [{ question: '用哪个库？' }] } as never)
  expect(waitingItems([], [view(saved(w))]).filter(x => x.kind === 'ask').length).toBe(1)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: '用哪个库？', header: '库', options: [], multiSelect: false }] } as never)
  expect(waitingItems([], [view(saved(w))]).filter(x => x.kind === 'ask').length).toBe(0)
})

test('WR-08 answered peer questions are not advertised as waiting or used to swallow a new ask', async ($, on) => {
  const w = world(on)
  const peer = session({ id: 's2', goal: '后端', asks: [{ id: 'q1', question: '用哪个库？', at: NOW - HOUR }], answered: ['用哪个库'] })
  seed(w, peer)
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_session', ask_user: [{ question: '用哪个库？' }] } as never)
  expect(String(r.result)).not.toContain('已在问同一问题')
  expect(waitingItems([], [view(saved(w)), view(peer)]).filter(x => x.kind === 'ask').length).toBe(1)
})

test('WR-09 a live question and its queued copy count only once', async () => {
  const s = view(session({ asks: [{ id: 'q1', question: '用哪个库？', at: NOW }], question: { text: ' 用哪个库 ', since: NOW } }))
  expect(waitingItems([], [s]).length).toBe(1)
  s.question!.text = '要发版吗？'
  expect(waitingItems([], [s]).length).toBe(2)
})

test('WR-09 answering a question longer than 300 characters clears its full queued text', async ($, on) => {
  const w = world(on)
  const question = '这是一段需要完整保留的问题背景。'.repeat(25) + '选哪个库？'
  seed(w, session({ goal: '实施', asks: [{ id: 'q1', question, at: NOW }] }))
  on('tool.call', () => ({ result: { answers: { [question]: 'sqlite' } } }) as never)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question, header: '库', options: [], multiSelect: false }] } as never)
  expect(waitingItems([], [view(saved(w))]).filter(x => x.kind === 'ask').length).toBe(0)
})

test('WR-10 the away report uses only active or done focused and own attributed plans', async () => {
  const complete = (id: string, status: Plan['status']): Plan => {
    const p = plan(id, { status })
    p.phases[0]!.items[0]!.status = 'done'; p.phases[0]!.items[0]!.doneAt = NOW - HOUR
    return p
  }
  const plans = [complete('focus/v1', 'active'), complete('own/v1', 'done'), complete('other/v1', 'active'), complete('draft/v1', 'draft'), complete('abandoned/v1', 'abandoned')]
  const self = view(session({ away: { from: NOW - 8 * HOUR, to: NOW }, lastPlan: 'focus/v1', claims: [{ plan: 'own/v1', at: NOW, source: 'claim' }] }))
  expect(awayReportOf(self, plans, [self])?.items.map(x => x.plan).sort()).toEqual(['focus/v1', 'own/v1'])
  self.claims = []; delete self.lastPlan
  expect(awayReportOf(self, plans, [self])?.items).toEqual([])
})

test('WR-11 a failed plan write or lost lock never releases the session claim', async () => {
  for (const fail of ['write', 'lock']) {
    const io = new MemIo(); io.clock = NOW
    const paths = Paths.forHome(HOME)
    const p = plan()
    io.files.set(paths.planJson(p.id), { text: JSON.stringify(p), m: NOW })
    const original = io.writeAtomic.bind(io)
    io.writeAtomic = async (path, text) => {
      if (path === paths.planJson(p.id) && fail === 'write') throw new Error('injected plan write failure')
      await original(path, text)
      if (path.endsWith('/.lock/owner') && fail === 'lock') io.files.set(path, { text: 'replacement-owner', m: NOW })
    }
    const c = { plan: p.id, phase: 'p1', item: 'p1-1', at: NOW, source: 'claim' as const }
    const self = session({ claims: [c] })
    const r = await runPlanTool({ action: 'set_item', plan: p.id, item: 'p1-1', status: 'done', meets_criteria: true }, {
      io, paths, sessionId: self.id, now: NOW, self, quoteFound: async () => false, touchRepos: async () => undefined, peerAsks: [],
    })
    expect(r.isError).toBe(true)
    expect(JSON.parse(io.files.get(paths.planJson(p.id))!.text).phases[0].items[0].status).toBe('todo')
    expect(self.claims).toEqual([c])
  }
})

test('WR-08 requeue keeps old peer asks settled and accepts a later shared text answer', async ($, on) => {
  const w = world(on)
  const question = '用哪个库？'
  seed(w, session({ goal: '实现', asks: [{ id: 'q1', question, at: NOW - HOUR }], askSeq: 1 }))
  const peer = session({ id: 's2', asks: [{ id: 'q1', question, at: NOW - HOUR }] })
  seed(w, peer)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', answered: [question] } as never)
  expect(waitingItems([], [view(saved(w)), view(peer)]).length).toBe(0)
  await w.clock.advance(2000)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', ask_user: [{ question }] } as never)
  const waiting = waitingItems([], [view(saved(w)), view(peer)])
  expect(waiting.length).toBe(1)
  expect(waiting[0]?.kind === 'ask' && waiting[0].also).toBe(0)
  await w.clock.advance(2000)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', answered: [question] } as never)
  expect(waitingItems([], [view(saved(w)), view(peer)]).length).toBe(0)
})

test('WR-10 panel away completions exclude unrelated plans', async ($, on) => {
  const w = world(on)
  for (const id of ['focus/v1', 'other/v1']) {
    const p = plan(id)
    p.phases[0]!.items[0]!.status = 'done'; p.phases[0]!.items[0]!.doneAt = NOW - HOUR
    seedPlan(w, HOME, p)
  }
  seed(w, session({ goal: '实现', lastPlan: 'focus/v1', away: { from: NOW - 8 * HOUR, to: NOW } }))
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const text = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(text).toContain('完成 1 条')
  expect(text).not.toContain('完成 2 条')
  await ui.unmount()
})

test('IN-02 a short overnight window shows dates too', async ($, on) => {
  const to = new Date(2027, 0, 16, 1, 0).getTime()
  const from = new Date(2027, 0, 15, 23, 0).getTime()
  const w = world(on, { now: to })
  seed(w, session({ goal: '实现', away: { from, to } }))
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const text = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(text).toContain(`你不在时（${mmddhhmm(from)}–${mmddhhmm(to)}`)
  await ui.unmount()
})

test('IN-02 the away card shows dates for a window spanning multiple days', async ($, on) => {
  const w = world(on)
  const from = NOW - 49 * HOUR
  seed(w, session({ goal: '实现', away: { from, to: NOW } }))
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const text = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(text).toContain(`你不在时（${mmddhhmm(from)}–${mmddhhmm(NOW)}`)
  await ui.unmount()
})
