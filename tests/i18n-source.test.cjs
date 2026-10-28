const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
// Decode source escapes before scanning: escaping a UI literal must not bypass this check.
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u
const decodeEscapes = text => text.replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gi, (_, long, short) => String.fromCodePoint(parseInt(long || short, 16)))
// Only whole-line comments are exempt: trailing executable code must still be scanned.
const commentOnly = line => /^\s*\/\/.*$/.test(line) || /^\s*\/\*(?:(?!\*\/).)*\*\/\s*$/.test(line)
const hasUiLiteral = line => !commentOnly(line) && cjk.test(decodeEscapes(line))
// Exact non-UI parser expressions and language-name lookup rows, never file/line-wide exemptions.
const nonUi = new Map()
const allow = (file, lines) => nonUi.set(file, new Set(lines))
allow("attrib.ts", ["const m = /^\\s*(?:[-*>]\\s*)?(?:\\*\\*)?(?:plan|\\u8ba1\\u5212|PROGRESS_BOARD_PLAN)(?:\\*\\*)?\\s*[:\uff1a=]\\s*`?([A-Za-z0-9_.\\-]+\\/[A-Za-z0-9_.\\-]+?)`?[\u3002.,\uff0c;\uff1b]?\\s*$/im.exec(text)", "return !!s.role && /\\u5ba1\\u67e5|\\u8bc4\\u5ba1|review/i.test(s.role)"])
allow("model.ts", ["const isRelease = (name: string) => [RELEASE_PHASE, tr('model.m001'), '\\u6536\\u53e3 / \\u53d1\\u5e03', ...Object.values(bundled).map(c => c['model.m001'])].includes(name)", "const NO = /\\u4e0d|\\u5426|\\u522b|\\u62d2|\\u653e\\u5f03|\\u53d6\\u6d88|\\u6682\\u7f13|\\u63a8\\u8fdf|\\u9a73\\u56de|\\u5148\\u7b49|\\bno\\b|\\bnot\\b|n't|\\bnope\\b|reject|decline|cancel|later|wait|hold/i", "const YES = /\\u91c7\\u7eb3|\\u540c\\u610f|\\u6279\\u51c6|\\u786e\\u8ba4|\\u5f00\\u59cb|\\u53ef\\u4ee5|\\u597d|\\u884c|\\u6ca1\\u95ee\\u9898|\\u5c31\\u8fd9\\u6837|\\u901a\\u8fc7|\\u6267\\u884c|\\u7ee7\\u7eed|\\byes\\b|\\by\\b|approve|accept|\\bok\\b|okay|lgtm|go ahead|proceed|sure|confirm/i", "const title = s.title?.replace(/^\\s*\\[?(dispatch|\\u6d3e\\u6d3b|\\u4efb\\u52a1)[\\]:\uff1a\\s-]*/i, '').trim()"])
allow("facts.ts", ["const prStation = (p.milestones ?? []).findIndex(s => /(^|[^A-Za-z])PR([^A-Za-z]|$)|pull request|\\u5f00\\s?PR|\\u63d0\\u4ea4\\u5ba1\\u67e5/i.test(s)) + 1", "const mergeStation = (p.milestones ?? []).findIndex(s => /\\u5408\\u5e76|merge/i.test(s)) + 1"])
allow("i18n.ts", ["'\\u7b80\\u4f53\\u4e2d\\u6587': 'zh-CN', '\\u4e2d\\u6587': 'zh-CN', '\\u7e41\\u9ad4\\u4e2d\\u6587': 'zh-TW', '\\u7e41\\u4f53\\u4e2d\\u6587': 'zh-TW',", "japanese: 'ja', '\\u65e5\\u672c\\u8a9e': 'ja', korean: 'ko', '\\ud55c\\uad6d\\uc5b4': 'ko',"])
test('i18n hooks contain no CJK punctuation, fullwidth forms or escaped UI literals', () => {
  for (const control of ['中文日本語한국어', '，：）、「', '\\uFF09', '\\u3001', '\\u{4e2d}']) assert.equal(cjk.test(decodeEscapes(control)), true, control)
  assert.equal(cjk.test('English (text), items: Alpha and Beta'), false, 'negative scan control')
  assert.equal(hasUiLiteral('/** 中文注释。 */'), false, 'whole-line JSDoc is not UI')
  assert.equal(hasUiLiteral('// 中文注释。'), false, 'whole-line comment is not UI')
  assert.equal(hasUiLiteral('const label = "中文"'), true, 'actual UI literal still rejected')
  assert.equal(hasUiLiteral('const label = "\\u4e2d\\u6587"'), true, 'escaped UI literal still rejected')
  assert.equal(hasUiLiteral('/** note */ const label = "中文"'), true, 'comment cannot hide trailing code')
  assert.equal(hasUiLiteral('const label = "中文" // note'), true, 'trailing comment cannot hide code')
  const hits = []
  for (const file of fs.readdirSync(path.join(root, 'hooks'))) {
    const text = fs.readFileSync(path.join(root, 'hooks', file), 'utf8')
    text.split('\n').forEach((line, n) => { if (hasUiLiteral(line) && !nonUi.get(file)?.has(line.trim())) hits.push(`${file}:${n + 1}: ${line.trim()}`) })
  }
  assert.deepEqual(hits, [])
})
test('non-CJK catalogs contain no CJK punctuation except exact language endonyms', () => {
  const endonyms = { 'language.zh-CN': '简体中文', 'language.zh-TW': '繁體中文', 'language.ja': '日本語', 'language.ko': '한국어' }
  const hits = []
  for (const code of ['en', 'fr', 'es', 'de', 'pt-BR', 'ru']) {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'locales', `${code}.json`), 'utf8'))
    for (const [key, value] of Object.entries(catalog)) if (cjk.test(value) && value !== endonyms[key]) hits.push(`${code}:${key}`)
  }
  assert.deepEqual(hits, [])
})
test('i18n JSON catalogs remain the sole source and the test-only fixture cannot drift', () => {
  const text = fs.readFileSync(path.join(root, 'tests/catalog-fixture.ts'), 'utf8')
  const fixture = JSON.parse(text.slice(text.indexOf(' = ') + 3).trim())
  const actual = Object.fromEntries(fs.readdirSync(path.join(root, 'locales')).filter(f => f.endsWith('.json')).map(f => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(root, 'locales', f), 'utf8'))]))
  assert.deepEqual(fixture, actual)
  for (const file of fs.readdirSync(path.join(root, 'hooks'))) assert.equal(fs.readFileSync(path.join(root, 'hooks', file), 'utf8').includes('catalog-fixture'), false)
})
