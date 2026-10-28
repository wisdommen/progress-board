import { expect, enTest as test } from './locale-test'
import { choices } from '../hooks/settings'
import { newPlan } from '../hooks/model'
import { seedPlan, world } from './world'
import { claim, plan, planDir as oldPlanDir, savedPlan, seedSession, session } from './v03-fixtures'
for (const override of [undefined, false]) test(`V04 automatic merge completion uses global true and plan override ${override}`, async ($, on) => {
  const w = world(on, { coarseClock: true })
  w.store.set('settings.autoDone', true)
  const p = plan({ milestones: ['PR', 'Merge', 'Deploy'], ...(override === false ? { auto_done_on_merge: true } : {}) })
  p.phases[0]!.items[0]!.refs = { pr: [{ repo: 'acme/app', number: 7 }] }
  seedPlan(w, '/h', p); seedSession(w, session({ claims: [claim()] }))
  if (override !== undefined) w.files.set(`${oldPlanDir}/settings.json`, { text: JSON.stringify({ autoDone: override }), m: w.clock.now() })
  w.processReply = argv => argv[0] === 'gh' ? { exitCode: 0, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-27', isDraft: false }), stderr: '' } : undefined
  await $.command.run({ command: 'progress', args: '' } as never); await w.clock.advance(5 * 60_000)
  expect(savedPlan(w).phases[0]!.items[0]!.status).toBe(override === false ? 'wrapping' : 'done')
  expect(savedPlan(w).auto_done_on_merge).toBe(override === false ? true : undefined)
})

const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
const call = { tool: 'mcp__progress-board__progress_session', goal: 'Example work', claim: [{ plan: 'acme/v4' }] } as const
const planPath = '/h/.claude/progress-board/plans/acme%2Fv4'
async function setup($: any, on: any, options = {}) {
  const w = world(on, options)
  seedPlan(w, '/h', { ...newPlan({ id: 'acme/v4', goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['one'] }], includeRelease: false, by: 's1', now: w.clock.now() }), status: 'active' })
  on('tool.call', () => ({ result: {} })); on('command.run', () => ({ text: '' }))
  await $.tool.call(call); await $.command.run({ command: 'progress', args: '' })
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-settings' })
  return { w, ui }
}

test('V06 settings select exact global values and persist separate store keys', async ($, on) => {
  const { w, ui } = await setup($, on)
  const expected: Record<string, unknown> = { barGlyph: '█', enforceGoal: false, stepReminder: 5, awayMinutes: 60, monitor: false, monitorMinutes: 30, autoDone: true, retention: 72, contextWarning: 90, notifications: 'toast' }
  for (const [key, value] of Object.entries(expected)) {
    await ui.press({ key: `setting-${key}-${(choices[key as keyof typeof choices] as readonly unknown[]).indexOf(value)}` })
    expect(w.store.get(`settings.${key}`)).toBe(value)
  }
  await ui.unmount()
})

test('V04 settings use userConfig defaults then read remote updates live', { options: { enforceGoal: false, barGlyph: '▅', monitor: false, monitorMinutes: 10 } }, async ($, on) => {
  const { w, ui } = await setup($, on)
  expect((await ui.find({ key: 'setting-barGlyph-2' }))?.text).toContain('[▅]')
  expect((await ui.find({ key: 'setting-enforceGoal-1' }))?.text).toContain('[Off]')
  w.store.set('settings.barGlyph', '█'); w.store.set('settings.monitor', true)
  await w.clock.advance(10_000)
  expect((await ui.find({ key: 'setting-barGlyph-1' }))?.text).toContain('[█]')
  expect((await ui.find({ key: 'setting-monitor-0' }))?.text).toContain('[On]')
  w.store.set('settings.barGlyph', 'invalid'); await w.clock.advance(10_000)
  expect((await ui.find({ key: 'setting-barGlyph-2' }))?.text).toContain('[▅]')
  await ui.unmount()
})

test('V06 plan settings select exact inherited overrides under the plan lock', async ($, on) => {
  const { w, ui } = await setup($, on)
  const read = () => JSON.parse(w.files.get(`${planPath}/settings.json`)?.text ?? '{}')
  expect((await ui.find({ key: 'plan-setting-monitor-0' }))?.text).toContain('Follow global')
  await ui.press({ key: 'plan-setting-monitor-1' }); expect(read().monitor).toBe(true)
  await ui.press({ key: 'plan-setting-monitor-2' }); expect(read().monitor).toBe(false)
  await ui.press({ key: 'plan-setting-monitor-0' }); expect(read().monitor).toBeUndefined()
  await ui.press({ key: 'plan-setting-monitorMinutes-1' }); expect(read().monitorMinutes).toBe(5)
  await ui.press({ key: 'plan-setting-autoDone-2' }); expect(read().autoDone).toBe(true)
  expect(w.processCalls.some(c => c.argv[0] === 'mkdir' && c.argv[1] === `${planPath}/.lock`)).toBe(true)
  await ui.unmount()
})

test('V04 language command persists a code and language controls follow host again', async ($, on) => {
  const { w, ui } = await setup($, on)
  await $.command.run({ command: 'progress', args: 'lang de' } as never)
  expect(w.store.get('language')).toBe('de')
  expect((await ui.find({ key: 'tab-settings' }))?.text).toBe('Einstellungen')
  await ui.press({ key: 'language-follow' })
  expect(w.store.get('language')).toBe(null)
  expect((await ui.find({ key: 'tab-settings' }))?.text).toBe('Settings')
  await ui.unmount()
})

test('V04 setting the step threshold changes reminders, not existing progress', async ($, on) => {
  const { w, ui } = await setup($, on)
  await ui.press({ key: 'setting-stepReminder-1' })
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', steps: [{ title: 'work', status: 'doing' }] } as never)
  const outcomes = []
  for (let i = 0; i < 5; i++) outcomes.push(await $.tool.call({ tool: 'Bash', command: 'pwd' } as never))
  expect(outcomes.slice(0, 4).every(r => !r.context?.some(x => x.includes('step_updates')))).toBe(true)
  expect(outcomes[4]?.context?.some(x => x.includes('step_updates'))).toBe(true)
  expect(w.store.get('settings.stepReminder')).toBe(5)
  await ui.unmount()
})
