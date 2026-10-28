import { expect, enTest as test } from './locale-test'
import { world, seedPlan } from './world'
import { plan, PLAN, seedSession, session, claim, savedSession, NOW } from './v03-fixtures'
import { CONTROL_PREFIX } from '../hooks/controls'
import { seedAuthorizedControl } from './control-token'
const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
async function setup($: any, on: any) {
  const w = world(on), sends: any[] = [], compacts: string[] = [], aborts: string[] = [], prompts: string[] = [], fills: string[] = []
  seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()] }))
  seedSession(w, session({ id: 'peer', controlVersion: 1, title: 'Peer Session', goal: 'Peer Session', claims: [claim()], lastActivity: NOW - 180_000 }))
  seedSession(w, session({ id: 'old', title: 'Old session', goal: 'Old session', endedAt: NOW - 48 * 3600_000 }))
  on('session.send', (_: unknown, e: any) => { sends.push(e); return { isDelivered: true } })
  on('session.compact', () => { compacts.push('compact'); return { messages: [{ role: 'assistant', text: 'summary', toolUses: [] }] } })
  on('turn.abort', (_: unknown, e: any) => { aborts.push(e.turnId); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 124000, window: 200000, percent: 62 }, rateLimits: [], cost: { usd: 1.25 } } }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId })); on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: unknown, e: any) => { prompts.push(e.text); return { text: e.text } })
  on('prompt.fill', (_: unknown, e: any) => { fills.push(e.text); return { isFilled: true } })
  on('session.receive', (_: unknown, e: any) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [] })); on('tool.call', () => ({ result: {} })); on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'progress', args: '' }); const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-sessions' }); await ui.press({ key: 'session-peer' })
  return { w, ui, sends, compacts, aborts, prompts, fills }
}
const control = (action: string, more = {}) => CONTROL_PREFIX + JSON.stringify({ v: 1, action, to: 's1', from: 'peer', nonce: `${action}-request`, at: NOW, ...more })

test('V04 session cards persist own usage model final reply and respect retention', async ($, on) => {
  const { w, ui } = await setup($, on)
  await $.prompt.compose({ model: 'session-model', promptModel: 'session-model', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  await $.turn.start({ turnId: 't1', prompt: 'go' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Final result '.repeat(20), reason: 'answer', durationMs: 2, isAborted: false } as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const text = (await ui.findAll({ type: 'Text' })).map((x: { text: string }) => x.text).join('\n')
  expect(text).toContain('session-model'); expect(text).toContain('62%'); expect(text).toContain('1.25')
  expect(text).toContain('Last reply:'); expect(text).not.toContain('Old session')
  expect((savedSession(w) as any).context.percent).toBe(62)
  expect((savedSession(w) as any).lastMessage.length).toBeLessThan(90)
  expect(await ui.find({ key: 'control-abort-s1' })).toBeUndefined()
  expect(await ui.find({ key: 'control-compact-s1' })).toBeUndefined()
  w.store.set('settings.retention', 72); await w.clock.advance(10_000)
  expect((await ui.findAll({ type: 'Text' })).map((x: { text: string }) => x.text).join('\n')).toContain('Old session')
  await ui.unmount()
})

test('V05 session controls confirm abort and compact before filling model-tool requests', async ($, on) => {
  const { ui, sends, fills } = await setup($, on)
  await ui.press({ key: 'control-abort-peer' }); expect(fills.length).toBe(0)
  expect((await ui.find({ key: 'control-abort-peer' }))?.text).toContain('again')
  await ui.press({ key: 'control-abort-peer' }); expect(fills.length).toBe(1)
  await ui.press({ key: 'control-compact-peer' }); expect(fills.length).toBe(1)
  await ui.press({ key: 'control-compact-peer' }); expect(fills.length).toBe(2)
  await ui.press({ key: 'control-reconcile-peer' }); expect(fills.length).toBe(3)
  expect(sends.length).toBe(0); expect(fills.every(text => text.includes('progress_control'))).toBe(true)
  await ui.unmount()
})

test('V04 compact defers during a turn and runs after its end; reconcile queues only the instruction', async ($, on) => {
  const { w, ui, compacts, prompts } = await setup($, on)
  const compact = JSON.parse(control('compact').slice(CONTROL_PREFIX.length))
  await seedAuthorizedControl(w, compact)
  await $.turn.start({ turnId: 't1', prompt: 'go' } as never)
  const result = await $.session.receive({ text: CONTROL_PREFIX + JSON.stringify(compact), origin: { kind: 'peer' } } as never)
  expect(result.consumed).toBeDefined(); expect(compacts.length).toBe(0)
  await $.turn.complete({ turnId: 't1', answer: '', reason: 'answer', durationMs: 1, isAborted: false } as never)
  await w.clock.advance(10)
  expect(compacts.length).toBe(1)
  const reconcile = JSON.parse(control('reconcile').slice(CONTROL_PREFIX.length))
  await seedAuthorizedControl(w, reconcile)
  await $.session.receive({ text: CONTROL_PREFIX + JSON.stringify(reconcile), origin: { kind: 'peer' } } as never)
  await w.clock.advance(10)
  expect(prompts.join('')).toContain('progress_session / progress_plan')
  expect(prompts.join('')).not.toContain(CONTROL_PREFIX)
  await ui.unmount()
})

test('V05 plain-message button and legacy command both fill requests instead of sending', async ($, on) => {
  const { ui, fills, sends } = await setup($, on)
  await ui.press({ key: 'control-message-peer' })
  expect(fills[0]).toContain('target_session=peer')
  const answer = await $.command.run({ command: 'progress', args: 'send Peer Session: Please check the tests' } as never)
  expect(sends.length).toBe(0); expect(fills[1]).toContain('Please check the tests')
  expect(answer.text).toContain('Enter')
  await ui.unmount()
})

test('V04 context usage uses warning only at configured threshold and never failure red', async ($, on) => {
  const w = world(on)
  seedSession(w, session({ id: 'peer', title: 'Context peer', context: { tokens: 180000, window: 200000, percent: 90 } } as any))
  on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-sessions' })
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.some(x => x.text.includes('90%') && x.props.color === 'warning')).toBe(true)
  expect(texts.some(x => ['red', 'error'].includes(String(x.props.color)))).toBe(false)
  await ui.unmount()
})
