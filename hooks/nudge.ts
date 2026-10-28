import { t as tr } from './i18n'
// Spec §13: a forced one-time stop to record the goal, and the provisional goal taken from the person's last request.

import { clip, strWidth } from './util'

export const AUTO_GOAL_CELLS = 20
export const autoMark = () => tr('nudge.m001')
/* Progress tracking invariant. */
export const AUTO_GOAL_MIN_CELLS = 6
/** The main loop's non-progress-board call (counted over the whole session) that is stopped when there is still no goal. */
export const ENFORCE_AT = 4
export const ENFORCE_DENY = "progress-board: this is a multi-step task. First call progress_session to set this session's goal and list its steps, then retry this step."

/** Whether the call just counted (`calls`, this one included) is the one to stop: once per session, never with a goal. */
export function shouldEnforce(s: { calls?: number; goal?: string; enforcedAt?: number; usedToolAt?: number }, enabled: boolean): boolean {
  return enabled && !s.goal?.trim() && s.enforcedAt === undefined && s.usedToolAt === undefined && (s.calls ?? 0) >= ENFORCE_AT
}

/** The engine's origins that mean the person wrote this prompt (typing at the prompt, or the Remote Control bridge). */
const OWN_ORIGINS = new Set(['composer', 'bridge'])

export type PromptLike = {
  text: string
  command?: unknown
  isMeta?: boolean
  /** Where the prompt came from (the engine's PromptOrigin); absent when it cannot be told. */
  origin?: { kind?: unknown }
}

/** Whether the person wrote this prompt: not a command, not meta, and (when known) an origin of their own. */
export function isOwnPrompt(e: PromptLike): boolean {
  if (e.command || e.isMeta) return false
  if (!e.text.trim()) return false
  const kind = e.origin?.kind
  return typeof kind !== 'string' || OWN_ORIGINS.has(kind)
}

/**
 * The first non-blank line worth keeping as a request: a command, a meta prompt, a notice (`<…>`),
 * a first line too short to name work, or a text a tool injected (not the person's own origin) has none.
 */
export function requestLineOf(e: PromptLike): string | undefined {
  if (!isOwnPrompt(e)) return undefined
  const text = e.text.trim()
  if (text.startsWith('/') || text.startsWith('<')) return undefined
  const line = text.split('\n').map(x => x.trim()).find(Boolean)
  if (!line || strWidth(line) <= AUTO_GOAL_MIN_CELLS) return undefined
  return line.slice(0, 200)
}

/** The provisional goal a submitted prompt gives: its first non-blank line, unless it names no work. */
export function autoGoalOf(e: PromptLike): string | undefined {
  return requestLineOf(e)
}

/** The same line, for `firstMessage` (a short or injected message names no work either). */
export function firstMessageOf(e: PromptLike): string | undefined {
  return requestLineOf(e)
}

/** About 20 display cells, … when cut. */
export function autoGoalLabel(text: string): string {
  return clip(text.trim(), AUTO_GOAL_CELLS)
}

/** Main-loop calls without a progress_session report before the first step reminder; it doubles each time it goes unheeded. */
export const STEP_NUDGE_AT = 3

type StepState = { steps: { title: string; status: string }[]; stepsSource?: string; sinceReport?: number; stepNudges?: number }

/** The reminder to attach to this call's result, or undefined. Counts the reminder as given. */
export function takeStepNudge(s: StepState, threshold = STEP_NUDGE_AT): string | undefined {
  if (s.stepsSource !== 'tool') return undefined
  const open = s.steps.filter(x => x.status !== 'done')
  if (open.length === 0) return undefined
  const n = s.stepNudges ?? 0
  const since = s.sinceReport ?? 0
  if (since < threshold * 2 ** n) return undefined
  s.stepNudges = n + 1
  s.sinceReport = 0
  const doing = open.filter(x => x.status === 'doing').map(x => `“${x.title}”`)
  const where = doing.length ? `Currently marked doing: ${new Intl.ListFormat('en', { type: 'conjunction' }).format(doing)}` : `Next step is “${open[0]?.title ?? ''}”`
  return `progress-board: ${since} operations without updating this session's progress (${where}). If a step finished or the current step changed, call progress_session step_updates (done for finished; doing for current); ignore if nothing changed.`
}
