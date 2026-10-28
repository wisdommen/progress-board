// v0.2 Part D: the 「等你拍板」 queue — non-blocking questions queued by a model, deduplicated across
// live sessions, answered automatically when the person answers the same question.

import { expect, test } from './locale-test'

import type { SessionRec, SessionView } from '../types'
import { waitingItems } from '../hooks/model'
import { normQuestion } from '../hooks/util'
import { world } from './world'

const NOW = 1_800_000_000_000
const HOME = '/h'
const MIN = 60_000
const SESSION = `${HOME}/.claude/progress-board/sessions`
const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: '进度', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

function session(over: Partial<SessionRec> = {}): SessionRec {
  return {
    v: 1, id: 's1', kind: 'normal', startedAt: NOW - 60 * MIN, cwd: '/w/acme', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [], ...over,
  }
}
function view(s: SessionRec, over: Partial<SessionView> = {}): SessionView {
  return { ...s, isAlive: true, isSelf: s.id === 's1', cwdMissing: false, attribution: { confident: [], speculative: [] }, ...over }
}
const ask = (question: string, at = NOW, id = `q${at}`) => ({ id, question, at })
const sessionJson = (w: ReturnType<typeof world>, id = 's1'): SessionRec =>
  JSON.parse(w.files.get(`${SESSION}/${id}.json`)?.text ?? '{}') as SessionRec
function seedSessions(w: ReturnType<typeof world>, recs: SessionRec[]): void {
  w.dirs.add(`${HOME}/.claude/progress-board`)
  w.dirs.add(SESSION)
  for (const r of recs) w.files.set(`${SESSION}/${r.id}.json`, { text: JSON.stringify(r), m: NOW })
}

test('D questions are compared by normalized text: case, spaces and punctuation do not matter', async () => {
  expect(normQuestion('  用哪个库？ ')).toBe(normQuestion('用哪个库'))
  expect(normQuestion('Use Which  LIB?')).toBe(normQuestion('use which lib'))
  expect(normQuestion('用哪个库')).not.toBe(normQuestion('用哪个数据库'))
})

test('D the same question from several sessions counts once and names the others', async () => {
  const s1 = view(session({ asks: [ask('用哪个库？')] }))
  const s2 = view(session({ id: 's2', goal: '后端', asks: [ask('用哪个库', NOW - MIN)] }), { isSelf: false })
  const s3 = view(session({ id: 's3', goal: '前端', asks: [ask(' 用哪个库 ', NOW - 2 * MIN)] }), { isSelf: false })
  const w = waitingItems([], [s1, s2, s3])
  expect(w.filter(x => x.kind === 'ask').length).toBe(1)
  const one = w.find(x => x.kind === 'ask')
  expect(one && one.kind === 'ask' ? one.also : -1).toBe(2)
  // A different question is its own entry.
  const s4 = view(session({ id: 's4', asks: [ask('部署到哪台？')] }), { isSelf: false })
  expect(waitingItems([], [s1, s2, s3, s4]).filter(x => x.kind === 'ask').length).toBe(2)
})

test('D an answered question stops counting, for every session holding it', async () => {
  const s1 = view(session({ asks: [ask('用哪个库？')] }))
  const s2 = view(session({ id: 's2', asks: [ask('用哪个库')], answered: [normQuestion('用哪个库？')] }), { isSelf: false })
  expect(waitingItems([], [s1, s2]).filter(x => x.kind === 'ask').length).toBe(0)
  // Answered by id.
  const s3 = view(session({ id: 's3', asks: [ask('用哪个库？', NOW, 'q7')], answered: ['q7'] }))
  expect(waitingItems([], [s3]).filter(x => x.kind === 'ask').length).toBe(0)
})

test('D queueing a question another live session already asked answers with where it is', async ($, on) => {
  const w = world(on)
  seedSessions(w, [session({ id: 's2', goal: '后端', asks: [ask('用哪个库？', NOW - 5 * MIN)] })])
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'mcp__progress-board__progress_session', ask_user: [{ question: '用哪个库' }] } as never) as { result?: unknown }
  expect(String(r.result)).toContain('会话 后端 已在问同一问题')
  expect(sessionJson(w).asks?.[0]?.question).toBe('用哪个库')
})

test('D answering the question with AskUserQuestion clears the queued one', async ($, on) => {
  const w = world(on)
  on('tool.call', (_, e) => (e.tool === 'AskUserQuestion' ? { result: { answers: { '用哪个库？': '用 sqlite' } } } : { result: {} }) as never)
  on('command.run', () => ({ text: '' }) as never)
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: 'g', ask_user: [{ question: '用哪个库？', options: ['sqlite', 'postgres'] }] } as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  let ui = await $.ui.mount(PANE)
  let t = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(t).toContain('等你拍板')
  expect(t).toContain('用哪个库？')
  expect(t).toContain('选项：sqlite和postgres')
  await ui.unmount()
  // The person answers the same question.
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: '用哪个库？', header: 'h', options: [{ label: 'sqlite', description: '' }, { label: 'postgres', description: '' }], multiSelect: false }] } as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  ui = await $.ui.mount(PANE)
  t = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(t).not.toContain('等你拍板')
  await ui.unmount()
})

test('D the panel names the other sessions asking the same question', async ($, on) => {
  const w = world(on)
  seedSessions(w, [
    session({ goal: '统筹', asks: [ask('用哪个库？', NOW - 3 * MIN)] }),
    session({ id: 's2', goal: '后端', asks: [ask('用哪个库', NOW - MIN)] }),
    session({ id: 's3', goal: '前端', asks: [ask('用哪个库', NOW - 2 * MIN)] }),
  ])
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  const t = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
  expect(t).toContain('另有 2 个会话也在问')
  await ui.unmount()
})

