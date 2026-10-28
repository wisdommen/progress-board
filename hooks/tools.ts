import { t as tr } from './i18n'
// The two tools the model calls: progress_session (this session) and progress_plan (the overall plan).

import type { ToolSpec } from 'claude-code'

import type { Ask, Claim, LogEntry, Plan, SessionRec, Step, StepStatus } from '../types'
import { isReviewer } from './attrib'
import { levels, setPriority, deviationReason } from './priorities'
import { matchingQuote } from './quotes'
import type { Priority } from '../types'
import { WORKER_DUTY } from './freshness'
import { mergeRefs, parseRefs } from './facts'
import { resolveSuggestion } from './monitor'
import {
  addItems, answeredQuestions, changeItem, changePhases, displayList, findItem, findPhase, isAskAnswered, isAskId, judgeApproval, newPlan, newReview, recordAnswers, renderPlanMd,
} from './model'
import type { ApprovalInput, ItemSpec, PhaseOp, PhaseSpec } from './model'
import { mutatePlan, readPlan, parseJson } from './store'
import type { Io, Mutation, Paths } from './store'
import { PLAN_ID, hhmm, normQuestion, parsePastTime } from './util'

export const SESSION_TOOL = 'progress_session'
export const PLAN_TOOL = 'progress_plan'

const claimSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: "Plan ID, e.g. acme/v1.2" },
      phase: { type: 'string', description: "Phase ID or name (optional)" },
      item: { type: 'string', description: "Item ID or title (optional)" },
      by: { type: 'string', description: "claim: claim on behalf of a subagent / worker name (optional)" },
    },
    required: ['plan'],
  },
}

export const sessionSpec: ToolSpec = {
  name: SESSION_TOOL,
  isDeferred: false,
  description: [
    WORKER_DUTY,
    "Record this session's own progress (band above the prompt and /progress panel). ",
    "Set goal and steps at the start of multi-step work; immediately mark each finished step done and the next step doing via step_updates, never batch ticks at the end. ",
    "Claim a plan phase or item when starting it, release when stopping; long-running dispatch-led sessions set orchestrator: true. ",
    "Claims release automatically when the item is done or void; do not add mark-complete / release-claim steps. ",
    "Use decided for decisions made for the user (reversible and undo); queue nonblocking user decisions with ask_user. ",
    "steps replaces the whole list; step_updates changes one step by 1-based index or title. Mark done only when actually finished. ",
    "Subagents must not call this tool.",
  ].join(''),
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: "This session's goal, one sentence" },
      orchestrator: { type: 'boolean', description: "Declare a coordinator session (mainly dispatching)" },
      role: { type: 'string', description: "Role, e.g. developer / reviewer" },
      steps: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] } }, required: ['title'] },
      },
      step_updates: {
        type: 'array',
        items: {
          type: 'object',
          properties: { index: { type: 'number' }, title: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] } },
          required: ['status'],
        },
      },
      claim: claimSchema,
      release: claimSchema,
      decided: {
        type: 'array',
        description: "Decisions made for the user: state reversible and undo for each",
        items: { type: 'object', properties: { text: { type: 'string' }, reversible: { type: 'boolean' }, undo: { type: 'string' } }, required: ['text', 'reversible'] },
      },
      ask_user: {
        type: 'array',
        description: "Nonblocking questions needing user decisions; queue without interrupting work",
        items: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] },
      },
      answered: { type: 'array', items: { type: 'string' }, description: "Answered queued questions (question text or id)" },
    },
  },
}

export const planSpec: ToolSpec = {
  name: PLAN_TOOL,
  isDeferred: false,
  description: [
    WORKER_DUTY,
    "Manage the overall plan (phases → items; the sole source of overall progress). action: ",
    "import detects GSD, Markdown, spec-kit/Kiro, Taskmaster, GitHub or a plan-mode file from source/path; always creates an unapproved draft. Reimport reconciles by source identity, only advances status, never deletes or overwrites local fields. plan is optional only for import. ",
    "set_priority changes an item or phase level (pinned/high/normal/low/deferred), only with a meaningful normalized quote from the first 200 characters of the person's own message, a matching quoted_at (within 2 minutes), and the target id, a distinctive title fragment or the requested level in that quote. A message is usable once per target. Never change priorities by your own judgment. explain_priority records item and reason for working out of order. ",
    "propose a plan with project-prefixed plan ID, goal, criteria (may include exceptions), phases, optional repos and milestones; appends a Closeout / Release phase by default. ",
    "phases items are strings or {title, status: done, done_at} for historical completions (done_at must not be in the future). ",
    "confirm a draft; insert_phase / split_phase / void_phase change phases (reason required). ",
    "add_items adds phase items; set_milestones names stations (e.g. open PR / checks pass / merge / deploy; no approval required). ",
    "set_item changes todo / wrapping (finished, awaiting review/acceptance/merge) / done / void; reverting requires reason. ",
    "done_at backfills completion time; milestone is the passed-station count (0..milestone count; reverting requires reason; done implies all passed). ",
    "Mark done only after confirming criteria are met with meets_criteria: true; abandon cancels the plan. ",
    "set_item refs merges PR/branch references; propose / set auto_done_on_merge defaults false, enable only when criteria allow merge to imply done. ",
    "resolve_suggestion uses id and accepted to accept or reject a suggestion; rejection requires reason. Verify and update with set_item first, then resolve; suggestions never execute automatically. ",
    "Phase changes (propose, confirm, phase edits) need user approval evidence: approval kind=plan_mode (just approved), ",
    "question (an affirmative answer to a question naming this plan ID), or quote (verbatim quote and quoted_at, checked against this session's user messages). ",
    "Changes while the user is away (verbatim away_authorization, verified, or 30 minutes without input), or relayed by another session (relayed_by), take effect but await review. ",
    "Evidence may be used only once. ",
    "Without evidence a new plan is a draft, not active; the user accepts it in /progress.",
  ].join(''),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['import', 'propose', 'confirm', 'insert_phase', 'split_phase', 'void_phase', 'add_items', 'set_item', 'set_milestones', 'set', 'resolve_suggestion', 'abandon', 'set_priority', 'explain_priority'] },
      level: { type: 'string', enum: [...levels], description: 'set_priority: requires the person\'s exact quote and quoted_at; never choose priorities yourself.' },
      quote: { type: 'string', description: 'Exact words in the person\'s own message, usable once per target.' },
      quoted_at: { type: ['string', 'number'], description: 'Timestamp of the quoted instruction.' },
      id: { type: 'string', description: "resolve_suggestion: suggestion id" },
      accepted: { type: 'boolean', description: "resolve_suggestion: true to accept, false to reject; rejection requires reason" },
      auto_done_on_merge: { type: 'boolean', description: "propose / set: auto-complete on merge, default false; enable only when criteria permit" },
      refs: { type: 'object', description: "set_item: merge PR / branch references without replacing existing ones", properties: {
        pr: { type: 'array', items: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer', minimum: 1 } }, required: ['number'] } },
        branch: { type: 'array', items: { type: 'string' } },
      } },
      plan: { type: 'string', description: "Plan ID with project prefix, e.g. acme/v1.2" },
      source: { type: 'string', description: 'import: gsd, specs, kiro, taskmaster, markdown, github or plan-mode; omit for detection' },
      path: { type: 'string', description: 'import: local path or GitHub owner/repo; optional for detection' },
      title: { type: 'string' },
      goal: { type: 'string' },
      criteria: { type: 'string', description: "Completion criteria; may specify exceptions (e.g. To Test does not block completion)" },
      repos: { type: 'array', items: { type: 'string' }, description: "Repository paths" },
      milestones: { type: 'array', items: { type: 'string' }, description: "propose / set_milestones: item milestones (e.g. open PR, checks pass, merge, deploy)" },
      phases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' }, repo: { type: 'string' },
            items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: ['done', 'todo'] }, done_at: { type: ['string', 'number'] } }, required: ['title'] }] } },
          },
          required: ['name'],
        },
      },
      include_release_phase: { type: 'boolean' },
      phase: { type: 'string', description: "Phase ID or name" },
      after: { type: 'string', description: "insert_phase: insert after this phase" },
      name: { type: 'string', description: "insert_phase: new phase name" },
      into: {
        type: 'array', description: "split_phase: replacement phases",
        items: { type: 'object', properties: { name: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } }, required: ['name'] },
      },
      items: { type: 'array', items: { type: 'string' }, description: "add_items / insert_phase: item titles" },
      item: { type: 'string', description: "set_item: item ID or title" },
      status: { type: 'string', enum: ['todo', 'wrapping', 'done', 'void'] },
      exception: { type: 'string', description: "set_item: reason an exception to criteria counts as complete" },
      done_at: { type: ['string', 'number'], description: "set_item / items: backfilled completion time (ISO or epoch ms, never in future)" },
      milestone: { type: 'number', description: "set_item: number of milestones passed (0..milestone count)" },
      meets_criteria: { type: 'boolean' },
      reason: { type: 'string' },
      approval: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['plan_mode', 'question', 'quote'] },
          quote: { type: 'string' },
          quoted_at: { type: 'string' },
          away_authorization: { type: 'string' },
          relayed_by: { type: 'string' },
        },
      },
    },
    required: ['action'],
  },
}

export type ToolCtx = {
  io: Io
  paths: Paths
  sessionId: string
  now: number
  self: SessionRec
  /** Whether `quote` is in one of the person's own messages; null when the transcript cannot be read. */
  quoteFound: (quote: string) => Promise<boolean | null>
  /** Records repo-index evidence for a plan. */
  touchRepos: (plan: Plan) => Promise<void>
  /** Questions other live sessions have queued, so a duplicate can say where it already is. */
  peerAsks: readonly { name: string; question: string; at: number }[]
  /** Retained records provide shared answers without cross-session writes. */
  sessions?: readonly SessionRec[]
}

type ClaimIn = { plan?: unknown; phase?: unknown; item?: unknown; by?: unknown }
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** A step carries no time of its own; the sessions' away report needs when it was ticked. */
function logStep(s: SessionRec, title: string, at: number): void {
  s.stepLog = [...(s.stepLog ?? []), { title, at }].slice(-50)
}

/** Applies progress_session to the in-memory record; answers the text the model reads. */
export async function runSessionTool(input: Record<string, unknown>, ctx: ToolCtx): Promise<{ text: string; isError?: boolean }> {
  const s = ctx.self
  const notes: string[] = []
  const goal = str(input['goal'])
  if (goal) { s.goal = goal; notes.push(tr('tools.m050', { p0: goal })) }
  if (typeof input['orchestrator'] === 'boolean') {
    s.kind = input['orchestrator'] ? 'orchestrator' : s.parent ? 'dispatched' : 'normal'
    notes.push(input['orchestrator'] ? tr('tools.m051') : tr('tools.m052'))
  }
  const role = str(input['role'])
  if (role) s.role = role
  const okStatus = (v: unknown): StepStatus => (v === 'doing' || v === 'done' ? v : 'todo')
  if (Array.isArray(input['steps'])) {
    const before = new Map(s.steps.map(x => [x.title, x.status]))
    s.steps = (input['steps'] as { title?: unknown; status?: unknown }[])
      .map(x => ({ title: str(x.title) ?? '', status: okStatus(x.status) }))
      .filter(x => x.title) as Step[]
    s.stepsSource = 'tool'
    for (const st of s.steps) if (st.status === 'done' && before.get(st.title) !== 'done') logStep(s, st.title, ctx.now)
    notes.push(tr('tools.m053', { p0: s.steps.length }))
  }
  if (Array.isArray(input['step_updates'])) {
    for (const u of input['step_updates'] as { index?: unknown; title?: unknown; status?: unknown }[]) {
      const i = typeof u.index === 'number' ? u.index - 1 : s.steps.findIndex(x => x.title === str(u.title))
      const step = s.steps[i]
      if (!step) { notes.push(tr('tools.m054', { p0: String(u.index ?? u.title) })); continue }
      const next = okStatus(u.status)
      if (next === 'done' && step.status !== 'done') logStep(s, step.title, ctx.now)
      step.status = next
      notes.push(tr('tools.stepChanged', { title: step.title, status: step.status }))
    }
    s.stepsSource = 'tool'
  }
  if (Array.isArray(input['decided'])) {
    const list = (input['decided'] as { text?: unknown; reversible?: unknown; undo?: unknown }[])
      .map(d => ({ text: str(d.text) ?? '', reversible: d.reversible === true, ...(str(d.undo) ? { undo: str(d.undo) as string } : {}) }))
      .filter(d => d.text)
    if (list.length) {
      s.decided = [...(s.decided ?? []), ...list.map(d => ({ ...d, at: ctx.now }))].slice(-50)
      notes.push(tr('tools.m055', { p0: list.length }))
    }
  }
  const resolveClaim = async (c: ClaimIn): Promise<Claim | string> => {
    const planId = str(c.plan)
    if (!planId) return tr('tools.m056')
    const plan = await readPlan(ctx.io, ctx.paths, planId)
    if (!plan) return tr('tools.m057', { p0: planId })
    if (plan.status === 'done' || plan.status === 'abandoned') return tr('tools.m058', { p0: planId })
    if (plan.status === 'draft') return tr('tools.m059', { p0: planId })
    const by = str(c.by)
    const claim: Claim = { plan: planId, at: ctx.now, source: 'claim', ...(by ? { by, worker: true } : {}) }
    const ph = str(c.phase)
    const it = str(c.item)
    if (it) {
      const hit = findItem(plan, it, ph)
      if (!hit) return tr('tools.m060', { p0: planId, p1: it })
      claim.phase = hit.phase.id
      claim.item = hit.item.id
    } else if (ph) {
      const p = findPhase(plan, ph)
      if (!p) return tr('tools.m061', { p0: planId, p1: ph })
      claim.phase = p.id
    }
    return claim
  }
  const same = (a: Claim, b: Claim) => a.plan === b.plan && a.phase === b.phase && a.item === b.item
  if (Array.isArray(input['claim']) && isReviewer(s)) {
    notes.push(tr('tools.m062'))
  } else if (Array.isArray(input['claim'])) {
    for (const c of input['claim'] as ClaimIn[]) {
      const r = await resolveClaim(c)
      if (typeof r === 'string') { notes.push(r); continue }
      const workers = r.by ? s.bg.filter(b => b.kind === 'agent' && b.taskId && b.endedAt === undefined && (b.name === r.by || b.taskId === r.by)) : []
      if (workers.length === 1) {
        const worker = workers[0]!
        r.by = worker.name
        worker.direct = true
        worker.workerSource = 'claim'
        worker.claim = { ...r }
      }
      s.claims = [...s.claims.filter(x => !same(x, r)), r]
      s.lastPlan = r.plan
      const plan = await readPlan(ctx.io, ctx.paths, r.plan)
      if (plan) {
        await ctx.touchRepos(plan)
        const targets = r.item ? [r.item] : plan.phases.filter(ph => !r.phase || ph.id === r.phase).flatMap(ph => ph.items.map(it => it.id))
        for (const item of targets) { const advice = deviationReason(plan, item, ctx.sessions ?? [s]); if (advice) notes.push(advice) }
      }
      notes.push(tr('tools.m063', { p0: r.plan, p1: r.item ? ` › ${r.item}` : r.phase ? ` › ${r.phase}` : '' }))
    }
  }
  if (Array.isArray(input['release'])) {
    for (const c of input['release'] as ClaimIn[]) {
      const planId = str(c.plan)
      const ph = str(c.phase)
      const it = str(c.item)
      // Claims are recorded by ids; the model names phases and items by name as often as by id.
      const plan = planId ? await readPlan(ctx.io, ctx.paths, planId) : null
      const phId = ph ? (plan && findPhase(plan, ph)?.id) || ph : undefined
      const itId = it ? (plan && findItem(plan, it, ph)?.item.id) || it : undefined
      const before = s.claims.length
      s.claims = s.claims.filter(x => !(x.plan === planId && (!phId || x.phase === phId || x.phase === undefined) && (!itId || x.item === itId)))
      notes.push(before === s.claims.length ? tr('tools.m064', { p0: planId ?? '' }) : tr('tools.m065', { p0: planId, p1: it ? ` › ${it}` : '' }))
    }
  }
  if (Array.isArray(input['ask_user'])) {
    for (const raw of input['ask_user'] as { question?: unknown; options?: unknown }[]) {
      const question = str(raw.question)
      if (!question) continue
      const options = Array.isArray(raw.options) ? raw.options.map(o => (typeof o === 'string' ? o.trim() : '')).filter(Boolean) : []
      const key = normQuestion(question)
      const answered = answeredQuestions([s, ...(ctx.sessions ?? []).filter(x => x.id !== s.id)])
      const same = (s.asks ?? []).find(a => normQuestion(a.question) === key && !isAskAnswered(s, a, answered))
      if (same) {
        if (options.length) same.options = options
        notes.push(tr('tools.m066', { p0: same.question }))
        continue
      }
      s.askSeq = Math.max(s.askSeq ?? 0, ...(s.asks ?? []).map(a => isAskId(a.id) ? Number(a.id.slice(1)) : 0)) + 1
      const reopened = answered.has(key)
      const ask: Ask = { id: `q${s.askSeq}`, question, ...(options.length ? { options } : {}), at: ctx.now, ...(reopened ? { reopenedAt: ctx.now } : {}) }
      s.asks = [...(s.asks ?? []).filter(a => normQuestion(a.question) !== key), ask].slice(-20)
      notes.push(options.length ? tr('tools.queuedWithOptions', { question, options: displayList(options) }) : tr('tools.m067', { p0: question, p1: '' }))
      const peer = ctx.peerAsks.find(p => normQuestion(p.question) === key)
      if (peer) notes.push(tr('tools.m068', { p0: peer.name, p1: hhmm(peer.at) }))
    }
  }
  if (Array.isArray(input['answered'])) {
    const list = arr(input['answered'])
    if (list.length) {
      recordAnswers(s, list, ctx.now)
      notes.push(tr('tools.m069', { p0: displayList(list) }))
    }
  }
  return { text: notes.length ? tr('tools.m070', { p0: displayList(notes) }) : tr('tools.m071') }
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : []
}

/** Item specs for a plan edit: titles, or finished items carrying their real completion time. */
function itemSpecs(v: unknown, now: number): { items: ItemSpec[] } | { error: string } {
  if (v === undefined || v === null) return { items: [] }
  if (!Array.isArray(v)) return { error: tr('tools.m072') }
  const out: ItemSpec[] = []
  for (const raw of v) {
    if (typeof raw === 'string') { const t = raw.trim(); if (t) out.push({ title: t }); continue }
    if (!raw || typeof raw !== 'object') continue
    const o = raw as { title?: unknown; status?: unknown; done_at?: unknown }
    const title = str(o.title)
    if (!title) continue
    if (o.status !== undefined && o.status !== 'done' && o.status !== 'todo') return { error: tr('tools.m073', { p0: title }) }
    const t = parsePastTime(o.done_at, now)
    if ('error' in t) return { error: tr('tools.m074', { p0: title, p1: t.error }) }
    if (t.at !== undefined && o.status !== 'done') return { error: tr('tools.m075', { p0: title }) }
    out.push({ title, ...(o.status === 'done' ? { status: 'done' as const } : {}), ...(t.at !== undefined ? { doneAt: t.at } : {}) })
  }
  return { items: out }
}

function phaseSpecs(v: unknown, now: number): { phases: PhaseSpec[] } | { error: string } {
  if (!Array.isArray(v)) return { phases: [] }
  const phases: PhaseSpec[] = []
  for (const p of v as { name?: unknown; repo?: unknown; items?: unknown }[]) {
    const name = str(p.name)
    if (!name) continue
    const it = itemSpecs(p.items, now)
    if ('error' in it) return it
    phases.push({ name, ...(str(p.repo) ? { repo: str(p.repo) as string } : {}), items: it.items })
  }
  return { phases }
}

/** Applies progress_plan under the plan's lock. */
export async function runPlanTool(input: Record<string, unknown>, ctx: ToolCtx): Promise<{ text: string; isError?: boolean }> {
  const action = str(input['action'])
  const id = str(input['plan'])
  if (!action || !id) return { text: tr('tools.m076'), isError: true }
  if (!PLAN_ID.test(id)) return { text: 'Invalid project-prefixed plan ID.', isError: true }
  if (action === 'set_priority') {
    const quote = str(input['quote']), level = str(input['level']) as Priority
    const timestamp = parsePastTime(input['quoted_at'], ctx.now)
    if (!quote) return { text: 'Priority changes need a meaningful quote from the person\'s own message in this session.', isError: true }
    if ('error' in timestamp || timestamp.at === undefined || !levels.includes(level) || (!str(input['item']) && !str(input['phase']))) return { text: 'Provide a target, a valid priority level and quoted_at.', isError: true }
    const evidence = matchingQuote(ctx.self, quote, timestamp.at)
    if (!evidence?.id) return { text: 'Priority changes need a meaningful quote from the person\'s own message in this session, with its matching time.', isError: true }
    const result = await setPriority(ctx.io, ctx.paths, id, { item: str(input['item']), phase: str(input['phase']) }, level, ctx.sessionId, { source: 'quote', quote, quotedAt: String(input['quoted_at']), messageId: evidence.id })
    return 'error' in result ? { text: result.error, isError: true } : { text: 'Priority updated.' }
  }
  if (action === 'explain_priority') {
    const reason = str(input['reason'])
    if (!reason) return { text: 'A priority deviation needs a reason.', isError: true }
    const result = await mutatePlan(ctx.io, ctx.paths, id, (plan, at) => {
      const hit = plan && findItem(plan, str(input['item']) ?? '')
      if (!plan || !hit) return { error: 'No matching item.' }
      const next = { ...plan, phases: plan.phases.map(ph => ({ ...ph, items: ph.items.map(it => it.id === hit.item.id ? { ...it, priorityReason: { reason, by: ctx.sessionId, at } } : it) })) }
      return { plan: next, log: [{ by: ctx.sessionId, action: 'explain_priority', target: hit.item.id, detail: reason }], md: renderPlanMd(next) }
    })
    return 'error' in result ? { text: result.error, isError: true } : { text: 'Priority explanation recorded.' }
  }
  if (action === 'resolve_suggestion') return resolveSuggestion(ctx.io, ctx.paths, id, input['id'], input['accepted'], input['reason'], ctx.sessionId)
  const reason = str(input['reason']) ?? ''
  const approvalIn = (input['approval'] && typeof input['approval'] === 'object' ? input['approval'] : undefined) as ApprovalInput | undefined
  const quote = approvalIn?.kind === 'quote' && approvalIn.quote ? await ctx.quoteFound(approvalIn.quote) : null
  const away = approvalIn?.away_authorization?.trim() ? await ctx.quoteFound(approvalIn.away_authorization) : null
  const verdict = judgeApproval(approvalIn, { now: ctx.now, sessionId: ctx.sessionId, planId: id, session: ctx.self, quoteFound: quote, awayFound: away })
  let isSpent = false
  const by = ctx.sessionId
  const reviewId = () => `r${ctx.now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  let message = ''
  let releaseItem: string | undefined

  const res = await mutatePlan(ctx.io, ctx.paths, id, async (cur, now, guard): Promise<Mutation> => {
    const done = (plan: Plan, log: Omit<LogEntry, 'at' | 'plan'>[], msg: string): Mutation => {
      message = msg
      return { plan, log, md: renderPlanMd(plan) }
    }
    if (action === 'propose') {
      if (!PLAN_ID.test(id)) return { error: tr('tools.m077', { p0: id }) }
      if (cur && cur.status !== 'abandoned') return { error: tr('tools.m078', { p0: id, p1: cur.status }) }
      const goal = str(input['goal'])
      const criteria = str(input['criteria'])
      const specs = phaseSpecs(input['phases'], ctx.now)
      if ('error' in specs) return { error: specs.error }
      const phases = specs.phases
      if (!goal || !criteria || phases.length === 0) return { error: tr('tools.m079') }
      let plan = newPlan({ id, ...(str(input['title']) ? { title: str(input['title']) as string } : {}), goal, criteria, repos: arr(input['repos']), phases, milestones: arr(input['milestones']), includeRelease: input['include_release_phase'] !== false, by, now })
      if (typeof input['auto_done_on_merge'] === 'boolean') plan.auto_done_on_merge = input['auto_done_on_merge']
      if (verdict.ok) {
        isSpent = true
        plan = { ...plan, status: 'active', approval: verdict.approval }
        if (verdict.isReview) plan.reviews = [newReview(reviewId(), now, tr('tools.m080', { p0: plan.title }), verdict.approval.text ?? tr('tools.m081'), by, verdict.approval, verdict.isAway, { kind: 'plan-draft' })]
        return done(plan, [{ by, action: 'propose', detail: tr('tools.m082', { p0: plan.phases.length }), approval: verdict.approval, ...(verdict.isReview ? { isReview: true } : {}) }],
          tr('tools.m083', { p0: id, p1: verdict.isReview ? tr('tools.m084') : '' }))
      }
      return done(plan, [{ by, action: 'propose', detail: tr('tools.m085', { p0: plan.phases.length, p1: verdict.why }) }],
        tr('tools.m086', { p0: id, p1: verdict.why }))
    }
    if (!cur) return { error: tr('tools.m087', { p0: id }) }
    if (cur.status === 'abandoned') return { error: tr('tools.m088', { p0: id }) }
    if (action === 'confirm') {
      if (cur.status !== 'draft') return { error: tr('tools.m089', { p0: id, p1: cur.status }) }
      if (!verdict.ok) return { error: tr('tools.m090', { p0: verdict.why }) }
      isSpent = true
      const plan: Plan = { ...cur, status: 'active', approval: verdict.approval,
        reviews: verdict.isReview ? [...cur.reviews, newReview(reviewId(), now, tr('tools.m091', { p0: cur.title }), verdict.approval.text ?? '', by, verdict.approval, verdict.isAway, { kind: 'plan-draft' })] : cur.reviews }
      return done(plan, [{ by, action: 'confirm', detail: tr('tools.m092'), approval: verdict.approval, ...(verdict.isReview ? { isReview: true } : {}) }], tr('tools.m093', { p0: id, p1: verdict.isReview ? tr('tools.m094') : '' }))
    }
    if (action === 'insert_phase' || action === 'split_phase' || action === 'void_phase') {
      let op: PhaseOp
      if (action === 'insert_phase') {
        const name = str(input['name'])
        if (!name) return { error: tr('tools.m095') }
        op = { op: 'insert', name, ...(str(input['after']) ? { after: str(input['after']) as string } : {}), items: arr(input['items']) }
      } else if (action === 'split_phase') {
        const into = phaseSpecs(input['into'], ctx.now)
        if ('error' in into) return { error: into.error }
        op = { op: 'split', phase: str(input['phase']) ?? '', into: into.phases }
      } else op = { op: 'void', phase: str(input['phase']) ?? '' }
      const r = changePhases(cur, op, reason, now)
      if ('error' in r) return r
      // A draft's phase list is confirmed as a whole later; an active plan needs evidence now.
      if (cur.status === 'draft') return done(r.plan, [{ by, action, detail: r.detail, reason }], tr('tools.m096', { p0: r.detail }))
      if (!verdict.ok) return { error: tr('tools.m097', { p0: verdict.why }) }
      isSpent = true
      const plan: Plan = verdict.isReview ? { ...r.plan, reviews: [...r.plan.reviews, newReview(reviewId(), now, r.detail, reason, by, verdict.approval, verdict.isAway, r.undo)] } : r.plan
      return done(plan, [{ by, action, detail: r.detail, reason, approval: verdict.approval, ...(verdict.isReview ? { isReview: true } : {}) }],
        tr('tools.sentence', { text: `${r.detail}${verdict.isReview ? tr('tools.m098') : ''}` }))
    }
    if (action === 'add_items') {
      const r = addItems(cur, str(input['phase']) ?? '', arr(input['items']), now)
      if ('error' in r) return r
      return done(r.plan, [{ by, action, detail: r.detail, ...(reason ? { reason } : {}) }], tr('tools.sentence', { text: r.detail }))
    }
    if (action === 'set_milestones') {
      const list = arr(input['milestones'])
      if (list.length === 0) return { error: tr('tools.m099') }
      // It names the stations, not the scope: no approval needed. A passed count beyond the list keeps the last station.
      let clamped = 0
      const phases = cur.phases.map(ph => ({
        ...ph,
        items: ph.items.map(it => {
          if (it.milestone === undefined || it.milestone <= list.length) return it
          clamped++
          return { ...it, milestone: list.length }
        }),
      }))
      const plan: Plan = { ...cur, phases, milestones: list }
      return done(plan, [{ by, action, detail: tr('tools.m100', { p0: list.join(' → ') }) }],
        tr('tools.m101', { p0: list.join(' → '), p1: clamped ? tr('tools.m102', { p0: clamped }) : '' }))
    }
    if (action === 'set') {
      if (typeof input['auto_done_on_merge'] !== 'boolean') return { error: tr('tools.m103') }
      const settingsPath = `${ctx.paths.planDir(id)}/settings.json`
      const settings = parseJson<Record<string, unknown>>(await ctx.io.read(settingsPath))
      const plan = { ...cur, auto_done_on_merge: input['auto_done_on_merge'] }
      if (settings) {
        await guard(); await ctx.io.writeAtomic(settingsPath, JSON.stringify({ ...settings, autoDone: input['auto_done_on_merge'] }))
        delete (plan as Plan).auto_done_on_merge
      }
      return done(plan, [{ by, action, detail: tr('tools.m104', { p0: input['auto_done_on_merge'] ? tr('tools.m105') : tr('tools.m106') }) }], tr('tools.m107'))
    }
    if (action === 'set_item') {
      const refs = input['refs'] === undefined ? undefined : parseRefs(input['refs'])
      if (refs && 'error' in refs) return refs
      const hit = findItem(cur, str(input['item']), str(input['phase']))
      if (refs && !hit) return { error: tr('tools.m108') }
      const withRefs = (p: Plan): Plan => !refs || !hit ? p : { ...p, phases: p.phases.map(ph => ({ ...ph, items: ph.items.map(i => i.id === hit.item.id ? { ...i, refs: mergeRefs(i.refs, refs.refs), ...((refs.refs.branch?.length ?? 0) > 0 ? { branchAddedAt: { ...i.branchAddedAt, ...Object.fromEntries(refs.refs.branch!.map(b => [b, i.branchAddedAt?.[b] ?? now])) } } : {}), updatedAt: now } : i) })) }
      const refsOnly = refs && hit && input['status'] === undefined && input['milestone'] === undefined && input['exception'] === undefined && input['done_at'] === undefined
      if (refsOnly) return done(withRefs(cur), [{ by, action: 'refs', detail: tr('tools.m109', { p0: hit.item.title }) }], tr('tools.m110'))
      let status = str(input['status'])
      const milestoneIn = typeof input['milestone'] === 'number' ? input['milestone'] : undefined
      // A milestone-only update may leave the status out: it stays what it is.
      if (!status && milestoneIn !== undefined) {
        const hit = findItem(cur, str(input['item']), str(input['phase']))
        if (!hit) return { error: tr('tools.m111', { p0: str(input['item']) ?? '' }) }
        status = hit.item.status
      }
      if (status !== 'todo' && status !== 'wrapping' && status !== 'done' && status !== 'void') return { error: tr('tools.m112') }
      const exception = typeof input['exception'] === 'string' ? (input['exception'] as string) : undefined
      const at = parsePastTime(input['done_at'], now)
      if ('error' in at) return { error: at.error }
      const r = changeItem(cur, str(input['phase']), str(input['item']) ?? '', {
        status, ...(reason ? { reason } : {}), ...(exception !== undefined ? { exception } : {}),
        ...(at.at !== undefined ? { doneAt: at.at } : {}), ...(milestoneIn !== undefined ? { milestone: milestoneIn } : {}),
        meetsCriteria: input['meets_criteria'] === true,
      }, now)
      if ('error' in r) return r
      const finished = cur.status !== 'done' && r.plan.status === 'done'
      if (status === 'done' || status === 'void') releaseItem = r.itemId
      const notes = [r.detail]
      if (finished) notes.push(tr('tools.m113'))
      return done(withRefs(r.plan), [{ by, action: r.isRevert ? 'revert' : action, detail: r.detail, status, ...(hit ? { previousStatus: hit.item.status } : {}), ...(reason ? { reason } : {}), ...(r.isBackfill ? { isBackfill: true } : {}) },
        ...(finished ? [{ by, action: 'complete', detail: tr('tools.m114') }] : [])], tr('tools.sentence', { text: displayList(notes) }))
    }
    if (action === 'abandon') {
      if (!reason) return { error: tr('tools.m115') }
      return done({ ...cur, status: 'abandoned', endReason: reason }, [{ by, action, detail: tr('tools.m116'), reason }], tr('tools.m117', { p0: id }))
    }
    return { error: tr('tools.m118', { p0: action }) }
  }).catch((err: unknown) => ({ error: String(err instanceof Error ? err.message : err) }))

  if ('error' in res) return { text: res.error, isError: true }
  if (releaseItem) {
    const before = ctx.self.claims.length
    ctx.self.claims = ctx.self.claims.filter(c => !(c.plan === id && c.item === releaseItem))
    const released = before - ctx.self.claims.length
    if (released > 0) message += tr('tools.m119', { p0: released })
  }
  if (res.plan.status === 'active') ctx.self.lastPlan = res.plan.id
  if (isSpent && verdict.ok && verdict.spend) verdict.spend.usedAt = ctx.now
  await ctx.touchRepos(res.plan).catch(() => undefined)
  return { text: message }
}

/** `/progress accept|reject [plan] [reason…]`: the first word is a plan when it names a pending draft. */
export function parseDecisionArgs(rest: readonly string[], draftIds: readonly string[]): { plan?: string; reason?: string } {
  const [first, ...more] = rest
  if (first && draftIds.includes(first)) return { plan: first, ...(more.length ? { reason: more.join(' ') } : {}) }
  return rest.length ? { reason: rest.join(' ') } : {}
}
