// v0.2 Part E: item milestones — a plan's stations, how many an item passed, and the dots on its row.

import { expect, test } from './locale-test'

import type { Plan, SessionRec } from '../types'
import { changeItem, newPlan } from '../hooks/model'
import { seedPlan, world } from './world'

const NOW = 1_800_000_000_000
const HOME = '/h'
const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: '进度', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const MS = ['开 PR', '检查通过', '合并', '部署']
const planJson = (w: ReturnType<typeof world>, id: string): Plan =>
  JSON.parse(w.files.get(`${HOME}/.claude/progress-board/plans/${encodeURIComponent(id)}/plan.json`)?.text ?? '{}') as Plan

const activePlan = (id: string, over: Partial<Plan> = {}) => ({
  ...newPlan({ id, goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['a', 'b'] }], includeRelease: false, by: 'x', now: NOW }),
  status: 'active' as const, ...over,
})

test('E propose takes milestones; set_milestones changes them without approval', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({
    tool: 'mcp__progress-board__progress_plan', action: 'propose', plan: 'acme/m1', goal: 'g', criteria: 'c',
    phases: [{ name: 'A', items: ['a'] }], milestones: MS,
  } as never)
  expect(planJson(w, 'acme/m1').milestones).toEqual(MS)
  seedPlan(w, HOME, activePlan('acme/m2'))
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_milestones', plan: 'acme/m2', milestones: ['审查', 'UAT', 'CI', '合并'] } as never) as { result?: unknown }
  expect(String(r.result)).toContain('里程碑')
  expect(planJson(w, 'acme/m2').milestones).toEqual(['审查', 'UAT', 'CI', '合并'])
})

test('E a milestone is how many stations passed: bounded, back needs a reason, done passes all', async () => {
  const p = activePlan('acme/m1', { milestones: MS })
  expect('error' in changeItem(p, undefined, 'a', { status: 'wrapping', milestone: 5 }, NOW)).toBe(true)
  const two = changeItem(p, undefined, 'a', { status: 'wrapping', milestone: 2 }, NOW)
  if ('error' in two) throw new Error(two.error)
  expect(two.plan.phases[0]?.items[0]?.milestone).toBe(2)
  const back = changeItem(two.plan, undefined, 'a', { status: 'wrapping', milestone: 1 }, NOW)
  expect('error' in back && back.error).toMatch(/requires a reason/)
  const ok = changeItem(two.plan, undefined, 'a', { status: 'wrapping', milestone: 1, reason: '合并回滚' }, NOW)
  if ('error' in ok) throw new Error(ok.error)
  expect(ok.plan.phases[0]?.items[0]?.milestone).toBe(1)
  expect(ok.plan.reverts.some(r => r.reason === '合并回滚')).toBe(true)
  const done = changeItem(two.plan, undefined, 'a', { status: 'done', meetsCriteria: true }, NOW)
  if ('error' in done) throw new Error(done.error)
  expect(done.plan.phases[0]?.items[0]?.milestone).toBe(MS.length)
  // Without milestones, a milestone argument is refused.
  expect('error' in changeItem(activePlan('acme/m3'), undefined, 'a', { status: 'wrapping', milestone: 1 }, NOW)).toBe(true)
})

test('E the panel draws the dots after the title and names the next station', async ($, on) => {
  const w = world(on)
  const p: Plan = activePlan('acme/m1', { milestones: MS })
  const items = p.phases[0]?.items ?? []
  if (items[0]) { items[0].status = 'wrapping'; items[0].milestone = 2 }
  if (items[1]) { items[1].status = 'todo' }
  seedPlan(w, HOME, p)
  const me: SessionRec = {
    v: 1, id: 's1', kind: 'normal', startedAt: NOW, cwd: '/w/acme', goal: 'g', steps: [], claims: [{ plan: 'acme/m1', at: NOW, source: 'claim' }],
    bg: [], dispatched: 0, agentsDone: 0, approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [],
  }
  w.dirs.add(`${HOME}/.claude/progress-board`)
  w.dirs.add(`${HOME}/.claude/progress-board/sessions`)
  w.files.set(`${HOME}/.claude/progress-board/sessions/s1.json`, { text: JSON.stringify(me), m: NOW })
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const t = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(t).toContain('●●○○ 下一站 合并')
  expect(t).toContain('○○○○ 下一站 开 PR')
  await ui.unmount()
})

test('E set_item milestone is accepted by the tool and reported', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/m1', { milestones: MS }))
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: 'acme/m1', item: 'a', status: 'wrapping', milestone: 1 } as never) as { result?: unknown }
  expect(String(r.result)).toContain('里程碑')
  expect(planJson(w, 'acme/m1').phases[0]?.items[0]?.milestone).toBe(1)
  const back = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: 'acme/m1', item: 'a', status: 'wrapping', milestone: 0 } as never) as { result?: unknown }
  expect(String(back.result)).toContain('requires a reason')
  const ok = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: 'acme/m1', item: 'a', status: 'wrapping', milestone: 0, reason: '检查没过' } as never) as { result?: unknown }
  expect(String(ok.result)).toContain('里程碑')
  expect(planJson(w, 'acme/m1').phases[0]?.items[0]?.milestone).toBe(0)
})
