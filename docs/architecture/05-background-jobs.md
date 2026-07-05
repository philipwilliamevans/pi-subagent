# Background Jobs and Cancellation

Background jobs allow the parent agent to start subagent work and continue immediately. The public tools are `subagent_start`, `subagent_status`, `subagent_cancel`, and `subagent_result`.

## Registry

[`background-jobs.ts`](../../background-jobs.ts) stores jobs in a process-local `Map<string, BackgroundJob>`.

Properties:

- Job IDs are `subjob_<8 uuid chars>`.
- Jobs are listed most-recent first.
- Active jobs are those with status `running` or `cancelling`.
- The active job limit is 2.

## Durable persistence

When a base directory is configured (via `setJobStoreBaseDir(cwd)`), every state transition is persisted to `.pi-subagent/jobs/<jobId>/state.json` using atomic writes via [`background-job-store.ts`](../../background-job-store.ts). On startup, `reloadPersistedJobs()` loads all terminal jobs from disk into the in-memory registry.

Jobs that were `running` or `cancelling` when the process exited are reloaded with status `interrupted`. Unserializable fields (promise, abortController, live callbacks) are excluded from the persisted state.

## Job model

`BackgroundJob` includes:

- `id`, `createdAt`, `updatedAt`
- `status`
- normalized `calls`
- per-call `callStates`
- final `results`
- optional `error`
- `onComplete`
- `AbortController`
- the running `promise`

Per-call state tracks phase, timestamps, tool call count, and recent activity.

## Start restrictions

`subagent_start` intentionally rejects features that would complicate background semantics:

- It can only run at root delegation depth.
- It cannot use persistent sessions.
- It does not support `initialContext: "parent"` yet.
- It is subject to the active job limit.
- It still uses the normal cycle guard.

The child processes still run in the same working tree, so background agents can race with the parent or with each other if prompts do not use disjoint scopes.

## Execution

`runBackgroundSubagentJob` executes calls with concurrency 2 through the same `runAgent` path used by foreground calls.

Streaming partial updates are captured into per-call lifecycle state:
- tool call counts
- recent activity text for status output

When execution finishes:

- If the job was cancelling, final status becomes `cancelled`.
- Else if any call failed, final status becomes `failed`.
- Else final status becomes `completed`.

On each status change the persisted state.json is updated. For terminal jobs a result.md artifact is also written to disk containing the formatted output available via `subagent_result`.

## Completion delivery

`onComplete` controls parent notification:

| Mode | Behavior |
| --- | --- |
| `"trigger"` | Inject a follow-up message and trigger a parent turn. Default. |
| `"message"` | Inject a follow-up message without triggering a turn. |
| `"silent"` | Store results in memory only. |

Completion messages use `formatBackgroundCompletion` from [`render.ts`](../../render.ts), including compact excerpts and instructions to use `subagent_result` for full output when truncated.

## Cancellation

`subagent_cancel` requires `confirm: true`. Without confirmation it returns a dry-run message.

On confirmed cancellation:

1. Job status becomes `cancelling`.
2. The job `AbortController` is aborted.
3. Each running child process receives termination through `runAgent`.
4. When the job settles, status becomes `cancelled`.
5. A completion/cancellation message is posted unless completion mode is silent.

