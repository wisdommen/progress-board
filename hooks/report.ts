import type { Plan, Snapshot, WaitingItem } from '../types'
import { dateTime, number, t } from './i18n'
import { liveItems, progress, sessionName } from './model'
import { priorityOf, levels } from './priorities'
import { parseJson, readPlan, withLock } from './store'
import type { Io, Paths } from './store'

const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/([\\`*_\[\]<>#|])/g, '\\$1')
export function waitingText(w: WaitingItem, snap: Snapshot): string {
  if (w.kind === 'draft') return t('report.draft', { name: snap.plans.find(p => p.id === w.plan)?.title ?? w.plan })
  if (w.kind === 'review') return t('report.review', { name: w.plan, count: w.count })
  if (w.kind === 'question') return t('report.question', { name: w.name })
  if (w.kind === 'ask') return w.question
  return w.text
}
export function reportMarkdown(plan: Plan, snap: Snapshot, since: number | undefined): string {
  const p = progress(plan), today = new Date(snap.now); today.setHours(0, 0, 0, 0)
  const rows = plan.phases.filter(ph => !ph.isVoid).flatMap(ph => liveItems(ph).map(item => ({ ph, item })))
  const completed = rows.filter(({ item }) => item.status === 'done' && item.doneAt !== undefined && item.doneAt <= snap.now)
  const list = (values: string[]) => values.length ? values.map(v => `- ${clean(v)}`) : [`- ${t('report.none')}`]
  const title = (key: string) => `\n## ${t(key)}\n`
  const who = (phase: string, id: string) => snap.sessions.filter(s => s.isAlive && s.endedAt === undefined).flatMap(s => s.claims.filter(c => c.plan === plan.id && (!c.phase || c.phase === phase) && (!c.item || c.item === id)).map(c => c.by ?? sessionName(s))).filter((v, i, a) => a.indexOf(v) === i).join(', ')
  const open = rows.filter(({ item }) => item.status !== 'done').sort((a, b) => levels.indexOf(priorityOf(a.ph, a.item)) - levels.indexOf(priorityOf(b.ph, b.item)))
  return [
    `# ${clean(plan.title)}`,
    t('report.summary', { percent: p.total ? Math.round(p.done / p.total * 100) : 0, done: p.done, planned: p.planned, unplanned: p.unplannedPhases }),
    dateTime(snap.now, { dateStyle: 'medium', timeStyle: 'short' }),
    title('report.criteria'), clean(plan.criteria),
    title('report.phases'),
    ...plan.phases.filter(ph => !ph.isVoid).map(ph => {
      const items = liveItems(ph), done = items.filter(i => i.status === 'done').length, n = items.length ? Math.round(done / items.length * 10) : 0
      return `- ${clean(ph.name)} ${'■'.repeat(n)}${'·'.repeat(10 - n)} ${number(done)}/${number(items.length)}`
    }),
    title('report.today'), ...list(completed.filter(({ item }) => item.doneAt! >= today.getTime()).map(({ item }) => item.title)),
    title('report.since'), ...list(completed.filter(({ item }) => since === undefined || item.doneAt! > since).map(({ item }) => item.title)),
    title('report.active'), ...list(open.filter(({ ph, item }) => item.status === 'wrapping' || who(ph.id, item.id)).map(({ ph, item }) => `${item.title} — ${who(ph.id, item.id) || t('report.unclaimed')} (${t(`filter.${item.status === 'wrapping' ? 'wrapping' : 'doing'}`)})`)),
    title('report.priorities'), ...list(open.filter(({ item, ph }) => ['pinned', 'high'].includes(priorityOf(ph, item))).map(({ item, ph }) => `${t(`priority.${priorityOf(ph, item)}`)}: ${item.title}`)),
    title('report.waiting'), ...list(snap.waiting.filter(w => !('plan' in w) || w.plan === plan.id).map(w => waitingText(w, snap))),
    title('report.decisions'), ...list((snap.away?.decisions ?? []).map(d => `${d.text} — ${d.reversible ? t('report.undo', { text: d.undo ?? t('report.none') }) : t('report.irreversible')}`)),
    '',
  ].join('\n')
}
export async function writeReport(io: Io, paths: Paths, planId: string, snap: Snapshot): Promise<string> {
  if (!await readPlan(io, paths, planId)) throw new Error(t('report.noPlan'))
  return withLock(io, paths.planDir(planId), async guard => {
    const plan = await readPlan(io, paths, planId)
    if (!plan) throw new Error(t('report.noPlan'))
    const dir = `${paths.planDir(planId)}/reports`; await io.mkdirp(dir)
    const previous = parseJson<{ at: number }>(await io.read(`${dir}/latest.json`))
    const d = new Date(snap.now), pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
    let path = `${dir}/${stamp}.md`, suffix = 1
    while (await io.mtime(path) !== null) path = `${dir}/${stamp}-${++suffix}.md`
    await guard(); await io.writeAtomic(path, reportMarkdown(plan, snap, previous?.at))
    await guard(); await io.writeAtomic(`${dir}/latest.json`, JSON.stringify({ at: snap.now, path }))
    return path
  })
}
