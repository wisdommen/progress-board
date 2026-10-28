import type { Plan, ProgressEvent, SessionRec } from '../types'
import { clip, mentionsExactly, strWidth } from './util'

export const WORKER_DUTY = "This session must update items it claims or was assigned: when PROGRESS_BOARD_PLAN or the first message names an item, use progress_plan set_item to update wrapping/done/milestone on completion, not just your own steps."

export function bashSignal(command: string): string | undefined {
  const signals = /(?:^|[;&|\n]\s*)\s*(?:git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+(push|merge|tag)(?=\s|$)|gh\s+pr\s+(create|merge|ready)(?=\s|$))([^;&|\n]*)/g
  for (const hit of command.matchAll(signals)) {
    const args = (hit[3] ?? '').trim()
    if (/(?:^|\s)(?:--dry-run|--help|-h)(?=\s|$)/.test(args)) continue
    if (hit[1] === 'tag' && (!args || /(?:^|\s)(?:-l|--list|-n\d*|--verify|-v)(?=\s|$)/.test(args))) continue
    return hit[1] ? `git ${hit[1]}` : `gh pr ${hit[2]}`
  }
  return undefined
}

export function candidateItems(s: SessionRec, p: Plan, text: string): string[] {
  return p.phases.filter(ph => !ph.isVoid).flatMap(ph => ph.items)
    .filter(i => i.status !== 'done' && i.status !== 'void')
    .filter(i => s.claims.some(c => c.plan === p.id && (c.item === i.id || (!c.item && c.phase === p.phases.find(ph => ph.items.includes(i))?.id)))
      || mentionsExactly(text, i.id) || text.split('/').some(t => mentionsExactly(t, i.id))
      || (strWidth(i.title.trim()) >= 6 && text.includes(i.title)))
    .map(i => i.id)
}

export function recordEvent(s: SessionRec, event: ProgressEvent, plans: readonly Plan[], attributed: readonly string[], search = event.text): void {
  const entry = { ...event, text: clip(event.text.replace(/\s+/g, ' '), 240) }
  s.activityEvents = [...(s.activityEvents ?? s.events ?? []), entry].filter(e => event.at - e.at <= 7 * 86400_000).slice(-5000)
  s.events = [...(s.events ?? []), entry].slice(-30)
  const targets = plans.filter(p => p.status === 'active' && (attributed.includes(p.id) || s.claims.some(c => c.plan === p.id)))
    .map(p => ({ plan: p.id, items: candidateItems(s, p, search) }))
  if (targets.length) s.pendingProgress = { event: event.kind === 'bash' ? bashSignal(event.text) ?? "repository operation" : event.kind === 'agent' ? "agent return" : event.kind === 'task' ? "background task return" : "session message", targets, ...(s.pendingProgress?.note ? { note: s.pendingProgress.note } : {}) }
}

export function takeProgressReminder(s: SessionRec, plans: readonly Plan[], repoPlans: readonly string[]): string | undefined {
  const calls = s.calls ?? 0
  if ((s.lastPlanCall !== undefined && calls - s.lastPlanCall <= 2) || (s.lastProgressNudge !== undefined && calls - s.lastProgressNudge < 3)) return undefined
  const pending = s.pendingProgress
  if (pending) {
    const parts = pending.targets.flatMap(t => {
      const p = plans.find(p => p.id === t.plan && p.status === 'active')
      if (!p) return []
      const items = p.phases.filter(ph => !ph.isVoid).flatMap(ph => ph.items).filter(i => t.items.includes(i.id) && i.status !== 'done' && i.status !== 'void')
      return [`progress-board: the recent ${pending.event} may have advanced plan ${p.id}. Candidate items: ${new Intl.ListFormat('en', { type: 'conjunction' }).format(items.map(i => `${i.id} “${i.title}”`)) || "no match; check against the actual work"}. Use progress_plan set_item to update status or milestone if anything changed; otherwise ignore. ${pending.note ?? ''}`]
    })
    delete s.pendingProgress
    if (parts.length) { s.lastProgressNudge = calls; return parts.join('\n') }
  }
  const active = repoPlans.filter(id => plans.some(p => p.id === id && p.status === 'active'))
  if (calls >= 8 && !s.unclaimedNudged && s.kind !== 'orchestrator' && s.claims.length === 0 && active.length) {
    s.unclaimedNudged = true
    s.lastProgressNudge = calls
    return `progress-board: this session works in ${s.repoRoot ?? s.cwd} but has not claimed items in plan ${new Intl.ListFormat('en', { type: 'conjunction' }).format(active)}; use progress_session claim if working on one.`
  }
  return undefined
}
