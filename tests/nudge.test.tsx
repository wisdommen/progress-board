// Spec §13 (live check 2026-10-27): the model reported nothing on its own. Two answers:
// a forced one-time stop of the 4th call, and a provisional goal from the person's last request.

import { expect, test } from './locale-test'
import type { On } from 'claude-code'

import type { SessionRec, SessionView, Snapshot } from '../types'
import { buildBanner, rowText } from '../hooks/banner'
import { waitingItems } from '../hooks/model'
import { ENFORCE_DENY, autoGoalLabel, autoGoalOf, callSummary, takeStepNudge } from '../hooks/nudge'
import { world, seedPlan } from './world'
import { PLAN as PLAN_ID, plan as fixturePlan } from './v03-fixtures'

const NOW = 1_800_000_000_000
const SESSION_FILE = '/h/.claude/progress-board/sessions/s1.json'
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'] as const, tools: [], outputStyle: null, traits: [] }
const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: '进度', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type Ran = { result?: unknown; context?: readonly string[]; deny?: string }

// The engine beneath: every tool answers `{ result: { out: <tool> } }`.
function engine(on: On) {
  const w = world(on)
  on('tool.call', (_, e) => ({ result: { out: e.tool } }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  return w
}

// ---- forced stop ----

const DENY = ENFORCE_DENY
const bash = ($: { tool: { call: (e: never) => Promise<unknown> } }, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command: 'x', ...(agentId ? { agentId } : {}) } as never) as Promise<Ran>

test('enforce: the 4th non-progress call without a goal is denied before it runs', async ($, on) => {
  const ran: string[] = []
  const w = world(on)
  on('tool.call', (_, e) => {
    if (e.tool === 'ListAgents') return { result: { listing: 'This session is nudge-self [aa11bb] — the name other sessions use to message it (it is not listed below).', sections: [], notes: [] } } as never
    ran.push(e.tool); return { result: { out: e.tool } } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'do it', turnId: 't1' })
  const runs: Ran[] = []
  for (let i = 0; i < 4; i++) runs.push(await bash($))
  expect(runs.slice(0, 3).every(r => r.deny === undefined)).toBe(true)
  expect(runs[3]?.deny).toBe(DENY)
  expect(ran.length).toBe(3)
  expect(JSON.parse(w.files.get(SESSION_FILE)?.text ?? '{}').enforcedAt).toBeGreaterThan(0)
})

test('enforce: never while the tools are not registered (session not bound yet), then once they are', async ($, on) => {
  const ran: string[] = []
  const w = world(on)
  w.unboundRegisters = 1_000
  on('tool.call', (_, e) => {
    if (e.tool === 'ListAgents') return { result: { listing: 'This session is nudge-self [aa11bb] — the name other sessions use to message it (it is not listed below).', sections: [], notes: [] } } as never
    ran.push(e.tool); return { result: { out: e.tool } } as never
  })
  for (let i = 0; i < 6; i++) expect((await bash($)).deny).toBeUndefined()
  expect(ran.length).toBe(6)
  expect(w.tools).toEqual([])
  w.unboundRegisters = 0
  // The next call retries registration; the tools now exist, so the one-time stop may apply.
  const r = await bash($)
  expect(w.tools.sort()).toEqual(['progress_control', 'progress_plan', 'progress_session'])
  expect(r.deny).toBe(DENY)
})

test('enforce: only once per session, across turns', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'a', turnId: 't1' })
  const runs: Ran[] = []
  for (let i = 0; i < 7; i++) runs.push(await bash($))
  expect(runs.filter(r => r.deny !== undefined).length).toBe(1)
  await $.turn.start({ text: 'b', turnId: 't2' })
  for (let i = 0; i < 5; i++) expect((await bash($)).deny).toBeUndefined()
})

test('enforce: the count is per session, not per turn', async ($, on) => {
  engine(on)
  for (let i = 0; i < 3; i++) {
    await $.turn.start({ text: 'a', turnId: `t${i}` })
    expect((await bash($)).deny).toBeUndefined()
  }
  await $.turn.start({ text: 'b', turnId: 't9' })
  expect((await bash($)).deny).toBe(DENY)
})

test('enforce: never with a formal goal; progress-board calls do not count', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'a', turnId: 't1' })
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'mcp__progress-board__progress_session', steps: [{ title: 'x', status: 'todo' }] } as never)
  for (let i = 0; i < 3; i++) expect((await bash($)).deny).toBeUndefined()
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '修复登录' } as never)
  for (let i = 0; i < 6; i++) expect((await bash($)).deny).toBeUndefined()
})

test('enforce: a subagent’s calls neither count nor are stopped', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'a', turnId: 't1' })
  for (let i = 0; i < 6; i++) expect((await bash($, 'a1')).deny).toBeUndefined()
  const main: Ran[] = []
  for (let i = 0; i < 4; i++) main.push(await bash($))
  expect(main.map(r => r.deny)).toEqual([undefined, undefined, undefined, DENY])
})

test('enforce: enforceGoal=false never stops', { options: { enforceGoal: false } }, async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'a', turnId: 't1' })
  for (let i = 0; i < 8; i++) expect((await bash($)).deny).toBeUndefined()
})

test('enforce: a session already stopped before a reload is not stopped again', async ($, on) => {
  const w = engine(on)
  w.files.set(SESSION_FILE, { m: NOW, text: JSON.stringify({
    v: 1, id: 's1', kind: 'normal', startedAt: NOW, cwd: '/w/acme', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, calls: 4, enforcedAt: NOW,
  }) })
  await $.turn.start({ text: 'a', turnId: 't1' })
  for (let i = 0; i < 6; i++) expect((await bash($)).deny).toBeUndefined()
})

// ---- provisional goal ----

test('auto goal: commands, blank input and notices are not requests; the first line is', async () => {
  expect(autoGoalOf({ text: '/progress' })).toBeUndefined()
  expect(autoGoalOf({ text: 'x', command: { name: 'progress' } as never })).toBeUndefined()
  expect(autoGoalOf({ text: '   \n ' })).toBeUndefined()
  expect(autoGoalOf({ text: '<task-notification>done</task-notification>' })).toBeUndefined()
  expect(autoGoalOf({ text: '  <system-reminder>x' })).toBeUndefined()
  expect(autoGoalOf({ text: 'hi', isMeta: true })).toBeUndefined()
  expect(autoGoalOf({ text: '\n  把登录超时修好\n细节如下' })).toBe('把登录超时修好')
})

test('auto goal: the label is about 20 display cells, with … when cut', async () => {
  expect(autoGoalLabel('把登录超时修好')).toBe('把登录超时修好')
  const long = autoGoalLabel('请把整个仓库的登录流程重构一遍并补齐测试和文档')
  expect(long.endsWith('…')).toBe(true)
  expect(long.length).toBeLessThanOrEqual(11)
})

function self(over: Partial<SessionRec> = {}): SessionView {
  return {
    v: 1, id: 's1', kind: 'normal', startedAt: NOW, cwd: '/w/acme', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [], ...over,
    isAlive: true, isSelf: true, cwdMissing: false, attribution: { confident: [], speculative: [] },
  }
}
const snapOf = (s: SessionView): Snapshot => ({ now: NOW, selfId: 's1', focusPlan: null, repoPlans: [], plans: [], sessions: [s], waiting: waitingItems([], [s]), recent: [] })
const band = (s: SessionView, cols = 120) => buildBanner({ snap: snapOf(s), cols, glyph: '■', isWorking: false, spinner: '⠋', now: NOW })

test('auto goal: the band shows it grey with （自动） when no goal is set; a formal goal replaces it', async () => {
  const b = band(self({ autoGoal: '请把整个仓库的登录流程重构一遍并补齐测试和文档' }))
  expect(b.isHidden).toBe(false)
  const row1 = b.rows[0] ?? []
  expect(rowText(row1)).toContain('请把整个仓库的登录…（自动）')
  const seg = row1.flatMap(g => g.segs).find(x => x.t.includes('（自动）'))
  expect(seg?.color).toBe('subtle')
  const steps = band(self({ autoGoal: '修登录', steps: [{ title: 'a', status: 'doing' }] }))
  expect(rowText(steps.rows[0] ?? [])).toContain('修登录（自动）')
  const formal = band(self({ autoGoal: '修登录', goal: '修复登录超时' }))
  expect(rowText(formal.rows[0] ?? [])).toContain('修复登录超时')
  expect(rowText(formal.rows[0] ?? [])).not.toContain('（自动）')
  expect(band(self()).isHidden).toBe(true)
})

test('auto goal: a new request updates it; commands and notices do not; it is no goal for the enforcement or the prompt', async ($, on) => {
  const w = world(on)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.compose', () => ({ sections: [] }) as never)
  on('command.run', () => ({ text: '' }) as never)
  const rec = () => JSON.parse(w.files.get(SESSION_FILE)?.text ?? '{}') as SessionRec
  await $.prompt.submit({ text: '把登录超时修好' } as never)
  expect(rec().autoGoal).toBe('把登录超时修好')
  await $.prompt.submit({ text: '再顺手更新文档' } as never)
  expect(rec().autoGoal).toBe('再顺手更新文档')
  await $.prompt.submit({ text: '/progress' } as never)
  await $.prompt.submit({ text: '<task-notification>x</task-notification>' } as never)
  expect(rec().autoGoal).toBe('再顺手更新文档')
  expect(rec().goal).toBeUndefined()
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.map(s => s.text).join('\n')).not.toContain('再顺手更新文档')
  await $.turn.start({ text: '', turnId: 't1' })
  const runs: Ran[] = []
  for (let i = 0; i < 4; i++) runs.push(await $.tool.call({ tool: 'Bash', command: 'x' }) as Ran)
  expect((runs[3] as Ran).deny).toBe(DENY)
  // The panel's own card shows it marked as automatic.
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /再顺手更新文档（自动）/ })).toBeDefined()
  await ui.unmount()
  // A formal goal takes its place on the card.
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '修复登录超时' } as never)
  await w.clock.advance(2000)
  const ui2 = await $.ui.mount(PANE)
  expect(await ui2.find({ type: 'Text', text: /修复登录超时/ })).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: /（自动）/ })).toBeUndefined()
  await ui2.unmount()
})

// ---- step nudge (live check 2026-10-27: 4 steps set, 15 calls, all ticked at the end) ----

const report = ($: { tool: { call: (e: never) => Promise<unknown> } }, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__progress-board__progress_session', ...input } as never) as Promise<Ran>
const STEPS = { goal: '加 --sort', steps: [{ title: '读代码', status: 'doing' }, { title: '实现', status: 'todo' }, { title: '测试', status: 'todo' }] }
const nudged = (r: Ran) => (r.context ?? []).some(c => c.includes('progress-board') && c.includes('step_updates'))

test('step nudge: after 3 calls with no report while steps are open, the reminder lists every open step by number', async ($, on) => {
  engine(on)
  await report($, STEPS)
  const runs: Ran[] = []
  for (let i = 0; i < 3; i++) runs.push(await bash($))
  expect(runs.slice(0, 2).some(nudged)).toBe(false)
  expect(nudged(runs[2] as Ran)).toBe(true)
  const text = (runs[2]?.context ?? []).join('')
  expect(text).toContain('3 operations since this session last updated its steps')
  expect(text).toContain('1 读代码 (doing)')
  expect(text).toContain('2 实现 (todo)')
  expect(text).toContain('3 测试 (todo)')
  expect(text).toContain('call progress_session step_updates')
  // The old escape hatch let the model dismiss the reminder without reporting.
  expect(text).not.toContain('ignore if nothing changed')
  expect(runs[2]?.result).toEqual({ out: 'Bash' })
})

test('step nudge: the reminder names each call since the last report, and starts over after one', async ($, on) => {
  engine(on)
  await report($, STEPS)
  await $.tool.call({ tool: 'Write', file_path: '/w/acme/src/tasks.js', content: '' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'test/tasks.test.js', content: '' } as never)
  const r = await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'run tests' } as never) as Ran
  const text = (r.context ?? []).join('\n')
  expect(text).toContain('3 operations since this session last updated its steps: Write src/tasks.js, Write test/tasks.test.js, Bash npm.')
  await report($, { step_updates: [{ index: 1, status: 'done' }, { index: 2, status: 'doing' }] })
  await $.tool.call({ tool: 'Read', file_path: 'README.md' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'docs/a.md' } as never)
  const r2 = await $.tool.call({ tool: 'Read', file_path: 'docs/b.md' } as never) as Ran
  const t2 = (r2.context ?? []).join('\n')
  expect(t2).toContain('Read README.md, Read docs/a.md, Read docs/b.md')
  expect(t2).not.toContain('Write')
  expect(t2).toContain('2 实现 (doing)')
  expect(t2).not.toContain('1 读代码')
})

test('step nudge: summaries keep the tool and its target; at most five calls and eight steps are listed', () => {
  expect(callSummary('Write', { file_path: '/w/acme/src/tasks.js' })).toBe('Write src/tasks.js')
  expect(callSummary('Edit', { file_path: 'lib/util/io.ts' })).toBe('Edit util/io.ts')
  expect(callSummary('Read', { file_path: 'README.md' })).toBe('Read README.md')
  expect(callSummary('Bash', { command: 'npm   test\n--watch=false' })).toBe('Bash npm')
  // Never any part of the command text: the record outlives the turn (review IN-04).
  expect(callSummary('Bash', { command: 'export OPENAI_API_KEY=sk-proj-secret' })).toBe('Bash export')
  expect(callSummary('Bash', { command: 'x'.repeat(80) })).toBe('Bash')
  // A leading assignment is not a program name and never enters the record.
  expect(callSummary('Bash', { command: 'TOKEN=abc123 npm test' })).toBe('Bash')
  expect(callSummary('Agent', { description: 'Review the diff' })).toBe('Agent Review the diff')
  expect(callSummary('TodoWrite', { todos: [] })).toBe('TodoWrite')
  const steps = Array.from({ length: 10 }, (_, i) => ({ title: `step${i + 1}`, status: 'todo' }))
  const s = { steps, stepsSource: 'tool', sinceReport: 3, stepNudges: 0, recentCalls: ['a', 'b', 'c', 'd', 'e', 'f'] }
  const text = takeStepNudge(s) ?? ''
  expect(text).toContain('since this session last updated its steps: b, c, d, e, f.')
  expect(text).toContain('8 step8 (todo)')
  expect(text).not.toContain('9 step9')
  expect(text).toContain(', …')
  expect(s.recentCalls).toEqual([])
})

test('step nudge: the record keeps the program name, never the command text', async ($, on) => {
  const w = engine(on)
  await $.tool.call({ tool: 'Bash', command: 'export OPENAI_API_KEY=sk-proj-secret' } as never)
  const saved = w.files.get(SESSION_FILE)?.text ?? ''
  expect(saved).not.toContain('sk-proj-secret')
  expect(JSON.parse(saved).recentCalls).toEqual(['Bash export'])
})

test('step nudge: a progress_session report resets the calls the reminder lists', async ($, on) => {
  engine(on)
  await report($, STEPS)
  await $.tool.call({ tool: 'Write', file_path: 'src/a.js', content: '' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'src/b.js', content: '' } as never)
  await report($, { step_updates: [{ index: 1, status: 'doing' }] })
  await $.tool.call({ tool: 'Read', file_path: 'x.md' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'y.md' } as never)
  const r = await $.tool.call({ tool: 'Read', file_path: 'z.md' } as never) as Ran
  const text = (r.context ?? []).join('\n')
  expect(text).toContain('Read x.md, Read y.md, Read z.md')
  expect(text).not.toContain('Write')
})

test('step nudge: a progress_plan call resets the calls the reminder lists', async ($, on) => {
  const w = engine(on); seedPlan(w, '/h', fixturePlan())
  await report($, STEPS)
  await $.tool.call({ tool: 'Write', file_path: 'src/a.js', content: '' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'src/b.js', content: '' } as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN_ID, item: 'p1-1', status: 'wrapping' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'x.md' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'y.md' } as never)
  const r = await $.tool.call({ tool: 'Read', file_path: 'z.md' } as never) as Ran
  const text = (r.context ?? []).join('\n')
  expect(text).toContain('Read x.md, Read y.md, Read z.md')
  expect(text).not.toContain('Write')
})

test('step nudge: the interval doubles while ignored, and a report resets it', async ($, on) => {
  engine(on)
  await report($, STEPS)
  const at: number[] = []
  for (let i = 1; i <= 21; i++) if (nudged(await bash($))) at.push(i)
  expect(at).toEqual([3, 9, 21])
  await report($, { step_updates: [{ index: 1, status: 'done' }, { index: 2, status: 'doing' }] })
  const after: number[] = []
  for (let i = 1; i <= 6; i++) if (nudged(await bash($))) after.push(i)
  expect(after).toEqual([3])
})

test('step nudge: never without open tool steps, for subagents, or with todo-imported steps', async ($, on) => {
  engine(on)
  await report($, { goal: 'g' })
  for (let i = 0; i < 10; i++) expect(nudged(await bash($))).toBe(false)
  await report($, { steps: [{ title: 'a', status: 'done' }] })
  for (let i = 0; i < 10; i++) expect(nudged(await bash($))).toBe(false)
  await report($, { steps: [{ title: 'a', status: 'todo' }] })
  for (let i = 0; i < 10; i++) expect(nudged(await bash($, 'agent-1'))).toBe(false)
})

test('step_updates alone answers what changed, not 没有变化', async ($, on) => {
  engine(on)
  await report($, STEPS)
  const r = await report($, { step_updates: [{ index: 1, status: 'done' }] })
  expect(String(r.result)).not.toContain('没有变化')
  expect(String(r.result)).toContain('读代码')
})

test('setting steps answers with the habit to keep: tick each step as it is done', async ($, on) => {
  engine(on)
  const r = await report($, STEPS)
  expect(String(r.result)).toContain('做完一步')
  const g = await report($, { goal: 'only a goal' })
  expect(String(g.result)).not.toContain('做完一步')
})
