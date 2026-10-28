import { expect, enTest as test } from './locale-test'
import type { EngineInterface } from 'claude-code'
import { createI18n } from '../hooks/i18n'
import { MemIo } from './memio'

function fixture(reply: unknown, source = { 'banner.hello': 'Hello {name}', 'panel.good': 'Good' } as Record<string, string>) {
  const logs: string[] = [], calls: { prompt: string }[] = [], io = new MemIo()
  const engine = {
    settings: { read: async () => 'it' }, store: { get: async () => undefined },
    model: { complete: async (request: { prompt: string }) => { calls.push(request); return typeof reply === 'function' ? reply(request) : reply } },
    ui: { log: async (message: string) => { logs.push(message) } },
  } as unknown as EngineInterface
  const controller = createI18n(engine, { io, home: '/h', source })
  return { controller, calls, logs, io }
}

test('live i18n malformed answered chunks log the parse reason and a bounded reply preview', async () => {
  const f = fixture({ isAnswered: true, text: 'Unparseable reply ' + 'x'.repeat(2000) })
  await f.controller.init()
  expect(f.logs.some(line => line.includes('invalid-json') && line.includes('Unparseable reply'))).toBe(true)
  expect(f.logs.every(line => line.length < 800)).toBe(true)
  for (const key of ['banner.hello', 'panel.good']) expect(f.logs.some(line => line.includes(key) && line.includes('invalid-json'))).toBe(true)
})

test('live i18n unanswered chunks retain the provider reason for every rejected key', async () => {
  const f = fixture({ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit' })
  await f.controller.init()
  for (const key of ['banner.hello', 'panel.good']) expect(f.logs.some(line => line.includes(key) && line.includes('api-error') && line.includes('429'))).toBe(true)
})

test('live i18n individual rejections identify missing keys, placeholders, unsafe controls and length', async () => {
  const f = fixture({ isAnswered: true, text: JSON.stringify({ placeholder: 'Ciao {wrong}', unsafe: 'Ciao\n{name}', long: 'x'.repeat(100), good: 'Bene' }) },
    { missing: 'Missing', placeholder: 'Hello {name}', unsafe: 'Hello {name}', long: 'Short', good: 'Good' })
  await f.controller.init()
  for (const [key, reason] of [['missing', 'missing-key'], ['placeholder', 'placeholder-mismatch'], ['unsafe', 'unsafe-control'], ['long', 'excess-length']])
    expect(f.logs.some(line => line.includes(key!) && line.includes(reason!))).toBe(true)
  expect(f.controller.t('good')).toBe('Bene')
})

test('live i18n accepts the observed language/messages envelope without accepting another target language', async () => {
  const source = { 'banner.hello': 'Hello {name}', 'panel.good': 'Good' }
  const f = fixture({ isAnswered: true, text: JSON.stringify({ language: 'it', messages: { 'banner.hello': 'Ciao {name}', 'panel.good': 'Bene' } }) }, source)
  await f.controller.init()
  expect(f.controller.t('banner.hello', { name: 'A' })).toBe('Ciao A')
  expect(f.controller.t('panel.good')).toBe('Bene')
  const g = fixture({ isAnswered: true, text: JSON.stringify({ language: 'de', messages: { 'panel.good': 'Gut' } }) }, source)
  await g.controller.init(); expect(g.controller.t('panel.good')).toBe('Good')
})

test('live i18n model-facing keys are never translated or overridden, including stale machine caches', async () => {
  const f = fixture(({ prompt }: { prompt: string }) => ({ isAnswered: true, text: JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(prompt).messages).map(key => [key, 'Bene']))) }),
    { 'model.instruction': 'Keep instructions in English', 'panel.good': 'Good' })
  await f.io.writeAtomic('/h/.claude/progress-board/locales/it.json', JSON.stringify({ 'model.instruction': 'Istruzione vecchia', _meta: { machineTranslated: true, keys: { 'model.instruction': { sourceHash: 'old', machineOutput: 'Istruzione vecchia' } } } }))
  await f.controller.init()
  expect(f.calls.flatMap(call => Object.keys(JSON.parse(call.prompt).messages))).toEqual(['panel.good'])
  expect(f.controller.t('model.instruction')).toBe('Keep instructions in English')
})

test('live i18n human plan labels remain translatable without sending the model namespace', async () => {
  const f = fixture(({ prompt }: { prompt: string }) => ({ isAnswered: true, text: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(prompt).messages).map(([key, value]) => [key, `IT ${value}`]))) }),
    { 'model.m001': 'Closeout / Release', 'model.m032': 'Mark done only when criteria are met: {p0}' })
  await f.controller.init()
  expect(f.calls.flatMap(call => Object.keys(JSON.parse(call.prompt).messages))).toEqual(['plan.m001'])
  expect(f.controller.t('model.m001')).toBe('IT Closeout / Release')
  expect(f.controller.t('model.m032', { p0: 'proof' })).toBe('Mark done only when criteria are met: proof')
  const manual = fixture({ isAnswered: false, reason: 'aborted' }, { 'model.m001': 'Closeout / Release' })
  await manual.io.writeAtomic('/h/.claude/progress-board/locales/it.json', JSON.stringify({ 'model.m001': 'Chiusura personalizzata' }))
  await manual.controller.init(); expect(manual.controller.t('model.m001')).toBe('Chiusura personalizzata')
})
