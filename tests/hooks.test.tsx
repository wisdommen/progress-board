// Hook-level tests through the engine: lazy start after a mid-session reload (21), and the
// recording paths the review found (2: question answers; 8: env export; 20: own missing directory).

import { expect, test } from './locale-test'

import { newPlan } from '../hooks/model'
import { seedPlan, world } from './world'

const NOW = 1_800_000_000_000
const SESSION_FILE = '/h/.claude/progress-board/sessions/s1.json'
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'] as const, tools: [], outputStyle: null, traits: [] }
const BAND = {
  plugin: 'progress-board', component: 'AbovePrompt', requestId: 'band', surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: '进度', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const activePlan = (id: string) => ({ ...newPlan({ id, goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['a'] }], includeRelease: false, by: 'x', now: NOW }), status: 'active' })

// ---- 21: a reload mid-session never runs session.start on the new code ----

test('21 a tool call without session.start initializes: tools, command and session file', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(w.tools.sort()).toEqual(['progress_control', 'progress_plan', 'progress_session'])
  expect(w.commands).toEqual(['progress'])
  expect(w.files.has(SESSION_FILE)).toBe(true)
})

test('22 a lazy start before the terminal attaches (no surfaces yet) still records the session', async ($, on) => {
  // Real engine: classic.SessionStart runs before session.start, while $.session.surfaces() is still [].
  const w = world(on, { surfaces: [] })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(w.tools.sort()).toEqual(['progress_control', 'progress_plan', 'progress_session'])
  expect(w.files.has(SESSION_FILE)).toBe(true)
})

test('21 a band render without session.start initializes', async ($, on) => {
  const w = world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount(BAND)
  await w.clock.settle()
  await ui.unmount()
  expect(w.tools.length).toBe(3)
  expect(w.files.has(SESSION_FILE)).toBe(true)
})

test('21 prompt.compose without session.start initializes and adds the guide', async ($, on) => {
  const w = world(on)
  on('prompt.compose', () => ({ sections: [] }) as never)
  const r = await $.prompt.compose(COMPOSE)
  expect(r.sections.some(s => s.id === 'progress-board:guide')).toBe(true)
  expect(w.commands).toEqual(['progress'])
  expect(w.files.has(SESSION_FILE)).toBe(true)
})

test('21 registration happens once, and a refused (already registered) one does not stop the start', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/w/acme', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  expect(w.tools.length).toBe(3)
  expect(w.commands.length).toBe(1)
})

test('21 refused registrations still record the session', async ($, on) => {
  const w = world(on)
  w.denyRegister = true
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(w.files.has(SESSION_FILE)).toBe(true)
})

// ---- 2: answering a question is approval only when it is about this plan and says yes ----

test('2 an AFK-resolved or unrelated question does not activate a proposed plan; an affirmative one about it does', async ($, on) => {
  const w = world(on)
  let answer: Record<string, unknown> = { answers: {}, afkTimeoutMs: 30_000 }
  on('tool.call', (_, e) => (e.tool === 'AskUserQuestion' ? { result: answer } : { result: {} }) as never)
  const ask = (question: string) => $.tool.call({ tool: 'AskUserQuestion', questions: [{ question, header: 'h', options: [{ label: '采纳', description: '' }, { label: '先不', description: '' }], multiSelect: false }] } as never)
  const propose = (plan: string) => $.tool.call({
    tool: 'mcp__progress-board__progress_plan', action: 'propose', plan, goal: 'g', criteria: 'c', phases: [{ name: 'A' }], approval: { kind: 'question' },
  } as never)
  const status = (plan: string) => JSON.parse(w.files.get(`/h/.claude/progress-board/plans/${encodeURIComponent(plan)}/plan.json`)?.text ?? '{}').status
  await ask('acme/v2 可以开始吗？')
  await propose('acme/v2')
  expect(status('acme/v2')).toBe('draft')
  answer = { answers: { '用哪个库？': '采纳' } }
  await ask('用哪个库？')
  await propose('acme/v3')
  expect(status('acme/v3')).toBe('draft')
  answer = { answers: { 'acme/v4 可以开始吗？': '采纳' } }
  await ask('acme/v4 可以开始吗？')
  await propose('acme/v4')
  expect(status('acme/v4')).toBe('active')
})

// ---- 8: export follows the current claims, and exports nothing when ambiguous ----

test('8 claiming two plans unsets PROGRESS_BOARD_PLAN; releasing one exports the other', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', activePlan('acme/a'))
  seedPlan(w, '/h', activePlan('acme/b'))
  on('tool.call', () => ({ result: {} }))
  const session = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__progress-board__progress_session', ...input } as never)
  await session({ claim: [{ plan: 'acme/a' }] })
  expect(w.env['PROGRESS_BOARD_PLAN']).toBe('acme/a')
  await session({ claim: [{ plan: 'acme/b' }] })
  expect(w.env['PROGRESS_BOARD_PLAN']).toBeUndefined()
  await session({ release: [{ plan: 'acme/a' }] })
  expect(w.env['PROGRESS_BOARD_PLAN']).toBe('acme/b')
})

test('7 an injected inherited plan id is not exported', async ($, on) => {
  const w = world(on, { env: { PROGRESS_BOARD_PLAN: 'acme/v2$(printf INJECTED)', CLAUDE_ENV_FILE: '/h/env.sh' } })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const text = w.files.get('/h/env.sh')?.text ?? ''
  expect(text).not.toContain('INJECTED')
  expect(text).toContain("export PROGRESS_BOARD_PARENT='s1'")
  expect(w.env['PROGRESS_BOARD_PLAN']).toBeUndefined()
})

// ---- 20: the current session's own deleted directory is shown ----

test('20 the panel marks this session’s deleted start directory', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '修复登录' } as never)
  w.missing.add('/w/acme')
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /目录已不存在/ })).toBeDefined()
  await ui.unmount()
})

// ---- live check 2026-10-27 (plan + panel) ----

const namedPlan = (id: string) => ({ ...newPlan({ id, goal: 'g', criteria: 'c', phases: [{ name: '补齐功能', items: ['实现 --min-len'] }], includeRelease: false, by: 'x', now: NOW }), status: 'active' })

test('release by phase name and item title drops a claim recorded by ids', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', namedPlan('acme/v1'))
  on('tool.call', () => ({ result: {} }))
  const session = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__progress-board__progress_session', ...input } as never) as Promise<{ result?: unknown }>
  await session({ claim: [{ plan: 'acme/v1', phase: '补齐功能', item: '实现 --min-len' }] })
  const r = await session({ release: [{ plan: 'acme/v1', phase: '补齐功能', item: '实现 --min-len' }] })
  expect(String(r.result)).not.toContain('没有可放弃')
  expect(JSON.parse(w.files.get(SESSION_FILE)?.text ?? '{}').claims).toEqual([])
})

test('the panel names claimed phases and items, not their ids', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', namedPlan('acme/v1'))
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: 'g', claim: [{ plan: 'acme/v1', phase: '补齐功能', item: '实现 --min-len' }] } as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /认领 acme\/v1 › 补齐功能 › 实现 --min-len/ })).toBeDefined()
  await ui.unmount()
})

test('a session that already used the plan tool is not stopped for a goal', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', namedPlan('acme/v1'))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'add_items', plan: 'acme/v1', phase: '补齐功能', items: ['x'] } as never)
  const runs: { deny?: string }[] = []
  for (let i = 0; i < 6; i++) runs.push(await $.tool.call({ tool: 'Bash', command: 'ls' }) as { deny?: string })
  expect(runs.every(r => r.deny === undefined)).toBe(true)
})

test('after finishing and releasing its item, the session still shows the plan it worked on (no repo index to fall back on)', async ($, on) => {
  const w = world(on, { cwd: '/tmp/demo' })
  seedPlan(w, '/h', { ...newPlan({ id: 'acme/v1', goal: 'g', criteria: 'c', phases: [{ name: 'A', items: ['a', 'b'] }], includeRelease: false, by: 'x', now: NOW }), status: 'active' })
  on('tool.call', () => ({ result: {} }))
  const call = (input: Record<string, unknown>) => $.tool.call(input as never)
  await call({ tool: 'mcp__progress-board__progress_session', goal: 'g', claim: [{ plan: 'acme/v1', item: 'a' }] })
  await w.clock.advance(1000)
  await call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: 'acme/v1', item: 'a', status: 'done', meets_criteria: true })
  await w.clock.advance(1000)
  await call({ tool: 'mcp__progress-board__progress_session', release: [{ plan: 'acme/v1', item: 'a' }] })
  await w.clock.advance(5000)
  await w.clock.settle()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeDefined()
  await ui.unmount()
})

// ---- parallel phases (live: a dispatcher works phases out of order) ----

function parallelPlan() {
  const p = newPlan({ id: 'acme/v2', goal: 'g', criteria: 'c', includeRelease: false, by: 'x', now: NOW,
    phases: [{ name: '一', items: ['a1', 'a2'] }, { name: '二', items: ['b1', 'b2', 'b3'] }, { name: '三', items: ['c1', 'c2'] }, { name: '四', items: ['d1'] }] })
  const set = (pi: number, ii: number, status: 'done' | 'wrapping') => { const it = p.phases[pi]?.items[ii]; if (it) { it.status = status; it.doneAt = NOW } }
  set(0, 0, 'done'); set(0, 1, 'done'); set(1, 1, 'done'); set(2, 0, 'done')
  return { ...p, status: 'active' as const }
}
const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

test('panel: any phase can be expanded or collapsed by pressing it; parallel progress is visible', async ($, on) => {
  const w = world(on)
  const plan = parallelPlan()
  seedPlan(w, '/h', plan)
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: 'g', claim: [{ plan: 'acme/v2' }] } as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  let ui = await $.ui.mount(PANE)
  let t = await texts(ui)
  // The first unfinished phase (二) is open by default; 三 is not.
  expect(t).toContain('b1')
  expect(t).not.toContain('c2')
  const p3 = plan.phases[2]?.id ?? ''
  await ui.press({ plugin: 'progress-board', key: `phase-${p3}` })
  await w.clock.advance(2000)
  await ui.unmount()
  ui = await $.ui.mount(PANE)
  t = await texts(ui)
  expect(t).toContain('c2')
  // Pressing an open phase collapses it.
  const p2 = plan.phases[1]?.id ?? ''
  await ui.press({ plugin: 'progress-board', key: `phase-${p2}` })
  await w.clock.advance(2000)
  await ui.unmount()
  ui = await $.ui.mount(PANE)
  t = await texts(ui)
  expect(t).not.toContain('b1')
  expect(t).toContain('c2')
  await ui.unmount()
})

test('panel: a phase where another session works an item is open by default', async ($, on) => {
  const w = world(on)
  const plan = parallelPlan()
  seedPlan(w, '/h', plan)
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: 'g', claim: [{ plan: 'acme/v2', item: 'c2' }] } as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const t = await texts(ui)
  expect(t).toContain('b1')
  expect(t).toContain('◐ c2')
  await ui.unmount()
})

test('panel: no button to open PLAN.md (it did nothing inside a terminal session)', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', parallelPlan())
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: 'g', claim: [{ plan: 'acme/v2' }] } as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', key: 'open' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
  await ui.unmount()
})
