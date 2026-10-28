import type { ElementTable, RenderElement } from 'claude-code'
import type { PanelUi, SessionView, Snapshot } from '../types'
import { dateTime, number, t } from './i18n'
import { sessionName } from './model'
import { clip, minutes } from './util'
import { defaults } from './settings'
import { costHelp, tokenMark } from './ui-costs'
export type SessionAction = 'compact' | 'reconcile' | 'abort' | 'message'
export type SessionActions = { control: (session: SessionView, action: SessionAction) => void; select?: (id: string) => void }
export function renderSessions({ Box, Text, Button }: Pick<ElementTable, 'Box' | 'Text' | 'Button'>, snap: Snapshot, ui: PanelUi, act: SessionActions): RenderElement {
  const settings = snap.settings ?? defaults
  const sessions = snap.sessions.filter(s => s.isAlive && s.endedAt === undefined || snap.now - (s.endedAt ?? s.lastActivity) <= settings.retention * 3600_000)
    .sort((a, b) => Number(b.isAlive && b.endedAt === undefined) - Number(a.isAlive && a.endedAt === undefined) || b.lastActivity - a.lastActivity)
  const groups = new Map<string, SessionView[]>()
  for (const s of sessions) {
    const key = s.attribution.confident[0]?.plan ?? s.claims[0]?.plan ?? ''
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  return <Box flexDirection="column">{[...groups].map(([id, list]) => <Box flexDirection="column">
    <Text weight="bold">{id ? snap.plans.find(p => p.id === id)?.title ?? id : t('session.unassigned')}</Text>
    {list.map(s => {
      const alive = s.isAlive && s.endedAt === undefined
      const state = !alive ? t('session.ended') : s.question ? t('session.waiting') : s.working ? t('session.working') : t('session.idle', { n: minutes(snap.now - s.lastActivity) })
      const context = s.context
      const pct = context?.percent ?? (context?.tokens !== undefined && context.window > 0 ? Math.round(context.tokens / context.window * 100) : undefined)
      const color = pct !== undefined && pct >= settings.contextWarning ? 'warning' : 'subtle'
      const step = s.steps.find(x => x.status === 'doing')
      const selected = ui.expandedRow === `session:${s.id}`
      return <Box key={`session-entry-${s.id}`} flexDirection="column">
        <Box key={`session-row-${s.id}`} flexDirection="row" gap={1}>
          <Button key={`session-${s.id}`} plain onPress={() => act.select?.(s.id)}><Text weight={selected ? 'bold' : 'regular'} color={s.isSelf || selected ? 'claude' : undefined}>{sessionName(s)}</Text></Button>
          <Text dimColor>{s.kind === 'normal' ? '' : `${t(`session.${s.kind}`)} · `}{state}</Text>
        </Box>
        <Text dimColor wrap="wrap">{s.model ?? t('common.unavailable')} · {s.cost === undefined ? t('common.unavailable') : t('session.cost', { cost: number(s.cost, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }) })}</Text>
        {pct !== undefined && context ? <Text color={color} wrap="wrap">{t('session.context', { n: pct, used: number(context.tokens ?? 0, { notation: 'compact' }), total: number(context.window, { notation: 'compact' }) })} {'■'.repeat(Math.round(Math.max(0, Math.min(100, pct)) / 10))}{'·'.repeat(10 - Math.round(Math.max(0, Math.min(100, pct)) / 10))}</Text> : ''}
        {step ? <Text>◐ {step.title}</Text> : ''}
        {s.currentTools?.length ? <Text dimColor>{t('session.tool', { name: s.currentTools.map(c => c.name).join(' · ') })}</Text> : ''}
        {s.lastMessage ? <Text dimColor wrap="wrap">{t('session.lastMessage', { text: clip(s.lastMessage, 80) })}</Text> : ''}
        {!alive ? <Text dimColor>{dateTime(s.endedAt ?? s.lastActivity, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text> : selected ? <Box key={`session-menu-${s.id}`} borderStyle="round" borderColor="subtle" flexDirection="column">
          <Text weight="bold">{sessionName(s)}</Text>
          <Box flexDirection="row" gap={2}>
            {(['reconcile', 'message', 'compact', 'abort'] as const).filter(action => !(s.isSelf && (action === 'compact' || action === 'abort'))).map(action =>
              <Button key={`control-${action}-${s.id}`} plain onPress={() => act.control(s, action)}><Text>{trLabel(action, ui.confirmation?.key === `${action}:${s.id}`)}</Text>{action !== 'abort' ? tokenMark({ Text }) : ''}</Button>)}
          </Box>
          {(['reconcile', 'message', 'compact'] as const).filter(action => !(s.isSelf && action === 'compact')).map(action => <Text key={`control-help-${action}-${s.id}`} dimColor wrap="wrap">{costHelp(action)}</Text>)}
        </Box> : ''}
      </Box>
    })}
  </Box>)}</Box>
}
function trLabel(action: SessionAction, confirmation: boolean): string {
  return t(confirmation && action === 'abort' ? 'control.confirmAbort' : confirmation && action === 'compact' ? 'control.confirmCompact' : `control.${action}`)
}
