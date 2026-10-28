// Small, format-authentic source files, mounted unchanged into MemIo by the tests.
export const markdown = '# Delivery\n\n## Build\n- [ ] Parent\n  - [x] Child\n- [ ] Stable\n```md\n## Not a phase\n- [x] Fake\n```\n## Ship\n- [x] Publish\n'
export const gsd: Record<string, string> = {
  '.planning/ROADMAP.md': '# Roadmap\n\n## Phases\n- [ ] **Phase 1: Foundation** - base\n- [ ] **Phase 2: Delivery** - ship\n\n### Phase 1: Foundation\n**Plans**: 2 plans\nPlans:\n- [ ] 01-01-PLAN.md - Prepare\n- [ ] 01-02-PLAN.md - Build\n### Phase 2: Delivery\n- [x] Release checklist\n',
  '.planning/phases/01-foundation/01-01-PLAN.md': '---\nphase: 01-foundation\nplan: 01\n---\n# Prepare foundation\n<objective>Prepare base</objective>\n',
  '.planning/phases/01-foundation/01-01-SUMMARY.md': '---\nphase: 01-foundation\nplan: 01\n---\n# Completed preparation\n',
  '.planning/phases/01-foundation/01-02-PLAN.md': '# Build foundation\n',
}
export const specs: Record<string, string> = {
  'specs/001-login/tasks.md': '# Login tasks\n## Setup\n- [x] T001 Create schema\n- [ ] T002 [P] Add endpoint\n## Tests\n- [ ] T003 Cover login\n',
  '.kiro/specs/search/tasks.md': '# Search\n- [ ] 1. Build search\n  - [x] 1.1 Add index\n  - [ ]* 1.2 Optional ranking\n',
}
export const taskmaster = JSON.stringify({
  tags: { backend: { tasks: [
    { id: 1, title: 'API', status: 'in-progress', subtasks: [{ id: 1, title: 'Schema', status: 'done' }, { id: 2, title: 'Handlers', status: 'pending' }] },
    { id: 2, title: 'Docs', status: 'done' },
  ] }, frontend: { tasks: [{ id: 1, title: 'UI', status: 'pending' }] } },
}, null, 2)
export const milestones = [{ number: 1, title: 'Launch', html_url: 'https://github.com/acme/app/milestone/1' }]
export const issues = [
  { number: 10, title: 'Closed bug', state: 'closed', html_url: 'https://github.com/acme/app/issues/10', milestone: { number: 1 } },
  { number: 11, title: 'Linked work', state: 'open', html_url: 'https://github.com/acme/app/issues/11', milestone: { number: 1 } },
  { number: 12, title: 'Unstarted', state: 'open', html_url: 'https://github.com/acme/app/issues/12', milestone: { number: 1 } },
  { number: 99, title: 'Not an issue', state: 'closed', html_url: 'https://github.com/acme/app/pull/99', milestone: { number: 1 }, pull_request: {} },
]
export const timeline = [{ event: 'cross-referenced', source: { issue: { html_url: 'https://github.com/acme/app/pull/22', pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/22' } } }, pullRequest: { url: 'https://github.com/acme/app/pull/22', state: 'OPEN', body: 'Fixes #11', closingIssuesReferences: [{ number: 11, url: 'https://github.com/acme/app/issues/11' }] } }]
export const planMode = '# Plan mode\n\n## Approach\n- [ ] Inspect implementation\n- [x] Agree constraints\n'
