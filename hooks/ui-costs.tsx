import type { ElementTable, RenderElement } from 'claude-code'
import type { SessionView } from '../types'
import { t } from './i18n'

export function tokenMark({ Text }: Pick<ElementTable, 'Text'>): RenderElement {
  return <Text color="warning">$</Text>
}
export function idleComplete(s: SessionView): boolean {
  return !s.working && !s.question && s.steps.length > 0 && s.steps.every(step => step.status === 'done') && !s.bg.some(task => task.endedAt === undefined)
}
export function activeOwner(s: SessionView): boolean {
  return s.isAlive && s.endedAt === undefined && !idleComplete(s)
}
/** Model calls and turn-producing controls only; plain-text reports do not spend tokens. */
export const tokenFeatures = ['monitor', 'translation', 'reconcile', 'compact', 'dispatch', 'message'] as const
export const costHelp = (feature: typeof tokenFeatures[number], minutes = 15) => t(`cost.${feature}Help`, { minutes })
