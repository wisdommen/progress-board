// v0.2 Part C: who is working each item — a claim's `by`, auto-claim from a dispatch,
// attribution by worktree name, and the band counting only progress-board sessions.

import { expect, test } from './locale-test'

import type { Plan, SessionRec, SessionView, Snapshot } from '../types'
import { attribute, resolveAttributions, worktreePhaseOf } from '../hooks/attrib'
import { buildBanner, rowText, sessionsOn } from '../hooks/banner'
import { dispatchItemOf, newPlan, waitingItems } from '../hooks/model'
import { seedPlan, world } from './world'

const NOW = 1_800_000_000_000
const HOME = '/h'
const MIN = 60_000
const SESSION_FILE = `${HOME}/.claude/progress-board/sessions/s1.json`
const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: '进度', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const activePlan = (id: string, over: Partial<Plan> = {}) => ({
  ...newPlan({ id, goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['a', 'b'] }], includeRelease: false, by: 'x', now: NOW }),
  status: 'active' as const, ...over,
})
const sessionJson = (w: ReturnType<typeof world>): SessionRec =>
  JSON.parse(w.files.get(SESSION_FILE)?.text ?? '{}') as SessionRec

function session(over: Partial<SessionRec> = {}): SessionRec {
  return {
    v: 1, id: 's1', kind: 'normal', startedAt: NOW - 60 * MIN, cwd: '/w/acme', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [], ...over,
  }
}

// ---- C1: a claim records who holds it ----

test('C1 a claim records who holds it (by)', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/v1'))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '统筹', claim: [{ plan: 'acme/v1', item: 'a', by: '后端' }] } as never)
  expect(sessionJson(w).claims[0]?.by).toBe('后端')
})

function seedSessions(w: ReturnType<typeof world>, recs: SessionRec[]): void {
  w.dirs.add(`${HOME}/.claude/progress-board`)
  w.dirs.add(`${HOME}/.claude/progress-board/sessions`)
  for (const r of recs) w.files.set(`${HOME}/.claude/progress-board/sessions/${r.id}.json`, { text: JSON.stringify(r), m: NOW })
}

test('C1 the item row names the worker with its step and age when it is a progress-board session', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/v1'))
  seedSessions(w, [
    session({ goal: '统筹', claims: [{ plan: 'acme/v1', phase: 'p1', item: 'p1-1', at: NOW - 35 * MIN, source: 'claim', by: '后端' }] }),
    session({ id: 's2', goal: '后端', steps: [{ title: '一', status: 'done' }, { title: '二', status: 'doing' }, { title: '三', status: 'todo' }] }),
  ])
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const t = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(t).toContain('← 后端 · 第 1/3 步 · 35 分')
  await ui.unmount()
})

test('C1 a worker that is not a progress-board session shows just its name and the age', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/v1'))
  seedSessions(w, [session({ goal: '统筹', claims: [{ plan: 'acme/v1', phase: 'p1', item: 'p1-1', at: NOW - 12 * MIN, source: 'claim', by: 'worker-3' }] })])
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const t = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(t).toContain('← worker-3 · 12 分')
  await ui.unmount()
})

// ---- C2: dispatch auto-claims the item the agent names ----

test('C2 an item id, a plan › phase or an exact title in the dispatch names the item', async () => {
  const plan = activePlan('acme/v1', { phases: [
    { id: 'p1', name: '登录', addedAt: NOW, items: [{ id: 'p1-1', title: '实现 --min-len', status: 'todo', updatedAt: NOW }] },
    { id: 'p3', name: '发布', addedAt: NOW, items: [{ id: 'p3-2', title: '打标签', status: 'todo', updatedAt: NOW }] },
  ] })
  const hit = dispatchItemOf('修 p3-2 的标签问题', [plan], ['acme/v1'])
  expect(hit).toEqual({ plan: 'acme/v1', phase: 'p3', item: 'p3-2' })
  expect(dispatchItemOf('做 acme/v1 › 登录 的实现', [plan], ['acme/v1'])).toEqual({ plan: 'acme/v1', phase: 'p1' })
  expect(dispatchItemOf('把 实现 --min-len 做完', [plan], ['acme/v1'])).toEqual({ plan: 'acme/v1', phase: 'p1', item: 'p1-1' })
  // Plans the session is not attributed to, or that are not active, name nothing.
  expect(dispatchItemOf('修 p3-2', [plan], [])).toBeUndefined()
  expect(dispatchItemOf('修 p3-2', [{ ...plan, status: 'draft' }], ['acme/v1'])).toBeUndefined()
  // A partial id is not a match.
  expect(dispatchItemOf('修 p3-20 的问题', [plan], ['acme/v1'])).toBeUndefined()
})

test('C2 dispatching an agent claims its item under the agent’s name, and completing it releases the claim', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/v1'))
  let mid: SessionRec | null = null
  on('agent.spawn', () => ({ agentId: 'a1', model: 'fixture-model' }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', async (_, e) => {
    if (e.tool === 'Agent') {
      await $.agent.spawn({ tool_use_id: e.tool_use_id, prompt: e.prompt, description: e.description ?? '', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'fixture-model', background: false, fork: false } as never)
      mid = sessionJson(w)
      await $.turn.complete({ turnId: 'sync-worker-turn', agentId: 'a1', answer: 'ready', durationMs: 1, reason: 'answer', isAborted: false } as never)
    }
    return (e.tool === 'Agent' ? { result: { agentId: 'a1' } } : { result: {} }) as never
  })
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '统筹', claim: [{ plan: 'acme/v1' }] } as never)
  await $.tool.call({ tool: 'Agent', description: '实现 p1-1', prompt: '做 p1-1 这一条' } as never)
  const atDispatch = (mid ?? null) as SessionRec | null
  expect(atDispatch?.claims.some(c => c.item === 'p1-1' && c.by === '实现 p1-1')).toBe(true)
  // The call returned without async launch: the subagent is done and its claim is released.
  expect(sessionJson(w).claims.some(c => c.item === 'p1-1')).toBe(false)
  expect(sessionJson(w).agentsDone).toBe(1)
  // A dispatch naming no item claims nothing.
  await $.tool.call({ tool: 'Agent', description: '随便看看', prompt: '读一下仓库' } as never)
  expect(sessionJson(w).claims.length).toBe(1)
})

test('C2 an async dispatch keeps the claim until the subagent stops', async ($, on) => {
  const w = world(on)
  seedPlan(w, HOME, activePlan('acme/v1'))
  on('tool.call', (_, e) => (e.tool === 'Agent' ? { result: { status: 'async_launched', agentId: 'a9' } } : { result: {} }) as never)
  on('classic.SubagentStop', () => ({}) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '统筹', claim: [{ plan: 'acme/v1' }] } as never)
  await $.tool.call({ tool: 'Agent', description: '实现 p1-2', prompt: '做 p1-2' } as never)
  expect(sessionJson(w).claims.some(c => c.item === 'p1-2' && c.by === '实现 p1-2')).toBe(true)
  await $.classic.SubagentStop({ agent_id: 'a9' } as never)
  expect(sessionJson(w).claims.some(c => c.item === 'p1-2')).toBe(false)
})

// ---- C3: attribution by worktree name ----

test('C3 a worktree name carrying the plan version and a phase number attributes the session', async () => {
  const phases = Array.from({ length: 17 }, (_, i) => ({ id: `p${i + 1}`, name: `阶段 ${i + 1}`, addedAt: NOW, items: [{ id: `p${i + 1}-1`, title: `x${i + 1}`, status: 'todo' as const, updatedAt: NOW }] }))
  const plan: Plan = { ...activePlan('x/v1.43'), phases }
  expect(worktreePhaseOf('/w/agent-v143-p17', [plan])).toEqual({ plan: 'x/v1.43', phase: 'p17' })
  // Both tokens are required.
  expect(worktreePhaseOf('/w/agent-v143', [plan])).toBeUndefined()
  expect(worktreePhaseOf('/w/agent-p17', [plan])).toBeUndefined()
  // p1 does not match p17.
  expect(worktreePhaseOf('/w/agent-v143-p1', [plan])).toEqual({ plan: 'x/v1.43', phase: 'p1' })
  const a = attribute({ ownClaims: [], repoCandidates: [], activePlans: new Set(['x/v1.43']), cwd: '/w/agent-v143-p17', plans: [plan] })
  expect(a.confident).toEqual([{ plan: 'x/v1.43', source: 'worktree', phase: 'p17' }])
  const rec = session({ id: 's9', cwd: '/w/agent-v143-p17' })
  const map = resolveAttributions([rec], new Set(['x/v1.43']), () => [], [plan])
  expect(map.get('s9')?.confident[0]?.source).toBe('worktree')
})

// ---- C4: only progress-board sessions are counted ----

test('C4 the band counts only sessions progress-board knows', async () => {
  const p = activePlan('acme/v1')
  const conf = { confident: [{ plan: 'acme/v1', source: 'claim' as const }], speculative: [] }
  const s1: SessionView = { ...session(), isAlive: true, isSelf: true, cwdMissing: false, attribution: conf }
  const s2: SessionView = { ...session({ id: 's2' }), isAlive: true, isSelf: false, cwdMissing: false, attribution: conf }
  const snap: Snapshot = { now: NOW, selfId: 's1', focusPlan: 'acme/v1', repoPlans: ['acme/v1'], plans: [p], sessions: [s1, s2], waiting: waitingItems([p], [s1, s2]), recent: [] }
  expect(sessionsOn(snap, 'acme/v1')).toBe(2)
  const banner = buildBanner({ snap, cols: 130, glyph: '■', isWorking: false, spinner: '', now: NOW })
  expect(rowText(banner.rows[1] ?? [])).toContain('2 个会话')
})
