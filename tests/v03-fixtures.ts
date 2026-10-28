import type { Plan, SessionRec } from '../types'
import { newPlan } from '../hooks/model'
import type { World } from './world'

export const NOW = 1_800_000_000_000
export const ROOT = '/h/.claude/progress-board'
export const PLAN = 'acme/v3'
export const planDir = `${ROOT}/plans/acme%2Fv3`
export const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: '进度', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
export function plan(over: Partial<Plan> = {}): Plan {
  return { ...newPlan({ id: PLAN, goal: '实现功能', criteria: '全部验证通过', phases: [{ name: '开发', items: ['实现登录验证', '完善错误处理', '文档'] }], includeRelease: false, by: 's1', now: NOW }), status: 'active', ...over }
}
export function session(over: Partial<SessionRec> = {}): SessionRec {
  return { v: 1, id: 's1', kind: 'normal', startedAt: NOW, cwd: '/w/acme', goal: '实现功能', steps: [], claims: [], bg: [], dispatched: 0, agentsDone: 0,
    approvals: [], messages: [], lastActivity: NOW, lastUserInput: NOW, limits: [], ...over }
}
export function seedSession(w: World, s: SessionRec): void {
  w.dirs.add(`${ROOT}/sessions`)
  w.files.set(`${ROOT}/sessions/${s.id}.json`, { text: JSON.stringify(s), m: w.clock.now() })
}
export function savedSession(w: World, id = 's1'): SessionRec {
  return JSON.parse(w.files.get(`${ROOT}/sessions/${id}.json`)?.text ?? '{}') as SessionRec
}
export function savedPlan(w: World): Plan {
  return JSON.parse(w.files.get(`${planDir}/plan.json`)?.text ?? '{}') as Plan
}
export const claim = (item = 'p1-1') => ({ plan: PLAN, phase: 'p1', item, at: NOW, source: 'claim' as const })
