import { expect, enTest as test } from './locale-test'
import { renderPanel } from '../hooks/panel'
import { renderPriorities } from '../hooks/priorities'
import { renderSessions } from '../hooks/sessions'
import { renderSettings, defaults } from '../hooks/settings'
import { activityOf, renderActivity } from '../hooks/activity'
import { collectControlResults, completeControlSend, envelope, flushCompact, receiveControl } from '../hooks/controls'
import { authorizedSender } from './control-token'
import { MemIo } from './memio'
import { Paths } from '../hooks/store'
import { plan, session, NOW, PLAN, claim } from './v03-fixtures'
import { setLocale, t } from '../hooks/i18n'
import type { PanelUi, Snapshot } from '../types'
import type { Control } from '../hooks/controls'

const els = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: any) => ({ type, props })])) as any
const kids = (n: any): any[] => [n?.props?.children].flat(Infinity).filter(Boolean)
const nodes = (n: any): any[] => [n, ...kids(n).flatMap(nodes)].filter(n => n && typeof n === 'object')
const text = (n: any): string => typeof n === 'string' || typeof n === 'number' ? String(n) : kids(n).map(text).join('')
const find = (n: any, key: string) => nodes(n).find(n => n.props.key === key)
const noop = () => {}
const ui = (): PanelUi => ({ expanded: [], showReview: false, selectedReview: null, showRelated: false, showEnded: false, pick: null })
const snap = (): Snapshot => ({ now: NOW, selfId: 's1', focusPlan: PLAN, repoPlans: [PLAN], plans: [plan()], sessions: [{ ...session({ claims: [claim()] }), isAlive: true, isSelf: true, attribution: { confident: [], speculative: [] } } as any], recent: [], waiting: [] })
const panelActions: any = { accept: noop, reject: noop, edit: noop, toggleReview: noop, selectReview: noop, undo: noop, refresh: noop, pickNext: noop, togglePhase: noop, toggleExpand: noop, toggleRelated: noop, toggleEnded: noop, dismissAway: noop }
const priorityActions = { change: noop, picker: noop, unclaimed: noop, dispatch: (item: string) => els.Button({ key: `dispatch-${item}`, plain: true, children: '▶$' }) }

test('V06c progress uses the active glyph for both phase and claimed item, never dispatch', () => {
  const s = snap(); s.plans[0]!.phases[0]!.items[1]!.status = 'wrapping'
  const tree = renderPanel(els, s, ui(), 90, '■', panelActions)
  expect(text(find(tree, 'phase-p1'))).toContain('◐')
  expect(text(tree)).toContain('│   ◐')
  expect(text(tree)).not.toContain('▶')
})

test('V06c priorities omit empty groups, repeated rank words and unowned trailing dots', () => {
  setLocale('zh-CN')
  const s = snap(); s.sessions = []
  const tree = renderPriorities(els, s.plans[0]!, s.sessions, ui(), priorityActions)
  expect(nodes(tree).filter(n => String(n.props.key).startsWith('priority-group-')).map(n => n.props.key)).toEqual(['priority-group-normal'])
  const row = find(tree, 'priority-row-item-p1-1')
  expect(text(row)).not.toContain(t('priority.normal'))
  expect(text(row)).not.toContain('·')
  expect(text(row).trim().endsWith('实现登录验证')).toBe(true)
})

test('V06c phase and item priority rows reserve identical action columns', () => {
  const s = snap(), tree = renderPriorities(els, s.plans[0]!, s.sessions, ui(), priorityActions)
  const phase = kids(find(tree, 'priority-row-phase-p1')), item = kids(find(tree, 'priority-row-item-p1-1'))
  expect(text(phase[0])).toBe('  ')
  expect(phase[0].props.width).toBe(5)
  expect(item[0].props.width).toBe(phase[0].props.width)
  expect(item[0].props.flexShrink).toBe(0)
  expect(phase[1].props.label).toBe('↑'); expect(item[1].props.label).toBe('↑')
  expect(phase[2].props.label).toBe('↓'); expect(item[2].props.label).toBe('↓')
  expect(String(phase[3].props.key)).toBe('priority-level-phase-p1')
  expect(String(item[3].props.key)).toBe('priority-level-item-p1-1')
})

test('V06c sessions suppress only the default regular kind, preserving state and orchestrator label', () => {
  const s = snap(); s.sessions.push({ ...s.sessions[0]!, id: 'leader', kind: 'orchestrator', isSelf: false })
  const tree = renderSessions(els, s, ui(), { control: noop })
  expect(text(find(tree, 'session-row-s1'))).not.toContain(t('session.normal'))
  expect(text(find(tree, 'session-row-s1'))).not.toContain('·')
  expect(text(find(tree, 'session-row-leader'))).toContain(t('session.orchestrator'))
})

test('V06c settings language and candidate wraps have zero vertical gap and remain plain buttons', () => {
  const tree = renderSettings(els, defaults, null, {}, { setting: noop, planSetting: noop, language: noop, otherLanguage: noop, retranslate: noop }, ui())
  const row = find(tree, 'setting-row-language')
  expect(row.props.flexWrap).toBe('wrap'); expect(row.props.rowGap).toBe(0)
  expect(kids(row).filter(n => n.type === 'Button').every(n => n.props.plain)).toBe(true)
  for (const n of nodes(tree).filter(n => n.props.flexWrap === 'wrap')) expect(n.props.rowGap).toBe(0)
})

for (const tab of ['progress', 'activity'] as const) test(`V06c ${tab} filters are plain orange bold active labels and dim inactive labels`, () => {
  const s = snap(), selected: string[] = []
  const tree = tab === 'progress' ? renderPanel(els, s, ui(), 90, '■', { ...panelActions, filterItems: (value: string) => selected.push(value) }) : renderActivity(els, s, ui(), { filter: value => selected.push(value), more: noop })
  for (const [index, name] of (tab === 'progress' ? ['all', 'doing', 'wrapping', 'todo', 'done'] : ['all', 'completion', 'event', 'decision']).entries()) {
    const button = find(tree, `${tab === 'progress' ? '' : 'activity-'}filter-${name}`)
    expect(button.props.plain).toBe(true); expect(button.props.variant).toBeUndefined()
    expect(text(button)).not.toContain('[')
    const label = kids(button)[0]
    expect(label.props.color).toBe(index === 0 ? 'claude' : undefined)
    expect(label.props.weight).toBe(index === 0 ? 'bold' : 'regular')
    expect(label.props.dimColor).toBe(index !== 0)
    button.props.onPress(); expect(selected.at(-1)).toBe(name)
  }
})

for (const action of ['message', 'reconcile', 'compact', 'abort', 'dispatch'] as const) test(`V06c ${action} activity records sender and receiver facts once, not intermediate or repeated receipts`, async () => {
  const io = new MemIo(), paths = Paths.forHome('/h'), callbacks: (() => void)[] = []
  const c: Control = { v: 1, from: 'sender', to: 'receiver', nonce: `regression-${action}`, at: NOW, action, ...(action === 'message' ? { message: 'Hello B' } : action === 'dispatch' ? { plan: PLAN, item: 'p1-1' } : {}) }
  const sender = await authorizedSender(c, { goal: 'Sender A' }), receiver = session({ id: 'receiver', goal: 'Receiver B' })
  await io.writeAtomic(paths.planJson(PLAN), JSON.stringify(plan()))
  const context = (self: typeof sender) => ({ io, paths, self, turnId: () => action === 'compact' ? 'busy-turn' : undefined, save: async () => { await io.writeAtomic(paths.session(self.id), JSON.stringify(self)) } })
  const a = context(sender), b = context(receiver)
  const engine: any = { clock: { now: async () => NOW, after: (_: number, callback: () => void) => callbacks.push(callback) }, ui: { toast: noop }, session: { compact: async () => ({}) }, prompt: { submit: async () => ({}) }, turn: { abort: async () => ({}) } }
  await a.save(); await b.save()
  await completeControlSend(engine, a, envelope(c)); await completeControlSend(engine, a, envelope(c))
  expect(sender.activityEvents?.filter(e => e.kind === 'control').length).toBe(1)
  await receiveControl(engine, { text: envelope(c), origin: { kind: 'peer' } } as never, b)
  await collectControlResults(engine, a); await collectControlResults(engine, a)
  if (action === 'compact' || callbacks.length) expect(receiver.activityEvents?.length ?? 0).toBe(0)
  for (const callback of callbacks) callback()
  for (let n = 0; n < 12; n++) await Promise.resolve()
  if (action === 'compact') await flushCompact(engine, { ...b, turnId: () => undefined })
  await collectControlResults(engine, a); await collectControlResults(engine, a)
  await receiveControl(engine, { text: envelope(c), origin: { kind: 'peer' } } as never, b)
  expect(sender.activityEvents?.filter(e => e.kind === 'control').length).toBe(1)
  expect(receiver.activityEvents?.filter(e => e.kind === 'control').length).toBe(1)
  expect(sender.pendingControls?.length ?? 0).toBe(0)
  if (action === 'message') {
    expect(sender.activityEvents?.[0]?.text).toBe('Sent a message to Receiver B.')
    expect(receiver.activityEvents?.[0]?.text).toBe('Received a message from Sender A.')
    const s = snap(); s.sessions = [sender, receiver].map(rec => ({ ...rec, isAlive: true, isSelf: rec.id === 'sender', attribution: { confident: [], speculative: [] } } as any))
    s.activity = await activityOf(io, paths, s, { get: async () => [] } as any)
    const tree = renderActivity(els, s, ui(), { filter: noop, more: noop })
    const rows = nodes(tree).filter(n => String(n.props.key).startsWith('activity-row-') && /(?:Sent|Received) a message/.test(text(n)))
    expect(rows.length).toBe(2)
    expect(rows.some(n => text(n).includes('Sender A') && text(n).includes('Sent a message to Receiver B.'))).toBe(true)
    expect(rows.some(n => text(n).includes('Receiver B') && text(n).includes('Received a message from Sender A.'))).toBe(true)
  }
})
