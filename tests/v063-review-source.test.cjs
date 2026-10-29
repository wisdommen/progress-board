const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const root = path.resolve(__dirname, '..')
const source = file => fs.readFileSync(path.join(root, file), 'utf8')

test('V063 review editedPlans 保留英文契约并说明独立的 itemAt', () => {
  const text = source('types/index.d.ts')
  assert.match(text, /Plans the person accepted here or the model changed an item of here/)
  assert.match(text, /itemAt\?: number/)
  assert.match(text, /at\?: number/)
})

test('V063 review notePlanEdit 注释准确限定接受和主循环状态更新', () => {
  const text = source('hooks/register.tsx')
  assert.match(text, /\/\*\*[^*]*accepted[^*]*main-loop[^*]*status[^*]*\*\/\s*function notePlanEdit/)
})

test('V063 review v0.6.3 文档保留达到投递上限仍计数的已知限制', () => {
  const section = source('IMPLEMENTATION-NOTES.md').split('## v0.6.3')[1]
  assert.ok(section)
  assert.match(section, /已知限制[^\n]*投递上限[^\n]*计数/)
})
