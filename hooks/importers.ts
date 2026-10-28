// Import adapters never execute source content. Only the GitHub adapter runs a process,
// always gh with argv; persistence is fenced by the store's existing per-plan lock.
import type { EngineInterface } from 'claude-code'
import type { ImportEvidence, ImportKind, ImportSource, Item, ItemStatus, LogEntry, Phase, Plan } from '../types'
export type { ImportEvidence, ImportKind, ImportSource } from '../types'
import type { Io, LockGuard } from './store'
import { Paths, listPlanIds, readPlan, withLock } from './store'
import { newPlan, renderPlanMd } from './model'
import { t } from './i18n'

export type SourceCandidate = { kind: ImportKind; key: string; path?: string; repo?: string; cwd: string }
export type ImportedItem = Item & { source?: ImportEvidence }
export type ImportedPhase = Omit<Phase, 'items'> & { source?: ImportEvidence; items: ImportedItem[] }
export type ImportedPlan = Omit<Plan, 'phases'> & { source?: ImportSource; phases: ImportedPhase[] }
export type ParsedItem = { title: string; status: ItemStatus; source: ImportEvidence }
export type ParsedPhase = { name: string; source: ImportEvidence; items: ParsedItem[] }
export type ParsedImport = { title: string; phases: ParsedPhase[] }
export type ImportContext = { cwd: string; sessionId: string; planId?: string; source?: string; path?: string }
export const IMPORT_INTERVAL_MS = 30 * 60_000

function resolvePath(cwd: string, path: string): string {
  // Keep a leading home marker intact until the engine supplies HOME.
  if (path === '~' || path.startsWith('~/')) return path
  const parts: string[] = []
  for (const p of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return '/' + parts.join('/')
}
const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path
const clean = (s: string) => s.replace(/\*\*|`/g, '').trim()
const identity = (s: string) => s.trim().replace(/\s+/g, ' ')
const fileEvidence = (key: string, file: string, line = 1): ImportEvidence => ({ key, file, line })
const occurrence = (seen: Map<string, number>, key: string) => { const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return `${key}:${n}` }
function hash(text: string): string {
  let n = 2166136261
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619)
  return (n >>> 0).toString(36)
}

/** Ignore fenced code without changing source line numbers (backticks and tildes). */
function visibleLines(text: string): { text: string; line: number }[] {
  let fence: { mark: string; size: number } | undefined
  return text.split(/\r?\n/).map((text, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(text)
    if (fence) {
      if (f && f[1]![0] === fence.mark && f[1]!.length >= fence.size && !f[2]!.trim()) fence = undefined
      return { text: '', line: i + 1 }
    }
    if (f) { fence = { mark: f[1]![0]!, size: f[1]!.length }; return { text: '', line: i + 1 } }
    return { text, line: i + 1 }
  })
}

/** A checkbox's identity uses its explicit task ID, else its original ancestor/title
 * and duplicate ordinal, never its line number or completion marker. Untagged title
 * edits are new source tasks; line insertion, ticking and local title edits are not. */
export function parseMarkdown(text: string, file: string): ParsedImport {
  const phases: ParsedPhase[] = [], phaseSeen = new Map<string, number>(), itemSeen = new Map<string, number>()
  let title = baseName(file).replace(/\.md$/i, ''), phase: ParsedPhase | undefined
  let parents: { indent: number; title: string }[] = []
  let headings: { level: number; name: string }[] = []
  const makePhase = (name: string, line: number, key: string) => {
    phase = { name, source: fileEvidence(key, file, line), items: [] }
    phases.push(phase)
    return phase
  }
  for (const row of visibleLines(text)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(row.text)
    if (heading) {
      const level = heading[1]!.length, name = clean(heading[2]!)
      // H1 labels the document, while all section ancestors scope local IDs.
      headings = headings.filter(h => h.level < level)
      if (level > 1) headings.push({ level, name })
      if (level === 1) { title = name; phase = undefined }
      if (level === 2) makePhase(name, row.line, occurrence(phaseSeen, `${file}#phase:${identity(name)}`))
      parents = []; continue
    }
    // Numbered lists and non-checkbox ancestors also contribute a readable prefix.
    const list = /^(\s*)(?:[-+*]|\d+[.)])\s+(?:\[([ xX~\-])\]\*?\s*)?(.+?)\s*$/.exec(row.text)
    if (!list) { if (row.text.trim() && !/^\s/.test(row.text)) parents = []; continue }
    const indent = list[1]!.replace(/\t/g, '    ').length, own = clean(list[3]!)
    parents = parents.filter(p => p.indent < indent)
    const full = [...parents.map(p => p.title), own].join(' > ')
    if (list[2] !== undefined) {
      const ph = phase ?? makePhase(t('import.tasks'), row.line, `${file}#phase:default`)
      const id = /^(T\d+|\d+(?:\.\d+)+|\d+[.)])(?:[.)])?(?:\s|$)/i.exec(own)?.[1]?.replace(/[.)]$/, '')
      const nested = headings.filter(h => h.level > 2).map(h => encodeURIComponent(identity(h.name))).join('/')
      const section = nested ? `${ph.source.key}#section:${nested}` : ph.source.key
      const globallyUnique = id !== undefined && (/^T\d+$/i.test(id) || /^\d+(?:\.\d+)+$/.test(id))
      const key = occurrence(itemSeen, id ? `${globallyUnique ? file : section}#task:${id}` : `${section}#task:${identity(full)}`)
      ph.items.push({ title: full, status: /x/i.test(list[2]!) ? 'done' : list[2] === '~' ? 'wrapping' : 'todo', source: fileEvidence(key, file, row.line) })
    }
    parents.push({ indent, title: own })
  }
  return { title, phases }
}

export function parsePlanMode(text: string, file: string): ParsedImport {
  const checked = parseMarkdown(text, file)
  if (checked.phases.some(phase => phase.items.length)) return checked
  const numbered = visibleLines(text).map(row => row.text.replace(/^(\s*)(?:[-+*]|\d+[.)])\s+(.+)$/, '$1- [ ] $2')).join('\n')
  return parseMarkdown(numbered, file)
}

type SourceFiles = Record<string, string>
function absoluteFiles(files: SourceFiles, root: string): SourceFiles {
  return Object.fromEntries(Object.entries(files).map(([p, text]) => [resolvePath(root, p), text]))
}
const phaseNumber = (s: string) => s.split('.').map(n => String(Number(n))).join('.')

export function parseGsd(input: SourceFiles, cwd: string): ParsedImport {
  const files = absoluteFiles(input, cwd), roadmap = resolvePath(cwd, '.planning/ROADMAP.md')
  const text = files[roadmap]
  if (text === undefined) throw new Error(t('import.readFailed', { path: roadmap }))
  const phases: (ParsedPhase & { number: string; section: { text: string; line: number }[] })[] = []
  const byNumber = new Map<string, typeof phases[number]>()
  let current: typeof phases[number] | undefined
  for (const row of visibleLines(text)) {
    const label = /^(?:\s*#{1,6}\s+|\s*[-*]\s+\[[ xX]\]\s+)(?:\*\*)?Phase\s+(\d+(?:\.\d+)*)\s*:\s*(.+)$/i.exec(row.text)
    if (label) {
      const number = phaseNumber(label[1]!), name = clean(label[2]!.split('**')[0]!.replace(/\s+[-—]\s+.*$/, ''))
      current = byNumber.get(number)
      if (!current) {
        current = { number, name, source: fileEvidence(`${roadmap}#phase:${number}`, roadmap, row.line), items: [], section: [] }
        phases.push(current); byNumber.set(number, current)
      }
      continue
    }
    // Do not let unrelated roadmap sections donate checkboxes to the last phase.
    if (/^#{1,3}\s/.test(row.text) && !/^#{1,3}\s+Phase\s/i.test(row.text)) current = undefined
    if (current) current.section.push(row)
  }
  for (const ph of phases) {
    const plans = Object.keys(files).filter(file => {
      const m = /\/(\d+(?:\.\d+)?)-(\d+)-(?:PLAN|SUMMARY)\.md$/i.exec(file)
      return !!m && phaseNumber(m[1]!) === ph.number
    }).sort()
    const groups = new Map<string, { plan?: string; summary?: string }>()
    for (const file of plans) {
      const key = file.replace(/-(PLAN|SUMMARY)\.md$/i, ''), pair = groups.get(key) ?? {}
      if (/-PLAN\.md$/i.test(file)) pair.plan = file; else pair.summary = file
      groups.set(key, pair)
    }
    for (const [key, pair] of groups) {
      const file = pair.plan ?? pair.summary!, content = files[file]!
      const heading = visibleLines(content).find(l => /^#\s+/.test(l.text))
      const title = heading ? clean(heading.text.replace(/^#\s+/, '')) : baseName(key)
      ph.items.push({ title, status: pair.summary ? 'done' : 'todo', source: fileEvidence(`${roadmap}#plan:${baseName(key)}`, file, heading?.line ?? 1) })
    }
    if (!ph.items.length) {
      // Keep actual roadmap line numbers even when parsing an isolated phase body.
      const body = Array.from({ length: text.split(/\r?\n/).length }, () => '')
      for (const row of ph.section) body[row.line - 1] = row.text
      ph.items = parseMarkdown(body.join('\n'), roadmap).phases.flatMap(p => p.items).map(it => ({ ...it, source: { ...it.source, key: `${ph.source.key}#${it.source.key}` } }))
    }
  }
  if (!phases.length) throw new Error(t('import.invalid', { path: roadmap }))
  return { title: parseMarkdown(text, roadmap).title, phases: phases.map(({ number: _n, section: _s, ...ph }) => ph) }
}

/** One spec is one phase, irrespective of headings inside tasks.md. */
export function parseSpecs(input: SourceFiles, cwd: string): ParsedImport {
  const files = absoluteFiles(input, cwd)
  return { title: t('import.specs'), phases: Object.keys(files).sort().filter(file => /\/(?:\.kiro\/)?specs\/[^/]+\/tasks\.md$/i.test(file)).map(file => {
    const parsed = parseMarkdown(files[file]!, file)
    return { name: file.split('/').slice(-2, -1)[0]!, source: fileEvidence(`${file}#spec`, file), items: parsed.phases.flatMap(p => p.items) }
  }) }
}

type Task = { id: string | number; title: string; status?: string; tag?: string; subtasks?: Task[] }
const taskStatus = (status: string | undefined): ParsedItem['status'] => /^(cancelled|canceled|deferred)$/i.test(status ?? '') ? 'void' : /^(done|completed|closed)$/i.test(status ?? '') ? 'done' : /^(in[-_ ]progress|review|in[-_ ]review|wrapping|test)$/i.test(status ?? '') ? 'wrapping' : 'todo'
export function parseTaskmaster(text: string, file: string): ParsedImport {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('import.invalid', { path: file }))
  const raw = value as Record<string, unknown>, phases = new Map<string, ParsedPhase>()
  let cursor = 0
  const add = (tasks: unknown, tag: string) => {
    if (!Array.isArray(tasks)) throw new Error(t('import.invalid', { path: file }))
    const walk = (tasks: Task[], ancestry: string[], names: string[], inheritedTag: string) => {
      for (const task of tasks) {
        if (!task || (typeof task.id !== 'string' && typeof task.id !== 'number') || typeof task.title !== 'string' || !task.title.trim() || (task.tag !== undefined && (typeof task.tag !== 'string' || !task.tag.trim())) || (task.status !== undefined && typeof task.status !== 'string')) throw new Error(t('import.invalid', { path: file }))
        const group = task.tag !== undefined ? `tag:${task.tag}` : inheritedTag
        let phase = phases.get(group)
        if (!phase) { phase = { name: group === 'default' ? t('import.tasks') : group.slice(4), source: fileEvidence(`${file}#${group}`, file), items: [] }; phases.set(group, phase) }
        const key = `${file}#${group}#task:${[...ancestry, String(task.id)].map(encodeURIComponent).join('/')}`
        const pattern = new RegExp('"id"\\s*:\\s*' + (typeof task.id === 'number' ? `${task.id}(?![\\d.])` : JSON.stringify(task.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        const found = pattern.exec(text.slice(cursor)), at = found ? cursor + found.index : 0
        if (found) cursor = at + found[0].length
        const line = text.slice(0, at).split('\n').length
        if (phase.items.some(i => i.source.key === key)) throw new Error(t('import.invalid', { path: file }))
        phase.items.push({ title: [...names, task.title].join(' > '), status: taskStatus(task.status), source: fileEvidence(key, file, line) })
        if (task.subtasks !== undefined) {
          if (!Array.isArray(task.subtasks)) throw new Error(t('import.invalid', { path: file }))
          walk(task.subtasks, [...ancestry, String(task.id)], [...names, task.title], group)
        }
      }
    }
    walk(tasks, [], [], tag)
  }
  if (raw['tag'] !== undefined && (typeof raw['tag'] !== 'string' || !raw['tag'].trim())) throw new Error(t('import.invalid', { path: file }))
  if (Array.isArray(raw['tasks'])) add(raw['tasks'], typeof raw['tag'] === 'string' ? `tag:${raw['tag']}` : 'default')
  else {
    const tags = raw['tags'] && typeof raw['tags'] === 'object' && !Array.isArray(raw['tags']) ? raw['tags'] as Record<string, unknown> : raw
    let recognized = false
    for (const [tag, entry] of Object.entries(tags)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'tasks' in entry) { add((entry as { tasks: unknown }).tasks, `tag:${tag}`); recognized = true }
    }
    if (!recognized) throw new Error(t('import.invalid', { path: file }))
  }
  return { title: t('import.taskmaster'), phases: [...phases.values()] }
}

export type GitHubMilestone = { number: number; title: string; html_url?: string }
export type GitHubIssue = { number: number; title: string; state: string; state_reason?: string | null; html_url?: string; milestone?: { number: number } | null; pull_request?: unknown }
export type GitHubPullRequest = { url: string; state: string; mergedAt?: string | null; body?: string; closingIssuesReferences?: { number: number; url?: string; repository?: { nameWithOwner?: string } }[] }
export type GitHubTimeline = { event?: string; source?: { issue?: { html_url?: string; pull_request?: unknown } }; pullRequest?: GitHubPullRequest }
function closingPullRequest(repo: string, number: number, pr: GitHubPullRequest | undefined): boolean {
  if (!pr || !new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/\\d+$`, 'i').test(pr.url)) return false
  if (pr.state.toUpperCase() !== 'OPEN' && pr.state.toUpperCase() !== 'MERGED' && !pr.mergedAt) return false
  const url = `https://github.com/${repo}/issues/${number}`
  if (pr.closingIssuesReferences?.some(i => i.number === number && (i.url?.toLowerCase() === url.toLowerCase() || i.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase()))) return true
  // Only closing keywords count; a timeline cross-reference alone is not evidence.
  const body = (pr.body ?? '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`/g, '')
  const links = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+(https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+|(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)(?![\w/#])/gi
  for (const match of body.matchAll(links)) {
    const link = match[1]!.toLowerCase()
    if (link === `#${number}` || link === `${repo}#${number}`.toLowerCase() || link === url.toLowerCase()) return true
  }
  return false
}
export function parseGitHub(repo: string, milestones: readonly GitHubMilestone[], issues: readonly GitHubIssue[], timelines: Record<number, readonly GitHubTimeline[]> = {}): ParsedImport {
  return { title: repo, phases: milestones.map(m => ({
    name: m.title, source: { key: `github:${repo}#milestone:${m.number}`, url: m.html_url ?? `https://github.com/${repo}/milestone/${m.number}` },
    items: issues.filter(i => !i.pull_request && i.milestone?.number === m.number).map(i => ({
      title: i.title,
      status: i.state.toLowerCase() === 'closed' ? (i.state_reason === 'not_planned' ? 'void' : 'done') : (timelines[i.number] ?? []).some(e => closingPullRequest(repo, i.number, e.pullRequest)) ? 'wrapping' : 'todo',
      source: { key: `github:${repo}#issue:${i.number}`, url: i.html_url ?? `https://github.com/${repo}/issues/${i.number}` },
    })),
  })) }
}

/** A source is never read by spelling alone. Resolve the session's project and
 * every read/list entry, including symlinks reached by recursive adapters. This
 * wrapper is for source reads only; board persistence uses the original Io. */
async function sourceBoundary($: EngineInterface, io: Io, requestedCwd: string) {
  const sessionCwd = await $.session.cwd()
  const sessionStat = await $.fs.stat(sessionCwd, { resolve: true })
  if (!sessionStat.realPath || sessionStat.kind !== 'dir') throw new Error(t('import.failed'))
  const git = await $.process.run(['git', '-C', sessionStat.realPath, 'rev-parse', '--show-toplevel'], { cwd: sessionStat.realPath, timeoutMs: 10_000 })
  const rootStat = git.exitCode === 0 ? await $.fs.stat(git.stdout.trim(), { resolve: true }) : sessionStat
  const root = rootStat.realPath
  if (!root || rootStat.kind !== 'dir') throw new Error(t('import.failed'))
  const inside = (path: string) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
  if (!inside(sessionStat.realPath)) throw new Error(t('import.failed'))
  const expanded = async (path: string) => {
    if (path === '~' || path.startsWith('~/')) {
      const home = await $.env.get('HOME')
      if (!home?.startsWith('/')) throw new Error(t('import.failed'))
      path = home + path.slice(1)
    }
    return resolvePath(sessionStat.realPath!, path)
  }
  const stat = async (path: string) => {
    const absolute = await expanded(path)
    const value = await $.fs.stat(absolute, { resolve: true }).catch(() => undefined)
    if (!value) return undefined
    if (!value.realPath || !inside(value.realPath)) throw new Error(t('import.failed'))
    return value
  }
  const required = async (path: string) => {
    const value = await stat(path)
    if (!value?.realPath) throw new Error(t('import.readFailed', { path }))
    return value.realPath
  }
  const cwd = await required(requestedCwd)
  const bounded = Object.create(io) as Io
  bounded.read = async path => {
    const value = await stat(path)
    return value?.realPath ? io.read(value.realPath) : null
  }
  bounded.list = async path => {
    const value = await stat(path)
    if (!value?.realPath || value.kind !== 'dir') return []
    const entries = await io.list(value.realPath), result = []
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('/')) continue
      const child = await stat(`${value.realPath}/${entry.name}`)
      // An unresolved recursive entry may be a dangling symlink: fail closed.
      if (!child) throw new Error(t('import.failed'))
      result.push({ ...entry, kind: child.kind === 'dir' ? 'dir' as const : child.kind === 'file' ? 'file' as const : 'other' as const })
    }
    return result
  }
  const canonical = async (source: SourceCandidate): Promise<SourceCandidate> => {
    const sourceCwd = await required(source.cwd)
    const path = source.path ? await required(source.path) : undefined
    return candidate(source.kind, sourceCwd, path, source.repo)
  }
  return { io: bounded, cwd, canonical }
}

function candidate(kind: ImportKind, cwd: string, path?: string, repo?: string): SourceCandidate {
  const absolute = path ? resolvePath(cwd, path) : undefined
  return { kind, cwd, key: `${kind}:${repo ?? absolute ?? cwd}`, ...(absolute ? { path: absolute } : {}), ...(repo ? { repo } : {}) }
}
const validRepo = (repo: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.split('/').some(p => p === '.' || p === '..')
async function ghJson($: EngineInterface, cwd: string, argv: string[]): Promise<unknown> {
  const out = await $.process.run(['gh', ...argv], { cwd, timeoutMs: 20_000 })
  if (out.exitCode !== 0) throw new Error(t('import.githubFailed'))
  try { return JSON.parse(out.stdout) } catch { throw new Error(t('import.githubFailed')) }
}
async function ghPages<T>($: EngineInterface, cwd: string, endpoint: string): Promise<T[]> {
  const raw = await ghJson($, cwd, ['api', endpoint, '--paginate', '--slurp'])
  if (!Array.isArray(raw)) throw new Error(t('import.githubFailed'))
  // --slurp yields an outer page array; a flat fixture response is accepted too.
  const rows = raw.flat()
  if (!rows.every(row => row && typeof row === 'object' && !Array.isArray(row))) throw new Error(t('import.githubFailed'))
  return rows as T[]
}
async function githubRepo($: EngineInterface, cwd: string): Promise<string> {
  const raw = await ghJson($, cwd, ['repo', 'view', '--json', 'nameWithOwner']) as { nameWithOwner?: string }
  if (!raw || typeof raw.nameWithOwner !== 'string' || !validRepo(raw.nameWithOwner)) throw new Error(t('import.githubFailed'))
  return raw.nameWithOwner
}

/** Discovery never chooses among candidates. GitHub failure is optional discovery,
 * but a selected GitHub source failing is an import failure, not an empty source. */
export async function detectSources($: EngineInterface, io: Io, cwd: string): Promise<SourceCandidate[]> {
  const boundary = await sourceBoundary($, io, cwd)
  io = boundary.io; cwd = boundary.cwd
  const found: SourceCandidate[] = []
  if (await io.read(`${cwd}/.planning/ROADMAP.md`) !== null) found.push(candidate('gsd', cwd, '.planning/ROADMAP.md'))
  for (const [kind, root] of [['specs', 'specs'], ['kiro', '.kiro/specs']] as const) {
    const path = `${cwd}/${root}`
    for (const dir of (await io.list(path)).filter(e => e.kind === 'dir').sort((a, b) => a.name.localeCompare(b.name))) {
      if (await io.read(`${path}/${dir.name}/tasks.md`) !== null) { found.push(candidate(kind, cwd, root)); break }
    }
  }
  if (await io.read(`${cwd}/.taskmaster/tasks/tasks.json`) !== null) found.push(candidate('taskmaster', cwd, '.taskmaster/tasks/tasks.json'))
  for (const file of ['TODO.md', 'PLAN.md', 'TASKS.md', 'ROADMAP.md']) {
    if (await io.read(`${cwd}/${file}`) !== null) found.push(candidate('markdown', cwd, file))
  }
  try {
    const repo = await githubRepo($, cwd)
    const milestones = await ghPages<GitHubMilestone>($, cwd, `repos/${repo}/milestones?state=all&per_page=100`)
    if (milestones.length) found.push(candidate('github', cwd, undefined, repo))
  } catch { /* No usable gh is not an error for local discovery. */ }
  return Promise.all(found.map(boundary.canonical))
}

async function readRequired(io: Io, path: string): Promise<string> {
  const text = await io.read(path)
  if (text === null) throw new Error(t('import.readFailed', { path }))
  return text
}
async function readTree(io: Io, root: string, select: (path: string) => boolean): Promise<SourceFiles> {
  const files: SourceFiles = {}
  const visit = async (dir: string, depth: number) => {
    if (depth > 12) throw new Error(t('import.invalid', { path: dir }))
    for (const entry of (await io.list(dir)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('/')) continue
      const path = `${dir}/${entry.name}`
      if (entry.kind === 'dir') await visit(path, depth + 1)
      else if (entry.kind === 'file' && select(path)) files[path] = await readRequired(io, path)
    }
  }
  await visit(root, 0)
  return files
}
async function readSource($: EngineInterface, io: Io, source: SourceCandidate): Promise<ParsedImport> {
  const { kind, cwd } = source
  if (kind === 'github') {
    const repo = source.repo!
    if (!validRepo(repo)) throw new Error(t('import.githubFailed'))
    const milestones = await ghPages<GitHubMilestone>($, cwd, `repos/${repo}/milestones?state=all&per_page=100`)
    if (!milestones.every(m => Number.isInteger(m.number) && typeof m.title === 'string')) throw new Error(t('import.githubFailed'))
    const issues: GitHubIssue[] = [], timelines: Record<number, GitHubTimeline[]> = {}, prs = new Map<string, GitHubPullRequest>()
    for (const milestone of milestones) {
      const rows = await ghPages<GitHubIssue>($, cwd, `repos/${repo}/issues?milestone=${milestone.number}&state=all&per_page=100`)
      if (!rows.every(i => Number.isInteger(i.number) && typeof i.title === 'string' && typeof i.state === 'string')) throw new Error(t('import.githubFailed'))
      for (const issue of rows) {
        if (issue.pull_request || issues.some(i => i.number === issue.number)) continue
        issues.push(issue)
        if (issue.state.toLowerCase() !== 'closed') {
          const events = await ghPages<GitHubTimeline>($, cwd, `repos/${repo}/issues/${issue.number}/timeline?per_page=100`)
          timelines[issue.number] = []
          for (const event of events) {
            const url = event.source?.issue?.html_url, match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/i.exec(url ?? '')
            if (event.event !== 'cross-referenced' || !event.source?.issue?.pull_request || !match || match[1]!.toLowerCase() !== repo.toLowerCase()) continue
            let pr = prs.get(url!)
            if (!pr) {
              const raw = await ghJson($, cwd, ['pr', 'view', match[2]!, '--repo', repo, '--json', 'state,mergedAt,url,body,closingIssuesReferences'])
              if (!raw || typeof raw !== 'object' || typeof (raw as GitHubPullRequest).url !== 'string' || typeof (raw as GitHubPullRequest).state !== 'string') throw new Error(t('import.githubFailed'))
              pr = raw as GitHubPullRequest
              if (pr.body !== undefined && typeof pr.body !== 'string' || pr.closingIssuesReferences !== undefined && (!Array.isArray(pr.closingIssuesReferences) || !pr.closingIssuesReferences.every(i => i && Number.isInteger(i.number)))) throw new Error(t('import.githubFailed'))
              prs.set(url!, pr)
            }
            timelines[issue.number]!.push({ ...event, pullRequest: pr })
          }
        }
      }
    }
    return parseGitHub(repo, milestones, issues, timelines)
  }
  const path = source.path!
  if (kind === 'plan-mode') return parsePlanMode(await readRequired(io, path), path)
  if (kind === 'markdown') return parseMarkdown(await readRequired(io, path), path)
  if (kind === 'taskmaster') return parseTaskmaster(await readRequired(io, path), path)
  if (kind === 'gsd') {
    // Source path is the roadmap; resolve its own project, not the caller's cwd.
    const root = path.replace(/\/\.planning\/ROADMAP\.md$/i, '')
    const files = await readTree(io, `${root}/.planning/phases`, p => /-(?:PLAN|SUMMARY)\.md$/i.test(p))
    files[path] = await readRequired(io, path)
    return parseGsd(files, root)
  }
  const files: SourceFiles = {}
  if (/\/tasks\.md$/i.test(path)) return parseSpecs({ [path]: await readRequired(io, path) }, cwd)
  const single = await io.read(`${path}/tasks.md`)
  if (single !== null) return parseSpecs({ [`${path}/tasks.md`]: single }, cwd)
  for (const entry of await io.list(path)) {
    if (entry.kind !== 'dir' || entry.name === '.' || entry.name === '..' || entry.name.includes('/')) continue
    const file = `${path}/${entry.name}/tasks.md`, text = await io.read(file)
    if (text !== null) files[file] = text
  }
  if (!Object.keys(files).length) throw new Error(t('import.readFailed', { path }))
  return parseSpecs(files, cwd)
}

function kindForPath(cwd: string, path: string): ImportKind | undefined {
  const absolute = resolvePath(cwd, path)
  if (/\/\.planning\/ROADMAP\.md$/i.test(absolute)) return 'gsd'
  if (/\/\.kiro\/specs(?:\/[^/]+(?:\/tasks\.md)?)?$/i.test(absolute)) return 'kiro'
  if (/\/specs(?:\/[^/]+(?:\/tasks\.md)?)?$/i.test(absolute)) return 'specs'
  if (/\.json$/i.test(absolute)) return 'taskmaster'
  if (/\.md$/i.test(absolute)) return 'markdown'
  return undefined
}

async function selectSource($: EngineInterface, io: Io, ctx: ImportContext): Promise<SourceCandidate | SourceCandidate[]> {
  const cwd = resolvePath('/', ctx.cwd), given = ctx.source?.trim(), path = ctx.path?.trim()
  if (!given && !path) return detectSources($, io, cwd)
  const kinds: ImportKind[] = ['gsd', 'specs', 'kiro', 'taskmaster', 'markdown', 'github', 'plan-mode']
  const split = given?.indexOf(':') ?? -1
  const token = split > 0 ? given!.slice(0, split) : given
  const suffix = split > 0 ? given!.slice(split + 1) : undefined
  if (token && !kinds.includes(token as ImportKind)) {
    const inferred = kindForPath(cwd, given!)
    if (inferred && !path) return candidate(inferred, cwd, given)
    throw new Error(t('import.unknownSource', { source: given }))
  }
  const kind = (token ?? (path ? kindForPath(cwd, path) : undefined) ?? 'markdown') as ImportKind
  if (kind === 'github') {
    const repo = suffix ?? path ?? await githubRepo($, cwd)
    if (!validRepo(repo)) throw new Error(t('import.githubFailed'))
    return candidate(kind, cwd, undefined, repo)
  }
  const defaults: Partial<Record<ImportKind, string>> = { gsd: '.planning/ROADMAP.md', specs: 'specs', kiro: '.kiro/specs', taskmaster: '.taskmaster/tasks/tasks.json' }
  let target = path ?? suffix ?? defaults[kind]
  if (!target) {
    if (kind === 'plan-mode') throw new Error(t('import.pathRequired'))
    return (await detectSources($, io, cwd)).filter(c => c.kind === kind)
  }
  if (kind === 'gsd' && !/ROADMAP\.md$/i.test(target)) target = `${target.replace(/\/+$/, '')}/ROADMAP.md`
  return candidate(kind, cwd, target)
}

function mergeImport(current: Plan | null, parsed: ParsedImport, source: SourceCandidate, id: string, sessionId: string, now: number): { plan: ImportedPlan; log: Omit<LogEntry, 'at' | 'plan'>[] } {
  const plan = (current ? JSON.parse(JSON.stringify(current)) : newPlan({ id, title: parsed.title, goal: t('import.goal'), criteria: t('import.criteria'), repos: [source.cwd], phases: [], includeRelease: false, by: sessionId, now })) as ImportedPlan
  const previous = plan.source, oldItems = new Map<string, ImportedItem>()
  for (const phase of plan.phases) for (const item of phase.items) if (item.source) oldItems.set(item.source.key, item)
  const present: string[] = [], log: Omit<LogEntry, 'at' | 'plan'>[] = []
  let added = 0, advanced = 0
  for (const incoming of parsed.phases) {
    let phase = plan.phases.find(p => p.source?.key === incoming.source.key)
    if (!phase) {
      do { plan.seq++ } while (plan.phases.some(p => p.id === `p${plan.seq}`))
      phase = { id: `p${plan.seq}`, name: incoming.name, source: incoming.source, addedAt: now, items: [] }
      plan.phases.push(phase)
    }
    for (const incomingItem of incoming.items) {
      present.push(incomingItem.source.key)
      const item = oldItems.get(incomingItem.source.key)
      if (item) {
        // Refresh evidence locations but never overwrite local titles/refs/priorities.
        item.source = incomingItem.source
        const rank: Record<ItemStatus, number> = { todo: 0, wrapping: 1, done: 2, void: 3 }
        if (rank[incomingItem.status] > rank[item.status]) {
          const before = item.status; item.status = incomingItem.status; item.updatedAt = now; advanced++
          if (item.status === 'done') {
            item.doneAt = now
            if (plan.milestones?.length) { item.milestoneBeforeDone = item.milestone ?? 0; item.milestone = plan.milestones.length }
          }
          log.push({ by: sessionId, action: 'import-progress', detail: t('import.progress', { title: item.title, from: before, to: item.status }), target: item.id })
        }
      } else {
        let n = 1
        const used = new Set(plan.phases.flatMap(p => p.items.map(i => i.id)))
        while (used.has(`${phase.id}-${n}`)) n++
        const next: ImportedItem = { id: `${phase.id}-${n}`, title: incomingItem.title, status: incomingItem.status, source: incomingItem.source, updatedAt: now, ...(incomingItem.status === 'done' && plan.milestones?.length ? { milestone: plan.milestones.length } : {}) }
        phase.items.push(next); oldItems.set(incomingItem.source.key, next); added++
      }
    }
  }
  const presentSet = new Set(present)
  for (const key of previous?.present ?? []) {
    if (presentSet.has(key)) continue
    const item = oldItems.get(key)
    if (item) log.push({ by: sessionId, action: 'import-removed', detail: t('import.removed', { title: item.title }), target: item.id })
  }
  if (current) plan.added += added
  plan.source = { ...source, lastImportedAt: now, present: [...presentSet] }
  plan.updatedAt = now
  log.push({ by: sessionId, action: current ? 'import-reconcile' : 'import', detail: t(current ? 'import.reconciled' : 'import.created', { plan: id, added, advanced }) })
  return { plan, log }
}
async function saveImport(io: Io, paths: Paths, guard: LockGuard, plan: ImportedPlan, log: Omit<LogEntry, 'at' | 'plan'>[]): Promise<void> {
  await guard(); await io.writeAtomic(paths.planJson(plan.id), JSON.stringify(plan, null, 1))
  await guard(); await io.writeAtomic(paths.planMd(plan.id), renderPlanMd(plan))
  if (log.length) { await guard(); await io.append(paths.planLog(plan.id), log.map(l => JSON.stringify({ at: plan.updatedAt, plan: plan.id, ...l })).join('\n') + '\n') }
}

/** Entry point for both /progress import and progress_plan action=import. Approval
 * is intentionally not accepted: a first import is always a draft. */
export async function importSource($: EngineInterface, io: Io, paths: Paths, ctx: ImportContext): Promise<{ text: string; plan?: Plan }> {
  try {
    if (ctx.planId && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ctx.planId)) return { text: t('import.failed') }
    const boundary = await sourceBoundary($, io, ctx.cwd)
    const saved = ctx.planId ? await readPlan(io, paths, ctx.planId) as ImportedPlan | null : null
    let selection: SourceCandidate | SourceCandidate[]
    if (!ctx.source && !ctx.path && saved?.source) selection = saved.source
    else selection = await selectSource($, boundary.io, { ...ctx, cwd: boundary.cwd })
    if (Array.isArray(selection)) {
      if (selection.length !== 1) return { text: selection.length ? `${t('import.choose')}\n${selection.map(c => c.key).join('\n')}` : t('import.none') }
      selection = selection[0]!
    }
    const source = await boundary.canonical(selection)
    const prefix = baseName(source.cwd).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
    let id = ctx.planId ?? `${prefix}/import-${hash(source.key)}`
    if (!ctx.planId) {
      const matches: string[] = []
      for (const entry of await listPlanIds(io, paths)) {
        const existing = await readPlan(io, paths, entry.id)
        if (existing?.source?.key === source.key) matches.push(existing.id)
      }
      // An explicit plan ID disambiguates intentionally duplicated source bindings.
      if (matches.length > 1) return { text: t('import.sourceMismatch') }
      if (matches.length === 1) id = matches[0]!
    }
    const snapshot = await readPlan(io, paths, id) as ImportedPlan | null
    if (snapshot && (!snapshot.source || snapshot.source.key !== source.key || !['draft', 'active'].includes(snapshot.status))) return { text: t('import.sourceMismatch') }
    // Fetch and parse before taking a lock, even for local sources. A slow gh
    // request cannot block claims, human edits or other plan mutations.
    const parsed = await readSource($, boundary.io, source)
    if (!snapshot && !parsed.phases.some(p => p.items.length)) return { text: t('import.none') }
    return await withLock(io, paths.planDir(id), async guard => {
      const current = await readPlan(io, paths, id) as ImportedPlan | null
      if (current && (!current.source || current.source.key !== source.key || !['draft', 'active'].includes(current.status))) return { text: t('import.sourceMismatch') }
      if (JSON.stringify(current?.source) !== JSON.stringify(snapshot?.source)) {
        // Another importer won while we fetched: return its result, never apply
        // this older observation. Unrelated human fields still merge below.
        return current ? { text: t('import.updated', { plan: id }), plan: current } : { text: t('import.sourceMismatch') }
      }
      const merged = mergeImport(current, parsed, source, id, ctx.sessionId, await io.now())
      await saveImport(io, paths, guard, merged.plan, merged.log)
      return { text: t(current ? 'import.updated' : 'import.draft', { plan: id }), plan: merged.plan }
    })
  } catch {
    return { text: t('import.failed') }
  }
}

/** Automatic reconciliation fetches without a lock, then checks the source
 * binding and watermark under the lock. Failures never advance the watermark. */
export async function reconcileImports($: EngineInterface, io: Io, paths: Paths, plan: Plan, sessionId: string): Promise<void> {
  const source = (plan as ImportedPlan).source
  if (!source || (await io.now()) - source.lastImportedAt < IMPORT_INTERVAL_MS) return
  try {
    const snapshot = await readPlan(io, paths, plan.id) as ImportedPlan | null
    if (!snapshot?.source || !['draft', 'active'].includes(snapshot.status) || (await io.now()) - snapshot.source.lastImportedAt < IMPORT_INTERVAL_MS) return
    const boundary = await sourceBoundary($, io, await $.session.cwd())
    const selected = await boundary.canonical(snapshot.source)
    // Rebinding by symlink after import is a different source, not an update.
    if (selected.key !== snapshot.source.key) return
    const parsed = await readSource($, boundary.io, selected)
    await withLock(io, paths.planDir(plan.id), async guard => {
      const current = await readPlan(io, paths, plan.id) as ImportedPlan | null, now = await io.now()
      if (!current?.source || !['draft', 'active'].includes(current.status) || JSON.stringify(current.source) !== JSON.stringify(snapshot.source) || now - current.source.lastImportedAt < IMPORT_INTERVAL_MS) return
      const merged = mergeImport(current, parsed, selected, current.id, sessionId, now)
      await saveImport(io, paths, guard, merged.plan, merged.log)
    })
  } catch { /* Retry at a later tick; no destructive guesses after an IO/gh failure. */ }
}
