import type { ElementTable, RenderElement } from 'claude-code'
import type { Item, Phase, Plan, Priority, SessionRec, SessionView, PanelUi } from '../types'
import { bundled, t } from './i18n'
import { meaningfulQuote, normalizePriorityQuote } from './quotes'
import { strWidth } from './util'
import { activeOwner, costHelp, tokenMark } from './ui-costs'
import { findItem, findPhase, renderPlanMd, sessionName } from './model'
import { mutatePlan } from './store'
import type { Io, Paths } from './store'

export const levels: readonly Priority[] = ['pinned', 'high', 'normal', 'low', 'deferred']
export const priorityOf = (phase: Phase, item?: Item): Priority => levels.includes(item?.priority!) ? item!.priority! : levels.includes(phase.priority!) ? phase.priority! : 'normal'
export const priorityMark = (level: Priority) => ({ pinned: '⇡ ', high: '↑ ', normal: '', low: '↓ ', deferred: '‖ ' })[level]
export const sortedItems = (phase: Phase): Item[] => phase.items.slice().sort((a, b) => levels.indexOf(priorityOf(phase, a)) - levels.indexOf(priorityOf(phase, b)))
export function openItems(plan: Plan) { return plan.phases.filter(p => !p.isVoid).flatMap(phase => phase.items.filter(i => i.status === 'todo' || i.status === 'wrapping').map(item => ({ phase, item, level: priorityOf(phase, item) }))).sort((a, b) => levels.indexOf(a.level) - levels.indexOf(b.level)) }
export function orchestratorFor(plan: string, sessions: readonly SessionRec[]): SessionRec | undefined {
  return sessions.filter(s => (s as Partial<SessionView>).isAlive === true && s.endedAt === undefined && (s.claims.some(c => c.plan === plan) || (s.kind === 'orchestrator' && (s.envPlan === plan || s.taskPlan === plan || (s as SessionView).attribution?.confident.some(a => a.plan === plan)))))
    .sort((a, b) => Number(b.kind === 'orchestrator') - Number(a.kind === 'orchestrator') || b.claims.filter(c => c.plan === plan).length - a.claims.filter(c => c.plan === plan).length || a.id.localeCompare(b.id))[0]
}
export type PriorityTarget = { item?: string; phase?: string }
function quotesTarget(plan: Plan, id: string, title: string, isItem: boolean, level: Priority, quote: string): boolean {
  if (!meaningfulQuote(quote)) return false
  const q = normalizePriorityQuote(quote)
  if (q.includes(normalizePriorityQuote(id))) return true
  const wordForm = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  const words = ` ${wordForm(quote)} `
  const levelWords = [level, t(`priority.${level}`), ...(level === 'pinned' ? ['pin'] : level === 'deferred' ? ['defer'] : []), ...Object.values(bundled).map(c => c[`priority.${level}`]).filter((v): v is string => !!v)]
  if (levelWords.some(word => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word) ? q.includes(normalizePriorityQuote(word)) : words.includes(` ${wordForm(word)} `))) return true
  const normalizedTitle = normalizePriorityQuote(title)
  const others = (isItem ? plan.phases.flatMap(p => p.items).filter(i => i.id !== id).map(i => i.title) : plan.phases.filter(p => p.id !== id).map(p => p.name)).map(normalizePriorityQuote)
  const chars = Array.from(q)
  for (let i = 0; i < chars.length; i++) {
    let fragment = ''
    for (let j = i; j < chars.length; j++) {
      fragment += chars[j]
      if (strWidth(fragment) >= 4 && normalizedTitle.includes(fragment) && !others.some(other => other.includes(fragment))) return true
    }
  }
  return false
}
export async function setPriority(io: Io, paths: Paths, id: string, target: PriorityTarget, level: Priority, by: string,
  evidence: { source: 'panel' | 'quote' | 'control'; quote?: string; quotedAt?: string; messageId?: string; action?: string; controlId?: string; intentId?: string }): Promise<{ plan: Plan } | { error: string }> {
  return mutatePlan(io, paths, id, (current, at) => {
    if (!current || current.status !== 'active') return { error: t('common.noPlan') }
    const hit = target.item ? findItem(current, target.item, target.phase) : undefined
    const phase = target.item ? hit?.phase : findPhase(current, target.phase)
    const object = target.item ? hit?.item : phase
    if (!object || !levels.includes(level) || (evidence.action === 'dispatch-now' && (!hit || hit.phase.isVoid || !['todo', 'wrapping'].includes(hit.item.status)))) return { error: t('dispatch.closed') }
    const key = `${target.item ? 'item' : 'phase'}:${object.id}`
    if (evidence.source === 'quote') {
      if (!evidence.messageId || !quotesTarget(current, object.id, target.item ? hit!.item.title : phase!.name, !!target.item, level, evidence.quote ?? '')) return { error: 'The quote must name this target, a distinctive title fragment, or the requested level.' }
      if (current.priorityReceipts?.some(r => r.target === key && r.messageId === evidence.messageId && r.by === by)) return { error: 'This message has already been used for this target.' }
    }
    const plan: Plan = { ...current, phases: current.phases.map(ph => ({ ...ph, ...(target.item ? {} : ph.id === object.id ? { priority: level } : {}), items: ph.items.map(it => target.item && it.id === object.id ? { ...it, priority: level } : it) })) }
    if (evidence.source === 'quote') plan.priorityReceipts = [...(plan.priorityReceipts ?? []), { target: key, messageId: evidence.messageId, by }]
    const detail = `${key} ${target.item ? hit!.item.title : phase!.name}: ${level}`
    plan.priorityNotices = [...(plan.priorityNotices ?? []).filter(n => !n.deliveredTo), { id: `${at}-${Math.random().toString(36).slice(2)}`, detail }]
    return { plan, log: [{ by, action: evidence.action ?? 'set_priority', detail, source: evidence.source, target: key, level, ...(evidence.controlId ? { controlId: evidence.controlId } : {}), ...(evidence.intentId ? { intentId: evidence.intentId } : {}), ...(evidence.quote ? { quote: evidence.quote, quotedAt: evidence.quotedAt } : {}) }], md: renderPlanMd(plan) }
  })
}
export function priorityAdvice(plan: Plan): string {
  const items = openItems(plan).filter(x => ['pinned', 'high', 'deferred'].includes(x.level))
  if (!items.length) return ''
  return `Plan ${plan.id} priorities (quoted item data):\n${JSON.stringify(items.map(x => ({ item: x.item.id, title: x.item.title, phase: x.phase.name, level: x.level })))}\nWork and dispatch in this order unless a dependency or a reason prevents it; do not start deferred items.`
}
export function deviationReason(plan: Plan, itemId: string, sessions: readonly SessionRec[]): string | undefined {
  const all = openItems(plan), target = all.find(x => x.item.id === itemId)
  if (!target) return undefined
  const claimed = new Set(sessions.filter(s => s.endedAt === undefined).flatMap(s => s.claims.filter(c => c.plan === plan.id).flatMap(c => c.item ? [c.item] : all.filter(x => !c.phase || x.phase.id === c.phase).map(x => x.item.id))))
  const higher = all.filter(x => !claimed.has(x.item.id) && levels.indexOf(x.level) < levels.indexOf(target.level))
  if (target.level !== 'deferred' && !higher.length) return undefined
  return `Priority deviation for ${plan.id} ${itemId}: ${target.level === 'deferred' ? 'the item is deferred' : `unclaimed higher-priority items: ${higher.map(x => x.item.id).join(', ')}`}. The claim is allowed; explain why using progress_plan action explain_priority with item and reason.`
}
export async function takePriorityNotice(io: Io, paths: Paths, id: string, selfId: string, sessions: readonly SessionRec[]): Promise<string | undefined> {
  if (orchestratorFor(id, sessions)?.id !== selfId) return undefined
  let text: string | undefined
  await mutatePlan(io, paths, id, plan => {
    if (!plan) return { error: t('common.noPlan') }
    const pending = plan.priorityNotices?.filter(n => !n.deliveredTo) ?? []
    if (!pending.length) return { unchanged: plan }
    text = `Priority changed in ${id} (quoted data): ${JSON.stringify(pending.map(n => n.detail))}. Recheck dispatch order.`
    const next = { ...plan, priorityNotices: plan.priorityNotices!.map(n => n.deliveredTo ? n : { ...n, deliveredTo: selfId }) }
    return { plan: next, log: [], md: renderPlanMd(next) }
  })
  return text
}
export type PriorityActions = {
  change: (target: PriorityTarget, level: Priority) => void
  picker: (key: string) => void
  unclaimed: () => void
  dispatch?: (item: string) => RenderElement
}
export function renderPriorities(els: Pick<ElementTable, 'Box' | 'Text' | 'Button'>, plan: Plan | null, sessions: readonly SessionView[], ui: PanelUi, act: PriorityActions): RenderElement {
  const { Box, Text, Button } = els
  if (!plan || plan.status === 'done' || plan.status === 'abandoned') return <Text dimColor>{t('priority.none')}</Text>
  const holders = (item: string) => sessions.filter(activeOwner).flatMap(s => s.claims.filter(c => c.plan === plan.id && c.item === item).flatMap(c => {
    const worker = c.by ? sessions.find(peer => sessionName(peer).trim() === c.by!.trim()) : undefined
    return worker && !activeOwner(worker) ? [] : [c.by ?? sessionName(s)]
  }))
  const selected = (id: string) => ui.expandedRow !== undefined ? ui.expandedRow === `priority:${id}` : ui.priorityPicker === id
  const controls = (target: PriorityTarget, id: string, level: Priority, title: string, owner: string[], item?: string) => <Box key={`priority-entry-${id}`} flexDirection="column">
    <Box key={`priority-row-${id}`} flexDirection="row" gap={1}>
      <Box key={`priority-dispatch-slot-${id}`} width={5} flexShrink={0}>{item ? act.dispatch?.(item) ?? '' : <Text>{'  '}</Text>}</Box>
      <Button key={`priority-up-${id}`} plain label="↑" onPress={() => act.change(target, levels[Math.max(0, levels.indexOf(level) - 1)]!)} />
      <Button key={`priority-down-${id}`} plain label="↓" onPress={() => act.change(target, levels[Math.min(levels.length - 1, levels.indexOf(level) + 1)]!)} />
      <Button key={`priority-level-${id}`} plain onPress={() => act.picker(id)}><Text weight={selected(id) ? 'bold' : 'regular'} color={selected(id) ? 'claude' : undefined}>{title}</Text></Button>
      {owner.length ? <Text color="claude">◐</Text> : ''}
      {owner.length ? <Text dimColor>{owner.join(', ')}</Text> : ''}
    </Box>
    {selected(id) ? <Box key={`priority-menu-${id}`} borderStyle="round" borderColor="subtle" flexDirection="column">
      <Text weight="bold">{title}</Text>
      <Box flexDirection="row" gap={2}>{levels.map(l => <Button key={`priority-choose-${id}-${l}`} plain onPress={() => act.change(target, l)}><Text color={l === level ? 'claude' : undefined} dimColor={l !== level} weight={l === level ? 'bold' : 'regular'}>{t(`priority.${l}`)}</Text></Button>)}<Button key={`priority-dismiss-${id}`} plain label={t('ui.dismiss')} onPress={() => act.picker(id)} /></Box>
      {item ? <Text dimColor wrap="wrap">{t('ui.dispatchHelp')} {costHelp('dispatch')}</Text> : ''}
    </Box> : ''}
  </Box>
  const items = openItems(plan).filter(x => !ui.unclaimedOnly || !holders(x.item.id).length)
  return <Box flexDirection="column">
    <Button key="priority-unclaimed" plain onPress={act.unclaimed}><Text color={ui.unclaimedOnly ? 'claude' : undefined} weight={ui.unclaimedOnly ? 'bold' : 'regular'}>{t('priority.unclaimed')}</Text></Button>
    {levels.map(level => {
      const phases = plan.phases.filter(ph => !ph.isVoid && ph.items.some(i => i.status === 'todo' || i.status === 'wrapping') && priorityOf(ph) === level)
      const rows = items.filter(x => x.level === level)
      if (!phases.length && !rows.length) return ''
      return <Box key={`priority-group-${level}`} flexDirection="column">
        <Text weight="bold" color={level === 'pinned' || level === 'high' ? 'claude' : level === 'normal' ? 'text' : 'subtle'}>{t(`priority.${level}`)}</Text>
        {phases.map(ph => controls({ phase: ph.id }, `phase-${ph.id}`, level, t('priority.phase', { name: ph.name }), []))}
        {rows.map(({ item }) => controls({ item: item.id }, `item-${item.id}`, level, item.title, holders(item.id), item.id))}
      </Box>
    })}
    {!items.length ? <Text dimColor>{t('priority.none')}</Text> : ''}
    <Box flexDirection="row" gap={1}><Text dimColor>{t('ui.priorityLegend')}</Text>{tokenMark(els)}<Text dimColor>{t('ui.usesTokens')}</Text></Box>
  </Box>
}
