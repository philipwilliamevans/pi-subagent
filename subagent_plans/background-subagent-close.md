# Plan: Close Parked Interactive Background Jobs

## Goal

Add an explicit `subagent_close` tool for background jobs that are parked in
`needs_input`, so the parent can end an interactive subagent without waking the
child agent again.

This prevents farewell loops where the parent sends "thanks, that's all" via
`subagent_continue`, the child politely acknowledges, then asks for another
instruction and parks again.

## Problem

Interactive background jobs currently have one forward path when parked:

```text
subagent_continue(prompt)
  -> wake the child session
  -> child model decides how to respond
  -> framework decides whether it completed or parked again
```

That is appropriate when the user is giving the subagent more work. It is the
wrong abstraction when the user is dismissing the subagent.

Short closers such as "thanks" or "/done" can be ambiguous to the model. A
child agent that is prompted to keep offering next steps may respond with a
friendly acknowledgement plus another request for direction, creating a fresh
`needs_input` state and a fresh escalation ID.

The human should own the stop button. Ending a parked job should be a
parent-side lifecycle transition, not another model turn.

## Non-goals

- Do not change cancellation for running jobs. `subagent_cancel` remains the
  tool for active work.
- Do not add a new top-level background job status in the first slice.
- Do not wake the child process or send a final prompt to the child.
- Do not delete persisted job artifacts or session files.
- Do not implement attach/takeover mode.

## Proposed Behavior

`subagent_close` closes a background job only when it is parked in
`needs_input`.

It should:

1. Resolve the target by `escalationId` or `jobId`.
2. Validate that the job is currently `needs_input`.
3. Validate that the referenced escalation is still open.
4. Mark the open escalation as dismissed or answered.
5. Clear `waitingForInput`.
6. Mark the parked call state as `completed`.
7. Set the job status to `completed`.
8. Persist the job.
9. Persist or refresh the result artifact.
10. Emit a lifecycle event.
11. Post a compact notification.

The child agent is not resumed.

## Status Semantics

Use:

```typescript
job.status = "completed";
callState.phase = "completed";
```

Rationale:

- The subagent already produced useful work and was only asking whether to do
  more.
- `cancelled` suggests the work was aborted or invalid.
- `completed` makes the fleet view quiet and keeps the job available through
  `subagent_result`.

For the escalation, prefer adding a new status:

```typescript
status: "open" | "answered" | "dismissed" | "cancelled";
```

If the first implementation wants the smallest type change, use
`status: "answered"` with an answer such as:

```text
Closed by parent: no further action requested.
```

Longer term, `dismissed` is clearer because the user did not answer the
subagent's question; they ended the interaction.

## Tool Schema

```typescript
const SubagentCloseParams = Type.Object({
  jobId: Type.Optional(
    Type.String({
      description: "ID of the parked background job to close. Optional when escalationId is provided.",
    }),
  ),
  escalationId: Type.Optional(
    Type.String({
      description: "ID of the open escalation to close. Prefer this when available.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: "Optional parent-facing reason for closing the parked job.",
    }),
  ),
});
```

`confirm: true` is not required for the first slice. Closing is less destructive
than cancelling a running process and only applies to already-parked jobs.

## User-Facing Copy

Successful close:

```text
Closed waiting subagent job `subjob_ab12cd34`.

No further action was requested. The job is now completed.
Use `subagent_result` with jobId `subjob_ab12cd34` to inspect the captured output.
```

Wrong status:

```text
Job `subjob_ab12cd34` is running, not needs_input. Use `subagent_cancel` for running jobs.
```

Unknown escalation:

```text
Unknown open escalation: `esc_1234abcd`.
Use `subagent_status` to list waiting jobs.
```

## Parent-Agent Contract

Add guidance to `contract.ts`:

```text
Use `subagent_close` when an interactive background job is waiting for input
and the user says no further action is needed. Do not use `subagent_continue`
to say goodbye.

Use `subagent_continue` only when the user is giving the subagent more work or
answering its question.
```

This distinction is the core UX fix.

## Implementation

### Change 1: Types

In `types.ts`, either:

Small first slice:

```typescript
// no type change; use BackgroundEscalation.status = "answered"
```

Preferred:

```typescript
export interface BackgroundEscalation {
  status: "open" | "answered" | "dismissed" | "cancelled";
  closedAt?: number;
  closeReason?: string;
}
```

Add helper:

```typescript
export function dismissBackgroundEscalation(
  escalation: BackgroundEscalation,
  reason: string | undefined,
  now = Date.now(),
): BackgroundEscalation
```

### Change 2: Persistence

In `background-job-store.ts`:

- hydrate `dismissed` escalation status.
- round-trip optional `closedAt` / `closeReason` if added.
- keep legacy escalation handling intact.

### Change 3: Registry helper

Optionally add a helper in `background-jobs.ts`:

```typescript
export function getOpenEscalationById(escalationId: string): BackgroundOpenEscalation | undefined
```

This avoids duplicating lookup logic from `subagent_continue`.

### Change 4: Tool registration

In `index.ts`, register `subagent_close` near `subagent_continue`.

Handler outline:

```typescript
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  // root-only guard
  // resolve by escalationId or jobId
  // validate job.status === "needs_input"
  // validate job.waitingForInput exists and matches escalationId if supplied
  // mark escalation dismissed/answered
  // clear waitingForInput
  // set callState.phase = "completed"
  // set callState.completedAt if absent
  // set job.status = "completed"
  // update job.updatedAt
  // persistBackgroundJob(job)
  // persist result artifact if results exist
  // emit completed or closed lifecycle event
  // post compact close message
}
```

Do not call `runAgent`.

### Change 5: Rendering

Add:

```typescript
export function formatSubagentCloseAcknowledgement(job: BackgroundJob, reason?: string): string
```

Update job detail rendering so closed/dismissed escalation history is visible
without making the fleet row noisy:

```text
Escalations
  esc_1234abcd dismissed: No further action requested.
```

### Change 6: Lifecycle events

First slice can emit the existing terminal completed event:

```typescript
emitSubagentLifecycleEvent(pi, "pi-subagent:completed", job)
```

Future improvement:

```typescript
"pi-subagent:closed"
```

If adding `pi-subagent:closed`, update `subagent-events.ts` and tests.

### Change 7: Tool descriptions

In `contract.ts`, add:

- `formatSubagentCloseToolDescription()`
- close-vs-continue guidance in the background section
- example invocation

## File-by-file Changes

| File | Changes |
|------|---------|
| `types.ts` | Add dismissal helper and optionally escalation status/metadata fields. |
| `background-job-store.ts` | Hydrate/persist new escalation status and close metadata if added. |
| `background-jobs.ts` | Optional helper for open escalation lookup. |
| `index.ts` | Register `subagent_close`; implement parked-job close transition. |
| `render.ts` | Add close acknowledgement and closed escalation detail rendering. |
| `contract.ts` | Add tool description and parent-agent guidance. |
| `subagent-events.ts` | Optional `pi-subagent:closed` event. |
| `test/escalation.test.mjs` | Cover dismissal helper and metadata. |
| `test/background-job-store.test.mjs` | Cover persistence of dismissed escalation metadata. |
| `test/background-jobs.test.mjs` | Cover formatting for closed jobs/escalations. |
| `test/contract.test.mjs` | Assert contract says to use close instead of continue for goodbye. |

## Test Cases

- `subagent_close` rejects when neither `jobId` nor `escalationId` is provided.
- `subagent_close` resolves an open escalation by `escalationId`.
- `subagent_close` rejects stale/unknown escalation IDs and lists waiting jobs.
- `subagent_close` rejects running jobs and points to `subagent_cancel`.
- `subagent_close` rejects completed/failed/cancelled jobs as already terminal.
- Closing a `needs_input` job clears `waitingForInput`.
- Closing marks the escalation dismissed/answered.
- Closing marks the call phase completed.
- Closing marks the job completed.
- Closing does not call `runAgent`.
- Closing persists job state.
- Closing preserves existing results for `subagent_result`.
- Closing emits the expected lifecycle event.
- Closing posts compact acknowledgement text.
- Contract tells parent agents not to use `subagent_continue` to say goodbye.

## Open Questions

1. Should the first slice add `dismissed` to `BackgroundEscalation.status`, or
   encode closure as an `answered` escalation to reduce type churn?
2. Should `subagent_close` emit a new `pi-subagent:closed` event immediately,
   or reuse `pi-subagent:completed` until Agentflow consumers need the
   distinction?
3. Should close support `confirm: true`, or is the parked-only guard enough?
4. Should closing an interactive job with no results be `completed` or
   `cancelled`?
5. Should the fleet view show "completed (closed)" for recently closed jobs,
   or keep that detail only in `subagent_status { jobId }`?

