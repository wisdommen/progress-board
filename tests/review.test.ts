// Regression tests for the 2026-10-27 code review findings.

import { expect, test } from './locale-test'

import type { Plan, SessionRec, SessionView, Snapshot } from '../types'
import { attribute, exportPlanOf, activePlanIds, resolveAttributions, taskPlanOf } from '../hooks/attrib'
import { buildBanner, focusPlanOf, rowText } from '../hooks/banner'
import {
  applyUndo, changeItem, changePhases, isAffirmative, judgeApproval, liveClaims, newPlan, newReview, phaseState, progress,
  questionApprovals, rejectDraft, sessionFate, waitingItems,
} from '../hooks/model'
import { LogTail, Paths, SessionSaver, mutatePlan, readPlan, withLock } from '../hooks/store'
import { parseDecisionArgs } from '../hooks/tools'
import { envFileText, shellQuote } from '../hooks/util'
import { publishKey } from '../hooks/model'
import { MemIo } from './memio'

const NOW = 1_800_000_000_000
const MIN = 60_000
const DAY = 24 * 3600_000

function plan(over: Partial<Plan> = {}): Plan {
  const p = newPlan({
    id: 'acme/v2', title: 'v2 发布', goal: 'g', criteria: 'PR 合并',
    phases: [{ name: 'A', items: ['a1', 'a2'] }, { name: 'B', items: ['b1'] }], includeRelease: false, by: 's1', now: NOW,
  })
  return { ...p, status: 'active', ...over }
}

function session(over: Partial<SessionRec> = {}): SessionRec {
  return {
    v: 1, id: 's1', kind: 'normal', startedAt: NOW, cwd: '/w/acme', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [], ...over,
  }
}

function view(s: SessionRec, over: Partial<SessionView> = {}): SessionView {
  return { ...s, isAlive: true, isSelf: s.id === 's1', cwdMissing: false, attribution: { confident: [], speculative: [] }, ...over }
}

const ok = <T extends object>(r: T | { error: string }): T => {
  if ('error' in r) throw new Error(r.error)
  return r
}
const doneAll = (p: Plan) => {
  let out = p
  for (const ph of p.phases) for (const it of ph.items) out = ok(changeItem(out, undefined, it.id, { status: 'done', meetsCriteria: true }, NOW)).plan
  return out
}

// ---- 1 stale lock ----------------------------------------------------------

/** MemIo whose `mtime(lock)` holds every caller until `release()`: both contenders see the stale lock. */
class GateIo extends MemIo {
  held: (() => void)[] = []
  gate = ''
  reclaims = 0
  /** The second reclaimer waits until the first contender is inside: it then holds a stale observation. */
  firstInside: Promise<void> = Promise.resolve()
  async mkdirExclusive(path: string) {
    if (path.endsWith('.lock.reclaim') && ++this.reclaims === 2) await this.firstInside
    return super.mkdirExclusive(path)
  }
  async mtime(path: string) {
    const m = await super.mtime(path)
    if (this.gate && path.startsWith(this.gate)) await new Promise<void>(r => this.held.push(r))
    return m
  }
}

test('1 two reclaimers of one stale lock never both enter', async () => {
  const io = new GateIo()
  const dir = '/h/p'
  io.dirs.set(`${dir}/.lock`, io.clock - 600_000)
  io.gate = `${dir}/.lock`
  let inside = 0
  let max = 0
  let entered: () => void = () => undefined
  io.firstInside = new Promise<void>(r => { entered = r })
  const run = () => withLock(io, dir, async () => {
    entered()
    inside++
    max = Math.max(max, inside)
    // Stay inside long enough for a wrong reclaim by the other contender to get in.
    for (let i = 0; i < 2000; i++) await Promise.resolve()
    inside--
  }, { timeoutMs: 60_000, staleMs: 30_000 })
  const a = run()
  const b = run()
  for (let i = 0; i < 50 && io.held.length < 2; i++) await Promise.resolve()
  io.gate = ''
  for (const r of io.held.splice(0)) r()
  await Promise.all([a, b])
  expect(max).toBe(1)
})

test('1 an old owner never releases a replacement owner’s lock; a stuck stale lock times out', async () => {
  const io = new MemIo()
  const dir = '/h/q'
  // A slow owner whose lock gets reclaimed: its release must not remove the new owner's lock, and its write is fenced.
  let slowWrote = false
  let fastInside = false
  let letSlowGo: () => void = () => undefined
  const slowWait = new Promise<void>(r => { letSlowGo = r })
  const slow = withLock(io, dir, async guard => {
    await slowWait
    await guard().then(() => { slowWrote = true }, () => undefined)
  }, { staleMs: 30_000, timeoutMs: 600_000 })
  for (let i = 0; i < 50; i++) await Promise.resolve()
  io.clock += 200_000
  const fast = withLock(io, dir, async () => {
    fastInside = true
    letSlowGo()
    await slow
    // The old owner finished meanwhile; our lock must still be there.
    expect(io.dirs.has(`${dir}/.lock`)).toBe(true)
  }, { staleMs: 30_000, timeoutMs: 600_000 })
  await Promise.all([slow, fast])
  expect(fastInside).toBe(true)
  expect(slowWrote).toBe(false)

  const stuck = new MemIo()
  stuck.dirs.set('/h/r/.lock', stuck.clock - 600_000)
  stuck.failRemove.add('/h/r/.lock')
  let err = ''
  await withLock(stuck, '/h/r', async () => 'no', { timeoutMs: 2_000, staleMs: 1_000 }).catch((e: unknown) => { err = String(e) })
  expect(err).toContain('lock busy')
})

// ---- 2 question approvals ---------------------------------------------------

test('2 only an affirmative answer to a question about this plan is evidence, once', async () => {
  const ask = (question: string) => ({ questions: [{ question, header: 'h', options: [{ label: '采纳' }, { label: '先不' }], multiSelect: false }] })
  const about = 'acme/v2 这份计划可以开始吗？'
  expect(questionApprovals(ask(about), { answers: { [about]: '采纳' } }, NOW)[0]?.isAffirmative).toBe(true)
  expect(questionApprovals(ask(about), { answers: { [about]: '先不' } }, NOW)[0]?.isAffirmative).toBe(false)
  expect(questionApprovals(ask(about), { answers: {}, afkTimeoutMs: 30_000 }, NOW)).toEqual([])
  expect(questionApprovals(ask(about), { answers: { [about]: '采纳' }, followUp: true }, NOW)).toEqual([])
  expect(questionApprovals(ask(about), { answers: {} }, NOW)).toEqual([])
  expect(isAffirmative('Do not adopt this plan')).toBe(false)
  expect(isAffirmative('不采纳')).toBe(false)

  const ctx = (approvals: SessionRec['approvals']) => ({ now: NOW, sessionId: 's1', planId: 'acme/v2', session: session({ approvals }), quoteFound: null, awayFound: null })
  const yes = questionApprovals(ask(about), { answers: { [about]: '采纳' } }, NOW - 1000)
  const no = questionApprovals(ask(about), { answers: { [about]: 'Do not adopt this plan' } }, NOW - 1000)
  const other = questionApprovals(ask('用哪个日期库？'), { answers: { '用哪个日期库？': '采纳 dayjs' } }, NOW - 1000)
  expect(judgeApproval({ kind: 'question' }, ctx(yes)).ok).toBe(true)
  expect(judgeApproval({ kind: 'question' }, ctx(no)).ok).toBe(false)
  expect(judgeApproval({ kind: 'question' }, ctx(other)).ok).toBe(false)
  expect(judgeApproval({ kind: 'question' }, ctx(yes.map(a => ({ ...a, usedAt: NOW - 10 })))).ok).toBe(false)
  // Plan mode still pending a team leader is no approval.
  expect(judgeApproval({ kind: 'plan_mode' }, ctx([{ kind: 'plan_mode', at: NOW - 10, isPending: true }])).ok).toBe(false)
})

// ---- 3 quotes ----------------------------------------------------------------

test('3 an uncheckable or missing quote, or an unverified leave authorization, is no evidence', async () => {
  const s = session({ lastUserInput: NOW - MIN })
  const c = (quoteFound: boolean | null, awayFound: boolean | null = null) => ({ now: NOW, sessionId: 's1', planId: 'acme/v2', session: s, quoteFound, awayFound })
  expect(judgeApproval({ kind: 'quote', quote: 'approve', quoted_at: '10-27 09:00' }, c(null)).ok).toBe(false)
  expect(judgeApproval({ kind: 'quote', quote: 'approve' }, c(true)).ok).toBe(false)
  expect(judgeApproval({ kind: 'quote', quote: '开始吧', quoted_at: '10-27 09:00' }, c(true)).ok).toBe(true)
  expect(judgeApproval({ away_authorization: 'not present in transcript' }, c(false, false)).ok).toBe(false)
  expect(judgeApproval({ away_authorization: '我去睡了，照授权推进' }, c(null, null)).ok).toBe(false)
  const away = judgeApproval({ away_authorization: '我去睡了，照授权推进' }, c(null, true))
  expect(away.ok && away.isAway && away.isReview).toBe(true)
})

// ---- 4 lifecycle ------------------------------------------------------------

test('4 reopening or splitting a finished plan makes it active again', async () => {
  const done = doneAll(plan())
  expect(done.status).toBe('done')
  const back = ok(changeItem(done, undefined, 'a1', { status: 'todo', reason: 'review failed' }, NOW))
  expect(back.plan.status).toBe('active')
  const split = ok(changePhases(done, { op: 'split', phase: 'A', into: [{ name: 'A1', items: ['x'] }, { name: 'A2', items: ['y'] }] }, 'r', NOW))
  expect(split.plan.status).toBe('active')
  const exc = ok(changeItem(ok(changeItem(plan(), undefined, 'a1', { status: 'done', meetsCriteria: true }, NOW)).plan, undefined, 'a2', { status: 'wrapping', exception: 'To Test' }, NOW))
  const done2 = ok(changeItem(exc.plan, undefined, 'b1', { status: 'done', meetsCriteria: true }, NOW)).plan
  expect(done2.status).toBe('done')
  const dropExc = ok(changeItem(done2, undefined, 'a2', { status: 'wrapping', exception: '' }, NOW))
  expect(dropExc.plan.status).toBe('active')
})

// ---- 5 undo conflicts -------------------------------------------------------

test('5 undoing a reviewed change after later edits reports a conflict instead of overwriting', async () => {
  const p = plan()
  const v = ok(changePhases(p, { op: 'void', phase: 'B' }, 'r', NOW))
  const rv = newReview('rv1', NOW, v.detail, 'r', 's1', { kind: 'away', at: NOW }, true, v.undo)
  const reviewed = { ...v.plan, reviews: [rv] }
  // Untouched since: undo restores.
  const clean = applyUndo(reviewed, rv)
  expect('conflict' in clean).toBe(false)
  if (!('conflict' in clean)) expect(clean.phases[1]?.isVoid).toBeUndefined()
  // Another session changed an item of the voided phase afterwards: undo refuses.
  const later = ok(changeItem(reviewed, undefined, 'b1', { status: 'done', meetsCriteria: true }, NOW + 1)).plan
  const r = applyUndo(later, rv)
  expect('conflict' in r).toBe(true)
  // Split then filled by another session: refuses as well.
  const s = ok(changePhases(p, { op: 'split', phase: 'A', into: [{ name: 'A1' }, { name: 'A2' }] }, 'r', NOW))
  const srv = newReview('rv2', NOW, s.detail, 'r', 's1', { kind: 'away', at: NOW }, true, s.undo)
  const filled = { ...s.plan, reviews: [srv], phases: s.plan.phases.map(ph => (ph.name === 'A1' ? { ...ph, items: [{ id: 'z', title: 'z', status: 'todo' as const, updatedAt: NOW }] } : ph)) }
  expect('conflict' in applyUndo(filled, srv)).toBe(true)
})

// ---- 6 ordered session saves -------------------------------------------------

class SlowIo extends MemIo {
  hold: (() => void) | null = null
  isHolding = true
  async writeAtomic(path: string, text: string) {
    if (this.isHolding) {
      this.isHolding = false
      await new Promise<void>(r => { this.hold = r })
    }
    return super.writeAtomic(path, text)
  }
}

test('6 a slower older save never lands over a newer one; a failed save is retried', async () => {
  const io = new SlowIo()
  const paths = new Paths('/h/.claude/progress-board')
  const saver = new SessionSaver(io, paths)
  const rec = session({ goal: 'old' })
  const first = saver.save(() => rec, NOW, true)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  rec.goal = 'new'
  const second = saver.save(() => rec, NOW + 1, true)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  io.hold?.()
  await Promise.all([first, second])
  expect(JSON.parse(io.files.get(paths.session('s1'))?.text ?? '{}').goal).toBe('new')

  const bad = new MemIo()
  const s2 = new SessionSaver(bad, paths)
  bad.failWrite = true
  await s2.save(() => rec, NOW)
  bad.failWrite = false
  await s2.save(() => rec, NOW + 1)
  expect(bad.files.has(paths.session('s1'))).toBe(true)
  // Nothing changed and no new activity: no rewrite.
  const writes = bad.writes
  await s2.save(() => rec, NOW + 60_000)
  expect(bad.writes).toBe(writes)
})

// ---- 7 / 8 env export --------------------------------------------------------

test('7 env-file exports are shell-quoted and unset an ineligible plan', async () => {
  expect(shellQuote("acme/v2$(printf INJECTED)")).toBe("'acme/v2$(printf INJECTED)'")
  expect(shellQuote("it's")).toBe("'it'\\''s'")
  const txt = envFileText('s1', undefined)
  expect(txt).toContain("export PROGRESS_BOARD_PARENT='s1'")
  expect(txt).toContain('unset PROGRESS_BOARD_PLAN')
  expect(envFileText('s1', 'acme/v2')).toContain("export PROGRESS_BOARD_PLAN='acme/v2'")
})

test('8 a session on several plans exports none; one plan exports it', async () => {
  const active = new Set(['acme/a', 'acme/b'])
  const two = attribute({ ownClaims: ['acme/a', 'acme/b'], repoCandidates: [], activePlans: active })
  expect(exportPlanOf(two)).toBeUndefined()
  const one = attribute({ ownClaims: ['acme/a'], repoCandidates: [], activePlans: active })
  expect(exportPlanOf(one)).toBe('acme/a')
})

// ---- 9 / 10 / 11 attribution -------------------------------------------------

test('9 a child inherits its parent’s env or lineage plan, through a chain', async () => {
  const active = new Set(['acme/v2'])
  const a = session({ id: 'A', envPlan: 'acme/v2' })
  const b = session({ id: 'B', parent: 'A' })
  const c = session({ id: 'C', parent: 'B' })
  const loop1 = session({ id: 'L1', parent: 'L2' })
  const loop2 = session({ id: 'L2', parent: 'L1' })
  const got = resolveAttributions([a, b, c, loop1, loop2], active, () => [])
  expect(got.get('B')?.confident).toEqual([{ plan: 'acme/v2', source: 'lineage' }])
  expect(got.get('C')?.confident).toEqual([{ plan: 'acme/v2', source: 'lineage' }])
  expect(got.get('L1')?.confident).toEqual([])
})

test('10 an explicit plan in the task beats the parent; mentions stay speculative; reviewers do not take mentions', async () => {
  const active = new Set(['acme/a', 'acme/b', 'acme/c'])
  expect(taskPlanOf('修复登录\nPlan: acme/b\n…')).toBe('acme/b')
  expect(taskPlanOf('计划：acme/b')).toBe('acme/b')
  expect(taskPlanOf('参考 acme/b 的章程')).toBeUndefined()
  const child = attribute({ taskPlan: 'acme/b', parentPlans: ['acme/a'], ownClaims: [], repoCandidates: [], activePlans: active })
  expect(child.confident).toEqual([{ plan: 'acme/b', source: 'task' }])
  const ref = attribute({ parentPlans: ['acme/a'], ownClaims: [], repoCandidates: [], firstMessage: '参考 acme/c 的章程', activePlans: active })
  expect(ref.confident).toEqual([{ plan: 'acme/a', source: 'lineage' }])
  expect(ref.speculative).toEqual([{ plan: 'acme/c', source: 'mention' }])
  const rev = attribute({ parentPlans: ['acme/a'], ownClaims: [], repoCandidates: ['acme/c'], firstMessage: 'acme/b', activePlans: active, isReviewer: true })
  expect(rev.confident).toEqual([{ plan: 'acme/a', source: 'lineage' }])
  expect(rev.speculative).toEqual([])
})

test('11 drafts are never inherited or claimed', async () => {
  const draft = { ...plan({ id: 'acme/draft' }), status: 'draft' as const }
  const act = activePlanIds([draft, plan()])
  expect(act.has('acme/draft')).toBe(false)
  const a = attribute({ parentPlans: ['acme/draft'], ownClaims: [], repoCandidates: [], activePlans: act })
  expect(a.confident).toEqual([])
})

// ---- 12 claims on ended plans -------------------------------------------------

test('12 claims on a finished plan stop counting; it does not keep the focus over active work', async () => {
  const a = { ...doneAll(plan({ id: 'acme/a', title: 'A' })), updatedAt: NOW - 2 * DAY }
  const b = plan({ id: 'acme/b', title: 'B' })
  const me = session({ kind: 'orchestrator', claims: [{ plan: 'acme/a', item: 'p1-1', at: NOW, source: 'claim' }, { plan: 'acme/b', at: NOW - 10, source: 'claim' }] })
  expect(liveClaims(me.claims, [a, b]).map(c => c.plan)).toEqual(['acme/b'])
  const snap: Snapshot = { now: NOW, selfId: 's1', focusPlan: null, repoPlans: ['acme/a', 'acme/b'], plans: [a, b], sessions: [view(me)], waiting: [], recent: [] }
  expect(focusPlanOf(snap).plan?.id).toBe('acme/b')
  const row = rowText(buildBanner({ snap, cols: 120, glyph: '■', isWorking: false, spinner: '', now: NOW }).rows[0] ?? [])
  expect(row).toContain('推进 1 条')
  // A just-finished plan with nothing else active still shows its completion.
  const fresh = { ...a, updatedAt: NOW - MIN }
  expect(focusPlanOf({ ...snap, plans: [fresh], repoPlans: ['acme/a'] }).plan?.id).toBe('acme/a')
})

// ---- 13 / 14 progress ---------------------------------------------------------

test('13 voiding every item of a phase does not invent unplanned work', async () => {
  let p = plan()
  for (const id of ['b1']) p = ok(changeItem(p, undefined, id, { status: 'void', reason: '不做' }, NOW)).plan
  expect(phaseState(p.phases[1] as never)).toBe('cleared')
  const pr = progress(p)
  expect(pr.unplannedEst).toBe(0)
  for (const id of ['p1-1', 'p1-2']) p = ok(changeItem(p, undefined, id, { status: 'done', meetsCriteria: true }, NOW)).plan
  expect(p.status).toBe('done')
})

test('14 numbers show real planned items plus +N unplanned phases (user rule); the bar still reserves the estimate', async () => {
  const p0 = newPlan({ id: 'acme/v2', goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['a'] }, { name: 'B' }], includeRelease: false, by: 's', now: NOW })
  const p = ok(changeItem({ ...p0, status: 'active' }, undefined, 'a', { status: 'done', meetsCriteria: true }, NOW)).plan
  const pr = progress(p)
  expect(pr.done).toBe(1)
  expect(pr.planned).toBe(1)
  expect(pr.total).toBe(2)
  expect(pr.isEstimate).toBe(true)
  const me = session({ goal: 'g', claims: [{ plan: 'acme/v2', at: NOW, source: 'claim' }] })
  const snap: Snapshot = { now: NOW, selfId: 's1', focusPlan: 'acme/v2', repoPlans: ['acme/v2'], plans: [p], sessions: [view(me)], waiting: [], recent: [] }
  expect(rowText(buildBanner({ snap, cols: 120, glyph: '■', isWorking: false, spinner: '', now: NOW }).rows[1] ?? [])).toContain('1/1 +1')
})

// ---- 15 time ticks ---------------------------------------------------------------

test('15 the published snapshot changes at least once a minute', async () => {
  const s: Snapshot = { now: NOW, selfId: 's1', focusPlan: null, repoPlans: [], plans: [], sessions: [], waiting: [], recent: [] }
  expect(publishKey({ ...s, now: NOW + 5_000 })).toBe(publishKey(s))
  expect(publishKey({ ...s, now: NOW + MIN })).not.toBe(publishKey(s))
})

// ---- 16 steps without a goal ------------------------------------------------------

test('16 steps without a goal still show on the band', async () => {
  const me = session({ firstMessage: '修一下登录', steps: [{ title: '复现', status: 'doing' }, { title: '修', status: 'todo' }] })
  const snap: Snapshot = { now: NOW, selfId: 's1', focusPlan: null, repoPlans: [], plans: [], sessions: [view(me)], waiting: [], recent: [] }
  const b = buildBanner({ snap, cols: 120, glyph: '■', isWorking: false, spinner: '', now: NOW })
  expect(b.isHidden).toBe(false)
  expect(rowText(b.rows[0] ?? [])).toContain('0/2')
  expect(rowText(b.rows[0] ?? [])).toContain('修一下登录')
})

// ---- 17 retention ---------------------------------------------------------------

test('17 a long-idle session that just died is marked ended, not deleted', async () => {
  const idle = session({ id: 'x', pid: 42, lastActivity: NOW - 10 * DAY })
  expect(sessionFate(idle, false, NOW)).toBe('gone')
  expect(sessionFate(idle, undefined, NOW)).toBe('keep')
  expect(sessionFate({ ...idle, endedAt: NOW - DAY }, false, NOW)).toBe('keep')
  expect(sessionFate({ ...idle, endedAt: NOW - 8 * DAY }, false, NOW)).toBe('delete')
})

// ---- 18 reject reason -----------------------------------------------------------------

test('18 rejecting a draft records a reason', async () => {
  const d = { ...plan(), status: 'draft' as const }
  const r = rejectDraft(d, '', 'panel', 's1')
  if ('error' in r) throw new Error(r.error)
  expect(r.plan.status).toBe('abandoned')
  expect(r.plan.endReason).toBe('用户在面板放弃')
  expect(r.log[0]?.reason).toBe('用户在面板放弃')
  const r2 = rejectDraft(d, '范围太大', 'command', 's1')
  if ('error' in r2) throw new Error(r2.error)
  expect(r2.log[0]?.reason).toBe('范围太大')
  expect(parseDecisionArgs(['acme/v2', '范围', '太大'], ['acme/v2'])).toEqual({ plan: 'acme/v2', reason: '范围 太大' })
  expect(parseDecisionArgs(['范围太大'], ['acme/v2'])).toEqual({ reason: '范围太大' })
})

// ---- 19 log reads -----------------------------------------------------------------------

test('19 the change log is read again only when it changed, and only its tail', async () => {
  const io = new MemIo()
  const paths = new Paths('/h/.claude/progress-board')
  await mutatePlan(io, paths, 'acme/v2', () => ({ plan: plan(), log: [{ by: 's', action: 'x', detail: 'd' }], md: '' }))
  const tail = new LogTail(io, paths)
  expect((await tail.get('acme/v2', 60)).length).toBe(1)
  const reads = io.tailReads
  await tail.get('acme/v2', 60)
  expect(io.tailReads).toBe(reads)
  io.clock += 10
  await mutatePlan(io, paths, 'acme/v2', cur => ({ plan: cur as Plan, log: [{ by: 's', action: 'y', detail: 'd' }], md: '' }))
  expect((await tail.get('acme/v2', 60)).length).toBe(2)
  expect(io.tailReads).toBe(reads + 1)
  expect(await readPlan(io, paths, 'acme/v2')).toBeDefined()
})

// waitingItems still counts the same things with the new phase state.
test('waiting items unaffected by the cleared phase state', async () => {
  expect(waitingItems([plan()], []).length).toBe(0)
})
