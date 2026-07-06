# Plan: Job Detail and Peek Cleanup

## Goal

Separate three different inspection modes:

- fleet overview: `subagent_status`
- structured job page: `subagent_status { jobId }`
- live activity tail: `subagent_peek`

The user should not need to read raw event JSON or long report text to
understand what a background job is doing.

## Problem

As job state has grown, status, peek, and result can blur together:

- status can become too verbose if it tries to show everything
- peek can feel like a debugging tool instead of a human activity tail
- result is the right place for report text, but completion notifications
  currently compete with it

This plan keeps the overview compact while improving intentional drilldown.

## Non-goals

- No attach/takeover mode.
- No direct TUI controls.
- No streaming live pane beyond existing `subagent_peek`.
- No changes to raw event journal storage.
- No full artifact model yet.

## Desired `subagent_status { jobId }` Shape

```text
Job subjob_ab12cd34
Status: running
Created: 2m14s ago
Updated: 8s ago
Mode: isolated worktree
Branch: codex/subjob_subjob_ab12cd34

Calls
  0 review   running   12 tools   latest: read src/auth/session.ts
  1 test     queued

Artifacts
  result: pending
  patch: pending
  changed files: pending

Next
  peek: subagent_peek jobId subjob_ab12cd34
  cancel: subagent_cancel jobId subjob_ab12cd34 confirm true
```

For terminal isolated jobs:

```text
Artifacts
  result: .pi-subagent/jobs/subjob_ab12cd34/result.md
  patch: .pi-subagent/jobs/subjob_ab12cd34/worktree.patch
  changed files: 4
  branch: codex/subjob_subjob_ab12cd34
```

## Desired `subagent_peek` Shape

Default:

```text
Recent activity for subjob_ab12cd34

Call 0 review
  12:01:04 read src/auth/session.ts
  12:01:07 grep /refreshToken/ src
  12:01:11 read src/auth/tokens.ts

Raw events hidden. Use includeRawEvents: true for debugging.
```

Raw events should remain available through `includeRawEvents: true`.

## Implementation

### Change 1: Make job detail sections explicit

Refactor `formatJobStatus(job)` in `render.ts` into section helpers:

```typescript
formatJobHeader(job)
formatJobCalls(job)
formatJobArtifacts(job)
formatJobEscalations(job)
formatJobNextActions(job)
```

This keeps single-job status useful without turning the fleet view into a wall
of text.

### Change 2: Make peek activity-first

`formatJobPeek` should use summarized activity by default:

- call index and agent
- latest tool/event activity
- assistant excerpt only when useful and short
- raw events only when `includeRawEvents` is true

### Change 3: Show artifact availability

Before adding a full artifact model, expose the current artifact fields
consistently:

- result artifact is available when job has terminal results
- patch path from `job.worktreeMetadata.patchPath`
- changed files from `job.worktreeMetadata.changedFiles`
- branch from `job.worktreeMetadata.branch`
- worktree path from `job.worktreeMetadata.path`

### Change 4: Keep raw event limits

Keep `maxEvents` bounded by existing validation. Raw event output is still a
debugging escape hatch, not the main UX.

## File-by-file Changes

| File | Changes |
|------|---------|
| `render.ts` | Refactor job detail sections; make peek activity-first; add artifact section helpers. |
| `types.ts` | No required changes unless artifact helper types are useful. |
| `contract.ts` | Clarify when to use status vs peek vs result. |
| `test/render.test.mjs` | Add tests for job detail sections and peek default/raw modes. |

## Test Cases

- Running job detail shows lifecycle, calls, recent activity, and next actions.
- Terminal isolated job detail shows branch, patch path, and changed files.
- `needs_input` job detail shows escalation question and continue hint.
- Peek default hides raw JSON event lines.
- Peek with `includeRawEvents: true` includes bounded raw event tail.
- Jobs with missing legacy metadata render without throwing.

## Open Questions

1. Should `subagent_peek` show assistant text excerpts by default, or only tool
   activity?
2. Should job detail include full cwd/worktree paths by default, or hide them
   unless expanded?
3. Should artifact paths be displayed as absolute paths or repo-relative paths?

