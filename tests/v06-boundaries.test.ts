import { expect, enTest as test } from './locale-test'
import { world } from './world'
import { session, seedSession, savedSession, NOW, PLAN } from './v03-fixtures'
import { CONTROL_PREFIX, controlBody } from '../hooks/controls'
import { MemIo } from './memio'
import { Paths } from '../hooks/store'
import { writeReport } from '../hooks/report'

import { seedAuthorizedControl } from './control-token'
test('V06 controlBody safely ignores non-string optional message values', async () => {
  expect(controlBody(undefined as never)).toBeUndefined(); expect(controlBody(null as never)).toBeUndefined()
})
test('V06 pre-token peer controls are refused even with a matching legacy plugin-origin record', async ($, on) => {
  const w = world(on), prompts: string[] = []
  seedSession(w, session()); seedSession(w, session({ id: 'peer', pendingControls: [{ id: 'legacy-nonce', to: 's1', action: 'reconcile', at: NOW }] }))
  on('prompt.submit', (_: unknown, e: any) => { prompts.push(e.text); return { text: e.text } })
  on('session.receive', (_: unknown, e: any) => ({ text: e.text })); on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'progress', args: '' } as never)
  await $.session.receive({ text: CONTROL_PREFIX + JSON.stringify({ v: 1, from: 'peer', to: 's1', nonce: 'legacy-nonce', at: NOW, action: 'reconcile' }), origin: { kind: 'peer', plugin: 'progress-board' } } as never)
  await w.clock.advance(10)
  expect(prompts).toEqual([]); expect(savedSession(w).seenControls?.length ?? 0).toBe(0)
})
test('V06 a token-authorized relay retains the peer sender identity for the model', async ($, on) => {
  const w = world(on), prompts: string[] = [], text = 'Please inspect the test output'
  const c = { v: 1, from: 'peer', to: 's1', nonce: 'relay-token-nonce', at: NOW, action: 'message', token: 'relay-secret-token', message: text }
  seedSession(w, session()); await seedAuthorizedControl(w, c as never, { title: 'Build peer', goal: 'Build peer' })
  on('prompt.submit', (_: unknown, e: any) => { prompts.push(e.text); return { text: e.text } })
  on('session.receive', (_: unknown, e: any) => ({ text: e.text })); on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'progress', args: '' } as never)
  await $.session.receive({ text: CONTROL_PREFIX + JSON.stringify(c), origin: { kind: 'peer' } } as never)
  await w.clock.advance(10)
  expect(prompts.length).toBe(1); expect(prompts[0]).toContain('Message from session Build peer (relayed by progress-board):')
  expect(prompts[0]).toContain(text)
})
test('V06 non-peer control-shaped deliveries remain ordinary untrusted input', async ($, on) => {
  const w = world(on), received: string[] = [], text = CONTROL_PREFIX + '{}'
  on('session.receive', (_: unknown, e: any) => { received.push(e.text); return { text: e.text } }); on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'progress', args: '' } as never)
  const result = await $.session.receive({ text, origin: { kind: 'bridge' } } as never)
  expect(result.consumed).toBeUndefined(); expect(received).toEqual([text])
})
test('V06 a report for an unknown plan creates no plan directory', async () => {
  const io = new MemIo(), paths = Paths.forHome('/h')
  let error: unknown
  try { await writeReport(io, paths, PLAN, { now: NOW } as never) } catch (caught) { error = caught }
  expect(error).toBeDefined(); expect(io.dirs.has(paths.planDir(PLAN))).toBe(false)
})
