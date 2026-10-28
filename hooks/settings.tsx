import type { EngineInterface, ElementTable, RenderElement } from 'claude-code'
import type { Plan, PanelUi } from '../types'
import { costHelp, tokenFeatures, tokenMark } from './ui-costs'
import { bundledCodes, language, t } from './i18n'
import { parseJson, readPlan, withLock } from './store'
import type { Io, Paths } from './store'

import type { BoardSettings as Settings, PlanSettings } from '../types'
export type { BoardSettings as Settings, PlanSettings } from '../types'
export const choices: { [K in keyof Settings]: readonly Settings[K][] } = {
  barGlyph: ['■', '█', '▅'], enforceGoal: [true, false], stepReminder: [3, 5, 8], awayMinutes: [15, 30, 60],
  monitor: [true, false], monitorMinutes: [5, 10, 15, 30], autoDone: [false, true], retention: [6, 24, 72],
  contextWarning: [70, 80, 90], notifications: ['off', 'toast', 'sound'],
}
export const defaults: Settings = { barGlyph: '■', enforceGoal: true, stepReminder: 3, awayMinutes: 30, monitor: true, monitorMinutes: 15, autoDone: false, retention: 24, contextWarning: 80, notifications: 'off' }
export function initialSettings(options: Record<string, unknown>): Settings {
  const chosen = Object.fromEntries((Object.keys(choices) as (keyof Settings)[]).filter(key => (choices[key] as readonly unknown[]).includes(options[key])).map(key => [key, options[key]]))
  return { ...defaults, ...chosen, barGlyph: choices.barGlyph.includes(String(options.barGlyph)) ? String(options.barGlyph) : defaults.barGlyph,
    enforceGoal: options.enforceGoal !== false, monitor: options.monitor !== false,
    monitorMinutes: typeof options.monitorMinutes === 'number' && Number.isFinite(options.monitorMinutes) ? Math.min(2_147_483_647 / 60_000, Math.max(5, options.monitorMinutes)) : 15 }
}
export async function readSettings($: EngineInterface, initial: Settings): Promise<Settings> {
  const entries = await Promise.all((Object.keys(choices) as (keyof Settings)[]).map(async key => {
    const value = await $.store.get(`settings.${key}`)
    return [key, (choices[key] as readonly unknown[]).includes(value) ? value : initial[key]] as const
  }))
  return Object.fromEntries(entries) as Settings
}
export async function writeSetting<K extends keyof Settings>($: EngineInterface, key: K, value: Settings[K]): Promise<void> {
  if (!(choices[key] as readonly unknown[]).includes(value)) throw new Error(t('settings.invalidChoice'))
  await $.store.set(`settings.${key}`, value)
}
export async function writePlanSetting(io: Io, paths: Paths, id: string, key: keyof PlanSettings, value: PlanSettings[keyof PlanSettings]): Promise<void> {
  if (value !== undefined && !(choices[key] as readonly unknown[]).includes(value)) throw new Error(t('settings.invalidChoice'))
  await withLock(io, paths.planDir(id), async guard => {
    const plan = await readPlan(io, paths, id)
    if (!plan) throw new Error(t('common.noPlan'))
    const current = await readPlanSettings(io, paths, id)
    if (value === undefined) delete current[key]
    else Object.assign(current, { [key]: value })
    await guard(); await io.writeAtomic(`${paths.planDir(id)}/settings.json`, JSON.stringify(current))
    if (key === 'autoDone' && plan.auto_done_on_merge !== undefined) {
      delete plan.auto_done_on_merge
      await guard(); await io.writeAtomic(paths.planJson(id), JSON.stringify(plan))
    }
  })
}
export async function cycleSetting($: EngineInterface, key: keyof Settings, settings: Settings): Promise<void> {
  const values = choices[key] as readonly unknown[], old = await $.store.get(`settings.${key}`)
  const index = values.indexOf(values.includes(old) ? old : settings[key])
  await $.store.set(`settings.${key}`, values[(index + 1) % values.length])
}
export async function readPlanSettings(io: Io, paths: Paths, id: string): Promise<PlanSettings> {
  const raw = parseJson<Record<string, unknown>>(await io.read(`${paths.planDir(id)}/settings.json`)) ?? {}
  const legacy = await readPlan(io, paths, id)
  const result: PlanSettings = typeof legacy?.auto_done_on_merge === 'boolean' ? { autoDone: legacy.auto_done_on_merge } : {}
  for (const key of ['monitor', 'monitorMinutes', 'autoDone'] as const) if ((choices[key] as readonly unknown[]).includes(raw[key])) Object.assign(result, { [key]: raw[key] })
  return result
}
export function effectiveSettings(settings: Settings, plan: Plan, override: PlanSettings): Settings {
  return { ...settings, ...(typeof plan.auto_done_on_merge === 'boolean' ? { autoDone: plan.auto_done_on_merge } : {}), ...override }
}
export async function cyclePlanSetting(io: Io, paths: Paths, id: string, key: keyof PlanSettings): Promise<void> {
  await withLock(io, paths.planDir(id), async guard => {
    const plan = await readPlan(io, paths, id)
    if (!plan) throw new Error(t('common.noPlan'))
    const current = await readPlanSettings(io, paths, id)
    const values: readonly unknown[] = key === 'monitorMinutes' ? [undefined, 5, 10, 15, 30] : [undefined, true, false]
    const value = values[(values.indexOf(current[key]) + 1) % values.length]
    if (value === undefined) delete current[key]
    else Object.assign(current, { [key]: value })
    await guard(); await io.writeAtomic(`${paths.planDir(id)}/settings.json`, JSON.stringify(current))
    if (key === 'autoDone' && plan.auto_done_on_merge !== undefined) {
      delete plan.auto_done_on_merge
      await guard(); await io.writeAtomic(paths.planJson(id), JSON.stringify(plan))
    }
  })
}
function valueLabel(key: keyof Settings, value: unknown): string {
  if (typeof value === 'boolean') return t(value ? 'common.on' : 'common.off')
  if (key === 'monitorMinutes' || key === 'awayMinutes') return t('common.minutes', { n: value })
  if (key === 'retention') return t('common.hours', { n: value })
  if (key === 'stepReminder') return t('common.calls', { n: value })
  if (key === 'contextWarning') return `${value}%`
  if (key === 'notifications') return t(value === 'off' ? 'common.off' : `settings.${value}`)
  return String(value)
}
export type SettingsActions = {
  setting: (key: keyof Settings) => void
  planSetting: (key: keyof PlanSettings) => void
  chooseSetting?: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  choosePlanSetting?: (key: keyof PlanSettings, value: PlanSettings[keyof PlanSettings]) => void
  select?: (key: string) => void
  language: (code: string | null) => void
  otherLanguage: () => void
  retranslate: () => void
}
export function renderSettings(els: Pick<ElementTable, 'Box' | 'Text' | 'Button'>, settings: Settings, plan: Plan | null, overrides: PlanSettings, act: SettingsActions, ui?: PanelUi): RenderElement {
  const { Box, Text, Button } = els
  const selected = ui?.selectedSetting
  const help = (id: string, key: string, extra?: string) => selected === id ? <Text key={`setting-help-${id}`} dimColor wrap="wrap">{t(`settings.help.${key}`)}{extra ? ` ${extra}` : ''}</Text> : ''
  const row = (key: keyof Settings, scope: 'global' | 'plan') => {
    const id = scope === 'plan' ? `plan-${key}` : key
    const current = scope === 'plan' ? overrides[key as keyof PlanSettings] : settings[key]
    const candidates: readonly unknown[] = scope === 'plan' ? [undefined, ...choices[key]] : choices[key]
    const values: readonly unknown[] = candidates.includes(current) ? candidates : [...candidates, current]
    const paid = key === 'monitor' || key === 'monitorMinutes'
    return <Box key={`setting-group-${id}`} flexDirection="column">
      <Box key={`setting-row-${id}`} flexDirection="row" flexWrap="wrap" gap={1} rowGap={0}>
        <Button key={scope === 'plan' ? `plan-setting-${key}` : `setting-${key}`} plain onPress={() => act.select?.(id)}><Text>{t(`settings.${key}`)}</Text>{paid ? tokenMark(els) : ''}</Button>
        {values.map((value, index) => <Box key={`setting-choice-${id}-${index}`} flexDirection="row" gap={1}>
          {index ? <Text dimColor>·</Text> : ''}
          <Button key={`${scope === 'plan' ? 'plan-setting' : 'setting'}-${key}-${index}`} plain onPress={() => {
            act.select?.(id)
            if (value === current) return
            if (scope === 'plan') act.choosePlanSetting?.(key as keyof PlanSettings, value as PlanSettings[keyof PlanSettings])
            else act.chooseSetting?.(key, value as Settings[typeof key])
          }}><Text color={value === current ? 'claude' : undefined} weight={value === current ? 'bold' : 'regular'} dimColor={value !== current}>{value === current ? '[' : ''}{value === undefined ? t('common.inherit') : valueLabel(key, value)}{value === current ? ']' : ''}</Text></Button>
        </Box>)}
      </Box>
      {help(id, key, paid ? costHelp('monitor', scope === 'plan' && plan ? effectiveSettings(settings, plan, overrides).monitorMinutes : settings.monitorMinutes) : undefined)}
    </Box>
  }
  const customLanguage = !bundledCodes.some(code => code === language() || code === language().split('-')[0])
  return <Box flexDirection="column">
    <Box key="cost-overview" flexDirection="column">
      <Text weight="bold" color="claude">{t('cost.title')}</Text>
      {tokenFeatures.map(feature => <Text key={`cost-feature-${feature}`} wrap="wrap">{tokenMark(els)} {t(`cost.${feature}`)}: <Text color="claude">{t((feature === 'monitor' ? (plan ? effectiveSettings(settings, plan, overrides).monitor : settings.monitor) : feature === 'translation' ? customLanguage : true) ? 'common.on' : 'common.off')}</Text>{feature !== 'monitor' && feature !== 'translation' ? ` (${t('cost.onDemand')})` : ''}</Text>)}
      <Text dimColor wrap="wrap">{t('cost.budget')}</Text>
    </Box>
    <Text weight="bold" color="claude">{t('settings.global')}</Text>
    {(Object.keys(choices) as (keyof Settings)[]).map(key => row(key, 'global'))}
    <Box key="setting-row-language" flexDirection="row" flexWrap="wrap" gap={1} rowGap={0}>
      <Button key="setting-language" plain onPress={() => act.select?.('language')}><Text>{t('settings.language')}</Text>{tokenMark(els)}</Button>
      <Button key="language-follow" plain onPress={() => { act.select?.('language'); act.language(null) }}><Text color={ui?.settingLanguage === null ? 'claude' : undefined} weight={ui?.settingLanguage === null ? 'bold' : 'regular'} dimColor={ui?.settingLanguage !== null}>{ui?.settingLanguage === null ? '[' : ''}{t('settings.followLanguage')}{ui?.settingLanguage === null ? ']' : ''}</Text></Button>
      {bundledCodes.map(code => {
        const current = ui?.settingLanguage !== null && (code === language() || code === language().split('-')[0])
        return <Button key={`language-${code}`} plain onPress={() => { act.select?.('language'); act.language(code) }}><Text color={current ? 'claude' : undefined} weight={current ? 'bold' : 'regular'} dimColor={!current}>{current ? '[' : ''}{t(`language.${code}`)}{current ? ']' : ''}</Text></Button>
      })}
      {customLanguage ? <Text color="claude" weight="bold">[{language()}]</Text> : ''}
      <Button key="language-other" plain onPress={() => { act.select?.('language'); act.otherLanguage() }}><Text dimColor>{t('settings.otherLanguage')}</Text>{tokenMark(els)}</Button>
      {customLanguage ? <Button key="language-retranslate" plain onPress={act.retranslate}><Text dimColor>{t('settings.retranslate')}</Text>{tokenMark(els)}</Button> : ''}
    </Box>
    {help('language', 'language', costHelp('translation'))}
    {plan ? <Box flexDirection="column">
      <Text weight="bold" color="claude">{t('settings.plan', { id: plan.id })}</Text>
      {(['monitor', 'monitorMinutes', 'autoDone'] as const).map(key => row(key, 'plan'))}
    </Box> : <Text dimColor>{t('common.noPlan')}</Text>}
  </Box>
}
