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
  // A running task is never cut: the band and the sessions tab count it. Only finished ones are trimmed.
  if (out.bg) { const finished = out.bg.filter(b => b.endedAt !== undefined); const kept = new Set(last(finished, keep)); out.bg = out.bg.filter(b => b.endedAt === undefined || kept.has(b)) }
  return out
}

/** The snapshot as published to state: drawn fields only, within `budget` characters when it can be. */
export function publishable(snap: Snapshot | null, budget = PUBLISH_BUDGET): Snapshot | null {
  if (!snap) return snap
  // Sizes are measured once per part and summed: re-serializing the whole snapshot per dropped
  // session is quadratic and, at a thousand sessions, stalls the hooks worker.
  const base = JSON.stringify({ ...snap, sessions: [], activity: undefined }).length
  const allActivity = snap.activity
  const activityAt = (rows: number) => allActivity === undefined ? undefined : allActivity.slice(0, rows)
  const measure = (list: unknown[] | undefined) => (list ?? []).reduce<number>((n, x) => n + JSON.stringify(x).length + 1, 0)
  const dropped = new Set<string>()
  let keep = Number.POSITIVE_INFINITY, rows = Number.POSITIVE_INFINITY
  let sessions = snap.sessions.map(s => slimSession(s, snap.now, keep))
  let activity = allActivity
  const sizes = new Map(sessions.map(s => [s.id, JSON.stringify(s).length + 1]))
  let sessionTotal = [...sizes.values()].reduce((n, x) => n + x, 0)
  let activityTotal = measure(activity)
  const total = () => base + sessionTotal + activityTotal + 20
  const result = (): Snapshot => ({ ...snap, sessions: sessions.filter(s => !dropped.has(s.id)), ...(activity === undefined ? {} : { activity }) })
  if (total() <= budget) return result()
  // The activity tab shows 40 rows at a time, newest first: older rows go first.
  rows = 1000; activity = activityAt(rows); activityTotal = measure(activity)
  if (total() <= budget) return result()
  // Ended sessions go next, the longest-ended first; live ones and this session stay.
  const ended = sessions.filter(s => !s.isSelf && (s.endedAt !== undefined || !s.isAlive))
    .sort((a, b) => (a.endedAt ?? a.lastActivity) - (b.endedAt ?? b.lastActivity))
  for (const s of ended) {
    if (total() <= budget) return result()
    dropped.add(s.id); sessionTotal -= sizes.get(s.id) ?? 0
  }
  // Still over: each remaining session and the activity list keep fewer recent entries.
  for ([keep, rows] of [[200, 400], [50, 120], [10, 40], [0, 40]] as const) {
    if (total() <= budget) break
    sessions = snap.sessions.filter(s => !dropped.has(s.id)).map(s => slimSession(s, snap.now, keep))
    sessionTotal = measure(sessions)
    activity = activityAt(rows); activityTotal = measure(activity)
  }
  return result()
}
