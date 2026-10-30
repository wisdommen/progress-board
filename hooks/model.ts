import { bundled, language, t as tr } from './i18n'

/** Localized human-readable lists, shared by this model and its panel. */
export const displayList = (values: readonly string[]): string => new Intl.ListFormat(language(), { type: 'conjunction' }).format(values)
// Plan rules: structure, derived states, progress counts, approvals, the bar's cell allocation, "waiting on you".

import type {
  Approval, Ask, AwayReport, Claim, Item, ItemStatus, LogEntry, Phase, Plan, Review, SessionRec, SessionView, Snapshot, Undo, WaitingItem,
} from '../types'
import { mentionsExactly, mmddhhmm, normQuestion, normQuote, strWidth } from './util'

export const RELEASE_PHASE = 'Closeout / Release'
const isRelease = (name: string) => [RELEASE_PHASE, tr('model.m001'), '\u6536\u53e3 / \u53d1\u5e03', ...Object.values(bundled).map(c => c['model.m001'])].includes(name)
export const AWAY_MS = 30 * 60_000
export const EVIDENCE_MS = 6 * 3600_000

/** `cleared`: every item was voided — no live work left, excluded like a void phase (unlike `unplanned`). */
export type PhaseState = 'void' | 'cleared' | 'unplanned' | 'todo' | 'active' | 'done'

const RANK: Record<Exclude<ItemStatus, 'void'>, number> = { todo: 0, wrapping: 1, done: 2 }

/** An item counts as complete when done, or wrapping under a criteria exception. */
export function isComplete(it: Item): boolean {
  return it.status === 'done' || (it.status === 'wrapping' && !!it.exception)
}

export function liveItems(p: Phase): Item[] {
  return p.items.filter(i => i.status !== 'void')
}

export function phaseState(p: Phase): PhaseState {
  if (p.isVoid) return 'void'
  const items = liveItems(p)
  if (items.length === 0) return p.items.length > 0 ? 'cleared' : 'unplanned'
  if (items.every(isComplete)) return 'done'
  if (items.some(i => i.status !== 'todo')) return 'active'
  return 'todo'
}

/** Phases that carry work: not void, not cleared of every item. */
function workPhases(plan: Plan): Phase[] {
  return plan.phases.filter(p => { const st = phaseState(p); return st !== 'void' && st !== 'cleared' })
}

export function isPlanComplete(plan: Plan): boolean {
  const phases = workPhases(plan)
  return phases.length > 0 && phases.every(p => phaseState(p) === 'done')
}

/** An active or done plan is `done` exactly when complete, else `active`; drafts and abandoned plans keep theirs. */
export function deriveStatus(plan: Plan): Plan {
  if (plan.status !== 'active' && plan.status !== 'done') return plan
  const status = isPlanComplete(plan) ? 'done' : 'active'
  return status === plan.status ? plan : { ...plan, status }
}

/** The phase shown expanded: first not-done phase with items, else first not-done one. */
export function currentPhase(plan: Plan): Phase | undefined {
  const open = workPhases(plan).filter(p => phaseState(p) !== 'done')
  return open.find(p => phaseState(p) !== 'unplanned') ?? open[0]
}

export type Progress = {
  done: number
  wrapping: number
  mine: number
  todo: number
  unplannedEst: number
  /** Live items of planned phases. */
  planned: number
  /** The denominator: planned items plus the estimate for unplanned phases. */
  total: number
  /** True when `total` includes an estimate. */
  isEstimate: boolean
  unplannedPhases: number
  isComplete: boolean
}

/** Counts over live items; `mineIds` are item ids this session claims (shown in its own color). */
export function progress(plan: Plan, mineIds: ReadonlySet<string> = new Set()): Progress {
  let done = 0, wrapping = 0, mine = 0, todo = 0, planned = 0, plannedPhases = 0, unplannedPhases = 0
  for (const p of plan.phases) {
    const st = phaseState(p)
    if (st === 'void' || st === 'cleared') continue
    const items = liveItems(p)
    if (st === 'unplanned') { unplannedPhases++; continue }
    plannedPhases++
    for (const it of items) {
      planned++
      if (it.status === 'done') done++
      else if (it.status === 'wrapping') wrapping++
      else if (mineIds.has(it.id)) mine++
      else todo++
    }
  }
  const avg = plannedPhases > 0 ? Math.max(1, Math.round(planned / plannedPhases)) : 4
  const unplannedEst = avg * unplannedPhases
  return { done, wrapping, mine, todo, unplannedEst, planned, total: planned + unplannedEst, isEstimate: unplannedEst > 0, unplannedPhases, isComplete: isPlanComplete(plan) }
}

/**
 * Splits `cells` among `counts` by rounding (largest remainder); every non-zero count gets
 * at least one cell, taken from `absorb` (the "todo" slot) first, else from the largest slot.
 */
export function allocCells(counts: readonly number[], cells: number, absorb: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= 0 || cells <= 0) return counts.map(() => 0)
  const raw = counts.map(c => (c * cells) / total)
  const out = raw.map(Math.floor)
  let left = cells - out.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    out[i] = (out[i] ?? 0) + 1
    left--
  }
  for (let i = 0; i < counts.length; i++) {
    if ((counts[i] ?? 0) <= 0 || (out[i] ?? 0) > 0) continue
    const absorbFloor = (counts[absorb] ?? 0) > 0 ? 1 : 0
    let from = -1
    if (absorb !== i && (out[absorb] ?? 0) > absorbFloor) from = absorb
    else {
      let best = 0
      out.forEach((n, j) => {
        if (j !== i && n > 1 && n > best) { best = n; from = j }
      })
    }
    if (from < 0) continue
    out[from] = (out[from] ?? 0) - 1
    out[i] = 1
  }
  return out
}

// ---- approvals -------------------------------------------------------------

export type ApprovalInput = {
  kind?: 'plan_mode' | 'question' | 'quote'
  quote?: string
  quoted_at?: string
  away_authorization?: string
  relayed_by?: string
}

export type ApprovalCtx = {
  now: number
  sessionId: string
  /** The plan the change is for: a question's answer counts only when the question names it. */
  planId: string
  session: Pick<SessionRec, 'approvals' | 'lastUserInput'>
  /** Whether the quoted words are in one of the person's messages; null when that cannot be checked. */
  quoteFound: boolean | null
  /** The same for a quoted leave authorization. */
  awayFound: boolean | null
}

export type ApprovalVerdict =
  | { ok: false; why: string }
  | { ok: true; approval: Approval; isReview: boolean; isAway: boolean; spend?: Approval }

const NO = /\u4e0d|\u5426|\u522b|\u62d2|\u653e\u5f03|\u53d6\u6d88|\u6682\u7f13|\u63a8\u8fdf|\u9a73\u56de|\u5148\u7b49|\bno\b|\bnot\b|n't|\bnope\b|reject|decline|cancel|later|wait|hold/i
const YES = /\u91c7\u7eb3|\u540c\u610f|\u6279\u51c6|\u786e\u8ba4|\u5f00\u59cb|\u53ef\u4ee5|\u597d|\u884c|\u6ca1\u95ee\u9898|\u5c31\u8fd9\u6837|\u901a\u8fc7|\u6267\u884c|\u7ee7\u7eed|\byes\b|\by\b|approve|accept|\bok\b|okay|lgtm|go ahead|proceed|sure|confirm/i

/** True when an answer says yes (and nothing that says no). */
export function isAffirmative(text: string): boolean {
  return !NO.test(text) && YES.test(text)
}

/**
 * The evidence an AskUserQuestion result leaves: one record per answered question, with its text.
 * An AFK auto-resolution, a follow-up request or an empty answer leaves none.
 */
export function questionApprovals(input: { questions?: readonly { question?: unknown; header?: unknown }[] }, result: Record<string, unknown>, at: number): Approval[] {
  if (result['afkTimeoutMs'] !== undefined || result['followUp'] === true) return []
  const answers = result['answers'] && typeof result['answers'] === 'object' ? result['answers'] as Record<string, unknown> : {}
  const response = typeof result['response'] === 'string' ? result['response'].trim() : ''
  const out: Approval[] = []
  for (const q of input.questions ?? []) {
    const question = typeof q.question === 'string' ? q.question : ''
    const raw = answers[question]
    const answer = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(', ') : '').trim() || response
    if (!question || !answer) continue
    out.push({ kind: 'question', at, question, text: tr('model.quoted', { text: answer.slice(0, 80) }), isAffirmative: isAffirmative(answer) })
  }
  return out
}

/**
 * Judges a change's approval evidence. Evidence must be checkable: a quote must be found in the person's
 * own messages, an answered question must name the plan and say yes; spent evidence does not count again.
 * Away (30 minutes without input, or a leave authorization found in the person's messages) and relayed
 * approvals take effect but await review.
 */
export function judgeApproval(input: ApprovalInput | undefined, ctx: ApprovalCtx): ApprovalVerdict {
  const idle = ctx.now - ctx.session.lastUserInput > AWAY_MS
  const awayText = input?.away_authorization?.trim()
  const awayOk = !!awayText && ctx.awayFound === true
  const isAway = idle || awayOk
  const relayed = input?.relayed_by?.trim()
  const fresh = (a: Approval) => a.usedAt === undefined && ctx.now - a.at <= EVIDENCE_MS
  const latest = (pred: (a: Approval) => boolean) => [...ctx.session.approvals].reverse().find(a => fresh(a) && pred(a))
  let own: Approval | null = null
  let spend: Approval | undefined
  let why = tr('model.m002')
  if (awayText && !awayOk && !idle) why = ctx.awayFound === null ? tr('model.m003') : tr('model.m004')
  if (input?.kind === 'plan_mode') {
    const a = latest(x => x.kind === 'plan_mode' && !x.isPending)
    if (a) { own = { kind: 'plan_mode', at: a.at, by: ctx.sessionId, text: tr('model.m005') }; spend = a }
    else why = tr('model.m006')
  } else if (input?.kind === 'question') {
    const a = latest(x => x.kind === 'question' && x.isAffirmative === true && !!x.question && mentionsExactly(x.question, ctx.planId))
    if (a) { own = { kind: 'question', at: a.at, by: ctx.sessionId, ...(a.text ? { text: a.text } : {}), ...(a.question ? { question: a.question } : {}) }; spend = a }
    else why = tr('model.m007', { p0: ctx.planId })
  } else if (input?.kind === 'quote') {
    const q = input.quote?.trim() ?? ''
    const at = input.quoted_at?.trim() ?? ''
    if (normQuote(q).length < 2) why = tr('model.m008')
    else if (!at) why = tr('model.m009')
    else if (ctx.quoteFound === null) why = tr('model.m010')
    else if (ctx.quoteFound === false) why = tr('model.m011')
    else own = { kind: 'quote', at: ctx.now, by: ctx.sessionId, text: tr('model.quoteEvidence', { at: at.slice(0, 40), quote: q.slice(0, 120) }) }
  }
  if (relayed) {
    const base = own ?? { kind: 'relayed' as const, at: ctx.now, by: ctx.sessionId }
    return { ok: true, approval: { ...base, relayedBy: relayed }, isReview: true, isAway, ...(own && spend ? { spend } : {}) }
  }
  if (isAway) {
    const text = awayOk ? tr('model.m012', { p0: (awayText ?? '').slice(0, 80) }) : tr('model.m013')
    return { ok: true, approval: own ?? { kind: 'away', at: ctx.now, by: ctx.sessionId, text }, isReview: true, isAway: true, ...(own && spend ? { spend } : {}) }
  }
  return own ? { ok: true, approval: own, isReview: false, isAway: false, ...(spend ? { spend } : {}) } : { ok: false, why }
}

export function describeApproval(a: Approval | undefined): string {
  if (!a) return tr('model.m014')
  const when = mmddhhmm(a.at)
  const relay = a.relayedBy ? tr('model.m015', { p0: a.relayedBy }) : ''
  switch (a.kind) {
    case 'plan_mode': return tr('model.m016', { p0: when, p1: relay })
    case 'question': return tr('model.m017', { p0: when, p1: a.text ? ` ${a.text.slice(0, 40)}` : '', p2: relay })
    case 'quote': return tr('model.m018', { p0: a.text ?? '', p1: a.isUnverified ? tr('model.m019') : '', p2: relay })
    case 'panel': return tr('model.m020', { p0: when })
    case 'command': return `/progress accept ${when}`
    case 'away': return `${a.text ?? tr('model.m021')} ${when}`
    case 'relayed': return tr('model.m022', { p0: a.relayedBy ?? tr('model.m023'), p1: when })
  }
}

// ---- plan edits (pure) -----------------------------------------------------

/** An item as a plan edit names it: a title, or an already finished one with its real time. */
export type ItemSpec = { title: string; status?: 'todo' | 'done'; doneAt?: number }

export type PhaseSpec = { name: string; repo?: string; items?: (string | ItemSpec)[]; isRelease?: boolean }

function makeItems(phaseId: string, specs: readonly (string | ItemSpec)[] | undefined, now: number, start = 1): Item[] {
  const out: Item[] = []
  for (const s of specs ?? []) {
    const spec: ItemSpec = typeof s === 'string' ? { title: s } : s
    const title = spec.title.trim()
    if (!title) continue
    const id = `${phaseId}-${start + out.length}`
    const done = spec.status === 'done'
    out.push({
      id, title, status: done ? 'done' : 'todo', updatedAt: now,
      ...(done ? { doneAt: spec.doneAt ?? now } : {}),
    })
  }
  return out
}

export function newPlan(args: {
  id: string; title?: string; goal: string; criteria: string; repos?: string[]; phases: PhaseSpec[]; milestones?: string[]
  includeRelease?: boolean; by: string; now: number
}): Plan {
  const specs = [...args.phases]
  if (args.includeRelease !== false && !specs.some(p => p.isRelease || isRelease(p.name.trim()))) specs.push({ name: tr('model.m001'), isRelease: true })
  const milestones = (args.milestones ?? []).map(m => m.trim()).filter(Boolean)
  let seq = 0
  const phases: Phase[] = specs.map(s => {
    const id = `p${++seq}`
    return { id, name: s.name.trim(), ...((s.isRelease || isRelease(s.name.trim())) ? { isRelease: true } : {}), ...(s.repo ? { repo: s.repo } : {}), addedAt: args.now, items: makeItems(id, s.items, args.now) }
  })
  return {
    v: 1, id: args.id, title: args.title?.trim() || args.id, goal: args.goal, criteria: args.criteria,
    repos: args.repos ?? [], status: 'draft', createdAt: args.now, updatedAt: args.now, createdBy: args.by,
    phases, ...(milestones.length ? { milestones } : {}), reviews: [], seq, added: 0, voided: 0, reverts: [],
  }
}

export function findPhase(plan: Plan, ref: string | undefined): Phase | undefined {
  if (!ref) return undefined
  const r = ref.trim()
  return plan.phases.find(p => p.id === r) ?? plan.phases.find(p => p.name === r)
}

export function findItem(plan: Plan, ref: string | undefined, phaseRef?: string): { phase: Phase; item: Item } | undefined {
  if (!ref) return undefined
  const r = ref.trim()
  const phases = phaseRef ? [findPhase(plan, phaseRef)].filter((p): p is Phase => !!p) : plan.phases
  for (const phase of phases) {
    const item = phase.items.find(i => i.id === r) ?? phase.items.find(i => i.title === r)
    if (item) return { phase, item }
  }
  return undefined
}

export type ItemChange = { status: ItemStatus; reason?: string; exception?: string; meetsCriteria?: boolean; doneAt?: number; milestone?: number }

/**
 * Applies a status change; going back (or out of void) needs a reason; done needs the criteria met.
 * `doneAt` backfills the completion time (never later than now); the result says it was a backfill so
 * the change log is not read as "just finished". `milestone` is how many stations the item passed:
 * moving back needs a reason too, and done implies all of them.
 */
export function changeItem(plan: Plan, phaseRef: string | undefined, itemRef: string, ch: ItemChange, now: number):
  { plan: Plan; detail: string; isRevert: boolean; isBackfill: boolean; phaseId: string; itemId: string } | { error: string } {
  const hit = findItem(plan, itemRef, phaseRef)
  if (!hit) return { error: tr('model.m024', { p0: itemRef }) }
  const { phase, item } = hit
  const from = item.status
  const to = ch.status
  const ms = plan.milestones ?? []
  const curM = item.milestone ?? 0
  const wantM = ch.milestone
  if (wantM !== undefined) {
    if (ms.length === 0) return { error: tr('model.m025', { p0: plan.id }) }
    if (!Number.isInteger(wantM) || wantM < 0 || wantM > ms.length) return { error: tr('model.m026', { p0: ms.length, p1: item.title, p2: curM }) }
    if (to === 'done' && wantM < ms.length) return { error: tr('model.m027') }
  }
  if (from === to && ch.exception === undefined && (wantM === undefined || wantM === curM)) return { error: tr('model.m028', { p0: item.title }) }
  const reason = ch.reason?.trim()
  const isRevert = from === 'void' ? to !== 'void' : to !== 'void' && RANK[to] < RANK[from]
  const isMilestoneBack = wantM !== undefined && wantM < curM
  if (isRevert && !reason) return { error: tr('model.m029', { p0: item.title, p1: from, p2: to }) }
  if (isMilestoneBack && !reason) return { error: tr('model.m030', { p0: item.title, p1: curM, p2: wantM }) }
  if (to === 'void' && !reason) return { error: tr('model.m031') }
  if (to === 'done' && ch.meetsCriteria !== true) return { error: tr('model.m032', { p0: plan.criteria }) }
  const doneAt = ch.doneAt
  if (doneAt !== undefined) {
    if (to !== 'done') return { error: tr('model.m033') }
    if (!Number.isFinite(doneAt) || doneAt > now) return { error: tr('model.m034') }
  }
  // done implies every station; reopening restores the last known pre-done count (legacy: zero).
  const nextM = ms.length === 0 ? undefined : to === 'done' ? ms.length : wantM ?? (from === 'done' ? Math.min(item.milestoneBeforeDone ?? 0, ms.length) : item.milestone)
  const next: Item = {
    ...item, status: to, updatedAt: now,
    ...(reason ? { reason } : {}),
    ...(to === 'done' ? { doneAt: doneAt ?? now } : {}),
    ...(to === 'done' && from !== 'done' ? { milestoneBeforeDone: curM } : {}),
    ...(nextM !== undefined ? { milestone: nextM } : {}),
  }
  if (ch.exception !== undefined) {
    if (ch.exception.trim()) next.exception = ch.exception.trim()
    else delete next.exception
  }
  const phases = plan.phases.map(p => (p.id === phase.id ? { ...p, items: p.items.map(i => (i.id === item.id ? next : i)) } : p))
  const reverts = (isRevert || isMilestoneBack) && reason ? [...plan.reverts, { item: item.title, reason, at: now }].slice(-20) : plan.reverts
  const voided = to === 'void' ? plan.voided + 1 : plan.voided
  let out: Plan = { ...plan, phases, reverts, voided }
  out = deriveStatus(out)
  const mNote = ms.length > 0 && (wantM !== undefined || to === 'done') ? tr('model.m035', { p0: nextM ?? 0, p1: ms.length, p2: nextM !== undefined && nextM < ms.length ? tr('model.m036', { p0: ms[nextM] }) : '' }) : ''
  return {
    plan: out, detail: `${phase.name} › ${item.title}: ${from} → ${to}${next.exception ? tr('model.m037', { p0: next.exception }) : ''}${mNote}`,
    isRevert, isBackfill: doneAt !== undefined, phaseId: phase.id, itemId: item.id,
  }
}

export function addItems(plan: Plan, phaseRef: string, titles: string[], now: number): { plan: Plan; detail: string } | { error: string } {
  const phase = findPhase(plan, phaseRef)
  if (!phase) return { error: tr('model.m038', { p0: phaseRef }) }
  if (phase.isVoid) return { error: tr('model.m039', { p0: phase.name }) }
  const n = phase.items.reduce((m, i) => Math.max(m, Number(i.id.split('-').pop()) || 0), 0)
  const items = makeItems(phase.id, titles, now, n + 1)
  if (items.length === 0) return { error: tr('model.m040') }
  const phases = plan.phases.map(p => (p.id === phase.id ? { ...p, items: [...p.items, ...items] } : p))
  const out = deriveStatus({ ...plan, phases, added: plan.added + items.length })
  return { plan: out, detail: tr('model.addedItems', { phase: phase.name, count: items.length, items: displayList(items.map(i => i.title)) }) }
}

export type PhaseOp =
  | { op: 'insert'; after?: string; name: string; repo?: string; items?: string[] }
  | { op: 'split'; phase: string; into: PhaseSpec[] }
  | { op: 'void'; phase: string }

/** Inserts, splits or voids a phase; answers the undo that reverses it. */
export function changePhases(plan: Plan, op: PhaseOp, reason: string, now: number):
  { plan: Plan; detail: string; undo: Undo } | { error: string } {
  if (!reason.trim()) return { error: tr('model.m041') }
  let seq = plan.seq
  const mk = (s: PhaseSpec): Phase => {
    const id = `p${++seq}`
    return { id, name: s.name.trim(), ...((s.isRelease || isRelease(s.name.trim())) ? { isRelease: true } : {}), ...(s.repo ? { repo: s.repo } : {}), addedAt: now, reason, items: makeItems(id, s.items, now) }
  }
  if (op.op === 'insert') {
    let at = plan.phases.length
    if (op.after) {
      const i = plan.phases.findIndex(p => p.id === op.after || p.name === op.after)
      if (i < 0) return { error: tr('model.m042', { p0: op.after }) }
      at = i + 1
    } else {
      const rel = plan.phases.findIndex(p => p.isRelease || isRelease(p.name))
      if (rel >= 0) at = rel
    }
    const ph = mk({ name: op.name, ...(op.repo ? { repo: op.repo } : {}), ...(op.items ? { items: op.items } : {}) })
    const phases = [...plan.phases.slice(0, at), ph, ...plan.phases.slice(at)]
    return { plan: deriveStatus({ ...plan, phases, seq, added: plan.added + 1 }), detail: tr('model.m043', { p0: ph.name }), undo: { kind: 'phases', removeIds: [ph.id], restore: [], expect: [ph] } }
  }
  const idx = plan.phases.findIndex(p => p.id === op.phase || p.name === op.phase)
  const old = plan.phases[idx]
  if (idx < 0 || !old) return { error: tr('model.m044', { p0: op.phase }) }
  if (op.op === 'void') {
    if (old.isVoid) return { error: tr('model.m045', { p0: old.name }) }
    const voidedPhase: Phase = { ...old, isVoid: true, voidReason: reason }
    const phases = plan.phases.map((p, i) => (i === idx ? voidedPhase : p))
    const out = deriveStatus({ ...plan, phases, voided: plan.voided + 1 })
    return { plan: out, detail: tr('model.m046', { p0: old.name }), undo: { kind: 'phases', removeIds: [], restore: [{ index: idx, phase: old }], expect: [voidedPhase] } }
  }
  if (op.into.length < 2) return { error: tr('model.m047') }
  const fresh = op.into.map(mk)
  const phases = [...plan.phases.slice(0, idx), ...fresh, ...plan.phases.slice(idx + 1)]
  return {
    plan: deriveStatus({ ...plan, phases, seq, added: plan.added + fresh.length }),
    detail: tr('model.m048', { p0: old.name, p1: displayList(fresh.map(f => tr('model.quoted', { text: f.name }))) }),
    undo: { kind: 'phases', removeIds: fresh.map(f => f.id), restore: [{ index: idx, phase: old }], expect: fresh },
  }
}

/**
 * Reverses a reviewed change. A phase change is reversed only while the phases it touched are exactly as the
 * change left them; when another edit changed them since, it answers a conflict and changes nothing.
 */
export function applyUndo(plan: Plan, review: Review): Plan | { conflict: string } {
  const rest = plan.reviews.filter(r => r.id !== review.id)
  const u = review.undo
  if (u.kind === 'plan-draft') {
    // Back to draft keeps every phase and item as they are now; nothing later is lost.
    const { approval: _a, ...base } = plan
    return { ...base, status: 'draft', reviews: rest }
  }
  if (!u.expect) return { conflict: tr('model.m049') }
  for (const e of u.expect) {
    const cur = plan.phases.find(p => p.id === e.id)
    if (!cur) return { conflict: tr('model.m050', { p0: e.name }) }
    if (JSON.stringify(cur) !== JSON.stringify(e)) return { conflict: tr('model.m051', { p0: e.name }) }
  }
  let phases = plan.phases.filter(p => !u.removeIds.includes(p.id))
  for (const r of [...u.restore].sort((a, b) => a.index - b.index)) {
    const i = phases.findIndex(p => p.id === r.phase.id)
    if (i >= 0) phases[i] = r.phase
    else phases = [...phases.slice(0, r.index), r.phase, ...phases.slice(r.index)]
  }
  return deriveStatus({ ...plan, phases, reviews: rest })
}

export function renderPlanMd(plan: Plan): string {
  const p = progress(plan)
  const lines = [
    `# ${plan.title}`,
    '',
    tr('model.m052', { p0: plan.id }),
    tr('model.m053', { p0: plan.status }),
    tr('model.m054', { p0: plan.goal }),
    tr('model.m055', { p0: plan.criteria }),
    tr('model.m056', { p0: p.done, p1: p.planned, p2: p.wrapping, p3: p.unplannedPhases ? tr('model.m057', { p0: p.unplannedPhases }) : '' }),
    tr('model.m058', { p0: describeApproval(plan.approval) }),
    ...(plan.repos.length ? [tr('model.m059', { p0: displayList(plan.repos) })] : []),
    '',
    tr('model.m060'),
    '',
  ]
  const mark: Record<ItemStatus, string> = { todo: '[ ]', wrapping: '[~]', done: '[x]', void: '[-]' }
  for (const ph of plan.phases) {
    const st = phaseState(ph)
    lines.push(`## ${tr('model.phaseHeading', { name: ph.name, repo: ph.repo ? tr('model.phaseRepo', { repo: ph.repo }) : '', state: st === 'void' ? tr('model.m061', { p0: ph.voidReason ?? '' }) : st === 'cleared' ? tr('model.m062') : st === 'unplanned' ? tr('model.m063') : '' })}`)
    for (const it of ph.items) lines.push(`- ${mark[it.status]} ${it.title}${it.exception ? tr('model.m064', { p0: it.exception }) : ''}${it.reason ? ` — ${it.reason}` : ''}`)
    lines.push('')
  }
  if (plan.reviews.length) {
    lines.push(tr('model.m065'), '')
    for (const r of plan.reviews) lines.push(tr('model.m066', { p0: mmddhhmm(r.at), p1: r.summary, p2: r.reason }))
  }
  return lines.join('\n') + '\n'
}

// ---- sessions and "waiting on you" -----------------------------------------

/** A phase can be numbered by its id or by its name after inserts and splits. */
export function phaseNumbersOf(p: Pick<Phase, 'id' | 'name'>): number[] {
  return [...new Set([/^p(\d+)$/.exec(p.id), /(\d+)/.exec(p.name)].flatMap(m => m ? [Number(m[1])] : []))]
}

/** Claim only a unique live target; a description's matches take precedence over its prompt's. */
export function dispatchItemOf(text: string, plans: readonly Plan[], attributed: readonly string[], description = ''): { plan: string; phase?: string; item?: string } | undefined {
  const mine = plans.filter(p => p.status === 'active' && attributed.includes(p.id))
  type Target = { plan: string; phase: string; item?: string }
  const matches = (input: string): Target[] => {
    const ids: Target[] = [], phases: Target[] = [], titles: Target[] = []
    for (const p of mine) {
      for (const ph of p.phases) {
        if (ph.isVoid) continue
        const live = ph.items.filter(it => it.status !== 'done' && it.status !== 'void')
        if (live.length && (input.includes(`${p.id} › ${ph.name}`) || input.includes(`${p.id} > ${ph.name}`))) phases.push({ plan: p.id, phase: ph.id })
        for (const it of live) {
          const target = { plan: p.id, phase: ph.id, item: it.id }
          if (mentionsExactly(input, it.id)) ids.push(target)
          if (strWidth(it.title.trim()) >= 6 && input.includes(it.title)) titles.push(target)
        }
      }
    }
    return ids.length ? ids : phases.length ? phases : titles
  }
  const described = matches(description)
  const candidates = described.length ? described : matches(text)
  return candidates.length === 1 ? candidates[0] : undefined
}

export function sessionName(s: Pick<SessionRec, 'goal' | 'title' | 'firstMessage' | 'cwd'>): string {
  const title = s.title?.replace(/^\s*\[?(dispatch|\u6d3e\u6d3b|\u4efb\u52a1)[\]:：\s-]*/i, '').trim()
  return s.goal?.trim() || title || s.firstMessage?.trim() || s.cwd.split('/').filter(Boolean).pop() || tr('model.m067')
}

/** A session worth showing has a goal, a claim, steps or background work. */
export function isVisible(s: SessionRec): boolean {
  return !!s.goal || s.claims.length > 0 || s.steps.length > 0 || s.bg.some(b => b.endedAt === undefined)
}

export const isAskId = (value: string): boolean => /^q\d+$/.test(value)

/** Legacy ids are session-local; text answers are shared for the retained session lifetime. */
export function answeredQuestions(sessions: readonly SessionRec[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of sessions) {
    for (const raw of s.answered ?? []) {
      if (!isAskId(raw) && !out.has(normQuestion(raw))) out.set(normQuestion(raw), Number.NEGATIVE_INFINITY)
    }
    for (const a of s.answerLog ?? []) {
      const key = normQuestion(a.question)
      out.set(key, Math.max(out.get(key) ?? Number.NEGATIVE_INFINITY, a.at))
    }
  }
  return out
}

export function isAskAnswered(s: SessionRec, a: Ask, texts: ReadonlyMap<string, number>): boolean {
  const key = normQuestion(a.question)
  return (s.answered ?? []).includes(a.id)
    || (texts.has(key) && (a.reopenedAt === undefined || (texts.get(key) as number) >= a.reopenedAt))
}

/** New text answers carry time; ids never enter the shared text namespace. */
export function recordAnswers(s: SessionRec, answers: readonly string[], at: number, textOnly = false): void {
  const ids = textOnly ? [] : answers.filter(isAskId)
  const texts = textOnly ? answers : answers.filter(a => !isAskId(a))
  if (ids.length) s.answered = [...(s.answered ?? []), ...ids].slice(-50)
  if (texts.length) s.answerLog = [...(s.answerLog ?? []), ...texts.map(question => ({ question: normQuestion(question), at }))].slice(-50)
}

export function waitingItems(plans: readonly Plan[], sessions: readonly SessionView[]): WaitingItem[] {
  const out: WaitingItem[] = []
  for (const p of plans) {
    if (p.status === 'draft') out.push({ kind: 'draft', plan: p.id, phases: p.phases.filter(ph => !ph.isVoid).length })
    if (p.reviews.length > 0 && p.status !== 'abandoned') out.push({ kind: 'review', plan: p.id, count: p.reviews.length, first: p.reviews[0]?.summary ?? '' })
  }
  for (const s of sessions) {
    if (s.question && s.endedAt === undefined && s.isAlive) out.push({ kind: 'question', session: s.id, name: sessionName(s), since: s.question.since })
  }
  // Only live sessions ask, but retained ended sessions still supply their answers.
  const live = sessions.filter(s => s.isAlive && s.endedAt === undefined)
  const answeredText = answeredQuestions(sessions)
  const openText = new Set(live.flatMap(s => s.question ? [normQuestion(s.question.text)] : []))
  const groups = new Map<string, { id: string; question: string; options?: string[]; at: number; name: string; session: string }[]>()
  for (const s of live) {
    for (const a of s.asks ?? []) {
      const key = normQuestion(a.question)
      if (!key || isAskAnswered(s, a, answeredText) || openText.has(key)) continue
      const list = groups.get(key) ?? []
      list.push({ id: a.id, question: a.question, ...(a.options?.length ? { options: a.options } : {}), at: a.at, name: sessionName(s), session: s.id })
      groups.set(key, list)
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.at - b.at)
    const first = list[0]
    if (!first) continue
    out.push({ kind: 'ask', id: first.id, question: first.question, ...(first.options ? { options: first.options } : {}), session: first.session, name: first.name, at: first.at, also: list.length - 1 })
  }
  // Decisions taken on the person's behalf while they were away need their review until the card is dismissed.
  const me = sessions.find(s => s.isSelf)
  const win = me?.away && me.away.dismissedAt === undefined ? me.away : undefined
  if (win) {
    for (const s of sessions) {
      for (const d of s.decided ?? []) {
        if (d.at < win.from || d.at > win.to) continue
        out.push({ kind: 'decision', session: s.id, name: sessionName(s), text: d.text, reversible: d.reversible, ...(d.undo ? { undo: d.undo } : {}), at: d.at })
      }
    }
  }
  return out
}

/* Progress tracking invariant. */
export function awayDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(m / 60)
  return h > 0 ? tr('model.m068', { p0: h, p1: m % 60 }) : tr('model.m069', { p0: m })
}

/**
 * What happened while the person was away, for the window frozen when they came back: the items that
 * became done (by their real completion time), the steps sessions ticked done, and the decisions the
 * models took on the person's behalf. Null when there is no window or the person dismissed its card.
 */
export function awayReportOf(self: SessionView | SessionRec, plans: readonly Plan[], sessions: readonly SessionRec[], focusPlan?: string): AwayReport | null {
  const w = self.away
  if (!w || w.dismissedAt !== undefined) return null
  const isIn = (at: number) => at >= w.from && at <= w.to
  const items: AwayReport['items'] = []
  const focused = new Set([focusPlan, self.lastPlan, self.envPlan, self.taskPlan, ...self.claims.map(c => c.plan),
    ...('attribution' in self ? self.attribution.confident.map(c => c.plan) : [])].filter((id): id is string => !!id))
  for (const p of plans) {
    if ((p.status !== 'active' && p.status !== 'done') || !focused.has(p.id)) continue
    for (const ph of p.phases) {
      for (const it of ph.items) {
        if (it.status === 'done' && it.doneAt !== undefined && isIn(it.doneAt)) {
          items.push({ plan: p.id, planTitle: p.title, phase: ph.name, item: it.title, at: it.doneAt })
        }
      }
    }
  }
  items.sort((a, b) => a.at - b.at)
  const steps: AwayReport['steps'] = []
  const decisions: AwayReport['decisions'] = []
  for (const s of sessions) {
    const titles = (s.stepLog ?? []).filter(x => isIn(x.at)).map(x => x.title)
    if (titles.length) steps.push({ session: s.id, name: sessionName(s), titles })
    for (const d of s.decided ?? []) {
      if (!isIn(d.at)) continue
      decisions.push({ session: s.id, name: sessionName(s), text: d.text, reversible: d.reversible, ...(d.undo ? { undo: d.undo } : {}), at: d.at })
    }
  }
  decisions.sort((a, b) => a.at - b.at)
  return { from: w.from, to: w.to, items, steps, decisions }
}

export function newReview(id: string, now: number, summary: string, reason: string, by: string, approval: Approval, isAway: boolean, undo: Undo): Review {
  return { id, at: now, summary, reason, by, ...(approval.relayedBy ? { relayedBy: approval.relayedBy } : {}), ...(isAway ? { isAway } : {}), undo }
}

/**
 * A directory's plans plus, for each finished or abandoned one, the active plans sharing its project prefix
 * (`acme/` of `acme/v1`), newest first: a milestone's successor shows where its predecessor was used, even
 * when it was proposed with other repos.
 */
export function withSuccessors(ids: readonly string[], plans: readonly Pick<Plan, 'id' | 'status' | 'createdAt'>[]): string[] {
  const byId = new Map(plans.map(p => [p.id, p]))
  const prefixes = new Set(ids.map(id => byId.get(id)).filter(p => p && (p.status === 'done' || p.status === 'abandoned') && p.id.includes('/'))
    .map(p => p!.id.slice(0, p!.id.indexOf('/') + 1)))
  const next = plans.filter(p => p.status === 'active' && [...prefixes].some(pre => p.id.startsWith(pre))).sort((a, b) => b.createdAt - a.createdAt).map(p => p.id)
  return [...new Set([...ids, ...next])]
}

/** Claims that still count: on plans that are active (ended plans release their claims). */
export function liveClaims(claims: readonly Claim[], plans: readonly Pick<Plan, 'id' | 'status'>[]): Claim[] {
  const active = new Set(plans.filter(p => p.status === 'active').map(p => p.id))
  return claims.filter(c => active.has(c.plan))
}

/**
 * Claims that still describe work in hand: a claim on an item that is done or void is stale —
 * whoever held it is finished with it, or the item is gone — so drawing ignores it.
 */
export function liveItemClaims(claims: readonly Claim[], plans: readonly Pick<Plan, 'id' | 'phases' | 'status'>[]): Claim[] {
  const over = new Set<string>()
  for (const p of plans) for (const ph of p.phases) for (const it of ph.items) if (it.status === 'done' || it.status === 'void') over.add(`${p.id}\u0000${it.id}`)
  return claims.filter(c => !c.item || !over.has(`${c.plan}\u0000${c.item}`))
}

export const RETAIN_MS = 7 * 24 * 3600_000

/**
 * What cleanup does with another session's record: `gone` when its process is confirmed dead and no end
 * was recorded (the end time becomes now, so retention counts from the death, not the last activity);
 * `delete` seven days after the recorded end; else `keep` (alive, or liveness unknown).
 */
export function sessionFate(rec: Pick<SessionRec, 'endedAt'>, isAlive: boolean | undefined, now: number): 'keep' | 'gone' | 'delete' {
  if (rec.endedAt !== undefined) return now - rec.endedAt > RETAIN_MS ? 'delete' : 'keep'
  return isAlive === false ? 'gone' : 'keep'
}

/** Abandons a draft the person rejected, keeping why (a default when none was given). */
export function rejectDraft(cur: Plan | null, reason: string, via: 'panel' | 'command', by: string):
  { plan: Plan; log: Omit<LogEntry, 'at' | 'plan'>[]; md: string } | { error: string } {
  if (!cur || cur.status !== 'draft') return { error: tr('model.m070', { p0: cur?.id ?? tr('model.m071') }) }
  const why = reason.trim() || (via === 'panel' ? tr('model.m072') : tr('model.m073'))
  const plan: Plan = { ...cur, status: 'abandoned', endReason: why }
  return { plan, log: [{ by, action: 'reject', detail: tr('model.m074'), reason: why }], md: renderPlanMd(plan) }
}

/** What decides whether the drawn state changes: content, plus the minute (relative times and durations). */
export function publishKey(snap: Snapshot | null): string {
  if (!snap) return 'null'
  const { now, ...rest } = snap
  return `${Math.floor(now / 60_000)}|${JSON.stringify(rest)}`
}
