import { expect, enTest as test } from './locale-test'
import type { SessionView, Snapshot, Suggestion } from '../types'
import { resolveAttributions } from '../hooks/attrib'
import { buildBanner, rowText } from '../hooks/banner'
import { bundled, t } from '../hooks/i18n'
import { attributedSessions, MONITOR_SYSTEM, monitorDigest, resolveSuggestion, takeSuggestions, validateSuggestions } from '../hooks/monitor'
import { Paths } from '../hooks/store'
import { MemIo } from './memio'
import { claim, NOW, PLAN, plan, savedSession, seedSession, session } from './v03-fixtures'
import { seedPlan, world } from './world'

const WINDOW = 30 * 60_000
const paths = Paths.forHome('/h')
const fields = { item: 'p1-1', status: 'wrapping' as const, reason: 'ready', evidence: 'observed' }
const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({ ...fields, id: 'check-1', created: NOW, by: 'monitor', state: 'open',
  cost: { usd: 0.001, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, basis: 'test' }, ...over })
const view = (over: Partial<SessionView> = {}): SessionView => ({ ...session(), isSelf: false, isAlive: true, cwdMissing: false,
  attribution: { confident: [], speculative: [] }, ...over })
const attributed = (over: Partial<SessionView> = {}) => view({ claims: [claim()], attribution: { confident: [{ plan: PLAN, source: 'claim' }], speculative: [] }, ...over })
async function stored(over: Partial<Suggestion> = {}) {
  const io = new MemIo(); io.clock = NOW
  io.now = async () => io.clock
  await io.writeAtomic(paths.suggestions(PLAN), JSON.stringify([suggestion(over)]))
  return io
}
const saved = async (io: MemIo): Promise<Suggestion> => JSON.parse((await io.read(paths.suggestions(PLAN)))!)[0]
const seedSuggestion = (w: ReturnType<typeof world>, over: Partial<Suggestion> = {}) => {
  w.files.set(paths.suggestions(PLAN), { text: JSON.stringify([suggestion(over)]), m: w.clock.now() })
}

test('V063 最近编辑计划的会话优先于较小 id 的归属会话', async () => {
  const io = await stored()
  const sessions = [attributed({ id: 'a-claimed' }), view({ id: 'z-editor', editedPlans: [{ plan: PLAN, at: NOW, itemAt: NOW }] })]
  expect(await takeSuggestions(io, paths, PLAN, 'a-claimed', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'z-editor', sessions)).toContain('check-1')
  expect((await saved(io)).deliveredTo).toBe('z-editor')
})

test('V063 使用当前计划的最新编辑时间，而不是认领数或其他计划的活动', async () => {
  const io = await stored()
  const sessions = [attributed({ id: 'a-busy', claims: [claim('p1-1'), claim('p1-2')], lastActivity: NOW + 100,
    editedPlans: [{ plan: PLAN, at: NOW - 100, itemAt: NOW - 100 }, { plan: 'other/v1', at: NOW + 100 }] }),
  view({ id: 'z-editor', editedPlans: [{ plan: PLAN, at: NOW, itemAt: NOW }] })]
  expect(await takeSuggestions(io, paths, PLAN, 'z-editor', sessions)).toContain('check-1')
})

test('V063 归属或仅编辑记录中的统筹者仍优先于最新编辑者', async () => {
  for (const lead of [attributed({ id: 'lead', kind: 'orchestrator' }), view({ id: 'lead', kind: 'orchestrator', editedPlans: [{ plan: PLAN, at: NOW - 100, itemAt: NOW - 100 }] })]) {
    const io = await stored()
    const sessions = [view({ id: 'editor', editedPlans: [{ plan: PLAN, at: NOW, itemAt: NOW }] }), lead]
    expect(await takeSuggestions(io, paths, PLAN, 'editor', sessions)).toBeUndefined()
    expect(await takeSuggestions(io, paths, PLAN, 'lead', sessions)).toContain('check-1')
  }
})

test('V063 旧会话没有编辑记录时按认领数、id 排序', async () => {
  const io = await stored()
  const sessions = [attributed({ id: 'a-one' }), attributed({ id: 'c-two', claims: [claim('p1-1'), claim('p1-2')] }),
    attributed({ id: 'b-two', claims: [claim('p1-1'), claim('p1-2')] })]
  expect(await takeSuggestions(io, paths, PLAN, 'a-one', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'c-two', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'b-two', sessions)).toContain('check-1')
})

test('V063 不向已结束、已死亡或无关编辑者投递', async () => {
  const io = await stored()
  const sessions = [view({ id: 'ended', kind: 'orchestrator', editedPlans: [{ plan: PLAN, at: NOW + 100 }], endedAt: NOW }),
    view({ id: 'dead', kind: 'orchestrator', editedPlans: [{ plan: PLAN, at: NOW + 100 }], isAlive: false }),
    view({ id: 'other', kind: 'orchestrator', editedPlans: [{ plan: 'other/v1', at: NOW + 100 }] }), attributed({ id: 'live' })]
  for (const id of ['ended', 'dead', 'other']) expect(await takeSuggestions(io, paths, PLAN, id, sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'live', sessions)).toContain('check-1')
})

test('V063 编辑记录不产生认领或明确归属，也不进入监视器归属列表', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session())
  const result = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-1', status: 'wrapping' } as never) as { result?: unknown }
  expect(String(result.result)).not.toMatch(/Error:|internal error/)
  const rec = savedSession(w)
  expect(rec.editedPlans?.map(e => e.plan)).toEqual([PLAN])
  expect(rec.claims).toEqual([])
  const attribution = resolveAttributions([rec], new Set([PLAN]), () => [], [plan()]).get(rec.id)!
  expect(attribution).toEqual({ confident: [], speculative: [] })
  const editor = view({ ...rec, attribution })
  expect(attributedSessions(PLAN, [editor])).toEqual([])
  const io = await stored()
  expect(await takeSuggestions(io, paths, PLAN, rec.id, [editor])).toContain('check-1')
})

test('V063 仅编辑过的计划即使不是当前焦点，也可在主循环工具结果投递', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedPlan(w, '/h', plan({ id: 'other/v1' }))
  seedSession(w, session({ lastPlan: 'other/v1', editedPlans: [{ plan: PLAN, at: NOW, itemAt: NOW }] }))
  seedSuggestion(w)
  on('tool.call', (_, e) => ({ result: { out: e.tool } }) as never)
  const result = await $.tool.call({ tool: 'Read', file_path: '/a' } as never) as { context?: readonly string[] }
  expect((result.context ?? []).join('\n')).toContain(`"plan":"${PLAN}"`)
  expect((result.context ?? []).join('\n')).toContain('check-1')
  expect(savedSession(w).claims).toEqual([])
})

test('V063 子代理的工具结果不会领取或消耗主循环的建议', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan())
  seedSession(w, session({ lastPlan: PLAN, editedPlans: [{ plan: PLAN, at: NOW, itemAt: NOW }] })); seedSuggestion(w)
  on('tool.call', (_, e) => ({ result: { out: e.tool } }) as never)
  const child = await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'child' } as never) as { context?: readonly string[] }
  expect((child.context ?? []).join('\n')).not.toContain('check suggestions')
  expect(JSON.parse(w.files.get(paths.suggestions(PLAN))!.text)[0].deliveredAt).toBeUndefined()
  const main = await $.tool.call({ tool: 'Read', file_path: '/a' } as never) as { context?: readonly string[] }
  expect((main.context ?? []).join('\n')).toContain('check-1')
})

test('V063 成功的条目里程碑修改只刷新 itemAt，设置里程碑列表和失败修改不刷新', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan({ milestones: ['checks', 'merge'] }))
  seedSession(w, session({ editedPlans: [{ plan: PLAN, at: NOW - 100, itemAt: NOW - 100 }] }))
  const result = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', plan: PLAN, action: 'set_item', item: 'p1-1', milestone: 1 } as never) as { result?: unknown }
  expect(String(result.result)).not.toMatch(/Error:|internal error/)
  const edit = savedSession(w).editedPlans!.find(e => e.plan === PLAN)!
  expect(edit.at).toBe(NOW - 100)
  expect(edit.itemAt! > NOW - 100).toBe(true)
  const before = savedSession(w).editedPlans
  await w.clock.advance(10)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', plan: PLAN, action: 'set_milestones', milestones: ['checks', 'merge', 'deploy'] } as never)
  expect(savedSession(w).editedPlans).toEqual(before)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'missing', milestone: 1 } as never)
  expect(savedSession(w).editedPlans).toEqual(before)
  expect(savedSession(w).claims).toEqual([])
})

test('V063 首投持久化次数、末次时间和收件人，并带可处理的建议及计划 id', async () => {
  const io = await stored()
  const delivered = await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])
  expect(delivered).toContain('"id":"check-1"')
  expect(delivered).toContain(`"plan":"${PLAN}"`)
  expect(delivered).toContain('resolve_suggestion')
  expect(delivered).toContain('sent again later if left open')
  const after = await saved(io)
  expect(after.deliveries).toBe(1)
  expect(after.deliveredTo).toBe('s1')
  expect(typeof after.deliveredAt).toBe('number')
})

test('V063 半小时内不重投，恰满半小时可重投给同一会话', async () => {
  const io = await stored({ deliveries: 1, deliveredAt: NOW, deliveredTo: 's1' })
  io.clock = NOW + WINDOW - 1
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toBeUndefined()
  expect((await saved(io)).deliveries).toBe(1)
  io.clock = NOW + WINDOW
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toContain('check-1')
  expect((await saved(io)).deliveries).toBe(2)
  expect((await saved(io)).deliveredAt).toBe(NOW + WINDOW)
})

test('V063 最新收件人改变仍须等待窗口，期满后可转投', async () => {
  const io = await stored({ deliveries: 1, deliveredAt: NOW, deliveredTo: 'old' })
  const sessions = [attributed({ id: 'old' }), view({ id: 'new', editedPlans: [{ plan: PLAN, at: NOW, itemAt: NOW }] })]
  io.clock = NOW + WINDOW - 1
  expect(await takeSuggestions(io, paths, PLAN, 'new', sessions)).toBeUndefined()
  io.clock = NOW + WINDOW
  for (const s of sessions) s.lastActivity = io.clock
  expect(await takeSuggestions(io, paths, PLAN, 'old', sessions)).toBeUndefined()
  expect(await takeSuggestions(io, paths, PLAN, 'new', sessions)).toContain('check-1')
  expect((await saved(io)).deliveredTo).toBe('new')
  expect((await saved(io)).deliveries).toBe(2)
})

test('V063 总共三次后停止重投，建议保持未解决', async () => {
  const io = await stored()
  for (let delivery = 1; delivery <= 3; delivery++) {
    if (delivery > 1) io.clock = (await saved(io)).deliveredAt! + WINDOW
    expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toContain('check-1')
    expect((await saved(io)).deliveries).toBe(delivery)
  }
  io.clock += 10 * WINDOW
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toBeUndefined()
  expect((await saved(io)).state).toBe('open')
  expect((await saved(io)).deliveries).toBe(3)
})

test('V063 并发调用只投递一次，半小时内不会因重复工具结果再次投递', async () => {
  const io = await stored()
  const results = await Promise.all(Array.from({ length: 3 }, () => takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])))
  expect(results.filter(Boolean).length).toBe(1)
  expect((await saved(io)).deliveries).toBe(1)
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toBeUndefined()
})

test('V063 旧记录仅有 deliveredAt 时视为已投一次，仍可投两次', async () => {
  const io = await stored({ deliveredAt: NOW, deliveredTo: 's1' })
  io.clock = NOW + WINDOW - 1
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toBeUndefined()
  io.clock = NOW + WINDOW
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toContain('check-1')
  expect((await saved(io)).deliveries).toBe(2)
  io.clock += WINDOW
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toContain('check-1')
  expect((await saved(io)).deliveries).toBe(3)
  io.clock += WINDOW
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toBeUndefined()
})

test('V063 已解决建议不再重投，投递上限不影响手动解决', async () => {
  const io = await stored({ deliveries: 3, deliveredAt: NOW, deliveredTo: 's1' })
  expect((await resolveSuggestion(io, paths, PLAN, 'check-1', false, 'already checked', 's1')).isError).toBeUndefined()
  io.clock += 10 * WINDOW
  expect(await takeSuggestions(io, paths, PLAN, 's1', [attributed({ lastActivity: io.clock })])).toBeUndefined()
  expect((await saved(io)).state).toBe('rejected')
})

const snapshot = (open?: number, status: 'active' | 'done' = 'active'): Snapshot => ({ now: NOW, selfId: 's1', focusPlan: PLAN, repoPlans: [],
  plans: [plan({ title: 'Plan', status })], sessions: [view({ isSelf: true })], recent: [], waiting: [],
  ...(open === undefined ? {} : { monitors: { [PLAN]: { enabled: false, open, todayCost: 0 } } }) })
const band = (snap: Snapshot, cols: number) => buildBanner({ snap, cols, glyph: '■', isWorking: false, spinner: '', now: NOW })

for (const cols of [140, 80, 40]) {
  test(`V063 总体行在 ${cols} 列显示未解决建议数量，零条或旧快照不显示`, () => {
    const text = rowText(band(snapshot(2), cols).rows[1]!)
    expect(text).toContain('2 to check')
    expect(rowText(band(snapshot(0), cols).rows[1]!)).not.toContain('to check')
    expect(rowText(band(snapshot(), cols).rows[1]!)).toBe(rowText(band(snapshot(0), cols).rows[1]!))
  })
}

test('V063 已完成计划不显示未解决建议数量', () => {
  expect(rowText(band(snapshot(2, 'done'), 140).rows[1]!)).not.toContain('to check')
})

test('V063 新建议数量文案在十种语言中使用真实译文和相同占位符', () => {
  const expected: Record<string, string> = { en: '{count} to check', 'zh-CN': '待核对 {count}', 'zh-TW': '待核對 {count}',
    ja: '要確認 {count} 件', ko: '확인 필요 {count}건', es: '{count} por revisar', fr: '{count} à vérifier', de: '{count} zu prüfen',
    'pt-BR': '{count} a verificar', ru: 'Проверить: {count}' }
  for (const [locale, value] of Object.entries(expected)) expect(bundled[locale]!['banner.toCheck']).toBe(value)
  expect(t('banner.toCheck', { count: 2 })).toBe('2 to check')
})

test('V063 摘要明确里程碑数量与计数含义，不把列表截断数当作 N', () => {
  const milestones = Array.from({ length: 25 }, (_, i) => `station ${i + 1}`)
  const p = plan({ milestones }); p.phases[0]!.items[0]!.status = 'done'; p.phases[0]!.items[0]!.milestone = 25
  const digest = JSON.parse(monitorDigest(p, [], {}))
  expect(digest.plan.milestoneCount).toBe(25)
  expect(digest.plan.milestones.length).toBe(20)
  expect(digest.plan.milestoneMeaning).toContain('count of milestones passed')
  expect(digest.items.find((item: { id: string }) => item.id === 'p1-1').milestone).toBe(25)
  expect(JSON.parse(monitorDigest(plan({ milestones: [] }), [], {})).plan.milestoneCount).toBe(0)
})

test('V063 检查器明确 0 到 N 的通过数量语义，不要求完成条目的历史值等于 N', () => {
  expect(MONITOR_SYSTEM).toContain('count of milestones passed')
  expect(MONITOR_SYSTEM).toContain('0 to N')
  expect(MONITOR_SYSTEM).toContain('milestoneCount')
  expect(MONITOR_SYSTEM).toContain('not a zero-based index')
  expect(MONITOR_SYSTEM).toContain('N is valid, not out of range')
  expect(MONITOR_SYSTEM).toContain('Do not suggest milestone changes for done items')
  expect(MONITOR_SYSTEM).not.toContain('done item has milestone N')
  expect(JSON.parse(monitorDigest(plan(), [], {})).plan.milestoneMeaning).not.toContain('done =')
})

test('V063 校验器允许 N 作为合法完成数量，继续拒绝 N+1', () => {
  const p = plan({ milestones: ['open', 'checks', 'merge', 'deploy'] })
  expect(validateSuggestions(JSON.stringify({ suggestions: [{ ...fields, status: 'done', milestone: 4 }] }), p)[0]?.milestone).toBe(4)
  expect(validateSuggestions(JSON.stringify({ suggestions: [{ ...fields, milestone: 5 }] }), p)).toEqual([])
})
