# Plan: Wire `markPendingCallsCancelled` into the Cancel Handler

## Goal

Call `markPendingCallsCancelled` from the `subagent_cancel` execute handler so that pending call states are immediately marked `cancelled` when cancellation is confirmed, and `finishCallState` preserves those states when workers return aborted results.

This closes the last remaining gap in the lifecycle‑state‑correctness work: the helpers exist and are tested, but are disconnected from the cancellation code path.

## Non-goals

- No changes to `markPendingCallsCancelled` or `finishCallState` themselves — their behaviour is already correct and tested.
- No changes to the synchronous `subagent` tool.
- No changes to persistence, status rendering, or activity tracking.

## Current Problem

The `subagent_cancel` handler in `index.ts` (around line 1252) does this:

```ts
// Proceed with cancellation
job.status = "cancelling";
job.updatedAt = Date.now();
job.abortController?.abort();
```

It never calls `markPendingCallsCancelled`. The later flow is:

1. Workers receive the abort signal and terminate.
2. `runAgent` returns with an aborted result (`exitCode 130`).
3. `finishCallState(job, index, result, now)` is called, but **its first guard** checks:

```ts
if ((job.status === "cancelling" || job.status === "cancelled") && cs.phase === "cancelled")
```

Since no one set `cs.phase` to `cancelled`, this guard never fires. The call is still in `running` phase.

4. `finishCallState` falls through to the normal terminal transition and marks the call as **`failed`** (the aborted result is treated as an error by `isResultError`).
5. Later, the job‑level status is corrected to `cancelled` (line 1602–1603), but the individual call states now say `failed`.

**Result:** `subagent_status` shows the job as `cancelled` but unfinished calls as `failed` — the exact inconsistency the lifecycle plan was designed to eliminate.

## Proposed Behaviour

Add one line to the cancel handler:

```ts
// Proceed with cancellation
job.status = "cancelling";
job.updatedAt = Date.now();
markPendingCallsCancelled(job, Date.now());    // ← new
job.abortController?.abort();
```

This immediately sets all `queued`, `spawning`, and `running` call phases to `cancelled` (with `completedAt`). When `finishCallState` later processes the aborted result from each worker, its first guard finds `cs.phase === "cancelled"` and preserves the cancelled status.

### What the call does

`markPendingCallsCancelled(job, now)` iterates `job.callStates` and for every call whose phase is `queued`, `spawning`, or `running`:
- Sets `phase = "cancelled"`
- Sets `completedAt = now` if not already set
- Leaves `completedAt` intact if already present (e.g., a previously‑completed call)

It does **not** touch already‑terminal calls (`completed`, `failed`, `cancelled`), so calls that finished before the cancellation keep their correct states.

## Implementation Notes

**`index.ts` changes:**

1. Add the import at the top of the file (near the existing `finishCallState` import):

```ts
import {
  markPendingCallsCancelled,
  finishCallState,
} from "./background-lifecycle.js";
```

Currently only `finishCallState` is imported:

```ts
import { finishCallState } from "./background-lifecycle.js";
```

2. In the `subagent_cancel` execute handler, add the call after setting `job.status`:

```ts
// Proceed with cancellation
job.status = "cancelling";
job.updatedAt = Date.now();
markPendingCallsCancelled(job, Date.now());   // ← new line
job.abortController?.abort();
```

**No other file changes needed.** `markPendingCallsCancelled` works directly on the shared `job.callStates` array — the same array that `finishCallState` reads later in `runBackgroundSubagentJob`. There's no race because both run on the same thread (JavaScript event loop).

## Tests

The unit tests in `test/background-lifecycle.test.mjs` already verify:
- `markPendingCallsCancelled` sets queued/spawning/running to cancelled (3 test cases).
- It preserves completed, failed, and already‑cancelled states (2 test cases).
- `finishCallState` preserves cancelled phases set by `markPendingCallsCancelled` (4 test cases, including the simulated cancellation flow).

**No new unit tests needed** for the helpers themselves. Add an integration‑level test:

- Start a background job, cancel it with `confirm: true`, verify the job status is `cancelled` and all unfinished call states are `cancelled` (not `failed`). This tests the wired‑together path through `index.ts`.

Since `runBackgroundSubagentJob` and `subagent_cancel` are embedded in `index.ts`, this is best tested via an end‑to‑end script or by inspecting the `BackgroundJob` object after cancellation in a controlled test that calls the tool's execute handler.

## Definition of Done

- The `subagent_cancel` handler calls `markPendingCallsCancelled` after setting the job status to `cancelling`.
- After a cancellation, all `queued`, `spawning`, and `running` calls show phase `cancelled` (not `failed` or `completed`).
- Calls that completed before the cancellation keep their `completed`/`failed` phase.
- The job status is `cancelled`.
- `npm test` passes.
- Tool descriptions in `contract.ts` remain accurate (no changes needed).

## Relationship to Other Plans

This is the **final piece** of the lifecycle‑state‑correctness work. Once merged, Plan 1 from the roadmap is fully implemented. The only remaining risk‑hardening work is **Plan 5: Shared‑Worktree Safety Phase 2** (actual git worktree creation).
