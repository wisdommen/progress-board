// Issue #1: the /progress pane must never come out blank without a reason on screen.
import { expect, enTest as test } from './locale-test'
import { world } from './world'

const PANE = {
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface: 'terminal',
  props: { title: 'progress', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const paneText = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

test('V066 a headless flag left in state does not blank an interactive session', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }))
  // The flag outlives the module (a reload, a restart): it reads true until this session writes it.
  let stale: boolean | undefined = true
  on('state.get', async (_, e, next) => {
    const actual = await next(e)
    return (e as { key: string }).key === 'isHeadless' && stale !== undefined ? { value: { ...actual.value, value: stale } } : actual
  })
  on('state.set', async (_, e, next) => {
    const ev = e as { key?: string; ref?: { key: string } }
    if ((ev.key ?? ev.ref?.key) === 'isHeadless') stale = undefined
    return next(e)
  })
  await $.session.start({ sessionId: 's1', cwd: '/w', isInteractive: true, isResume: false } as never)
  await w.clock.settle()
  const ui = await $.ui.mount(PANE)
  await w.clock.settle()
  const text = await paneText(ui)
  expect(text.trim()).not.toBe('')
  expect(text).not.toContain('headless session')
  await ui.unmount()
})

test('V066 a headless session draws a visible reason instead of nothing', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }))
  await $.session.start({ sessionId: 's1', cwd: '/w', isInteractive: false, isResume: false } as never)
  await w.clock.settle()
  const ui = await $.ui.mount(PANE)
  await w.clock.settle()
  expect(await paneText(ui)).toContain('progress-board is inactive in this session')
  await ui.unmount()
})

test('V066 a failure while drawing shows the error on screen', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }))
  on('state.get', async (_, e, next) => {
    const actual = await next(e)
    // A snapshot the panel cannot draw: plans missing.
    return (e as { key: string }).key === 'snapshot' ? { value: { ...actual.value, value: { now: 1, selfId: 's1', focusPlan: null } } } : actual
  })
  await $.session.start({ sessionId: 's1', cwd: '/w', isInteractive: true, isResume: false } as never)
  await w.clock.settle()
  const ui = await $.ui.mount(PANE)
  await w.clock.settle()
  expect(await paneText(ui)).toContain('progress-board could not draw this panel')
  await ui.unmount()
})
