import { expect, enTest as test } from './locale-test'
import type { Snapshot } from '../types'
import { reportMarkdown } from '../hooks/report'
import { plan, session, NOW } from './v03-fixtures'

test('V05 report phase claims do not mark another phase items as in progress', async () => {
  const p = plan()
  p.phases[0]!.items = [{ ...p.phases[0]!.items[0]!, title: 'Claimed phase task', status: 'todo' }]
  p.phases.push({ id: 'p2', name: 'Other phase', addedAt: NOW, items: [{ id: 'p2-1', title: 'Other phase task', status: 'todo', updatedAt: NOW }] })
  const self = { ...session({ claims: [{ plan: p.id, phase: 'p1', source: 'claim', at: NOW }] }), isAlive: true, isSelf: true, attribution: { confident: [], speculative: [] }, cwdMissing: false }
  const snap: Snapshot = { plans: [p], sessions: [self], focusPlan: p.id, now: NOW, selfId: self.id, waiting: [], repoPlans: [], recent: [] }
  const report = reportMarkdown(p, snap, NOW)
  expect(report).toContain('Claimed phase task')
  expect(report).not.toContain('Other phase task')
})
