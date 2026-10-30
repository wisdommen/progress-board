// 0.6.5: a change awaiting review is approved or rejected from the panel. The panel used to offer only
// "undo selected change", so a plan proposed by a relaying session stayed flagged until `/progress review ok`.

import { expect, enTest as test } from './locale-test'
import { renderPanel } from '../hooks/panel'
import { newReview } from '../hooks/model'
import { t } from '../hooks/i18n'
import { NOW, PLAN, plan, session } from './v03-fixtures'
import type { PanelUi, Plan, Snapshot } from '../types'

const els = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: any) => ({ type, props })])) as any
const children = (n: any): any[] => !n || typeof n !== 'object' ? [] : [n.props?.children].flat(Infinity).filter(Boolean)
const nodes = (n: any): any[] => [n, ...children(n).flatMap(nodes)].filter(x => x && typeof x === 'object')
const ui = (over: Partial<PanelUi> = {}): PanelUi => ({ expanded: [], showReview: false, showRelated: false, showEnded: false, pick: null, ...over })
const self = { ...session(), isAlive: true, isSelf: true, attribution: { confident: [], speculative: [] } } as any
const relayed = { kind: 'relayed' as const, at: NOW, by: 's1', relayedBy: 'secretary' }
const review = (id: string, summary: string) => newReview(id, NOW - 60_000, summary, 'relayed', 's1', relayed, false, { kind: 'plan-draft' })

function render(reviews: ReturnType<typeof review>[], over: Partial<PanelUi> = {}) {
  const p: Plan = { ...plan(), reviews }
  const snap: Snapshot = { now: NOW, selfId: 's1', focusPlan: PLAN, repoPlans: [PLAN], plans: [p], sessions: [self], recent: [],
    waiting: [{ kind: 'review', plan: PLAN, count: reviews.length, first: reviews[0]!.summary }] }
  const calls: string[] = []
  const noop = () => {}
  const act: any = { accept: noop, reject: noop, edit: noop, toggleReview: noop, refresh: noop, pickNext: noop, togglePhase: noop,
    toggleExpand: noop, toggleRelated: noop, toggleEnded: noop, dismissAway: noop,
    approveReview: (id: string) => calls.push(`approve:${id}`), rejectReview: (id: string) => calls.push(`reject:${id}`) }
  const buttons = nodes(renderPanel(els, snap, ui(over), 100, '■', act)).filter(n => n.type === 'Button')
  return { buttons, calls }
}

test('V065 a single change awaiting review has Approve and Reject on its own line', () => {
  const { buttons, calls } = render([review('r1', 'New plan')])
  const ok = buttons.find(b => b.props.label === t('panel.m036'))
  const no = buttons.find(b => b.props.label === t('panel.m037'))
  expect(ok?.props.hotkey).toBe('y')
  expect(no?.props.hotkey).toBe('n')
  ok.props.onPress(); no.props.onPress()
  expect(calls).toEqual(['approve:r1', 'reject:r1'])
})

test('V065 several changes are approved or rejected one by one under View', () => {
  const closed = render([review('r1', 'New plan'), review('r2', 'Phase added')])
  expect(closed.buttons.some(b => b.props.label === t('panel.m036'))).toBe(false)
  const open = render([review('r1', 'New plan'), review('r2', 'Phase added')], { showReview: true })
  for (const b of open.buttons.filter(b => b.props.label === t('panel.m036') || b.props.label === t('panel.m037'))) {
    expect(b.props.hotkey).toBeUndefined()
    b.props.onPress()
  }
  expect(open.calls).toEqual(['approve:r1', 'reject:r1', 'approve:r2', 'reject:r2'])
})
