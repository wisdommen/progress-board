import { t as tr } from './i18n'
import type { EngineInterface } from 'claude-code'
import type { ItemRefs, LogEntry, Plan, RefCheck, SessionRec, SessionView } from '../types'
import { changeItem, renderPlanMd } from './model'
import { mutatePlan, parseJson, readPlan, withLock } from './store'
import type { Io, Paths } from './store'

export const CHECK_MS = 5 * 60_000
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const branchOk = (s: string) => !!s && s.length <= 250 && !s.startsWith('-') && !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(s)
  && !s.includes('..') && !s.includes('@{') && !s.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'))
const prOk = (x: { number: number; repo?: string }) => x && Number.isSafeInteger(x.number) && x.number > 0
  && (x.repo === undefined || (typeof x.repo === 'string' && REPO.test(x.repo) && !x.repo.startsWith('-')))
const belongs = (s: SessionView, id: string) => s.isAlive && s.endedAt === undefined
  && (s.claims.some(c => c.plan === id) || s.attribution.confident.some(a => a.plan === id))

export function parseRefs(raw: unknown): { refs: ItemRefs } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: tr('facts.m001') }
  const r = raw as Record<string, unknown>
  if (Object.keys(r).some(k => k !== 'pr' && k !== 'branch')) return { error: tr('facts.m002') }
  const refs: ItemRefs = {}
  if (r['pr'] !== undefined) {
    if (!Array.isArray(r['pr'])) return { error: tr('facts.m003') }
    refs.pr = []
    for (const x of r['pr']) {
      if (!prOk(x)) return { error: tr('facts.m004') }
      refs.pr.push({ number: x.number, ...(x.repo ? { repo: x.repo } : {}) })
    }
  }
  if (r['branch'] !== undefined) {
    if (!Array.isArray(r['branch']) || r['branch'].some(x => typeof x !== 'string' || !branchOk(x))) return { error: tr('facts.m005') }
    refs.branch = r['branch'] as string[]
  }
  return { refs }
}

export function mergeRefs(old: ItemRefs | undefined, fresh: ItemRefs): ItemRefs {
  const pr = [...new Map([...(old?.pr ?? []), ...(fresh.pr ?? [])].map(r => [JSON.stringify([r.repo ?? '', r.number]), r])).values()]
  const branch = [...new Set([...(old?.branch ?? []), ...(fresh.branch ?? [])])]
  return { ...(pr.length ? { pr } : {}), ...(branch.length ? { branch } : {}) }
}

export async function attachCreatedPr(io: Io, paths: Paths, s: SessionRec, text: string): Promise<string | undefined> {
  const urls = [...text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\b/g)]
  if (!urls.length) return undefined
  const claims = [...new Map(s.claims.filter(c => c.item).map(c => [`${c.plan}\0${c.item}`, c])).values()]
  const live = []
  for (const c of claims) {
    const p = await readPlan(io, paths, c.plan)
    if (p?.status === 'active' && p.phases.some(ph => !ph.isVoid && ph.items.some(i => i.id === c.item && i.status !== 'done' && i.status !== 'void'))) live.push(c)
  }
  if (live.length !== 1) return live.length > 1 ? tr('facts.m006') : undefined
  const unique = [...new Set(urls.map(m => m[0]))]
  if (unique.length !== 1) return tr('facts.m007')
  const c = live[0]!, url = urls[0]!
  const pr = { repo: url[1]!, number: Number(url[2]) }
  const parsed = parseRefs({ pr: [pr] })
  if ('error' in parsed) return undefined
  await mutatePlan(io, paths, c.plan, (p, at) => {
    if (!p || p.status !== 'active') return { error: tr('facts.m008') }
    const phases = p.phases.map(ph => ({ ...ph, items: ph.items.map(i => i.id === c.item && i.status !== 'done' && i.status !== 'void' ? { ...i, refs: mergeRefs(i.refs, parsed.refs), updatedAt: at } : i) }))
    const out = { ...p, phases }
    return { plan: out, log: [{ by: s.id, action: 'refs', detail: tr('facts.m009', { p0: c.item, p1: pr.repo, p2: pr.number }) }], md: renderPlanMd(out) }
  })
  return undefined
}

type Target = { key: string; kind: 'pr' | 'branch'; number?: number; repo?: string; branch?: string; addedAt?: number; cwd?: string; items: string[] }
function targetsOf(p: Plan, sessions: readonly SessionView[]): Target[] {
  const roots = [...new Set(sessions.filter(s => belongs(s, p.id)).flatMap(s => s.repoRoot ? [s.repoRoot.replace(/\/+$/, '')] : []))]
  const all = new Map<string, Target>()
  for (const ph of p.phases) for (const i of ph.items) {
    if (ph.isVoid || i.status === 'done' || i.status === 'void' || !i.refs) continue
    const declared = (ph.repo ? [ph.repo] : p.repos).map(r => r.replace(/\/+$/, ''))
    const root = declared.length === 1 && roots.includes(declared[0]!) ? declared[0] : undefined
    for (const ref of i.refs.pr ?? []) {
      if (!prOk(ref) || (!ref.repo && !root)) continue
      const key = JSON.stringify(['pr', ref.repo ?? root, ref.number])
      const t = all.get(key) ?? { key, kind: 'pr' as const, ...ref, ...(root ? { cwd: root } : {}), items: [] }
      t.items.push(i.id); all.set(key, t)
    }
    if (root) for (const branch of i.refs.branch ?? []) {
      if (typeof branch !== 'string' || !branchOk(branch)) continue
      const addedAt = i.branchAddedAt?.[branch]
      const key = JSON.stringify(['branch', root, branch, addedAt ?? null])
      const t = all.get(key) ?? { key, kind: 'branch' as const, branch, addedAt, cwd: root, items: [] }
      t.items.push(i.id); all.set(key, t)
    }
  }
  return [...all.values()]
}

async function fetchFact($: EngineInterface, t: Target): Promise<RefCheck['state']> {
  const run = (argv: string[]) => $.process.run(argv, { ...(t.cwd ? { cwd: t.cwd } : {}), timeoutMs: 8000 }).catch(() => null)
  if (t.kind === 'pr') {
    const r = await run(['gh', 'pr', 'view', String(t.number), ...(t.repo ? ['--repo', t.repo] : []), '--json', 'state,mergedAt,isDraft'])
    if (!r || r.exitCode !== 0) return 'unknown'
    const o = parseJson<{ state?: string; mergedAt?: unknown; isDraft?: boolean }>(r.stdout)
    if (o?.state === 'MERGED') return 'merged'
    if (o?.state === 'OPEN' && typeof o.isDraft === 'boolean') return o.isDraft ? 'draft' : 'open'
    return o?.state === 'CLOSED' ? 'closed' : 'unknown'
  }
  const r = await run(['git', 'ls-remote', '--heads', 'origin', t.branch!])
  const head = r?.exitCode === 0 ? r.stdout.split('\n').map(l => l.trim().split(/\s+/)).find(([sha, ref]) => /^[a-f0-9]{40,64}$/i.test(sha ?? '') && ref === `refs/heads/${t.branch}`)?.[0] : undefined
  const merged = await run(['gh', 'pr', 'list', `--head=${t.branch}`, '--state', 'merged', '--limit', '100', '--json', 'number,mergedAt,headRefOid,headRefName'])
  const prs = merged?.exitCode === 0 ? parseJson<unknown>(merged.stdout) : null
  if (head && typeof t.addedAt === 'number' && Number.isFinite(t.addedAt) && Array.isArray(prs) && prs.some(p => p && typeof p === 'object'
    && Number.isSafeInteger(p.number) && p.number > 0 && p.headRefName === t.branch && p.headRefOid === head
    && typeof p.mergedAt === 'string' && Date.parse(p.mergedAt) > t.addedAt!)) return 'merged'
  return !r || r.exitCode !== 0 ? 'unknown' : head ? 'present' : 'missing'
}

function applyFacts(p: Plan, targets: Target[], checks: Record<string, RefCheck>, at: number, autoDone = p.auto_done_on_merge === true): { plan: Plan; log: Omit<LogEntry, 'at' | 'plan'>[] } {
  let plan = p
  const log: Omit<LogEntry, 'at' | 'plan'>[] = []
  const prStation = (p.milestones ?? []).findIndex(s => /(^|[^A-Za-z])PR([^A-Za-z]|$)|pull request|\u5f00\s?PR|\u63d0\u4ea4\u5ba1\u67e5/i.test(s)) + 1
  const mergeStation = (p.milestones ?? []).findIndex(s => /\u5408\u5e76|merge/i.test(s)) + 1
  for (const hit of p.phases.filter(ph => !ph.isVoid).flatMap(ph => ph.items)) {
    if (hit.status === 'done' || hit.status === 'void') continue
    const linked = targets.filter(t => t.items.includes(hit.id))
    const states = linked.map(t => checks[t.key]?.state)
    const merged = states.includes('merged')
    if (!merged && !states.includes('open')) continue
    const prRefs = hit.refs?.pr ?? []
    const allPrsMerged = prRefs.length === 0 || prRefs.every(ref => linked.some(t => t.kind === 'pr' && t.number === ref.number && t.repo === ref.repo
      && (checks[t.key]?.state === 'merged' || checks[t.key]?.state === 'closed')))
    const done = merged && allPrsMerged && (autoDone || (mergeStation > 0 && mergeStation === plan.milestones?.length))
    const status = done ? 'done' : merged ? 'wrapping' : hit.status
    const station = merged ? Math.max(prStation, mergeStation) : prStation
    const milestone = Math.max(hit.milestone ?? 0, station)
    if (status === hit.status && milestone === (hit.milestone ?? 0)) continue
    const r = changeItem(plan, undefined, hit.id, { status, meetsCriteria: done, ...(plan.milestones?.length ? { milestone: done ? plan.milestones.length : milestone } : {}) }, at)
    if ('error' in r) continue
    plan = r.plan
    log.push({ by: tr('facts.m010'), action: 'set_item', detail: r.detail })
  }
  if (plan.status === 'done' && p.status !== 'done') log.push({ by: tr('facts.m011'), action: 'complete', detail: tr('facts.m012') })
  return { plan, log }
}

const terminal = (check?: RefCheck) => check?.state === 'merged' || check?.state === 'closed'
function pruneChecks(checks: Record<string, RefCheck>, targets: Target[]): Record<string, RefCheck> {
  const keys = new Set(targets.map(t => t.key))
  return Object.fromEntries(Object.entries(checks).filter(([key]) => keys.has(key)))
}

export async function pollFacts($: EngineInterface, io: Io, paths: Paths, id: string, sessions: readonly SessionView[], stopped: () => boolean, globalAutoDone = false): Promise<void> {
  const autoDone = async (plan: Plan): Promise<boolean> => {
    const override = parseJson<{ autoDone?: boolean }>(await io.read(`${paths.planDir(id)}/settings.json`))
    return typeof override?.autoDone === 'boolean' ? override.autoDone : plan.auto_done_on_merge ?? globalAutoDone
  }
  const p = await readPlan(io, paths, id)
  if (p?.status !== 'active' || stopped()) return
  // Progress tracking invariant.
  await mutatePlan(io, paths, id, async (cur, at, guard) => {
    if (!cur || cur.status !== 'active') return cur ? { unchanged: cur } : { error: tr('facts.m013') }
    const targets = targetsOf(cur, sessions)
    const raw = parseJson<Record<string, RefCheck>>(await io.read(paths.checks(id))) ?? {}
    const checks = pruneChecks(raw, targets)
    if (JSON.stringify(raw) !== JSON.stringify(checks)) { await guard(); await io.writeAtomic(paths.checks(id), JSON.stringify(checks)) }
    const out = applyFacts(cur, targets, checks, at, await autoDone(cur))
    return out.log.length ? { ...out, md: renderPlanMd(out.plan) } : { unchanged: cur }
  })
  for (const target of targetsOf(p, sessions)) {
    if (stopped()) return
    const token = Math.random().toString(36).slice(2)
    const reserved = await withLock(io, paths.planDir(id), async guard => {
      const cur = await readPlan(io, paths, id)
      if (!cur || cur.status !== 'active' || !targetsOf(cur, sessions).some(t => t.key === target.key)) return false
      const checks = parseJson<Record<string, RefCheck>>(await io.read(paths.checks(id))) ?? {}
      const at = await io.now()
      const period = sessions.some(s => belongs(s, id) && at - s.lastActivity <= CHECK_MS) ? CHECK_MS : 60 * 60_000
      if (terminal(checks[target.key]) || (checks[target.key] && at - checks[target.key]!.lastCheckedAt < period - 1000)) return false
      checks[target.key] = { lastCheckedAt: at, state: 'pending', token }
      await guard(); await io.writeAtomic(paths.checks(id), JSON.stringify(checks))
      return true
    })
    if (!reserved) continue
    const state = await fetchFact($, target)
    if (stopped()) return
    await mutatePlan(io, paths, id, async (cur, at, guard) => {
      if (!cur) return { error: tr('facts.m014') }
      const checks = parseJson<Record<string, RefCheck>>(await io.read(paths.checks(id))) ?? {}
      const reservation = checks[target.key]
      if (reservation?.token !== token) return { unchanged: cur }
      checks[target.key] = { lastCheckedAt: reservation.lastCheckedAt, state }
      const targets = targetsOf(cur, sessions)
      const retained = pruneChecks(checks, targets)
      await guard(); await io.writeAtomic(paths.checks(id), JSON.stringify(retained))
      if (cur.status !== 'active') return { unchanged: cur }
      const out = applyFacts(cur, targets, retained, at, await autoDone(cur))
      return out.log.length ? { ...out, md: renderPlanMd(out.plan) } : { unchanged: cur }
    })
  }
}
