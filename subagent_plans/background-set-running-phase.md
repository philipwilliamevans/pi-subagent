# Plan: Set `running` Phase When Worker Picks Up a Call

## Goal

Ensure a background subagent call transitions through the `running` phase when a worker actually starts executing it, so that `subagent_status` never shows `spawning` for a call that has been running for a long time.

This closes the known risk that a call remains `spawning` until the first tool call, so long reasoning without tools can look stuck.

## Non-goals

- No changes to cancellation semantics (already correct via `background-lifecycle.ts`).
- No changes to the `interrupted`, `queued`, `cancelled`, `completed`, or `failed` phases.
- No changes to synchronous `subagent` tool behaviour.
- No changes to the `updateCallStateFromPartial` activity-tracking module.
- No durable persistence changes.

## Recommended Implementation Order

Implement before or together with any status rendering changes. This is a small, targeted fix that makes subagent_status accurate for running calls.

## Current Problem

The call-state lifecycle in `runBackgroundSubagentJob` (in `index.ts`) currently does this:

1. **Job creation** (in `subagent_start.execute`): all calls start as `queued`.
2. **Bulk phase shift** (`runBackgroundSubagentJob` entry): all calls are set to `spawning` before any worker picks them up — even calls that won't be started until a concurrent worker slot frees up.
3. **Worker runs** (`mapConcurrent` callback): each call is already `spawning`. The worker never transitions to `running`. It stays `spawning` until `runAgent` returns.
4. **Result arrives**: phase jumps directly to `completed` or `failed`.

This means a call that spends 60 seconds reasoning before its first tool call is shown as `spawning` for the entire duration, making it look stuck or not yet started.

Additionally, calls that are queued behind the concurrency limit (max 2) are shown as `spawning` even though no process has been spawned for them — they are still waiting for a worker slot.

## Proposed Behaviour

- When `runBackgroundSubagentJob` starts, all calls remain `queued`. Do not bulk-set them to `spawning`.
- Inside each per-call worker (the `mapConcurrent` callback), immediately before `await runAgent(...)`:
  - Set `cs.phase = "spawning"` (brief window: process spawn startup).
  - Set `cs.startedAt = Date.now()`.
  - Then immediately set `cs.phase = "running"` (the process is now executing).
- Remove the upfront bulk loop that sets all calls to `spawning` at function entry.
- `updateCallStateFromPartial` (called from `onUpdate`) already has logic that transitions `spawning` → `running` internally when it records tool-call evidence via `spawnedAt`, but the explicit phase transition needs to happen at the `runAgent` call boundary as the plan originally specified.
- Status rendering (`formatJobStatus` + `formatCallStatusLine`) already displays the phase label and elapsed time for `running` calls — no rendering changes needed.

### Detailed state diagram

```
queued
  │
  │  (worker picks up the call)
  ▼
spawning    ←─ brief, set just before runAgent
  │
  │  (runAgent begins — process is alive)
  ▼
running     ←─ set immediately after spawning
  │
  ├── cancelled  ←─ if cancellation confirmed while running
  ├── completed  ←─ runAgent returned success
  └── failed     ←─ runAgent returned error
```

## Implementation Notes

The only code change is in `runBackgroundSubagentJob` in `index.ts`. Here is the current execution path:

```ts
// Current (simplified):
async function runBackgroundSubagentJob(job, ...) {
  // BULK — marks ALL calls as spawning upfront:
  for (const [index, call] of job.calls.entries()) {
    const cs = job.callStates[index];
    cs.phase = "spawning";
    cs.startedAt = Date.now();
  }

  const results = await mapConcurrent(job.calls, MAX_BACKGROUND_CONCURRENCY,
    async (call, index) => {
      const cs = job.callStates[index];
      // cs is already "spawning" from the bulk loop above
      const result = await runAgent({...});
      cs.phase = isResultError(result) ? "failed" : "completed";
      cs.completedAt = Date.now();
      return result;
    },
  );
  ...
}
```

Replace with:

```ts
// Proposed:
async function runBackgroundSubagentJob(job, ...) {
  // No bulk loop — calls stay as "queued" until a worker picks them up.

  const results = await mapConcurrent(job.calls, MAX_BACKGROUND_CONCURRENCY,
    async (call, index) => {
      const cs = job.callStates[index];
      cs.phase = "spawning";
      cs.startedAt = Date.now();
      // Brief spawning window ends, process is alive:
      cs.phase = "running";

      const result = await runAgent({...});
      // Phase transition based on result (preserve cancelled if aborted):
      if (job.status === "cancelling" || job.status === "cancelled") {
        // finishCallState already handles this; runAgent returned an aborted result.
        // But the final result handling below still uses isResultError logic.
        // Use finishCallState here if the result-flow is refactored, or let
        // the existing markPendingCallsCancelled + finishCallState pattern handle it.
      }
      cs.phase = isResultError(result) ? "failed" : "completed";
      cs.completedAt = Date.now();
      return result;
    },
  );
  ...
}
```

**Important**: The cancellation flow in `background-lifecycle.ts` already handles the case where a `running` call is marked `cancelled` by `markPendingCallsCancelled`. This means if cancellation fires between `cs.phase = "running"` and `await runAgent(...)` returning, the worker result will hit `finishCallState` which refuses to overwrite `cancelled`. The current code does not call `finishCallState` explicitly — it just does `cs.phase = isResultError(...) ? "failed" : "completed"`. Because the cancellation helpers run synchronously on the job object (which is shared), and the worker later sets `cs.phase` unconditionally, there is a **subtle race**: the worker could overwrite a `cancelled` phase set by `markPendingCallsCancelled`.

To be safe, the final phase transition should use `finishCallState` instead of directly setting the phase. Replace:

```ts
cs.phase = isResultError(result) ? "failed" : "completed";
cs.completedAt = Date.now();
```

with:

```ts
finishCallState(job, index, result, Date.now());
```

This ensures that if the call was cancelled mid-flight, the cancelled phase is preserved.

## Tests

The existing `test/background-lifecycle.test.mjs` tests already verify the helpers. Add new tests focused on the `runBackgroundSubagentJob` integration:

- A call moves from `queued` → `spawning` → `running` during execution, not staying in `spawning`.
- Calls behind the concurrency limit remain `queued` until a worker slot opens.
- If cancellation fires while a call is `running`, the final phase stays `cancelled` not `failed` or `completed` (this tests the `finishCallState` integration).
- `subagent_status` shows `running` for actively executing calls and `queued` for queued ones.

Because `runBackgroundSubagentJob` is embedded in `index.ts` and not directly exported, test at the seams:
- Unit-test the phase transitions by calling `finishCallState` directly (already done).
- Integration-test the full job lifecycle by creating a background job and polling `subagent_status` during simulated execution, or by using a small mock `runAgent` that yields and checks intermediate call states.

## Definition of Done

- A long-running background subagent call without tool calls does not sit indefinitely in `spawning`; it shows as `running` after the process starts.
- Calls that are waiting for a concurrency slot show as `queued`, not `spawning`.
- Cancellation mid‑`running` does not leave the call showing an ordinary `failed` or `completed` phase.
- Existing successful, failed, cancelled, and interrupted completion behaviour is unchanged.
- `npm test` passes.
- Tool descriptions in `contract.ts` remain accurate (no changes needed — the existing descriptions already describe `queued`, `running`, and `spawning` phases).
