import { createI18n, languageInstruction, mapLanguage, t as tr } from './i18n'
import { defaults, initialSettings, readSettings, cycleSetting, readPlanSettings, cyclePlanSetting, effectiveSettings, writeSetting, writePlanSetting, choices } from './settings'
import type { Settings } from './settings'
import type { Timer } from 'claude-code'
import { setPriority, priorityAdvice, takePriorityNotice, deviationReason } from './priorities'
import { controlSpec, controlRequest, dispatchRequest, dispatchTarget, createControlIntent, rememberControlPrompt, forgetControlPrompt, takeDispatchPermit, pinStartedDispatch, completeControlSend, runControlTool, receiveControl, isControl, allowControlSend, prepareControlSend, finishControlSend, collectControlResults, flushCompact } from './controls'
import { compactQuotes, rememberQuote } from './quotes'
import { isNativeLookup, readNativeListing, selfNativeAddress } from './native-address'
import { activityOf } from './activity'
import { visiblePlans } from './overview'
import { notifyWaiting } from './notifications'
import { writeReport } from './report'
import { importSource, reconcileImports } from './importers'
import type { I18nController } from './i18n'
export let i18n: I18nController | null = null
// progress-board: session + overall-plan progress band, /progress panel, model tools, hook recording.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Approval, BgTask, Claim, PanelUi, Plan, SessionRec, SessionView, Snapshot } from '../types'
import { activePlanIds, exportPlanOf, inheritFrom, isReviewer, resolveAttributions, taskPlanOf } from './attrib'
import { buildBanner, focusPlanOf } from './banner'
import { WORKER_DUTY, bashSignal, recordEvent, takeProgressReminder } from './freshness'
import type { ProgressEvent } from '../types'
import { attachCreatedPr, CHECK_MS, pollFacts } from './facts'
import { monitorView, runMonitor, takeSuggestions } from './monitor'
import {
  RETAIN_MS, answeredQuestions, applyUndo, awayReportOf, dispatchItemOf, isAskAnswered, liveClaims, liveItemClaims, publishKey, questionApprovals, recordAnswers, rejectDraft, renderPlanMd, sessionFate, sessionName, waitingItems, withSuccessors,
} from './model'
import { renderPanel } from './panel'
import { ENFORCE_DENY, RECENT_CALLS, autoGoalOf, callSummary, firstMessageOf, isOwnPrompt, shouldEnforce, takeStepNudge } from './nudge'
import {
  LogTail, Paths, SessionSaver, ioFor, isIndexableRepo, listPlanIds, mutatePlan, parseJson, readPlan, readRepo, repoKeyOf, saveSession, touchRepo,
} from './store'
import type { Io } from './store'
import { parseDecisionArgs, planSpec, runPlanTool, runSessionTool, sessionSpec } from './tools'
import type { ToolCtx } from './tools'
import { PLAN_ID, clip, envFileText, normQuote, shortHash } from './util'

const PANE = 'progress-board'
const COMMAND = 'progress'
const PLUGIN_NAME = 'progress-board'
const SKILL_NAME = 'progress-board'
const QUALIFIED_SKILL = `${PLUGIN_NAME}:${SKILL_NAME}`
const REFRESH_MS = 10_000
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const DAY = 24 * 3600_000

const snapshot = atom({ plugin: 'progress-board', key: 'snapshot' } as const, null)
const uiState = atom({ plugin: 'progress-board', key: 'ui' } as const,
  { expanded: [], showReview: false, selectedReview: null, showRelated: false, showEnded: false, pick: null } as PanelUi)
const tick = atom({ plugin: 'progress-board', key: 'tick' } as const, 0)
const localeVersion = atom({ plugin: 'progress-board', key: 'localeVersion' } as const, 0)
const headless = atom({ plugin: 'progress-board', key: 'isHeadless' } as const, false)

let glyph = '■'
// Module state. A reload starts it over; the first hook that runs afterwards (session.start, or any other
// when a mid-session reload skipped it) rebuilds it from disk through `ensureInit`.
let io: Io | null = null
let paths: Paths | null = null
let saver: SessionSaver | null = null
let logTail: LogTail | null = null
let home = ''
let self: SessionRec | null = null
let isOff = false
let initP: Promise<void> | null = null
let isRegistered = false
let hasTimers = false
let isWorking = false
let runningTurn: string | undefined
const dispatching = new Set<string>()
async function confirmed($: EngineInterface, key: string): Promise<boolean> {
  const at = await $.clock.now(); let accepted = false
  await update($, uiState, state => {
    accepted = state.confirmation?.key === key && state.confirmation.until > at
    return { ...state, interruptDispatch: accepted ? state.interruptDispatch : false, confirmation: accepted ? undefined : { key, until: at + 5000 } }
  })
  if (!accepted) $.clock.after(5000, () => { void update($, uiState, state => state.confirmation?.key === key && state.confirmation.until <= at + 5000 ? { ...state, confirmation: undefined, interruptDispatch: false } : state) })
  return accepted
}
let lastSnapKey = ''
let lastSnap: Snapshot | null = null
let lastCleanup = 0
let lastExport = ''
let refreshP: Promise<void> | null = null
let refreshAgain = false
const planCache = new Map<string, { m: number; plan: Plan }>()
const sessCache = new Map<string, { m: number; rec: SessionRec }>()
let pidAlive = new Map<number, boolean>()
let isEnforce = true
let settings: Settings = { ...defaults }
let initial: Settings = { ...defaults }
let monitorTimer: Timer | undefined
let monitorTick = 0
async function syncSettings($: EngineInterface): Promise<void> {
  settings = await readSettings($, initial)
  glyph = settings.barGlyph; isEnforce = settings.enforceGoal
  rescheduleMonitor($)
}
function rescheduleMonitor($: EngineInterface): void {
  const cadence = Math.min(settings.monitorMinutes, ...Object.values(lastSnap?.planSettings ?? {}).map(p => p.monitorMinutes ?? settings.monitorMinutes)) * 60_000
  if (hasTimers && cadence !== monitorTick) {
    monitorTimer?.cancel(); monitorTick = cadence
    monitorTimer = $.clock.every(cadence, () => monitorVisiblePlans($))
  }
  for (const [id, stop] of monitorStops) if (!(lastSnap?.planSettings?.[id]?.monitor ?? settings.monitor)) stop.abort()
}
let mainSeen = false
let monitoring = false
const monitorStops = new Map<string, AbortController>()

const now = ($: EngineInterface) => $.clock.now()

async function repoOf($: EngineInterface, cwd: string): Promise<{ key: string; root: string } | null> {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeoutMs: 5000 })
    if (r.exitCode !== 0) return null
    const dir = r.stdout.trim().replace(/\/+$/, '')
    const root = dir.endsWith('/.git') ? dir.slice(0, -5) : dir
    if (!isIndexableRepo(root, home)) return null
    return { key: repoKeyOf(root, shortHash), root }
  } catch {
    return null
  }
}

function freshSession(id: string, cwd: string, t: number): SessionRec {
  return {
    v: 1, id, kind: 'normal', startedAt: t, cwd, steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: t, lastUserInput: t, limits: [],
  }
}

/** A process's start identity (Linux: /proc stat start ticks; elsewhere `ps` start time), so a reused PID is told apart. */
async function procStart($: EngineInterface, pid: number): Promise<string | undefined> {
  if (await $.fs.exists('/proc/self').catch(() => false)) {
    const stat = await $.fs.read(`/proc/${pid}/stat`).then(t => t as string, () => null)
    const after = stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ') : []
    return after[19] || undefined
  }
  const r = await $.process.run(['ps', '-o', 'lstart=', '-p', String(pid)], { timeoutMs: 3000 }).catch(() => null)
  return r?.stdout.trim() || undefined
}

/** The plan this session exports to what it starts: from its current state, and only when unambiguous. */
async function eligibleExport(): Promise<string | undefined> {
  if (!self) return undefined
  const plans = await loadPlans()
  const active = activePlanIds(plans)
  const recs = [self, ...(await loadSessions()).filter(r => r.id !== self?.id)]
  const mine = resolveAttributions(recs, active, () => [], plans).get(self.id)
  return mine ? exportPlanOf(mine) : undefined
}

/** Exports PROGRESS_BOARD_PARENT / PROGRESS_BOARD_PLAN when they changed (process env, and quoted in CLAUDE_ENV_FILE). */
async function exportEnv($: EngineInterface): Promise<void> {
  if (!self) return
  const plan = await eligibleExport().catch(() => undefined)
  const key = `${self.id}|${plan ?? ''}`
  if (key === lastExport) return
  lastExport = key
  const a = await $.env.set('PROGRESS_BOARD_PARENT', self.id).catch(() => ({ deny: 'failed' }))
  const b = await $.env.set('PROGRESS_BOARD_PLAN', plan).catch(() => ({ deny: 'failed' }))
  const envFile = await $.env.get('CLAUDE_ENV_FILE').catch(() => undefined)
  if (envFile && io) {
    await io.append(envFile, envFileText(self.id, plan)).catch(() => undefined)
  } else if (!self.limits.includes('no-env-file')) {
    self.limits.push('no-env-file')
  }
  if (('deny' in a && a.deny) || ('deny' in b && b.deny)) {
    if (!self.limits.includes('env-set-denied')) self.limits.push('env-set-denied')
  }
}

async function captureUsage($: EngineInterface): Promise<void> {
  if (!self) return
  const usage = await $.session.usage().catch(() => undefined)
  if (!usage) return
  self.context = usage.context
  if (usage.cost) self.cost = usage.cost.usd
}

async function saveSelf($: EngineInterface, force = false): Promise<void> {
  if (!saver) return
  if (self) { self.controlVersion = 1; await compactQuotes(self) }
  await saver.save(() => self, await now($), force)
}

let learningNativeName = false
async function captureNativeName($: EngineInterface, s: SessionRec, force = false): Promise<void> {
  if ((!force && s.nativeName) || learningNativeName) return
  learningNativeName = true
  try {
    const address = selfNativeAddress(await readNativeListing($))
    if (address && self === s && await $.session.id() === s.id) {
      Object.assign(s, address)
      await saveSelf($, true)
    }
  } finally { learningNativeName = false }
}

/** The session record for the current id; a /clear moves to a new id that inherits from the old one. */
async function ensureSelf($: EngineInterface): Promise<SessionRec | null> {
  if (isOff || !io || !paths) return null
  const id = await $.session.id()
  if (self && self.id === id) { await captureNativeName($, self); return self }
  const t = await now($)
  const cwd = await $.session.cwd()
  const existing = parseJson<SessionRec>(await io.read(paths.session(id)))
  if (existing && existing.v === 1) {
    self = existing
    await captureNativeName($, self)
    return self
  }
  const prev = self
  const rec = freshSession(id, cwd, t)
  if (prev) {
    // Same process after /clear: same terminal, so inherit goal and claims on still-active plans.
    const active = activePlanIds(await loadPlans())
    Object.assign(rec, inheritFrom(prev, active, t), {
      parent: prev.id, parentSource: 'clear' as const, repoKey: prev.repoKey, repoRoot: prev.repoRoot, pid: prev.pid,
      ...(prev.pidStart ? { pidStart: prev.pidStart } : {}), limits: [...prev.limits],
    })
    if (prev.endedAt === undefined) {
      prev.endedAt = t
      prev.endReason = 'clear'
      await saveSession(io, paths, prev).catch(() => undefined)
    }
  }
  self = rec
  await captureNativeName($, rec)
  await saveSelf($, true)
  await exportEnv($)
  return self
}

async function startSession($: EngineInterface, cwd: string): Promise<void> {
  home = (await $.env.get('HOME')) ?? ''
  if (!home) { isOff = true; return }
  io = ioFor($)
  paths = Paths.forHome(home)
  saver = new SessionSaver(io, paths)
  logTail = new LogTail(io, paths)
  const id = await $.session.id()
  const existing = parseJson<SessionRec>(await io.read(paths.session(id)))
  const t = await now($)
  if (existing && existing.v === 1) {
    self = existing
    if (self.endedAt !== undefined && self.endReason !== 'clear') { delete self.endedAt; delete self.endReason }
  } else {
    self = freshSession(id, cwd, t)
    const envPlan = (await $.env.get('PROGRESS_BOARD_PLAN'))?.trim()
    const envParent = (await $.env.get('PROGRESS_BOARD_PARENT'))?.trim()
    // Inherited values are untrusted text: only a well-formed plan id / session id is kept.
    if (envPlan && PLAN_ID.test(envPlan)) self.envPlan = envPlan
    const pid = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 3000 }).then(r => Number(r.stdout.trim()) || undefined, () => undefined)
    if (pid) {
      self.pid = pid
      const st = await procStart($, pid).catch(() => undefined)
      if (st) self.pidStart = st
    }
    if (envParent && envParent !== id && /^[A-Za-z0-9_.-]+$/.test(envParent)) {
      const parentRec = parseJson<SessionRec>(await io.read(paths.session(envParent)))
      self.parent = envParent
      if (parentRec && pid && parentRec.pid === pid) {
        // Our own process exported that variable before a /clear: same terminal, not a dispatch.
        self.parentSource = 'clear'
        Object.assign(self, inheritFrom(parentRec, activePlanIds(await loadPlans()), t))
      } else {
        self.parentSource = 'env'
        self.kind = 'dispatched'
      }
    }
    const repo = await repoOf($, cwd)
    if (repo) { self.repoKey = repo.key; self.repoRoot = repo.root }
  }
  await captureNativeName($, self, true)
  await saveSelf($, true)
  await exportEnv($)
}

/**
 * Registers the tools and the command. Registration rejects until the session binds, and the first hook
 * to run (classic.SessionStart) can come before that, so each part is retried on later hooks until it
 * succeeds; an "already registered" refusal counts as done. Enforcement waits for the tools (isToolsReady).
 */
const isAlreadyRegistered = (err: unknown) => /already/i.test(String((err as { message?: string })?.message ?? err))
let isToolsReady = false
let isCommandReady = false
async function registerAll($: EngineInterface): Promise<void> {
  if (isRegistered) return
  if (!isToolsReady) {
    const ok = async (spec: typeof sessionSpec | typeof planSpec) =>
      $.tool.register(spec).then(r => !(r as { deny?: unknown })?.deny || isAlreadyRegistered((r as { deny?: unknown }).deny), isAlreadyRegistered)
    const a = await ok(sessionSpec)
    const b = await ok(planSpec)
    const c = await ok(controlSpec)
    isToolsReady = a && b && c
  }
  if (!isCommandReady) {
    isCommandReady = await $.command.register({ name: COMMAND, description: tr('register.m001'), argumentHint: tr('register.m002') })
      .then(r => !(r as { deny?: unknown })?.deny || isAlreadyRegistered((r as { deny?: unknown }).deny), isAlreadyRegistered)
  }
  isRegistered = isToolsReady && isCommandReady
}

async function init($: EngineInterface, start: { cwd: string; isInteractive: boolean } | null): Promise<void> {
  // Only session.start knows reliably whether a person is at the prompt. A lazy start (a reload, or
  // classic.SessionStart firing first) runs before the terminal attaches, when surfaces() is still [],
  // so it must assume interactive; session.start turns the mod off later if the session is headless.
  const interactive = start ? start.isInteractive : true
  if (!interactive) {
    // Headless (SDK / -p / background): not recorded, not shown.
    isOff = true
    await update($, headless, () => true).catch(() => undefined)
    return
  }
  i18n ??= createI18n($, { backgroundTranslation: true, onChange: async () => {
    lastSnapKey = ''; await update($, localeVersion, n => n + 1);
    if (lastSnap) await update($, snapshot, () => lastSnap)
  } })
  await i18n.init()
  await registerAll($)
  await startSession($, start?.cwd ?? (await $.session.cwd())).catch(() => { isOff = true })
  if (!hasTimers) {
    hasTimers = true
    $.clock.every(REFRESH_MS, () => later($))
    $.clock.every(CHECK_MS, () => pollVisiblePlans($))
    $.clock.every(30 * 60_000, () => reconcileVisibleImports($))
    await syncSettings($)
    $.clock.every(200, () => {
      if (isWorking) void update($, tick, n => (n + 1) % 1_000_000).catch(() => undefined)
    })
  }
  later($)
}

/** Starts the module once: by session.start, or lazily by whichever hook runs first after a reload. */
function ensureInit($: EngineInterface, start: { cwd: string; isInteractive: boolean } | null = null): Promise<void> {
  if (!initP) initP = init($, start).catch(() => { isOff = true })
  return initP
}

async function loadPlans(): Promise<Plan[]> {
  if (!io || !paths) return []
  const ids = await listPlanIds(io, paths)
  const seen = new Set<string>()
  for (const { id, mtimeMs } of ids) {
    seen.add(id)
    const c = planCache.get(id)
    if (c && c.m === mtimeMs) continue
    const p = await readPlan(io, paths, id)
    if (p) planCache.set(id, { m: mtimeMs, plan: p })
  }
  for (const id of [...planCache.keys()]) if (!seen.has(id)) planCache.delete(id)
  return [...planCache.values()].map(c => c.plan)
}

async function loadSessions(): Promise<SessionRec[]> {
  if (!io || !paths) return []
  const entries = (await io.list(paths.sessions)).filter(e => e.kind === 'file' && e.name.endsWith('.json'))
  const seen = new Set<string>()
  for (const e of entries) {
    const id = e.name.slice(0, -5)
    seen.add(id)
    const c = sessCache.get(id)
    if (c && c.m === e.mtimeMs) continue
    const rec = parseJson<SessionRec>(await io.read(`${paths.sessions}/${e.name}`))
    if (rec && rec.v === 1) sessCache.set(id, { m: e.mtimeMs, rec })
  }
  for (const id of [...sessCache.keys()]) if (!seen.has(id)) sessCache.delete(id)
  return [...sessCache.values()].map(c => c.rec)
}

/** Liveness of other sessions' processes; a PID whose start identity differs from the recorded one is dead (reused). */
async function checkPids($: EngineInterface, recs: readonly SessionRec[]): Promise<void> {
  const next = new Map<number, boolean>()
  const want = new Map<number, string | undefined>()
  for (const r of recs) if (r.pid) want.set(r.pid, r.pidStart)
  if (want.size === 0) { pidAlive = next; return }
  const linux = await $.fs.exists('/proc/self').catch(() => false)
  if (linux) {
    for (const [p, st] of want) {
      const exists = await $.fs.exists(`/proc/${p}`).catch(() => true)
      next.set(p, exists && (st === undefined || (await procStart($, p).catch(() => st)) === st))
    }
  } else {
    const r = await $.process.run(['ps', '-o', 'pid=,lstart=', '-p', [...want.keys()].join(',')], { timeoutMs: 5000 }).catch(() => null)
    const seen = new Map<number, string>()
    for (const line of (r?.stdout ?? '').split('\n')) {
      const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line)
      if (m) seen.set(Number(m[1]), m[2] ?? '')
    }
    for (const [p, st] of want) next.set(p, r === null ? true : seen.has(p) && (st === undefined || seen.get(p) === st))
  }
  pidAlive = next
}

async function build($: EngineInterface): Promise<{ snap: Snapshot; gone: SessionRec[] } | null> {
  if (!io || !paths || !self) return null
  const t = await now($)
  const plans = (await loadPlans()).filter(p => p.status !== 'abandoned')
  const recs = await loadSessions()
  const selfId = self.id
  const all = [self, ...recs.filter(r => r.id !== selfId)]
  await checkPids($, all.filter(r => r.endedAt === undefined && r.pid && r.id !== selfId))
  const active = activePlanIds(plans)
  const repoCache = new Map<string, string[]>()
  const repoPlansFor = async (key?: string, root?: string): Promise<string[]> => {
    if (!key) return []
    const hit = repoCache.get(key)
    if (hit) return hit
    const idx = await readRepo(io as Io, paths as Paths, key)
    const fromIdx = Object.entries(idx?.plans ?? {}).sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt).map(([p]) => p)
    const declared = root ? plans.filter(p => p.repos.some(r => r.replace(/\/+$/, '') === root)).map(p => p.id) : []
    const list = withSuccessors([...fromIdx, ...declared], plans)
    repoCache.set(key, list)
    return list
  }
  for (const r of all) await repoPlansFor(r.repoKey, r.repoRoot)
  const attributions = resolveAttributions(all, active, r => (r.repoKey ? repoCache.get(r.repoKey) ?? [] : []), plans)
  const sessions: SessionView[] = []
  const gone: SessionRec[] = []
  for (const r0 of all) {
    const isSelf = r0.id === selfId
    let r = r0
    // A process confirmed gone without session.end: the end is recorded now, so retention counts from here.
    if (!isSelf && sessionFate(r, r.pid ? pidAlive.get(r.pid) : undefined, t) === 'gone') {
      r = { ...r, endedAt: t, endReason: 'gone' }
      delete r.question
      gone.push(r)
    }
    if (!isSelf && r.endedAt !== undefined && t - r.endedAt > RETAIN_MS) continue
    const isAlive = isSelf || r.endedAt === undefined
    const attribution = attributions.get(r.id) ?? { confident: [], speculative: [] }
    const cwdMissing = !isAlive ? false : !(await $.fs.exists(r.cwd).catch(() => true))
    // A claim on a done or void item is stale: whoever held it is finished with it, so drawing ignores it.
    const claims = liveItemClaims(r.claims, plans)
    sessions.push({ ...r, claims, isSelf, isAlive, attribution, cwdMissing })
  }
  const repoPlans = await repoPlansFor(self.repoKey, self.repoRoot)
  const waiting = waitingItems(plans, sessions)
  const base: Snapshot = { now: t, selfId, focusPlan: null, repoPlans, plans, sessions, waiting, recent: [] }
  const ui = await read($, uiState)
  const focus = (ui.pick && plans.find(p => p.id === ui.pick)) || focusPlanOf(base).plan
  const away = awayReportOf(sessions.find(s => s.isSelf) ?? self, plans, all, focus?.id)
  const recent: Snapshot['recent'] = []
  if (focus && logTail) {
    const log = await logTail.get(focus.id, 60)
    for (const l of [...log].reverse()) {
      // A backfilled completion happened when it happened: it is not news to the person.
      if (l.isBackfill) continue
      if (l.action === 'set_item' && / → done/.test(l.detail)) recent.push({ at: l.at, text: l.detail.replace(/: .*$/, ''), tag: '✓' })
      else if (l.action === 'set_item' && / → wrapping/.test(l.detail)) recent.push({ at: l.at, text: l.detail.replace(/: .*$/, ''), tag: tr('register.m003') })
      else if (l.action === 'complete') recent.push({ at: l.at, text: focus.title, tag: tr('register.m004') })
    }
  }
  for (const b of self.bg) if (b.endedAt !== undefined && t - b.endedAt < DAY) recent.push({ at: b.endedAt, text: b.name, tag: tr('register.m005') })
  recent.sort((a, b) => b.at - a.at)
  const monitors: NonNullable<Snapshot['monitors']> = {}
  const planSettings: NonNullable<Snapshot['planSettings']> = {}
  for (const p of plans) {
    planSettings[p.id] = await readPlanSettings(io, paths, p.id)
    monitors[p.id] = await monitorView(io, paths, p.id, effectiveSettings(settings, p, planSettings[p.id]!).monitor, t)
  }
  const snap: Snapshot = { ...base, settings, planSettings, focusPlan: focus?.id ?? null, recent: recent.slice(0, 8), away, monitors }
  if (logTail) snap.activity = await activityOf(io, paths, snap, logTail)
  return { snap, gone }
}

/** Deletes other sessions' records seven days after their recorded end (never counted from last activity). */
async function cleanup(t: number): Promise<void> {
  if (!io || !paths || t - lastCleanup < 3600_000) return
  lastCleanup = t
  for (const { rec } of sessCache.values()) {
    if (rec.id === self?.id) continue
    if (sessionFate(rec, rec.pid ? pidAlive.get(rec.pid) : undefined, t) === 'delete') await io.remove(paths.session(rec.id)).catch(() => undefined)
  }
}

/** One refresh at a time; a request during one runs once more after it, so a caller always sees its own changes. */
function refresh($: EngineInterface): Promise<void> {
  if (isOff) return Promise.resolve()
  if (refreshP) {
    refreshAgain = true
    return refreshP
  }
  refreshP = (async () => {
    try {
      do {
        refreshAgain = false
        await refreshOnce($)
      } while (refreshAgain)
    } finally {
      refreshP = null
    }
  })()
  return refreshP
}

async function refreshOnce($: EngineInterface): Promise<void> {
  {
    await i18n?.refresh()
    await syncSettings($)
    await ensureSelf($)
    await saveSelf($)
    if (self && io && paths) await collectControlResults($, { self, io, paths, turnId: () => runningTurn, save: () => saveSelf($, true) })
    const built = await build($)
    const snap = built?.snap ?? null
    lastSnap = snap
    if (snap && self && io && paths) { await notifyWaiting($, io, paths, self, snap); await saveSelf($) }
    rescheduleMonitor($)
    if (io && paths) for (const g of built?.gone ?? []) await saveSession(io, paths, g).catch(() => undefined)
    // Unchanged content leaves the state alone, but the minute moves it: durations and "ago" labels advance.
    const key = publishKey(snap)
    if (key !== lastSnapKey) {
      lastSnapKey = key
      await update($, snapshot, () => snap)
    }
    // Plan lifecycle changes (a claimed plan finished, a parent's plan resolved) change what is exported.
    await exportEnv($)
    if (snap) await cleanup(snap.now)
  }
}

let lastRefreshAt = 0
let isQueued = false
/** Refreshes now, or once shortly after when one ran under a second ago (bursts of tool calls). */
const later = ($: EngineInterface) => {
  void (async () => {
    const t = await $.clock.now()
    if (t - lastRefreshAt >= 1000) {
      lastRefreshAt = t
      await refresh($)
    } else if (!isQueued) {
      isQueued = true
      $.clock.after(1000, () => {
        isQueued = false
        lastRefreshAt = 0
        later($)
      })
    }
  })().catch(() => undefined)
}

async function touch($: EngineInterface, user = false): Promise<SessionRec | null> {
  const s = await ensureSelf($)
  if (!s) return null
  const t = await now($)
  s.lastActivity = t
  if (user) s.lastUserInput = t
  return s
}

/** Whether `q` is (normalized) inside one of the person's own messages; null when the transcript cannot be read. */
async function quoteFound($: EngineInterface, q: string): Promise<boolean | null> {
  try {
    const msgs = await $.session.messages()
    if (!Array.isArray(msgs)) return null
    const want = normQuote(q)
    if (!want) return false
    return msgs.some(m => m.role === 'user' && !(m.toolResults && m.toolResults.length > 0) && normQuote(m.text).includes(want))
  } catch {
    return null
  }
}

async function toolCtx($: EngineInterface, s: SessionRec, t: number): Promise<ToolCtx> {
  const peers = [s, ...(await loadSessions()).filter(r => r.id !== s.id && (r.endedAt === undefined || t - r.endedAt <= RETAIN_MS))]
  const answered = answeredQuestions(peers)
  const peerAsks = peers
    .filter(x => x.id !== s.id && x.endedAt === undefined)
    .flatMap(x => (x.asks ?? []).filter(a => !isAskAnswered(x, a, answered)).map(a => ({ name: sessionName(x), question: a.question, at: a.at })))
  return {
    io: io as Io, paths: paths as Paths, sessionId: s.id, now: t, self: s,
    peerAsks, sessions: peers,
    quoteFound: q => quoteFound($, q),
    touchRepos: async plan => {
      if (!io || !paths) return
      if (s.repoKey && s.repoRoot) await touchRepo(io, paths, s.repoKey, s.repoRoot, plan.id).catch(() => undefined)
      for (const r of plan.repos) {
        const repo = await repoOf($, r)
        if (repo && repo.key !== s.repoKey) await touchRepo(io, paths, repo.key, repo.root, plan.id).catch(() => undefined)
      }
    },
  }
}

/** The same claim: plan, phase, item and holder. */
const sameClaim = (a: Pick<Claim, 'plan' | 'phase' | 'item' | 'by'>, b: Pick<Claim, 'plan' | 'phase' | 'item' | 'by'>) =>
  a.plan === b.plan && a.phase === b.phase && a.item === b.item && a.by === b.by

/**
 * A dispatched agent whose text names an item of a plan this session works on claims it on the
 * session's behalf, held until the agent completes (or the item is done, which releases it anyway).
 */
async function dispatchClaimFor($: EngineInterface, s: SessionRec, by: string, e: Record<string, unknown>, t: number): Promise<Claim | null> {
  const snap = lastSnap
  const view = snap?.sessions.find(x => x.id === s.id)
  const plans = snap?.plans ?? (await loadPlans().catch(() => [] as Plan[]))
  const attributed = [...new Set([...(view?.attribution.confident.map(c => c.plan) ?? []), ...s.claims.map(c => c.plan), ...(s.lastPlan && plans.some(p => p.id === s.lastPlan && p.status === 'active') ? [s.lastPlan] : [])])]
  if (attributed.length === 0) return null
  const description = typeof e['description'] === 'string' ? e['description'] : ''
  const prompt = typeof e['prompt'] === 'string' ? e['prompt'] : ''
  const hit = dispatchItemOf(prompt, plans, attributed, description)
  if (!hit) return null
  return { plan: hit.plan, ...(hit.phase ? { phase: hit.phase } : {}), ...(hit.item ? { item: hit.item } : {}), at: t, source: 'claim', by }
}

/** Publish an assignment only after the engine reports a real start, for sync and background agents. */
async function noteAgentStarted($: EngineInterface, s: SessionRec, b: BgTask, agentId: string): Promise<void> {
  b.taskId = agentId
  const actual = (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)
  const previous = b.claim
  b.name = actual?.name || b.name
  if (b.dispatchId && io && paths) {
    const permit = s.dispatchPermits?.find(p => p.id === b.dispatchId)
    if (permit) await pinStartedDispatch({ self: s, io, paths, turnId: () => runningTurn, save: () => saveSelf($, true) }, permit).catch(error => $.ui.toast(tr('control.failed', { reason: String(error) })))
    planCache.clear(); delete b.dispatchId
  }
  const explicit = s.claims.filter(c => c.worker && c.item && (c.by === b.name || c.by === agentId))
  const assigned = explicit.length === 1 ? explicit[0] : previous
  if (explicit.length === 1) { b.direct = true; b.workerSource = 'claim' }
  if (assigned && b.endedAt === undefined) {
    const next = { ...assigned, by: b.name, at: await now($) }
    b.claim = next
    s.claims = [...s.claims.filter(c => !sameClaim(c, assigned) && !(previous && sameClaim(c, previous)) && !sameClaim(c, next)), next]
  }
  await saveSelf($, true)
  later($)
}

/** Drops the claim a dispatched agent held; called when it completes. */
function releaseBgClaim(s: SessionRec, b: BgTask): void {
  const c = b.claim
  if (!c) return
  s.claims = s.claims.filter(x => !sameClaim(x, c))
}
function finishAgent(s: SessionRec, b: BgTask, at: number): void {
  if (b.endedAt !== undefined) return
  b.endedAt = at
  s.agentsDone++
  releaseBgClaim(s, b)
}


async function progressEvent($: EngineInterface, s: SessionRec, kind: ProgressEvent['kind'], text: string): Promise<void> {
  const plans = await loadPlans()
  const recs = [s, ...(await loadSessions()).filter(r => r.id !== s.id)]
  const attribution = resolveAttributions(recs, activePlanIds(plans), () => [], plans).get(s.id)
  const branch = kind === 'bash' ? await $.process.run(['git', 'branch', '--show-current'], { cwd: s.cwd, timeoutMs: 3000 }).then(r => r.exitCode === 0 ? r.stdout.trim() : '', () => '') : ''
  recordEvent(s, { kind, text, at: await now($) }, plans, attribution?.confident.map(a => a.plan) ?? [], `${text}\n${branch}`)
}

let polling = false
function plansInView(snap: Snapshot): Plan[] { return visiblePlans(snap) }
async function pollVisiblePlans($: EngineInterface): Promise<void> {
  if (isOff || !self || self.endedAt !== undefined || !io || !paths || polling) return
  polling = true
  try {
    await refresh($)
    const snap = lastSnap
    if (!snap) return
    for (const p of plansInView(snap)) await pollFacts($, io, paths, p.id, snap.sessions, () => isOff || self?.endedAt !== undefined, settings.autoDone)
    await refresh($)
  } catch { /* Progress tracking invariant. */ }
  finally { polling = false }
}

let reconcilingImports = false
async function reconcileVisibleImports($: EngineInterface): Promise<void> {
  if (isOff || !self || self.endedAt !== undefined || !io || !paths || reconcilingImports) return
  reconcilingImports = true
  try {
    await refresh($)
    if (!lastSnap) return
    const visible = new Set(plansInView(lastSnap).map(p => p.id))
    for (const plan of lastSnap.plans) if (plan.source && (visible.has(plan.id) || (plan.status === 'draft' && plan.createdBy === self.id))) {
      await reconcileImports($, io, paths, plan, self.id)
      planCache.delete(plan.id)
    }
    await refresh($)
  } catch { $.ui.log('progress-board: import reconciliation failed; local records retained.', { to: 'debug' }) }
  finally { reconcilingImports = false }
}

async function monitorVisiblePlans($: EngineInterface): Promise<void> {
  if (!mainSeen || isOff || monitoring || !self || self.endedAt !== undefined || !io || !paths) return
  if (!(await $.session.surfaces()).length) return
  monitoring = true
  try {
    await refresh($)
    if (!lastSnap) return
    for (const p of plansInView(lastSnap)) {
      if (isOff || self.endedAt !== undefined) break
      const effective = effectiveSettings(settings, p, lastSnap.planSettings?.[p.id] ?? {})
      if (!effective.monitor) continue
      const stop = new AbortController()
      monitorStops.set(p.id, stop)
      try { await runMonitor($, io, paths, p.id, self.id, lastSnap.sessions, effective.monitorMinutes * 60_000, stop.signal) }
      finally { monitorStops.delete(p.id) }
    }
    await refresh($)
  } catch { $.ui.log("progress-board monitor: check failed; no suggestions this run", { to: 'debug' }) }
  finally { monitoring = false }
}

async function suggestionReminder($: EngineInterface, s: SessionRec): Promise<string | undefined> {
  if (!io || !paths) return undefined
  await refresh($)
  if (!lastSnap) return undefined
  const visible = new Set([...plansInView(lastSnap).map(p => p.id), ...(s.editedPlans ?? []).map(e => e.plan)])
  for (const p of lastSnap.plans.filter(p => p.status === 'active' && visible.has(p.id))) {
    const text = await takeSuggestions(io, paths, p.id, s.id, lastSnap.sessions, settings.awayMinutes * 60_000)
    if (text) return text
  }
  return undefined
}

async function freshnessReminder(s: SessionRec): Promise<string | undefined> {
  const plans = await loadPlans()
  const idx = s.repoKey && io && paths ? await readRepo(io, paths, s.repoKey) : null
  return takeProgressReminder(s, plans, Object.keys(idx?.plans ?? {}))
}

function draftIds(): string[] {
  return (lastSnap?.plans ?? []).filter(p => p.status === 'draft').map(p => p.id)
}

function targetDraft(planArg?: string): Plan | undefined {
  const plans = lastSnap?.plans ?? []
  if (planArg) return plans.find(p => p.id === planArg && p.status === 'draft')
  const repo = new Set(lastSnap?.repoPlans ?? [])
  return plans.find(p => p.status === 'draft' && (repo.has(p.id) || p.createdBy === self?.id)) ?? plans.find(p => p.status === 'draft')
}

/** Participation: the person accepted the plan here, or a main-loop set_item included a status. */
function notePlanEdit(s: SessionRec, plan: string, at: number): void {
  const old = s.editedPlans?.find(e => e.plan === plan)
  s.editedPlans = [...(s.editedPlans ?? []).filter(e => e.plan !== plan), { ...old, plan, at }].slice(-20)
}

function notePlanItemEdit(s: SessionRec, plan: string, itemAt: number): void {
  const old = s.editedPlans?.find(e => e.plan === plan)
  s.editedPlans = [...(s.editedPlans ?? []).filter(e => e.plan !== plan), { ...old, plan, itemAt }].slice(-20)
}

async function accept($: EngineInterface, id: string, kind: Approval['kind']): Promise<string> {
  if (!io || !paths) return tr('register.m007')
  const by = self?.id ?? 'person'
  const r = await mutatePlan(io, paths, id, (cur, t) => {
    if (!cur || cur.status !== 'draft') return { error: tr('register.m008', { p0: id }) }
    const plan: Plan = { ...cur, status: 'active', approval: { kind, at: t, by: 'person' } }
    return { plan, log: [{ by, action: 'confirm', detail: tr('register.m009'), approval: plan.approval as Approval }], md: renderPlanMd(plan) }
  }).catch((e: unknown) => ({ error: String(e) }))
  later($)
  if (!('error' in r) && self) { notePlanEdit(self, id, await $.clock.now()); await saveSelf($, true) }
  return 'error' in r ? r.error : tr('register.m010', { p0: id })
}

/** The person rejects a draft: abandoned with the reason given, or a default saying where it was rejected. */
async function reject($: EngineInterface, id: string, reason: string, via: 'panel' | 'command'): Promise<string> {
  if (!io || !paths) return tr('register.m011')
  const by = self?.id ?? 'person'
  const r = await mutatePlan(io, paths, id, cur => rejectDraft(cur, reason, via, by)).catch((e: unknown) => ({ error: String(e) }))
  later($)
  return 'error' in r ? r.error : tr('register.m012', { p0: id, p1: r.plan.endReason ?? '' })
}

async function undoReview($: EngineInterface, reviewId: string): Promise<string> {
  if (!io || !paths) return tr('register.m013')
  const plan = lastSnap?.plans.find(p => p.reviews.some(r => r.id === reviewId))
  if (!plan) return tr('register.m014')
  const by = self?.id ?? 'person'
  const r = await mutatePlan(io, paths, plan.id, cur => {
    const rv = cur?.reviews.find(x => x.id === reviewId)
    if (!cur || !rv) return { error: tr('register.m015') }
    const next = applyUndo(cur, rv)
    if ('conflict' in next) return { error: tr('register.m016', { p0: next.conflict }) }
    return { plan: next, log: [{ by, action: 'undo', detail: tr('register.m017', { p0: rv.summary }) }], md: renderPlanMd(next) }
  }).catch((e: unknown) => ({ error: String(e) }))
  later($)
  return 'error' in r ? r.error : tr('register.m018')
}

async function keepReviews($: EngineInterface, planId: string): Promise<string> {
  if (!io || !paths) return tr('register.m019')
  const by = self?.id ?? 'person'
  const r = await mutatePlan(io, paths, planId, cur => {
    if (!cur) return { error: tr('register.m020', { p0: planId }) }
    const next = { ...cur, reviews: [] }
    return { plan: next, log: [{ by, action: 'reviewed', detail: tr('register.m021', { p0: cur.reviews.length }) }], md: renderPlanMd(next) }
  }).catch((e: unknown) => ({ error: String(e) }))
  later($)
  return 'error' in r ? r.error : tr('register.m022')
}

function planMdPath(): string | null {
  const id = lastSnap?.focusPlan
  return id && paths ? paths.planMd(id) : null
}

export const register: Register = (on, options) => {
  initial = initialSettings(options); settings = { ...initial }
  isEnforce = settings.enforceGoal; glyph = settings.barGlyph

  // ---- lifecycle ----
  on('session.start', async ($, e, next) => {
    mainSeen = e.isInteractive
    if (!e.isInteractive) for (const stop of monitorStops.values()) stop.abort()
    await ensureInit($, { cwd: e.cwd, isInteractive: e.isInteractive })
    // The session is bound now: retry any registration an earlier hook could not make.
    if (!isOff) {
      await registerAll($).catch(() => undefined)
      if (e.isInteractive && self) await captureNativeName($, self, true)
    }
    if (!e.isInteractive && !isOff) {
      // A lazy start already assumed interactive: a headless (-p / SDK) session is not recorded or shown.
      isOff = true
      await update($, headless, () => true).catch(() => undefined)
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await ensureInit($)
    const s = await ensureSelf($).catch(() => null)
    if (s) {
      if (e.session_title && !s.title) s.title = e.session_title
      if (e.agent_type && !s.role) s.role = e.agent_type
      await saveSelf($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (self && !isOff && self.id === e.sessionId) {
      for (const stop of monitorStops.values()) stop.abort()
      mainSeen = false
      const t = await now($)
      self.endedAt = t
      self.endReason = e.reason
      delete self.question
      delete self.ownQuotes
      delete self.pendingControls
      delete self.controlIntents
      delete self.dispatchPermits
      forgetControlPrompt(self)
      for (const b of self.bg) if (b.kind === 'agent') releaseBgClaim(self, b)
      await saveSelf($, true).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    await ensureInit($)
    if (isOff) return next(e)
    if (!isOff && e.origin?.kind === 'task-notification' && /<status>\s*(?:completed|complete|finished)\s*<\/status>/i.test(e.text)) {
      const s = await ensureSelf($)
      if (s) { await progressEvent($, s, 'task', tr('register.m023')); await saveSelf($, true) }
    }
    if (!e.isMeta && !isOff) {
      const own = isOwnPrompt(e) && (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge')
      const prev = (await ensureSelf($))?.lastUserInput
      const s = own ? await touch($, true) : await ensureSelf($)
      const t = await now($)
      if (s) {
        // The person's own prompt after a 30-minute gap ends an away window; its card is drawn from here.
        if (prev !== undefined && own && t - prev >= settings.awayMinutes * 60_000) s.away = { from: prev, to: t }
        if (own) {
          delete s.awayAuthAt
          await rememberQuote(s, e.text, t)
          await rememberControlPrompt(s, e.text)
        }
        const auto = autoGoalOf(e)
        if (auto) s.autoGoal = auto
        const line = firstMessageOf(e)
        if (!s.firstMessage && line) {
          s.firstMessage = line
          const tp = taskPlanOf(e.text)
          if (tp) s.taskPlan = tp
        }
        await saveSelf($)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await ensureInit($)
    if (isOff) return next(e)
    if (e.agentId === undefined) {
      isWorking = true; runningTurn = e.turnId
      if (self) { self.working = true; await captureUsage($); await saveSelf($, true); later($) }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await ensureInit($)
    if (e.agentId === undefined && !isOff) {
      isWorking = false
      if (runningTurn === e.turnId) runningTurn = undefined
      await touch($)
      if (self) { self.working = false; self.currentTools = []; self.lastMessage = clip(e.answer.replace(/\s+/g, ' ').trim(), 80); if (e.usage?.model) self.model = e.usage.model; await captureUsage($); await saveSelf($, true) }
      $.clock.after(1, () => { if (self && io && paths) void flushCompact($, { self, io, paths, turnId: () => runningTurn, save: () => saveSelf($, true) }).catch(() => undefined) })
      later($)
    } else if (e.agentId && self && !isOff) {
      const task = self.bg.find(b => b.direct && b.taskId === e.agentId && b.endedAt === undefined)
      if (task) { finishAgent(self, task, await now($)); await saveSelf($, true); later($) }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    await ensureInit($)
    const s = await ensureSelf($).catch(() => null)
    if (s && !e.agent_id) {
      const live = e.background_tasks ?? []
      const t = await now($)
      for (const b of s.bg) {
        if (b.endedAt !== undefined) continue
        const still = live.some(x => (b.taskId !== undefined && x.id === b.taskId) || x.description === b.name || x.command === b.name)
        if (!still) {
          if (b.kind === 'agent') finishAgent(s, b, t)
          else b.endedAt = t
        }
      }
      await saveSelf($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    await ensureInit($)
    if (self && !isOff) {
      const b = self.bg.find(x => x.taskId === e.agent_id && x.endedAt === undefined)
      if (b) {
        finishAgent(self, b, await now($))
        await saveSelf($)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (typeof e.message !== 'string') return next(e)
    await ensureInit($)
    if (isOff || !isControl(e.message)) return next(e)
    if (!self || !io || !paths || !await prepareControlSend($, { self, io, paths, turnId: () => runningTurn, save: () => saveSelf($, true) }, e.to, e.message, e.agentId)) return { deny: 'progress-board: missing, invalid, expired, replayed or wrongly addressed control token.' }
    try { return await next(e) }
    finally { finishControlSend(e.message) }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'progress-board: control token validation failed.' })

  on('session.send', async ($, e, next) => {
    await ensureInit($)
    if (isOff || !isControl(e.text)) return next(e)
    if (!allowControlSend(e)) return { isDelivered: false, reason: 'progress-board: control envelopes require a valid single-use token through the native SendMessage tool.' }
    const result = await next(e)
    if (result.isDelivered && self && io && paths) {
      await completeControlSend($, { self, io, paths, turnId: () => runningTurn, save: () => saveSelf($, true) }, e.text).catch(error => $.ui.toast(tr('control.failed', { reason: String(error) })))
      planCache.clear(); later($)
    }
    $.ui.toast(result.isDelivered ? tr('control.sent', { name: e.to }) : tr('control.failed', { reason: result.reason }))
    return result
  }).catch(($, e, next) => next.called ? next(e) : { isDelivered: false, reason: 'progress-board: control send validation failed.' })

  on('session.receive', async ($, e, next) => {
    await ensureInit($)
    if (isOff) return next(e)
    if (isControl(e.text) && ['peer', 'coordinator', 'peer-send-message'].includes(e.origin.kind)) {
      try {
        if (!self || !io || !paths) return { consumed: 'Progress-board unavailable' }
        return await receiveControl($, e, { io, paths, self, turnId: () => runningTurn, save: () => saveSelf($, true) }) ?? next(e)
      } catch { return { consumed: 'Progress-board control failed' } }
    }
    if (self && !isOff && e.agentId === undefined && (e.origin.kind === 'peer' || e.origin.kind === 'coordinator')) {
      const peer = 'teammate' in e.origin ? e.origin.teammate : e.origin.kind
      self.messages = [...self.messages, { dir: 'from' as const, peer, at: await now($) }].slice(-20)
      // Progress tracking invariant.
      if (!e.event?.untrustedKeys.length) await progressEvent($, self, 'message', tr('register.m024'))
      await saveSelf($, true)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- the model's tools ----
  on('tool.call', { tool: /^mcp__progress-board__progress_control$/ }, async ($, e, next) => {
    await ensureInit($)
    if (isOff) return next(e)
    if (e.agentId !== undefined) return { result: 'Only the main conversation may execute a person-requested control.' }
    if (!self || !io || !paths || isOff) return { result: 'progress-board is unavailable.' }
    try {
      await refresh($)
      const result = await runControlTool($, { io, paths, self, turnId: () => runningTurn, save: () => saveSelf($, true) }, e as unknown as Record<string, unknown>, lastSnap?.sessions ?? [])
      planCache.clear(); await refresh($)
      return { result }
    } catch (error) {
      const message = tr('control.failed', { reason: String(error) })
      $.ui.toast(message)
      return { result: message }
    }
  }).catch(() => ({ result: tr('common.unavailable') }))

  on('tool.call', { tool: /^mcp__progress-board__progress_session$/ }, async ($, e, next) => {
    await ensureInit($)
    if (isOff) return next(e)
    if (e.agentId !== undefined) return { result: "Subagents must not call progress_session; the main session reports progress." }
    const s = await touch($)
    if (!s || !io || !paths) return { result: "progress-board is disabled (headless session or initialization failed)." }
    const { tool: _t, tool_use_id: _id, agentId: _a, requestMeta: _m, ...input } = e as Record<string, unknown>
    const ctx = await toolCtx($, s, await now($))
    const r = await runSessionTool(input, ctx)
    s.usedToolAt ??= await now($)
    s.sinceReport = 0
    s.recentCalls = []
    s.stepNudges = 0
    await saveSelf($, true)
    await exportEnv($)
    later($)
    return { result: r.text }
  }).catch(() => ({ result: "progress-board internal error; nothing recorded." }))

  on('tool.call', { tool: /^mcp__progress-board__progress_plan$/ }, async ($, e, next) => {
    await ensureInit($)
    if (isOff) return next(e)
    if (e.agentId !== undefined) {
      const task = self?.bg.find(b => b.direct && b.workerSource && b.taskId === e.agentId && b.endedAt === undefined)
      const input = e as unknown as Record<string, unknown>
      if (!task?.claim || input.action !== 'set_item' || input.plan !== task.claim.plan || input.item !== task.claim.item || (input.phase !== undefined && input.phase !== task.claim.phase)) return { result: 'A direct worker may only update its assigned item with set_item.' }
    }
    const s = await touch($)
    if (!s || !io || !paths) return { result: "progress-board is disabled (headless session or initialization failed)." }
    const { tool: _t, tool_use_id: _id, agentId: _a, requestMeta: _m, ...input } = e as Record<string, unknown>
    s.usedToolAt ??= await now($)
    s.sinceReport = 0
    s.recentCalls = []
    s.lastPlanCall = s.calls ?? 0
    const ctx = await toolCtx($, s, await now($))
    let r: { text: string; isError?: boolean }
    if (input.action === 'import') {
      const result = await importSource($, io, paths, { cwd: s.cwd, sessionId: s.id, planId: typeof input.plan === 'string' ? input.plan : undefined, source: typeof input.source === 'string' ? input.source : undefined, path: typeof input.path === 'string' ? input.path : undefined })
      if (result.plan) { s.lastPlan = result.plan.id; await ctx.touchRepos(result.plan); planCache.delete(result.plan.id) }
      r = { text: result.text }
    } else r = await runPlanTool(input, ctx)
    if (typeof input.plan === 'string') planCache.delete(input.plan)
    if (e.agentId === undefined && !r.isError && typeof input.plan === 'string'
      && (input.action === 'set_item' || input.action === 'add_items' || input.action === 'resolve_suggestion')) {
      const at = await now($)
      if (input.action === 'set_item' && typeof input.status === 'string') notePlanEdit(s, input.plan, at)
      notePlanItemEdit(s, input.plan, at)
    }
    // Spent approval evidence is part of the record.
    await saveSelf($, true)
    await exportEnv($)
    later($)
    return { result: r.isError ? tr('register.m030', { p0: r.text }) : r.text }
  }).catch(() => ({ result: "progress-board internal error; nothing recorded." }))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (e.parentAgentId === undefined && result.agentId && self && !isOff) {
      const task = self.bg.find(b => b.kind === 'agent' && b.id === e.tool_use_id && b.endedAt === undefined)
      if (task) await noteAgentStarted($, self, task, result.agentId)
    }
    return result
  }).catch(($, e, next) => next(e))

  // ---- recording every other tool call (main loop only) ----
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'ListAgents' && isNativeLookup()) return next(e)
    await ensureInit($)
    if (isOff || e.agentId !== undefined || String(e.tool).startsWith('mcp__progress-board__')) return next(e)
    mainSeen = true
    const s = await touch($).catch(() => null)
    if (!s) return next(e)
    s.calls = (s.calls ?? 0) + 1
    s.sinceReport = (s.sinceReport ?? 0) + 1
    // A reminder names what was done since the last report, so the model cannot dismiss it as vague.
    s.recentCalls = [...(s.recentCalls ?? []), callSummary(String(e.tool), e as unknown as Record<string, unknown>)].slice(-RECENT_CALLS)
    const t = await now($)
    // Spec §13: with no formal goal, the 4th call of the session is stopped before it runs, once per session.
    // Only when the tools exist: a stop the model cannot satisfy would block the user's work.
    await registerAll($).catch(() => undefined)
    if (isToolsReady && shouldEnforce(s, isEnforce)) {
      s.enforcedAt = t
      await saveSelf($, true)
      return { deny: ENFORCE_DENY }
    }
    const id = e.tool_use_id ?? `t${t}`
    if (e.tool === 'Agent') {
      s.dispatched++
      const name = e.name || e.description || e.subagent_type || tr('register.m032')
      const permit = takeDispatchPermit(s, e.prompt, t)
      const explicit = s.claims.find(c => c.worker && c.by === name && c.item)
      const inferred = await dispatchClaimFor($, s, name, e as unknown as Record<string, unknown>, t).catch(() => null)
      const claim = permit ? { ...permit.claim, by: name } : explicit ?? inferred
      s.bg.push({ id, kind: 'agent', ...(permit || explicit ? { direct: true, workerSource: permit ? 'dispatch' as const : 'claim' as const } : {}), ...(permit ? { dispatchId: permit.permit.id } : {}), name, startedAt: t, ...(claim ? { claim } : {}) })
      await saveSelf($, true)
      later($)
    } else if (e.tool === 'Bash' && e.run_in_background) {
      s.bg.push({ id, kind: 'bash', name: e.description || e.command.slice(0, 60), startedAt: t })
      await saveSelf($, true)
    } else if (e.tool === 'AskUserQuestion') {
      s.question = { since: t, text: e.questions[0]?.question ?? '' }
      await saveSelf($, true)
      later($)
    }

    s.currentTools = [...(s.currentTools ?? []), { id, name: String(e.tool), at: t }]
    await saveSelf($, true); later($)
    let ran: Awaited<ReturnType<typeof next>>
    try { ran = await next(e) }
    finally { s.currentTools = (s.currentTools ?? []).filter(call => call.id !== id); await saveSelf($, true); later($) }

    const t2 = await now($)
    const ok = ran.deny === undefined && ran.isError !== true
    const res = (ran.result ?? {}) as Record<string, unknown>
    if (ran.deny === undefined) {
      if (e.tool === 'Bash' && bashSignal(e.command)) {
        await progressEvent($, s, 'bash', e.command).catch(() => undefined)
        if (ok && bashSignal(e.command) === 'gh pr create' && io && paths && (res['exitCode'] === undefined || res['exitCode'] === 0)) {
          const note = await attachCreatedPr(io, paths, s, typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? {})).catch(() => undefined)
          if (note && s.pendingProgress) s.pendingProgress.note = note
        }
      }
      if (e.tool === 'Agent' && res['status'] !== 'async_launched') await progressEvent($, s, 'agent', e.description || tr('register.m033')).catch(() => undefined)
    }
    if (e.tool === 'Agent') {
      const b = s.bg.find(x => x.id === id)
      if (b) {
        if (ok && res['status'] === 'async_launched' && typeof res['agentId'] === 'string') {
          await noteAgentStarted($, s, b, res['agentId'])
        }
        else finishAgent(s, b, t2)
      }
    } else if (e.tool === 'Bash') {
      const b = s.bg.find(x => x.id === id)
      const taskId = typeof res['backgroundTaskId'] === 'string' ? res['backgroundTaskId'] : undefined
      if (b) {
        if (taskId) b.taskId = taskId
        else if (!ok) b.endedAt = t2
      } else if (taskId) {
        s.bg.push({ id, kind: 'bash', name: e.description || e.command.slice(0, 60), startedAt: t, taskId })
      }
    } else if (e.tool === 'AskUserQuestion') {
      delete s.question
      // Evidence is each answered question with its text; AFK timeouts, follow-ups and empty answers leave none.
      if (ok) {
        const qa = questionApprovals(e, res, t2)
        s.approvals = [...s.approvals, ...qa].slice(-10)
        // A queued question the person just answered is answered for every session holding it.
        const asked = qa.map(a => a.question).filter((q): q is string => !!q)
        recordAnswers(s, asked, t2, true)
      }
    } else if (e.tool === 'ExitPlanMode') {
      if (ok) s.approvals = [...s.approvals, { kind: 'plan_mode' as const, at: t2, ...(res['awaitingLeaderApproval'] === true ? { isPending: true } : {}) }].slice(-10)
    } else if (e.tool === 'SendMessage') {
      const to = typeof e.to === 'string' ? e.to : JSON.stringify(e.to)
      s.messages = [...s.messages, { dir: 'to' as const, peer: to.slice(0, 60), at: t2 }].slice(-20)
    } else if (e.tool === 'TodoWrite' && s.stepsSource !== 'tool') {
      s.steps = e.todos.map(x => ({ title: x.content, status: x.status === 'completed' ? 'done' : x.status === 'in_progress' ? 'doing' : 'todo' }))
      s.stepsSource = 'todo'
    } else if (e.tool === 'TaskCreate' && s.stepsSource !== 'tool' && ok) {
      const task = res['task'] as { id?: unknown } | undefined
      s.steps = [...s.steps, { title: e.subject, status: 'todo', ...(typeof task?.id === 'string' ? { taskId: task.id } : {}) }]
      s.stepsSource = 'todo'
    } else if (e.tool === 'TaskUpdate' && s.stepsSource !== 'tool' && ok && e.status) {
      const step = s.steps.find(x => x.taskId === e.taskId)
      if (step) {
        if (e.status === 'deleted') s.steps = s.steps.filter(x => x !== step)
        else step.status = e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'doing' : 'todo'
      }
    }
    // Steps ticked only at the end leave the band at 0/N for the whole task: remind, sparingly.
    const progressNudge = ran.deny === undefined && isToolsReady ? await freshnessReminder(s).catch(() => undefined) : undefined
    const suggestion = ran.deny === undefined && isToolsReady ? await suggestionReminder($, s).catch(() => undefined) : undefined
    const priorities: string[] = []
    if (io && paths && lastSnap && ran.deny === undefined) for (const p of plansInView(lastSnap)) {
      const notice = await takePriorityNotice(io, paths, p.id, s.id, lastSnap?.sessions ?? []).catch(() => undefined)
      if (notice) priorities.push(notice)
    }
    if (e.tool === 'Agent') {
      const item = await dispatchClaimFor($, s, e.description || '', e as unknown as Record<string, unknown>, t)
      const plan = item && lastSnap?.plans.find(p => p.id === item.plan)
      if (plan && item) {
        const targets = item.item ? [item.item] : plan.phases.filter(ph => !item.phase || ph.id === item.phase).flatMap(ph => ph.items.map(it => it.id))
        for (const target of targets) { const why = deviationReason(plan, target, lastSnap?.sessions ?? []); if (why) priorities.push(why) }
      }
    }
    const nudge = [...priorities, progressNudge, suggestion, !progressNudge && !suggestion && ran.deny === undefined && isToolsReady ? takeStepNudge(s, settings.stepReminder) : undefined].filter(Boolean).join('\n')
    await saveSelf($)
    later($)
    if (ran.deny !== undefined || !nudge) return ran
    return { ...ran, context: [...(ran.context ?? []), nudge] }
  }).catch(($, e, next) => next(e))

  // ---- system prompt ----
  on('prompt.compose', async ($, e, next) => {
    await ensureInit($)
    if (!isOff) await refresh($)
    const r = await next(e)
    if (isOff || !self) return r
    self.model = e.model
    const snap = lastSnap
    const byId = new Map((snap?.plans ?? []).map(p => [p.id, p]))
    const reviewer = isReviewer(self)
    // Only active plans are claim candidates; drafts wait for the person.
    const cands = (snap?.repoPlans ?? []).map(id => byId.get(id)).filter((p): p is Plan => !!p && p.status === 'active').slice(0, 4)
    const mine = [...new Set(liveClaims(self.claims, snap?.plans ?? []).map(c => c.plan))]
    const lines = [
      '## progress-board',
      ...(e.tools.includes('Skill') ? [`Before proposing, importing or restructuring a plan, coordinating sessions on a plan, or handling check suggestions, load the ${QUALIFIED_SKILL} skill.`] : []),
      WORKER_DUTY,
      languageInstruction(),
      "Use progress_session to record this session's progress: set goal and steps when starting multi-step work, update as each step starts or finishes; claim a plan phase or item when working on it, release when stopping; declare orchestrator for long-running dispatch-led sessions.",
      "Use progress_plan for overall goals: propose a plan with a project-prefixed ID, phases and completion criteria. Phase changes require user approval evidence and a reason (questions must name the plan ID; quotations must be verbatim and dated). Reverting item status requires a reason. Mark done only when completion criteria are met; work awaiting review, acceptance or merge is wrapping.",
    ]
    if (reviewer) lines.push("This is a review session: inherit the dispatching session's attribution; do not claim plans based on content.")
    else if (cands.length) lines.push(`Candidate plans for this repository (judge relevance semantically; inferred until claimed): ${cands.map(p => `${p.id}[${p.phases.filter(ph => !ph.isVoid).map(ph => ph.name).join(' / ')}]`).join('; ')}`)
    if (mine.length) lines.push(`This session has claimed: ${mine.join(', ')}`)
    for (const p of snap ? plansInView(snap) : []) { const advice = priorityAdvice(p); if (advice) lines.push(advice) }
    return { ...r, sections: [...r.sections, { id: 'progress-board:guide', text: lines.join('\n'), scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // ---- command ----
  on('command.run', { command: COMMAND }, async ($, e, next) => {
    await ensureInit($)
    if (isOff) return next(e)
    mainSeen = true
    await refresh($).catch(() => undefined)
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (sub === 'import') {
      if (!self || !io || !paths) return { text: tr('import.failed') }
      const raw = e.args.trim().slice(6).trim(), part = /^(\S+)(?:\s+([\s\S]+))?$/.exec(raw)
      const source = part && ['gsd', 'specs', 'kiro', 'taskmaster', 'markdown', 'github', 'plan-mode'].includes(part[1]!) ? part[1] : undefined
      const result = await importSource($, io, paths, { cwd: self.cwd, sessionId: self.id, source, path: source ? part?.[2] : raw || undefined })
      if (result.plan) { self.lastPlan = result.plan.id; await (await toolCtx($, self, await now($))).touchRepos(result.plan) }
      planCache.clear(); await saveSelf($, true); await refresh($)
      return { text: result.text }
    }
    if (sub === 'find') {
      await update($, uiState, u => ({ ...u, search: rest.join(' ').slice(0, 200), tab: 'progress' as const }))
      await $.ui.open({ id: PANE, title: tr('register.m050') })
      return { text: tr('overview.searchSet', { text: rest.join(' ') }) }
    }
    if (sub === 'report') {
      const id = rest[0] ?? lastSnap?.focusPlan
      if (!id || !io || !paths || !lastSnap) return { text: tr('report.noPlan') }
      try { return { text: tr('report.written', { path: await writeReport(io, paths, id, lastSnap) }) } }
      catch (error) { return { text: tr('control.failed', { reason: String(error) }) } }
    }
    if (sub === 'send') {
      const raw = e.args.trim().slice(4).trim(), split = raw.indexOf(':')
      if (split < 1 || !raw.slice(split + 1).trim() || !self) return { text: tr('control.badSend') }
      const name = raw.slice(0, split).trim(), text = raw.slice(split + 1).trim()
      const matches = (lastSnap?.sessions ?? []).filter(s => s.isAlive && s.endedAt === undefined && (s.id === name || sessionName(s) === name))
      if (matches.length !== 1) return { text: tr('control.unknown', { name }) }
      if (isControl(text)) return { text: tr('control.badSend') }
      if (!io || !paths) return { text: tr('common.unavailable') }
      const request = await createControlIntent($, { self, io, paths, turnId: () => runningTurn, save: () => saveSelf($, true) }, { action: 'message', target: matches[0]!.id, text }, 'command', controlRequest('message', matches[0]!) + text)
      await $.prompt.fill({ text: request, mode: 'replace' })
      return { text: tr('control.submitRequest') }
    }
    if (sub === 'lang') {
      const code = rest.join(' ').trim()
      if (code === 'follow') await i18n?.setLanguage(null)
      else if (code === 'retranslate') await i18n?.retranslate()
      else if (mapLanguage(code)) await i18n?.setLanguage(code)
      else { await $.prompt.fill({ text: '/progress lang ', mode: 'replace' }); return { text: tr('settings.otherLanguage') } }
      await refresh($)
      return { text: tr('settings.saved') }
    }
    if (sub === 'accept' || sub === 'reject') {
      const { plan, reason } = parseDecisionArgs(rest, draftIds())
      const d = targetDraft(plan)
      if (!d) return { text: tr('register.m040') }
      return { text: sub === 'accept' ? await accept($, d.id, 'command') : await reject($, d.id, reason ?? '', 'command') }
    }
    if (sub === 'review') {
      const plans = (lastSnap?.plans ?? []).filter(p => p.reviews.length)
      const all = plans.flatMap(p => p.reviews.map(r => ({ p, r })))
      if (rest[0] === 'undo') {
        const n = Number(rest[1])
        const hit = all[n - 1]
        if (!hit) return { text: tr('register.m041', { p0: rest[1] ?? '' }) }
        return { text: await undoReview($, hit.r.id) }
      }
      if (rest[0] === 'ok') {
        const out = []
        for (const p of plans) out.push(await keepReviews($, p.id))
        return { text: out.join('\n') || tr('register.m042') }
      }
      if (all.length === 0) return { text: tr('register.m043') }
      return {
        text: [
          tr('register.m044'),
          ...all.map(({ p, r }, i) => tr('register.m045', { p0: i + 1, p1: p.id, p2: r.summary, p3: r.reason, p4: r.relayedBy ? tr('register.m046', { p0: r.relayedBy }) : '', p5: r.isAway ? tr('register.m047') : '' })),
          tr('register.m048'),
        ].join('\n'),
      }
    }
    if (sub === 'plan') {
      const path = planMdPath()
      return { text: path ? tr('register.planPath', { path }) : tr('register.m049') }
    }
    const { isPlaced } = await $.ui.open({ id: PANE, title: tr('register.m050') })
    return { text: isPlaced ? tr('register.m051') : tr('register.m052') }
  }).catch(() => ({ text: tr('register.m053') }))

  // 聚焦只展示说明，不写设置；只有宿主确认焦点移动后才改变选中行。
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    await ensureInit($)
    const result = await next(e)
    if (isOff || result.deny || e.plugin !== 'progress-board' || !e.element) return result
    const match = /^(plan-)?setting-([A-Za-z]+)(?:-\d+)?$/.exec(e.element)
    const selected = e.element.startsWith('language-') || e.element === 'setting-language' ? 'language'
      : match && Object.prototype.hasOwnProperty.call(choices, match[2]!) ? `${match[1] ? 'plan-' : ''}${match[2]}` : undefined
    if (selected) await update($, uiState, state => state.selectedSetting === selected ? state : { ...state, selectedSetting: selected })
    return result
  }).catch(($, e, next) => next(e))

  // ---- drawing ----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A drawing never waits on start-up work; it starts it and draws what the state holds.
    void ensureInit($)
    if (e.props.hasSurvey || (await read($, headless))) return next(e)
    await read($, localeVersion)
    const snap = await read($, snapshot)
    if (!snap) return next(e)
    const n = e.props.isWorking ? await read($, tick) : 0
    const banner = buildBanner({
      snap, cols: e.props.bodyColumns, glyph, isWorking: e.props.isWorking, spinner: SPIN[n % SPIN.length] ?? '●', now: await $.clock.now(),
    })
    if (banner.isHidden) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {banner.rows.map(row => (
          <Text wrap="truncate-end">
            {row.flatMap(g => g.segs).map(s => (
              <Text color={s.color ?? 'text'} dimColor={!!s.dim} weight={s.bold ? 'bold' : 'regular'}>{s.t}</Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    void ensureInit($)
    if (isOff || await read($, headless)) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    await read($, localeVersion)
    const snap = await read($, snapshot)
    if (!snap) return <Box><Text dimColor>{tr('register.m054')}</Text></Box>
    const storedUi = await read($, uiState)
    const languageChoice = await $.store.get('language').catch(() => undefined)
    const ui: PanelUi = { ...storedUi, settingLanguage: typeof languageChoice === 'string' ? languageChoice : null }
    const setUi = (fn: (u: PanelUi) => PanelUi) => void update($, uiState, fn).then(() => later($)).catch(() => undefined)
    return renderPanel({ Box, Text, Button, Input }, snap, ui, e.props.bodyColumns, glyph, {
      selectTab: tab => setUi(u => ({ ...u, tab })),
      pickPlan: pick => setUi(u => ({ ...u, pick, search: '', itemFilter: 'all' })),
      filterItems: itemFilter => setUi(u => ({ ...u, itemFilter })),
      searchItems: search => setUi(u => ({ ...u, search: search.slice(0, 200) })),
      focusSearch: () => { void $.prompt.fill({ text: '/progress find ', mode: 'replace' }) },
      toggleDaily: () => setUi(u => ({ ...u, showDaily: !u.showDaily })),
      activity: {
        filter: activityFilter => setUi(u => ({ ...u, activityFilter, activityCount: 40 })),
        more: () => setUi(u => ({ ...u, activityCount: (u.activityCount ?? 40) + 40 })),
      },
      sessions: {
        select: id => setUi(u => ({ ...u, expandedRow: u.expandedRow === `session:${id}` ? undefined : `session:${id}`, priorityPicker: undefined })),
        control: (target, action) => { void (async () => {
          if (!self || !io || !paths) return
          if ((action === 'compact' || action === 'abort') && (target.isSelf || !await confirmed($, `${action}:${target.id}`))) return
          if (target.controlVersion !== 1) { $.ui.toast(tr('common.unavailable')); return }
          const request = await createControlIntent($, { self, io, paths, turnId: () => runningTurn, save: () => saveSelf($, true) }, { action: action === 'abort' ? 'interrupt' : action, target: target.id }, 'panel', controlRequest(action, target))
          await $.prompt.fill({ text: request, mode: 'replace' })
          $.ui.toast(tr('control.submitRequest'))
        })().catch(error => $.ui.toast(tr('control.failed', { reason: String(error) }))) },
      },
      priorities: {
        dispatch: item => <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key={`dispatch-${item}`} plain label="▶" onPress={async () => {
            const id = snap.focusPlan, key = `dispatch:${id}:${item}`
            if (!id || !io || !paths || !self || dispatching.has(key)) return
            dispatching.add(key)
            let accepted = false
            try {
              if (!await confirmed($, key)) return
              accepted = true
              const currentUi = await read($, uiState)
              const interrupt = currentUi.interruptDispatch === true
              const request = await createControlIntent($, { self, io, paths, turnId: () => runningTurn, save: () => saveSelf($, true) }, { action: 'dispatch_now', target: dispatchTarget(id, snap.sessions, self).id, plan: id, item, interrupt }, 'panel', dispatchRequest(id, item, interrupt))
              await $.prompt.fill({ text: request, mode: 'replace' })
              $.ui.toast(tr('control.submitRequest'))
            } catch (e) { $.ui.toast(tr('control.failed', { reason: String(e) })) }
            finally {
              if (accepted) await update($, uiState, state => ({ ...state, interruptDispatch: false }))
              dispatching.delete(key); planCache.delete(id); await refresh($)
            }
          }}><Text color="claude">▶</Text><Text color="warning">$</Text></Button>
          {ui.confirmation?.key === `dispatch:${snap.focusPlan}:${item}` ? <Text dimColor>{tr('dispatch.confirm')}</Text> : ''}
          {ui.confirmation?.key === `dispatch:${snap.focusPlan}:${item}` ? <Button key={`dispatch-interrupt-${item}`} plain onPress={() => setUi(u => ({ ...u, interruptDispatch: !u.interruptDispatch }))}><Text dimColor>{ui.interruptDispatch ? '[✓] ' : '[ ] '}{tr('dispatch.interrupt')}</Text></Button> : ''}
        </Box>,
        change: (target, level) => { if (snap.focusPlan && io && paths) void setPriority(io, paths, snap.focusPlan, target, level, self?.id ?? 'person', { source: 'panel' }).then(async result => {
          $.ui.toast('error' in result ? result.error : tr('priority.saved', { name: target.item ?? target.phase }))
          if (!('error' in result)) planCache.delete(result.plan.id)
          setUi(u => ({ ...u, priorityPicker: undefined, expandedRow: undefined })); await refresh($)
        }).catch(e => $.ui.toast(tr('control.failed', { reason: String(e) }))) },
        picker: key => setUi(u => ({ ...u, expandedRow: u.expandedRow === `priority:${key}` ? undefined : `priority:${key}`, priorityPicker: undefined })),
        unclaimed: () => setUi(u => ({ ...u, unclaimedOnly: !u.unclaimedOnly })),
      },
      settings: {
        select: key => setUi(u => ({ ...u, selectedSetting: key })),
        chooseSetting: (key, value) => { void writeSetting($, key, value).then(() => refresh($)).catch(e => $.ui.toast(tr('control.failed', { reason: String(e) }))) },
        choosePlanSetting: (key, value) => { if (snap.focusPlan && io && paths) void writePlanSetting(io, paths, snap.focusPlan, key, value).then(() => { planCache.delete(snap.focusPlan!); return refresh($) }).catch(e => $.ui.toast(tr('control.failed', { reason: String(e) }))) },
        setting: key => { void cycleSetting($, key, settings).then(() => refresh($)).catch(e => $.ui.toast(tr('control.failed', { reason: String(e) }))) },
        planSetting: key => { if (snap.focusPlan && io && paths) void cyclePlanSetting(io, paths, snap.focusPlan, key).then(() => { planCache.delete(snap.focusPlan!); return refresh($) }).catch(e => $.ui.toast(tr('control.failed', { reason: String(e) }))) },
        language: code => { void i18n?.setLanguage(code).then(() => refresh($)) },
        otherLanguage: () => { void $.prompt.fill({ text: '/progress lang ', mode: 'replace' }) },
        retranslate: () => { void i18n?.retranslate().then(() => refresh($)) },
      },
      accept: id => void accept($, id, 'panel').then(t => $.ui.toast(t)),
      reject: id => void reject($, id, '', 'panel').then(t => $.ui.toast(t)),
      edit: id => void $.prompt.fill({ text: tr('register.m055', { p0: id }), mode: 'replace' }).catch(() => undefined),
      toggleReview: () => setUi(u => ({ ...u, showReview: !u.showReview })),
      selectReview: id => setUi(u => ({ ...u, selectedReview: u.selectedReview === id ? null : id })),
      undo: () => {
        const id = ui.selectedReview
        if (!id) { $.ui.toast(tr('register.m056')); return }
        void undoReview($, id).then(t => { $.ui.toast(t); setUi(u => ({ ...u, selectedReview: null })) })
      },
      refresh: () => later($),
      pickNext: () => {
        const ids = snap.plans.filter(p => p.status === 'active' && (snap.repoPlans.includes(p.id) || snap.sessions.some(s => s.isSelf && s.claims.some(c => c.plan === p.id)))).map(p => p.id)
        if (ids.length < 2) { $.ui.toast(tr('register.m057')); return }
        const cur = snap.focusPlan ? ids.indexOf(snap.focusPlan) : -1
        const nextId = ids[(cur + 1) % ids.length] ?? null
        setUi(u => ({ ...u, pick: nextId }))
      },
      togglePhase: (id, wasOpen) => setUi(u => ({ ...u, expanded: [...u.expanded.filter(k => k !== `open-${id}` && k !== `shut-${id}`), wasOpen ? `shut-${id}` : `open-${id}`] })),
      toggleExpand: key => setUi(u => ({ ...u, expanded: u.expanded.includes(key) ? u.expanded.filter(k => k !== key) : [...u.expanded, key] })),
      toggleRelated: () => setUi(u => ({ ...u, showRelated: !u.showRelated })),
      toggleEnded: () => setUi(u => ({ ...u, showEnded: !u.showEnded })),
      dismissAway: () => {
        void (async () => {
          const s = await ensureSelf($)
          if (!s?.away) return
          s.away.dismissedAt = await now($)
          await saveSelf($, true)
          await refresh($)
        })().catch(() => undefined)
      },
    })
  })
}
