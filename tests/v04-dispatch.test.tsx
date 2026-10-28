import { expect, enTest as test } from './locale-test'
import { world, seedPlan } from './world'
import { dispatchNow } from '../hooks/controls'
import { controlTransport, sendIssued, captureControlRequests, submitControlRequest, seedAuthorizedControl } from './control-token'
import { MemIo } from './memio'
import { Paths } from '../hooks/store'
import type { EngineInterface } from 'claude-code'
import { plan, PLAN, planDir, savedPlan, seedSession, session, claim, savedSession, NOW } from './v03-fixtures'
const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
const PREFIX = '[progress-board:control:v1]'
async function setup($: any, on: any, remote = false, refuse = false) {
  const w = world(on), sends: any[] = [], spawns: any[] = [], prompts: string[] = [], aborted: string[] = []
  seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()], bg: [{ id: 'owned', taskId: 'owned', direct: true, workerSource: 'claim', kind: 'agent', name: 'assigned worker', startedAt: NOW, claim: { ...claim('p1-3'), by: 'assigned worker' } }] }))
  if (remote) seedSession(w, session({ id: 'lead', nativeName: 'lead', controlVersion: 1, kind: 'orchestrator', title: 'Lead', claims: [claim()], lastActivity: NOW }))
  on('session.send', (_: unknown, e: any) => { sends.push(e); return refuse ? { isDelivered: false, reason: 'Unknown address' } : { isDelivered: true } })
  on('agent.spawn', (_: unknown, e: any) => { spawns.push(e); return { agentId: 'worker1', model: 'session-model' } })
  on('prompt.submit', (_: unknown, e: any) => { prompts.push(e.text); return { text: e.text } })
  on('turn.abort', (_: unknown, e: any) => { aborted.push(e.turnId); return { value: undefined } })
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.receive', (_: unknown, e: any) => ({ text: e.text }))
  controlTransport($, on, ['lead']); on('command.run', () => ({ text: '' }))
  const fills = captureControlRequests(on)
  await $.command.run({ command: 'progress', args: '' })
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-priorities' })
  return { w, ui, sends, spawns, prompts, aborted, fills }
}

test('V04 dispatch needs two presses within five seconds and pins after routing to the orchestrator', async ($, on) => {
  const { w, ui, sends, spawns, fills } = await setup($, on, true)
  await ui.press({ key: 'dispatch-p1-2' }); expect(sends.length).toBe(0)
  await w.clock.advance(5001); await ui.press({ key: 'dispatch-p1-2' }); expect(sends.length).toBe(0)
  await ui.press({ key: 'dispatch-p1-2' })
  expect(savedPlan(w).phases[0]!.items[1]!.priority).toBeUndefined()
  const intent_id = await submitControlRequest($, fills.at(-1)!)
  const issued = await $.tool.call({ tool: 'mcp__progress-board__progress_control', action: 'dispatch_now', intent_id, plan: PLAN, item: 'p1-2' } as never)
  expect(sends.length).toBe(0)
  await sendIssued($, issued)
  expect(savedPlan(w).phases[0]!.items[1]!.priority).toBe('pinned')
  expect(sends.length).toBe(1); expect(sends[0].text).toContain(PREFIX)
  expect(JSON.parse(sends[0].text.slice(PREFIX.length)).to).toBe('lead')
  expect(spawns.length).toBe(0)
  await ui.unmount()
})

test('V05 dispatch without another orchestrator hands context to the model without claiming an invented agent', async ($, on) => {
  const { w, ui, sends, spawns, fills } = await setup($, on)
  await ui.press({ key: 'dispatch-p1-2' }); await ui.press({ key: 'dispatch-p1-2' })
  expect(spawns.length).toBe(0); expect(sends.length).toBe(0)
  expect(savedSession(w).claims.some(c => c.item === 'p1-2')).toBe(false)
  expect(w.processCalls.every(c => c.argv[0] !== 'claude')).toBe(true)
  const intent_id = await submitControlRequest($, fills.at(-1)!)
  const instruction = String((await $.tool.call({ tool: 'mcp__progress-board__progress_control', action: 'dispatch_now', intent_id, plan: PLAN, item: 'p1-2' } as never)).result)
  expect(instruction).toContain('Agent'); expect(instruction).toContain('criteria'); expect(instruction).toContain('/w/acme')
  expect(savedSession(w).claims.some(c => c.item === 'p1-2')).toBe(false)
  expect(savedSession(w).bg.length).toBe(1)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-3', status: 'wrapping', agentId: 'owned' } as never)
  expect(savedPlan(w).phases[0]!.items[2]!.status).toBe('wrapping')
  await ui.unmount()
})

test('V04 dispatch refusal leaves priority unchanged and toasts the engine reason', async ($, on) => {
  const { w, ui, fills } = await setup($, on, true, true)
  await ui.press({ key: 'dispatch-p1-2' }); await ui.press({ key: 'dispatch-p1-2' })
  const intent_id = await submitControlRequest($, fills.at(-1)!)
  const result = await $.tool.call({ tool: 'mcp__progress-board__progress_control', action: 'dispatch_now', intent_id, plan: PLAN, item: 'p1-2' } as never)
  expect(savedPlan(w).phases[0]!.items[1]!.priority).toBeUndefined()
  const transport = await sendIssued($, result)
  expect(savedPlan(w).phases[0]!.items[1]!.priority).toBeUndefined()
  expect(JSON.stringify(transport)).toContain('Unknown address')
  expect(w.toasts.join('\n')).toContain('Unknown address')
  await ui.unmount()
})

test('V04 dispatch envelope is consumed, aborts before submission when asked, and never reaches a model', async ($, on) => {
  const { w, ui, prompts, aborted } = await setup($, on)
  const pinned = savedPlan(w); pinned.phases[0]!.items[1]!.priority = 'pinned'; seedPlan(w, '/h', pinned)
  const nonce = 'dispatch-request'
  const c = { v: 1 as const, to: 's1', from: 'lead', action: 'dispatch' as const, plan: PLAN, item: 'p1-2', interrupt: true, nonce, at: NOW }
  await seedAuthorizedControl(w, c)
  await $.turn.start({ turnId: 'turn-1', prompt: 'work' } as never)
  const text = PREFIX + JSON.stringify(c)
  const result = await $.session.receive({ text, origin: { kind: 'peer', plugin: 'progress-board' } } as never)
  await w.clock.advance(10)
  expect(result.consumed).toBeDefined(); expect(aborted).toEqual(['turn-1'])
  expect(prompts.some(p => p.includes('Dispatch it immediately'))).toBe(true)
  expect(prompts.every(p => !p.includes(PREFIX))).toBe(true)
  await ui.unmount()
})

test('V04 malformed and wrong-target control envelopes are consumed without execution', async ($, on) => {
  const { ui, prompts, aborted } = await setup($, on)
  for (const text of [PREFIX + 'bad json', PREFIX + JSON.stringify({ v: 1, to: 'other', from: 'lead', action: 'dispatch', plan: PLAN, item: 'p1-2' })]) {
    const result = await $.session.receive({ text, origin: { kind: 'peer' } } as never)
    expect(result.consumed).toBeDefined()
  }
  expect(prompts).toEqual([]); expect(aborted).toEqual([])
  await ui.unmount()
})

test('V04 spawned worker can update only its assigned item and releases its claim when it completes', async ($, on) => {
  const { w, ui } = await setup($, on)
  await ui.press({ key: 'dispatch-p1-2' }); await ui.press({ key: 'dispatch-p1-2' })
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', claim: [{ plan: PLAN, item: 'p1-3', by: 'assigned worker' }] } as never)
  const workerId = 'owned'
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-1', status: 'done', meets_criteria: true, agentId: workerId } as never)
  expect(savedPlan(w).phases[0]!.items[0]!.status).toBe('todo')
  expect(String(r.result)).toContain('assigned item')
  await $.turn.complete({ turnId: 'agent-turn', agentId: workerId, answer: 'done', durationMs: 1, reason: 'answer', isAborted: false } as never)
  expect(savedSession(w).claims.some(c => c.item === 'p1-3')).toBe(false)
  await ui.unmount()
})
