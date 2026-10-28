// A fake world beneath the plugin for hook-level tests: an in-memory file system, the few
// processes the store runs (mv, mkdir, rm, append, tail, $PPID, git), env, session and registrations.

import { mock } from 'claude-code/testing'
import { bundled } from '../hooks/i18n'
import type { MockClock } from 'claude-code/testing'
import type { EngineInterface, ModelCompleteInput, ModelCompleteRequest, ModelCompleteResult, On, SessionMessage } from 'claude-code'

export type World = {
  store: Map<string, unknown>
  toasts: string[]
  files: Map<string, { text: string; m: number }>
  dirs: Set<string>
  missing: Set<string>
  env: Record<string, string | undefined>
  tools: string[]
  commands: string[]
  messages: SessionMessage[]
  clock: MockClock
  denyRegister: boolean
  /** Registrations refused as unbound before they succeed (the engine rejects until the session binds). */
  unboundRegisters: number
  modelCalls: ModelCompleteInput[]
  modelReply: (input: ModelCompleteInput) => ModelCompleteResult | Promise<ModelCompleteResult>
  processCalls: { argv: readonly string[]; cwd?: string }[]
  processReply?: (argv: readonly string[], cwd?: string) => { exitCode: number; stdout: string; stderr: string } | undefined
}

export type WorldOptions = { sessionId?: string; cwd?: string; home?: string; env?: Record<string, string>; now?: number; surfaces?: string[]; coarseClock?: boolean }

export function world(on: On, opts: WorldOptions = {}): World {
  const home = opts.home ?? '/h'
  if (opts.coarseClock) {
    on('clock.every', { ms: 200 }, (_, e, next) => next({ ...e, ms: 60_000 }))
    // Long cadence tests do not need six UI refreshes per virtual minute.
    on('clock.every', { ms: 10_000 }, (_, e, next) => next({ ...e, ms: 60_000 }))
  }
  const clock = mock.clock(on, { now: opts.now ?? 1_800_000_000_000 })
  const w: World = {
    store: new Map(), toasts: [], files: new Map(), dirs: new Set([home]), missing: new Set(), env: { HOME: home, ...(opts.env ?? {}) },
    tools: [], commands: [], messages: [], clock, denyRegister: false, unboundRegisters: 0, processCalls: [], modelCalls: [],
    modelReply: () => ({ isAnswered: true, text: '{"suggestions":[]}', usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
  }
  const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`)
  const parentsOf = (p: string) => {
    const parts = p.split('/')
    for (let i = 2; i < parts.length; i++) w.dirs.add(parts.slice(0, i).join('/'))
  }
  const put = (p: string, text: string) => {
    parentsOf(p)
    w.files.set(p, { text, m: clock.now() })
  }
  const remove = (p: string) => {
    for (const k of [...w.files.keys()]) if (under(k, p)) w.files.delete(k)
    for (const k of [...w.dirs]) if (under(k, p)) w.dirs.delete(k)
  }
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
  const fail = (code = 1, stderr = 'failed') => ({ value: { exitCode: code, stdout: '', stderr } })
  const h = on as unknown as (event: string, hook: (...a: never[]) => unknown) => void

  h('fs.read', ((_: unknown, e: { path: string }) => {
    const catalog = /\/locales\/([^/]+)\.json$/.exec(e.path)
    const built = catalog ? bundled[catalog[1]!] : undefined
    if (built && !e.path.startsWith(`${home}/.claude/`)) return { value: JSON.stringify(built) }
    const f = w.files.get(e.path)
    return f ? { value: f.text } : { deny: `ENOENT ${e.path}` }
  }) as never)
  h('fs.write', ((_: unknown, e: { path: string; text: string }) => {
    put(e.path, e.text)
    return { value: undefined }
  }) as never)
  h('fs.exists', ((_: unknown, e: { path: string }) => {
    if (e.path === '/proc/self') return { value: false }
    if (w.missing.has(e.path)) return { value: false }
    return { value: w.files.has(e.path) || w.dirs.has(e.path) || e.path === (opts.cwd ?? '/w/acme') }
  }) as never)
  h('fs.stat', ((_: unknown, e: { path: string; resolve?: boolean }) => {
    // Resolved stats mirror the host: existing files and implicit parent folders
    // have realPath; absent paths never get a fabricated canonical location.
    const real = e.resolve ? { realPath: e.path } : {}
    const f = w.files.get(e.path)
    if (f) return { value: { kind: 'file', size: f.text.length, mtimeMs: f.m, isLink: false, ...real } }
    if (w.dirs.has(e.path) || e.path === (opts.cwd ?? '/w/acme') || [...w.files.keys()].some(path => path.startsWith(`${e.path}/`))) return { value: { kind: 'dir', size: 0, mtimeMs: clock.now(), isLink: false, ...real } }
    return { deny: `ENOENT ${e.path}` }
  }) as never)
  h('fs.list', ((_: unknown, e: { path: string }) => {
    const prefix = `${e.path.replace(/\/+$/, '')}/`
    const out = new Map<string, { name: string; kind: string; size: number; mtimeMs: number }>()
    for (const [p, f] of w.files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const name = rest.split('/')[0] ?? ''
      out.set(name, { name, kind: rest.includes('/') ? 'dir' : 'file', size: f.text.length, mtimeMs: rest.includes('/') ? 0 : f.m })
    }
    for (const d of w.dirs) {
      if (!d.startsWith(prefix)) continue
      const name = d.slice(prefix.length).split('/')[0] ?? ''
      if (!out.has(name)) out.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0 })
    }
    return { value: [...out.values()] }
  }) as never)
  h('process.run', ((_: unknown, e: { argv: readonly string[]; init?: { stdin?: string; cwd?: string } }) => {
    w.processCalls.push({ argv: e.argv, ...(e.init?.cwd ? { cwd: e.init.cwd } : {}) })
    const reply = w.processReply?.(e.argv, e.init?.cwd)
    if (reply) return { value: reply }
    const [cmd, a, b, , d] = e.argv
    if (cmd === 'mv') {
      const f = w.files.get(b ?? '')
      if (!f) return fail()
      w.files.delete(b ?? '')
      put(e.argv[3] ?? '', f.text)
      return ok()
    }
    if (cmd === 'mkdir' && a === '-p') { w.dirs.add(b ?? ''); parentsOf(`${b}/x`); return ok() }
    if (cmd === 'mkdir') {
      if (w.dirs.has(a ?? '') || w.files.has(a ?? '')) return fail(1, 'File exists')
      w.dirs.add(a ?? '')
      return ok()
    }
    if (cmd === 'rm') { remove(b ?? ''); return ok() }
    if (cmd === 'sh' && b === 'echo $PPID') return ok('4242\n')
    if (cmd === 'sh' && b === 'cat >> "$1"') {
      put(d ?? '', (w.files.get(d ?? '')?.text ?? '') + (e.init?.stdin ?? ''))
      return ok()
    }
    if (cmd === 'tail') {
      const text = w.files.get(e.argv[3] ?? '')?.text
      if (text === undefined) return fail()
      return ok(text.trim().split('\n').slice(-Number(b)).join('\n') + '\n')
    }
    if (cmd === 'git') return fail(128, 'not a git repository')
    if (cmd === 'ps') return ok('')
    return ok()
  }) as never)
  h('model.complete', (async (_: unknown, e: ModelCompleteInput) => {
    w.modelCalls.push(e)
    return { value: await w.modelReply(e) }
  }) as never)
  h('ui.log', (() => ({ value: undefined })) as never)
  h('store.get', ((_: unknown, e: { key: string }) => ({ value: w.store.get(e.key) })) as never)
  h('store.set', ((_: unknown, e: { key: string; value: unknown }) => { w.store.set(e.key, e.value); return { value: undefined } }) as never)
  h('store.delete', ((_: unknown, e: { key: string }) => { w.store.delete(e.key); return { value: undefined } }) as never)
  h('env.get', ((_: unknown, e: { name: string }) => ({ value: w.env[e.name] })) as never)
  h('env.set', ((_: unknown, e: { name: string; value?: string }) => {
    if (e.value === undefined) delete w.env[e.name]
    else w.env[e.name] = e.value
    return { value: {} }
  }) as never)
  h('session.id', (() => ({ value: opts.sessionId ?? 's1' })) as never)
  h('session.cwd', (() => ({ value: opts.cwd ?? '/w/acme' })) as never)
  h('session.surfaces', (() => ({ value: opts.surfaces ?? ['terminal'] })) as never)
  h('session.messages', (() => ({ value: w.messages })) as never)
  h('tool.register', ((_: unknown, e: { name: string }) => {
    if (w.unboundRegisters > 0) { w.unboundRegisters--; return { deny: 'the session is not bound yet' } }
    if (w.denyRegister) return { deny: `tool ${e.name} already registered` }
    w.tools.push(e.name)
    return { value: { tool: e.name } }
  }) as never)
  h('command.register', ((_: unknown, e: { name: string }) => {
    if (w.denyRegister) return { deny: `command ${e.name} already registered` }
    w.commands.push(e.name)
    return { value: { command: e.name } }
  }) as never)
  h('ui.open', (() => ({ value: { isPlaced: true } })) as never)
  h('ui.toast', ((_: unknown, e: { text: string }) => { w.toasts.push(e.text); return { value: undefined } }) as never)
  return w
}

export function isolatedMonitorEngine(w: World): EngineInterface {
  return {
    process: { run: async (argv: readonly string[], init?: { cwd?: string }) => {
      w.processCalls.push({ argv, ...(init?.cwd ? { cwd: init.cwd } : {}) })
      return w.processReply?.(argv, init?.cwd) ?? { exitCode: 127, stdout: '', stderr: 'not installed' }
    } },
    model: { complete: async (request: ModelCompleteRequest) => {
      const input = { ...request, prompt: String(request.prompt) } as ModelCompleteInput
      w.modelCalls.push(input)
      return w.modelReply(input)
    } },
    ui: { log: () => undefined },
  } as unknown as EngineInterface
}

/** Writes a plan file the way the store does. */
export function seedPlan(w: World, home: string, plan: { id: string } & Record<string, unknown>): void {
  const dir = `${home}/.claude/progress-board/plans/${encodeURIComponent(plan.id)}`
  w.dirs.add(`${home}/.claude/progress-board/plans`)
  w.dirs.add(dir)
  w.files.set(`${dir}/plan.json`, { text: JSON.stringify(plan), m: w.clock.now() })
}
