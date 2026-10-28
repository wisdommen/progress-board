import type { ElementTable, RenderElement } from 'claude-code'
import type { ActivityEntry, LogEntry, PanelUi, RefCheck, Snapshot, Suggestion } from '../types'
import { dateTime, t } from './i18n'
import { sessionName } from './model'
import { parseJson } from './store'
import type { Io, Paths, LogTail } from './store'

const WEEK = 7 * 86400_000
function logMeaning(l: LogEntry): Pick<ActivityEntry, 'semantic' | 'verb'> {
  const status = l.status
  if (l.action === 'complete' || l.action === 'merged' || (status === 'done' && l.previousStatus !== 'done') || (status === undefined && l.action === 'set_item' && / → done\b/.test(l.detail))) return { semantic: 'success', verb: t(l.action === 'merged' ? 'activity.verb.merged' : 'activity.verb.done') }
  if (['claim', 'start', 'started', 'dispatch-now'].includes(l.action)) return { semantic: 'started', verb: t(l.action === 'claim' ? 'activity.verb.claimed' : 'activity.started') }
  if (['ask', 'question', 'waiting'].includes(l.action)) return { semantic: 'waiting', verb: t('activity.verb.waiting') }
  return { semantic: 'change', verb: t('activity.verb.changed') }
}
export async function activityOf(io: Io, paths: Paths, snap: Snapshot, logs: LogTail): Promise<ActivityEntry[]> {
  const me = snap.sessions.find(s => s.isSelf)
  const ids = new Set([snap.focusPlan, ...snap.repoPlans, ...(me?.claims.map(c => c.plan) ?? []), ...(me?.attribution.confident.map(a => a.plan) ?? []), me?.lastPlan])
  const visible = snap.plans.filter(p => ids.has(p.id)), out: ActivityEntry[] = []
  const who = (id: string) => { const s = snap.sessions.find(s => s.id === id); return s ? sessionName(s) : id }
  const inWindow = (at: number) => Number.isFinite(at) && at <= snap.now && snap.now - at <= WEEK
  for (const plan of visible) {
    const tail = await logs.get(plan.id, 5000)
    tail.forEach((l: LogEntry, n) => {
      if (!inWindow(l.at) || l.isBackfill) return
      const kind: ActivityEntry['kind'] = l.action === 'explain_priority' || l.action === 'set_priority' || l.action === 'dispatch-now' ? 'decision' : l.action === 'complete' || (l.action === 'set_item' && ((l.status !== l.previousStatus && (l.status === 'done' || l.status === 'wrapping')) || (l.status === undefined && / → (?:done|wrapping)\b/.test(l.detail)))) ? 'completion' : 'event'
      out.push({ id: `log-${plan.id}-${l.at}-${n}`, at: l.at, by: who(l.by), plan: plan.id, kind, ...logMeaning(l), text: l.detail })
    })
    const checks = parseJson<Record<string, RefCheck>>(await io.read(paths.checks(plan.id))) ?? {}
    for (const [key, check] of Object.entries(checks)) if (inWindow(check.lastCheckedAt)) out.push({ id: `check-${plan.id}-${key}`, at: check.lastCheckedAt, by: t('settings.monitor'), plan: plan.id, kind: 'event', semantic: check.state === 'merged' ? 'success' : 'change', verb: t(check.state === 'merged' ? 'activity.verb.merged' : 'activity.verb.checked'), text: `${key}: ${t(`activity.state.${check.state}`)}` })
    const suggestions = parseJson<Suggestion[]>(await io.read(paths.suggestions(plan.id))) ?? []
    for (const s of suggestions) if (s.resolvedAt !== undefined && inWindow(s.resolvedAt)) out.push({ id: `suggestion-${plan.id}-${s.id}`, at: s.resolvedAt, by: who(s.resolvedBy ?? ''), plan: plan.id, kind: 'decision', semantic: 'change', verb: t('activity.verb.changed'), text: `${s.item} · ${t(`activity.state.${s.state}`)} · ${s.resolutionReason ?? s.reason}` })
  }
  for (const s of snap.sessions) {
    const plan = s.claims.find(c => ids.has(c.plan))?.plan ?? s.attribution.confident.find(c => ids.has(c.plan))?.plan
    if (!s.isAlive && !plan && !s.isSelf) continue
    const by = sessionName(s), prefix = { by, ...(plan ? { plan } : {}) }
    for (const [n, claim] of s.claims.entries()) if (ids.has(claim.plan) && inWindow(claim.at)) out.push({ ...prefix, plan: claim.plan, id: `claim-${s.id}-${n}`, at: claim.at, kind: 'event', semantic: 'started', verb: t('activity.verb.claimed'), text: claim.item ?? claim.phase ?? claim.plan })
    for (const ask of s.asks ?? []) if (!(s.answered ?? []).includes(ask.id) && !(s.answered ?? []).includes(ask.question) && inWindow(ask.at)) out.push({ ...prefix, id: `ask-${s.id}-${ask.id}`, at: ask.at, kind: 'event', semantic: 'waiting', verb: t('activity.verb.waiting'), text: ask.question })
    if (inWindow(s.startedAt)) out.push({ ...prefix, id: `start-${s.id}`, at: s.startedAt, kind: 'event', semantic: 'started', verb: t('activity.started'), text: t('activity.started') })
    if (s.endedAt !== undefined && inWindow(s.endedAt)) out.push({ ...prefix, id: `end-${s.id}`, at: s.endedAt, kind: 'event', verb: t('activity.ended'), text: t('activity.ended') })
    for (const [n, event] of (s.activityEvents ?? s.events ?? []).entries()) if (inWindow(event.at)) out.push({ ...prefix, id: `event-${s.id}-${event.at}-${n}`, at: event.at, kind: 'event', verb: t('activity.verb.updated'), text: event.text })
    for (const [n, d] of (s.decided ?? []).entries()) if (inWindow(d.at)) out.push({ ...prefix, id: `decision-${s.id}-${d.at}-${n}`, at: d.at, kind: 'decision', semantic: 'change', verb: t('activity.verb.decided'), text: d.text })
  }
  for (const s of snap.sessions) if (s.question && inWindow(s.question.since)) out.push({ id: `question-${s.id}`, at: s.question.since, by: sessionName(s), kind: 'event', semantic: 'waiting', verb: t('activity.verb.waiting'), text: s.question.text })
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
}
export type ActivityActions = { filter: (kind: NonNullable<PanelUi['activityFilter']>) => void; more: () => void }
export function renderActivity({ Box, Text, Button }: Pick<ElementTable, 'Box' | 'Text' | 'Button'>, snap: Snapshot, ui: PanelUi, act: ActivityActions): RenderElement {
  const filter = ui.activityFilter ?? 'all', count = ui.activityCount ?? 40
  const rows = (snap.activity ?? []).filter(row => filter === 'all' || row.kind === filter)
  return <Box flexDirection="column">
    <Box flexDirection="row" flexWrap="wrap" gap={1}>{(['all', 'completion', 'event', 'decision'] as const).map(kind => <Button key={`activity-filter-${kind}`} plain onPress={() => act.filter(kind)}><Text color={filter === kind ? 'claude' : undefined} weight={filter === kind ? 'bold' : 'regular'} dimColor={filter !== kind}>{t(`activity.${kind}`)}</Text></Button>)}</Box>
    {rows.slice(0, count).map(row => <Box key={`activity-row-${row.id}`} flexDirection="column">
      <Text dimColor>{dateTime(row.at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {row.by}{row.plan ? ` · ${row.plan}` : ''}</Text>
      <Text wrap="wrap"><Text color={row.semantic === 'success' || (!row.semantic && row.kind === 'completion') ? 'success' : row.semantic === 'started' ? 'claude' : row.semantic === 'waiting' ? 'warning' : row.semantic === 'change' || row.kind === 'decision' ? 'suggestion' : undefined} weight="bold">{row.verb ?? t(row.kind === 'completion' ? 'activity.verb.done' : row.kind === 'decision' ? 'activity.verb.decided' : 'activity.verb.updated')}</Text>{row.text === row.verb ? '' : ` ${row.text}`}</Text>
    </Box>)}
    {rows.length === 0 ? <Text dimColor>{t('activity.empty')}</Text> : ''}
    {rows.length > count ? <Button key="activity-more" label={t('activity.more')} onPress={act.more} /> : ''}
  </Box>
}
