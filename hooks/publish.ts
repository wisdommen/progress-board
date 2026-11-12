// What the drawing hooks read is published as one state value, and the host refuses a value over
// 4,194,304 characters. A machine with many sessions builds a far larger snapshot (7 MB measured),
// so the published copy keeps only what drawing reads and then fits a budget. The full snapshot
// stays in memory for the tools and the monitor.
import type { SessionView, Snapshot } from '../types'

export const PUBLISH_BUDGET = 3_000_000
const WEEK = 7 * 24 * 3600_000
/** Session fields no drawing reads (panel, band, activity, sessions, overview, priorities, settings). */
const UNDRAWN = ['messages', 'waitingState', 'stepLog', 'ownQuotes'] as const

const size = (snap: Snapshot): number => JSON.stringify(snap).length
const last = <T>(list: T[], keep: number): T[] => keep === Number.POSITIVE_INFINITY ? list : keep <= 0 ? [] : list.slice(-keep)

function slimSession(s: SessionView, now: number, keep: number): SessionView {
  const out = { ...s } as SessionView & Record<string, unknown>
  for (const key of UNDRAWN) delete out[key]
  const recent = <T extends { at: number }>(list: T[] | undefined): T[] | undefined =>
    list === undefined ? undefined : last(list.filter(e => now - e.at <= WEEK), keep)
  if (out.activityEvents) out.activityEvents = recent(out.activityEvents)
  if (out.events) out.events = out.activityEvents ? [] : recent(out.events)
  if (out.decided) out.decided = recent(out.decided)
  if (out.bg) out.bg = last(out.bg, keep)
  return out
}

/** The snapshot as published to state: drawn fields only, within `budget` characters when it can be. */
export function publishable(snap: Snapshot | null, budget = PUBLISH_BUDGET): Snapshot | null {
  if (!snap) return snap
  // Sizes are measured once per session and summed: re-serializing the whole snapshot per dropped
  // session is quadratic and, at a thousand sessions, stalls the hooks worker.
  const base = JSON.stringify({ ...snap, sessions: [] }).length
  const fit = (keep: number, dropped: Set<string>): { sessions: SessionView[]; total: number } => {
    const sessions = snap.sessions.filter(s => !dropped.has(s.id)).map(s => slimSession(s, snap.now, keep))
    return { sessions, total: base + sessions.reduce((n, s) => n + JSON.stringify(s).length + 1, 0) }
  }
  const dropped = new Set<string>()
  let { sessions, total } = fit(Number.POSITIVE_INFINITY, dropped)
  if (total <= budget) return { ...snap, sessions }
  // Ended sessions go first, the longest-ended first; live ones and this session stay.
  const sizes = new Map(sessions.map(s => [s.id, JSON.stringify(s).length + 1]))
  const ended = sessions.filter(s => !s.isSelf && (s.endedAt !== undefined || !s.isAlive))
    .sort((a, b) => (a.endedAt ?? a.lastActivity) - (b.endedAt ?? b.lastActivity))
  for (const s of ended) {
    if (total <= budget) break
    dropped.add(s.id); total -= sizes.get(s.id) ?? 0
  }
  sessions = sessions.filter(s => !dropped.has(s.id))
  // Still over: each remaining session keeps fewer recent entries.
  for (const keep of [200, 50, 10, 0]) {
    if (total <= budget) break
    ;({ sessions, total } = fit(keep, dropped))
  }
  return { ...snap, sessions }
}
