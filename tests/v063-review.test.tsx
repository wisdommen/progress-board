import { expect, enTest as test } from './locale-test'
import type { SessionRec, SessionView, Snapshot, Suggestion } from '../types'
import { resolveAttributions } from '../hooks/attrib'
import { sessionsOn } from '../hooks/banner'
import { takeSuggestions, validateSuggestions } from '../hooks/monitor'
import { Paths } from '../hooks/store'
import { MemIo } from './memio'
import { claim, NOW, PLAN, plan, savedPlan, savedSession, seedSession, session } from './v03-fixtures'
import { seedPlan, world } from './world'

const paths = Paths.forHome('/h')
const WINDOW = 30 * 60_000
const fields = { item: 'p1-1', reason: 'ready', evidence: 'observed' }
const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({ ...fields, status: 'wrapping', id: 'check-1', created: NOW, by: 'monitor', state: 'open',
  cost: { usd: 0.001, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, basis: 'test' }, ...over })
const view = (over: Partial<SessionView> = {}): SessionView => ({ ...session(), isSelf: false, isAlive: true, cwdMissing: false,
  attribution: { confident: [], speculative: [] }, ...over })
const attributed = (over: Partial<SessionView> = {}) => view({ claims: [claim()], attribution: { confident: [{ plan: PLAN, source: 'claim' }], speculative: [] }, ...over })
const countOnPlan = (rec: SessionRec) => {
  const attribution = resolveAttributions([rec], new Set([PLAN]), () => [], [plan()]).get(rec.id)!
  const snap: Snapshot = { now: NOW, selfId: rec.id, focusPlan: PLAN, repoPlans: [], plans: [plan()], sessions: [view({ ...rec, attribution })], recent: [], waiting: [] }
  return sessionsOn(snap, PLAN)
}
async function stored(list: Suggestion[] = [suggestion()]) {
  const io = new MemIo(); io.clock = NOW; io.now = async () => io.clock
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(plan()))
  await io.writeAtomic(paths.suggestions(PLAN), JSON.stringify(list))
  return io
}
const seedSuggestion = (w: ReturnType<typeof world>, list = [suggestion()]) => {
  w.files.set(paths.suggestions(PLAN), { text: JSON.stringify(list), m: w.clock.now() })
}

test('V063 review 可见范围外只有文本匹配的推测归属计划不投递', async ($, on) => {
  const w = world(on); const foreign = plan({ repos: ['/w/other'] })
  seedPlan(w, '/h', foreign); seedPlan(w, '/h', plan({ id: 'other/v1', repos: ['/w/acme'] }))
  const rec = session({ lastPlan: 'other/v1', firstMessage: `Investigate ${PLAN} later` })
  seedSession(w, rec); seedSuggestion(w)
  on('tool.call', (_, e) => ({ result: { out: e.tool } }) as never)
  const attribution = resolveAttributions([rec], new Set([PLAN, 'other/v1']), () => [], [foreign]).get(rec.id)!
  expect(attribution.speculative).toEqual([{ plan: PLAN, source: 'mention' }])
  const result = await $.tool.call({ tool: 'Read', file_path: '/a' } as never) as { context?: readonly string[] }
  expect((result.context ?? []).join('\n')).not.toContain('check-1')
  expect(JSON.parse(w.files.get(paths.suggestions(PLAN))!.text)[0].deliveredAt).toBeUndefined()
})

test('V063 review 可见计划仍能收到建议', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session({ lastPlan: PLAN, envPlan: PLAN })); seedSuggestion(w)
  on('tool.call', (_, e) => ({ result: { out: e.tool } }) as never)
  const result = await $.tool.call({ tool: 'Read', file_path: '/a' } as never) as { context?: readonly string[] }
  expect((result.context ?? []).join('\n')).toContain('check-1')
})

test('V063 review 仅接受过计划的会话不凭 at 击败认领者', async () => {
  const io = await stored()
  const sessions = [view({ id: 'a-accepted', editedPlans: [{ plan: PLAN, at: NOW + 100 }] }), attributed({ id: 'z-claimed' })]
  expect(await takeSuggestions(io, paths, PLAN, 'a-accepted', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'z-claimed', sessions)).toContain('check-1')
})

test('V063 review 仅接受过计划的会话之间只按 id 而非 at 排序', async () => {
  const io = await stored()
  const sessions = [view({ id: 'z-recent', editedPlans: [{ plan: PLAN, at: NOW }] }), view({ id: 'a-older', editedPlans: [{ plan: PLAN, at: NOW - 100 }] })]
  expect(await takeSuggestions(io, paths, PLAN, 'z-recent', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'a-older', sessions)).toContain('check-1')
})

test('V063 review itemAt 而非参与时间决定最近条目编辑者', async () => {
  const io = await stored()
  const sessions = [attributed({ id: 'a-accepted', editedPlans: [{ plan: PLAN, at: NOW + 100, itemAt: NOW - 100 }] }),
    view({ id: 'z-worker', editedPlans: [{ plan: PLAN, at: NOW - 100, itemAt: NOW }] })]
  expect(await takeSuggestions(io, paths, PLAN, 'a-accepted', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'z-worker', sessions)).toContain('check-1')
})

test('V063 review itemAt 相同或缺省时按认领数量再按 id 排序', async () => {
  const io = await stored()
  const sessions = [attributed({ id: 'a-one', editedPlans: [{ plan: PLAN, at: NOW + 100, itemAt: NOW }] }),
    attributed({ id: 'c-two', claims: [claim('p1-1'), claim('p1-2')], editedPlans: [{ plan: PLAN, at: NOW + 200, itemAt: NOW }] }),
    attributed({ id: 'b-two', claims: [claim('p1-1'), claim('p1-2')], editedPlans: [{ plan: PLAN, at: NOW - 100, itemAt: NOW }] })]
  expect(await takeSuggestions(io, paths, PLAN, 'a-one', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'c-two', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'b-two', sessions)).toContain('check-1')
})

test('V063 review 其他计划的统筹者仅接受过本计划时不能抢占建议', async () => {
  const io = await stored()
  const sessions = [view({ id: 'a-other-lead', kind: 'orchestrator', claims: [{ ...claim(), plan: 'other/v1' }],
    attribution: { confident: [{ plan: 'other/v1', source: 'claim' }], speculative: [] },
    editedPlans: [{ plan: PLAN, at: NOW }, { plan: 'other/v1', at: NOW, itemAt: NOW + 100 }] }),
    view({ id: 'z-worker', editedPlans: [{ plan: PLAN, at: NOW - 100, itemAt: NOW - 100 }] })]
  expect(await takeSuggestions(io, paths, PLAN, 'a-other-lead', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'z-worker', sessions)).toContain('check-1')
})

test('V063 review 只含 itemAt 的编辑记录不计参与人数，但仍可收建议', async () => {
  const rec = session({ editedPlans: [{ plan: PLAN, itemAt: NOW }] })
  expect(countOnPlan(rec)).toBe(0)
  const io = await stored()
  expect(await takeSuggestions(io, paths, PLAN, rec.id, [view(rec)])).toContain('check-1')
})

for (const input of [
  { action: 'set_item', item: 'p1-1', milestone: 1 },
  { action: 'set_item', item: 'p1-1', refs: { branch: ['feature/check'] } },
  { action: 'add_items', phase: 'p1', items: ['新增条目'] },
  { action: 'resolve_suggestion', id: 'check-1', accepted: false, reason: '已经核对' },
]) {
  for (const counted of [false, true]) {
    test(`V063 review ${input.action} ${'milestone' in input ? 'milestone' : 'refs' in input ? 'refs' : ''} 仅刷新 itemAt，既有参与记录 ${counted}`, async ($, on) => {
      const w = world(on); seedPlan(w, '/h', plan({ milestones: ['checks', 'merge'] })); seedSuggestion(w)
      seedSession(w, session({ ...(counted ? { editedPlans: [{ plan: PLAN, at: NOW - 100 }] } : {}) }))
      const result = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', plan: PLAN, ...input } as never) as { result?: unknown }
      expect(String(result.result)).not.toMatch(/Error:|internal error/)
      const rec = savedSession(w), edit = rec.editedPlans?.find(e => e.plan === PLAN)
      expect(typeof edit?.itemAt).toBe('number')
      expect(edit!.itemAt! >= NOW).toBe(true)
      expect(edit?.at).toBe(counted ? NOW - 100 : undefined)
      expect(countOnPlan(rec)).toBe(counted ? 1 : 0)
      expect(rec.claims).toEqual([])
    })
  }
}

for (const action of ['propose', 'set_priority', 'abandon', 'explain_priority', 'set_milestones'] as const) {
  for (const counted of [false, true]) {
    test(`V063 review ${action} 保持 0.6.1 的参与计数与两种时间，既有参与记录 ${counted}`, async ($, on) => {
      const w = world(on)
      if (action !== 'propose') seedPlan(w, '/h', plan())
      seedSession(w, session({ ...(counted ? { editedPlans: [{ plan: PLAN, at: NOW - 100, itemAt: NOW - 200 }] } : {}) }))
      const quote = 'Make the first item high priority'
      if (action === 'set_priority') {
        on('prompt.submit', (_, e) => ({ text: e.text }))
        await $.prompt.submit({ text: quote, origin: { kind: 'composer' }, wait: false } as never)
      }
      const before = savedSession(w).editedPlans
      const input = action === 'propose' ? { goal: '实现功能', criteria: '全部通过', phases: [{ name: '开发', items: ['实现功能'] }], include_release_phase: false }
        : action === 'set_priority' ? { item: 'p1-1', level: 'high', quote, quoted_at: new Date(NOW).toISOString() }
        : action === 'set_milestones' ? { milestones: ['checks', 'merge'] }
        : { item: 'p1-1', reason: '已核对原因' }
      const result = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action, plan: PLAN, ...input } as never) as { result?: unknown }
      expect(String(result.result)).not.toMatch(/Error:|internal error/)
      const p = savedPlan(w)
      if (action === 'propose') expect(p.status).toBe('draft')
      if (action === 'abandon') expect(p.status).toBe('abandoned')
      if (action === 'set_priority') expect(p.phases[0]!.items[0]!.priority).toBe('high')
      if (action === 'explain_priority') expect(p.phases[0]!.items[0]!.priorityReason?.reason).toBe('已核对原因')
      if (action === 'set_milestones') expect(p.milestones).toEqual(['checks', 'merge'])
      expect(savedSession(w).editedPlans).toEqual(before)
      expect(countOnPlan(savedSession(w))).toBe(counted ? 1 : 0)
    })
  }
}

test('V063 review 接受计划只记参与时间，不刷新已有 itemAt', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan({ status: 'draft' }))
  seedSession(w, session({ editedPlans: [{ plan: PLAN, itemAt: NOW - 100 }] }))
  on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'progress', args: `accept ${PLAN}` } as never)
  const rec = savedSession(w)
  expect(savedPlan(w).status).toBe('active')
  expect(rec.editedPlans?.[0]?.at! >= NOW).toBe(true)
  expect(rec.editedPlans?.[0]?.itemAt).toBe(NOW - 100)
  expect(countOnPlan(rec)).toBe(1)
})

test('V063 review 主循环状态修改刷新参与时间和 itemAt', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session())
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-1', status: 'wrapping' } as never)
  const rec = savedSession(w)
  expect(savedPlan(w).phases[0]!.items[0]!.status).toBe('wrapping')
  expect(rec.editedPlans?.[0]?.at! >= NOW).toBe(true)
  expect(rec.editedPlans?.[0]?.itemAt! >= NOW).toBe(true)
  expect(countOnPlan(rec)).toBe(1)
})

test('V063 review 失败的条目操作不刷新任何时间', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan())
  seedSession(w, session({ editedPlans: [{ plan: PLAN, at: NOW - 100, itemAt: NOW - 200 }] }))
  const before = savedSession(w).editedPlans
  for (const input of [{ action: 'set_item', item: 'missing', status: 'wrapping' }, { action: 'add_items', phase: 'missing', items: ['新增条目'] },
    { action: 'resolve_suggestion', id: 'missing', accepted: false, reason: '未找到' }]) {
    const result = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', plan: PLAN, ...input } as never) as { result?: unknown }
    expect(String(result.result)).toContain('Error:')
    expect(savedSession(w).editedPlans).toEqual(before)
  }
})

test('V063 review 子代理成功更新条目也不刷新主会话的两种时间', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan())
  seedSession(w, session({ editedPlans: [{ plan: PLAN, at: NOW - 100, itemAt: NOW - 200 }],
    bg: [{ id: 'b1', kind: 'agent', name: 'worker', startedAt: NOW, direct: true, workerSource: 'claim', taskId: 'child', claim: claim() }] }))
  const before = savedSession(w).editedPlans
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-1', status: 'wrapping', agentId: 'child' } as never)
  expect(savedPlan(w).phases[0]!.items[0]!.status).toBe('wrapping')
  expect(savedSession(w).editedPlans).toEqual(before)
})

test('V063 review 离开的首选统筹者让位给仍有活动的候选者', async () => {
  const io = await stored()
  const sessions = [attributed({ id: 'a-away', kind: 'orchestrator', lastActivity: NOW - WINDOW - 1 }), attributed({ id: 'z-active', lastUserInput: NOW - 2 * WINDOW })]
  expect(await takeSuggestions(io, paths, PLAN, 'a-away', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'z-active', sessions)).toContain('check-1')
})

test('V063 review 所有候选者离开时不投递也不消耗次数', async () => {
  const io = await stored()
  const sessions = [attributed({ id: 'away', lastActivity: NOW - WINDOW - 1 })]
  expect(await takeSuggestions(io, paths, PLAN, 'away', sessions)).toBeUndefined()
  expect(JSON.parse((await io.read(paths.suggestions(PLAN)))!)[0].deliveries).toBeUndefined()
})

test('V063 review 建议选举使用现有 awayMinutes 设置而非固定半小时', async ($, on) => {
  const w = world(on); w.store.set('settings.awayMinutes', 15)
  seedPlan(w, '/h', plan()); seedSuggestion(w)
  seedSession(w, session({ lastPlan: PLAN, envPlan: PLAN }))
  seedSession(w, session({ id: 'a-lead', kind: 'orchestrator', envPlan: PLAN, lastActivity: NOW - 20 * 60_000 }))
  on('tool.call', (_, e) => ({ result: { out: e.tool } }) as never)
  const result = await $.tool.call({ tool: 'Read', file_path: '/a' } as never) as { context?: readonly string[] }
  expect((result.context ?? []).join('\n')).toContain('check-1')
})

test('V063 review 最后一次投递明确告知不再重投，混批也标明各自次数', async () => {
  const io = await stored([suggestion(), suggestion({ id: 'final-check', item: 'p1-2', deliveries: 2, deliveredAt: NOW - WINDOW })])
  const result = await takeSuggestions(io, paths, PLAN, 's1', [attributed()])
  expect(result).toContain('"delivery":1')
  expect(result).toContain('"delivery":3')
  expect(result).toContain('will not be sent again')
  expect(result).not.toContain('it will be sent again later if left open')
})

test('V063 review 提醒明确 progress_plan 的解决调用参数与拒绝理由', async () => {
  const io = await stored()
  const result = await takeSuggestions(io, paths, PLAN, 's1', [attributed()])
  expect(result).toContain('progress_plan with action: resolve_suggestion')
  expect(result).toContain('plan, id, accepted')
  expect(result).toContain('reason when rejecting')
})

for (const legacy of [undefined, 2]) {
  test(`V063 review 已完成条目的历史里程碑 ${legacy} 不产生仅改里程碑建议`, async ($, on) => {
    const w = world(on), p = plan({ milestones: ['checks', 'merge'] })
    p.phases[0]!.items[0]!.status = 'done'; p.phases[0]!.items[0]!.milestone = legacy
    seedPlan(w, '/h', p); seedSession(w, session())
    await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_milestones', plan: PLAN, milestones: ['checks', 'merge', 'deploy'] } as never)
    const current = savedPlan(w)
    expect(current.phases[0]!.items[0]!.milestone).toBe(legacy)
    for (const status of [undefined, 'done']) {
      expect(validateSuggestions(JSON.stringify({ suggestions: [{ ...fields, status, milestone: 3 }] }), current)).toEqual([])
    }
    expect(validateSuggestions(JSON.stringify({ suggestions: [{ ...fields, status: 'wrapping', milestone: 2 }] }), current).length).toBe(1)
    expect(validateSuggestions(JSON.stringify({ suggestions: [{ ...fields, milestone: 3, split: ['部分一', '部分二'] }] }), current).length).toBe(1)
  })
}

test('V063 review 升级前的已完成条目里程碑误报不会重投，其他建议不受影响', async () => {
  const io = await stored([suggestion({ id: 'legacy-undefined', status: undefined, milestone: 3, deliveredAt: NOW - WINDOW }),
    suggestion({ id: 'legacy-done', status: 'done', milestone: 3, deliveredAt: NOW - WINDOW }),
    suggestion({ id: 'status-revert', status: 'wrapping', milestone: 2 }),
    suggestion({ id: 'split', status: undefined, milestone: 3, split: ['部分一', '部分二'] }),
    suggestion({ id: 'other-item', item: 'p1-2' })])
  const p = plan({ milestones: ['checks', 'merge', 'deploy'] }); p.phases[0]!.items[0]!.status = 'done'; p.phases[0]!.items[0]!.milestone = 2
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  const result = await takeSuggestions(io, paths, PLAN, 's1', [attributed()])
  expect(result).not.toContain('legacy-undefined')
  expect(result).not.toContain('legacy-done')
  expect(result).toContain('status-revert')
  expect(result).toContain('split')
  expect(result).toContain('other-item')
  const list = JSON.parse((await io.read(paths.suggestions(PLAN)))!) as Suggestion[]
  expect(list.filter(s => s.id.startsWith('legacy-')).every(s => s.deliveries === undefined && s.deliveredAt === NOW - WINDOW)).toBe(true)
})

test('V063 review 只有已完成条目的历史里程碑误报时不投递', async () => {
  const io = await stored([suggestion({ status: undefined, milestone: 3, deliveredAt: NOW - WINDOW })])
  const p = plan({ milestones: ['checks', 'merge', 'deploy'] }); p.phases[0]!.items[0]!.status = 'done'
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(p))
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed()])).toBeUndefined()
})
