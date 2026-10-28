// Automatic attribution of a session to plans, layered by confidence.
// Confident: 1 env plan or a plan the task names explicitly, 2 lineage (recursive), 3 own claim, 4 worktree name.
// Speculative: 5 exact mention in the first message, 4 repo index. Only active plans take part.

import type { Attribution, Claim, ClaimSource, Plan, SessionRec } from '../types'
import { phaseNumbersOf } from './model'
import { PLAN_ID, mentionsExactly } from './util'

export type AttribInput = {
  envPlan?: string
  /** A plan the task names in an explicit field (`Plan: x/y`); beats the parent's. */
  taskPlan?: string
  /** The parent's effective confident plans (env parent or the /clear chain), when known. */
  parentPlans?: readonly string[]
  ownClaims: readonly string[]
  repoCandidates: readonly string[]
  firstMessage?: string
  activePlans: ReadonlySet<string>
  /** Review sessions only inherit: no content-based (mention / repo) candidates. */
  isReviewer?: boolean
  /** The session's start directory: a worktree name may carry a plan version and a phase number. */
  cwd?: string
  /** The live plans, for the worktree-name rule (only active ones take part). */
  plans?: readonly Plan[]
}

/**
 * The plan and phase a worktree name numbers (`agent-v143-p17` for plan `x/v1.43`, phase 17).
 * Both tokens are required, so an ordinary directory name almost never matches.
 */
export function worktreePhaseOf(cwd: string, plans: readonly Plan[]): { plan: string; phase: string } | undefined {
  const base = cwd.replace(/\/+$/, '').split('/').pop() ?? ''
  if (!base) return undefined
  const tokens = base.toLowerCase().split(/[-_.]+/)
  const numbers = new Set(tokens.flatMap(t => /^p\d+$/.test(t) ? [Number(t.slice(1))] : []))
  const matches: { plan: string; phase: string }[] = []
  for (const p of plans) {
    if (p.status !== 'active') continue
    const version = (p.id.split('/').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    if (version.length < 2 || !tokens.includes(version)) continue
    for (const ph of p.phases) {
      if (!ph.isVoid && phaseNumbersOf(ph).some(n => numbers.has(n))) matches.push({ plan: p.id, phase: ph.id })
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}

export function attribute(a: AttribInput): Attribution {
  const confident: { plan: string; source: ClaimSource; phase?: string }[] = []
  const has = (p: string) => confident.some(c => c.plan === p)
  if (a.envPlan && a.activePlans.has(a.envPlan)) confident.push({ plan: a.envPlan, source: 'env' })
  else if (a.taskPlan && a.activePlans.has(a.taskPlan)) confident.push({ plan: a.taskPlan, source: 'task' })
  // Lineage: only when the child names no plan of its own and the parent has exactly one active plan.
  if (confident.length === 0 && a.parentPlans) {
    const live = [...new Set(a.parentPlans.filter(p => a.activePlans.has(p)))]
    if (live.length === 1 && live[0]) confident.push({ plan: live[0], source: 'lineage' })
  }
  for (const p of a.ownClaims) if (a.activePlans.has(p) && !has(p)) confident.push({ plan: p, source: 'claim' })
  // A worktree name carries both the plan's version and a phase number: strong enough to be confident.
  if (a.cwd && a.plans?.length) {
    const hit = worktreePhaseOf(a.cwd, a.plans.filter(p => a.activePlans.has(p.id)))
    if (hit && !has(hit.plan)) confident.push({ plan: hit.plan, source: 'worktree', phase: hit.phase })
  }

  const speculative: { plan: string; source: ClaimSource }[] = []
  if (a.isReviewer) return { confident, speculative }
  const spec = (p: string) => confident.some(c => c.plan === p) || speculative.some(c => c.plan === p)
  if (a.firstMessage) {
    for (const p of a.activePlans) if (!spec(p) && mentionsExactly(a.firstMessage, p)) speculative.push({ plan: p, source: 'mention' })
  }
  for (const p of a.repoCandidates) if (a.activePlans.has(p) && !spec(p)) speculative.push({ plan: p, source: 'repo' })
  return { confident, speculative }
}

/** Plans that take part in attribution, inheritance and claims: active ones only (drafts have no effect yet). */
export function activePlanIds(plans: readonly Pick<Plan, 'id' | 'status'>[]): Set<string> {
  return new Set(plans.filter(p => p.status === 'active').map(p => p.id))
}

/* Progress tracking invariant. */
export function taskPlanOf(text: string): string | undefined {
  const m = /^\s*(?:[-*>]\s*)?(?:\*\*)?(?:plan|\u8ba1\u5212|PROGRESS_BOARD_PLAN)(?:\*\*)?\s*[:：=]\s*`?([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+?)`?[。.,，;；]?\s*$/im.exec(text)
  const id = m?.[1]
  return id && PLAN_ID.test(id) ? id : undefined
}

/** Review-type sessions only inherit their plan. */
export function isReviewer(s: Pick<SessionRec, 'role'>): boolean {
  return !!s.role && /\u5ba1\u67e5|\u8bc4\u5ba1|review/i.test(s.role)
}

/**
 * Every session's attribution, lineage resolved through the parent chain: a parent's effective confident
 * plans (from its env, its task, its own parent or its claims) pass down when there is exactly one.
 * A cycle in the parent links passes nothing.
 */
export function resolveAttributions(recs: readonly SessionRec[], activePlans: ReadonlySet<string>, repoCandidates: (r: SessionRec) => readonly string[], plans: readonly Plan[] = []): Map<string, Attribution> {
  const byId = new Map(recs.map(r => [r.id, r]))
  const out = new Map<string, Attribution>()
  const visiting = new Set<string>()
  const of = (r: SessionRec): Attribution => {
    const hit = out.get(r.id)
    if (hit) return hit
    if (visiting.has(r.id)) return { confident: [], speculative: [] }
    visiting.add(r.id)
    const parent = r.parent ? byId.get(r.parent) : undefined
    const parentPlans = parent ? [...new Set(of(parent).confident.map(c => c.plan))] : undefined
    visiting.delete(r.id)
    const a = attribute({
      ...(r.envPlan ? { envPlan: r.envPlan } : {}),
      ...(r.taskPlan ? { taskPlan: r.taskPlan } : {}),
      ...(parentPlans ? { parentPlans } : {}),
      ownClaims: claimedPlans(r),
      repoCandidates: repoCandidates(r),
      ...(r.firstMessage ? { firstMessage: r.firstMessage } : {}),
      activePlans,
      isReviewer: isReviewer(r),
      cwd: r.cwd,
      plans,
    })
    out.set(r.id, a)
    return a
  }
  for (const r of recs) of(r)
  return out
}

/** The plan a session exports to what it starts: only an unambiguous one. */
export function exportPlanOf(a: Attribution): string | undefined {
  const plans = [...new Set(a.confident.map(c => c.plan))]
  return plans.length === 1 ? plans[0] : undefined
}

/** What a session started after /clear (or a dispatched child) inherits: goal and claims on still-active plans. */
export function inheritFrom(prev: Pick<SessionRec, 'goal' | 'claims'>, activePlans: ReadonlySet<string>, now: number):
  { goal?: string; claims: Claim[] } {
  const claims = prev.claims.filter(c => activePlans.has(c.plan)).map(c => ({ ...c, at: now, source: 'lineage' as const }))
  return { ...(prev.goal ? { goal: prev.goal } : {}), claims }
}

export function claimedPlans(s: Pick<SessionRec, 'claims'>): string[] {
  return [...new Set(s.claims.map(c => c.plan))]
}
