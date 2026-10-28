// An in-memory Io for tests: every operation yields, so concurrent callers interleave.

import type { Entry, Io } from '../hooks/store'

const yieldTurn = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

export class MemIo implements Io {
  files = new Map<string, { text: string; m: number }>()
  dirs = new Map<string, number>()
  clock = 1_000_000
  writes = 0
  tailReads = 0
  failWrite = false
  failRemove = new Set<string>()

  async read(path: string) {
    await yieldTurn()
    return this.files.get(path)?.text ?? null
  }
  async writeAtomic(path: string, text: string) {
    await yieldTurn()
    if (this.failWrite) throw new Error('write failed')
    this.writes++
    this.files.set(path, { text, m: this.clock })
  }
  async append(path: string, text: string) {
    await yieldTurn()
    const cur = this.files.get(path)?.text ?? ''
    this.files.set(path, { text: cur + text, m: this.clock })
  }
  async mkdirExclusive(path: string) {
    await yieldTurn(1)
    if (this.dirs.has(path)) return false
    this.dirs.set(path, this.clock)
    return true
  }
  async mkdirp(path: string) {
    await yieldTurn(1)
    if (!this.dirs.has(path)) this.dirs.set(path, this.clock)
  }
  async remove(path: string) {
    await yieldTurn(1)
    if (this.failRemove.has(path)) throw new Error(`remove failed: ${path}`)
    const under = (p: string) => p === path || p.startsWith(`${path}/`)
    for (const k of [...this.dirs.keys()]) if (under(k)) this.dirs.delete(k)
    for (const k of [...this.files.keys()]) if (under(k)) this.files.delete(k)
  }
  async tail(path: string, n: number) {
    await yieldTurn(1)
    this.tailReads++
    const text = this.files.get(path)?.text
    return text === undefined ? null : text.trim().split('\n').slice(-n).join('\n') + '\n'
  }
  async mtime(path: string) {
    await yieldTurn(1)
    return this.files.get(path)?.m ?? this.dirs.get(path) ?? null
  }
  async list(path: string): Promise<Entry[]> {
    await yieldTurn(1)
    const out = new Map<string, Entry>()
    const prefix = path.endsWith('/') ? path : `${path}/`
    for (const [p, f] of this.files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const name = rest.split('/')[0] ?? ''
      out.set(name, { name, kind: rest.includes('/') ? 'dir' : 'file', mtimeMs: f.m })
    }
    return [...out.values()]
  }
  async now() {
    this.clock += 1
    return this.clock
  }
  async sleep(ms: number) {
    this.clock += ms
    await yieldTurn(5)
  }
}
