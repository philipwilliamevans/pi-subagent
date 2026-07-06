# Plan: Per-Call Completion Notifications with Trigger

## Goal

When a background job runs multiple calls, each call should inject its own
completion notification (with trigger) the moment it finishes, rather than
waiting for all calls to complete before sending a single combined message.

This lets the parent agent act on early results and gives the human a
progressive view of job progress without polling `subagent_status`.

## Problem

Currently `runBackgroundSubagentJob` runs all calls via `mapConcurrent` and
awaits every branch before calling `postCompletionMessage` once:

```
results = await mapConcurrent(calls, MAX_CONCURRENCY, runCall);
// all calls done here
postCompletionMessage(job);  // single notification
```

For a 2-call job where call A finishes in 1m57s and call B takes 2m09s, no
notification fires at t=1m57s. The parent sees nothing until t=2m09s when
both appear simultaneously. This defeats the purpose of firing multiple
agents concurrently — the parent cannot act on early results.

## Design

### Per-call completion message

Fires inside the `mapConcurrent` callback as soon as each individual call
completes. Very compact — no excerpts, no job-level summary.

```text
Call 1/2 (explorer) in job subjob_abc123 completed.

Agent: explorer
Duration: 1m 57s
Result: completed, 49 tool calls

Next: use subagent_result with jobId subjob_abc123 to inspect this call.
```

Variants for different per-call statuses:

```text
Call 1/2 (review) in job subjob_abc123 failed.

Agent: review
Duration: 41s
Error: child process exited with code 1

Next: use subagent_result with jobId subjob_abc123 for captured output, or subagent_peek for recent events.
```

```text
Call 1/2 (review) in job subjob_abc123 was cancelled.

Agent: review
Duration: 30s
```

For single-call jobs, the per-call message IS the job-level message (no
second notification needed — see Edge Cases below).

### Job-level completion message

Fires after ALL calls are done, but reduced to a brief "all-done" summary
since per-call details were already delivered:

```text
All calls in job subjob_abc123 completed.

Duration: 2m 9s
Result: 2/2 calls completed, 96 tool calls

Next: use subagent_result to inspect individual call results, or subagent_status for the fleet view.
```

```text
All calls in job subjob_abc123 finished. Some calls failed.

Duration: 2m 9s
Result: 1/2 calls completed, 1 failed

Use subagent_status to inspect.
```

Worktree metadata appears only in the job-level message (it's collected
after all calls finish):

```text
All calls in job subjob_abc123 completed in an isolated worktree.

Duration: 2m 9s
Branch: codex/subjob_subjob_abc123
Changed files: 4
Patch: .pi-subagent/jobs/subjob_abc123/worktree.patch

Next: inspect with subagent_result before integrating changes.
```

### Trigger semantics

Each per-call notification uses the job's `onComplete` mode:

| `onComplete` | Per-call behavior | Job-level behavior |
|---|---|---|
| `"trigger"` | Each call fires a `followUp` with `triggerTurn: true` | Fires a final `followUp` with `triggerTurn: true` |
| `"message"` | Each call fires a `followUp` with `triggerTurn: false` | Fires a final `followUp` with `triggerTurn: false` |
| `"silent"` | Nothing | Nothing |

Single-call jobs skip the extra job-level notification to avoid a redundant
double-trigger (see Edge Cases).

### Custom type conventions

Per-call messages use `customType: "subagent-call-completed"`.
Job-level messages continue to use `customType: "subagent-background-result"`.
This lets the parent agent distinguish between per-call progress and
job-level completion (relevant for plan queue).

## Changes by File

### `types.ts` — Add notified-call tracking

Add to `BackgroundJob`:

```typescript
/** Tracks which call indices have already had their completion message sent. */
callCompletionNotified?: boolean[];
```

Initialized at job creation as `new Array(calls.length).fill(false)`.
This prevents double-sending if a call completes and then the job-level
handler also tries to notify it.

### `render.ts` — Add per-call formatter

New function:

```typescript
export function formatCallCompletion(
  job: BackgroundJob,
  result: SingleResult,
  callIndex: number,
): string
```

Compact form that shows:
- `Call {index+1}/{total} ({agent}) in job {id} {status}.`
- Agent, duration, per-call result (completed/failed/cancelled), tool calls
- Error line for failed calls
- Next-action line (`subagent_result` with jobId)

Does NOT show worktree metadata, job-level artifacts, or job-level result
aggregation.

Job-level `formatBackgroundCompletion` should be reduced when per-call
messages are active:
- Remove the per-call detail loop (already shown per-call)
- Keep job-level aggregate: duration, result summary, worktree metadata,
  artifacts, fleet-status hint
- Headline changes from `"Background job {id} completed."` to
  `"All calls in job {id} completed."`

The reduction is conditional — single-call jobs skip per-call messages
entirely and fall back to the current full job-level format.

### `index.ts` — Fire per-call in mapConcurrent callback

**New function `postCallCompletion`**:

```typescript
function postCallCompletion(
  job: BackgroundJob,
  result: SingleResult,
  callIndex: number,
): void
```

Sends a `subagent-call-completed` message with `formatCallCompletion`.
Honors `job.onComplete` for trigger vs message vs silent.
Marks `callCompletionNotified[callIndex] = true` to prevent double-send.

**Modified `runBackgroundSubagentJob`**:

In the `mapConcurrent` callback, after `runBackgroundCall` resolves, call
`postCallCompletion` before returning the result:

```typescript
const results = await mapConcurrent(
  job.calls, MAX_BACKGROUND_CONCURRENCY,
  async (call, index) => {
    const result = await runBackgroundCall(job, call, index, ...);
    if (job.calls.length > 1) {
      postCallCompletion(job, result, index);
    }
    return result;
  },
);
```

After `mapConcurrent`, call `postJobCompletion` instead of the current
`postCompletionMessage`:

```typescript
postJobCompletion(job);
```

**New function `postJobCompletion`** (replaces `postCompletionMessage` for
the job-level path):

Similar to the current `postCompletionMessage`, but:
- For multi-call jobs, uses the reduced job-level format
- For single-call jobs, uses the existing full `formatBackgroundCompletion`
  (same as today — no double message)
- Always calls `processPlanQueue` after sending
- Skips sending entirely if `onComplete === "silent"`

**Modified `continueBackgroundSubagentJob`**:

Continuation of a needs_input job is always single-call (interactive
background jobs are single-call only). The current behavior is correct —
one notification when the continuation finishes. No per-call changes needed
here.

### `contract.ts` — Update guidance

Add to the background jobs section in `formatAvailableSubagentsPrompt`:

> **Per-call completion:** Multi-call background jobs now fire a completion
> notification as each individual call finishes, not just when all calls
> are done. The per-call message tells you which call completed and its
> result. When all calls finish, a final job-level message gives the
> aggregate summary.
>
> You can inspect individual call results immediately via `subagent_result`
> with `callIndex`. Use `subagent_status` to see which calls are still
> running.

Update `formatSubagentStartToolDescription` to mention per-call behavior.

Update `formatSubagentResultToolDescription` to clarify that per-call
results are available immediately after each per-call notification.

## Edge Cases

### Single-call jobs

When `job.calls.length === 1`, skip the per-call message entirely. The
job-level message uses the current full `formatBackgroundCompletion` format.
This avoids an unnecessary double-notification and preserves the current
behavior for the most common case (single-call `subagent_start`).

Implementation: check `job.calls.length > 1` before calling
`postCallCompletion` inside the `mapConcurrent` callback.

### Cancellation mid-flight

If a job is cancelled while calls are running:
- Calls that already completed got their per-call message at completion time.
- Calls that were terminated by cancellation do NOT get a per-call message.
- The job-level `postJobCompletion` fires with status `"cancelled"`.

The `callCompletionNotified` array distinguishes which calls already fired.

### Plan queue

`processPlanQueue` checks `arePlanDepsTerminal` which looks at job-level
status. Plans should NOT fire on per-call notifications — only on the
final job-level `postJobCompletion`. This is already correct because
`processPlanQueue` is called from `postJobCompletion`, not from
`postCallCompletion`.

### needs_input / interactive jobs

Interactive background jobs are single-call only (validated at start time),
so the single-call edge case handles them. No per-call message, no change
to the escalation flow.

### Worktree mode

Worktree metadata is collected after all calls finish (it needs the
completed worktree state). Per-call messages never include worktree info.
The job-level message uses `formatBackgroundCompletion` with the existing
worktree metadata path — no change needed.

### `onComplete: "silent"`

`postCallCompletion` checks `job.onComplete === "silent"` at the top and
returns immediately if so. Same pattern as the current `postCompletionMessage`.

### Persisted jobs reloaded from disk

Reloaded jobs have `callCompletionNotified: undefined`. When a persisted
job reaches a terminal state after reload (e.g., was `"cancelling"` and
is upgraded to `"interrupted"`), `postCompletionMessage` fires. Since no
per-call messages were sent before persistence, the job-level message
uses the current format (no per-call info needed for terminal reloads).

## Open Questions

1. **Should the job-level message be omitted entirely for multi-call jobs
   when `onComplete: "trigger"`?** The per-call messages already trigger
   turns, and by the time the last call finishes, the parent may have already
   acted on that call's notification. A brief "All calls done" may still be
   useful for plan-queue activation and fleet awareness.

2. **Should per-call notifications include a `callIndex` in the message
   details for routing?** Currently the `subagent-background-result` message
   carries `details.jobId`. Per-call messages could carry
   `details: { jobId, callIndex, agent }` so the parent agent knows which
   call result it's looking at without parsing the text.

3. **What about the `subagent-call-completed` customType?** If the parent
   agent isn't trained to recognize it, it might treat it like any other
   follow-up message. Should the text itself be self-explanatory (which
   the proposed format is), or should we add system prompt instructions
   about how to handle this message type?

4. **Should a fast call failure immediately cancel still-running sibling
   calls?** Currently no — all calls run to completion regardless of
   sibling results. If per-call notifications let the parent see a failure
   early, it could choose to `subagent_cancel` the job. But auto-cancelling
   on first failure would be a separate feature.
