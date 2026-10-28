import { expect, enTest as test } from './locale-test'
import { world, seedPlan } from './world'
import { plan, PLAN, planDir, seedSession, session, claim, NOW } from './v03-fixtures'
import { recordEvent } from '../hooks/freshness'

test('V04 activity retains more than the old thirty-event ring while expiring seven-day history', async () => {
  const s = session({ events: [{ kind: 'bash', text: 'old', at: NOW - 8 * 86400_000 }] })
  for (let n = 0; n < 45; n++) recordEvent(s, { kind: 'bash', text: `git push ${n}`, at: NOW + n }, [], [])
  expect(s.activityEvents?.length).toBe(45)
  expect(s.activityEvents?.some(e => e.text === 'old')).toBe(false)
  expect(s.events?.length).toBe(30)
})
const pane = { plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal', props: { title: 'Progress', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const

test('V04 activity pages forty rows reverse chronologically and filters completions and decisions', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()], decided: [{ text: 'Decision example', reversible: true, undo: 'revert', at: NOW - 200 }], events: [{ kind: 'bash', text: 'git push', at: NOW - 100 }] }))
  w.files.set(`${planDir}/log.jsonl`, { text: Array.from({ length: 45 }, (_, n) => JSON.stringify({ at: NOW - 1000 - n, by: 's1', plan: PLAN, action: 'set_item', detail: `Completion ${n}: todo → done` })).join('\n'), m: NOW })
  on('command.run', () => ({ text: '' })); await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-activity' }); await ui.press({ key: 'activity-filter-completion' })
  expect((await ui.findAll({ type: 'Box' })).filter(x => x.key?.startsWith('activity-row-')).length).toBe(40)
  const rows = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('\n')
  expect(rows.indexOf('Completion 0:')).toBeLessThan(rows.indexOf('Completion 1:'))
  await ui.press({ key: 'activity-more' })
  expect((await ui.findAll({ type: 'Box' })).filter(x => x.key?.startsWith('activity-row-')).length).toBe(45)
  await ui.press({ key: 'activity-filter-decision' })
  const decisions = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('\n')
  expect(decisions).toContain('Decision example'); expect(decisions).not.toContain('Completion 0:')
  await ui.unmount()
})

test('V04 activity excludes old and unrelated plan data and includes checks suggestions and lifecycle', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedPlan(w, '/h', plan({ id: 'unrelated/v1' }))
  seedSession(w, session({ claims: [claim()] })); seedSession(w, session({ id: 'ended', claims: [claim()], endedAt: NOW - 1000 }))
  w.files.set(`${planDir}/log.jsonl`, { text: JSON.stringify({ at: NOW - 8 * 86400_000, by: 's1', plan: PLAN, action: 'complete', detail: 'Too old' }), m: NOW })
  w.files.set('/h/.claude/progress-board/plans/unrelated%2Fv1/log.jsonl', { text: JSON.stringify({ at: NOW, by: 'stranger', action: 'complete', detail: 'Secret unrelated work' }), m: NOW })
  w.files.set(`${planDir}/checks.json`, { text: JSON.stringify({ pr: { lastCheckedAt: NOW - 500, state: 'merged' } }), m: NOW })
  w.files.set(`${planDir}/suggestions.json`, { text: JSON.stringify([{ id: 's1', state: 'rejected', item: 'p1-1', reason: 'not finished', resolvedAt: NOW - 400, resolvedBy: 's1', resolutionReason: 'Needs tests' }]), m: NOW })
  on('command.run', () => ({ text: '' })); await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-activity' })
  const text = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('\n')
  expect(text).toContain('Needs tests'); expect(text).toContain('merged'); expect(text).toContain('Session ended')
  expect(text).not.toContain('Too old'); expect(text).not.toContain('Secret unrelated work')
  await ui.unmount()
})

test('V04 activity shows priority deviations and controls without creating waiting blockers', async ($, on) => {
  const w = world(on); seedPlan(w, '/h', plan()); seedSession(w, session({ claims: [claim()], events: [{ kind: 'control', text: 'Compact requested', at: NOW - 1 }] }))
  w.files.set(`${planDir}/log.jsonl`, { text: JSON.stringify({ at: NOW - 10, by: 's1', plan: PLAN, action: 'explain_priority', detail: 'Dependency first' }), m: NOW })
  on('command.run', () => ({ text: '' })); await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(pane); await ui.press({ key: 'tab-activity' })
  const text = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('\n')
  expect(text).toContain('Dependency first'); expect(text).toContain('Compact requested')
  expect(text).not.toContain('Waiting for you')
  await ui.unmount()
})
