// 0.6.1, from a fresh-user test in a clean container: internal names in the empty state, the empty
// state under a pending draft, and imported history that looked freshly finished.

import { expect, enTest as test } from './locale-test'
import { renderPanel } from '../hooks/panel'
import { bundled, t } from '../hooks/i18n'
import { NOW, PLAN, plan, session } from './v03-fixtures'
import type { PanelUi, Plan, Snapshot } from '../types'

const els = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: any) => ({ type, props })])) as any
const children = (n: any): any[] => !n || typeof n !== 'object' ? [] : [n.props?.children].flat(Infinity).filter(Boolean)
const nodes = (n: any): any[] => [n, ...children(n).flatMap(nodes)].filter(x => x && typeof x === 'object')
const text = (n: any): string => typeof n === 'string' || typeof n === 'number' ? String(n) : children(n).map(text).join('')
const ui = (over: Partial<PanelUi> = {}): PanelUi => ({ expanded: [], showReview: false, selectedReview: null, showRelated: false, showEnded: false, pick: null, ...over })
const noop = () => {}
const act: any = { accept: noop, reject: noop, edit: noop, toggleReview: noop, selectReview: noop, undo: noop, refresh: noop, pickNext: noop, togglePhase: noop, toggleExpand: noop, toggleRelated: noop, toggleEnded: noop, dismissAway: noop }
const self = { ...session(), isAlive: true, isSelf: true, attribution: { confident: [], speculative: [] } } as any
const snapOf = (plans: Plan[], waiting: Snapshot['waiting'] = [], focusPlan: string | null = null): Snapshot =>
  ({ now: NOW, selfId: 's1', focusPlan, repoPlans: [], plans, sessions: [self], recent: [], waiting })
const panel = (s: Snapshot, over: Partial<PanelUi> = {}) => renderPanel(els, s, ui(over), 90, '■', act)

test('V061 the empty state names no tool or environment variable, and every catalog translates it', () => {
  const en = bundled.en!['panel.m063']!
  expect(en).toContain('/progress import')
  expect(en).not.toContain('progress_plan')
  expect(en).not.toContain('PROGRESS_BOARD_PLAN')
  for (const code of ['zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR', 'ru']) {
    const value = bundled[code]!['panel.m063']!
    expect({ code, differs: value !== en }).toEqual({ code, differs: true })
    expect(value).not.toContain('progress_plan')
    expect(value).not.toContain('PROGRESS_BOARD_PLAN')
  }
  // Japanese says 計画, like the rest of its catalog (review IN-02).
  expect(bundled.ja!['panel.m063']).toContain('計画')
  expect(bundled.ja!['panel.m063']).not.toContain('プラン')
})

test('V061 the empty state is shown only with neither an active plan nor a pending draft', () => {
  const empty = text(panel(snapOf([])))
  expect(empty).toContain(t('panel.m063'))
  const draft = plan({ id: 'acme/draft', status: 'draft' })
  const pending = text(panel(snapOf([draft], [{ kind: 'draft', plan: 'acme/draft', phases: 2 }])))
  expect(pending).toContain('acme/draft')
  expect(pending).not.toContain(t('panel.m063'))
  // An active plan needs no empty state either.
  expect(text(panel(snapOf([plan()], [], PLAN)))).not.toContain(t('panel.m063'))
})

test('V061 a done item shows a completion time only when the time is known', () => {
  const p = plan()
  p.phases[0]!.items = [
    { id: 'p1-1', title: 'Known time', status: 'done', updatedAt: NOW, doneAt: NOW },
    { id: 'p1-2', title: 'Imported history', status: 'done', updatedAt: NOW },
  ]
  const tree = panel(snapOf([p], [], PLAN), { expanded: ['open-p1'] })
  const rowOf = (title: string) => nodes(tree).find(n => n.type === 'Text' && text(n).includes(title) && text(n).includes('✓'))
  expect(text(rowOf('Known time'))).toMatch(/\d{2}:\d{2}/)
  expect(text(rowOf('Imported history'))).not.toMatch(/\d{2}:\d{2}/)
})

test('V061 a collapsed phase never presents undated imported history as recent', () => {
  const p = plan()
  p.phases[0]!.items = [
    { id: 'p1-1', title: 'Wrapping now', status: 'wrapping', updatedAt: NOW },
    { id: 'p1-2', title: 'Dated completion', status: 'done', updatedAt: NOW, doneAt: NOW - 60_000 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `p1-${i + 3}`, title: `Imported history ${i + 1}`, status: 'done' as const, updatedAt: NOW })),
  ]
  const tree = panel(snapOf([p], [], PLAN))
  const has = (title: string) => nodes(tree).some(n => n.type === 'Text' && text(n).includes(title))
  expect(has('Wrapping now')).toBe(true)
  expect(has('Dated completion')).toBe(true)
  // Imported history has no completion time, so it is not "recent" either.
  expect(has('Imported history 1')).toBe(false)
})
