// 0.6.1, from a fresh-user test: the session that imported, accepted and updated a plan was still
// shown as "0 sessions" on it. Review CR-01: the plan counts that session, but the edit is never a
// confident attribution, a claim, or a priority route.

import { expect, enTest as test } from './locale-test'
import { resolveAttributions } from '../hooks/attrib'
import { buildBanner, rowText, sessionsOn } from '../hooks/banner'
import { orchestratorFor } from '../hooks/priorities'
import { dispatchTarget } from '../hooks/controls'
import { t } from '../hooks/i18n'
import { world, seedPlan } from './world'
import { NOW, PLAN, claim, plan, savedSession, seedSession, session } from './v03-fixtures'
import type { Plan, SessionRec, SessionView, Snapshot } from '../types'

const planFile = (id: string) => `/h/.claude/progress-board/plans/${encodeURIComponent(id)}/plan.json`
const savedPlan = (w: ReturnType<typeof world>, id: string): Plan => JSON.parse(w.files.get(planFile(id))?.text ?? '{}') as Plan
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'] as const, tools: [], outputStyle: null, traits: [] }

/** The session views a snapshot holds: attribution resolved exactly as the plugin resolves it. */
const views = (recs: SessionRec[], plans: Plan[] = [plan()]): SessionView[] => {
  const active = new Set(plans.filter(p => p.status === 'active').map(p => p.id))
  const attrs = resolveAttributions(recs, active, () => [], plans)
  return recs.map(r => ({ ...r, isAlive: true, isSelf: false, attribution: attrs.get(r.id)!, cwdMissing: false }))
}
const snapshotOf = (recs: SessionRec[], plans: Plan[] = [plan()]): Snapshot =>
  ({ now: NOW, selfId: recs[0]?.id ?? 's1', focusPlan: plans[0]?.id ?? null, repoPlans: [], plans, sessions: views(recs, plans), recent: [], waiting: [] }) as unknown as Snapshot

test('V061 a session that accepted a draft is counted on the plan, without attribution or a claim', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan({ id: 'acme/draft', status: 'draft' })); seedSession(w, session())
  on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'progress', args: 'accept acme/draft' } as never)
  expect(savedPlan(w, 'acme/draft').status).toBe('active')
  const rec = savedSession(w)
  expect(rec.editedPlans?.map(e => e.plan)).toEqual(['acme/draft'])
  expect(rec.claims).toEqual([])
  const got = resolveAttributions([rec], new Set(['acme/draft']), () => [], [savedPlan(w, 'acme/draft')]).get('s1')!
  expect(got.confident).toEqual([])
  expect(sessionsOn(snapshotOf([rec], [savedPlan(w, 'acme/draft')]), 'acme/draft')).toBe(1)
})

test('V061 a status change through progress_plan is counted on the plan, without attribution or a claim', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session())
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-1', status: 'wrapping' } as never) as { result?: unknown }
  expect(String(r.result)).not.toContain('internal error')
  const rec = savedSession(w)
  expect(rec.editedPlans?.map(e => e.plan)).toEqual([PLAN])
  expect(rec.claims).toEqual([])
  const got = resolveAttributions([rec], new Set([PLAN]), () => [], [savedPlan(w, PLAN)]).get('s1')!
  expect(got.confident).toEqual([])
  expect(sessionsOn(snapshotOf([rec], [savedPlan(w, PLAN)]), PLAN)).toBe(1)
})

test('V061 old session records load unchanged and an edit never attributes a plan', () => {
  const rec = session()
  expect(resolveAttributions([rec], new Set([PLAN]), () => [], [plan()]).get('s1')!.confident).toEqual([])
  expect(sessionsOn(snapshotOf([rec]), PLAN)).toBe(0)
  // An edit of a plan that is no longer active takes no part, like every other attribution.
  expect(views([session({ editedPlans: [{ plan: PLAN, at: NOW }] })], [{ ...plan(), status: 'draft' }])[0]!.attribution.confident).toEqual([])
})

test('V061 an edited plan gives no claim when the session dispatches an agent naming its item', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session({ editedPlans: [{ plan: PLAN, at: NOW }] }))
  on('tool.call', (_, e) => ({ result: { out: e.tool } }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.compose', () => ({ sections: [] }) as never)
  await $.prompt.compose(COMPOSE as never)
  const r = await $.tool.call({ tool: 'Agent', description: 'fix p1-2', prompt: 'Fix p1-2 of acme/v3', subagent_type: 'general-purpose' } as never) as { context?: readonly string[] }
  const rec = savedSession(w)
  expect(rec.bg[0]?.claim).toBeUndefined()
  expect(rec.claims).toEqual([])
  expect((r.context ?? []).join('\n')).not.toContain('Priority deviation')
})

test('V061 edited plans never choose the orchestrator or the dispatch-now target', () => {
  const editor = session({ id: 'a-editor', kind: 'orchestrator', editedPlans: [{ plan: PLAN, at: NOW }] })
  const lead = session({ id: 'z-lead', kind: 'orchestrator', envPlan: PLAN })
  expect(views([editor, lead])[0]!.attribution.confident).toEqual([])
  expect(orchestratorFor(PLAN, views([editor, lead]))?.id).toBe('z-lead')
  const self = session({ id: 'm-self' })
  expect(dispatchTarget(PLAN, views([editor, lead, self]), self).id).toBe('z-lead')
})

test('V061 the participating-session count includes the session that edited the plan', () => {
  const editor = session({ id: 's1', editedPlans: [{ plan: PLAN, at: NOW }] })
  const snap = snapshotOf([editor])
  expect(sessionsOn(snap, PLAN)).toBe(1)
  expect(rowText(buildBanner({ snap, cols: 120, glyph: '■', isWorking: false, spinner: '', now: NOW }).rows[1]!)).toContain(t('banner.m006', { p0: 1 }))
})

test('V061 only the main loop counts: a direct worker’s set_item never edits the session’s plan record', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan())
  // A permitted direct worker: the call passes the worker gate and reaches the main-loop check.
  seedSession(w, session({ bg: [{ id: 'b1', kind: 'agent', name: 'worker', startedAt: NOW, direct: true, workerSource: 'claim', taskId: 'a1', claim: claim('p1-1') }] }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-1', status: 'wrapping', agentId: 'a1' } as never)
  expect(savedSession(w).editedPlans ?? []).toEqual([])
})
