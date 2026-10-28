// 0.6.1, from a fresh-user test: the host's install form showed the five number options with a blank
// value, so each title now carries its default. This file reads the shipped manifest; the mod's own
// test runner has no file system, so it runs under `node --test` like i18n-source.test.cjs.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

const manifest = () => JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'))

test('every number option names its default in the title', () => {
  const config = manifest().userConfig
  const numbers = Object.entries(config).filter(([, option]) => option.type === 'number')
  assert.deepEqual(numbers.map(([key]) => key), ['stepReminder', 'awayMinutes', 'retention', 'contextWarning', 'monitorMinutes'])
  for (const [key, option] of numbers) assert.match(option.title, new RegExp(`\\(default ${option.default}\\)$`), key)
})

test('number option keys, types and defaults are unchanged', () => {
  const config = manifest().userConfig
  const defaults = Object.fromEntries(Object.entries(config).map(([key, option]) => [key, [option.type, option.default]]))
  assert.deepEqual(defaults, {
    stepReminder: ['number', 3],
    awayMinutes: ['number', 30],
    autoDone: ['boolean', false],
    retention: ['number', 24],
    contextWarning: ['number', 80],
    notifications: ['string', 'off'],
    monitor: ['boolean', true],
    monitorMinutes: ['number', 15],
    barGlyph: ['string', '■'],
    enforceGoal: ['boolean', true],
  })
})
