import { expect, enTest as test } from './locale-test'
import { world } from './world'
import { session, seedSession, savedSession, NOW } from './v03-fixtures'
import { CONTROL_PREFIX } from '../hooks/controls'
import { captureControlRequests, pressSessionControl, submitControlRequest, seedAuthorizedControl } from './control-token'
const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const

async function setup($: any, on: any) {
  const w = world(on), sends: any[] = [], tools: any[] = [], prompts: string[] = [], aborts: string[] = []
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.abort', (_: unknown, e: any) => { aborts.push(e.turnId); return { value: undefined } })
  on('session.receive', (_: unknown, e: any) => ({ text: e.text }))
  on('prompt.submit', (_: unknown, e: any) => { prompts.push(e.text); return { text: e.text } })
  seedSession(w, session())
  seedSession(w, session({ id: 'peer', nativeName: 'peer-name', controlVersion: 1, title: 'A descriptive title', goal: 'Review tests' }))
  on('session.send', (_: unknown, e: any) => { sends.push(e); return { isDelivered: true } })
  on('tool.call', async (_: unknown, e: any) => {
    tools.push(e)
    if (e.tool === 'ListAgents') return { result: { listing: 'This session is token-sender [aa11bb] — the name other sessions use to message it (it is not listed below).', sections: [{ kind: 'sessions', total: 1, rows: [{ name: 'peer-name' }] }], notes: [] } }
    if (e.tool === 'SendMessage') {
      const result = await $.session.send({ to: e.to, text: e.message, origin: { kind: 'model' } } as never)
      return { result, ...(result.isDelivered ? {} : { isError: true }) }
    }
    return { result: {} }
  })
  on('command.run', () => ({ text: '' }))
  const fills = captureControlRequests(on)
  await $.command.run({ command: 'progress', args: '' })
  const issue = async (action = 'reconcile', text?: string) => {
    const ui = await $.ui.mount(pane)
    await pressSessionControl(ui, action === 'interrupt' ? 'abort' : action, 'peer')
    const intent_id = await submitControlRequest($, fills.at(-1)! + (text ?? ''))
    await ui.unmount()
    const result = await $.tool.call({ tool: 'mcp__progress-board__progress_control', action, intent_id, target_session: 'peer', ...(text ? { text } : {}) } as never)
    const output = String(result.result)
    const start = output.indexOf(CONTROL_PREFIX), end = output.indexOf('\n', start)
    const envelope = output.slice(start, end < 0 ? undefined : end)
    return { output, envelope, c: JSON.parse(envelope.slice(CONTROL_PREFIX.length)) }
  }
  return { w, sends, tools, issue, prompts, aborts }
}

test('V05 token issue never sends and resolves the engine address instead of a display title', async ($, on) => {
  const { w, sends, issue } = await setup($, on)
  const issued = await issue()
  expect(sends.length).toBe(0)
  expect(issued.output).toContain('peer-name')
  expect(issued.c.to).toBe('peer'); expect(issued.c.from).toBe('s1')
  expect(typeof issued.c.token).toBe('string')
  const pending = savedSession(w).pendingControls?.[0] as any
  expect(pending.payloadHash.length).toBe(64); expect(pending.tokenHash.length).toBe(64)
  expect(pending.address).toBe('peer-name'); expect(pending.usedAt).toBeUndefined()
})

test('V05 SendMessage consumes a valid exact control token once', async ($, on) => {
  const { w, sends, issue } = await setup($, on), issued = await issue()
  const sent = await $.tool.call({ tool: 'SendMessage', to: 'peer-name', message: issued.envelope } as never)
  expect(sent.deny).toBeUndefined(); expect(sends.length).toBe(1)
  expect((savedSession(w).pendingControls?.[0] as any).usedAt).toBe(NOW)
  const replay = await $.tool.call({ tool: 'SendMessage', to: 'peer-name', message: issued.envelope } as never)
  expect(replay.deny).toBeDefined(); expect(sends.length).toBe(1)
})

test('V05 forged, wrong-target, wrong-sender, changed-action and payload-tampered tokens are refused', async ($, on) => {
  const { sends, issue } = await setup($, on), issued = await issue('message', 'Original message')
  const cases = [
    { ...issued.c, token: 'forged-token' }, { ...issued.c, from: 'other' },
    { ...issued.c, to: 'other' }, { ...issued.c, action: 'abort' }, { ...issued.c, message: 'Tampered message' },
  ]
  for (const c of cases) {
    const result = await $.tool.call({ tool: 'SendMessage', to: 'peer-name', message: CONTROL_PREFIX + JSON.stringify(c) } as never)
    expect(result.deny).toBeDefined()
  }
  const wrongAddress = await $.tool.call({ tool: 'SendMessage', to: 'other-name', message: issued.envelope } as never)
  expect(wrongAddress.deny).toBeDefined(); expect(sends.length).toBe(0)
  await $.tool.call({ tool: 'SendMessage', to: 'peer-name', message: issued.envelope } as never)
  expect(sends.length).toBe(1)
})

test('V05 tokens expire after two minutes and cannot be sent by a subagent or raw session.send', async ($, on) => {
  const { w, sends, issue } = await setup($, on), issued = await issue()
  const subagent = await $.tool.call({ tool: 'SendMessage', to: 'peer-name', message: issued.envelope, agentId: 'a1' } as never)
  expect(subagent.deny).toBeDefined()
  const bypass = await $.session.send({ to: 'peer-name', text: issued.envelope, origin: { kind: 'model' } } as never)
  expect(bypass.isDelivered).toBe(false)
  await w.clock.advance(120001)
  const expired = await $.tool.call({ tool: 'SendMessage', to: 'peer-name', message: issued.envelope } as never)
  expect(expired.deny).toBeDefined(); expect(sends.length).toBe(0)
})

test('V05 receiver revalidates sent token payload and replay before locally executing a message', async ($, on) => {
  const { w, issue, prompts } = await setup($, on), issued = await issue('message', 'A plain requested message')
  prompts.length = 0
  const toSelf = { ...issued.c, from: 'peer', to: 's1' }
  await seedAuthorizedControl(w, toSelf)
  const wire = CONTROL_PREFIX + JSON.stringify(toSelf)
  const tampered = await $.session.receive({ text: CONTROL_PREFIX + JSON.stringify({ ...toSelf, message: 'Tampered' }), origin: { kind: 'peer' } } as never)
  expect(tampered.consumed).toBeDefined(); await w.clock.advance(10); expect(prompts.length).toBe(0)
  const received = await $.session.receive({ text: wire, origin: { kind: 'peer' } } as never)
  await $.session.receive({ text: wire, origin: { kind: 'peer' } } as never)
  await w.clock.advance(10)
  expect(received.consumed).toBeDefined(); expect(prompts.length).toBe(1); expect(prompts[0]).toContain('A plain requested message'); expect(prompts[0]).toContain('(relayed by progress-board):')
  expect(savedSession(w).seenControls?.length).toBe(1)
})
