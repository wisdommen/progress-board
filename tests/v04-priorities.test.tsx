import { expect, enTest as test } from './locale-test'
import { world, seedPlan } from './world'
import { plan, PLAN, planDir, savedPlan, seedSession, session, claim, NOW } from './v03-fixtures'
const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
const priority = (level: string, more: Record<string, unknown> = {}) => ({ tool: 'mcp__progress-board__progress_plan', action: 'set_priority', plan: PLAN, item: 'p1-1', level, ...more })
async function setup($: any, on: any) {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()] }))
  on('prompt.compose', () => ({ sections: [] })); on('tool.call', () => ({ result: {} })); on('command.run', () => ({ text: '' })); on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  await $.command.run({ command: 'progress', args: '' }); return w
}

test('V04 priorities require meaningful own-user evidence once per message and target', async ($, on) => {
  const w = await setup($, on)
  await $.tool.call(priority('high') as never)
  expect((savedPlan(w).phases[0]!.items[0] as any).priority).toBeUndefined()
  const quote = 'Make the first item high priority'
  await $.prompt.submit({ text: quote, origin: { kind: 'composer' }, wait: false } as never)
  await $.tool.call(priority('high', { quote, quoted_at: new Date(NOW).toISOString() }) as never)
  expect((savedPlan(w).phases[0]!.items[0] as any).priority).toBe('high')
  await $.tool.call(priority('low', { quote, quoted_at: new Date(NOW).toISOString() }) as never)
  expect((savedPlan(w).phases[0]!.items[0] as any).priority).toBe('high')
  await $.tool.call(priority('pinned', { item: 'p1-2', quote, quoted_at: new Date(NOW).toISOString() }) as never)
  expect((savedPlan(w).phases[0]!.items[1] as any).priority).toBeUndefined()
  expect(w.files.get(`${planDir}/log.jsonl`)?.text).toContain('set_priority')
})

test('V04 priorities never treat incoming peer text as the persons own quote', async ($, on) => {
  const w = await setup($, on), quote = 'Pin all of the work immediately'
  await $.prompt.submit({ text: quote, origin: { kind: 'peer', from: 'other' }, wait: false } as never)
  await $.tool.call(priority('pinned', { quote, quoted_at: new Date(NOW).toISOString() }) as never)
  expect((savedPlan(w).phases[0]!.items[0] as any).priority).toBeUndefined()
  const result = await $.tool.call(priority('high', { quote, quoted_at: new Date(NOW).toISOString() }) as never)
  expect(String(result.result)).toContain('own message')
})

test('V04 priority panel changes item and phase levels and filters claimed items', async ($, on) => {
  const w = await setup($, on), ui = await $.ui.mount(pane)
  await ui.press({ key: 'tab-priorities' }); await ui.press({ key: 'priority-up-item-p1-2' })
  expect((savedPlan(w).phases[0]!.items[1] as any).priority).toBe('high')
  await ui.press({ key: 'priority-down-phase-p1' })
  expect((savedPlan(w).phases[0] as any).priority).toBe('low')
  await ui.press({ key: 'priority-unclaimed' })
  expect(await ui.find({ key: 'priority-up-item-p1-1' })).toBeUndefined()
  expect(await ui.find({ key: 'priority-up-item-p1-2' })).toBeDefined()
  expect(w.files.get(`${planDir}/log.jsonl`)?.text).toContain('panel')
  await ui.unmount()
})

test('V04 priority advice lists pinned high and deferred work and reminds the orchestrator once', async ($, on) => {
  const w = await setup($, on)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', orchestrator: true } as never)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-priorities' })
  await ui.press({ key: 'priority-level-item-p1-2' }); await ui.press({ key: 'priority-choose-item-p1-2-pinned' })
  const compose = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] }
  const a = await $.prompt.compose(compose as never)
  expect(a.sections.map(s => s.text).join('\n')).toContain('do not start deferred items')
  expect(a.sections.map(s => s.text).join('\n')).toContain('p1-2')
  const first = await $.tool.call({ tool: 'Bash', command: 'pwd' } as never)
  const second = await $.tool.call({ tool: 'Bash', command: 'pwd' } as never)
  expect(first.context?.join('\n')).toContain('Priority changed')
  expect(second.context?.join('\n') ?? '').not.toContain('Priority changed')
  expect(w.files.get(`${planDir}/plan.json`)?.text).toContain('pinned')
  await ui.unmount()
})

test('V04 claiming lower priority work is allowed but requests a reason and stores the explanation', async ($, on) => {
  const w = await setup($, on), ui = await $.ui.mount(pane)
  await ui.press({ key: 'tab-priorities' }); await ui.press({ key: 'priority-up-item-p1-2' })
  const result = await $.tool.call({ tool: 'mcp__progress-board__progress_session', claim: [{ plan: PLAN, item: 'p1-3' }] } as never)
  expect(String(result.result)).toContain('explain_priority')
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'explain_priority', plan: PLAN, item: 'p1-3', reason: 'This prerequisite unblocks the higher item' } as never)
  expect((savedPlan(w).phases[0]!.items[2] as any).priorityReason?.reason).toContain('prerequisite')
  expect(w.files.get(`${planDir}/log.jsonl`)?.text).toContain('explain_priority')
  await ui.unmount()
})

test('V04 expanded progress rows sort priorities before original order', async ($, on) => {
  await setup($, on); const ui = await $.ui.mount(pane)
  await ui.press({ key: 'tab-priorities' }); await ui.press({ key: 'priority-up-item-p1-3' })
  await ui.press({ key: 'tab-progress' })
  const text = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('\n')
  expect(text.indexOf('↑ 文档')).toBeGreaterThan(-1)
  expect(text.indexOf('↑ 文档')).toBeLessThan(text.indexOf('◐ 实现登录验证'))
  await ui.unmount()
})
