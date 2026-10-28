import type { EngineInterface } from 'claude-code'
import type { SessionRec } from '../types'

type NativeAddress = { nativeName: string; ref?: string }
type NativeListing = { listing?: string; sections?: { kind?: string; rows?: { name?: string; ref?: string; status?: string }[] }[]; notes?: { kind?: string; text?: string }[] }
let lookups = 0
let loggedShape = false

/** 内部查询不计入模型的调用次数；初始化期间也不能重入 ensureInit。 */
export const isNativeLookup = () => lookups > 0
export async function readNativeListing($: EngineInterface): Promise<NativeListing | undefined> {
  lookups++
  try {
    const result = await $.tool.call({ tool: 'ListAgents' })
    const listing = result.result as NativeListing | undefined
    if (!loggedShape) {
      loggedShape = true
      $.ui.log(`ListAgents result shape: ${JSON.stringify({ keys: Object.keys(result), resultKeys: listing && Object.keys(listing), selfLine: listing?.listing?.split('\n').find(line => line.startsWith('This session is ')), sections: listing?.sections?.map(section => ({ kind: section.kind, rowKeys: Object.keys(section.rows?.[0] ?? {}) })) })}`, { to: 'debug' })
    }
    return result.deny || result.isError ? undefined : listing
  } catch { return undefined }
  finally { lookups-- }
}

/** 自身没有出现在 peer rows 中；只认宿主的自身说明，不认其他会话标题。 */
export function selfNativeAddress(listing: NativeListing | undefined): NativeAddress | undefined {
  const match = /^This session is ([^\r\n]+?) \[([A-Za-z0-9_-]+)\] — the name other sessions use to message it\b/m.exec(listing?.listing ?? '')
  if (!match || match[1]!.length > 220 || /[\u0000-\u001f\u007f]/.test(match[1]!)) return undefined
  return { nativeName: match[1]!, ref: match[2]! }
}

/** UUID 只用于读目标自己的登记；原生行只负责确认可达性和名称冲突。 */
export async function nativeAddressOf($: EngineInterface, target: SessionRec): Promise<string | undefined> {
  if (!target.nativeName) return undefined
  const listing = await readNativeListing($)
  if (!listing) return undefined
  const rows = listing.sections?.flatMap(section => section.rows ?? []) ?? []
  const matches = rows.filter(row => row.name === target.nativeName && (!target.ref || row.ref === target.ref))
  if (matches.length !== 1) return undefined
  const duplicate = rows.filter(row => row.name === target.nativeName).length > 1 || selfNativeAddress(listing)?.nativeName === target.nativeName
  if (duplicate && !target.ref) return undefined
  return target.nativeName + (duplicate ? ` [${target.ref}]` : '')
}
