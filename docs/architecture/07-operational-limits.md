# Operational Limits and Risk Areas

This file captures the non-obvious constraints that matter when maintaining or extending `pi-subagent`.

## Runtime limits

| Limit | Value | Where |
| --- | --- | --- |
| Calls per foreground invocation | 8 | `MAX_CALLS` in [`index.ts`](../../index.ts) |
| Foreground concurrent child processes | 4 | `MAX_CONCURRENCY` in [`index.ts`](../../index.ts) |
| Foreground progress heartbeat | 1000 ms | `CALLS_HEARTBEAT_MS` in [`index.ts`](../../index.ts) |
| Default max delegation depth | 3 | `DEFAULT_MAX_DELEGATION_DEPTH` in [`index.ts`](../../index.ts) |
| Background active jobs | 2 | `MAX_BACKGROUND_JOBS` in [`background-jobs.ts`](../../background-jobs.ts) |
| Background concurrent calls per job | 2 | `MAX_BACKGROUND_CONCURRENCY` in [`index.ts`](../../index.ts) |
| Non-persistent semantic completion grace | 250 ms | `AGENT_END_GRACE_MS` in [`runner.ts`](../../runner.ts) |
| SIGKILL timeout after SIGTERM | 5000 ms | `SIGKILL_TIMEOUT_MS` in [`runner.ts`](../../runner.ts) |
| Persistent session post-completion exit timeout | 30000 ms | `PERSISTENT_SESSION_EXIT_TIMEOUT_MS` in [`runner.ts`](../../runner.ts). The timer is **reset** when a new agent cycle begins (`agent_start` / `turn_start`) after a transient error, so an auto-retry gets a full timeout window. See [ADR 001](../adr/001-persistent-session-exit-timer-reset.md). |
| Session lock heartbeat | 30000 ms | [`session-lock.ts`](../../session-lock.ts) |
| Stale lock threshold | 2 minutes | [`session-lock.ts`](../../session-lock.ts) |
| `subagent_result.maxOutputLength` | 50000 chars | `MAX_OUTPUT_LENGTH_LIMIT` in [`types.ts`](../../types.ts) |

## Delegation guard configuration

Delegation depth and cycle behavior can come from:

- environment variables
- CLI arguments
- Pi runtime flags
- defaults

Depth is propagated to children through environment variables. Cycle prevention blocks delegation to any agent name already present in the ancestor stack.

## Known architectural tradeoffs

### Background jobs are durable, but active jobs are not resumed

Terminal background jobs are persisted to disk and reloaded on startup. Jobs that were `running` when the extension process exited are reloaded as `interrupted`; child processes are not resumed.

A cancelling job can reload as `cancelled` only if persisted call state already shows cancellation had been applied. Otherwise it reloads as `interrupted` to avoid pretending the process completed cleanly.

### Isolated worktree mode is job-level

`worktreeMode: "isolated"` creates one isolated worktree for the background job. Multiple calls inside that job share the same isolated worktree, so sibling write-capable calls can still conflict with each other.

Isolated worktree mode also requires a clean git working tree and a named branch before job start. The extension creates a branch named `codex/subjob_<jobId>` and stores changed-file metadata plus a patch artifact when possible.

### Shared worktree mode remains the default

Background jobs default to `worktreeMode: "shared"`, which means child processes can edit the parent working tree while the parent or sibling jobs are also active. The extension warns and records optional `worktreeScope`, but it does not enforce file-level locking.

### Session locks are advisory

Locks are filesystem directories with owner metadata. They protect against normal concurrent use, but stale recovery is manual and there is no cross-machine coordination beyond the shared filesystem.

### Contract and implementation must stay aligned

`contract.ts` centralizes wording, but schema definitions and runtime validation still live in `index.ts`. Changes to accepted parameters should update both.

### Event handling depends on Pi JSON event shape

`runner-events.js` recognizes a small set of event types. If Pi changes its JSON-mode event shape, final output, usage, or semantic completion could drift.

### Process termination is semantic

For ephemeral calls, the wrapper can terminate the child after observing `agent_end` and assistant output. This keeps calls responsive, but it relies on the event stream being authoritative.

## Change checklist

Before changing architecture-sensitive code:

1. Update contract text and runtime validation together.
2. Add or adjust tests for process arguments, result normalization, and rendering when relevant.
3. Confirm persistent session changes handle duplicate calls, active calls, filesystem locks, and custom session directories.
4. Confirm background job changes handle status, cancellation, completion delivery, and `subagent_result`.
5. Confirm isolated worktree changes handle git preconditions, metadata collection, patch artifacts, and multi-call job behavior.
6. Keep generated package contents in sync with `package.json.files` if new runtime files are needed in the npm package.
