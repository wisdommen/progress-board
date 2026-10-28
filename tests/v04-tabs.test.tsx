import { expect, enTest as test } from './locale-test'
import { world } from './world'

const pane = (surface: 'terminal' | 'desktop') => ({
  plugin: 'progress-board', component: 'Pane', requestId: 'progress-board', surface,
  props: { title: 'Progress', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const)

test('V04 tabs expose five numbered choices and remember the selected tab', async ($, on) => {
  world(on)
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    for (const [index, tab] of ['progress', 'priorities', 'sessions', 'activity', 'settings'].entries()) {
      const button = await ui.find({ key: `tab-${tab}` })
      expect(button).toBeDefined()
      expect(button?.props.hotkey).toBe(String(index + 1))
    }
    await ui.press({ key: 'tab-settings' })
    await ui.unmount()
    const again = await $.ui.mount(pane(surface))
    expect((await again.find({ key: 'tab-settings' }))?.props.plain).toBe(true)
    await again.unmount()
  }
})

test('V05 tabs keep the legacy progress view with an old ui state but replace the switch-plan button', async ($, on) => {
  world(on)
  on('command.run', () => ({ text: '' }) as never)
  await $.command.run({ command: 'progress', args: '' } as never)
  const ui = await $.ui.mount(pane('terminal'))
  expect((await ui.find({ key: 'tab-progress' }))?.props.plain).toBe(true)
  expect(await ui.find({ key: 'pick' })).toBeUndefined()
  await ui.press({ key: 'tab-priorities' })
  expect((await ui.find({ key: 'tab-priorities' }))?.props.plain).toBe(true)
  expect(await ui.find({ key: 'pick' })).toBeUndefined()
  await ui.unmount()
})
