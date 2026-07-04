# Plan: Background Job Status & Cancel

This plan covers two companion tools — `subagent_status` and `subagent_cancel` — that close the most immediate UX gaps after the background start slice.

## Goals

1. **`subagent_status`** — Query the state of a running or completed background job by ID, or list all known jobs.
2. **`subagent_cancel`** — Gracefully terminate a running background job and its child processes, then inject a cancellation message.

Both tools are read‑only / confirm‑gated to avoid accidental state changes without user intent.

## Non‑goals

- No persisted job recovery after parent Pi exit.
- No cancellation of individual calls within a multi‑call job — cancel is all‑or‑nothing per job.
- No DAG/workflow awareness.
- No worktree isolation.
- No named persistent session cleanup (cancelling a background job does not clean unrelated session locks).

---

## Tool 1: `subagent_status`

### User‑facing behavior

List a specific job:

```json
{ "jobId": "subjob_abc123" }
```

Output:

```
subjob_abc123: running, 2 calls, started 90s ago
  explorer — running (0s elapsed)
  reviewer — queued
```

Or list all jobs (omit `jobId`):

```json
{}
```

Output:

```
Background subagent jobs:

  subjob_abc123: running, 2 calls, started 90s ago
  subjob_def456: completed, 1 call, took 24s (finished 5m ago)
  subjob_ghi789: failed, 1 call, took 12s (finished 7m ago)

0 running, 2 completed, 1 failed
```

### Parameter schema

```ts
const SubagentStatusParams = Type.Object({
  jobId: Type.Optional(
    Type.String({ description: "Job ID to inspect. Omit to list all jobs." }),
  ),
});
```

### Implementation

- Read‑only, no confirmation needed.
- Look up `jobId` via `getBackgroundJob(id)` from `background-jobs.ts`.
- Fall back to `getAllBackgroundJobs()` when `jobId` is omitted.
- Format using a new helper `formatJobStatus(job)` and `formatJobList(jobs)` in `render.ts`.
- Per‑call status: iterate `job.calls` and cross‑reference with `job.results` (or lack thereof) to show "running", "queued", "completed", or "failed".
- Already‑completed jobs show elapsed time (`formatDuration` already exists in `render.ts`).
- `renderCall` shows a compact summary line; `renderResult` shows the formatted status text.

### Edge cases

- `jobId` is unknown → error message with available IDs.
- No jobs exist and no `jobId` → "No background subagent jobs."
- Running job where the child process crashed externally → status shows "running" until the next heartbeat or completion callback updates it. Acceptable for thin slice.

---

## Tool 2: `subagent_cancel`

### User‑facing behavior

```json
{ "jobId": "subjob_abc123" }
```

Output (immediate):

```
Cancelling background job subjob_abc123...

The subagent processes will be terminated. A cancellation message will be posted when the job has stopped.
```

Completion message (injected after clean‑up):

```
Background subagent job subjob_abc123 was cancelled (took 34s).

- explorer call 1: cancelled
- reviewer call 2: cancelled
```

If the job has already completed:

```
Job subjob_abc123 is already completed. Nothing to cancel.
```

### Parameter schema

```ts
const SubagentCancelParams = Type.Object({
  jobId: Type.String({ description: "ID of the background job to cancel." }),
  confirm: Type.Optional(
    Type.Boolean({ description: "Explicit confirmation flag.", default: false }),
  ),
});
```

### Internal data model changes

Add an `AbortController` to `BackgroundJob`:

```ts
export interface BackgroundJob {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: BackgroundJobStatus;
  calls: NormalizedCall[];
  promise: Promise<void>;
  results?: SingleResult[];
  error?: string;
  onComplete: BackgroundCompletionMode;
  /** AbortController for cancellation. Created when the job starts. */
  abortController?: AbortController;
}
```

### Execution flow

1. Look up the job by ID.
2. If not found → error.
3. If status is not `"running"` → inform caller the job is already `status`, nothing to cancel.
4. If `confirm` is not true → dry‑run message showing what would be cancelled.
5. Set job status to `"cancelling"` (new status).
6. Call `job.abortController.abort()`:
   - This fires the `AbortSignal` passed to each running `runAgent` call.
   - Each `runAgent` terminates its child process via the existing signal handler (`terminateChild()`).
   - `runAgent` returns a `SingleResult` with `wasAborted: true`.
7. The `mapConcurrent` loop in `runBackgroundSubagentJob` finishes (all runAgent calls settle).
8. `runBackgroundSubagentJob` checks: if status is `"cancelling"` or `"cancelled"`, set status to `"cancelled"` and inject a cancellation message (distinct from completion).

Alternatively, make cancellation fire‑and‑forget: return immediately with "cancelling..." and let the running promise update the job when `mapConcurrent` finishes. This matches the pattern of `subagent_start` and avoids blocking the parent turn.

### New status: `"cancelling"` and `"cancelled"`

Add to the type:

```ts
export type BackgroundJobStatus =
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";
```

Semantics:
- `"running"` — subagent processes are executing.
- `"cancelling"` — `abort()` was called; processes are being terminated.
- `"cancelled"` — all processes have exited due to cancellation.
- `"completed"` / `"failed"` — unchanged from existing semantics.

The `getActiveBackgroundJobCount` function should count `"running"` and `"cancelling"` jobs as active.

### AbortController wiring in `index.ts`

When creating the background job in `subagent_start.execute(...)`:

```ts
const abortController = new AbortController();

const job: BackgroundJob = {
  id: jobId,
  createdAt,
  updatedAt: createdAt,
  status: "running",
  calls,
  promise: Promise.resolve(),
  onComplete,
  abortController,
};

job.promise = runBackgroundSubagentJob(
  job,
  agents,
  ctx.cwd,
  makeDetails,
);
```

And in `runBackgroundSubagentJob`:

```ts
async function runBackgroundSubagentJob(
  job: BackgroundJob,
  agents: AgentConfig[],
  defaultCwd: string,
  makeDetails: ReturnType<typeof makeDetailsFactory>,
): Promise<void> {
  try {
    const results = await mapConcurrent(
      job.calls,
      MAX_BACKGROUND_CONCURRENCY,
      async (call) => {
        return await runAgent({
          ...
          signal: job.abortController?.signal,
          ...
        });
      },
    );

    // Determine final status
    if (job.status === "cancelling") {
      job.status = "cancelled";
    } else {
      const hasError = results.some((r) => isResultError(r));
      job.status = hasError ? "failed" : "completed";
    }

    job.results = results;
    job.updatedAt = Date.now();
    postCompletionMessage(job);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = Date.now();
    postCompletionMessage(job);
  }
}
```

### Cancellation message formatting

Add a new formatter or extend `formatBackgroundCompletion` to handle `"cancelled"` status.

```ts
export function formatBackgroundCompletion(job: BackgroundJob): string {
  const duration = job.createdAt ? formatDuration(Date.now() - job.createdAt) : "";
  const durationLine = duration ? ` (took ${duration})` : "";

  let statusLabel: string;
  if (job.status === "cancelled") {
    statusLabel = "was cancelled";
  } else if (job.status === "failed") {
    statusLabel = "completed with errors";
  } else {
    statusLabel = "completed successfully";
  }
  ...
```

Rendering: for cancelled calls, show "cancelled" instead of "failed" in the per‑call line. Use the `stopReason` from each result — if it's `"aborted"`, label it "cancelled".

### Cancellation message injection

Use `postCompletionMessage` as-is — the trigger/message/silent mode from the original job controls delivery. For cancellation, `trigger` makes sense as default so the parent reacts.

### Tool confirm gating

Follow the existing pattern from `gitlab_mr_merge` and other mutating tools:

```ts
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  if (!params.confirm) {
    return {
      content: [{ type: "text", text: `Dry-run: would cancel background job ${params.jobId} with X running call(s). Pass "confirm": true to proceed.` }],
      isError: true,
    };
  }
  ...
}
```

---

## Tests

### Unit tests for `subagent_status`

- Format a running job → output contains "running" and call count.
- Format a completed job → output contains "completed" and duration.
- Format a failed job → output contains "failed".
- Unknown `jobId` → error message.
- List all when empty → "No background subagent jobs."
- List all with mixed states → shows running/completed/failed counts.

### Unit tests for `subagent_cancel`

- Cancel a running job → status transitions to cancelling → cancelled.
- Cancel a completed job → error message (already done).
- Cancel unknown job → error message.
- Cancel without confirm → dry‑run message, no state change.
- Cancelled job does not count as active in `getActiveBackgroundJobCount`.

### Registry tests

- `getActiveBackgroundJobCount` excludes `"completed"`, `"failed"`, `"cancelled"` jobs.
- `getActiveBackgroundJobCount` includes `"cancelling"` jobs.

### Existing tests to update

- `types.ts` — new `BackgroundJobStatus` union member may need test updates if any code pattern‑matches on the type.
- `render.ts` — existing `formatBackgroundCompletion` tests should verify the cancellation message format.
- `background-jobs.test.mjs` — add tests for new status values.

---

## Manual validation

1. Start Pi with `pi -e .`
2. Start a background job with a long‑running prompt (e.g. "Read the entire repo and summarize").
3. Immediately query with `subagent_status { "jobId": "subjob_..." }` — confirm it shows running.
4. Cancel the job with `subagent_cancel { "jobId": "subjob_...", "confirm": true }`.
5. Verify cancellation message is injected.
6. Query status again — confirm job shows as cancelled.
7. Try cancelling the same job again — confirm error message.
8. Try cancelling without `confirm` — confirm dry‑run message.
9. Try status with an unknown ID — confirm error message.
10. Try status with no ID — confirm list of all jobs.
11. Start two background jobs, cancel one, verify the other continues and completes normally.

---

## Risks and accepted limitations

### Race: cancel arrives as job finishes naturally

If `subagent_cancel` fires `abort()` at the same moment the subagent processes are exiting naturally, the status may flicker between `"cancelling"` and the natural completion path. The `runBackgroundSubagentJob` function checks `job.status` after `mapConcurrent` settles: if it sees `"cancelling"`, it sets `"cancelled"`. If the natural completion path wins the race, the job shows as `"completed"` or `"failed"`. This is acceptable — the child processes were terminated either way.

### Orphaned child processes on unclean parent exit

No change from thin slice. If the parent Pi dies, child processes may be orphaned. Out of scope.

### No partial cancellation

Cancelling a 4‑call job where 2 calls already finished terminates the remaining 2. The finished results are preserved in `job.results`. The per‑call display shows finished calls as "completed" and cancelled calls as "cancelled". No support for "cancel only call 3".

---

## Success criteria

- `subagent_status` returns formatted job info for any known job ID.
- `subagent_status` without arguments lists all jobs.
- `subagent_cancel` terminates running subagent processes via AbortSignal.
- `subagent_cancel` with `confirm: true` transitions the job to cancelled.
- `subagent_cancel` without confirm does not mutate state.
- Cancellation messages are injected into the parent session.
- Both tools follow existing patterns (TypeBox schemas, `render.ts` formatting, `renderCall`/`renderResult`).
- All existing tests pass.
