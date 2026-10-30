import { expect, enTest as test } from './locale-test'
import type { Snapshot } from '../types'
import { addItems, renderPlanMd } from '../hooks/model'
import { buildBanner, rowText } from '../hooks/banner'
import { installCatalogs, setLocale, placeholders } from '../hooks/i18n'
import { catalogs } from './catalog-fixture'
import { world, seedPlan } from './world'
import { plan, PLAN, planDir, seedSession, session, claim, NOW } from './v03-fixtures'

const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
function snapshot(): Snapshot {
  return { now: NOW, selfId: 's1', repoPlans: [PLAN], focusPlan: PLAN, plans: [plan()], sessions: [{ ...session({ kind: 'orchestrator', dispatched: 3, agentsDone: 2 }), isAlive: true, isSelf: true, cwdMissing: false, attribution: { confident: [], speculative: [] } }], waiting: [], recent: [] }
}

test('WR06 complete catalog messages reorder away window and void reason without source punctuation', async ($, on) => {
  world(on)
  const snap = snapshot()
  snap.plans[0]!.phases[0] = { ...snap.plans[0]!.phases[0]!, isVoid: true, voidReason: 'superseded' }
  snap.away = { from: NOW - 1800000, to: NOW, items: [], steps: [], decisions: [] }
  installCatalogs({ ...catalogs, en: { ...catalogs.en, 'panel.awayWindow': '{duration} :: {to} <- {from}', 'panel.voidPhase': '{reason} :: {name}' } })
  on('state.get', async (_$, e, next) => {
    const actual = await next(e)
    const values = { snapshot: snap, isHeadless: false, tick: 0, ui: { expanded: [], showReview: false, showRelated: false, showEnded: false, pick: null } } as Record<string, unknown>
    return actual.value && e.key in values ? { value: { ...actual.value, value: values[e.key] as never } } : actual
  })
  on('command.run', () => ({ text: '' })); await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(pane)
  const text = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('\n')
  expect(text).toContain('30 min ::')
  expect(text).toContain('superseded ::')
  expect(/[　-〿＀-￯]/u.test(text)).toBe(false)
  await ui.unmount()
})

test('WR06 model descriptions use locale-aware lists and whole phase repository message', () => {
  const p = plan(); const result = addItems(p, 'p1', ['Alpha', 'Beta', 'Gamma'], NOW)
  expect('error' in result).toBe(false)
  if ('error' in result) return
  expect(result.detail).toContain(new Intl.ListFormat('en', { type: 'conjunction' }).format(['Alpha', 'Beta', 'Gamma']))
  expect(/[　-〿＀-￯]/u.test(result.detail)).toBe(false)
  p.phases[0]!.repo = 'repo-a'; p.repos = ['repo-a', 'repo-b']
  const md = renderPlanMd(p)
  expect(md).toContain('(repo-a)')
  expect(md).toContain(new Intl.ListFormat('en', { type: 'conjunction' }).format(p.repos))
  expect(/[　-〿＀-￯]/u.test(md)).toBe(false)
})

test('IN02 dispatch uses code-owned separators independent of translated punctuation', () => {
  const snap = snapshot()
  setLocale('en', { 'banner.m019': ' / sent {p0}; back {p1}', 'banner.dispatchSummary': 'back {returned}; sent {sent}' })
  const narrow = rowText(buildBanner({ snap, cols: 59, glyph: '█', isWorking: false, spinner: '*', now: NOW }).rows[0]!)
  expect(narrow).toContain('back 2; sent 3')
  expect(narrow).not.toContain(' / sent')
  const wide = rowText(buildBanner({ snap, cols: 140, glyph: '█', isWorking: false, spinner: '*', now: NOW }).rows[0]!)
  expect(wide).toContain(' · back 2; sent 3')
})

test('WR08 only complete and done or wrapping transitions enter completion filter', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()] }))
  const entries = [
    ['set_item', 'Revert: done → todo'], ['set_item', 'Refs merged'], ['set_item', 'Milestone 1 → 2'],
    ['set_item', 'Item: todo → done'], ['set_item', 'Item: todo → wrapping'], ['complete', 'Plan complete'],
  ]
  w.files.set(`${planDir}/log.jsonl`, { text: entries.map(([action, detail], n) => JSON.stringify({ at: NOW - n - 1, by: 's1', plan: PLAN, action, detail })).join('\n'), m: NOW })
  on('command.run', () => ({ text: '' })); await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-activity' }); await ui.press({ key: 'activity-filter-completion' })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(x => x.text).join('\n')
  const completions = await texts()
  expect(completions).toContain('todo → done'); expect(completions).toContain('todo → wrapping'); expect(completions).toContain('Plan complete')
  expect(completions).not.toContain('Revert:'); expect(completions).not.toContain('Refs merged'); expect(completions).not.toContain('Milestone 1')
  await ui.press({ key: 'activity-filter-event' })
  const events = await texts()
  expect(events).toContain('Revert:'); expect(events).toContain('Refs merged'); expect(events).toContain('Milestone 1')
  await ui.unmount()
})

test('WR06 ten catalogs keep keys and placeholder contracts aligned', () => {
  const en = catalogs.en!
  expect(Object.keys(catalogs).length).toBe(10)
  for (const catalog of Object.values(catalogs)) {
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) expect(placeholders(catalog[key]!)).toEqual(placeholders(en[key]!))
  }
})
