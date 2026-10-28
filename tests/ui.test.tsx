import { expect, test } from './locale-test'
import { world } from './world'

import type { Snapshot } from '../types'
import { changeItem, newPlan, waitingItems } from '../hooks/model'

const NOW = 1_800_000_000_000

function fixture(): Snapshot {
  const base = { ...newPlan({ id: 'acme/v2', title: 'v2 发布', goal: 'g', criteria: 'PR 合并', phases: [{ name: '登录重构', items: ['a', 'b', 'c'] }, { name: '文档' }], by: 's1', now: NOW }), status: 'active' as const }
  const r = changeItem(base, undefined, 'a', { status: 'done', meetsCriteria: true }, NOW)
  if ('error' in r) throw new Error(r.error)
  const draft = newPlan({ id: 'acme/v3', goal: 'g', criteria: 'c', phases: [{ name: 'x' }], by: 's1', now: NOW })
  const plans = [r.plan, draft]
  const sessions = [{
    v: 1 as const, id: 's1', kind: 'normal' as const, startedAt: NOW, cwd: '/w', goal: '修复登录超时',
    steps: [{ title: '复现', status: 'done' as const }, { title: '修', status: 'doing' as const }],
    claims: [{ plan: 'acme/v2', item: 'p1-2', at: NOW, source: 'claim' as const }],
    bg: [], dispatched: 0, agentsDone: 0, approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [],
    isAlive: true, isSelf: true, cwdMissing: false, attribution: { confident: [{ plan: 'acme/v2', source: 'claim' as const }], speculative: [] },
  }]
  return { now: NOW, selfId: 's1', focusPlan: 'acme/v2', repoPlans: ['acme/v2'], plans, sessions, waiting: waitingItems(plans, sessions), recent: [] }
}

const seed = (snap: Snapshot) => async (_$: unknown, e: { key: string }, next: (e: unknown) => Promise<any>) => {
  const actual = await next(e)
  const values: Record<string, unknown> = {
    snapshot: snap, isHeadless: false, tick: 0,
    ui: { expanded: [], showReview: false, selectedReview: null, showRelated: false, showEnded: false, pick: null },
  }
  return e.key in values ? { value: { ...actual.value, value: values[e.key] } } : actual
}

const BAND = {
  plugin: 'progress-board', component: 'AbovePrompt', requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board',
  props: { title: '进度', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the band draws both rows on every surface', async ($, on) => {
  on('state.get', seed(fixture()) as never)
  on('clock.now', () => ({ value: NOW }))
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /修复登录超时/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the panel draws the waiting card, plan and session', async ($, on) => {
  const w = world(on)
  on('state.get', seed(fixture()) as never)
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await w.clock.settle()
    const text = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')
    expect(text).toContain('等你 1')
    expect(text).toContain('待确认计划')
    expect(text).toContain('完成标准：PR 合并')
    expect(text).toContain('本会话 · 修复登录超时')
    expect(text).toContain('← 本会话')
    expect(await ui.find({ type: 'Text', text: /等你 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /待确认计划/ })).toBeDefined()
    expect(await ui.find({ key: 'accept' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /完成标准：PR 合并/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /本会话 · 修复登录超时/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /← 本会话/ })).toBeDefined()
    await ui.unmount()
  }
})
