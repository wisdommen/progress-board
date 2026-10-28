import { expect, enTest as test } from './locale-test'
import type { EngineInterface } from 'claude-code'
import { importSource } from '../hooks/importers'
import { MemIo } from './memio'
import { Paths } from '../hooks/store'
import { plan, NOW } from './v03-fixtures'
function engineFor(io: MemIo, cwd = '/w/acme'): EngineInterface {
  return { session: { cwd: async () => cwd }, fs: { stat: async (path: string) => {
    const f = io.files.get(path)
    if (!f && path !== cwd && ![...io.files.keys()].some(p => p.startsWith(path + '/'))) throw new Error('ENOENT')
    return { kind: f ? 'file' : 'dir', realPath: path, isLink: false, size: f?.text.length ?? 0, mtimeMs: 1 }
  } }, process: { run: async (argv: readonly string[]) => ({ exitCode: argv[0] === 'git' ? 128 : 0, stdout: argv[0] === 'git' ? '' : JSON.stringify([[{ number: 1, title: 'Work', state: 'open', milestone: { number: 1 } }]]), stderr: '' }) } } as unknown as EngineInterface
}

test('V05 plan-mode accepts a conventional numbered implementation plan without checkboxes', async () => {
  const io = new MemIo(), paths = Paths.forHome('/h'); io.clock = NOW
  await io.writeAtomic('/w/acme/plan.md', '# Endpoint change\n## Implementation\n1. Update the route\n2. Add regression tests\n\n```sh\n3. not a task\n```\n')
  const result = await importSource(engineFor(io), io, paths, { cwd: '/w/acme', sessionId: 's1', source: 'plan-mode', path: 'plan.md' })
  expect(result.plan?.phases.flatMap(p => p.items).map(i => i.title)).toEqual(['Update the route', 'Add regression tests'])
})

test('V05 import cannot silently add source phases to an already active non-imported plan', async () => {
  const io = new MemIo(), paths = Paths.forHome('/h'); io.clock = NOW
  const existing = plan(); await io.writeAtomic(paths.planJson(existing.id), JSON.stringify(existing))
  await io.writeAtomic('/w/acme/TODO.md', '# New scope\n## Extra\n- [ ] New task\n')
  const before = await io.read(paths.planJson(existing.id))
  const result = await importSource(engineFor(io), io, paths, { cwd: '/w/acme', sessionId: 's1', source: 'markdown', path: 'TODO.md', planId: existing.id })
  expect(result.plan).toBeUndefined(); expect(await io.read(paths.planJson(existing.id))).toBe(before)
})

test('V05 import generates a valid project-prefixed plan id when cwd contains spaces or non-ASCII', async () => {
  const io = new MemIo(), paths = Paths.forHome('/h'); io.clock = NOW
  await io.writeAtomic('/w/My App/TODO.md', '# Work\n- [ ] A task\n')
  const result = await importSource(engineFor(io, '/w/My App'), io, paths, { cwd: '/w/My App', sessionId: 's1', path: 'TODO.md' })
  expect(result.plan?.id).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
})

test('V05 explicit GitHub owner/repo path is used instead of the unrelated current repository', async () => {
  const io = new MemIo(), paths = Paths.forHome('/h'); io.clock = NOW
  const result = await importSource(engineFor(io), io, paths, { cwd: '/w/acme', sessionId: 's1', source: 'github', path: 'owner/project' })
  expect(result.plan?.source?.repo).toBe('owner/project')
})
