import { expect, test } from './locale-test'
import { seedPlan, world } from './world'
import { claim, NOW, PLAN, plan, planDir, PANE, savedPlan, seedSession, session } from './v03-fixtures'

const MIN = 60_000
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

test('L2 set_item merges deduplicated refs without requiring a status change', async ($, on) => {
  const w = world(on, { coarseClock: true })
  seedPlan(w, '/h', plan())
  on('tool.call', () => ({ result: {} }))
  for (const refs of [{ pr: [{ repo: 'acme/app', number: 7 }], branch: ['feature/login'] }, { pr: [{ repo: 'acme/app', number: 7 }, { number: 8 }], branch: ['feature/login', 'fix/errors'] }]) {
    const r = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-1', refs } as never)
    expect(String(r.result)).not.toContain('错误')
  }
  expect(savedPlan(w).phases[0]!.items[0]!.refs).toEqual({ pr: [{ repo: 'acme/app', number: 7 }, { number: 8 }], branch: ['feature/login', 'fix/errors'] })
})

test('L2 invalid refs reject atomically instead of applying their accompanying status', async ($, on) => {
  const w = world(on, { coarseClock: true })
  seedPlan(w, '/h', plan())
  on('tool.call', () => ({ result: {} }))
  for (const refs of [{ pr: [{ number: -1 }] }, { pr: [{ number: 1, repo: '--help' }] }, { branch: ['--upload-pack=evil'] }, { branch: ['feature/*'] }]) {
    const r = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set_item', plan: PLAN, item: 'p1-1', status: 'wrapping', refs } as never)
    expect(String(r.result)).toContain('错误')
    expect(savedPlan(w).phases[0]!.items[0]!.status).toBe('todo')
  }
})

test('L2 successful gh pr create attaches a URL only to a single claimed item', async ($, on) => {
  const w = world(on, { coarseClock: true })
  seedPlan(w, '/h', plan())
  seedSession(w, session({ claims: [claim()] }))
  on('tool.call', () => ({ result: { stdout: 'https://github.com/acme/app/pull/7\n', exitCode: 0 } }))
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title test' } as never)
  expect(savedPlan(w).phases[0]!.items[0]!.refs?.pr).toEqual([{ repo: 'acme/app', number: 7 }])
})

test('L2 ambiguous claimed items create no automatic ref and explain it in the reminder', async ($, on) => {
  const w = world(on, { coarseClock: true })
  seedPlan(w, '/h', plan())
  seedSession(w, session({ claims: [claim(), claim('p1-2')] }))
  on('tool.call', () => ({ result: 'https://github.com/acme/app/pull/7' }))
  const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create' } as never)
  expect(r.context?.join('')).toContain('多个条目')
  expect(savedPlan(w).phases[0]!.items.every(i => !i.refs)).toBe(true)
})

for (const mode of ['open', 'merged', 'last', 'opt-in']) {
  test(`L2 five-minute poll applies ${mode} facts and logs as automatic verification`, async ($, on) => {
    const w = world(on, { coarseClock: true })
    const p = plan({ milestones: mode === 'last' ? ['开 PR', '合并'] : ['开 PR', '合并', '部署'], ...(mode === 'opt-in' ? { auto_done_on_merge: true } : {}) })
    p.phases[0]!.items[0]!.refs = { pr: [{ repo: 'acme/app', number: 7 }] }
    seedPlan(w, '/h', p)
    seedSession(w, session({ claims: [claim()] }))
    w.processReply = argv => argv[0] === 'gh' ? ok(JSON.stringify({ state: mode === 'open' ? 'OPEN' : 'MERGED', mergedAt: mode === 'open' ? null : '2026-10-27', isDraft: false })) : undefined
    await $.command.run({ command: 'progress', args: '' } as never)
    await w.clock.advance(5 * MIN)
    const item = savedPlan(w).phases[0]!.items[0]!
    expect(item.status).toBe(mode === 'open' ? 'todo' : mode === 'merged' ? 'wrapping' : 'done')
    expect(item.milestone).toBe(mode === 'open' ? 1 : mode === 'opt-in' ? 3 : 2)
    expect(w.files.get(`${planDir}/log.jsonl`)?.text).toContain('自动核对')
    expect(w.files.get(`${planDir}/checks.json`)?.text).toContain('lastCheckedAt')
    const calls = w.processCalls.filter(c => c.argv[0] === 'gh')
    expect(calls.length).toBe(1)
    expect(calls[0]!.argv).toEqual(['gh', 'pr', 'view', '7', '--repo', 'acme/app', '--json', 'state,mergedAt,isDraft'])
    if (mode !== 'open') {
      await $.command.run({ command: 'progress', args: '' } as never)
      const ui = await $.ui.mount(PANE)
      expect((await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')).toContain('最近完成')
      await ui.unmount()
    }
  })
}

test('L2 default merge stays wrapping without milestones; shared fresh check suppresses a duplicate query', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const p = plan()
  for (const it of p.phases[0]!.items.slice(0, 2)) it.refs = { pr: [{ repo: 'acme/app', number: 9 }] }
  seedPlan(w, '/h', p)
  seedSession(w, session({ claims: [claim()] }))
  w.processReply = argv => argv[0] === 'gh' ? ok('{"state":"MERGED","mergedAt":"now","isDraft":false}') : undefined
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(5 * MIN)
  expect(savedPlan(w).phases[0]!.items.slice(0, 2).map(i => i.status)).toEqual(['wrapping', 'wrapping'])
  expect(w.processCalls.filter(c => c.argv[0] === 'gh').length).toBe(1)
  await w.clock.advance(MIN)
  expect(w.processCalls.filter(c => c.argv[0] === 'gh').length).toBe(1)
})

test('L2 branch facts run from a matching repository root and infer a merged PR', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const p = plan({ repos: ['/w/acme'], milestones: ['开 PR', '合并'] })
  p.phases[0]!.items[0]!.refs = { branch: ['feature/login'] }
  p.phases[0]!.items[0]!.branchAddedAt = { 'feature/login': NOW }
  seedPlan(w, '/h', p)
  seedSession(w, session({ claims: [claim()], repoRoot: '/w/acme', repoKey: 'acme' }))
  w.processReply = argv => argv.includes('ls-remote') ? ok(`${'a'.repeat(40)}\trefs/heads/feature/login\n`) : argv[0] === 'gh' ? ok(JSON.stringify([{ number: 9, headRefName: 'feature/login', headRefOid: 'a'.repeat(40), mergedAt: new Date(NOW + MIN).toISOString() }])) : undefined
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(5 * MIN)
  expect(savedPlan(w).phases[0]!.items[0]!.status).toBe('done')
  const ls = w.processCalls.find(c => c.argv.includes('ls-remote'))
  expect(ls?.argv).toEqual(['git', 'ls-remote', '--heads', 'origin', 'feature/login'])
  expect(ls?.cwd).toBe('/w/acme')
})

test('L2 propose and set expose opt-in auto completion with a false legacy default', async ($, on) => {
  const w = world(on, { coarseClock: true })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'propose', plan: PLAN, goal: 'g', criteria: 'c', phases: [{ name: 'work', items: ['a'] }], auto_done_on_merge: true } as never)
  expect(savedPlan(w).auto_done_on_merge).toBe(true)
  await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'set', plan: PLAN, auto_done_on_merge: false } as never)
  expect(savedPlan(w).auto_done_on_merge).toBe(false)
})

test('L2 closed, draft, failures and terminal items never move; unrelated plans are not polled', async ($, on) => {
  const w = world(on, { coarseClock: true })
  const p = plan({ milestones: ['开 PR', '合并'] })
  p.phases[0]!.items = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, title: `item ${i}`, status: i === 4 ? 'done' : i === 5 ? 'void' : 'wrapping', milestone: 1, updatedAt: NOW, refs: { pr: [{ repo: 'acme/app', number: i + 1 }] } }))
  seedPlan(w, '/h', p)
  const other = plan({ id: 'other/v1' }); other.phases[0]!.items[0]!.refs = { pr: [{ repo: 'other/app', number: 99 }] }; seedPlan(w, '/h', other)
  seedSession(w, session({ envPlan: PLAN }))
  w.processReply = argv => argv[0] === 'gh' ? argv[3] === '3' ? { exitCode: 127, stdout: '', stderr: 'missing' } : ok(JSON.stringify({ state: argv[3] === '1' ? 'CLOSED' : 'OPEN', isDraft: argv[3] === '2', mergedAt: null })) : undefined
  await $.command.run({ command: 'progress', args: '' } as never)
  await w.clock.advance(5 * MIN)
  expect(w.files.has(`${planDir}/checks.json`)).toBe(true)
  expect(savedPlan(w).phases).toEqual(p.phases)
  expect(w.processCalls.filter(c => c.argv[0] === 'gh').map(c => c.argv[3])).toEqual(['1', '2', '3', '4'])
})
