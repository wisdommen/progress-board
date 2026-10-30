---
name: progress-board
description: How to keep the progress-board band and plan board accurate. Use before proposing, importing or restructuring a plan, when coordinating sessions that work on a plan, when progress-board check suggestions arrive, or when the board looks stale.
---

# Using progress-board well

progress-board shows two things: this session's own steps (the band above the prompt) and an overall plan shared by every session in the project (`/progress`). The person reads the board instead of asking you. A board that lags behind the work is worse than no board, because it is believed.

## Session steps (`progress_session`)

- At the start of multi-step work, set `goal` and `steps`.
- Every time a step finishes, call `progress_session` with `step_updates` right away: mark it `done` and the next one `doing`. Do not tick everything at the end.
- Claim the plan phase or item you are working on and release it when you stop. A session that mainly dispatches others sets `orchestrator: true`.
- Subagents never call this tool.

## Plan items: one item per mergeable unit

This is the rule most often broken. Each item must be something that gets finished on its own: one pull request, or one sub-plan that ends in one merge.

- Do not write an item that covers a whole phase ("plan and execute phase 14") or a dozen sub-plans. If "done" means "merged and read back", such an item stays `wrapping` while ten PRs merge under it. The board looks frozen even though work is shipping, and anyone who marks it `done` early has to revert it.
- When you plan new sub-plans or open a new PR, add its item in the same turn with `add_items`.
- To fix an item that is too broad, `add_items` with the parts, mark the parts that are already finished `done` (with `meets_criteria: true`), and set the broad item to `void` with a `reason` that names what replaced it.

## Item status

| Status | Use it when |
| --- | --- |
| `todo` | Not started, or started with no reviewable result yet. A claim shows who is on it. |
| `wrapping` | The work exists and waits only on review, a gate, acceptance or merge. |
| `done` | The plan's completion criteria are met (often: merged and read back). Pass `meets_criteria: true`, or the change is rejected. |
| `void` | Dropped or replaced; always give a `reason`. |

- Update the item in the same turn as the event: PR opened → `wrapping`; PR merged and confirmed → `done`. Use `milestone` to show how many of the plan's milestones the item has passed.
- Going back to an earlier status needs a `reason`.
- If the plan's criteria name an exception (for example "To Test does not block completion"), keep the item `wrapping` and set `exception` to that reason; it then counts as complete. Do not use `exception` for "everything is done except part of the work". That means the item is too broad: split it as described above.

## Who edits the plan

- The session that owns the plan (usually the coordinator, which proposed it or was told to keep it) updates its items. Worker sessions update the items they claimed or were assigned.
- Any other session, including one that is only investigating, reads the board but does not edit it. If you see that it is stale, tell the owning session (for example with SendMessage), with the evidence.
- Changing phases needs the person's approval evidence. Do not invent it, and do not edit the files under `~/.claude/progress-board/` by hand.

## Check suggestions

The monitor compares the board with commits, PRs and session activity. When it finds a mismatch, it attaches suggestions with ids to one of your tool results.

- Handle every suggestion you receive in that turn. Verify the facts, update the item if the suggestion is right, then call `progress_plan` with `action: resolve_suggestion`, the `plan` ID, the suggestion's `id` and `accepted: true`. If it is wrong, use `accepted: false` and a `reason`.
- An open suggestion may be sent again to an eligible session after 30 minutes, up to 3 deliveries in total; the last reminder says it will not be sent again. After that, the band and panel still count it (the band only while the plan is active). Open suggestions keep the monitor from raising the same issue anew.

## When the board seems stuck

1. Compare the board's change log with the merges on the repository's main branch over the same period. The log is `~/.claude/progress-board/plans/<encoded id>/log.jsonl`, where the plan ID is URL-encoded: plan `acme/v1.2` lives in `plans/acme%2Fv1.2/`. List `~/.claude/progress-board/plans/` if unsure, and do not conclude "no changes" from a path that does not exist.
2. If both show activity but the done count does not move, the items are too broad. Split them.
3. If the log really has no recent changes, check whether the owning session can use the tool. Plugins load only when a session starts. A session that was already running when progress-board was first installed has no `progress_plan` or `progress_session` tool, even after `/clear`. It needs a restart once it is idle and has written its handoff. (After an update, a running session keeps the version it started with until it restarts.)
4. If a session says the tool is missing, do not route its updates through hand-edited files. Report it to the person and propose the restart.
5. If a window shows an old or finished plan instead of the current one, the window's directory is not among the plan's `repos`. A finished plan is followed automatically by active plans with the same project prefix (`acme/`); for any other case, the plan's owning session calls `progress_plan` with `action: set` and the full `repos` list, including the directory the person views the board from. When proposing a plan, include that directory from the start.
