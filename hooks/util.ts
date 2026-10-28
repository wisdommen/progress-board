import { dateTime, relative, t as tr } from './i18n'
// Small pure helpers: display width, hashing, time words, exact plan-ID matching.

/** Terminal cell width of one code point (CJK / fullwidth = 2). */
export function charWidth(cp: number): number {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp >= 0x300 && cp <= 0x36f) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

export function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** Cuts `s` to at most `max` cells, ending with … when cut. */
export function clip(s: string, max: number): string {
  if (max <= 0) return ''
  if (strWidth(s) <= max) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

export function padTo(s: string, width: number): string {
  const w = strWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

/** FNV-1a 32-bit, hex. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function minutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000))
}

export function ago(ms: number): string {
  const m = minutes(ms)
  return m < 1 ? relative(0, 'second') : m < 60 ? relative(-m, 'minute') : m < 1440 ? relative(-Math.floor(m / 60), 'hour') : relative(-Math.floor(m / 1440), 'day')
}
export function hhmm(at: number): string { return dateTime(at, { hour: '2-digit', minute: '2-digit', hour12: false }) }
export function mmddhhmm(at: number): string { return dateTime(at, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) }

const ID_CHAR = /[A-Za-z0-9_.\-/]/

/** True when `id` appears in `text` as a whole token (`v1.41` does not match `v1.41.0`). */
export function mentionsExactly(text: string, id: string): boolean {
  if (!id) return false
  let from = 0
  for (;;) {
    const at = text.indexOf(id, from)
    if (at < 0) return false
    const before = at > 0 ? text[at - 1] ?? '' : ''
    const after = text[at + id.length] ?? ''
    // A trailing "." that ends a sentence is not part of an ID.
    const afterIsId = after !== '' && ID_CHAR.test(after) && !(after === '.' && !ID_CHAR.test(text[at + id.length + 1] ?? ' '))
    if (!(before !== '' && ID_CHAR.test(before)) && !afterIsId) return true
    from = at + 1
  }
}

/** Plan IDs carry a project prefix: `acme/v1.2`. */
export const PLAN_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Folder name for a plan ID (the slash is encoded). */
export function planDir(id: string): string {
  return encodeURIComponent(id)
}

export function planIdFromDir(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** POSIX single-quoted shell word. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** What a session appends to CLAUDE_ENV_FILE: quoted values; an ineligible plan is unset, not left from before. */
export function envFileText(parent: string, plan: string | undefined): string {
  return `export PROGRESS_BOARD_PARENT=${shellQuote(parent)}\n${plan ? `export PROGRESS_BOARD_PLAN=${shellQuote(plan)}` : 'unset PROGRESS_BOARD_PLAN'}\n`
}

/** Text compared for quotations: lower case, no whitespace or punctuation. */
export function normQuote(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** A question compared across sessions: trimmed, case-folded, punctuation dropped, spaces collapsed. */
export function normQuestion(s: string): string {
  return s.toLowerCase().replace(/[\p{P}\p{S}]+/gu, '').replace(/\s+/g, ' ').trim()
}

/** A backfilled completion time: an ISO time or epoch ms, never later than `now`. */
export function parsePastTime(v: unknown, now: number): { at?: number } | { error: string } {
  if (v === undefined || v === null) return {}
  let at = Number.NaN
  if (typeof v === 'number') at = v
  else if (typeof v === 'string' && v.trim()) {
    const s = v.trim()
    at = /^\d+$/.test(s) ? Number(s) : Date.parse(s)
  } else return { error: tr('util.m005') }
  if (!Number.isFinite(at)) return { error: tr('util.m006') }
  if (at < 946684800000) return { error: tr('util.m007') }
  if (at > now) return { error: tr('util.m008') }
  return { at }
}
