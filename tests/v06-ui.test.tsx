import { expect, enTest as test } from './locale-test'
import { renderPanel } from '../hooks/panel'
import { renderPriorities } from '../hooks/priorities'
import { renderSessions } from '../hooks/sessions'
import { renderSettings, defaults, choices } from '../hooks/settings'
import { renderActivity } from '../hooks/activity'
import { tokenFeatures } from '../hooks/ui-costs'
import { setLocale, t } from '../hooks/i18n'
import { world, seedPlan } from './world'
import { plan, session, NOW, PLAN, seedSession, claim } from './v03-fixtures'
import type { PanelUi, Snapshot } from '../types'

// Capture actual JSX parent/child structure, rather than flattening rendered text.
const els = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: any) => ({ type, props })])) as any
const children = (n: any): any[] => !n || typeof n !== 'object' ? [] : [n.props?.children].flat(Infinity).filter(Boolean)
const nodes = (n: any): any[] => [n, ...children(n).flatMap(nodes)].filter(x => x && typeof x === 'object')
const find = (n: any, key: string) => nodes(n).find(x => x.props?.key === key)
const text = (n: any): string => typeof n === 'string' || typeof n === 'number' ? String(n) : children(n).map(text).join('')
const ui = (): PanelUi => ({ expanded: [], showReview: false, selectedReview: null, showRelated: false, showEnded: false, pick: null })
const snap = (): Snapshot => ({ now: NOW, selfId: 's1', focusPlan: PLAN, repoPlans: [PLAN], plans: [plan()], sessions: [{ ...session(), isAlive: true, isSelf: true, attribution: { confident: [], speculative: [] } } as any], recent: [], waiting: [] })
const noop = () => {}
const panelActions: any = { accept: noop, reject: noop, edit: noop, toggleReview: noop, selectReview: noop, undo: noop, refresh: noop, pickNext: noop, togglePhase: noop, toggleExpand: noop, toggleRelated: noop, toggleEnded: noop, dismissAway: noop }

test('V06 UI tabs use plain orange bold labels, width underline and a dim rule; progress has no dispatch', () => {
 const s = snap(); let calls = 0
 const tree = renderPanel(els, s, ui(), 90, '■', { ...panelActions, priorities: { dispatch: () => { calls++; return null }, change: noop, picker: noop, unclaimed: noop } })
 const tab = find(tree, 'tab-progress')
 expect(tab.props.plain).toBe(true)
 expect(nodes(tab).some(n => n.props.color === 'claude' && n.props.weight === 'bold')).toBe(true)
 expect(nodes(tree).some(n => text(n) === '   ━━━━━━━━' && n.props.color === 'claude')).toBe(true)
 expect(nodes(tree).some(n => /^─+$/.test(text(n)) && n.props.dimColor)).toBe(true)
 expect(calls).toBe(0)
})

test('V06 UI priorities place dispatch up down and selectable title in one row, suppress done and completed owners', () => {
 const s = snap(), p = s.plans[0]!; p.phases[0]!.items[2]!.status = 'done'
 s.sessions[0]!.claims = [{ plan: PLAN, item: 'p1-1', source: 'claim', at: NOW }]
 s.sessions[0]!.goal = 'Completed owner'; s.sessions[0]!.working = false; s.sessions[0]!.steps = [{ title: 'finished', status: 'done' }]
 const tree = renderPriorities(els, p, s.sessions, { ...ui(), expandedRow: 'priority:item-p1-1' }, { change: noop, picker: noop, unclaimed: noop, dispatch: item => els.Button({ key: `dispatch-${item}`, children: '▶$' }) })
 const row = find(tree, 'priority-row-item-p1-1')
 expect(row.props.flexDirection).toBe('row')
 expect(children(row).map(n => n.props?.key).slice(0, 3)).toEqual(['priority-dispatch-slot-item-p1-1', 'priority-up-item-p1-1', 'priority-down-item-p1-1'])
 expect(find(children(row)[0], 'dispatch-p1-1')).toBeDefined()
 expect(children(row)[0].props.width).toBe(5)
 expect(find(tree, 'priority-level-item-p1-3')).toBeUndefined()
 expect(text(row)).not.toContain('Completed owner')
 const menus = nodes(tree).filter(n => n.props?.borderStyle === 'round')
 expect(menus.length).toBe(1)
 expect(nodes(menus[0]).filter(n => n.type === 'Button').every(n => n.props.plain)).toBe(true)
})

test('V06 UI session second level is single row plain actions inside one round box with cost markers', () => {
 const s = snap(); s.sessions.push({ ...s.sessions[0]!, id: 's2', isSelf: false })
 const tree = renderSessions(els, s, { ...ui(), expandedRow: 'session:s2' }, { control: noop })
 const menus = nodes(tree).filter(n => n.props.borderStyle === 'round')
 expect(menus.length).toBe(1)
 const buttons = nodes(menus[0]).filter(n => n.type === 'Button')
 expect(buttons.length).toBe(4)
 expect(buttons.every(n => n.props.plain)).toBe(true)
 for (const action of ['reconcile', 'compact', 'message']) expect(nodes(find(tree, `control-${action}-s2`)).some(n => text(n) === '$' && n.props.color === 'warning')).toBe(true)
 expect(nodes(find(tree, 'control-abort-s2')).some(n => text(n) === '$')).toBe(false)
})

test('V06 UI settings enumerate exact candidates, select-only help and warning token markers', () => {
 const actions: any = { setting: noop, planSetting: noop, language: noop, otherLanguage: noop, retranslate: noop }
 const tree = renderSettings(els, defaults, plan(), {}, actions, { ...ui(), selectedSetting: 'monitor' })
 for (const [key, values] of Object.entries(choices)) for (let n = 0; n < values.length; n++) expect(find(tree, `setting-${key}-${n}`)).toBeDefined()
 expect(find(tree, 'setting-help-monitor')?.props.dimColor).toBe(true)
 expect(find(tree, 'setting-help-barGlyph')).toBeUndefined()
 expect(nodes(find(tree, 'setting-monitor-0')).some(n => n.props.color === 'claude' && n.props.weight === 'bold' && text(n).startsWith('['))).toBe(true)
 expect(nodes(find(tree, 'setting-row-monitor')).some(n => text(n) === '$' && n.props.color === 'warning')).toBe(true)
 expect(find(tree, 'cost-overview')).toBeDefined()
})

test('V06 UI activity uses structured semantic colors and bold verbs, never red', () => {
 const s = snap(); s.activity = [
 { id: 'a', at: NOW, by: 'worker', kind: 'event', text: 'Started', semantic: 'started', verb: 'Started' },
 { id: 'b', at: NOW, by: 'worker', kind: 'decision', text: 'Changed', semantic: 'change', verb: 'Changed' },
 { id: 'c', at: NOW, by: 'worker', kind: 'event', text: 'Waiting', semantic: 'waiting', verb: 'Waiting' },
 { id: 'd', at: NOW, by: 'worker', kind: 'completion', text: 'Done', semantic: 'success', verb: 'Done' }]
 const tree = renderActivity(els, s, ui(), { filter: noop, more: noop })
 for (const [id, color] of [['a', 'claude'], ['b', 'suggestion'], ['c', 'warning'], ['d', 'success']]) {
  const row = find(tree, `activity-row-${id}`)
  expect(nodes(row).some(n => n.props.color === color && n.props.weight === 'bold')).toBe(true)
 }
 expect(nodes(tree).some(n => n.props.color === 'error' || n.props.color === 'red')).toBe(false)
})


test('V06 UI each setting reveals only its own help without cycling the value; clicking a candidate sends its exact value', () => {
 const selected: string[] = [], chosen: unknown[][] = []
 const actions: any = { setting: () => { throw new Error('must not cycle') }, planSetting: () => { throw new Error('must not cycle') }, language: noop, otherLanguage: noop, retranslate: noop, select: (id: string) => selected.push(id), chooseSetting: (...args: unknown[]) => chosen.push(args), choosePlanSetting: (...args: unknown[]) => chosen.push(args) }
 for (const key of Object.keys(choices)) {
  const tree = renderSettings(els, defaults, plan(), {}, actions, { ...ui(), selectedSetting: key })
  expect(nodes(tree).filter(n => String(n.props.key ?? '').startsWith('setting-help-')).length).toBe(1)
  expect(find(tree, `setting-help-${key}`)?.props.dimColor).toBe(true)
  find(tree, `setting-${key}`).props.onPress()
  expect(selected.at(-1)).toBe(key)
 }
 const tree = renderSettings(els, defaults, plan(), {}, actions)
 find(tree, 'setting-retention-2').props.onPress()
 expect(chosen.at(-1)).toEqual(['retention', 72])
 find(tree, 'plan-setting-monitor-2').props.onPress()
 expect(chosen.at(-1)).toEqual(['monitor', false])
 expect(nodes(tree).filter(n => String(n.props.key ?? '').startsWith('setting-help-')).length).toBe(0)
 const custom = renderSettings(els, { ...defaults, monitorMinutes: 6 }, plan(), {}, actions, { ...ui(), selectedSetting: 'monitorMinutes' })
 expect(text(find(custom, 'setting-monitorMinutes-4'))).toBe('[6 min]')
 expect(text(find(custom, 'setting-help-monitorMinutes'))).toContain('6 min')
})

test('V06 UI all code-owned token features are listed, translation controls carry warning markers, reports stay outside paid features', () => {
 setLocale('it')
 const actions: any = { setting: noop, planSetting: noop, language: noop, otherLanguage: noop, retranslate: noop }
 const tree = renderSettings(els, defaults, plan(), {}, actions)
 for (const feature of tokenFeatures) {
  const row = find(tree, `cost-feature-${feature}`)
  expect(row).toBeDefined()
  expect(nodes(row).some(n => text(n) === '$' && n.props.color === 'warning')).toBe(true)
 }
 for (const key of ['setting-language', 'language-other', 'language-retranslate']) expect(nodes(find(tree, key)).some(n => text(n) === '$' && n.props.color === 'warning')).toBe(true)
 expect((tokenFeatures as readonly string[]).includes('report')).toBe(false)
})

const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
test('V06 UI keyboard focus reveals setting help without changing its value', async ($, on) => {
 const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()] }))
 on('command.run', () => ({ text: '' })); on('ui.focus', () => ({}))
 await $.command.run({ command: 'progress', args: '' } as never)
 const mounted = await $.ui.mount({ ...pane, props: { ...pane.props, isFocused: true } })
 await mounted.press({ key: 'tab-settings' })
 const result = await $.ui.focus({ component: 'Pane', requestId: 'progress-board', plugin: 'progress-board', element: 'setting-monitor', origin: { kind: 'person' } })
 expect(result.deny).toBeUndefined()
 await w.clock.settle()
 const help = (await mounted.findAll({ type: 'Text' })).find(n => n.text.includes(t('settings.help.monitor')))
 expect(help?.props.dimColor).toBe(true)
 expect(w.store.get('settings.monitor')).toBeUndefined()
 await mounted.unmount()
})
test('V06 UI actual panel keeps only one selected row expanded across Sessions and Priorities and toggles closed', async ($, on) => {
 const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()] }))
 seedSession(w, session({ id: 'peer', title: 'Peer', goal: 'Peer', controlVersion: 1 }))
 seedSession(w, session({ id: 'other', title: 'Other', goal: 'Other', controlVersion: 1 }))
 on('command.run', () => ({ text: '' })); await $.command.run({ command: 'progress', args: '' } as never)
 const mounted = await $.ui.mount(pane)
 const required = async (key: string) => expect({ key, present: !!await mounted.find({ key }) }).toEqual({ key, present: true })
 const helpVisible = async (key: string) => (await mounted.findAll({ type: 'Text' })).some(n => n.text.includes(t(`settings.help.${key}`)) && n.props.dimColor === true)
 await mounted.press({ key: 'tab-sessions' })
 expect(await mounted.find({ key: 'control-reconcile-peer' })).toBeUndefined()
 await mounted.press({ key: 'session-peer' })
 await required('control-reconcile-peer')
 await mounted.press({ key: 'session-other' })
 expect(await mounted.find({ key: 'control-reconcile-peer' })).toBeUndefined()
 await required('control-reconcile-other')
 expect((await mounted.findAll({ type: 'Box' })).filter(n => n.props.borderStyle === 'round').length).toBe(1)
 await mounted.press({ key: 'session-other' })
 expect(await mounted.find({ key: 'control-reconcile-other' })).toBeUndefined()
 await mounted.press({ key: 'tab-priorities' }); await mounted.press({ key: 'priority-level-item-p1-1' })
 await required('priority-choose-item-p1-1-high')
 await mounted.press({ key: 'priority-level-item-p1-2' })
 expect(await mounted.find({ key: 'priority-choose-item-p1-1-high' })).toBeUndefined()
 await required('priority-choose-item-p1-2-high')
 expect((await mounted.findAll({ type: 'Box' })).filter(n => n.props.borderStyle === 'round').length).toBe(1)
 await mounted.press({ key: 'tab-sessions' }); await mounted.press({ key: 'session-peer' })
 await mounted.press({ key: 'tab-priorities' })
 expect(await mounted.find({ key: 'priority-choose-item-p1-2-high' })).toBeUndefined()
 await mounted.press({ key: 'tab-settings' })
 expect(await helpVisible('monitor')).toBe(false)
 await mounted.press({ key: 'setting-monitor' })
 await w.clock.settle()
 expect(await helpVisible('monitor')).toBe(true)
 expect(w.store.get('settings.monitor')).toBeUndefined()
 await mounted.press({ key: 'setting-retention' })
 await w.clock.settle()
 expect(await helpVisible('monitor')).toBe(false)
 expect(await helpVisible('retention')).toBe(true)
 await mounted.unmount()
})
