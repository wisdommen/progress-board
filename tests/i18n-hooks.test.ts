import { enTest as test, expect } from './locale-test'
import { world } from './world'

test('i18n hook initialization defaults to English and injects a fixed English language directive', async ($, on) => {
  world(on)
  on('command.run', () => ({ text: '' }) as never)
  on('prompt.compose', () => ({ sections: [] }) as never)
  const answer = await $.command.run({ command: 'progress', args: '' } as never)
  expect(answer.text).toBe('Progress panel opened.')
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  const text = composed.sections.map(s => s.text).join('\n')
  expect(text).toContain("person's language: English")
  expect(text).toContain('Use progress_session')
})
