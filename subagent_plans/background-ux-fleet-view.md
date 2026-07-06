# Plan: Background Fleet View

## Goal

Make `subagent_status` without a `jobId` feel like a cockpit dashboard for
background subagents. The user should be able to answer these questions at a
glance:

- What is running?
- What needs me?
- What failed?
- What completed recently?
- Which job should I inspect next?

## Problem

The current list view is useful but still reads like a formatted registry. As
background jobs become durable and interactive, the default status view should
prioritize human attention instead of simply exposing raw job records.

## Non-goals

- No interactive TUI controls yet.
- No external fleet view dependency unless a later spike proves it fits.
- No per-job attach mode.
- No workflow graph view.
- No Agentflow UI integration.

## Desired Output

Example:

```text
Background subagents
1 needs_input · 2 running · 1 failed · 4 completed

Needs input
  subjob_ab12cd34  explorer   1m22s  asks: Which area should I inspect next?
    next: subagent_continue escalationId esc_1234abcd

Running
  subjob_ef56ab78  review,test   2m14s  12 tools  isolated  branch codex/subjob_ef56ab78
    latest: read src/auth/session.ts
    next: subagent_peek jobId subjob_ef56ab78

Failed
  subjob_9988aabb  review   41s  error: child process exited with code 1
    next: subagent_result jobId subjob_9988aabb

Recent completed
  subjob_1122ccdd  docs   3m01s  result available
    next: subagent_result jobId subjob_1122ccdd
```

## Sorting Policy

Sort by attention priority:

1. `needs_input`
2. `failed`
3. `running`
4. `cancelling`
5. recent `completed`
6. recent `cancelled`
7. recent `interrupted`

Within each group, sort most recently updated first.

## Row Content

Each row should prefer compact status fields:

- job ID
- status
- agent names
- age/duration
- phase counts when multi-call
- tool call count
- worktree mode
- branch or changed file count when available
- first recent activity line for running jobs
- open question excerpt for `needs_input`
- error excerpt for failed jobs
- next action hint

## Implementation

### Change 1: Add fleet formatting helpers

In `render.ts`, add helpers such as:

```typescript
function groupJobsForFleet(jobs: BackgroundJob[]): FleetGroup[]
function formatFleetJobRow(job: BackgroundJob): string[]
export function formatJobFleet(jobs: BackgroundJob[]): string
```

Then have `formatJobList` either delegate to `formatJobFleet` or become the
fleet formatter.

### Change 2: Preserve detail view

`subagent_status { jobId }` should continue to show a detailed single-job
view. This plan should not cram every field into the fleet rows.

### Change 3: Add phase counts

For multi-call jobs, display a compact call-state summary:

```text
calls: 1 running, 1 queued, 2 completed
```

This should use `job.callStates`, falling back gracefully for legacy jobs.

### Change 4: Add next action hints

Hints should be precise enough for the parent agent but not overly noisy:

- `needs_input`: `subagent_continue escalationId <id>`
- `running`: `subagent_peek jobId <id>`
- `completed`: `subagent_result jobId <id>`
- `failed`: `subagent_result jobId <id>`
- `cancelling`: wait or check status

## File-by-file Changes

| File | Changes |
|------|---------|
| `render.ts` | Add fleet grouping, sorting, row formatting, and summary header. |
| `index.ts` | No major behavior change; `subagent_status` already calls `formatJobList`. |
| `contract.ts` | Teach parent agent to use fleet view before making parent-worktree changes. |
| `test/render.test.mjs` | Add tests for group ordering, row fields, needs-input priority, failed priority, and legacy fallback. |

## Test Cases

- Empty fleet shows concise empty state.
- Mixed jobs are grouped by attention priority.
- `needs_input` rows include question excerpt and escalation ID.
- Running rows include latest activity and tool count when available.
- Isolated rows include branch or worktree hint.
- Completed rows do not include large result excerpts.
- Legacy jobs without `callStates` still render.

## Open Questions

1. Should old completed jobs be hidden by default after a count threshold?
2. Should `subagent_status` accept filters such as `status`, `limit`, or
   `includeCompleted`?
3. Should fleet rows include queued plans that are waiting on each job, or
   should plans get their own section later?

