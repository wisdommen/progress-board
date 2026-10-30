import { expect, enTest as test } from './locale-test'
import type { Snapshot } from '../types'
import { focusPlanOf } from '../hooks/banner'
import { withSuccessors } from '../hooks/model'
import { NOW, PLAN, plan, savedPlan } from './v03-fixtures'
import { world } from './world'

const at = (id: string, status: 'draft' | 'active' | 'done' | 'abandoned', createdAt = NOW) => plan({ id, status, createdAt })

test('a finished repo plan is followed by the active plans with its project prefix, newest first', () => {
  const plans = [at('acme/v1', 'done'), at('acme/v2', 'active', NOW + 1), at('acme/v3', 'active', NOW + 2), at('acme/v4', 'draft', NOW + 3), at('other/v9', 'active')]
  expect(withSuccessors(['acme/v1'], plans)).toEqual(['acme/v1', 'acme/v3', 'acme/v2'])
})

test('an abandoned repo plan is followed too; an active one or an unprefixed id is not', () => {
  expect(withSuccessors(['acme/v1'], [at('acme/v1', 'abandoned'), at('acme/v2', 'active')])).toEqual(['acme/v1', 'acme/v2'])
  expect(withSuccessors(['acme/v1'], [at('acme/v1', 'active'), at('acme/v2', 'active')])).toEqual(['acme/v1'])
  expect(withSuccessors(['solo'], [at('solo', 'done'), at('solo2', 'active')])).toEqual(['solo'])
})

test('row 2 focuses the successor instead of the finished plan of this directory', () => {
  const plans = [at('acme/v1', 'done'), at('acme/v2', 'active')]
  const snap: Snapshot = { now: NOW, selfId: 's1', focusPlan: null, repoPlans: withSuccessors(['acme/v1'], plans), plans, sessions: [], recent: [], waiting: [] }
  expect(focusPlanOf(snap).plan?.id).toBe('acme/v2')
})

test('set replaces the repos of a plan without approval and logs the change', async ($, on) => {
  const w = world(on, { coarseClock: true })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'propose', plan: PLAN, goal: 'g', criteria: 'c', repos: ['/w/a'], phases: [{ name: 'work', items: ['a'] }] } as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set', plan: PLAN, repos: ['/w/a', '/w/code/'] } as never)
  expect(savedPlan(w).repos).toEqual(['/w/a', '/w/code'])
  const log = [...w.files.entries()].find(([k]) => k.endsWith('acme%2Fv3/log.jsonl'))?.[1].text ?? ''
  expect(log).toContain('/w/code')
})

test('set rejects an empty or malformed repos list and a call with nothing to set', async ($, on) => {
  const w = world(on, { coarseClock: true })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'propose', plan: PLAN, goal: 'g', criteria: 'c', repos: ['/w/a'], phases: [{ name: 'work', items: ['a'] }] } as never)
  for (const repos of [[], [''], 'x']) {
    await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set', plan: PLAN, repos } as never)
    expect(savedPlan(w).repos).toEqual(['/w/a'])
  }
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set', plan: PLAN } as never)
  expect(savedPlan(w).repos).toEqual(['/w/a'])
})
