import { expect, test } from './locale-test'
import type { ModelCompleteResult } from 'claude-code'
import { seedPlan, world } from './world'
import { claim, NOW, PLAN, plan, planDir, PANE, savedPlan, seedSession, session } from './v03-fixtures'

const MIN = 60_000
const usage = { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const suggestion = { item: 'p1-1', status: 'wrapping', reason: '实现已交回', evidence: '事件显示实现完成' }
const response = (suggestions: unknown[]): ModelCompleteResult => ({ isAnswered: true, text: JSON.stringify({ suggestions }), usage })
const read = (w: ReturnType<typeof world>, file: string): any => JSON.parse(w.files.get(`${planDir}/${file}.json`)?.text ?? 'null')
const put = (w: ReturnType<typeof world>, file: string, value: unknown) => w.files.set(`${planDir}/${file}.json`, { text: JSON.stringify(value), m: w.clock.now() })

function setup(on: Parameters<typeof world>[0]) {
  const w = world(on, { coarseClock: true })
  seedPlan(w, '/h', plan({ milestones: ['开 PR', '合并'] }))
  seedSession(w, session({ kind: 'orchestrator', claims: [claim()], repoRoot: '/w/acme', repoKey: 'acme',
    steps: [{ title: '实现功能', status: 'done' }], stepLog: [{ title: '实现功能', at: NOW }], events: [{ kind: 'agent', text: '实现已交回', at: NOW }] }))
  w.modelReply = () => response([suggestion])
  on('tool.call', () => ({ result: {}, context: ['existing'] }))
  on('session.end', () => ({ sessionId: 's1' }))
  return w
}

test('L3 monitor defaults to fifteen minutes and records suggestions only, digest and daily cost', { timeoutMs: 20000 }, async ($, on) => {
  const w = setup(on)
  w.processReply = argv => argv.includes('log') ? { exitCode: 0, stdout: 'abcd implement login\n', stderr: '' } : undefined
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(14 * MIN)
  expect(w.modelCalls.length).toBe(0)
  await w.clock.advance(MIN)
  expect(w.modelCalls.length).toBe(1)
  const call = w.modelCalls[0]!
  expect(call.model).toBe('haiku'); expect(call.effort).toBe('low')
  expect(call.prompt.length <= 12000).toBe(true)
  for (const text of ['实现登录验证', '实现功能', '实现已交回', 'abcd implement login', 'claimers']) expect(call.prompt).toContain(text)
  expect(w.processCalls.find(c => c.argv.includes('log'))?.argv).toEqual(['git', 'log', '--all', `--since=${new Date(NOW).toISOString()}`, '--oneline', '-n', '20'])
  const suggestions = read(w, 'suggestions')
  expect(suggestions.length).toBe(1); expect(suggestions[0].state).toBe('open'); expect(suggestions[0].by).toBe('monitor')
  expect(read(w, 'monitor').owner).toBe('s1')
  expect(Object.values(read(w, 'monitor').dailyCost).some(n => Number(n) > 0)).toBe(true)
  expect(savedPlan(w).phases[0]!.items[0]!.status).toBe('todo')
})

test('L3 unchanged digest skips the model even with fresh activity; changed digest runs again', { timeoutMs: 20000 }, async ($, on) => {
  const w = setup(on)
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN)
  expect(w.modelCalls.length).toBe(1)
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  await w.clock.advance(15 * MIN)
  expect(w.modelCalls.length).toBe(1)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '实现另一功能' } as never)
  await w.clock.advance(15 * MIN)
  expect(w.modelCalls.length).toBe(2)
})

test('L3 active foreign owner suppresses runs and stale heartbeat allows takeover', { timeoutMs: 20000 }, async ($, on) => {
  const w = setup(on)
  put(w, 'monitor', { owner: 's2', heartbeat: NOW, dailyCost: {} })
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN)
  expect(w.modelCalls.length).toBe(0)
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  await w.clock.advance(15 * MIN)
  expect(w.modelCalls.length).toBe(0)
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  await w.clock.advance(15 * MIN)
  expect(w.modelCalls.length).toBe(1)
  expect(read(w, 'monitor').owner).toBe('s1')
})

test('L3 strict validation drops malformed and unknown suggestions, dedupes and caps five', { timeoutMs: 20000 }, async ($, on) => {
  const w = setup(on)
  const p = plan({ milestones: ['开 PR', '合并'] })
  p.phases[0]!.items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, title: `item ${i}`, status: i === 0 ? 'wrapping' : 'todo', milestone: i === 0 ? 1 : 0, updatedAt: NOW }))
  seedPlan(w, '/h', p)
  w.modelReply = () => response([
    { ...suggestion, item: 'unknown' }, { ...suggestion, item: 'i1', status: 'void' }, { ...suggestion, item: 'i1', milestone: 3 },
    { ...suggestion, item: 'i1', extra: 'not allowed' }, { ...suggestion, item: 'i1', evidence: '' }, { ...suggestion, item: 'i1', split: ['only one'] },
    { item: 'i0', status: 'todo', reason: '', evidence: 'x' }, { ...suggestion, item: 'i0', status: 'todo' },
    ...Array.from({ length: 8 }, (_, i) => ({ ...suggestion, item: `i${i + 1}` })),
  ])
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN)
  expect(read(w, 'suggestions').map((s: any) => s.item)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4'])
})

test('L3 delivery reaches the orchestrator once on a counted result, never subagents or waiting count', { timeoutMs: 20000 }, async ($, on) => {
  const w = setup(on)
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN)
  const child = await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'child' } as never)
  expect(child.context).toEqual(['existing'])
  const r = await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  expect(r.context?.join('')).toContain('check suggestions (1)')
  expect(r.context?.join('')).toContain('resolve_suggestion')
  expect((await $.tool.call({ tool: 'Read', file_path: '/a' } as never)).context?.join('') ?? '').not.toContain('check suggestions')
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const text = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(text).toContain('自动核对：上次'); expect(text).toContain('待处理建议 1 条'); expect(text).toContain('今日花费')
  expect(text).not.toContain('等你 1')
  await ui.unmount()
})

test('L3 resolve requires a rejection reason, records disposition but never applies status', { timeoutMs: 20000 }, async ($, on) => {
  const w = setup(on)
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN)
  const id = read(w, 'suggestions')?.[0]?.id ?? 'missing'
  const bad = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'resolve_suggestion', plan: PLAN, id, accepted: false } as never)
  expect(String(bad.result)).toContain('reason')
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'resolve_suggestion', plan: PLAN, id, accepted: false, reason: '证据不足' } as never)
  expect(read(w, 'suggestions')[0].state).toBe('rejected')
  expect(savedPlan(w).phases[0]!.items[0]!.status).toBe('todo')
})

test('L3 configured minimum interval runs after five minutes', { options: { monitorMinutes: 5 } }, async ($, on) => {
  const w = setup(on)
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(4 * MIN); expect(w.modelCalls.length).toBe(0)
  await w.clock.advance(MIN); expect(w.modelCalls.length).toBe(1)
})

test('L3 disabled monitor keeps existing suggestions visible without a model call', { options: { monitor: false } }, async ($, on) => {
  const w = setup(on)
  put(w, 'suggestions', [{ ...suggestion, id: 'old', created: NOW, by: 'monitor', state: 'open', cost: { usd: 0.01 } }])
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN)
  expect(w.modelCalls.length).toBe(0)
  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')).toContain('待处理建议 1 条')
  await ui.unmount()
})

test('L3 idle, headless and ended sessions make no model request; a later main activity enables it', { timeoutMs: 20000 }, async ($, on) => {
  const w = setup(on)
  seedSession(w, session({ envPlan: PLAN, lastActivity: NOW - 60 * MIN }))
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN); expect(w.modelCalls.length).toBe(0)
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  await w.clock.advance(15 * MIN); expect(w.modelCalls.length).toBe(1)
  await $.session.end({ sessionId: 's1', reason: 'exit' } as never)
  await w.clock.advance(15 * MIN); expect(w.modelCalls.length).toBe(1)
})

test('L3 failed completion is silent and stores no suggestions, later changed evidence can retry', { timeoutMs: 20000 }, async ($, on) => {
  const w = setup(on)
  w.modelReply = () => ({ isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage }) as ModelCompleteResult
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN)
  expect(w.modelCalls.length).toBe(1)
  expect(read(w, 'suggestions') ?? []).toEqual([])
  w.modelReply = () => response([suggestion])
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: '已有新证据' } as never)
  await w.clock.advance(15 * MIN)
  expect(read(w, 'suggestions').length).toBe(1)
})

test('L3 digest remains bounded with large plans and retains valid JSON', { timeoutMs: 20000 }, async ($, on) => {
  const w = setup(on)
  const p = plan()
  p.phases[0]!.items = Array.from({ length: 200 }, (_, i) => ({ id: `i${i}`, title: 'long title '.repeat(100), status: 'todo', updatedAt: NOW }))
  seedPlan(w, '/h', p)
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(15 * MIN)
  const text = w.modelCalls[0]?.prompt ?? ''
  expect(text.length > 0 && text.length <= 12000).toBe(true)
  expect(JSON.parse(text).omitted > 0).toBe(true)
})
