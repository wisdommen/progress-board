import { expect, enTest as test } from './locale-test'
import { world } from './world'
import { session, seedSession, ROOT } from './v03-fixtures'

function setup(on: any) {
  const w = world(on)
  seedSession(w, session())
  w.dirs.add('/w/acme/.planning')
  w.files.set('/w/acme/.planning/ROADMAP.md', { text: '# Demo\n## Phase 1: Build\n- [ ] Add the endpoint\n- [x] Write the specification\n', m: w.clock.now() })
  on('command.run', () => ({ text: '' })); on('tool.call', () => ({ result: {} }))
  return w
}

test('V05 progress_plan import exposes schema fields and creates an unapproved draft', async ($, on) => {
  const w = setup(on)
  await $.command.run({ command: 'progress', args: '' } as never)
  const result = await $.tool.call({ tool: 'mcp__progress-board__progress_plan', action: 'import', plan: 'acme/imported', source: 'gsd' } as never)
  const raw = w.files.get(`${ROOT}/plans/acme%2Fimported/plan.json`)
  expect(raw).toBeDefined()
  const p = JSON.parse(raw!.text)
  expect(p.status).toBe('draft'); expect(p.approval).toBeUndefined()
  expect(p.phases[0].items.length).toBe(2)
  expect(String(result.result)).toContain('acme/imported')
})

test('V05 progress import detects GSD and repeated imports reconcile rather than duplicating drafts', async ($, on) => {
  const w = setup(on)
  const first = await $.command.run({ command: 'progress', args: 'import gsd' } as never)
  const before = [...w.files].filter(([path]) => path.endsWith('/plan.json'))
  expect(before.length).toBe(1); expect(first.text).toContain('Imported')
  await $.command.run({ command: 'progress', args: 'import gsd' } as never)
  const after = [...w.files].filter(([path]) => path.endsWith('/plan.json'))
  expect(after.length).toBe(1)
  expect(JSON.parse(after[0]![1].text).status).toBe('draft')
})
