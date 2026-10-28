import { expect, enTest as test } from './locale-test'
import { world, seedPlan } from './world'
import { session, seedSession, savedSession, savedPlan, plan, claim, NOW, PLAN, planDir } from './v03-fixtures'
import { CONTROL_PREFIX } from '../hooks/controls'
import { sendIssued } from './control-token'

const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 100 }, view: {} } } as const
async function setup($: any, on: any, remote = false, deliver = true, legacyWorker = false) {
  const w = world(on, { coarseClock: true }), fills: string[] = [], sends: any[] = [], native: any[] = []
  seedPlan(w, '/h', plan()); seedSession(w, session({ goal: 'Control regression', claims: [claim()], ...(legacyWorker ? { bg: [{ id: 'old-call', taskId: 'old-reviewer', kind: 'agent' as const, direct: true, name: 'Old review p1-2', startedAt: NOW, claim: { ...claim('p1-2'), by: 'Old review p1-2' } }] } : {}) }))
  seedSession(w, session({ id: 'peer', nativeName: 'peer', title: 'Peer', goal: 'Peer', controlVersion: 1, ...(remote ? { kind: 'orchestrator', claims: [claim()] } : {}) }))
  on('prompt.fill', (_: unknown, e: any) => { fills.push(e.text); return { isFilled: true } })
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('session.receive', (_: unknown, e: any) => ({ text: e.text }))
  on('session.send', (_: unknown, e: any) => { sends.push(e); return deliver ? { isDelivered: true } : { isDelivered: false, reason: 'Native delivery refused' } })
  on('tool.call', async (_: unknown, e: any) => {
    native.push(e)
    if (e.tool === 'ListAgents') return { result: { listing: 'This session is control-sender [aa11bb] — the name other sessions use to message it (it is not listed below).', sections: [{ kind: 'sessions', total: 1, rows: [{ name: 'peer' }] }], notes: [] } }
    if (e.tool === 'SendMessage' && typeof e.message === 'string') {
      const result = await $.session.send({ to: e.to, text: e.message, origin: { kind: 'model' } } as never)
      return { result, ...(result.isDelivered ? {} : { isError: true }) }
    }
    if (e.tool === 'Agent') return { result: { status: 'async_launched', agentId: 'real-worker' } }
    return { result: { native: true } }
  })
  on('command.run', () => ({ text: '' })); on('agent.list', () => ({ value: [{ id: 'real-worker', name: 'worker', status: 'running', type: 'general-purpose' }] }))
  await $.command.run({ command: 'progress', args: '' })
  const ui = await $.ui.mount(pane)
  const request = async (action = 'reconcile', text = '') => {
    await ui.press({ key: 'tab-sessions' })
    if (!await ui.find({ key: `control-${action}-peer` })) await ui.press({ key: 'session-peer' })
    await ui.press({ key: `control-${action}-peer` })
    if (action === 'compact' || action === 'abort') await ui.press({ key: `control-${action}-peer` })
    const prompt = fills.at(-1)! + text
    const intent_id = /intent_id=([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
    return { prompt, intent_id }
  }
  const dispatch = async () => {
    await ui.press({ key: 'tab-priorities' }); await ui.press({ key: 'dispatch-p1-2' }); await ui.press({ key: 'dispatch-p1-2' })
    const prompt = fills.at(-1)!, intent_id = /intent_id=([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
    return { prompt, intent_id }
  }
  const submit = async (text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false } as never)
  const control = async (input: any) => $.tool.call({ tool: 'mcp__progress-board__progress_control', ...input } as never)
  return { w, ui, fills, sends, native, request, dispatch, submit, control }
}

test('V06 no person intent refuses every control, including dispatch, without plan mutation', async ($, on) => {
  const f = await setup($, on, true)
  for (const action of ['compact', 'reconcile', 'interrupt', 'message', 'dispatch_now']) {
    const r = await f.control({ action, target_session: 'peer', text: 'Run this', plan: PLAN, item: 'p1-2' })
    expect(String(r.result)).toContain('panel')
    expect(String(r.result)).not.toContain(CONTROL_PREFIX)
  }
  expect(savedSession(f.w).pendingControls?.length ?? 0).toBe(0)
  expect(savedPlan(f.w).phases[0]!.items[1]!.priority).toBeUndefined()
  await f.ui.unmount()
})

test('V06 panel intent requires its id in the most recent own prompt and is consumed exactly once', async ($, on) => {
  const f = await setup($, on), intent = await f.request()
  expect(typeof intent.intent_id).toBe('string')
  expect(savedSession(f.w).controlIntents?.length).toBe(1)
  expect(String((await f.control({ action: 'reconcile', target_session: 'peer', intent_id: intent.intent_id })).result)).not.toContain(CONTROL_PREFIX)
  await f.submit(intent.prompt, 'peer-send-message')
  expect(String((await f.control({ action: 'reconcile', target_session: 'peer', intent_id: intent.intent_id })).result)).not.toContain(CONTROL_PREFIX)
  await f.submit(intent.prompt)
  const issued = await f.control({ action: 'reconcile', target_session: 'peer', intent_id: intent.intent_id })
  expect(String(issued.result)).toContain(CONTROL_PREFIX)
  expect(savedSession(f.w).controlIntents?.[0]?.usedAt).toBe(NOW)
  expect(String((await f.control({ action: 'reconcile', target_session: 'peer', intent_id: intent.intent_id })).result)).not.toContain(CONTROL_PREFIX)
  await f.ui.unmount()
})

test('V06 an unrelated later own prompt invalidates a still unspent panel request', async ($, on) => {
  const f = await setup($, on), intent = await f.request()
  await f.submit(intent.prompt); await f.submit('Please read the source instead')
  expect(String((await f.control({ action: 'reconcile', target_session: 'peer', intent_id: intent.intent_id })).result)).not.toContain(CONTROL_PREFIX)
  await f.ui.unmount()
})

test('V06 intents bind exact action target message payload and expire after ten minutes', async ($, on) => {
  const f = await setup($, on), intent = await f.request('message', 'Exact requested text')
  await f.submit(intent.prompt)
  for (const change of [{ action: 'interrupt' }, { target_session: 's1' }, { text: 'Changed by the model' }]) {
    const r = await f.control({ action: 'message', target_session: 'peer', text: 'Exact requested text', intent_id: intent.intent_id, ...change })
    expect(String(r.result)).not.toContain(CONTROL_PREFIX)
  }
  await f.w.clock.advance(600001)
  expect(String((await f.control({ action: 'message', target_session: 'peer', text: 'Exact requested text', intent_id: intent.intent_id })).result)).not.toContain(CONTROL_PREFIX)
  await f.ui.unmount()
})

test('V06 slash send binds the exact person message and never grants authority to tool output', async ($, on) => {
  const f = await setup($, on)
  await $.command.run({ command: 'progress', args: 'send Peer: Please check the tests' } as never)
  const prompt = f.fills.at(-1)!, intent_id = /intent_id=([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
  expect(typeof intent_id).toBe('string'); await f.submit(prompt, 'bridge')
  const issued = await f.control({ action: 'message', target_session: 'peer', text: 'Please check the tests', intent_id })
  expect(String(issued.result)).toContain(CONTROL_PREFIX); await sendIssued($, issued)
  expect(f.sends.length).toBe(1)
  await f.ui.unmount()
})

test('V06 dispatch pins only after native send succeeds and records actual intent provenance', async ($, on) => {
  const f = await setup($, on, true), intent = await f.dispatch()
  await f.submit(intent.prompt)
  const issued = await f.control({ action: 'dispatch_now', plan: PLAN, item: 'p1-2', intent_id: intent.intent_id })
  expect(String(issued.result)).toContain(CONTROL_PREFIX)
  expect(savedPlan(f.w).phases[0]!.items[1]!.priority).toBeUndefined()
  await sendIssued($, issued)
  expect(savedPlan(f.w).phases[0]!.items[1]!.priority).toBe('pinned')
  const row = (f.w.files.get(`${planDir}/log.jsonl`)?.text ?? '').split('\n').filter(Boolean).map(x => JSON.parse(x)).find(x => x.action === 'dispatch-now')
  expect(row?.source).toBe('panel'); expect(row?.intentId).toBe(intent.intent_id)
  await f.ui.unmount()
})

test('V06 failed native dispatch never pins or writes a false dispatch log', async ($, on) => {
  const f = await setup($, on, true, false), intent = await f.dispatch()
  await f.submit(intent.prompt)
  const issued = await f.control({ action: 'dispatch_now', plan: PLAN, item: 'p1-2', intent_id: intent.intent_id })
  await sendIssued($, issued)
  expect(savedPlan(f.w).phases[0]!.items[1]!.priority).toBeUndefined()
  expect(f.w.files.get(`${planDir}/log.jsonl`)?.text ?? '').not.toContain('dispatch-now')
  await f.ui.unmount()
})

test('V06 ordinary agents have attribution but no worker authority; explicit by grants only its assigned item', async ($, on) => {
  const f = await setup($, on)
  await $.tool.call({ tool: 'Agent', description: 'Review p1-2', prompt: `Plan: ${PLAN}\nReview item p1-2`, subagent_type: 'general-purpose' } as never)
  expect(savedSession(f.w).bg[0]?.direct).not.toBe(true)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-2', status: 'done', meets_criteria: true, agentId: 'real-worker' } as never)
  expect(savedPlan(f.w).phases[0]!.items[1]!.status).toBe('todo')
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', claim: [{ plan: PLAN, item: 'p1-2', by: 'worker' }] } as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-2', status: 'wrapping', agentId: 'real-worker' } as never)
  expect(savedPlan(f.w).phases[0]!.items[1]!.status).toBe('wrapping')
  await f.ui.unmount()
})

test('V06 legacy blanket direct flags never become authority without a marker or explicit by', async ($, on) => {
  const f = await setup($, on, false, true, true)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-2', status: 'wrapping', agentId: 'old-reviewer' } as never)
  expect(savedPlan(f.w).phases[0]!.items[1]!.status).toBe('todo')
  await f.ui.unmount()
})

test('V06 local dispatch markers grant worker authority only once a real Agent starts', async ($, on) => {
  const f = await setup($, on), intent = await f.dispatch()
  await f.submit(intent.prompt)
  const issued = await f.control({ action: 'dispatch_now', plan: PLAN, item: 'p1-2', intent_id: intent.intent_id }), prompt = String(issued.result)
  expect(prompt).toContain('[progress-board:dispatch:')
  expect(savedPlan(f.w).phases[0]!.items[1]!.priority).toBeUndefined()
  await $.tool.call({ tool: 'Agent', description: 'Implement p1-2', prompt, subagent_type: 'general-purpose' } as never)
  expect(savedSession(f.w).bg[0]?.direct).toBe(true)
  expect(savedPlan(f.w).phases[0]!.items[1]!.priority).toBe('pinned')
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, phase: 'p1', item: 'p1-2', status: 'wrapping', agentId: 'real-worker' } as never)
  expect(savedPlan(f.w).phases[0]!.items[1]!.status).toBe('wrapping')
  await f.ui.unmount()
})

test('V06 SendMessage idle subscription without message passes through untouched', async ($, on) => {
  const f = await setup($, on)
  const result = await $.tool.call({ tool: 'SendMessage', to: 'peer', notify_when_idle: true } as never)
  expect(result.deny).toBeUndefined(); expect((result.result as any)?.native).toBe(true)
  expect(f.native.at(-1)?.message).toBeUndefined(); expect(f.native.at(-1)?.notify_when_idle).toBe(true)
  await f.ui.unmount()
})

test('V06 disabled mod passes control-shaped sends receives and prompts through unchanged', async ($, on) => {
  const w = world(on), calls: string[] = []
  on('session.start', () => ({ cwd: '/w/acme' })); on('session.receive', (_: unknown, e: any) => { calls.push('receive'); return { text: e.text } })
  on('session.send', () => { calls.push('send'); return { isDelivered: true } })
  on('prompt.submit', (_: unknown, e: any) => { calls.push('prompt'); return { text: e.text } })
  on('tool.call', () => { calls.push('tool'); return { result: { native: true } } })
  await $.session.start({ sessionId: 's1', cwd: '/w/acme', isInteractive: false, isResume: false } as never)
  const text = CONTROL_PREFIX + '{}'
  const result = await $.tool.call({ tool: 'SendMessage', to: 'peer', message: text } as never)
  expect(result.deny).toBeUndefined()
  expect((await $.session.receive({ text, origin: { kind: 'peer' } } as never)).consumed).toBeUndefined()
  expect((await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)).drop).toBeUndefined()
  expect((await $.session.send({ text, to: 'peer', origin: { kind: 'model' } } as never)).isDelivered).toBe(true)
  expect(calls).toContain('receive'); expect(calls).toContain('prompt'); expect(calls).toContain('send'); expect(w.files.size).toBe(0)
})
