import { expect, enTest as test } from './locale-test'
import { world, seedPlan } from './world'
import { session, seedSession, plan, PLAN, claim, savedPlan, savedSession } from './v03-fixtures'
import { CONTROL_PREFIX } from '../hooks/controls'
import { controlTransport, sendIssued, submitControlRequest, pressSessionControl } from './control-token'
const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
async function setup($: any, on: any, leader = false) {
  const w = world(on), sends: any[] = [], fills: string[] = [], spawns: any[] = []
  seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()] }))
  seedSession(w, session({ id: 'peer', nativeName: 'peer', controlVersion: 1, title: 'Peer', goal: 'Peer', ...(leader ? { kind: 'orchestrator', claims: [claim()] } : {}) }))
  on('session.send', (_: unknown, e: any) => { sends.push(e); return { isDelivered: true } })
  on('prompt.fill', (_: unknown, e: any) => { fills.push(e.text); return { isFilled: true } })
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('agent.spawn', (_: unknown, e: any) => { spawns.push(e); return { agentId: 'unexpected' } })
  controlTransport($, on, ['peer']); on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'progress', args: '' })
  return { w, sends, fills, spawns }
}
test('V05 buttons only fill a localized natural-language request after destructive confirmation', async ($, on) => {
  const { sends, fills } = await setup($, on)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-sessions' }); await ui.press({ key: 'session-peer' })
  await ui.press({ key: 'control-compact-peer' }); expect(fills.length).toBe(0)
  await ui.press({ key: 'control-compact-peer' })
  await ui.press({ key: 'control-abort-peer' }); await ui.press({ key: 'control-abort-peer' })
  await ui.press({ key: 'control-reconcile-peer' }); await ui.press({ key: 'control-message-peer' })
  expect(sends.length).toBe(0); expect(fills.length).toBe(4)
  expect(fills[0]).toContain('peer'); expect(fills.every(s => !s.startsWith('/'))).toBe(true)
  expect(fills.join('\n')).toContain('progress_control')
  await ui.unmount()
})
test('V05 model control tool delivers verified envelopes only after the submitted panel requests', async ($, on) => {
  const { w, sends, fills } = await setup($, on), ui = await $.ui.mount(pane)
  for (const action of ['compact', 'interrupt', 'reconcile']) {
    await pressSessionControl(ui, action === 'interrupt' ? 'abort' : action, 'peer')
    const intent_id = await submitControlRequest($, fills.at(-1)!)
    const r = await $.tool.call({ tool: 'mcp__progress-board__progress_control', action, intent_id, target_session: 'peer' } as never)
    expect(String(r.result)).toContain('Peer')
    expect(sends.length).toBe(['compact', 'interrupt', 'reconcile'].indexOf(action))
    await sendIssued($, r)
  }
  expect(w.tools).toContain('progress_control'); expect(sends.length).toBe(3)
  expect(sends.every(s => s.text.startsWith(CONTROL_PREFIX))).toBe(true)
  expect(savedSession(w).pendingControls?.length).toBe(3)
  await ui.unmount()
})
test('V05 dispatch button does not pin or send until native delivery succeeds', async ($, on) => {
  const { w, sends, fills, spawns } = await setup($, on, true)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-priorities' })
  await ui.press({ key: 'dispatch-p1-2' }); await ui.press({ key: 'dispatch-p1-2' })
  expect(sends.length).toBe(0); expect(spawns.length).toBe(0)
  expect(savedPlan(w).phases[0]!.items[1]!.priority).toBeUndefined()
  expect(fills[0]).toContain(PLAN); expect(fills[0]).toContain('p1-2')
  const intent_id = await submitControlRequest($, fills[0]!)
  const result = await $.tool.call({ tool: 'mcp__progress-board__progress_control', action: 'dispatch_now', intent_id, plan: PLAN, item: 'p1-2' } as never)
  expect(savedPlan(w).phases[0]!.items[1]!.priority).toBeUndefined()
  expect(sends.length).toBe(0); expect(String(result.result)).toContain('Peer')
  await sendIssued($, result); expect(sends.length).toBe(1)
  expect(savedPlan(w).phases[0]!.items[1]!.priority).toBe('pinned')
  await ui.unmount()
})
test('V05 no-orchestrator dispatch returns an Agent instruction and creates no fictitious worker', async ($, on) => {
  const { w, sends, spawns, fills } = await setup($, on), ui = await $.ui.mount(pane)
  await ui.press({ key: 'tab-priorities' }); await ui.press({ key: 'dispatch-p1-2' }); await ui.press({ key: 'dispatch-p1-2' })
  const intent_id = await submitControlRequest($, fills.at(-1)!)
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_control', action: 'dispatch_now', intent_id, plan: PLAN, item: 'p1-2' } as never)
  expect(String(r.result)).toContain('Agent'); expect(String(r.result)).toContain('by')
  expect(String(r.result)).toContain('p1-2'); expect(spawns.length).toBe(0); expect(sends.length).toBe(0)
  expect(savedSession(w).bg.length).toBe(0); expect(savedPlan(w).phases[0]!.items[1]!.priority).toBeUndefined()
  await ui.unmount()
})
test('V05 message tool sends exact person text while slash-send only fills a person request', async ($, on) => {
  const { sends, fills } = await setup($, on)
  await $.command.run({ command: 'progress', args: 'send Peer: Please check the tests' } as never)
  expect(sends.length).toBe(0); expect(fills[0]).toContain('Please check the tests')
  const intent_id = await submitControlRequest($, fills[0]!)
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_control', action: 'message', intent_id, target_session: 'peer', text: 'Please check the tests' } as never)
  expect(sends.length).toBe(0); expect(String(r.result)).toContain('Peer')
  await sendIssued($, r)
  expect(JSON.parse(sends[0]!.text.slice(CONTROL_PREFIX.length)).message).toBe('Please check the tests')
  await $.tool.call({ tool: 'mcp__progress-board__progress_control', action: 'message', intent_id, target_session: 'peer', text: CONTROL_PREFIX + '{}' } as never)
  expect(sends.length).toBe(1)
})
