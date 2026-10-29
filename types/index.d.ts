// progress-board data contract: what is stored on disk and held in $.state.

export type ItemStatus = 'todo' | 'wrapping' | 'done' | 'void'
export type Priority = 'pinned' | 'high' | 'normal' | 'low' | 'deferred'

export type ImportEvidence = { key: string; file?: string; line?: number; url?: string }
export type ImportKind = 'gsd' | 'specs' | 'kiro' | 'taskmaster' | 'markdown' | 'github' | 'plan-mode'
export type ImportSource = { kind: ImportKind; key: string; path?: string; repo?: string; cwd: string; lastImportedAt: number; present: string[] }
export type ItemRefs = { pr?: { repo?: string; number: number }[]; branch?: string[] }
export type RefCheck = { lastCheckedAt: number; state: 'pending' | 'open' | 'draft' | 'merged' | 'closed' | 'present' | 'missing' | 'unknown'; token?: string }

export type Item = {
  source?: ImportEvidence
  priority?: Priority
  priorityReason?: { reason: string; by: string; at: number }
  refs?: ItemRefs
  /** 分支首次关联时间；旧数据无时间时不能据历史 PR 自动推进。 */
  branchAddedAt?: Record<string, number>
  id: string
  title: string
  status: ItemStatus
  /** Set when the plan's criteria exception lets a wrapping item count as complete. */
  exception?: string
  reason?: string
  updatedAt: number
  doneAt?: number
  /** Stations of the plan's milestones passed (0..milestones.length); done implies all. */
  milestone?: number
  /** Count before entering done, restored when the item is reopened. */
  milestoneBeforeDone?: number
}

export type Phase = {
  source?: ImportEvidence
  priority?: Priority
  id: string
  name: string
  repo?: string
  isVoid?: boolean
  /** Stable identity of the generated release phase; its display name may be localized. */
  isRelease?: boolean
  voidReason?: string
  reason?: string
  addedAt: number
  items: Item[]
}

export type ApprovalKind = 'plan_mode' | 'question' | 'quote' | 'panel' | 'command' | 'away' | 'relayed'

export type Approval = {
  kind: ApprovalKind
  text?: string
  at: number
  by?: string
  relayedBy?: string
  isUnverified?: boolean
  /** question: the question text the answer belongs to. */
  question?: string
  /** question: whether the answer says yes. */
  isAffirmative?: boolean
  /** plan_mode: still awaiting a team leader's approval. */
  isPending?: boolean
  /** When this evidence was spent on a change; evidence is single-use. */
  usedAt?: number
}

export type Undo =
  | { kind: 'plan-draft' }
  /** `expect`: the touched phases right after the change; an undo refuses when they changed since. */
  | { kind: 'phases'; removeIds: string[]; restore: { index: number; phase: Phase }[]; expect?: Phase[] }

export type Review = {
  id: string
  at: number
  summary: string
  reason: string
  by: string
  relayedBy?: string
  isAway?: boolean
  undo: Undo
}

export type PlanStatus = 'draft' | 'active' | 'done' | 'abandoned'

export type Revert = { item: string; reason: string; at: number }

export type Plan = {
  source?: ImportSource
  priorityReceipts?: { target: string; quote?: string; by: string; messageId?: string }[]
  priorityNotices?: { id: string; detail: string; deliveredTo?: string }[]
  auto_done_on_merge?: boolean
  v: 1
  id: string
  title: string
  goal: string
  criteria: string
  repos: string[]
  status: PlanStatus
  createdAt: number
  updatedAt: number
  createdBy: string
  approval?: Approval
  /** Why the plan was abandoned (rejected drafts included). */
  endReason?: string
  phases: Phase[]
  /** The stations an item passes (e.g. 开 PR / 检查通过 / 合并 / 部署); items carry how many they passed. */
  milestones?: string[]
  reviews: Review[]
  seq: number
  added: number
  voided: number
  reverts: Revert[]
}

export type LogEntry = {
  at: number
  by: string
  plan: string
  action: string
  detail: string
  reason?: string
  approval?: Approval
  isReview?: boolean
  /** The completion time was entered by hand (`done_at`): not news, so 最近完成 ignores it. */
  isBackfill?: boolean
  source?: 'panel' | 'quote' | 'control'
  intentId?: string
  status?: ItemStatus
  previousStatus?: ItemStatus
  quote?: string
  quotedAt?: string
  target?: string
  level?: Priority
  controlId?: string
}

export type StepStatus = 'todo' | 'doing' | 'done'
export type Step = { title: string; status: StepStatus; taskId?: string }

export type ClaimSource = 'env' | 'task' | 'lineage' | 'claim' | 'repo' | 'mention' | 'worktree'
export type Claim = { plan: string; phase?: string; item?: string; at: number; source: ClaimSource; worker?: true; /** Who holds it on the session's behalf (a worker or subagent name). */ by?: string }

export type BgTask = {
  direct?: boolean
  workerSource?: 'dispatch' | 'claim'
  dispatchId?: string
  id: string
  kind: 'agent' | 'bash'
  name: string
  startedAt: number
  endedAt?: number
  taskId?: string
  /** The item the dispatched agent was claimed for; released when the agent completes. */
  claim?: Claim
}

export type SessionKind = 'normal' | 'orchestrator' | 'dispatched'

/** A decision the model made on the person's behalf. */
export type Decision = { text: string; reversible: boolean; undo?: string; at: number }

/** A non-blocking question the model queued for the person. */
export type Ask = { id: string; question: string; options?: string[]; at: number; /** A requeued question ignores older text answers, including legacy untimed ones. */ reopenedAt?: number }

/** The person's away window: when they left, when they came back, and whether the card was dismissed. */
export type AwayWindow = { from: number; to: number; dismissedAt?: number }

export type ProgressEvent = { kind: 'bash' | 'agent' | 'task' | 'message' | 'control'; text: string; at: number; /** 控制事实按 nonce 与方向去重；旧记录没有此字段。 */ id?: string }

export type ControlIntent = { id: string; from: string; target: string; action: 'dispatch_now' | 'compact' | 'interrupt' | 'reconcile' | 'message'; at: number; expires: number; source: 'panel' | 'command'; payloadHash: string; usedAt?: number; messagePrefix?: string }
export type DispatchPermit = { id: string; plan: string; item: string; phase?: string; at: number; source: 'panel' | 'control'; intentId: string; usedAt?: number; remote?: boolean }
export type PendingControl = { id: string; to: string; action: 'dispatch' | 'compact' | 'abort' | 'reconcile' | 'message'; at: number; tokenHash?: string; payloadHash?: string; address?: string; usedAt?: number; resultSeen?: string; intentId?: string; source?: 'panel' | 'command'; deliveredAt?: number }
export type ControlResult = { id: string; from: string; to: string; at: number; message: string; ok: boolean; final: boolean }
export type OwnQuote = { text: string; at: number; id?: string; hash?: string }

export type SessionRec = {
  /** 由本会话自己的 ListAgents 自身说明捕获，不从标题或 UUID 猜测。 */
  nativeName?: string
  ref?: string
  controlVersion?: 1
  controlIntents?: ControlIntent[]
  dispatchPermits?: DispatchPermit[]
  ownQuotes?: OwnQuote[]
  pendingControls?: PendingControl[]
  controlResults?: ControlResult[]
  waitingState?: { known: string[]; pending: string[]; count: number }
  seenControls?: { nonce: string; at: number }[]
  model?: string
  cost?: number
  context?: { tokens?: number; window: number; percent?: number }
  working?: boolean
  currentTools?: { id: string; name: string; at: number }[]
  lastMessage?: string
  pendingCompact?: { from: string; to: string; id?: string; at?: number }[]
  activityEvents?: ProgressEvent[]
  events?: ProgressEvent[]
  pendingProgress?: { event: string; targets: { plan: string; items: string[] }[]; note?: string }
  lastPlanCall?: number
  lastProgressNudge?: number
  unclaimedNudged?: boolean
  v: 1
  id: string
  kind: SessionKind
  role?: string
  startedAt: number
  endedAt?: number
  endReason?: string
  cwd: string
  repoKey?: string
  repoRoot?: string
  parent?: string
  parentSource?: 'env' | 'clear'
  envPlan?: string
  title?: string
  firstMessage?: string
  /** A plan the task names explicitly (`Plan: x/y` / `计划：x/y` line of the first message). */
  taskPlan?: string
  goal?: string
  /** The person's latest request (first line), shown grey as 「（自动）」 while no goal is set; never a goal. */
  autoGoal?: string
  /** Non-progress-board main-loop tool calls made in this session. */
  calls?: number
  /** When the one forced stop (no goal by the 4th call) happened; never stopped again. */
  enforcedAt?: number
  /** The plan this session last claimed or changed; kept in view on row 2 after a release, until the plan ends. */
  lastPlan?: string
  /** When the model first called a progress-board tool; such a session is never stopped for a goal. */
  usedToolAt?: number
  /** Counted main-loop calls since the last progress_session call. */
  sinceReport?: number
  /** Short summaries of those calls (tool and its target, at most five); records written before 0.6.1 have none. */
  recentCalls?: string[]
  /** Step reminders given since the last progress_session call (the interval doubles with each). */
  stepNudges?: number
  steps: Step[]
  stepsSource?: 'tool' | 'todo'
  /** Claims on plans this session works on. */
  claims: Claim[]
  /**
   * Plans the person accepted here or the model changed an item of here: counted as a participating session,
   * never an attribution or a claim. Only entries with at count; itemAt is suggestion recency alone.
   */
  editedPlans?: { plan: string; at?: number; itemAt?: number }[]
  /** Decisions the model took on the person's behalf, each with whether it can be undone. */
  decided?: Decision[]
  /** Non-blocking decisions the model wants from the person (the 等你拍板 queue). */
  asks?: Ask[]
  /** How many asks this session has made (ids are `q<n>`). */
  askSeq?: number
  /** Ids or texts of queued asks that have been answered. */
  answered?: string[]
  /** Timestamped text answers shared at read time, including after this session ends. */
  answerLog?: { question: string; at: number }[]
  /** Steps that became done and when (a step itself carries no time). */
  stepLog?: { title: string; at: number }[]
  /** The window the person was away, frozen when they came back; `dismissedAt` hides its card. */
  away?: AwayWindow
  /** Legacy field, ignored: away windows start at the last own prompt. */
  awayAuthAt?: number
  bg: BgTask[]
  dispatched: number
  agentsDone: number
  question?: { since: number; text: string }
  approvals: Approval[]
  messages: { dir: 'to' | 'from'; peer: string; at: number }[]
  lastActivity: number
  lastUserInput: number
  pid?: number
  /** The process's start identity, so a reused PID is not taken for this session. */
  pidStart?: string
  limits: string[]
}

export type Attribution = {
  /** Plans the session certainly works on; `phase` is set when the evidence names one (a worktree name). */
  confident: { plan: string; source: ClaimSource; phase?: string }[]
  speculative: { plan: string; source: ClaimSource }[]
}

export type SessionView = SessionRec & { isAlive: boolean; isSelf: boolean; attribution: Attribution; cwdMissing: boolean }

export type WaitingItem =
  | { kind: 'draft'; plan: string; phases: number }
  | { kind: 'review'; plan: string; count: number; first: string }
  | { kind: 'question'; session: string; name: string; since: number }
  /** A queued question (Part D): one entry per distinct normalized text across live sessions. */
  | { kind: 'ask'; id: string; question: string; options?: string[]; session: string; name: string; at: number; also: number }
  /** A decision made on the person's behalf while they were away, not yet reviewed. */
  | { kind: 'decision'; session: string; name: string; text: string; reversible: boolean; undo?: string; at: number }

/** What happened while the person was away, frozen when they came back. */
export type AwayReport = {
  from: number
  to: number
  /** Items that became done in the window. */
  items: { plan: string; planTitle: string; phase: string; item: string; at: number }[]
  /** Session steps ticked done in the window, grouped by session. */
  steps: { session: string; name: string; titles: string[] }[]
  /** Decisions the model took in the window, each naming whether it can be undone. */
  decisions: { session: string; name: string; text: string; reversible: boolean; undo?: string; at: number }[]
}

export type SuggestionFields = { item: string; status?: 'todo' | 'wrapping' | 'done'; milestone?: number; split?: string[]; reason: string; evidence: string }
export type MonitorCost = { usd: number; input: number; output: number; cacheRead: number; cacheWrite: number; basis: string }
export type Suggestion = SuggestionFields & { id: string; created: number; by: 'monitor'; state: 'open' | 'accepted' | 'rejected'; cost: MonitorCost; deliveries?: number; deliveredAt?: number; deliveredTo?: string; resolvedAt?: number; resolvedBy?: string; resolutionReason?: string }
export type MonitorRecord = { owner: string; heartbeat: number; lastRun?: number; digestHash?: string; runToken?: string; commits?: Record<string, string[]>; dailyCost?: Record<string, number> }
export type MonitorView = { enabled: boolean; lastRun?: number; open: number; todayCost: number }

export type BoardSettings = {
  barGlyph: string; enforceGoal: boolean; stepReminder: number; awayMinutes: number
  monitor: boolean; monitorMinutes: number; autoDone: boolean; retention: number
  contextWarning: number; notifications: string
}
export type PlanSettings = Partial<Pick<BoardSettings, 'monitor' | 'monitorMinutes' | 'autoDone'>>
export type ActivityEntry = { id: string; at: number; kind: 'completion' | 'event' | 'decision'; by: string; plan?: string; text: string; semantic?: 'success' | 'started' | 'change' | 'waiting'; verb?: string }
export type Snapshot = {
  activity?: ActivityEntry[]
  settings?: BoardSettings
  planSettings?: Record<string, PlanSettings>
  monitors?: Record<string, MonitorView>
  now: number
  selfId: string | null
  focusPlan: string | null
  repoPlans: string[]
  plans: Plan[]
  sessions: SessionView[]
  waiting: WaitingItem[]
  recent: { at: number; text: string; tag: string }[]
  /** The frozen away summary shown at the top of the panel; null when there is none or it was dismissed. */
  away?: AwayReport | null
}

export type PanelTab = 'progress' | 'priorities' | 'sessions' | 'activity' | 'settings'
export type PanelUi = {
  tab?: PanelTab
  search?: string
  itemFilter?: 'all' | 'doing' | 'wrapping' | 'todo' | 'done'
  showDaily?: boolean
  unclaimedOnly?: boolean
  priorityPicker?: string
  /** One expanded action row across the pane, prefixed session: or priority:. */
  expandedRow?: string
  selectedSetting?: string
  /** Explicit language override; null follows the host language. */
  settingLanguage?: string | null
  confirmation?: { key: string; until: number }
  interruptDispatch?: boolean
  activityFilter?: 'all' | ActivityEntry['kind']
  activityCount?: number
  expanded: string[]
  showReview: boolean
  selectedReview: string | null
  showRelated: boolean
  showEnded: boolean
  pick: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'progress-board': {
      snapshot: Snapshot | null
      ui: PanelUi
      tick: number
      localeVersion: number
      isHeadless: boolean
    }
  }
}
