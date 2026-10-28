import { expect, enTest as test } from './locale-test'
import { world } from './world'
import { session, seedSession, savedSession } from './v03-fixtures'
import { renderPanel } from '../hooks/panel'
import { setLocale, t } from '../hooks/i18n'
import { strWidth } from '../hooks/util'
import { CONTROL_PREFIX } from '../hooks/controls'
import type { PanelUi, Snapshot } from '../types'

// 本机 2.1.311 的返回形状：自身只在 listing 首部，其他会话行没有 UUID。
const nativeResult = (rows = [{ name: 'pb-demo-42', ref: 'ffd518', type: 'local', status: 'idle' }]) => ({
  result: {
    listing: 'This session is sender-4b [812c02] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).\n\nOther Claude sessions',
    sections: [{ kind: 'sessions', total: rows.length, rows }], notes: [],
  },
})

test('V06b session start captures its own native name and ref, never a peer row', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => e.tool === 'ListAgents' ? nativeResult() : { result: {} })
  await $.session.start({ sessionId: 's1', cwd: '/w/acme', isInteractive: true, isResume: false } as never)
  const saved = savedSession(w) as any
  expect(saved.nativeName).toBe('sender-4b'); expect(saved.ref).toBe('812c02')
  expect(saved.calls ?? 0).toBe(0)
})

test('V06b missing self name is retried lazily after a session becomes addressable', async ($, on) => {
  const w = world(on); let ready = false
  on('command.run', () => ({ text: '' }))
  on('tool.call', (_, e) => e.tool === 'ListAgents' ? ready ? nativeResult() : { result: { listing: 'No reachable agents.', sections: [], notes: [] } } : { result: {} })
  await $.command.run({ command: 'progress', args: '' } as never)
  expect((savedSession(w) as any).nativeName).toBeUndefined()
  ready = true
  await $.tool.call({ tool: 'mcp__progress-board__progress_session', goal: 'Lazy self name capture' } as never)
  expect((savedSession(w) as any).nativeName).toBe('sender-4b')
  expect((savedSession(w) as any).ref).toBe('812c02')
})

async function request($: any, on: any, known = true, duplicate = false) {
  const w = world(on), fills: string[] = []
  seedSession(w, session())
  seedSession(w, session({ id: 'target-session-uuid', title: 'Target', goal: 'Target', controlVersion: 1, ...(known ? { nativeName: 'pb-demo-42', ref: 'ffd518' } : {}) } as any))
  on('command.run', () => ({ text: '' }))
  on('prompt.fill', (_: unknown, e: any) => { fills.push(e.text); return { isFilled: true } })
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('tool.call', (_: unknown, e: any) => e.tool === 'ListAgents' ? nativeResult([
    { name: 'pb-demo-42', ref: 'ffd518', type: 'local', status: 'idle' },
    { name: duplicate ? 'pb-demo-42' : 'pb-demo-02', ref: '33aa11', type: 'local', status: 'idle' },
  ]) : { result: {} })
  await $.command.run({ command: 'progress', args: 'send Target: Exact person message' })
  const prompt = fills.at(-1)!, intent_id = /intent_id=([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
  await $.prompt.submit({ text: prompt, origin: { kind: 'composer' }, wait: false })
  const control = (extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'mcp__progress-board__progress_control', action: 'message', target_session: 'target-session-uuid', intent_id, text: 'Exact person message', ...extra })
  return { w, control }
}

test('V06b UUID resolves only through the target self-registered name, not a similar peer name', async ($, on) => {
  const f = await request($, on)
  const output = String((await f.control()).result)
  expect(output).toContain('to="pb-demo-42"')
  expect(output).toContain(CONTROL_PREFIX)
  expect(savedSession(f.w).pendingControls?.[0]?.address).toBe('pb-demo-42')
})

test('V06b duplicate native names require the target stored ref suffix', async ($, on) => {
  const f = await request($, on, true, true)
  const output = String((await f.control()).result)
  expect(output).toContain('to="pb-demo-42 [ffd518]"')
  expect(savedSession(f.w).pendingControls?.[0]?.address).toBe('pb-demo-42 [ffd518]')
})

test('V06b missing native name spends the intent, explains a new button request and never accepts guessed target_name', async ($, on) => {
  const f = await request($, on, false)
  const output = String((await f.control({ target_name: 'pb-demo-42' })).result)
  expect(output).not.toContain(CONTROL_PREFIX)
  expect(output).toContain('now spent')
  expect(output).toContain('Any further prompt')
  expect(output).toContain('press the panel button')
  expect(output).not.toContain('reply yes')
  expect(output).not.toContain('retry this unspent intent')
  expect(savedSession(f.w).controlIntents?.[0]?.usedAt).toBeDefined()
  expect(savedSession(f.w).pendingControls?.length ?? 0).toBe(0)
  await $.prompt.submit({ text: '是', origin: { kind: 'composer' }, wait: false } as never)
  expect(String((await f.control()).result)).not.toContain(CONTROL_PREFIX)
})

const els = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: any) => ({ type, props })])) as any
const kids = (n: any): any[] => [n?.props?.children].flat(Infinity).filter(Boolean)
const text = (n: any): string => typeof n === 'string' || typeof n === 'number' ? String(n) : kids(n).map(text).join('')
const noop = () => {}
for (const cols of [37, 80]) test(`V06b ${cols}-column Chinese tabs keep complete hotkey-label pairs and label-aligned underlines`, () => {
  setLocale('zh-CN')
  const state: PanelUi = { expanded: [], showReview: false, selectedReview: null, showRelated: false, showEnded: false, pick: null }
  const snap: Snapshot = { now: 1800000000000, selfId: 's1', focusPlan: null, repoPlans: [], plans: [], sessions: [], recent: [], waiting: [] }
  const selected: string[] = []
  const tree = renderPanel(els, snap, state, cols, '■', { accept: noop, reject: noop, edit: noop, toggleReview: noop, selectReview: noop, undo: noop, refresh: noop, pickNext: noop, togglePhase: noop, toggleExpand: noop, toggleRelated: noop, toggleEnded: noop, dismissAway: noop, selectTab: name => selected.push(name) }) as any
  const line = kids(tree)[0], columns = kids(line)
  expect(line.props.flexWrap).toBe('wrap')
  let occupied = (columns.length - 1) * line.props.gap
  for (const [index, name] of ['progress', 'priorities', 'sessions', 'activity', 'settings'].entries()) {
    const column = columns[index], [button, underline] = kids(column), width = strWidth(t(`tabs.${name}`))
    expect(column.props.width).toBe(width + 3)
    expect(column.props.flexShrink).toBe(0)
    expect(button.props.hotkey).toBe(String(index + 1))
    expect(text(underline)).toBe('   ' + (index === 0 ? '━' : ' ').repeat(width))
    button.props.onPress(); expect(selected.at(-1)).toBe(name)
    occupied += column.props.width
  }
  expect(occupied <= cols).toBe(true)
})
