import type { Item, PanelUi, Plan, Snapshot } from '../types'
import { liveItems } from './model'

/** The same view boundary is shared by the overview and background plan checks. */
export function visiblePlans(snap: Snapshot): Plan[] {
  const me = snap.sessions.find(s => s.isSelf)
  const ids = new Set([snap.focusPlan, ...snap.repoPlans, ...(me?.attribution.confident.map(a => a.plan) ?? []), ...(me?.claims.map(c => c.plan) ?? [])])
  return snap.plans.filter(p => p.status === 'active' && ids.has(p.id))
}
export function completionHistory(plan: Plan, now: number): { at: number; count: number }[] {
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(today); day.setDate(day.getDate() - 13 + i)
    return { at: day.getTime(), count: 0 }
  })
  for (const phase of plan.phases.filter(p => !p.isVoid)) for (const item of liveItems(phase)) {
    if (item.status !== 'done' || item.doneAt === undefined || item.doneAt > now) continue
    const index = days.findLastIndex(day => item.doneAt! >= day.at)
    if (index >= 0) days[index]!.count++
  }
  return days
}
export function sparkline(values: readonly number[]): string {
  const glyphs = '▁▂▃▄▅▆▇█', max = Math.max(1, ...values)
  return values.map(n => glyphs[Math.round(Math.max(0, n) / max * 7)]).join('')
}
export function matchesFilter(item: Item, ui: PanelUi, claimed: boolean): boolean {
  if (ui.search && !item.title.toLocaleLowerCase().includes(ui.search.trim().toLocaleLowerCase())) return false
  switch (ui.itemFilter) {
    case 'doing': return claimed && item.status === 'todo'
    case 'todo': return !claimed && item.status === 'todo'
    case 'wrapping': return item.status === 'wrapping'
    case 'done': return item.status === 'done'
    default: return true
  }
}
