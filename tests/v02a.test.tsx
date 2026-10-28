// v0.2 Part A: release wording, backfilled completions, auto release on done,
// auto-goal filtering, and the dispatch line for sessions without steps.

import { expect, test } from './locale-test'

import type { Plan, SessionRec, SessionView, Snapshot } from '../types'
import { buildBanner, rowText } from '../hooks/banner'
import { liveItemClaims, newPlan, waitingItems } from '../hooks/model'
import { autoGoalOf } from '../hooks/nudge'
import { sessionSpec } from '../hooks/tools'
import { seedPlan, world } from './world'

const NOW = 1_800_000_000_000
const HOME = '/h'
const SESSION_FILE = `${HOME}/.claude/progress-board/sessions/s1.json`
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'] as const, tools: [], outputStyle: null, traits: [] }
const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: '进度', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const activePlan = (id: string, over: Partial<Plan> = {}) => ({
  ...newPlan({ id, goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['a'] }], includeRelease: false, by: 'x', now: NOW }),
  status: 'active' as const, ...over,
})
const planJson = (w: ReturnType<typeof world>, id: string): Plan =>
  JSON.parse(w.files.get(`${HOME}/.claude/progress-board/plans/${encodeURIComponent(id)}/plan.json`)?.text ?? '{}') as Plan
const sessionJson = (w: ReturnType<typeof world>, id = 's1'): SessionRec =>
  JSON.parse(w.files.get(`${HOME}/.claude/progress-board/sessions/${id}.json`)?.text ?? '{}') as SessionRec

// ---- A1: release says 释放认领 ----

test('A1 releasing a claim says 释放认领, not 放弃', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/v1'))
  on('tool.call', () => ({ result: {} }))
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__progress-board__progress_session', ...input } as never) as Promise<{ result?: unknown }>
  await call({ claim: [{ plan: 'acme/v1', item: 'a' }] })
  const ok = await call({ release: [{ plan: 'acme/v1', item: 'a' }] })
  expect(String(ok.result)).toContain('释放认领')
  expect(String(ok.result)).not.toContain('放弃')
  const none = await call({ release: [{ plan: 'acme/v1', item: 'a' }] })
  expect(String(none.result)).toContain('没有可释放的认领')
})

// ---- A2: backfilled completions ----

test('A2 set_item takes done_at (ISO or epoch ms); it must not be in the future', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/v1', { phases: [
    { id: 'p1', name: 'A', addedAt: NOW, items: [
      { id: 'p1-1', title: 'a', status: 'todo', updatedAt: NOW },
      { id: 'p1-2', title: 'b', status: 'todo', updatedAt: NOW },
    ] },
  ] }))
  on('tool.call', () => ({ result: {} }))
  const set = (item: string, doneAt: unknown) => $.tool.call({
    tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: 'acme/v1', item, status: 'done', meets_criteria: true, done_at: doneAt,
  } as never) as Promise<{ result?: unknown }>
  const past = NOW - 3 * 3600_000
  await set('a', new Date(past).toISOString())
  expect(planJson(w, 'acme/v1').phases[0]?.items[0]?.doneAt).toBe(past)
  const r = await set('b', NOW + 3600_000)
  expect(String(r.result)).toContain('不能晚于现在')
  expect(planJson(w, 'acme/v1').phases[0]?.items[1]?.status).toBe('todo')
})

test('A2 propose accepts item objects with status done and done_at', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: {} }))
  const past = NOW - 86400_000
  await $.tool.call({
    tool: 'mcp__progress-board__progress_plan', action: 'propose', plan: 'acme/v9', goal: 'g', criteria: 'c',
    phases: [{ name: 'A', items: [{ title: 'old', status: 'done', done_at: past }, { title: 'new' }] }],
  } as never)
  const p = planJson(w, 'acme/v9')
  expect(p.phases[0]?.items[0]?.status).toBe('done')
  expect(p.phases[0]?.items[0]?.doneAt).toBe(past)
  expect(p.phases[0]?.items[1]?.status).toBe('todo')
  const bad = await $.tool.call({
    tool: 'mcp__progress-board__progress_plan', action: 'propose', plan: 'acme/v8', goal: 'g', criteria: 'c',
    phases: [{ name: 'A', items: [{ title: 'x', status: 'done', done_at: NOW + 1000 }] }],
  } as never) as { result?: unknown }
  expect(String(bad.result)).toContain('不能晚于现在')
})

test('A2 a backfilled completion is not listed as newly finished', async ($, on) => {
  const w = world(on)
  // Two phases: the current one (A) opens, so the title in B only shows in 最近完成.
  seedPlan(w, HOME, activePlan('acme/v1', { phases: [
    { id: 'p1', name: 'A', addedAt: NOW, items: [{ id: 'p1-1', title: 'one', status: 'todo', updatedAt: NOW }] },
    { id: 'p2', name: 'B', addedAt: NOW, items: [{ id: 'p2-1', title: '历史条目', status: 'todo', updatedAt: NOW }] },
  ] }))
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: 'g', claim: [{ plan: 'acme/v1' }] } as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: 'acme/v1', item: 'p2-1', status: 'done', meets_criteria: true, done_at: NOW - 86400_000 } as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')
  expect(all).not.toContain('历史条目')
  await ui.unmount()
})

// ---- A3: done auto-releases the claim ----

test('A3 marking an item done releases this session’s claim and says so', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/v1'))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: 'g', claim: [{ plan: 'acme/v1', item: 'a' }] } as never)
  expect(sessionJson(w).claims.length).toBe(1)
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: 'acme/v1', item: 'a', status: 'done', meets_criteria: true } as never) as { result?: unknown }
  expect(String(r.result)).toContain('释放')
  expect(sessionJson(w).claims).toEqual([])
  // A void releases it too.
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', claim: [{ plan: 'acme/v1', item: 'b' }] } as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: 'acme/v1', item: 'b', status: 'void', reason: '不做了' } as never)
  expect(sessionJson(w).claims).toEqual([])
})

test('A3 another session’s claim on a done item is not drawn', async () => {
  const plan = activePlan('acme/v1', { phases: [{ id: 'p1', name: 'A', addedAt: NOW, items: [
    { id: 'p1-1', title: 'a', status: 'done', doneAt: NOW - 1000, updatedAt: NOW },
    { id: 'p1-2', title: 'b', status: 'todo', updatedAt: NOW },
  ] }] })
  const claims = [
    { plan: 'acme/v1', phase: 'p1', item: 'p1-1', at: NOW, source: 'claim' as const },
    { plan: 'acme/v1', phase: 'p1', item: 'p1-2', at: NOW, source: 'claim' as const },
  ]
  expect(liveItemClaims(claims, [plan])).toEqual([claims[1]])
})

test('A3 the progress_session description says done releases the claim; no step for it', async () => {
  expect(sessionSpec.description).toContain('release automatically')
})

// ---- A4: the provisional goal skips short, notice and injected messages ----

test('A4 a short first line, a notice line or a tool-injected text is not a provisional goal', async () => {
  expect(autoGoalOf({ text: '继续' })).toBeUndefined()
  expect(autoGoalOf({ text: '1' })).toBeUndefined()
  expect(autoGoalOf({ text: '好' })).toBeUndefined()
  expect(autoGoalOf({ text: '读交接文件' })).toBe('读交接文件')
  expect(autoGoalOf({ text: '<task-notification>done</task-notification>' })).toBeUndefined()
  expect(autoGoalOf({ text: '把登录超时修好', origin: { kind: 'task-notification' } })).toBeUndefined()
  expect(autoGoalOf({ text: '把登录超时修好', origin: { kind: 'peer' } })).toBeUndefined()
  expect(autoGoalOf({ text: '把登录超时修好', origin: { kind: 'composer' } })).toBe('把登录超时修好')
  expect(autoGoalOf({ text: '把登录超时修好', origin: { kind: 'bridge' } })).toBe('把登录超时修好')
})

test('A4 firstMessage ignores short, notice and injected messages too', async ($, on) => {
  const w = world(on)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('tool.call', () => ({ result: {} }))
  await $.prompt.submit({ text: '好' } as never)
  expect(sessionJson(w).firstMessage).toBeUndefined()
  await $.prompt.submit({ text: '<task-notification>x</task-notification>' } as never)
  expect(sessionJson(w).firstMessage).toBeUndefined()
  await $.prompt.submit({ text: '把登录超时修好', origin: { kind: 'task-notification' } } as never)
  expect(sessionJson(w).firstMessage).toBeUndefined()
  await $.prompt.submit({ text: '把登录超时修好，先看日志', origin: { kind: 'composer' } } as never)
  expect(sessionJson(w).firstMessage).toBe('把登录超时修好，先看日志')
})

test('A4 the provisional goal is kept when the session has no steps and the text is a notice', async ($, on) => {
  const w = world(on)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('tool.call', () => ({ result: {} }))
  await $.prompt.submit({ text: '把登录超时修好' } as never)
  await $.prompt.submit({ text: '继续' } as never)
  await $.prompt.submit({ text: '<task-notification>x</task-notification>' } as never)
  expect(sessionJson(w).autoGoal).toBe('把登录超时修好')
})

// ---- A5: a dispatch-heavy session without steps shows dispatched / returned ----

function self(over: Partial<SessionRec> = {}): SessionView {
  return {
    v: 1, id: 's1', kind: 'normal', startedAt: NOW, cwd: '/w/acme', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [], ...over,
    isAlive: true, isSelf: true, cwdMissing: false, attribution: { confident: [], speculative: [] },
  }
}
const snapOf = (s: SessionView): Snapshot => ({ now: NOW, selfId: 's1', focusPlan: null, repoPlans: [], plans: [], sessions: [s], waiting: waitingItems([], [s]), recent: [] })
const band = (s: SessionView, cols = 120) => buildBanner({ snap: snapOf(s), cols, glyph: '■', isWorking: false, spinner: '⠋', now: NOW })

test('A5 a session without steps that dispatched agents shows 派出 N · 交回 M, not an empty fraction', async () => {
  const s = self({ dispatched: 3, agentsDone: 1, bg: [{ id: 'b1', kind: 'agent', name: 'review', startedAt: NOW - 60_000 }, { id: 'b2', kind: 'agent', name: 'impl', startedAt: NOW - 60_000 }] })
  const r1 = rowText(band(s).rows[0] ?? [])
  expect(r1).toContain('派出 3 · 交回 1')
  expect(r1).toContain('运行 2')
  expect(r1).not.toContain('0/0')
  const narrow = rowText(band(s, 50).rows[0] ?? [])
  expect(narrow).toContain('派出 3')
  expect(narrow).not.toContain('0/0')
})

test('A5 an orchestrator without steps shows 派出 / 交回 too; with steps it keeps its line', async () => {
  const r = rowText(band(self({ kind: 'orchestrator', goal: '统筹三仓', dispatched: 2, agentsDone: 2 })).rows[0] ?? [])
  expect(r).toContain('派出 2 · 交回 2')
  expect(r).not.toContain('0/0')
  const withSteps = rowText(band(self({ kind: 'orchestrator', goal: '统筹', dispatched: 1, steps: [{ title: 'x', status: 'doing' }] })).rows[0] ?? [])
  expect(withSteps).toContain('派出 1')
})

void COMPOSE
