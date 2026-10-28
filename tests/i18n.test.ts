import { expect, enTest as test } from './locale-test'
import type { EngineInterface } from 'claude-code'
import { bundled, createI18n, dateTime, formatMessage, language, languageInstruction, mapLanguage, number, placeholders, relative, setLocale, t } from '../hooks/i18n'
import { MemIo } from './memio'
import { buildBanner, rowText } from '../hooks/banner'
import { changePhases, newPlan } from '../hooks/model'
import { NOW, plan as progressPlan, session as progressSession } from './v03-fixtures'
import type { Snapshot } from '../types'

const source = { hello: 'Hello {name}', count: '{n, plural, one {# item} other {# items}}', empty: 'Empty' }
function fixture(setting?: string, data = new Map<string, unknown>(), io = new MemIo()) {
  const calls: { model: string; prompt: string }[] = []
  let reply = (prompt: string) => {
    const input = JSON.parse(prompt) as { messages: Record<string, string> }
    return JSON.stringify(Object.fromEntries(Object.entries(input.messages).map(([k, v]) => [k, `Translated ${v}`])))
  }
  const engine = {
    settings: { read: async () => setting },
    store: { get: async (k: string) => data.get(k), set: async (k: string, v: unknown) => { data.set(k, v) } },
    model: { complete: async (r: { model: string; prompt: string }) => { calls.push(r); return { isAnswered: true, text: reply(r.prompt) } } },
  } as unknown as EngineInterface
  let changes = 0
  const instance = createI18n(engine, { io, home: '/h', source, chunkSize: 2, onChange: () => { changes++ } })
  return { instance, calls, io, data, engine, reply: (r: typeof reply) => { reply = r }, changes: () => changes }
}

test('i18n English is the default, with stable missing-key and English fallback', () => {
  setLocale('en'); expect(language()).toBe('en'); expect(t('panel.progress')).toBe('Progress')
  setLocale('ja', { 'panel.progress': '' }); expect(t('panel.progress')).toBe('')
  expect(t('not.a.key')).toBe('not.a.key'); setLocale('en')
})
test('i18n ICU-lite interpolates, selects exact/cardinal plurals and formats numbers', () => {
  expect(formatMessage('{name}: {n, plural, =0 {none} one {# item} other {# items}}', { name: 'A', n: 0 })).toBe('A: none')
  expect(formatMessage('{n, plural, one {{who}: # item} other {{who}: # items}}', { who: 'A', n: 2 })).toBe('A: 2 items')
  expect(formatMessage('{n, plural, one {one} few {few} many {many} other {other}}', { n: 2 }, 'ru')).toBe('few')
  expect(formatMessage('{x}', {})).toBe('{x}')
})
test('i18n placeholder signatures include nested plural variables', () => {
  expect(placeholders('{n, plural, one {{name}} other {{name} #}}')).toEqual(['n:plural', 'name:value'])
})
test('i18n bundled catalogs have exactly all keys, valid placeholders and faithful translated headings', () => {
  expect(Object.keys(bundled).sort()).toEqual(['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR', 'ru'].sort())
  const keys = Object.keys(bundled.en!).sort()
  for (const catalog of Object.values(bundled)) {
    expect(Object.keys(catalog).sort()).toEqual(keys)
    for (const key of keys) expect(placeholders(catalog[key]!)).toEqual(placeholders(bundled.en![key]!))
  }
  expect(bundled['zh-CN']!['panel.progress']).toBe('进度')
  expect(bundled.ja!['panel.progress']).toBe('進捗')
  expect(bundled.fr!['panel.progress']).toBe('Progression')
})
test('i18n maps common names, endonyms and BCP-47 codes, rejecting unsafe paths', () => {
  for (const [input, code] of [['简体中文', 'zh-CN'], ['繁體中文', 'zh-TW'], ['日本語', 'ja'], ['Português do Brasil', 'pt-BR'], ['English', 'en'], ['ZH-hant', 'zh-TW'], ['fr_CA', 'fr-CA'], ['العربية', 'ar'], ['Deutsch', 'de']]) expect(mapLanguage(input!)).toBe(code)
  expect(mapLanguage('../../evil')).toBe(undefined)
})
test('i18n Intl number/date/relative formatting follows locale', () => {
  setLocale('de'); expect(number(1234.5)).toBe('1.234,5')
  setLocale('en'); expect(dateTime(0, { timeZone: 'UTC', year: 'numeric' })).toBe('1970')
  expect(relative(-2, 'minute')).toBe('2 minutes ago')
})
test('i18n language directive uses the resolved human language, never translated instructions', () => {
  setLocale('ja'); expect(languageInstruction()).toContain('Japanese')
  expect(languageInstruction()).toContain('goals, steps, item titles, decisions and questions'); setLocale('en')
})
test('i18n store selection wins over free-text setting; null follows setting', async () => {
  const f = fixture('日本語'); f.data.set('language', 'de')
  await f.instance.init(); expect(f.instance.language()).toBe('de')
  await f.instance.setLanguage(null); expect(f.instance.language()).toBe('ja'); expect(f.calls.length).toBe(0)
})
test('i18n unknown language is mapped by haiku once and cached persistently', async () => {
  const f = fixture('a language name not in the table'); f.reply(() => '"it"')
  await f.instance.init(); expect(f.instance.language()).toBe('it'); expect(f.calls[0]?.model).toBe('haiku')
  const g = fixture('a language name not in the table', f.data, f.io); g.reply(() => { throw new Error('must use mapping cache') })
  await g.instance.init(); expect(g.instance.language()).toBe('it'); expect(g.calls.length).toBe(0)
  const owner = fixture('another unknown language'); let release!: () => void
  const blocked = new Promise<void>(r => { release = r }); const original = owner.engine.model.complete
  owner.engine.model.complete = async (...args) => { await blocked; return original(...args) }
  const running = owner.instance.init()
  for (let n = 0; n < 150; n++) await Promise.resolve()
  const peer = fixture('another unknown language', owner.data, owner.io)
  try { await peer.instance.init(); expect(peer.calls.length).toBe(0) } finally { release(); await running }
})
test('i18n unknown languages translate in chunks; invalid placeholders fall back per key', async () => {
  const f = fixture('it'); f.reply(prompt => {
    const { messages } = JSON.parse(prompt)
    return JSON.stringify(Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, k === 'hello' ? 'Ciao {wrong}' : `IT ${v}`])))
  })
  await f.instance.init(); expect(f.calls.length).toBe(2); expect(f.calls.every(r => r.model === 'haiku')).toBe(true)
  expect(f.instance.t('hello', { name: 'A' })).toBe('Hello A'); expect(f.instance.t('empty')).toBe('IT Empty')
  expect(f.changes() > 0).toBe(true)
})
test('i18n cached per-key hashes retranslate only changed/new source keys and retain manual edits', async () => {
  const f = fixture('it'); await f.instance.init()
  const path = '/h/.claude/progress-board/locales/it.json'
  const saved = JSON.parse((await f.io.read(path))!); saved.hello = 'Manual {name}'
  await f.io.writeAtomic(path, JSON.stringify(saved)); f.calls.length = 0
  const g = createI18n(f.engine, { io: f.io, home: '/h', source: { ...source, hello: 'Hi {name}', empty: 'Nothing', added: 'New' } })
  await g.init(); expect(g.t('hello', { name: 'A' })).toBe('Manual A')
  const keys = f.calls.flatMap(c => Object.keys(JSON.parse(c.prompt).messages)).sort()
  expect(keys).toEqual(['added', 'empty']); expect(JSON.parse((await f.io.read(path))!)._meta.machineTranslated).toBe(true)
})
test('i18n user overrides win per key over bundled catalogs and refresh live', async () => {
  const f = fixture('ja'); const path = '/h/.claude/progress-board/locales/ja.json'
  await f.io.writeAtomic(path, JSON.stringify({ hello: 'Custom {name}', empty: 'Custom' }))
  await f.instance.init(); expect(f.instance.t('hello', { name: 'A' })).toBe('Custom A')
  await f.io.writeAtomic(path, JSON.stringify({ empty: 'Live' })); await f.instance.refresh()
  expect(f.instance.t('empty')).toBe('Live'); expect(f.instance.t('hello', { name: 'A' })).toBe('Hello A')
})
test('i18n translation lock makes peers use English until owner lands, then refresh', async () => {
  const f = fixture('it'); let release!: () => void
  const blocked = new Promise<void>(r => { release = r })
  const first = f.engine.model.complete
  f.engine.model.complete = async (...args) => { await blocked; return first(...args) }
  const owner = f.instance.init()
  for (let n = 0; n < 100; n++) await Promise.resolve()
  const peer = fixture('it', f.data, f.io); await peer.instance.init()
  expect(peer.calls.length).toBe(0); expect(peer.instance.t('empty')).toBe('Empty')
  release(); await owner; await peer.instance.refresh(); expect(peer.instance.t('empty')).toBe('Translated Empty')
})
test('i18n retranslate preserves manual keys, store refresh propagates, and bad model JSON is safe', async () => {
  const f = fixture('it'); await f.instance.init()
  const path = '/h/.claude/progress-board/locales/it.json'; const saved = JSON.parse((await f.io.read(path))!); saved.empty = 'Manual'
  await f.io.writeAtomic(path, JSON.stringify(saved)); f.calls.length = 0
  await f.instance.retranslate(); expect(f.instance.t('empty')).toBe('Manual'); expect(f.calls.length > 0).toBe(true)
  f.data.set('language', 'fr'); await f.instance.refresh(); expect(f.instance.language()).toBe('fr')
  f.reply(() => 'not json'); await f.instance.setLanguage('nl'); expect(f.instance.t('empty')).toBe('Empty')
})
test('i18n malformed translated messages fall back instead of leaking unmatched braces', async () => {
  const f = fixture('it'); f.reply(() => JSON.stringify({ hello: 'Ciao {name}}', empty: 'Vuoto' }))
  await f.instance.init(); expect(f.instance.t('hello', { name: 'A' })).toBe('Hello A')
})
test('i18n nonblocking translation never writes a stale language into a newly selected locale', async () => {
  const f = fixture('it'); let release!: () => void
  const blocked = new Promise<void>(r => { release = r }); const original = f.engine.model.complete
  f.engine.model.complete = async (...args) => { await blocked; return original(...args) }
  const c = createI18n(f.engine, { io: f.io, home: '/h', source, backgroundTranslation: true } as never)
  let initialized = false; const start = c.init().then(() => { initialized = true })
  try {
    for (let n = 0; n < 200; n++) await Promise.resolve()
    expect(initialized).toBe(true)
    await c.setLanguage('ja'); expect(c.language()).toBe('ja')
  } finally { release(); await start }
  await (c as unknown as { whenIdle: () => Promise<void> }).whenIdle()
  expect(c.language()).toBe('ja'); expect(await f.io.read('/h/.claude/progress-board/locales/ja.json')).toBe(null)
  expect(await f.io.read('/h/.claude/progress-board/locales/it.json')).not.toBe(null)
})
test('i18n manual edits made while a model request is pending survive the response', async () => {
  const f = fixture('it'); let changed = false
  const original = f.engine.model.complete
  f.engine.model.complete = async (...args) => {
    if (!changed) { changed = true; await f.io.writeAtomic('/h/.claude/progress-board/locales/it.json', JSON.stringify({ hello: 'Manual {name}' })) }
    return original(...args)
  }
  await f.instance.init(); expect(f.instance.t('hello', { name: 'A' })).toBe('Manual A')
})
test('i18n Intl absence has deterministic numeric, date and relative fallbacks', () => {
  const original = globalThis.Intl
  try {
    ;(globalThis as unknown as { Intl: unknown }).Intl = undefined
    setLocale('en'); expect(number(1234.5)).toBe('1234.5')
    expect(dateTime(0, { year: 'numeric', timeZone: 'UTC' })).toBe('1970')
    expect(relative(-2, 'minute')).toBe('2 min ago')
  } finally { (globalThis as unknown as { Intl: unknown }).Intl = original }
})
test('i18n rendered progress fractions use Intl rather than raw numeric interpolation', () => {
  setLocale('de')
  const plan = progressPlan(); plan.phases = [{ ...plan.phases[0]!, items: Array.from({ length: 1001 }, (_, i) => ({ id: `i${i}`, title: 'work', status: i < 1000 ? 'done' as const : 'todo' as const, updatedAt: NOW })) }]
  const session = { ...progressSession(), isSelf: true, isAlive: true, cwdMissing: false, attribution: { confident: [{ plan: plan.id, source: 'claim' as const }], speculative: [] } }
  const snap: Snapshot = { now: NOW, selfId: session.id, focusPlan: plan.id, repoPlans: [], plans: [plan], sessions: [session], waiting: [], recent: [] }
  const banner = buildBanner({ snap, cols: 200, glyph: '■', isWorking: false, spinner: 'x', now: NOW })
  expect(banner.rows.map(rowText).join('\n')).toContain('1.000/1.001')
})
test('i18n release phase identity survives switching languages without duplicates or insertion reordering', () => {
  for (const locale of ['ja', 'it']) {
    setLocale(locale, locale === 'it' ? { 'model.m001': 'Chiusura / Rilascio' } : {})
    const args = { id: 'example/v1', goal: 'g', criteria: 'c', phases: [{ name: 'work' }], by: 's', now: NOW }
    const original = newPlan(args), release = original.phases.at(-1)!.name
    setLocale('de')
    expect(newPlan({ ...args, phases: original.phases.map(ph => ({ name: ph.name, isRelease: ph.isRelease })) }).phases.length).toBe(2)
    const changed = changePhases(original, { op: 'insert', name: 'extra' }, 'needed', NOW)
    expect('error' in changed).toBe(false)
    if ('plan' in changed) expect(changed.plan.phases.at(-1)!.name).toBe(release)
  }
})
