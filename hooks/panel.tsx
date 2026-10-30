import { number, dateTime, t as tr } from './i18n'
import { visiblePlans, completionHistory, sparkline, matchesFilter } from './overview'
import { defaults, renderSettings } from './settings'
import { renderPriorities, priorityOf, priorityMark, sortedItems } from './priorities'
import type { PriorityActions } from './priorities'
import { renderSessions } from './sessions'
import type { SessionActions } from './sessions'
import { renderActivity } from './activity'
import type { ActivityActions } from './activity'
import type { SettingsActions } from './settings'
// The /progress panel: waiting card, plan, phases, sessions, recent completions.

import type { Color, ElementTable, RenderElement } from 'claude-code'

import type { Item, PanelUi, Phase, Plan, SessionView, Snapshot } from '../types'
import { barSegs, focusPlanOf, sessionsOn } from './banner'
import { autoMark, autoGoalLabel } from './nudge'
import { currentPhase, displayList, awayDuration, describeApproval, isVisible, liveClaims, liveItems, phaseState, progress, sessionName } from './model'
import { ago, clip, hhmm, minutes, mmddhhmm, strWidth } from './util'

export type PanelActions = {
  selectTab?: (tab: NonNullable<PanelUi['tab']>) => void
  pickPlan?: (plan: string) => void
  filterItems?: (filter: NonNullable<PanelUi['itemFilter']>) => void
  searchItems?: (text: string) => void
  focusSearch?: () => void
  toggleDaily?: () => void
  settings?: SettingsActions
  priorities?: PriorityActions
  sessions?: SessionActions
  activity?: ActivityActions
  accept: (plan: string) => void
  reject: (plan: string) => void
  edit: (plan: string) => void
  toggleReview: () => void
  /** Keeps a reviewed change and clears its review; `rejectReview` reverses it. */
  approveReview: (id: string) => void
  rejectReview: (id: string) => void
  refresh: () => void
  pickNext: () => void
  /** Opens or closes a phase's items; `wasOpen` is how it was drawn. */
  togglePhase: (phaseId: string, wasOpen: boolean) => void
  toggleExpand: (key: string) => void
  toggleRelated: () => void
  toggleEnded: () => void
  /** Hides the away card until the next away window. */
  dismissAway: () => void
}

type Els = Pick<ElementTable, 'Box' | 'Text' | 'Button'> & Partial<Pick<ElementTable<'terminal'>, 'Input'>>

const sourceLabels = (): Record<string, string> => ({
  env: tr('panel.m001'), task: tr('panel.m002'), lineage: tr('panel.m003'), claim: tr('panel.m004'), repo: tr('panel.m005'), mention: tr('panel.m006'), worktree: tr('panel.m007'),
})

/** Who holds an item: a session, or a worker/subagent the session claimed on. */
type ClaimerView = { who: string; at: number; by?: string }

/* Progress tracking invariant. */
function claimLabel(c: ClaimerView, sessions: readonly SessionView[], now: number): string {
  if (!c.by) return c.who
  const age = tr('panel.m008', { p0: minutes(now - c.at) })
  const worker = sessions.find(s => s.steps.length > 0 && sessionName(s).trim() === c.by?.trim())
  if (!worker) return `${c.by} · ${age}`
  const done = worker.steps.filter(x => x.status === 'done').length
  return tr('panel.m009', { p0: c.by, p1: done, p2: worker.steps.length, p3: age })
}

export function renderPanel(els: Els, snap: Snapshot, ui: PanelUi, cols: number, glyph: string, act: PanelActions): RenderElement {
  const { Box, Text, Button } = els
  const tabs = ['progress', 'priorities', 'sessions', 'activity', 'settings'] as const
  const tab = tabs.includes(ui.tab!) ? ui.tab! : 'progress'
  const widths = tabs.map(name => strWidth(tr(`tabs.${name}`)) + 3)
  const gap = Math.min(3, Math.max(0, Math.floor((cols - widths.reduce((a, b) => a + b, 0)) / (tabs.length - 1))))
  return <Box flexDirection="column">
    <Box flexDirection="row" flexWrap="wrap" gap={gap}>{tabs.map((name, index) =>
      <Box key={`tab-column-${name}`} flexDirection="column" width={widths[index]} flexShrink={0}>
        <Button key={`tab-${name}`} plain hotkey={String(index + 1)} label={tr(`tabs.${name}`)} onPress={() => act.selectTab?.(name)}><Text color={tab === name ? 'claude' : undefined} weight={tab === name ? 'bold' : 'regular'} dimColor={tab !== name} wrap="truncate-end">{tr(`tabs.${name}`)}</Text></Button>
        <Text color={tab === name ? 'claude' : undefined}>{'   ' + (tab === name ? '━' : ' ').repeat(widths[index]! - 3)}</Text>
      </Box>
    )}</Box>
    <Text dimColor>{'─'.repeat(Math.max(1, cols))}</Text>
    <Box flexDirection="row" flexWrap="wrap" gap={1}>{visiblePlans(snap).map(plan => {
      const p = progress(plan)
      return <Button key={`overview-${plan.id}`} variant={(ui.pick ?? snap.focusPlan) === plan.id ? 'primary' : 'secondary'} label={`${plan.title} ${number(p.done)}/${p.isEstimate ? '~' : ''}${number(p.total)}`} onPress={() => act.pickPlan?.(plan.id)} />
    })}</Box>
    {tab === 'progress' ? renderProgress(els, snap, ui, cols, glyph, act) : <Box flexDirection="column">
      {tab === 'settings' && act.settings ? renderSettings(els, snap.settings ?? defaults, focusPlanOf(snap).plan, snap.planSettings?.[snap.focusPlan ?? ''] ?? {}, act.settings, ui) : tab === 'priorities' && act.priorities ? renderPriorities(els, focusPlanOf(snap).plan, snap.sessions, ui, act.priorities) : tab === 'sessions' && act.sessions ? renderSessions(els, snap, ui, act.sessions) : tab === 'activity' && act.activity ? renderActivity(els, snap, ui, act.activity) : <Text dimColor>{tr('common.unavailable')}</Text>}
    </Box>}
  </Box>
}

function renderProgress(els: Els, snap: Snapshot, ui: PanelUi, cols: number, glyph: string, act: PanelActions): RenderElement {
  const { Box, Text, Button } = els
  const now = snap.now
  const narrow = cols < 50
  const border = (color: Color) => (narrow ? {} : { borderStyle: 'round', borderColor: color })
  const rule = (title: string, color?: Color) => (
    <Text color={color ?? 'text'} weight="bold" wrap="truncate-end">
      {` ${title} `}{'─'.repeat(Math.max(0, cols - strWidth(title) - 3))}
    </Text>
  )
  const self = snap.sessions.find(s => s.isSelf)
  const byId = new Map(snap.plans.map(p => [p.id, p]))
  const picked = ui.pick ? byId.get(ui.pick) : undefined
  const plan: Plan | null = picked && picked.status !== 'abandoned' ? picked : focusPlanOf(snap).plan
  const out: RenderElement[] = []

  // ---- away (the card the person reads first when they come back) ----
  if (snap.away) {
    const a = snap.away
    const time = new Date(a.from).toDateString() !== new Date(a.to).toDateString() ? mmddhhmm : hhmm
    const rows: RenderElement[] = [
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="bold" color="success" wrap="truncate-end">{tr('panel.awayWindow', { from: time(a.from), to: time(a.to), duration: awayDuration(a.to - a.from) })}</Text>
        <Button key="away-dismiss" hotkey="d" label={tr('panel.m011')} onPress={() => act.dismissAway()} />
      </Box>,
    ]
    if (a.items.length) {
      rows.push(<Text dimColor wrap="truncate-end">{tr('panel.awayItems', { count: a.items.length })}</Text>)
      for (const it of a.items.slice(0, 8)) {
        rows.push(<Text wrap="truncate-end">    {clip(it.planTitle, 14)} · {clip(it.phase, 12)} › {clip(it.item, 28)}  <Text dimColor>{hhmm(it.at)}</Text></Text>)
      }
      if (a.items.length > 8) rows.push(<Text dimColor wrap="truncate-end">{tr('panel.awayMoreItems', { count: a.items.length - 8 })}</Text>)
    }
    if (a.steps.length) {
      rows.push(<Text dimColor wrap="truncate-end">{tr('panel.awaySteps', { count: a.steps.reduce((n, s) => n + s.titles.length, 0) })}</Text>)
      for (const s of a.steps) rows.push(<Text wrap="truncate-end">    {tr('panel.namedSteps', { name: clip(s.name, 18), steps: clip(displayList(s.titles), 40) })}</Text>)
    }
    if (a.decisions.length) {
      rows.push(<Text color="warning" wrap="truncate-end">{tr('panel.awayDecisions', { count: a.decisions.length })}</Text>)
      for (const d of a.decisions) {
        rows.push(<Text wrap="truncate-end">    {clip(d.text, 40)}  <Text dimColor>{d.reversible ? tr('panel.m020', { p0: d.undo ?? tr('panel.m021') }) : tr('panel.m022')}</Text></Text>)
      }
    }
    rows.push(<Text dimColor wrap="truncate-end">  {snap.waiting.length ? tr('panel.m023', { p0: snap.waiting.length }) : tr('panel.m024')}</Text>)
    out.push(<Box flexDirection="column" {...border('success')}>{rows}</Box>)
    out.push(<Text> </Text>)
  }

  // ---- waiting ----
  const awayDecisions = snap.waiting.filter(w => w.kind === 'decision')
  if (snap.waiting.length > 0) {
    out.push(rule(tr('panel.m025', { p0: snap.waiting.length }), 'warning'))
    const rows: RenderElement[] = []
    let firstDraft = true
    for (const w of snap.waiting) {
      if (w.kind === 'decision') continue
      if (w.kind === 'draft') {
        const p = byId.get(w.plan)
        rows.push(<Text wrap="truncate-end"><Text color="warning">{tr('panel.m026')}</Text><Text weight="bold">{w.plan}</Text> · {number(w.phases)}{tr('panel.m027')}{clip(p?.criteria ?? '', 30)}</Text>)
        if (firstDraft) {
          rows.push(
            <Box flexDirection="row" gap={2}>
              <Button key="accept" hotkey="a" variant="primary" label={tr('panel.m028')} onPress={() => act.accept(w.plan)} />
              <Button key="edit" hotkey="e" label={tr('panel.m029')} onPress={() => act.edit(w.plan)} />
              <Button key="reject" hotkey="x" label={tr('panel.m030')} onPress={() => act.reject(w.plan)} />
            </Box>,
          )
          firstDraft = false
        } else rows.push(<Text dimColor>  /progress accept {w.plan}</Text>)
      } else if (w.kind === 'review') {
        const reviews = byId.get(w.plan)?.reviews ?? []
        const only = reviews.length === 1 ? reviews[0] : undefined
        rows.push(
          <Box flexDirection="row">
            <Text wrap="truncate-end"><Text color="warning">{tr('panel.reviewCount', { count: w.count })}</Text>{clip(w.first, 30)}{w.count > 1 ? tr('panel.m033') : ''}  </Text>
            {only ? [
              <Button key={`ok-${only.id}`} hotkey="y" label={tr('panel.m036')} onPress={() => act.approveReview(only.id)} />,
              <Button key={`no-${only.id}`} hotkey="n" label={tr('panel.m037')} onPress={() => act.rejectReview(only.id)} />,
            ] : null}
            <Button key={`v-${w.plan}`} hotkey="v" label={tr('panel.m034')} onPress={() => act.toggleReview()} />
          </Box>,
        )
        if (ui.showReview) {
          for (const r of reviews) {
            rows.push(
              <Box flexDirection="row">
                <Text wrap="truncate-end">  {clip(r.summary, 40)} <Text dimColor>{ago(now - r.at)} · {r.reason}{r.relayedBy ? tr('panel.m035', { p0: r.relayedBy }) : ''}</Text>  </Text>
                {only ? null : [
                  <Button key={`ok-${r.id}`} label={tr('panel.m036')} onPress={() => act.approveReview(r.id)} />,
                  <Button key={`no-${r.id}`} label={tr('panel.m037')} onPress={() => act.rejectReview(r.id)} />,
                ]}
              </Box>,
            )
          }
        }
      } else if (w.kind === 'ask') {
        rows.push(
          <Text wrap="truncate-end" color="warning">{tr('panel.m038')}{clip(w.question, 40)}  <Text dimColor>· {clip(w.name, 16)} · {tr('panel.waitAge', { count: minutes(now - w.at) })}{w.also > 0 ? tr('panel.m040', { p0: w.also }) : ''}</Text></Text>,
        )
        if (w.options?.length) rows.push(<Text dimColor wrap="truncate-end">{tr('panel.m041')}{displayList(w.options.map(o => clip(o, 16)))}</Text>)
      } else {
        rows.push(<Text wrap="truncate-end" color="warning">⚑ {clip(w.name, 24)}{tr('panel.noUpdate', { count: minutes(now - w.since) })}</Text>)
      }
    }
    if (awayDecisions.length) {
      rows.push(<Text wrap="truncate-end" color="warning">{tr('panel.decisionCount', { count: awayDecisions.length })}<Text dimColor>{tr('panel.m046')}</Text></Text>)
    }
    out.push(<Box flexDirection="column" {...border('warning')}>{rows}</Box>)
  }

  // ---- plan ----
  if (plan) {
    const mine = new Set((self?.claims ?? []).filter(c => c.plan === plan.id && c.item).map(c => c.item as string))
    const pr = progress(plan, mine)
    const pct = pr.total > 0 ? Math.round((pr.done / pr.total) * 100) : 0
    const barCells = Math.max(8, Math.min(60, cols - 2))
    out.push(<Text> </Text>)
    out.push(
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="bold" wrap="truncate-end">{plan.status === 'done' ? '✓ ' : ''}{plan.title}</Text>
        <Text><Text weight="bold">{number(pr.done)} / {number(pr.planned)}</Text>{pr.unplannedPhases ? <Text dimColor> +{number(pr.unplannedPhases)}</Text> : ''}{pr.wrapping ? <Text color="warning">{tr('panel.m047')}{number(pr.wrapping)}</Text> : ''} · {number(pct)}%</Text>
      </Box>,
    )
    const monitor = snap.monitors?.[plan.id]
    if (plan.status === 'active' && monitor && (monitor.lastRun !== undefined || monitor.open > 0) && (monitor.enabled || monitor.open > 0)) {
      const cost = monitor.lastRun !== undefined ? tr('panel.m048', { p0: number(monitor.todayCost, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) }) : ''
      out.push(<Text dimColor wrap="truncate-end">{tr('panel.monitorSummary', { time: monitor.lastRun !== undefined ? hhmm(monitor.lastRun) : tr('panel.m050'), count: monitor.open, cost })}</Text>)
    }
    out.push(<Text>{bar(Text, [pr.done, pr.wrapping, pr.mine, pr.todo, pr.unplannedEst], barCells, glyph)}</Text>)
    const history = completionHistory(plan, now), completed = history.reduce((n, day) => n + day.count, 0)
    out.push(<Text wrap="truncate-end">{sparkline(history.map(day => day.count))} · {tr('overview.history', { count: completed })}</Text>)
    out.push(<Button key="trend-data" plain label={tr(ui.showDaily ? 'overview.hideDaily' : 'overview.showDaily')} onPress={() => act.toggleDaily?.()} />)
    if (ui.showDaily) out.push(<Text dimColor wrap="wrap">{tr('overview.showDaily')}: {history.map(day => `${dateTime(day.at, { month: 'short', day: 'numeric' })}: ${number(day.count)}`).join(' · ')}</Text>)
    out.push(<Box flexDirection="row" flexWrap="wrap" gap={1}>{(['all', 'doing', 'wrapping', 'todo', 'done'] as const).map(filter => <Button key={`filter-${filter}`} plain onPress={() => act.filterItems?.(filter)}><Text color={(ui.itemFilter ?? 'all') === filter ? 'claude' : undefined} weight={(ui.itemFilter ?? 'all') === filter ? 'bold' : 'regular'} dimColor={(ui.itemFilter ?? 'all') !== filter}>{tr(`filter.${filter}`)}</Text></Button>)}</Box>)
    const { Input } = els
    if (Input) out.push(<Input key="search-items" label={tr('overview.search')} value={ui.search ?? ''} placeholder={tr('overview.searchHint')} onInput={text => act.searchItems?.(text)} onSubmit={text => act.searchItems?.(text)} />)
    else out.push(<Button key="search-items" label={tr('overview.search')} onPress={() => act.focusSearch?.()} />)
    out.push(<Text wrap="wrap" dimColor>{tr('panel.m053')}{plan.criteria}</Text>)
    out.push(<Text wrap="wrap" dimColor>{tr('panel.planSummary', { count: sessionsOn(snap, plan.id), age: ago(now - plan.updatedAt), approval: describeApproval(plan.approval) })}</Text>)

    out.push(<Text> </Text>)
    out.push(rule(tr('panel.m056')))
    const cur = currentPhase(plan)
    const claimers = new Map<string, ClaimerView[]>()
    for (const s of snap.sessions) {
      if (!s.isAlive || s.endedAt !== undefined) continue
      for (const c of s.claims) {
        if (c.plan !== plan.id || !c.item) continue
        const who = s.isSelf ? tr('panel.m057') : clip(sessionName(s), 12)
        claimers.set(c.item, [...(claimers.get(c.item) ?? []), { who, at: c.at, ...(c.by ? { by: c.by } : {}) }])
      }
    }
    // A repo whose phases are all done collapses to one line.
    const repos = new Map<string, Phase[]>()
    for (const ph of plan.phases) if (ph.repo) repos.set(ph.repo, [...(repos.get(ph.repo) ?? []), ph])
    const collapsed = new Set([...repos].filter(([, ps]) => ps.every(p => ['void', 'cleared', 'done'].includes(phaseState(p)))).map(([r]) => r))
    const shownRepo = new Set<string>()
    const filtering = !!ui.search?.trim() || (!!ui.itemFilter && ui.itemFilter !== 'all')
    let matchCount = 0
    for (const ph of plan.phases) {
      if (!filtering && ph.repo && collapsed.has(ph.repo)) {
        if (!shownRepo.has(ph.repo)) {
          shownRepo.add(ph.repo)
          out.push(<Text color="success">  ✓ {tr('panel.completedRepo', { repo: ph.repo, count: repos.get(ph.repo)?.length ?? 0 })}</Text>)
        }
        continue
      }
      // Work runs in parallel: besides the first unfinished phase, any phase with an item in hand or wrapping opens.
      const byDefault = ph === cur || liveItems(ph).some(i => claimers.has(i.id) || i.status === 'wrapping')
      const isOpen = ui.expanded.includes(`open-${ph.id}`) ? true : ui.expanded.includes(`shut-${ph.id}`) ? false : byDefault
      const matching = ph.items.filter(item => item.status !== 'void' && matchesFilter(item, ui, claimers.has(item.id)))
      matchCount += matching.length
      const shownPhase = filtering && matching.length ? { ...ph, items: matching } : ph
      out.push(...phaseRows(els, shownPhase, ph === cur, filtering ? matching.length > 0 : isOpen, claimers, snap.sessions, plan.milestones ?? [], filtering ? { ...ui, expanded: [...ui.expanded, `ph-${ph.id}`] } : ui, now, cols, narrow, glyph, act))
    }
    if (filtering && !matchCount) out.push(<Text dimColor>{tr('overview.noMatches')}</Text>)
    const ret = plan.reverts.at(-1)
    const notes: string[] = []
    if (plan.reverts.length) notes.push(tr('panel.m060', { p0: plan.reverts.length, p1: ret?.item ?? '', p2: clip(ret?.reason ?? '', 24) }))
    if (plan.voided) notes.push(tr('panel.m061', { p0: plan.voided }))
    if (plan.added) notes.push(tr('panel.m062', { p0: plan.added }))
    if (notes.length) out.push(<Text dimColor wrap="truncate-end">  {notes.join('   ')}</Text>)
  } else if (!snap.waiting.some(w => w.kind === 'draft')) {
    // A pending draft already has its card above: "no plan yet" next to it would contradict it.
    out.push(<Text> </Text>)
    out.push(<Text color="subtle">{tr('panel.m063')}</Text>)
  }

  // ---- sessions ----
  out.push(<Text> </Text>)
  out.push(rule(tr('panel.m064')))
  const live = snap.sessions.filter(s => s.isAlive && s.endedAt === undefined && (s.isSelf || isVisible(s)))
  const onPlan = (s: SessionView) => plan !== null && s.attribution.confident.some(c => c.plan === plan.id)
  const children = (id: string) => live.filter(s => s.parent === id && !s.isSelf)
  const top = live.filter(s => s.isSelf || (onPlan(s) && !(s.parent && live.some(p => p.id === s.parent && (p.isSelf || onPlan(p))))))
  const related = live.filter(s => !s.isSelf && !top.includes(s) && !live.some(p => p.id === s.parent) &&
    (plan ? s.attribution.speculative.some(c => c.plan === plan.id) : !!self?.repoKey && s.repoKey === self.repoKey))
  for (const s of top) out.push(sessionCard(els, s, children(s.id), snap.plans, now, narrow, glyph, border, null))
  if (related.length) {
    out.push(<Button key="related" plain onPress={() => act.toggleRelated()}>{ui.showRelated ? '▾' : '▸'}{tr('panel.relatedCount', { count: related.length })}</Button>)
    if (ui.showRelated) {
      for (const s of related) {
        const src = s.attribution.speculative.find(c => c.plan === plan?.id)?.source
        out.push(sessionCard(els, s, [], snap.plans, now, narrow, glyph, border, src ? sourceLabels()[src] ?? src : tr('panel.m067')))
      }
    }
  }

  // ---- recent ----
  if (snap.recent.length) {
    out.push(<Text> </Text>)
    out.push(rule(tr('panel.m068')))
    for (const r of snap.recent.slice(0, 6)) {
      out.push(
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">  {hhmm(r.at)}  {r.text}</Text>
          <Text color={r.tag.startsWith('▒') ? 'warning' : 'success'}>{r.tag}</Text>
        </Box>,
      )
    }
  }
  const ended = snap.sessions.filter(s => (s.endedAt !== undefined || !s.isAlive) && now - (s.endedAt ?? s.lastActivity) < 24 * 3600_000 && isVisible(s))
  if (ended.length) {
    out.push(<Button key="ended" plain onPress={() => act.toggleEnded()}>{ui.showEnded ? '▾' : '▸'}{tr('panel.endedCount', { count: ended.length })}</Button>)
    if (ui.showEnded) for (const s of ended) out.push(<Text dimColor wrap="truncate-end">    {clip(sessionName(s), 30)} · {ago(now - (s.endedAt ?? s.lastActivity))}</Text>)
  }

  out.push(<Text> </Text>)
  out.push(
    <Box flexDirection="row" gap={2}>
      <Button key="refresh" hotkey="r" label={tr('panel.m071')} onPress={() => act.refresh()} />
    </Box>,
  )
  return <Box flexDirection="column">{out}</Box>
}

function bar(Text: Els['Text'], counts: number[], cells: number, glyph: string): RenderElement[] {
  return barSegs(counts, [{ color: 'success' }, { color: 'warning' }, { color: 'claude' }, { color: 'subtle' }, { color: 'inactive', dim: true }], cells, 3, glyph)
    .map(s => <Text color={s.color} dimColor={!!s.dim}>{s.t}</Text>)
}

function phaseRows(els: Els, ph: Phase, isCurrent: boolean, isPhaseOpen: boolean, claimers: Map<string, ClaimerView[]>,
  sessions: readonly SessionView[], milestones: readonly string[], ui: PanelUi, now: number, cols: number, narrow: boolean, glyph: string,
  act: PanelActions): RenderElement[] {
  const { Box, Text, Button } = els
  const st = phaseState(ph)
  const items = sortedItems(ph).filter(i => i.status !== 'void')
  const d = items.filter(i => i.status === 'done').length
  const w = items.filter(i => i.status === 'wrapping').length
  const t = items.length
  const small = (cells: number) => (narrow ? [] : bar(Text, [d, w, 0, t - d - w, 0], cells, glyph))
  const right = (
    <Text>{small(8)} {number(d).padStart(2)}/{number(t)}{w ? <Text color="warning">  +{number(w)}{tr('panel.m073')}</Text> : ''}</Text>
  )
  if (st === 'void') return [<Text dimColor wrap="truncate-end">  ✕ {tr('panel.voidPhase', { name: ph.name, reason: clip(ph.voidReason ?? '', 20) })}</Text>]
  if (st === 'cleared') return [<Text dimColor wrap="truncate-end">  ✕ {ph.name}{tr('panel.m075')}</Text>]
  if (st === 'unplanned') return [<Text color="inactive" wrap="truncate-end">  ┄ {ph.name}{tr('panel.m076')}</Text>]
  const icon = st === 'done' ? '✓' : st === 'active' ? '◐' : '·'
  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      <Button key={`phase-${ph.id}`} plain label={`${isPhaseOpen ? tr('panel.m077') : tr('panel.m078')} ${ph.name}`} onPress={() => act.togglePhase(ph.id, isPhaseOpen)}>
        <Text color={isCurrent ? 'claude' : st === 'done' ? 'success' : 'text'} weight={isCurrent ? 'bold' : 'regular'}>{isCurrent ? '▌' : ' '}{isPhaseOpen ? '▾' : '▸'} {icon} {ph.name}</Text>
        {ph.repo ? <Text dimColor>  {ph.repo}</Text> : ''}
      </Button>
      {right}
    </Box>
  )
  if (!isPhaseOpen) return [header]
  const rows: RenderElement[] = [header]
  const key = `ph-${ph.id}`
  const isOpen = ui.expanded.includes(key)
  // Only a dated completion is recent: imported history has no time and would claim a slot.
  const recentDone = items.filter(i => i.status === 'done' && i.doneAt !== undefined).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 2)
  const shown = items.length <= 8 || isOpen
    ? items
    : items.filter(i => i.status === 'wrapping' || claimers.has(i.id) || recentDone.includes(i))
  // Milestones: dots right after the title (gold for passed, subtle for the rest), never red; a done
  // item passed them all, so it shows none. The next station is named when the row has room.
  const marks = (i: Item): RenderElement[] => {
    if (milestones.length === 0 || i.status === 'done' || i.status === 'void') return []
    const passed = Math.min(milestones.length, Math.max(0, i.milestone ?? 0))
    const next = passed < milestones.length ? tr('panel.m079', { p0: milestones[passed] }) : ''
    const room = next && strWidth(i.title) + milestones.length + strWidth(next) + 14 <= cols
    return [
      <Text color="success">{'●'.repeat(passed)}</Text>,
      <Text color="subtle">{'○'.repeat(milestones.length - passed)}</Text>,
      ...(room ? [<Text dimColor>{` ${next}`}</Text>] : []),
    ]
  }
  const itemRow = (i: Item) => {
    const who = claimers.get(i.id), level = priorityOf(ph, i)
    const title = <Text color={level === 'pinned' || level === 'high' ? 'claude' : level === 'low' || level === 'deferred' ? 'subtle' : undefined}>{priorityMark(level)}{i.title}</Text>
    // Only a known completion time is shown: an item imported as already done has none, and its last
    // update (the import) would read as if it had just finished.
    if (i.status === 'done') return <Text color="success" wrap="truncate-end">│   ✓ {title}{i.doneAt !== undefined ? <Text dimColor>  {hhmm(i.doneAt)}</Text> : null}</Text>
    if (i.status === 'wrapping') return <Text color="warning" wrap="truncate-end">│   ▒ {title}  {marks(i)}{tr('panel.m080')}{i.exception ? tr('panel.m081', { p0: clip(i.exception, 16) }) : ''}</Text>
    if (who?.length) return <Text wrap="truncate-end"><Text color="claude">│   ◐ {title}</Text>  {marks(i)}<Text dimColor>  ← {displayList(who.map(x => claimLabel(x, sessions, now)))}</Text></Text>
    return <Text color="subtle" wrap="truncate-end">│   · {title}  {marks(i)}</Text>
  }
  rows.push(...shown.map(itemRow))
  const hidden = items.length - shown.length
  if (hidden > 0 || isOpen) {
    rows.push(<Button key={key} plain onPress={() => act.toggleExpand(key)}>{isOpen ? tr('panel.m082') : tr('panel.m083', { p0: hidden })}</Button>)
  }
  void now
  return rows
}

function sessionCard(els: Els, s: SessionView, kids: SessionView[], plans: readonly Plan[], now: number, narrow: boolean, glyph: string,
  border: (c: Color) => Record<string, unknown>, source: string | null): RenderElement {
  const { Box, Text } = els
  // Claims on ended plans are released: neither listed nor counted.
  const claims = liveClaims(s.claims, plans)
  const done = s.steps.filter(x => x.status === 'done').length
  const running = s.bg.filter(b => b.endedAt === undefined)
  const name = clip(sessionName(s), 28)
  const idle = minutes(now - s.lastActivity)
  // Progress tracking invariant.
  const auto = s.isSelf && !s.goal?.trim() && s.autoGoal?.trim() ? `${autoGoalLabel(s.autoGoal)}${autoMark()}` : ''
  const head = s.isSelf ? tr('panel.m084', { p0: name }) : s.kind === 'orchestrator' ? tr('panel.m085', { p0: name }) : name
  const roles = new Map<string, number>()
  for (const k of kids) roles.set(k.role ?? tr('panel.m086'), (roles.get(k.role ?? tr('panel.m087')) ?? 0) + 1)
  const body: RenderElement[] = [
    <Box flexDirection="row" justifyContent="space-between">
      {auto
        ? <Text weight="bold" color="claude" wrap="truncate-end">{tr('panel.m088')}<Text weight="regular" color="subtle">{auto}</Text></Text>
        : <Text weight={s.isSelf ? 'bold' : 'regular'} color={s.isSelf ? 'claude' : 'text'} wrap="truncate-end">{head}</Text>}
      <Text dimColor>{s.kind === 'orchestrator' ? tr('panel.m089', { p0: claims.length }) : s.steps.length ? `${number(done)}/${number(s.steps.length)}` : ''}  {tr('panel.startedAt', { time: hhmm(s.startedAt) })}</Text>
    </Box>,
  ]
  if (s.isSelf) {
    if (s.steps.length) {
      body.push(
        <Text wrap="wrap">
          {'  '}
          {s.steps.map(x => (
            <Text color={x.status === 'done' ? 'success' : x.status === 'doing' ? 'claude' : 'subtle'}>
              {x.status === 'done' ? '✓' : x.status === 'doing' ? '◐' : '·'} {x.title}{'   '}
            </Text>
          ))}
        </Text>,
      )
    }
    if (running.length) {
      body.push(<Text dimColor wrap="truncate-end">{tr('panel.m091')}{running.map(b => tr('panel.m092', { p0: clip(b.name, 16), p1: minutes(now - b.startedAt) })).join(' · ')}</Text>)
    }
    for (const c of claims) {
      const plan = plans.find(p => p.id === c.plan)
      const phase = plan?.phases.find(p => p.id === c.phase)
      const item = phase?.items.find(i => i.id === c.item) ?? plan?.phases.flatMap(p => p.items).find(i => i.id === c.item)
      const where = `${c.phase ? ` › ${clip(phase?.name ?? c.phase, 16)}` : ''}${c.item ? ` › ${clip(item?.title ?? c.item, 24)}` : ''}`
      body.push(<Text dimColor wrap="truncate-end">{tr('panel.m093')}{c.plan}{where} · {sourceLabels()[c.source] ?? c.source} · {ago(now - c.at)}</Text>)
    }
  } else {
    const cur = s.steps.find(x => x.status === 'doing')
    body.push(<Text dimColor wrap="truncate-end">  {cur ? `◐ ${clip(cur.title, 24)}   ` : ''}{tr('panel.m094')}{ago(now - s.lastActivity)}{running.length ? ` · ⟳ ${running.length}` : ''}</Text>)
  }
  if (roles.size) body.push(<Text dimColor>  └ {[...roles].map(([r, n]) => `${r} ×${number(n)}`).join(' · ')}</Text>)
  if (source) body.push(<Text dimColor>{tr('panel.m095')}{source}</Text>)
  if (s.cwdMissing) body.push(<Text color="warning">{tr('panel.m096')}</Text>)
  const color: Color = s.isSelf ? 'claude' : idle >= 15 ? 'inactive' : 'subtle'
  void glyph
  return <Box flexDirection="column" {...border(color)}>{body}</Box>
}
