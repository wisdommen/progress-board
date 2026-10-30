const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const skillPath = path.join(root, 'skills/progress-board/SKILL.md')

const parseSkill = text => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  assert.ok(match, 'skill must have YAML front matter')
  const frontmatter = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const key = /^([\w-]+):[ \t]*(.*)$/.exec(lines[i])
    if (!key) continue
    const valueLines = [key[2]]
    while (i + 1 < lines.length && !/^[\w-]+:/.test(lines[i + 1])) {
      valueLines.push(lines[++i])
    }
    const block = /^([>|])([-+]?)$/.exec(valueLines[0])
    let value
    if (block) {
      const content = valueLines.slice(1)
      const indent = Math.min(...content.filter(line => line.trim()).map(line => /^ */.exec(line)[0].length))
      const unindented = content.map(line => line.slice(indent))
      value = unindented.join('\n') + (content.length ? '\n' : '')
      if (block[1] === '>') value = value.replace(/([^\n])\n(?=[^\n])/g, '$1 ')
      if (block[2] === '-') value = value.replace(/\n+$/, '')
      else if (block[2] !== '+') value = value.replace(/\n+$/, '\n')
    } else {
      value = valueLines.map(line => line.trim()).join(' ').trim()
      if (value.startsWith('"')) {
        value = JSON.parse(value)
      } else if (value.startsWith("'")) {
        assert.ok(value.endsWith("'"), 'single-quoted value must be closed')
        value = value.slice(1, -1).replace(/''/g, "'")
      } else if (/^-?\d+(?:\.\d+)?$/.test(value)) {
        value = Number(value)
      }
    }
    frontmatter[key[1]] = value
  }
  return { frontmatter, body: match[2] }
}
const skill = () => parseSkill(fs.readFileSync(skillPath, 'utf8'))
const validDescription = description => {
  assert.equal(typeof description, 'string', 'description must be text')
  assert.ok(description.trim(), 'description must not be empty')
  assert.ok(description.length < 1024, 'description must be under 1024 characters')
  assert.doesNotMatch(description, /[<>]/)
}
const fixture = description => `---\nname: progress-board\ndescription: ${description}\n---\nbody\n`

test('V062 bundled progress-board skill exists', () => {
  assert.ok(fs.statSync(skillPath).isFile())
})

test('V062 skill front matter names progress-board and has a valid description', () => {
  const { frontmatter } = skill()
  assert.equal(frontmatter.name, 'progress-board')
  validDescription(frontmatter.description)
})

test('V062 pointer constant joins the manifest plugin name and YAML skill name', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'))
  const source = fs.readFileSync(path.join(root, 'hooks/register.tsx'), 'utf8')
  const literal = name => {
    const match = new RegExp(`const ${name} = ['"]([^'"]+)['"]`).exec(source)
    assert.ok(match, `${name} must be an explicit source constant`)
    return match[1]
  }
  assert.equal(literal('PLUGIN_NAME'), manifest.name)
  assert.equal(literal('SKILL_NAME'), skill().frontmatter.name)
  assert.match(source, /const QUALIFIED_SKILL = `\$\{PLUGIN_NAME\}:\$\{SKILL_NAME\}`/)
  assert.equal(`${literal('PLUGIN_NAME')}:${literal('SKILL_NAME')}`, `${manifest.name}:${skill().frontmatter.name}`)
  assert.match(source, /load the \$\{QUALIFIED_SKILL\} skill\./)
  assert.equal(path.basename(path.dirname(skillPath)), skill().frontmatter.name)
})

for (const [label, input, expected] of [
  ['folded', '>\n  first line\n  second line', 'first line second line\n'],
  ['literal', '|\n  first line\n  second line', 'first line\nsecond line\n'],
  ['plain multiline', 'first line\n  second line', 'first line second line'],
  ['quoted multiline', '"first line\n  second line"', 'first line second line'],
  ['plain one-line', 'first line', 'first line'],
  ['single-quoted one-line', "'first ''quoted'' line'", "first 'quoted' line"],
  ['double-quoted one-line', '"first \\"quoted\\" line"', 'first "quoted" line'],
  ['single-quoted multiline', "'first line\n  second line'", 'first line second line'],
  ['folded strip', '>-\n  first line\n  second line\n', 'first line second line'],
  ['folded keep', '>+\n  first line\n  second line\n', 'first line second line\n\n'],
  ['literal strip', '|-\n  first line\n  second line\n', 'first line\nsecond line'],
  ['literal keep', '|+\n  first line\n  second line\n', 'first line\nsecond line\n\n'],
  ['next top-level key', '>\n  first line\n  second line\nother: separate', 'first line second line\n'],
]) {
  test(`V062 description parses the whole ${label} YAML value`, () => {
    const { frontmatter } = parseSkill(fixture(input))
    assert.equal(frontmatter.description, expected)
    validDescription(frontmatter.description)
  })
}

for (const [label, input] of [
  ['folded later-line angle brackets', '>\n  first line\n  <bad>'],
  ['literal later-line angle brackets', '|\n  first line\n  <bad>'],
  ['plain later-line angle brackets', 'first line\n  <bad>'],
  ['quoted later-line angle brackets', '"first line\n  <bad>"'],
  ['folded overlong text', `>\n  first line\n  ${'a'.repeat(1024)}`],
  ['literal overlong text', `|\n  first line\n  ${'a'.repeat(1024)}`],
  ['empty block', '>'],
  ['non-string value', '123'],
]) {
  test(`V062 description rejects ${label}`, () => {
    assert.throws(() => validDescription(parseSkill(fixture(input)).frontmatter.description))
  })
}

test('V062 skill body covers suggestions and splitting oversized items', () => {
  const { body } = skill()
  for (const name of ['resolve_suggestion', 'add_items', 'void']) assert.ok(body.includes(name), name)
})

test('V063 plugin manifest declares version 0.6.5', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'))
  assert.equal(manifest.version, '0.6.5')
})

test('V063 check suggestions describe 30-minute redelivery capped at three deliveries', () => {
  const section = skill().body.split('## Check suggestions\n')[1].split('\n## ')[0]
  assert.match(section, /30 minutes/)
  assert.match(section, /3 deliveries/)
  assert.match(section, /band and panel/)
})
