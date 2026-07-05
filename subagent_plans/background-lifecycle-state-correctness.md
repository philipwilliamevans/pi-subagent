# Plan: Background Lifecycle State Correctness

## Goal

Make background job and per-call lifecycle states internally consistent and user-visible status accurate during start, cancellation, and completion.

This covers two known risks:

1. Cancellation can mark the job `cancelled` while individual calls later show `failed` or `completed`.
2. A call can remain `spawning` until the first tool call, so long reasoning without tools can look stuck.

## Non-goals

- No durable job persistence.
- No per-call cancellation API.
- No worktree isolation.
- No changes to the synchronous `subagent` tool.
- No new background collection/waiting tool.

## Recommended Implementation Order

Implement this first among the risk-hardening plans.

## Current Problem

The background runner sets each call to `spawning` before `runAgent`, then changes it to `completed` or `failed` from the returned `SingleResult`. Cancellation is represented at the job level by `cancelling` and then `cancelled`, but final result mapping can still leave call states looking like ordinary failures or successes.

Separately, `running` is inferred from observed tool calls in `updateCallStateFromPartial`. If the child process spends a long time reasoning or writing final text before tool use, the status can remain `spawning`.

## Proposed Behavior

- When `subagent_cancel` is confirmed:
  - Set the job to `cancelling`.
  - Immediately mark all `queued`, `spawning`, and `running` call states as `cancelled`.
  - Set `completedAt` on any call that has no completion timestamp.
- While `runBackgroundSubagentJob` settles:
  - If the job is `cancelling` or `cancelled`, preserve `cancelled` call phases for unfinished calls.
  - Do not overwrite a cancelled call state with `failed` or `completed` unless the call had already reached a terminal state before cancellation.
- When a worker actually starts `runAgent`:
  - Transition from `queued` to `running` quickly, or use `spawning` only for a very brief process-start window.
  - Record `startedAt` when the worker picks up the call.
  - Record `spawnedAt` when there is evidence the process is alive, if that signal exists.
- Status rendering should show:
  - `queued` for calls not yet picked up by a worker.
  - `running` for calls actively executing even if they have not made a tool call.
  - `cancelled` for calls cancelled before or during execution.

## Implementation Notes

- Prefer a small helper such as `markPendingCallsCancelled(job, now)` so cancellation semantics are centralized.
- Add a second helper for terminal transitions, for example `finishCallState(job, index, result, now)`, that refuses to overwrite `cancelled` during job cancellation.
- If `runAgent` does not expose a precise "child spawned" callback, treat the awaited `runAgent` call boundary as running for user-facing status. This is more useful than showing `spawning` for long reasoning periods.
- Keep `normalizeCompletedResult` unchanged unless tests prove the issue belongs there. The job/call lifecycle should not depend on process exit semantics alone.

## Tests

Add focused tests for:

- Confirmed cancellation marks queued, spawning, and running call states as `cancelled`.
- Final aborted results do not overwrite `cancelled` call states as `failed`.
- A worker-picked-up call renders as `running` before any tool call appears.
- Completed calls that finished before cancellation keep their completed/failed phase, while unfinished calls become cancelled.

## Definition of Done

- `subagent_status` cannot show a job as `cancelled` while unfinished calls show ordinary `failed` or `completed` states caused by the abort.
- A long-running call without tool calls does not sit indefinitely in `spawning`.
- Background completion output consistently labels cancelled calls as cancelled.
- Existing successful and failed completion behavior is unchanged.
- `npm test` passes.
