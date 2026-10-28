import type { EngineInterface } from 'claude-code'
import type { SessionRec, Snapshot } from '../types'
import { t } from './i18n'
import { parseJson, withLock } from './store'
import type { Io, Paths } from './store'

export function waitingKeys(snap: Snapshot): string[] {
  return snap.waiting.flatMap(w => {
    if (w.kind === 'draft') return [`draft:${w.plan}:${snap.plans.find(p => p.id === w.plan)?.createdAt ?? 0}`]
    if (w.kind === 'review') return snap.plans.find(p => p.id === w.plan)?.reviews.map(r => `review:${w.plan}:${r.id}`) ?? []
    if (w.kind === 'question') return [`question:${w.session}:${w.since}`]
    if (w.kind === 'ask') return [`ask:${w.session}:${w.id}:${w.at}`]
    return [`decision:${w.session}:${w.at}:${w.text}`]
  })
}
/** Pending increases survive typing and election ties; shared receipts prevent cross-session repeats. */
export async function notifyWaiting($: EngineInterface, io: Io, paths: Paths, self: SessionRec, snap: Snapshot): Promise<void> {
  const keys = waitingKeys(snap), state = self.waitingState
  if (!state) { self.waitingState = { known: keys, pending: [], count: keys.length }; return }
  const added = keys.filter(k => !state.known.includes(k))
  state.pending = state.pending.filter(k => keys.includes(k))
  if (keys.length > state.count && snap.settings?.notifications !== 'off') state.pending = [...new Set([...state.pending, ...added])]
  state.known = [...new Set([...state.known, ...keys])].slice(-5000); state.count = keys.length
  if (!snap.settings || snap.settings.notifications === 'off') { state.pending = []; return }
  if (!state.pending.length) return
  const live = snap.sessions.filter(s => s.isAlive && s.endedAt === undefined)
  const last = Math.max(...live.map(s => s.lastUserInput))
  const winners = live.filter(s => s.lastUserInput === last)
  if (winners.length !== 1 || winners[0]!.id !== self.id || snap.now - last < 10_000) return
  const dir = `${paths.root}/notifications`, path = `${dir}/receipts.json`
  const count = await withLock(io, dir, async guard => {
    const receipts = parseJson<Record<string, number>>(await io.read(path)) ?? {}
    const fresh = state.pending.filter(k => receipts[k] === undefined)
    for (const key of fresh) receipts[key] = snap.now
    for (const [key, at] of Object.entries(receipts)) if (snap.now - at > 7 * 86400_000) delete receipts[key]
    await guard(); await io.writeAtomic(path, JSON.stringify(receipts))
    return fresh.length
  })
  state.pending = []
  if (!count) return
  $.ui.toast(t('notify.waiting', { count }))
  if (snap.settings.notifications === 'sound') await $.audio.play({ asset: 'sounds/waiting.wav' }).catch(() => undefined)
}
