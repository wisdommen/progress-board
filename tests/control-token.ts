import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { SessionRec } from '../types'
import { CONTROL_PREFIX } from '../hooks/controls'
import type { Control } from '../hooks/controls'
import { session, seedSession } from './v03-fixtures'
import type { World } from './world'

/** 原生工具替身仍然走生产发送守卫，不调用控制工具内部旁路。 */
export function controlTransport($: Engine, on: On, ids: string[]): void {
  on('tool.call', async (_, e) => {
    if (e.tool === 'ListAgents') return { result: { listing: 'This session is local-sender [aa11bb] — the name other sessions use to message it (it is not listed below).', sections: [{ kind: 'sessions', total: ids.length, rows: ids.map(name => ({ name })) }], notes: [] } }
    if (e.tool === 'SendMessage' && typeof e.message === 'string') {
      const result = await $.session.send({ to: e.to, text: e.message, origin: { kind: 'model' } } as never)
      return result.isDelivered ? { result } : { result, isError: true as const }
    }
    return { result: {} }
  })
}
export function captureControlRequests(on: On): string[] {
  const fills: string[] = []
  on('prompt.fill', (_, e) => { fills.push(e.text); return { isFilled: true } })
  return fills
}
export async function submitControlRequest($: Engine, text: string): Promise<string> {
  const id = /intent_id=([A-Za-z0-9_-]+)/.exec(text)?.[1]
  if (!id) throw new Error('测试没有获得面板产生的意图号')
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
  return id
}
export async function pressSessionControl(ui: any, action: string, target: string): Promise<void> {
  await ui.press({ key: 'tab-sessions' })
  if (!await ui.find({ key: `control-${action}-${target}` })) await ui.press({ key: `session-${target}` })
  await ui.press({ key: `control-${action}-${target}` })
  if (action === 'compact' || action === 'abort') await ui.press({ key: `control-${action}-${target}` })
}
export async function sendIssued($: Engine, result: { result?: unknown }): Promise<unknown> {
  const text = String(result.result), start = text.indexOf(CONTROL_PREFIX), end = text.indexOf('\n', start)
  const message = text.slice(start, end < 0 ? undefined : end)
  const quoted = /\bto=("(?:[^"\\]|\\.)*")/.exec(text)?.[1]
  if (!quoted) throw new Error('控制工具没有返回已绑定的原生地址')
  return $.tool.call({ tool: 'SendMessage', to: JSON.parse(quoted), message } as never)
}
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), n => n.toString(16).padStart(2, '0')).join('')
/** 接收侧单元夹具明确带上新协议的本人意图、token和发送端消费证据。 */
export async function authorizedSender(c: Control, overrides: Partial<SessionRec> = {}): Promise<SessionRec> {
  c.token ??= crypto.randomUUID()
  const action = c.action === 'abort' ? 'interrupt' : c.action === 'dispatch' ? 'dispatch_now' : c.action
  if (action === 'result') throw new Error('旧结果信封不再受支持')
  const intentId = `intent-${c.nonce}`, payload = JSON.stringify([c.v, c.to, c.from, c.nonce, c.at, c.action, c.plan ?? null, c.item ?? null, c.interrupt ?? false, c.message ?? null])
  return session({ ...overrides, id: c.from, controlVersion: 1,
    controlIntents: [{ id: intentId, from: c.from, target: c.to, action, at: c.at, expires: c.at + 600000, usedAt: c.at, source: 'panel', payloadHash: await digest(JSON.stringify([action, c.to, c.plan ?? null, c.item ?? null, c.interrupt ?? false, c.message ?? null])) }],
    pendingControls: [{ id: c.nonce, to: c.to, action: c.action as never, at: c.at, usedAt: c.at, intentId, source: 'panel', tokenHash: await digest(c.token), payloadHash: await digest(payload) }],
  })
}
export async function seedAuthorizedControl(w: World, c: Control, overrides: Partial<SessionRec> = {}): Promise<void> {
  seedSession(w, await authorizedSender(c, overrides))
}
