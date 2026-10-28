import { expect, enTest as test } from './locale-test'
import type { EngineInterface } from 'claude-code'
import { createI18n } from '../hooks/i18n'
import { MemIo } from './memio'

const path = '/h/.claude/progress-board/locales/it.json'
function fixture(source: Record<string, string> = { hello: 'Hello {name}', good: 'Good' }, io = new MemIo()) {
  let reply = () => JSON.stringify({ hello: 'Ciao {name}', good: 'Bene' })
  const calls: string[] = []
  const engine = {
    settings: { read: async () => 'it' },
    store: { get: async () => undefined },
    model: { complete: async ({ prompt }: { prompt: string }) => { calls.push(prompt); return { isAnswered: true, text: reply() } } },
  } as unknown as EngineInterface
  const controller = createI18n(engine, { io, home: '/h', source })
  return { controller, io, engine, calls, reply: (fn: typeof reply) => { reply = fn }, saved: async () => JSON.parse((await io.read(path))!) }
}

for (const [name, bad] of [
  ['newline', 'Ciao\n{name}'], ['carriage return', 'Ciao\r{name}'], ['tab', 'Ciao\t{name}'],
  ['ANSI CSI', '\u001b[31mCiao {name}'], ['ANSI OSC', '\u001b]0;title\u0007Ciao {name}'],
  ['C1 control', 'Ciao\u009b31m{name}'], ['excess length', 'x'.repeat(74) + '{name}'],
  ['Unicode line separator', 'Ciao {name}'],
]) test(`review i18n rejects machine ${name} per key without losing valid siblings`, async () => {
  const f = fixture(); f.reply(() => JSON.stringify({ hello: bad, good: 'Bene' }))
  await f.controller.init()
  expect(f.controller.t('hello', { name: 'A' })).toBe('Hello A')
  expect(f.controller.t('good')).toBe('Bene')
  expect((await f.saved()).hello).toBe(undefined)
})

test('review i18n permits the exact English length multiplier boundary', async () => {
  const f = fixture({ good: 'Good' }), boundary = 'x'.repeat(3 * 4 + 40)
  f.reply(() => JSON.stringify({ good: boundary })); await f.controller.init()
  expect(f.controller.t('good')).toBe(boundary)
})

test('review i18n display removes whole escape sequences and line controls without changing manual storage', async () => {
  const f = fixture(), manual = '\u001b[31mManual\u001b[0m\n{name}\u001b]0;secret\u0007\u009b32m\u001b]8;;url\u001b\\link\u001b]8;;\u001b\\'
  await f.io.writeAtomic(path, JSON.stringify({ hello: manual }))
  await f.controller.init()
  expect(f.controller.t('hello', { name: 'A' })).toBe('Manual Alink')
  expect((await f.saved()).hello).toBe(manual)
})

test('review i18n accepts fenced JSON directly', async () => {
  const f = fixture(); f.reply(() => '```json\n' + JSON.stringify({ hello: 'Ciao {name}', good: 'Bene' }) + '\n```')
  await f.controller.init(); expect(f.controller.t('good')).toBe('Bene')
})

test('review i18n transient chunk failures record attempts and retry after backoff across controllers', async () => {
  const f = fixture(); f.reply(() => 'not JSON'); await f.controller.init()
  const failed = (await f.saved())._meta.keys.good
  expect(failed.attempts).toBe(1); expect(typeof failed.failedAt).toBe('number')
  await f.controller.refresh(); expect(f.calls.length).toBe(1)
  f.io.clock += 60_000; f.reply(() => JSON.stringify({ hello: 'Ciao {name}', good: 'Bene' }))
  const next = createI18n(f.engine, { io: f.io, home: '/h', source: { hello: 'Hello {name}', good: 'Good' } })
  await next.init(); expect(f.calls.length).toBe(2); expect(next.t('good')).toBe('Bene')
  expect((await f.saved())._meta.keys.good.failedAt).toBe(undefined)
})

test('review i18n transport errors and denials remain retryable but stop after three total attempts', async () => {
  const f = fixture(); f.reply(() => { throw new Error('timeout') }); await f.controller.init()
  f.io.clock += 60_000
  f.engine.model.complete = (async () => { f.calls.push('denied'); return { isAnswered: false } }) as unknown as typeof f.engine.model.complete
  await f.controller.refresh(); expect(f.calls.length).toBe(2)
  await f.controller.refresh(); expect(f.calls.length).toBe(2)
  f.io.clock += 120_000; await f.controller.refresh(); expect(f.calls.length).toBe(3)
  f.io.clock += 1_000_000; await f.controller.refresh(); expect(f.calls.length).toBe(3)
  expect((await f.saved())._meta.keys.good.attempts).toBe(3)
  await f.controller.retranslate(); expect(f.calls.length).toBe(4)
  expect((await f.saved())._meta.keys.good.attempts).toBe(1)
})

test('review i18n incomplete replies retry only missing keys; placeholder failures are permanent', async () => {
  const f = fixture(); f.reply(() => JSON.stringify({ hello: 'Ciao {wrong}' })); await f.controller.init()
  f.io.clock += 60_000; f.reply(() => JSON.stringify({ good: 'Bene' })); await f.controller.refresh()
  expect(f.calls.length).toBe(2)
  expect(Object.keys(JSON.parse(f.calls[1]!).messages)).toEqual(['good'])
  expect(f.controller.t('hello', { name: 'A' })).toBe('Hello A')
  expect(f.controller.t('good')).toBe('Bene')
})

test('review i18n retries preserve manual edits and live translation lock exclusion', async () => {
  const f = fixture(); f.reply(() => 'bad'); await f.controller.init(); f.io.clock += 60_000
  const saved = await f.saved(); saved.hello = 'Manual {name}'
  await f.io.writeAtomic(path, JSON.stringify(saved))
  let release!: () => void
  const blocked = new Promise<void>(r => { release = r })
  f.reply(() => JSON.stringify({ good: 'Bene' }))
  const original = f.engine.model.complete
  f.engine.model.complete = async (...args) => { await blocked; return original(...args) }
  const running = f.controller.refresh()
  try {
    for (let i = 0; i < 150; i++) await Promise.resolve()
    const peer = createI18n(f.engine, { io: f.io, home: '/h', source: { hello: 'Hello {name}', good: 'Good' } })
    await peer.init(); expect(f.calls.length).toBe(1)
    const latest = await f.saved(); latest.good = 'Edited during request'
    await f.io.writeAtomic(path, JSON.stringify(latest))
  } finally { release(); await running }
  expect(f.controller.t('hello', { name: 'A' })).toBe('Manual A')
  expect(f.controller.t('good')).toBe('Edited during request')
})
