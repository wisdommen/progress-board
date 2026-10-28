// Storage under $HOME/.claude/progress-board: atomic writes (temp + rename),
// owned mkdir locks with fenced, serialized stale-lock recovery, append-only change logs.

import type { EngineInterface } from 'claude-code'

import type { LogEntry, Plan, SessionRec } from '../types'
import { planDir, planIdFromDir } from './util'

export type Entry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

/** The file operations the store needs; `$`-backed in a session, in memory in tests. */
export interface Io {
  read(path: string): Promise<string | null>
  writeAtomic(path: string, text: string): Promise<void>
  append(path: string, text: string): Promise<void>
  /** Creates `path` only if absent; true when this call created it. */
  mkdirExclusive(path: string): Promise<boolean>
  mkdirp(path: string): Promise<void>
  /** Removes `path` and what is under it; rejects when it could not. */
  remove(path: string): Promise<void>
  /** The last `n` lines of a text file; null when it cannot be read. */
  tail(path: string, n: number): Promise<string | null>
  mtime(path: string): Promise<number | null>
  list(path: string): Promise<Entry[]>
  now(): Promise<number>
  sleep(ms: number): Promise<void>
}

export function ioFor($: EngineInterface): Io {
  const run = (argv: string[], stdin?: string) =>
    $.process.run(argv, { timeoutMs: 10_000, ...(stdin === undefined ? {} : { stdin }) })
  return {
    read: path => $.fs.read(path).then(t => t as string, () => null),
    async writeAtomic(path, text) {
      const tmp = `${path}.tmp-${Math.random().toString(36).slice(2, 10)}`
      await $.fs.write(tmp, text)
      const r = await run(['mv', '-f', tmp, path])
      if (r.exitCode !== 0) {
        await run(['rm', '-f', tmp]).catch(() => undefined)
        throw new Error(`rename failed: ${r.stderr.trim()}`)
      }
    },
    async append(path, text) {
      const r = await run(['sh', '-c', 'cat >> "$1"', 'sh', path], text)
      if (r.exitCode !== 0) throw new Error(`append failed: ${r.stderr.trim()}`)
    },
    mkdirExclusive: path => run(['mkdir', path]).then(r => r.exitCode === 0),
    mkdirp: path => run(['mkdir', '-p', path]).then(() => undefined),
    async remove(path) {
      const r = await run(['rm', '-rf', path])
      if (r.exitCode !== 0) throw new Error(`remove failed: ${r.stderr.trim()}`)
    },
    tail: (path, n) => run(['tail', '-n', String(n), path]).then(r => (r.exitCode === 0 ? r.stdout : null), () => null),
    mtime: path => $.fs.stat(path).then(s => s.mtimeMs, () => null),
    list: path =>
      $.fs.list(path).then(
        es => es.map(e => ({ name: e.name, kind: e.kind === 'dir' ? 'dir' : e.kind === 'file' ? 'file' : 'other', mtimeMs: e.mtimeMs }) as Entry),
        () => [],
      ),
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
  }
}

export class Paths {
  constructor(readonly root: string) {}
  static forHome(home: string): Paths {
    return new Paths(`${home.replace(/\/+$/, '')}/.claude/progress-board`)
  }
  get plans() { return `${this.root}/plans` }
  get sessions() { return `${this.root}/sessions` }
  get repos() { return `${this.root}/repos` }
  planDir(id: string) { return `${this.plans}/${planDir(id)}` }
  planJson(id: string) { return `${this.planDir(id)}/plan.json` }
  planMd(id: string) { return `${this.planDir(id)}/PLAN.md` }
  planLog(id: string) { return `${this.planDir(id)}/log.jsonl` }
  checks(id: string) { return `${this.planDir(id)}/checks.json` }
  monitor(id: string) { return `${this.planDir(id)}/monitor.json` }
  suggestions(id: string) { return `${this.planDir(id)}/suggestions.json` }
  session(id: string) { return `${this.sessions}/${id}.json` }
  repo(key: string) { return `${this.repos}/${key}.json` }
}

export function parseJson<T>(text: string | null): T | null {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export type LockOptions = { timeoutMs?: number; staleMs?: number; pollMs?: number }

/** Throws when this holder no longer owns the lock (it was reclaimed as stale); call before each write. */
export type LockGuard = () => Promise<void>

let lockSeq = 0

/**
 * Runs `fn` holding `${dir}/.lock`, a directory made exclusively and stamped with an owner token.
 *
 * A lock older than `staleMs` is reclaimed only under a second exclusive directory (`.lock.reclaim`), and
 * only when it still carries the token and age seen before: two waiters that both saw the same stale lock
 * cannot both remove it, and nobody removes a replacement. Release removes the lock only while it is still
 * ours. `fn` gets a guard that fences writes of a holder whose lock was reclaimed meanwhile. Every attempt,
 * reclaiming included, is bounded by `timeoutMs`.
 */
export async function withLock<T>(io: Io, dir: string, fn: (guard: LockGuard) => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const lock = `${dir}/.lock`
  const ownerFile = `${lock}/owner`
  const reclaim = `${lock}.reclaim`
  const timeoutMs = opts.timeoutMs ?? 8_000
  const staleMs = opts.staleMs ?? 120_000
  const pollMs = opts.pollMs ?? 60
  const token = `${(await io.now()).toString(36)}-${(++lockSeq).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const look = async () => ({ owner: await io.read(ownerFile), at: (await io.mtime(ownerFile)) ?? (await io.mtime(lock)) })
  await io.mkdirp(dir)
  const start = await io.now()
  for (;;) {
    if (await io.mkdirExclusive(lock)) {
      try {
        await io.writeAtomic(ownerFile, token)
      } catch (err) {
        await io.remove(lock).catch(() => undefined)
        throw err
      }
      break
    }
    const now = await io.now()
    const seen = await look()
    if (seen.at !== null && now - seen.at > staleMs) {
      // Reclaim under its own lock, re-checking that the stale lock is still the one we saw.
      if (await io.mkdirExclusive(reclaim)) {
        try {
          const again = await look()
          if (again.owner === seen.owner && again.at !== null && (await io.now()) - again.at > staleMs) await io.remove(lock)
        } catch {
          // An undeletable lock: fall through to the deadline.
        } finally {
          await io.remove(reclaim).catch(() => undefined)
        }
      } else {
        const r = await io.mtime(reclaim)
        // A reclaimer that died mid-reclaim (a few file operations) leaves this behind.
        if (r !== null && now - r > staleMs) await io.remove(reclaim).catch(() => undefined)
      }
    }
    if ((await io.now()) - start > timeoutMs) throw new Error(`progress-board: lock busy: ${lock}`)
    await io.sleep(pollMs)
  }
  const guard: LockGuard = async () => {
    if ((await io.read(ownerFile)) !== token) throw new Error(`progress-board: lock lost: ${lock}`)
  }
  try {
    return await fn(guard)
  } finally {
    if ((await io.read(ownerFile).catch(() => null)) === token) await io.remove(lock).catch(() => undefined)
  }
}

export type Mutation =
  | { unchanged: Plan }
  | { plan: Plan; log: Omit<LogEntry, 'at' | 'plan'>[]; md: string }
  | { error: string }

/** Locks the plan, reads the newest copy, applies `mutate`, writes it back and appends the log. */
export async function mutatePlan(
  io: Io,
  paths: Paths,
  id: string,
  mutate: (current: Plan | null, now: number, guard: LockGuard) => Mutation | Promise<Mutation>,
): Promise<{ plan: Plan } | { error: string }> {
  return withLock(io, paths.planDir(id), async guard => {
    const current = parseJson<Plan>(await io.read(paths.planJson(id)))
    const now = await io.now()
    const out = await mutate(current, now, guard)
    if ('error' in out) return out
    if ('unchanged' in out) return { plan: out.unchanged }
    const plan = { ...out.plan, updatedAt: now }
    await guard()
    await io.writeAtomic(paths.planJson(id), JSON.stringify(plan, null, 1))
    await io.writeAtomic(paths.planMd(id), out.md)
    if (out.log.length > 0) {
      const lines = out.log.map(l => JSON.stringify({ at: now, plan: id, ...l })).join('\n') + '\n'
      await guard()
      await io.append(paths.planLog(id), lines)
    }
    return { plan }
  })
}

export async function readPlan(io: Io, paths: Paths, id: string): Promise<Plan | null> {
  return parseJson<Plan>(await io.read(paths.planJson(id)))
}

export async function listPlanIds(io: Io, paths: Paths): Promise<{ id: string; mtimeMs: number }[]> {
  const out: { id: string; mtimeMs: number }[] = []
  for (const e of await io.list(paths.plans)) {
    if (e.kind !== 'dir') continue
    const id = planIdFromDir(e.name)
    const m = await io.mtime(paths.planJson(id))
    if (m !== null) out.push({ id, mtimeMs: m })
  }
  return out
}

/** The last `n` entries of a plan's log, read with a bounded tail. */
export async function readLogTail(io: Io, paths: Paths, id: string, n: number): Promise<LogEntry[]> {
  const text = await io.tail(paths.planLog(id), n)
  if (!text) return []
  return text
    .trim()
    .split('\n')
    .slice(-n)
    .map(l => parseJson<LogEntry>(l))
    .filter((l): l is LogEntry => l !== null)
}

/** Log tails cached by the log's modification time: an unchanged log is not read again. */
export class LogTail {
  private cache = new Map<string, { m: number; n: number; entries: LogEntry[] }>()
  constructor(private io: Io, private paths: Paths) {}
  async get(id: string, n: number): Promise<LogEntry[]> {
    const m = await this.io.mtime(this.paths.planLog(id))
    if (m === null) return []
    const hit = this.cache.get(id)
    if (hit && hit.m === m && hit.n === n) return hit.entries
    const entries = await readLogTail(this.io, this.paths, id, n)
    this.cache.set(id, { m, n, entries })
    return entries
  }
}

export async function saveSession(io: Io, paths: Paths, rec: SessionRec, text = JSON.stringify(rec)): Promise<void> {
  await io.mkdirp(paths.sessions)
  await io.writeAtomic(paths.session(rec.id), text)
}

/**
 * Writes a session's record one save at a time, each writing the record as it is when its turn comes, so an
 * older save can never land after a newer one. The saved watermark advances only after a write succeeded
 * (a failed one is retried by the next save). Unchanged content is not rewritten; a last-activity-only
 * change is written at most every 30 seconds.
 */
export class SessionSaver {
  private queue: Promise<void> = Promise.resolve()
  private last = ''
  private lastAt = 0
  private lastActivity = -1
  constructor(private io: Io, private paths: Paths) {}
  save(get: () => SessionRec | null, now: number, force = false): Promise<void> {
    const job = this.queue.then(async () => {
      const rec = get()
      if (!rec) return
      const { lastActivity, ...rest } = rec
      const key = JSON.stringify(rest)
      const isSame = key === this.last
      if (!force && isSame && (lastActivity === this.lastActivity || now - this.lastAt < 30_000)) return
      await saveSession(this.io, this.paths, rec, JSON.stringify(rec))
      this.last = key
      this.lastAt = now
      this.lastActivity = lastActivity
    })
    this.queue = job.catch(() => undefined)
    return this.queue
  }
}

export type RepoIndex = { root: string; plans: Record<string, { count: number; lastAt: number }> }

/** Adds evidence that `plan` belongs to repo `key`. */
export async function touchRepo(io: Io, paths: Paths, key: string, root: string, plan: string): Promise<void> {
  await withLock(io, paths.repos, async guard => {
    const idx = parseJson<RepoIndex>(await io.read(paths.repo(key))) ?? { root, plans: {} }
    const now = await io.now()
    const cur = idx.plans[plan] ?? { count: 0, lastAt: 0 }
    idx.plans[plan] = { count: cur.count + 1, lastAt: now }
    await guard()
    await io.writeAtomic(paths.repo(key), JSON.stringify(idx))
  })
}

export async function readRepo(io: Io, paths: Paths, key: string): Promise<RepoIndex | null> {
  return parseJson<RepoIndex>(await io.read(paths.repo(key)))
}

/** Repos under these roots are never indexed. */
export function isIndexableRepo(root: string, home: string): boolean {
  const h = home.replace(/\/+$/, '')
  if (root === '/tmp' || root.startsWith('/tmp/') || root.startsWith('/private/tmp/')) return false
  if (root === h) return false
  if (root === `${h}/.claude` || root.startsWith(`${h}/.claude/`)) return false
  return true
}

/** `<last segment>-<short hash>` of a repo's main directory. */
export function repoKeyOf(root: string, hash: (s: string) => string): string {
  const name = root.replace(/\/+$/, '').split('/').pop() || 'repo'
  return `${name.replace(/[^A-Za-z0-9_.-]/g, '_')}-${hash(root).slice(0, 8)}`
}
