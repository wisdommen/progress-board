import { number, t as tr } from './i18n'
// The band's two rows as plain segments, sized to three width tiers and dropped by priority.

import type { Color } from 'claude-code'

import type { Plan, SessionView, Snapshot } from '../types'
import { allocCells, liveClaims, progress, sessionName } from './model'
import { autoMark, autoGoalLabel } from './nudge'
import { clip, minutes, padTo, strWidth } from './util'

export type Seg = { t: string; color?: Color; dim?: boolean; bold?: boolean }
/** prio: 0 never dropped; then numbers 1 > waiting 2 > bar 3 > name 4 > activity 5 > other 6. */
export type Group = { prio: number; segs: Seg[] }
export type Row = Group[]

export type Tier = 'wide' | 'mid' | 'narrow'
export function tierOf(cols: number): Tier {
  return cols >= 100 ? 'wide' : cols >= 60 ? 'mid' : 'narrow'
}
const BAR: Record<Tier, number> = { wide: 12, mid: 10, narrow: 8 }

export function rowText(row: Row): string {
  return row.map(g => g.segs.map(s => s.t).join('')).join('')
}

/** Drops the lowest-priority groups (rightmost first among equals) until the row fits. */
export function fit(row: Row, cols: number): Row {
  const out = [...row]
  while (strWidth(rowText(out)) > cols) {
    let at = -1
    out.forEach((g, i) => {
      const cur = out[at]
      if (g.prio > 0 && (at < 0 || (cur && g.prio >= cur.prio))) at = i
    })
    if (at < 0) break
    out.splice(at, 1)
  }
  return out
}

export function barSegs(counts: number[], colors: { color: Color; dim?: boolean }[], cells: number, absorb: number, glyph: string): Seg[] {
  const alloc = allocCells(counts, cells, absorb)
  const used = alloc.reduce((a, b) => a + b, 0)
  const segs: Seg[] = []
  alloc.forEach((n, i) => {
    const c = colors[i]
    if (n > 0 && c) segs.push({ t: glyph.repeat(n), color: c.color, ...(c.dim ? { dim: true } : {}) })
  })
  if (used < cells) segs.push({ t: glyph.repeat(cells - used), color: 'subtle' })
  return segs
}

export type BannerInput = {
  snap: Snapshot
  cols: number
  glyph: string
  isWorking: boolean
  spinner: string
  now: number
}

export type Banner = { rows: Row[]; isHidden: boolean }

function bgSummary(s: SessionView, now: number): { n: number; longest: number } {
  const running = s.bg.filter(b => b.endedAt === undefined)
  const longest = running.reduce((m, b) => Math.max(m, now - b.startedAt), 0)
  return { n: running.length, longest: minutes(longest) }
}

const DAY = 24 * 3600_000

/**
 * The plan row 2 shows: the session's most recently claimed active plan, else its confident one, else the
 * repo's. A finished plan shows only when nothing active is in view and it finished within a day, so a
 * completed claim never keeps the focus over active work.
 */
export function focusPlanOf(snap: Snapshot): { plan: Plan | null; more: number } {
  const self = snap.sessions.find(s => s.isSelf)
  const byId = new Map(snap.plans.map(p => [p.id, p]))
  const claimedActive = self ? [...new Set(liveClaims(self.claims, snap.plans).map(c => c.plan))] : []
  const more = Math.max(0, claimedActive.length - 1)
  if (snap.focusPlan) {
    const p = byId.get(snap.focusPlan)
    if (p && (p.status === 'active' || p.status === 'done')) return { plan: p, more }
  }
  const claims = self ? [...self.claims].sort((a, b) => b.at - a.at).map(c => c.plan) : []
  const ordered = [...new Set([...claims, ...(self?.attribution.confident.map(c => c.plan) ?? []), ...(self?.lastPlan ? [self.lastPlan] : []), ...snap.repoPlans])]
  const plans = ordered.map(id => byId.get(id)).filter((p): p is Plan => !!p)
  const active = plans.find(p => p.status === 'active')
  if (active) return { plan: active, more }
  const recent = plans.find(p => p.status === 'done' && snap.now - p.updatedAt < DAY)
  return { plan: recent ?? null, more }
}

/** Sessions working on a plan, including those that accepted or changed one of its items here. */
export function sessionsOn(snap: Snapshot, planId: string): number {
  return snap.sessions.filter(s => s.isAlive && s.endedAt === undefined
    && (s.attribution.confident.some(c => c.plan === planId) || (s.editedPlans ?? []).some(e => e.plan === planId))).length
}

export function buildBanner(inp: BannerInput): Banner {
  const { snap, cols, glyph, now } = inp
  const tier = tierOf(cols)
  const cells = BAR[tier]
  const self = snap.sessions.find(s => s.isSelf)
  const waiting = snap.waiting.length
  const { plan, more } = focusPlanOf(snap)
  const draft = snap.plans.find(p => p.status === 'draft' && (snap.repoPlans.includes(p.id) || p.createdBy === snap.selfId))
    ?? snap.plans.find(p => p.status === 'draft')

  // ---- row 2 ----
  const lead2: Group = { prio: 0, segs: [{ t: '◆ ', color: 'success' }] }
  const waitG = (sep: string): Group[] => (waiting > 0 ? [{ prio: 2, segs: [{ t: tr('banner.m001', { p0: sep, p1: waiting }), color: 'warning', bold: true }] }] : [])
  let row2: Row
  let row2Empty = false
  let name2 = ''
  const mineIds = new Set((self?.claims ?? []).filter(c => c.plan === plan?.id && c.item).map(c => c.item as string))
  if (plan && plan.status === 'done') {
    row2 = [{ prio: 0, segs: [{ t: '✓ ', color: 'success' }] }, { prio: 6, segs: [{ t: tier === 'wide' ? tr('banner.m002') : '', color: 'success' }] },
      { prio: 4, segs: [{ t: plan.title, color: 'success', bold: true }] }, { prio: 1, segs: [{ t: tr('banner.m003'), color: 'success' }] }, ...waitG(' · ')]
  } else if (plan) {
    const pr = progress(plan, mineIds)
    name2 = plan.title
    const bar: Group = { prio: 3, segs: barSegs([pr.done, pr.wrapping, pr.mine, pr.todo, pr.unplannedEst],
      [{ color: 'success' }, { color: 'warning' }, { color: 'claude' }, { color: 'subtle' }, { color: 'inactive', dim: true }], cells, 3, glyph) }
    const nums: Group = { prio: 1, segs: [{ t: `${number(pr.done)}/${number(pr.planned)}`, bold: true }, ...(pr.unplannedPhases > 0 ? [{ t: ` +${number(pr.unplannedPhases)}`, color: 'subtle' as Color }] : [])] }
    const n = sessionsOn(snap, plan.id)
    const extra = more > 0 ? tr('banner.m004', { p0: more }) : ''
    if (tier === 'wide') {
      row2 = [lead2, { prio: 6, segs: [{ t: tr('banner.m005') }] }, { prio: 4, segs: [{ t: '' }] }, { prio: 0, segs: [{ t: '  ' }] }, bar, { prio: 0, segs: [{ t: '  ' }] }, nums,
        { prio: 6, segs: [{ t: tr('banner.m006', { p0: n }), dim: true }] }, ...waitG(' · '), ...(extra ? [{ prio: 6, segs: [{ t: extra, dim: true }] }] : [])]
    } else if (tier === 'mid') {
      row2 = [lead2, { prio: 4, segs: [{ t: '' }] }, { prio: 0, segs: [{ t: '  ' }] }, bar, { prio: 0, segs: [{ t: '  ' }] }, nums, ...waitG(' · ')]
    } else {
      row2 = [lead2, bar, { prio: 0, segs: [{ t: ' ' }] }, nums, ...waitG(' ')]
    }
  } else if (draft) {
    const ph = draft.phases.filter(p => !p.isVoid).length
    row2 = [{ prio: 0, segs: [{ t: '◆ ', color: 'warning' }] },
      { prio: 6, segs: [{ t: tier === 'narrow' ? '' : tr('banner.m007'), color: 'warning' }] },
      { prio: 4, segs: [{ t: tier === 'narrow' ? tr('banner.m008') : tr('banner.m009', { p0: ph }), color: 'warning' }] },
      { prio: 2, segs: [{ t: tr('banner.m010', { p0: tier === 'narrow' ? ' ' : '', p1: Math.max(1, waiting) }), color: 'warning', bold: true }] },
      { prio: 6, segs: [{ t: '  /progress', dim: true }] }]
  } else {
    row2Empty = waiting === 0
    row2 = [{ prio: 0, segs: [{ t: '◆ ', color: 'subtle' }] }, { prio: 6, segs: [{ t: tr('banner.m011'), color: 'subtle' }] }, ...waitG(' · ')]
  }

  // ---- row 1 ----
  const lead1: Group = { prio: 0, segs: [{ t: `${inp.isWorking ? inp.spinner : '●'} `, color: 'claude' }] }
  const bg = self ? bgSummary(self, now) : { n: 0, longest: 0 }
  const idle = self ? minutes(now - self.lastActivity) : 0
  const idleG: Group[] = idle >= 15 && !inp.isWorking ? [{ prio: 6, segs: [{ t: tr('banner.m012', { p0: idle }), color: 'subtle' }] }] : []
  const bgWide = bg.n > 0 ? tr('banner.m013', { p0: bg.n, p1: bg.longest }) : ''
  const bgMid = bg.n > 0 ? tr('banner.m014', { p0: bg.n, p1: bg.longest }) : ''
  let row1: Row
  let row1Empty = false
  let name1 = ''
  // Progress tracking invariant.
  const auto1 = self && !self.goal?.trim() && self.autoGoal?.trim() ? `${autoGoalLabel(self.autoGoal)}${autoMark()}` : ''
  const steps = self?.steps ?? []
  const stepDone = steps.filter(s => s.status === 'done').length
  const stepDoing = steps.filter(s => s.status === 'doing').length
  const current = steps.find(s => s.status === 'doing')
  // A session that dispatches work shows what it sent out, not an empty step fraction.
  const runningAgents = self ? self.bg.filter(b => b.kind === 'agent' && b.endedAt === undefined).length : 0
  const isDispatch = !!self && steps.length === 0 && ((self.dispatched ?? 0) > 0 || self.kind === 'orchestrator')
  if (self && (self.kind === 'orchestrator' || isDispatch)) {
    const label = self.kind === 'orchestrator'
      ? (plan?.id ?? self.goal ?? tr('banner.m015'))
      : (self.goal?.trim() || auto1 || sessionName(self))
    name1 = label
    const live = liveClaims(self.claims, snap.plans)
    const pushing = live.filter(c => c.item).length || live.length
    const head = self.kind === 'orchestrator' ? tr('banner.m016') : tr('banner.m017')
    const pushingG: Group[] = self.kind === 'orchestrator' ? [{ prio: 1, segs: [{ t: tr('banner.m018', { p0: pushing }), bold: true }] }] : []
    const dispatchG: Group = { prio: 1, segs: [{ t: steps.length === 0 ? `${tier === 'narrow' ? '' : ' · '}${tr('banner.dispatchSummary', { sent: self.dispatched, returned: self.agentsDone })}` : `${tier === 'narrow' ? '' : ' · '}${tr('banner.dispatchCount', { sent: self.dispatched })}`, bold: true }] }
    const runningG: Group[] = steps.length === 0 && runningAgents > 0 ? [{ prio: 6, segs: [{ t: tr('banner.m021', { p0: runningAgents }), dim: true }] }] : []
    const labelG: Group = { prio: 4, segs: [{ t: label, ...(label === auto1 ? { color: 'subtle' as Color } : {}) }] }
    if (tier === 'wide') {
      row1 = [lead1, { prio: 6, segs: [{ t: head, color: 'claude', bold: true }] }, labelG, { prio: 0, segs: [{ t: '  ' }] },
        ...pushingG, dispatchG, ...runningG, ...(bgWide ? [{ prio: 5, segs: [{ t: ` · ${bgWide}`, dim: true }] }] : []), ...idleG]
    } else if (tier === 'mid') {
      row1 = [lead1, labelG, { prio: 0, segs: [{ t: '  ' }] },
        ...pushingG, dispatchG, ...runningG, ...(bgMid ? [{ prio: 5, segs: [{ t: `  ${bgMid}`, dim: true }] }] : []), ...idleG]
    } else {
      row1 = [lead1, { prio: 0, segs: [{ t: (self.kind === 'orchestrator' ? tr('banner.m022') : '') }] }, dispatchG,
        ...runningG, { prio: 4, segs: [{ t: ` ${clip(label, 10)}`, ...(label === auto1 ? { color: 'subtle' as Color } : {}) }] }]
    }
  } else if (self && (self.goal || steps.length > 0)) {
    // Steps imported from TodoWrite / TaskCreate, or reported without a goal, still show; the name falls back.
    name1 = self.goal?.trim() || auto1 || sessionName(self)
    const bar: Group = { prio: 3, segs: steps.length > 0
      ? barSegs([stepDone, stepDoing, steps.length - stepDone - stepDoing], [{ color: 'claude' }, { color: 'claude', dim: true }, { color: 'subtle' }], cells, 2, glyph)
      : [{ t: glyph.repeat(cells), color: 'subtle' }] }
    const nums: Group = { prio: 1, segs: [{ t: `${number(stepDone)}/${number(steps.length)}`, bold: true }] }
    if (tier === 'wide') {
      row1 = [lead1, { prio: 6, segs: [{ t: tr('banner.m023') }] }, { prio: 4, segs: [{ t: '' }] }, { prio: 0, segs: [{ t: '  ' }] }, bar, { prio: 0, segs: [{ t: '  ' }] }, nums,
        ...(current ? [{ prio: 6, segs: [{ t: tr('banner.m024', { p0: clip(current.title, 24) }), dim: true }] }] : []),
        ...(bgWide ? [{ prio: 5, segs: [{ t: `${current ? ' · ' : '   '}${bgWide}`, dim: true }] }] : []), ...idleG]
    } else if (tier === 'mid') {
      row1 = [lead1, { prio: 4, segs: [{ t: '' }] }, { prio: 0, segs: [{ t: '  ' }] }, bar, { prio: 0, segs: [{ t: ' ' }] }, nums,
        ...(bgMid ? [{ prio: 5, segs: [{ t: `  ${bgMid}`, dim: true }] }] : []), ...idleG]
    } else {
      row1 = [lead1, bar, { prio: 0, segs: [{ t: ' ' }] }, nums, { prio: 4, segs: [{ t: ` ${clip(name1, 10)}`, ...(name1 === auto1 ? { color: 'subtle' as Color } : {}) }] }]
    }
  } else if (bg.n > 0) {
    row1 = [lead1, { prio: 6, segs: [{ t: tier === 'narrow' ? '' : tr('banner.m025') }] },
      ...(auto1 ? [{ prio: 4, segs: [{ t: `${auto1}  `, color: 'subtle' as Color }] }] : []),
      { prio: 5, segs: [{ t: tier === 'wide' ? bgWide : bgMid, dim: true }] }, ...idleG]
  } else if (auto1) {
    row1 = [lead1, { prio: 6, segs: [{ t: tier === 'narrow' ? '' : tr('banner.m026') }] }, { prio: 4, segs: [{ t: auto1, color: 'subtle' }] }, ...idleG]
  } else {
    row1Empty = true
    row1 = [{ prio: 0, segs: [{ t: `${inp.isWorking ? inp.spinner : '●'} `, color: 'subtle' }] }, { prio: 6, segs: [{ t: tr('banner.m027'), color: 'subtle' }] }]
  }

  // Align both bars: pad the name column of rows that carry one to the same width.
  if (tier !== 'narrow') {
    const W = Math.min(tier === 'wide' ? 24 : 18, Math.max(8, strWidth(clip(name1, tier === 'wide' ? 24 : 18)), strWidth(clip(name2, tier === 'wide' ? 24 : 18))))
    const setName = (row: Row, name: string) => {
      if (!name) return
      const g = tier === 'wide' ? row[2] : row[1]
      if (!g || g.prio !== 4) return
      // Progress tracking invariant.
      g.segs = name === auto1 ? [{ t: padTo(name, W), color: 'subtle' }] : [{ t: padTo(clip(name, W), W), bold: true }]
    }
    setName(row1, name1)
    setName(row2, name2)
  }

  const isHidden = row1Empty && row2Empty
  return { rows: [fit(row1, cols), fit(row2, cols)], isHidden }
}
