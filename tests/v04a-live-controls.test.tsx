import { expect, enTest as test } from './locale-test'
import type { EngineInterface } from 'claude-code'
import { dispatchNow } from '../hooks/controls'
import { MemIo } from './memio'
import { Paths } from '../hooks/store'
import { plan, PLAN, session, NOW } from './v03-fixtures'

test('live dispatch never passes a raw usage model ID to a plugin-created Agent', async () => {
  const io = new MemIo(), paths = Paths.forHome('/h'), self = session({ model: 'claude-opus-5-5' })
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(plan()))
  const requests: Record<string, unknown>[] = []
  const engine = {
    clock: { now: async () => NOW }, ui: { toast: () => undefined },
    agent: { spawn: async (request: Record<string, unknown>) => { requests.push(request); return { agentId: 'unexpected' } } },
  } as unknown as EngineInterface
  const result = await dispatchNow(engine, { io, paths, self, turnId: () => undefined, save: async () => undefined }, PLAN, 'p1-2', [], false, undefined, { id: 'fixture-intent', from: self.id, target: self.id, action: 'dispatch_now', at: NOW, expires: NOW + 600000, usedAt: NOW, source: 'panel', payloadHash: 'fixture-only' })
  expect(requests.length).toBe(0)
  expect(result).toContain('your own Agent tool')
  expect(self.claims.length).toBe(0); expect(self.bg.length).toBe(0)
})
