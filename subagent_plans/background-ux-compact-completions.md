# Plan: Compact Background Completion Notifications

## Goal

Stop dumping large subagent reports into the parent TUI when background jobs
complete. A completion message should be a compact notification that tells the
parent agent what happened and where to inspect the full result.

The report itself should remain available through `subagent_result`.

## Problem

`formatBackgroundCompletion` currently includes excerpts from subagent output.
That was useful when background jobs were a thin slice, but it now makes the
human view noisy:

- multiple background jobs can complete close together
- long review/exploration reports crowd out the active conversation
- the parent agent is tempted to narrate or act on partial excerpts
- artifacts such as result files, patches, and worktrees are not visually
  distinguished from chat text

## Non-goals

- No changes to job execution semantics.
- No changes to persisted result storage.
- No removal of `subagent_result`.
- No rich TUI layout redesign yet.
- No workflow DAG or Agentflow trace model.

## Desired Completion Shape

Default completion message:

```text
Background job subjob_ab12cd34 completed.

Agents: review, test
Duration: 2m14s
Result: 2 calls completed, 18 tool calls
Artifacts: result.md available

Next: use subagent_result with jobId subjob_ab12cd34 to inspect the full report.
```

Failure message:

```text
Background job subjob_ab12cd34 failed.

Agents: review
Duration: 41s
Error: child process exited with code 1

Next: use subagent_result with jobId subjob_ab12cd34 for captured output, or subagent_peek for recent events.
```

Isolated worktree message:

```text
Background job subjob_ab12cd34 completed in an isolated worktree.

Branch: codex/subjob_subjob_ab12cd34
Changed files: 4
Patch: .pi-subagent/jobs/subjob_ab12cd34/worktree.patch

Next: inspect with subagent_result before integrating changes.
```

## Implementation

### Change 1: Add compact completion formatter

In `render.ts`, split the current completion rendering into two concepts:

- compact notification for auto-injected follow-up messages
- full result formatting for `subagent_result`

Possible function names:

```typescript
export function formatBackgroundCompletionNotice(job: BackgroundJob): string
export function formatBackgroundCompletionLegacy(job: BackgroundJob): string
```

Or make compact the default:

```typescript
export function formatBackgroundCompletion(
  job: BackgroundJob,
  options?: { includeExcerpt?: boolean },
): string
```

Default should be `includeExcerpt: false`.

### Change 2: Keep full output in `subagent_result`

Do not remove `formatJobResults`. That remains the full report view.

If a compact notification mentions output size, derive it from existing result
messages but do not include the full text.

### Change 3: Special-case important states

Completion formatting should have separate paths for:

- `completed`
- `failed`
- `cancelled`
- `interrupted`
- `needs_input`

`needs_input` can remain more verbose than normal completion because it is a
human-facing question, but it should still hide marker/session plumbing.

### Change 4: Update parent-agent contract

In `contract.ts`, tell the parent agent:

- do not quote or summarize full result text from completion notifications
- use `subagent_result` when the user asks for details
- treat completion notifications as state changes, not reports
- use `subagent_status` for fleet overview

## File-by-file Changes

| File | Changes |
|------|---------|
| `render.ts` | Add compact completion formatter; reduce default injected completion text. |
| `index.ts` | Ensure `postCompletionMessage` uses the compact formatter. |
| `contract.ts` | Update background-job guidance for compact notifications and result retrieval. |
| `test/render.test.mjs` | Add/adjust tests for compact completion, failure, cancellation, isolated worktree metadata, and no large excerpts by default. |

## Test Cases

- Completed job notification contains job ID, status, agent names, and result command.
- Completed job notification does not include long final assistant output.
- Failed job notification includes error summary and next action.
- Isolated worktree job includes branch, changed file count, and patch path when available.
- `needs_input` notification still presents the question clearly.
- `subagent_result` still returns full output.

## Open Questions

1. Should compact completions include a one-line model-generated summary in the
   future, or should summaries always come from explicit `subagent_result`?
2. Should completed jobs with zero output be louder because they may indicate a
   child failure hidden by process semantics?
3. Should `onComplete: "message"` and `"trigger"` use identical compact text?

