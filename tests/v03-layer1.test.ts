import { expect, test } from './locale-test'
import { planSpec, sessionSpec } from '../hooks/tools'
import { seedPlan, world } from './world'
import { claim, NOW, PLAN, plan, ROOT, savedSession, seedSession, session } from './v03-fixtures'

for (const command of ['git push origin feature', 'gh pr create --title x', 'gh pr merge 12', 'gh pr ready 12', 'git merge feature', 'git tag v1']) {
  test(`L1 signal ${command} records an event and reminds the claimed item`, async ($, on) => {
    const w = world(on)
    seedPlan(w, '/h', plan())
    seedSession(w, session({ claims: [claim()] }))
    on('tool.call', () => ({ result: {} }))
    const r = await $.tool.call({ tool: 'Bash', command } as never)
    expect(r.context?.join('')).toContain(`may have advanced plan ${PLAN}`)
    expect(r.context?.join('')).toContain('实现登录验证')
    expect(savedSession(w).events?.length).toBe(1)
  })
}

test('L1 reminders throttle three calls, defer events and suppress two calls after plan reports', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', plan())
  seedSession(w, session({ claims: [claim()] }))
  on('tool.call', () => ({ result: {}, context: ['existing'] }))
  const run = (command = 'git push') => $.tool.call({ tool: 'Bash', command } as never)
  expect((await run()).context?.join('')).toContain('may have advanced')
  expect((await run()).context).toEqual(['existing'])
  expect((await run('pwd')).context).toEqual(['existing'])
  expect((await run('pwd')).context?.join('')).toContain('may have advanced')
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-2', status: 'wrapping' } as never)
  expect((await run()).context).toEqual(['existing'])
  expect((await run('pwd')).context).toEqual(['existing'])
  expect((await run('pwd')).context?.join('')).toContain('may have advanced')
})

test('L1 exact item id and long title candidates exclude short titles and finished items', async ($, on) => {
  const w = world(on)
  const p = plan()
  p.phases[0]!.items[1]!.status = 'done'
  seedPlan(w, '/h', p)
  seedSession(w, session({ envPlan: PLAN }))
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'Bash', command: 'git push origin p1-1 文档 完善错误处理' } as never)
  expect(r.context?.join('')).toContain('实现登录验证')
  expect(r.context?.join('')).not.toContain('完善错误处理')
  expect(r.context?.join('')).not.toContain('候选条目：文档')
})

test('L1 current branch supplies a candidate without a claim', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', plan())
  seedSession(w, session({ envPlan: PLAN }))
  w.processReply = argv => argv.join(' ') === 'git branch --show-current' ? { exitCode: 0, stdout: 'feature/p1-2\n', stderr: '' } : undefined
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(r.context?.join('')).toContain('完善错误处理')
})

test('L1 sync Agent return reminds its description before its automatic claim is released', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', plan())
  seedSession(w, session({ envPlan: PLAN }))
  on('tool.call', () => ({ result: { status: 'completed' } }))
  await $.command.run({ command: 'progress', args: '' } as never)
  const r = await $.tool.call({ tool: 'Agent', description: '实现登录验证', prompt: '实现任务' } as never)
  expect(r.context?.join('')).toContain('实现登录验证')
  expect(savedSession(w).events?.[0]?.kind).toBe('agent')
})

test('L1 notifications and session messages defer reminders without becoming user input', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', plan())
  seedSession(w, session({ claims: [claim()] }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('session.receive', () => ({ consumed: 'test' }) as never)
  on('tool.call', () => ({ result: {} }))
  await $.prompt.submit({ text: '<task-notification><status>completed</status>实现完成</task-notification>', isMeta: true, origin: { kind: 'task-notification' } } as never)
  expect((await $.tool.call({ tool: 'Read', file_path: '/tmp/a' } as never)).context?.join('')).toContain('may have advanced')
  await $.session.receive({ text: '实现登录验证已交回', origin: { kind: 'peer' } } as never)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a' } as never)
  expect((await $.tool.call({ tool: 'Read', file_path: '/tmp/a' } as never)).context?.join('')).toContain('session message')
  expect(savedSession(w).events?.map(e => e.kind)).toEqual(['task', 'message'])
  expect(savedSession(w).lastUserInput).toBe(NOW)
})

test('L1 ring keeps thirty events; subagent, async launch and unrelated calls add none', async ($, on) => {
  const w = world(on)
  seedSession(w, session())
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'a1' } }))
  for (let i = 0; i < 32; i++) await $.tool.call({ tool: 'Bash', command: `git push origin b${i}` } as never)
  await $.tool.call({ tool: 'Bash', command: 'git push', agentId: 'child' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  await $.tool.call({ tool: 'Agent', description: 'async', prompt: 'task' } as never)
  const s = savedSession(w)
  expect(s.events?.length).toBe(30)
  expect(s.events?.[0]?.text).toContain('b2')
  expect(s.events?.at(-1)?.text).toContain('b31')
})

test('L1 unclaimed repository work is reminded once after eight calls, not orchestrators', async ($, on) => {
  const w = world(on)
  seedPlan(w, '/h', plan())
  seedSession(w, session({ repoKey: 'acme', repoRoot: '/w/acme' }))
  w.files.set(`${ROOT}/repos/acme.json`, { text: JSON.stringify({ root: '/w/acme', plans: { [PLAN]: { count: 1, lastAt: NOW } } }), m: NOW })
  on('tool.call', () => ({ result: {} }))
  for (let i = 0; i < 7; i++) expect((await $.tool.call({ tool: 'Read', file_path: '/a' } as never)).context?.join('') ?? '').not.toContain('没认领')
  expect((await $.tool.call({ tool: 'Read', file_path: '/a' } as never)).context?.join('')).toContain(`has not claimed items in plan ${PLAN}`)
  expect((await $.tool.call({ tool: 'Read', file_path: '/a' } as never)).context?.join('') ?? '').not.toContain('没认领')
  expect(savedSession(w).unclaimedNudged).toBe(true)
})

test('L1 worker duty is present in both tools and composed prompt', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [] }))
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  for (const text of [sessionSpec.description, planSpec.description, r.sections.map(s => s.text).join('')]) {
    expect(text).toContain('This session must update items it claims or was assigned')
    expect(text).toContain('PROGRESS_BOARD_PLAN')
  }
})
