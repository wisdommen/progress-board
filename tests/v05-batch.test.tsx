import { expect, enTest as test } from './locale-test'
import { world, seedPlan } from './world'
import { plan, session, seedSession, claim, NOW, PLAN } from './v03-fixtures'
const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 100 }, view: {} } } as const
async function setup($: any, on: any) {
  const w = world(on), sounds: any[] = []
  const first = plan({ title: 'Backend' }), second = plan({ id: 'acme/frontend', title: 'Frontend' })
  first.phases[0]!.items[0]!.status = 'done'; first.phases[0]!.items[0]!.doneAt = NOW - 86400_000
  first.phases[0]!.items[1]!.title = 'Find this item'; first.phases[0]!.items[1]!.status = 'wrapping'
  seedPlan(w, '/h', first); seedPlan(w, '/h', second)
  seedSession(w, session({ claims: [claim(), { ...claim(), plan: second.id }] }))
  on('command.run', () => ({ text: '' })); on('tool.call', () => ({ result: {} }))
  on('audio.play', (_: unknown, e: unknown) => { sounds.push(e); return { value: undefined } })
  await $.command.run({ command: 'progress', args: '' } as never)
  return { w, sounds, first, second }
}
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((x: any) => x.text).join('\n')

test('V05 overview focuses either visible active plan and replaces the old switch button', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane)
  expect((await ui.find({ key: `overview-${PLAN}` }))?.text).toContain('Backend')
  expect((await ui.find({ key: 'overview-acme/frontend' }))?.text).toContain('Frontend')
  expect(await ui.find({ key: 'pick' })).toBeUndefined()
  await ui.press({ key: 'overview-acme/frontend' })
  expect((await ui.find({ key: 'overview-acme/frontend' }))?.props.variant).toBe('primary')
  await ui.unmount()
})

test('V05 fourteen-day history includes backfilled completion timestamps and exposes daily data', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: `overview-${PLAN}` })
  expect(await texts(ui)).toContain('Completed in 14 days: 1')
  await ui.press({ key: 'trend-data' })
  expect(await texts(ui)).toContain('Daily completions')
  await ui.unmount()
})

test('V05 status and find filters show matching items with their phase', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: `overview-${PLAN}` })
  await ui.press({ key: 'filter-wrapping' })
  expect(await texts(ui)).toContain('Find this item')
  expect(await texts(ui)).not.toContain('完善错误处理')
  await $.command.run({ command: 'progress', args: 'find no-such-item' } as never)
  expect(await texts(ui)).not.toContain('Find this item')
  expect(await texts(ui)).toContain('No matching items')
  await $.command.run({ command: 'progress', args: 'find Find this' } as never)
  expect(await texts(ui)).toContain('Find this item')
  await ui.unmount()
})

test('V05 report writes localized Markdown with criteria, history, claimers and waiting list', async ($, on) => {
  const { w } = await setup($, on)
  const result = await $.command.run({ command: 'progress', args: `report ${PLAN}` } as never)
  expect(result.text).toContain('/reports/')
  const reports = [...w.files].filter(([path]) => /\/reports\/.*\.md$/.test(path))
  expect(reports.length).toBe(1)
  const text = reports[0]![1].text
  expect(text).toContain('# Backend'); expect(text).toContain('Criteria'); expect(text).toContain('In progress')
  expect(text).toContain('Since the previous report'); expect(text).toContain('Waiting for you')
  expect(text).not.toContain('\u001b')
  await $.command.run({ command: 'progress', args: `report ${PLAN}` } as never)
  expect([...w.files].filter(([path]) => /\/reports\/.*\.md$/.test(path)).length).toBe(2)
})

test('V05 waiting toast and optional sound emit once, on the last active session only, after the quiet window', async ($, on) => {
  const { w, sounds } = await setup($, on)
  w.store.set('settings.notifications', 'sound')
  await w.clock.advance(11000)
  seedPlan(w, '/h', plan({ id: 'acme/draft', status: 'draft', createdAt: NOW + 11000 }))
  await $.command.run({ command: 'progress', args: '' } as never)
  const waiting = () => w.toasts.filter(t => t.startsWith('Waiting for you:'))
  expect(waiting().length).toBe(1); expect(sounds.length).toBe(1)
  await w.clock.advance(20000); await $.command.run({ command: 'progress', args: '' } as never)
  expect(waiting().length).toBe(1); expect(sounds.length).toBe(1)
})

test('V05 waiting notification defers during recent input and suppresses timestamp ties', async ($, on) => {
  const { w } = await setup($, on)
  w.store.set('settings.notifications', 'toast')
  seedPlan(w, '/h', plan({ id: 'acme/draft', status: 'draft' }))
  await $.command.run({ command: 'progress', args: '' } as never)
  expect(w.toasts.filter(t => t.startsWith('Waiting for you:')).length).toBe(0)
  seedSession(w, session({ id: 'peer', lastUserInput: NOW }))
  await w.clock.advance(11000); await $.command.run({ command: 'progress', args: '' } as never)
  expect(w.toasts.filter(t => t.startsWith('Waiting for you:')).length).toBe(0)
  seedSession(w, session({ id: 'peer', lastUserInput: NOW - 1 }))
  await $.command.run({ command: 'progress', args: '' } as never)
  expect(w.toasts.filter(t => t.startsWith('Waiting for you:')).length).toBe(1)
})
