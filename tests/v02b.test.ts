// v0.2 Part B: the 「你不在时」 away summary — the window, its content, its card, its dismissal,
// and the decisions that count as waiting for the person.

import { expect, test } from './locale-test'

import type { Plan, SessionRec, SessionView, Snapshot } from '../types'
import { awayReportOf, newPlan, waitingItems } from '../hooks/model'
import { seedPlan, world } from './world'

const NOW = 1_800_000_000_000
const HOME = '/h'
const HOUR = 3600_000
const MIN = 60_000
const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: '进度', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

function session(over: Partial<SessionRec> = {}): SessionRec {
  return {
    v: 1, id: 's1', kind: 'normal', startedAt: NOW - 8 * HOUR, cwd: '/w/acme', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW - 8 * HOUR, limits: [], ...over,
  }
}
function view(s: SessionRec, over: Partial<SessionView> = {}): SessionView {
  return { ...s, isAlive: true, isSelf: s.id === 's1', cwdMissing: false, attribution: { confident: [], speculative: [] }, ...over }
}
function plan(over: Partial<Plan> = {}): Plan {
  return {
    ...newPlan({ id: 'acme/v2', title: 'v2 发布', goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['a', 'b'] }], includeRelease: false, by: 'x', now: NOW - 10 * HOUR }),
    status: 'active', ...over,
  }
}
const sessionJson = (w: ReturnType<typeof world>): SessionRec =>
  JSON.parse(w.files.get(`${HOME}/.claude/progress-board/sessions/s1.json`)?.text ?? '{}') as SessionRec
function seedSession(w: ReturnType<typeof world>, rec: SessionRec): void {
  const dir = `${HOME}/.claude/progress-board/sessions`
  w.dirs.add(`${HOME}/.claude/progress-board`)
  w.dirs.add(dir)
  w.files.set(`${dir}/${rec.id}.json`, { text: JSON.stringify(rec), m: NOW })
}

// ---- the window ----

test('B an away window starts at the last prompt when the person comes back after 30 minutes', async ($, on) => {
  const w = world(on)
  seedSession(w, session({ lastUserInput: NOW - 8 * HOUR, lastActivity: NOW - 8 * HOUR }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('tool.call', () => ({ result: {} }))
  await $.prompt.submit({ text: '我回来了，进度如何', origin: { kind: 'composer' } } as never)
  const rec = sessionJson(w)
  expect(rec.away?.from).toBe(NOW - 8 * HOUR)
  expect(rec.away?.to).toBe(NOW)
  // A short gap records nothing.
  await $.prompt.submit({ text: '再看一眼', origin: { kind: 'composer' } } as never)
  expect(sessionJson(w).away?.to).toBe(NOW)
})

// ---- the report ----

test('B the report lists items done, steps ticked and decisions taken in the window', async () => {
  const from = NOW - 8 * HOUR
  const p = plan()
  const items = p.phases[0]?.items ?? []
  if (items[0]) { items[0].status = 'done'; items[0].doneAt = NOW - 6 * HOUR }
  if (items[1]) { items[1].status = 'done'; items[1].doneAt = NOW - 20 * HOUR } // before the window
  const me = view(session({
    away: { from, to: NOW },
    stepLog: [{ title: '跑测试', at: NOW - 5 * HOUR }, { title: '很早的步骤', at: NOW - 20 * HOUR }],
    decided: [{ text: '选了 SQLite 存储', reversible: true, undo: '改回 JSON 文件', at: NOW - 4 * HOUR }, { text: '很久以前', reversible: false, at: NOW - 30 * HOUR }],
  }))
  const other = view(session({ id: 's2', goal: '后端', decided: [{ text: '挪了 UAT', reversible: false, at: NOW - 2 * HOUR }] }), { isSelf: false })
  const r = awayReportOf(me, [p], [me, other], p.id)
  expect(r).not.toBeNull()
  expect(r?.items.map(i => i.item)).toEqual(['a'])
  expect(r?.steps).toEqual([{ session: 's1', name: expect.any(String) as unknown as string, titles: ['跑测试'] }])
  expect(r?.decisions.map(d => d.text)).toEqual(['选了 SQLite 存储', '挪了 UAT'])
  expect(r?.decisions[0]?.reversible).toBe(true)
  expect(r?.decisions[0]?.undo).toBe('改回 JSON 文件')
  // A dismissed window draws nothing.
  expect(awayReportOf(view(session({ away: { from, to: NOW, dismissedAt: NOW } })), [p], [me])).toBeNull()
})

// ---- waiting ----

test('B decisions made while away count as waiting until the card is dismissed', async () => {
  const from = NOW - 8 * HOUR
  const me = view(session({
    away: { from, to: NOW },
    decided: [{ text: '选了兜底模型', reversible: true, undo: '改回', at: NOW - 3 * HOUR }],
  }))
  const w = waitingItems([], [me])
  expect(w.filter(x => x.kind === 'decision').length).toBe(1)
  const dismissed = view(session({
    away: { from, to: NOW, dismissedAt: NOW },
    decided: [{ text: '选了兜底模型', reversible: true, undo: '改回', at: NOW - 3 * HOUR }],
  }))
  expect(waitingItems([], [dismissed]).filter(x => x.kind === 'decision').length).toBe(0)
})

// ---- the card and its dismissal ----

test('B the panel shows the away card above the waiting card; d dismisses it', async ($, on) => {
  const w = world(on)
  seedSession(w, session({ goal: '整合三个仓库', lastUserInput: NOW - 8 * HOUR, lastActivity: NOW - 8 * HOUR }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  seedPlan(w, HOME, {
    ...newPlan({ id: 'acme/v2', title: 'v2 发布', goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['a'] }], includeRelease: false, by: 'x', now: NOW - 10 * HOUR }),
    status: 'active',
  })
  await $.tool.call({
    tool: 'mcp__progress-board__progress_session',
    decided: [{ text: '选了 SQLite 存储', reversible: true, undo: '改回 JSON 文件' }, { text: '挪了 UAT 到明天', reversible: false }],
  } as never)
  await $.prompt.submit({ text: '我回来了，进度如何', origin: { kind: 'composer' } } as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  let ui = await $.ui.mount(PANE)
  const text = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')
  let t = await text()
  expect(t).toContain('你不在时（')
  expect(t).toContain('替你定了 2 件')
  expect(t).toContain('可撤回：改回 JSON 文件')
  expect(t).toContain('不可撤回')
  expect(t).toContain('等你 ')
  await ui.press({ plugin: 'progress-board', key: 'away-dismiss' })
  await w.clock.advance(2000)
  await ui.unmount()
  ui = await $.ui.mount(PANE)
  t = await text()
  expect(t).not.toContain('你不在时（')
  expect(t).not.toContain('替你定了 2 件')
  await ui.unmount()
})

void MIN
