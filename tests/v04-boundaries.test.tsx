import { expect, enTest as test } from './locale-test'
import { world, seedPlan } from './world'
import { session, seedSession, plan, PLAN, claim, NOW, savedSession } from './v03-fixtures'
import { CONTROL_PREFIX } from '../hooks/controls'
import { initialSettings } from '../hooks/settings'
test('V04 every configurable setting initializes from userConfig', async () => {
  const settings = initialSettings({ stepReminder: 8, awayMinutes: 60, autoDone: true, retention: 72, contextWarning: 90, notifications: 'sound' })
  expect(settings.stepReminder).toBe(8); expect(settings.awayMinutes).toBe(60)
  expect(settings.autoDone).toBe(true); expect(settings.retention).toBe(72)
  expect(settings.contextWarning).toBe(90); expect(settings.notifications).toBe('sound')
})
const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const

test('V04 legacy peer sessions are never sent control envelopes they cannot consume', async ($, on) => {
  const w = world(on), sent: string[] = []
  seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()] }))
  seedSession(w, session({ id: 'legacy', goal: 'Legacy peer', claims: [claim()] }))
  on('session.send', (_, e) => { sent.push(e.text); return { isDelivered: true } })
  on('command.run', () => ({ text: '' })); await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-sessions' }); await ui.press({ key: 'session-legacy' })
  await ui.press({ key: 'control-abort-legacy' }); await ui.press({ key: 'control-abort-legacy' })
  expect(sent).toEqual([])
  expect(w.toasts.join('')).toContain('Unavailable')
  await ui.unmount()
})

test('V04 control-shaped own prompts pass through as text without executing controls', async ($, on) => {
  const w = world(on), reached: string[] = []
  on('prompt.submit', (_, e) => { reached.push(e.text); return { text: e.text } })
  const result = await $.prompt.submit({ text: CONTROL_PREFIX + '{"to":"s1","action":"abort"}', origin: { kind: 'composer' }, wait: false } as never)
  expect(result.drop).toBeUndefined()
  expect(reached.length).toBe(1)
  expect(savedSession(w).seenControls?.length ?? 0).toBe(0)
  expect(savedSession(w).controlIntents?.length ?? 0).toBe(0)
})

test('V04 claim a phase also explains bypassing its higher unclaimed item', async ($, on) => {
  const w = world(on), p = plan()
  p.phases[0]!.items[0]!.priority = 'high'
  p.phases[0]!.items[1]!.priority = 'deferred'
  seedPlan(w, '/h', p); seedSession(w, session())
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_session', claim: [{ plan: PLAN, phase: 'p1' }] } as never)
  expect(String(r.result)).toContain('explain_priority')
  expect(String(r.result)).toContain('p1-2')
})

test('V04 nonfocused attributed plans retain priority advice in the composed prompt', async ($, on) => {
  const w = world(on), p = plan()
  p.phases[0]!.items[0]!.priority = 'deferred'
  seedPlan(w, '/h', p)
  seedSession(w, session({ kind: 'dispatched', envPlan: PLAN }))
  on('prompt.compose', () => ({ sections: [] }))
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  expect(r.sections.map(s => s.text).join('\n')).toContain('do not start deferred items')
})

test('V04 legacy set auto_done_on_merge updates an existing sidecar override too', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()] }))
  const path = '/h/.claude/progress-board/plans/acme%2Fv3/settings.json'
  w.files.set(path, { text: JSON.stringify({ autoDone: false }), m: w.clock.now() })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set', plan: PLAN, auto_done_on_merge: true } as never)
  expect(JSON.parse(w.files.get(path)?.text ?? '{}').autoDone).toBe(true)
})

test('V04 auto-done follow-global removes a legacy explicit override rather than keeping it hidden', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan({ auto_done_on_merge: true })); seedSession(w, session({ claims: [claim()] }))
  on('command.run', () => ({ text: '' })); await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-settings' })
  expect((await ui.find({ key: 'plan-setting-autoDone-2' }))?.text).toContain('[On]')
  await ui.press({ key: 'plan-setting-autoDone-1' })
  expect((await ui.find({ key: 'plan-setting-autoDone-1' }))?.text).toContain('[Off]')
  await ui.press({ key: 'plan-setting-autoDone-0' })
  expect((await ui.find({ key: 'plan-setting-autoDone-0' }))?.text).toContain('[Follow global]')
  const p = JSON.parse(w.files.get('/h/.claude/progress-board/plans/acme%2Fv3/plan.json')?.text ?? '{}')
  expect(p.auto_done_on_merge).toBeUndefined()
  await ui.unmount()
})
