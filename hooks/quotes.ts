import type { OwnQuote, SessionRec } from '../types'
import { normQuote, strWidth } from './util'

export const normalizePriorityQuote = (text: string) => normQuote(text.normalize('NFKC'))
const preview = (text: string) => Array.from(text).slice(0, 200).join('')
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizePriorityQuote(text)))
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
}
/** Migrate legacy records before saving; the original full prompt is never written again. */
export async function compactQuotes(self: SessionRec): Promise<void> {
  if (!self.ownQuotes || (self.ownQuotes.length <= 10 && self.ownQuotes.every(q => q.id && q.hash && q.text === preview(q.text)))) return
  self.ownQuotes = await Promise.all(self.ownQuotes.slice(-10).map(async q => {
    const digest = q.hash ?? await hash(q.text)
    return { id: q.id ?? `${self.id}:${q.at}:${digest}`, hash: digest, text: preview(q.text), at: q.at }
  }))
}
export async function rememberQuote(self: SessionRec, text: string, at: number): Promise<void> {
  const quote: OwnQuote = { id: `${self.id}:${crypto.randomUUID()}`, hash: await hash(text), text: preview(text), at }
  self.ownQuotes = [...(self.ownQuotes ?? []), quote].slice(-10)
}
export function meaningfulQuote(text: string): boolean {
  if (Array.from(text).length > 200) return false
  const normalized = normalizePriorityQuote(text)
  const words = text.normalize('NFKC').match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []
  return !!normalized && (strWidth(normalized) >= 8 || words.length >= 2)
}
export function matchingQuote(self: SessionRec, quote: string, at: number): OwnQuote | undefined {
  if (!meaningfulQuote(quote)) return undefined
  const normalized = normalizePriorityQuote(quote)
  return self.ownQuotes?.slice().reverse().sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))
    .find(q => Math.abs(q.at - at) <= 120_000 && normalizePriorityQuote(q.text).includes(normalized))
}
