import { expect, test } from './locale-test'

import type { Plan, SessionRec, SessionView, Snapshot } from '../types'
import { attribute, inheritFrom } from '../hooks/attrib'
import { buildBanner, rowText, tierOf } from '../hooks/banner'
import {
  addItems, allocCells, changeItem, changePhases, isPlanComplete, judgeApproval, newPlan, phaseState, progress, waitingItems,
} from '../hooks/model'
import { Paths, mutatePlan, readPlan, withLock } from '../hooks/store'
import { mentionsExactly, strWidth } from '../hooks/util'
import { renderPlanMd } from '../hooks/model'
import { MemIo } from './memio'

const NOW = 1_800_000_000_000

function plan(over: Partial<Plan> = {}): Plan {
  const p = newPlan({
    id: 'acme/v2', title: 'v2 发布', goal: 'ship v2', criteria: 'PR 合并且 issue 关闭（停在 To Test 的不挡完成）',
    phases: [{ name: '数据库迁移', items: ['a', 'b'] }, { name: '登录重构', items: ['c', 'd', 'e', 'f'] }, { name: '文档' }],
    by: 's1', now: NOW,
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

function snap(plans: Plan[], sessions: SessionView[], over: Partial<Snapshot> = {}): Snapshot {
  return { now: NOW, selfId: 's1', focusPlan: null, repoPlans: plans.map(p => p.id), plans, sessions, waiting: waitingItems(plans, sessions), recent: [], ...over }
}

// ---- progress bar ----

test('bar cells round to whole cells', async () => {
  expect(allocCells([37, 3, 0, 40, 0], 10, 3)).toEqual([5, 1, 0, 4, 0])
  expect(allocCells([1, 1], 10, 1)).toEqual([5, 5])
  expect(allocCells([0, 0, 0], 10, 1)).toEqual([0, 0, 0])
  const out = allocCells([2, 1, 7], 9, 2)
  expect(out.reduce((a, b) => a + b, 0)).toBe(9)
})

test('every non-zero state gets at least one cell, taken from todo', async () => {
  // 1 wrapping among 100 would round to 0 cells; it takes one from "todo".
  const out = allocCells([10, 1, 89], 10, 2)
  expect(out[1]).toBe(1)
  expect(out[0]).toBe(1)
  expect(out[2]).toBe(8)
  expect(out.reduce((a, b) => a + b, 0)).toBe(10)
  // When todo is gone, the largest slot gives.
  const two = allocCells([98, 1, 0, 0, 1], 10, 2)
  expect(two[1]).toBe(1)
  expect(two[4]).toBe(1)
  expect(two.reduce((a, b) => a + b, 0)).toBe(10)
})

// ---- banner ----

function bannerFixture(): Snapshot {
  const p = plan()
  const r1 = changeItem(p, undefined, 'a', { status: 'done', meetsCriteria: true }, NOW)
  if ('error' in r1) throw new Error(r1.error)
  const r2 = changeItem(r1.plan, undefined, 'c', { status: 'wrapping' }, NOW)
  if ('error' in r2) throw new Error(r2.error)
  const draft = { ...newPlan({ id: 'acme/v3', goal: 'g', criteria: 'c', phases: [{ name: 'x' }], by: 's2', now: NOW }) }
  const me = session({
    goal: '修复登录超时',
    steps: [{ title: '复现', status: 'done' }, { title: '定位', status: 'done' }, { title: '跑单元测试', status: 'doing' }, { title: '文档', status: 'todo' }, { title: '提交', status: 'todo' }],
    claims: [{ plan: 'acme/v2', item: 'p2-2', at: NOW, source: 'claim' }],
    bg: [{ id: 'b1', kind: 'bash', name: 'tests', startedAt: NOW - 14 * 60_000 }, { id: 'b2', kind: 'agent', name: 'review', startedAt: NOW - 3 * 60_000 }],
  })
  const conf = { confident: [{ plan: 'acme/v2', source: 'claim' as const }], speculative: [] }
  return snap([r2.plan, draft], [view(me, { attribution: conf }), view(session({ id: 's2', goal: 'x' }), { isSelf: false, attribution: conf })])
}

test('banner text in the three width tiers', async () => {
  expect(tierOf(120)).toBe('wide')
  expect(tierOf(80)).toBe('mid')
  expect(tierOf(50)).toBe('narrow')
  const s = bannerFixture()
  const at = (cols: number) => buildBanner({ snap: s, cols, glyph: '■', isWorking: false, spinner: '⠋', now: NOW }).rows.map(rowText)

  const [w1, w2] = at(130)
  expect(w1).toMatch(/^● 本会话  修复登录超时/)
  expect(w1).toContain('2/5')
  expect(w1).toContain('正在 跑单元测试')
  expect(w1).toContain('⟳ 后台 2 · 14 分')
  expect(w2).toMatch(/^◆ 整体    v2 发布/)
  expect(w2).toContain('1/6 +2')
  expect(w2).toContain('2 个会话')
  expect(w2).toContain('等你 1')
  // Both bars start in the same column.
  const lead = (r: string | undefined) => strWidth((r ?? '').slice(0, (r ?? '').indexOf('■')))
  expect(lead(w1)).toBe(lead(w2))

  const [m1, m2] = at(80)
  expect(m1).toMatch(/^● 修复登录超时 +■/)
  expect(m1).toContain('⟳2·14分')
  expect(m2).toMatch(/^◆ v2 发布/)
  expect(m2).toContain('1/6 +2 · 等你 1')

  const [n1, n2] = at(40)
  expect(n1).toMatch(/^● ■{8} 2\/5 修复登录/)
  expect(n2).toMatch(/^◆ ■{8} 1\/6/)
  expect(n2).toContain('等你 1')
  for (const row of [n1, n2]) expect(strWidth(row ?? '')).toBeLessThanOrEqual(40)
})

test('banner drops low-priority parts before the numbers', async () => {
  const s = bannerFixture()
  const [r1, r2] = buildBanner({ snap: s, cols: 24, glyph: '■', isWorking: true, spinner: '⠋', now: NOW }).rows.map(rowText)
  expect(r1).toContain('2/5')
  expect(r1).toMatch(/^⠋ /)
  expect(r2).toContain('1/6')
  expect(strWidth(r2 ?? '')).toBeLessThanOrEqual(24)
})

test('banner states: nothing set hides; no plan; draft; done', async () => {
  const empty = buildBanner({ snap: snap([], [view(session())]), cols: 120, glyph: '■', isWorking: false, spinner: '', now: NOW })
  expect(empty.isHidden).toBe(true)
  expect(rowText(empty.rows[0] ?? [])).toContain('未设定目标')

  const d = newPlan({ id: 'acme/v3', goal: 'g', criteria: 'c', phases: [{ name: 'x' }, { name: 'y' }], by: 's1', now: NOW })
  const draft = buildBanner({ snap: snap([d], [view(session({ goal: 'g' }))]), cols: 120, glyph: '■', isWorking: false, spinner: '', now: NOW })
  expect(rowText(draft.rows[1] ?? [])).toContain('有一份待确认的计划（3 个阶段）· 等你 1  /progress')

  const p = plan({ status: 'done' })
  const done = buildBanner({ snap: snap([p], [view(session({ claims: [{ plan: 'acme/v2', at: NOW, source: 'claim' }] }))]), cols: 120, glyph: '■', isWorking: false, spinner: '', now: NOW })
  expect(rowText(done.rows[1] ?? [])).toBe('✓ 整体  v2 发布  完成')

  const idle = buildBanner({ snap: snap([], [view(session({ goal: 'g', lastActivity: NOW - 18 * 60_000 }))]), cols: 120, glyph: '■', isWorking: false, spinner: '', now: NOW })
  expect(rowText(idle.rows[0] ?? [])).toContain('· 18 分钟无动静')
  expect(rowText(idle.rows[1] ?? [])).toContain('整体  未设定')
})

// ---- waiting ----

test('waiting count: drafts, plans with reviews, sessions on a question', async () => {
  const d = newPlan({ id: 'acme/v3', goal: 'g', criteria: 'c', phases: [{ name: 'x' }], by: 's1', now: NOW })
  const reviewed = plan({ reviews: [
    { id: 'r1', at: NOW, summary: '插入阶段', reason: 'r', by: 's1', undo: { kind: 'plan-draft' } },
    { id: 'r2', at: NOW, summary: '作废阶段', reason: 'r', by: 's1', undo: { kind: 'plan-draft' } },
  ] })
  const asking = view(session({ id: 's2', question: { since: NOW, text: '?' } }))
  const ended = view(session({ id: 's3', question: { since: NOW, text: '?' }, endedAt: NOW }))
  const dead = view(session({ id: 's4', question: { since: NOW, text: '?' } }), { isAlive: false })
  const w = waitingItems([d, reviewed, plan({ id: 'acme/v4' })], [asking, ended, dead])
  expect(w.length).toBe(3)
  expect(w.map(x => x.kind)).toEqual(['draft', 'review', 'question'])
})

// ---- plan rules ----

test('phase and plan states, including the criteria exception', async () => {
  let p = plan()
  expect(phaseState(p.phases[2] as never)).toBe('unplanned')
  expect(p.phases.at(-1)?.name).toBe('收口 / 发布')
  expect(phaseState(p.phases[0] as never)).toBe('todo')
  const step = (ref: string, status: 'done' | 'wrapping' | 'void', extra: Record<string, unknown> = {}) => {
    const r = changeItem(p, undefined, ref, { status, meetsCriteria: true, ...extra }, NOW)
    if ('error' in r) throw new Error(r.error)
    p = r.plan
  }
  step('a', 'done')
  expect(phaseState(p.phases[0] as never)).toBe('active')
  step('b', 'wrapping')
  expect(phaseState(p.phases[0] as never)).toBe('active')
  step('b', 'wrapping', { exception: '停在 To Test' })
  expect(phaseState(p.phases[0] as never)).toBe('done')
  for (const r of ['c', 'd', 'e']) step(r, 'done')
  step('f', 'void', { reason: '不做了' })
  expect(phaseState(p.phases[1] as never)).toBe('done')
  expect(isPlanComplete(p)).toBe(false) // 文档 and 收口 are unplanned
  const v1 = changePhases(p, { op: 'void', phase: '文档' }, '合并进别处', NOW)
  if ('error' in v1) throw new Error(v1.error)
  const add = addItems(v1.plan, '收口 / 发布', ['tag'], NOW)
  if ('error' in add) throw new Error(add.error)
  p = add.plan
  step('tag', 'done')
  expect(isPlanComplete(p)).toBe(true)
  expect(p.status).toBe('done')
  const pr = progress(p)
  expect(pr.total).toBe(6)
  expect(pr.done).toBe(5)
  expect(pr.wrapping).toBe(1)
  expect(renderPlanMd(p)).toContain('[~] b（例外：停在 To Test）')
})

test('going back needs a reason; done needs the criteria', async () => {
  const p = plan()
  expect('error' in changeItem(p, undefined, 'a', { status: 'done' }, NOW)).toBe(true)
  const d = changeItem(p, undefined, 'a', { status: 'done', meetsCriteria: true }, NOW)
  if ('error' in d) throw new Error(d.error)
  const back = changeItem(d.plan, undefined, 'a', { status: 'wrapping' }, NOW)
  expect('error' in back && back.error).toMatch(/requires a reason/)
  const ok = changeItem(d.plan, undefined, 'a', { status: 'wrapping', reason: '审查打回' }, NOW)
  if ('error' in ok) throw new Error(ok.error)
  expect(ok.isRevert).toBe(true)
  expect(ok.plan.reverts[0]?.reason).toBe('审查打回')
  expect('error' in changePhases(p, { op: 'insert', name: 'x' }, '', NOW)).toBe(true)
})

test('approval evidence: none, quote, away, relayed', async () => {
  const s = session({ lastUserInput: NOW - 60_000 })
  const ctx = (quoteFound: boolean | null, sess = s) => ({ now: NOW, sessionId: 's1', planId: 'acme/v2', session: sess, quoteFound, awayFound: null })
  expect(judgeApproval(undefined, ctx(null)).ok).toBe(false)
  expect(judgeApproval({ kind: 'quote', quote: '开始吧' }, ctx(false)).ok).toBe(false)
  const q = judgeApproval({ kind: 'quote', quote: '开始吧', quoted_at: '10-25 09:12' }, ctx(true))
  expect(q.ok && !q.isReview).toBe(true)
  expect(judgeApproval({ kind: 'question' }, ctx(null)).ok).toBe(false)
  const asked = session({ approvals: [{ kind: 'question', at: NOW - 1000, text: '「采纳」', question: 'acme/v2 可以开始吗？', isAffirmative: true }] })
  expect(judgeApproval({ kind: 'question' }, ctx(null, asked)).ok).toBe(true)
  const away = judgeApproval(undefined, ctx(null, session({ lastUserInput: NOW - 31 * 60_000 })))
  expect(away.ok && away.isReview).toBe(true)
  const relayed = judgeApproval({ relayed_by: '统筹会话' }, ctx(null))
  expect(relayed.ok && relayed.isReview && relayed.approval.relayedBy).toBe('统筹会话')
})

// ---- storage ----

test('two concurrent plan writes under the lock both land', async () => {
  const io = new MemIo()
  const paths = new Paths('/h/.claude/progress-board')
  await mutatePlan(io, paths, 'acme/v2', (_c, now) => {
    const p = { ...plan(), updatedAt: now }
    return { plan: p, log: [], md: '' }
  })
  const add = (title: string) => mutatePlan(io, paths, 'acme/v2', cur => {
    const r = addItems(cur as Plan, '登录重构', [title], NOW)
    return 'error' in r ? r : { plan: r.plan, log: [{ by: 's', action: 'add_items', detail: r.detail }], md: '' }
  })
  const [a, b] = await Promise.all([add('x1'), add('x2')])
  expect('error' in a).toBe(false)
  expect('error' in b).toBe(false)
  const got = await readPlan(io, paths, 'acme/v2')
  const titles = got?.phases[1]?.items.map(i => i.title) ?? []
  expect(titles).toContain('x1')
  expect(titles).toContain('x2')
  const log = io.files.get(paths.planLog('acme/v2'))?.text ?? ''
  expect(log.trim().split('\n').length).toBe(2)
  // The lock is released and the plan folder name encodes the slash.
  expect(io.dirs.has(`${paths.planDir('acme/v2')}/.lock`)).toBe(false)
  expect(paths.planDir('acme/v2')).toEndWith('/acme%2Fv2')
})

test('a stale lock is recovered; a live one times out', async () => {
  const io = new MemIo()
  const dir = '/h/x'
  io.dirs.set(`${dir}/.lock`, io.clock - 600_000)
  expect(await withLock(io, dir, async () => 'ran')).toBe('ran')
  io.dirs.set(`${dir}/.lock`, io.clock)
  let err = ''
  await withLock(io, dir, async () => 'no', { timeoutMs: 500, staleMs: 1_000_000 }).catch((e: unknown) => { err = String(e) })
  expect(err).toContain('lock busy')
})

// ---- attribution ----

test('attribution layers: confident vs speculative', async () => {
  const active = new Set(['acme/v1.41', 'acme/v2', 'other/v9'])
  const env = attribute({ envPlan: 'acme/v2', parentPlans: ['other/v9'], ownClaims: [], repoCandidates: ['acme/v1.41'], activePlans: active })
  expect(env.confident).toEqual([{ plan: 'acme/v2', source: 'env' }])
  expect(env.speculative).toEqual([{ plan: 'acme/v1.41', source: 'repo' }])

  const lin = attribute({ parentPlans: ['other/v9'], ownClaims: [], repoCandidates: [], activePlans: active })
  expect(lin.confident).toEqual([{ plan: 'other/v9', source: 'lineage' }])
  // A parent with several plans passes none down.
  expect(attribute({ parentPlans: ['other/v9', 'acme/v2'], ownClaims: [], repoCandidates: [], activePlans: active }).confident).toEqual([])

  const men = attribute({ ownClaims: ['acme/v2'], repoCandidates: ['acme/v1.41', 'acme/v2'], firstMessage: '继续 acme/v1.41 的收尾', activePlans: active })
  expect(men.confident).toEqual([{ plan: 'acme/v2', source: 'claim' }])
  expect(men.speculative).toEqual([{ plan: 'acme/v1.41', source: 'mention' }])
  expect(mentionsExactly('see acme/v1.41.0 now', 'acme/v1.41')).toBe(false)
  expect(mentionsExactly('done with acme/v1.41.', 'acme/v1.41')).toBe(true)
})

test('inheritance after /clear keeps only active plans', async () => {
  const prev = session({ goal: 'g', claims: [
    { plan: 'acme/v2', item: 'p1-1', at: 1, source: 'claim' },
    { plan: 'acme/old', at: 1, source: 'claim' },
  ] })
  const got = inheritFrom(prev, new Set(['acme/v2']), NOW)
  expect(got.goal).toBe('g')
  expect(got.claims.map(c => c.plan)).toEqual(['acme/v2'])
  expect(got.claims[0]?.source).toBe('lineage')
})
