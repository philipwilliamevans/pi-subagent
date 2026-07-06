# Background Jobs and Cancellation

Background jobs allow the parent agent to start subagent work and continue immediately. The public tools are `subagent_start`, `subagent_status`, `subagent_cancel`, and `subagent_result`.

## Registry

[`background-jobs.ts`](../../background-jobs.ts) stores live jobs in a process-local `Map<string, BackgroundJob>` and persists mutations when a job store base directory has been configured.

Properties:

- Job IDs are `subjob_<8 uuid chars>`.
- Jobs are listed most-recent first.
- Active jobs are those with status `running` or `cancelling`.
- The active job limit is 2.

## Durable persistence

When a base directory is configured (via `setJobStoreBaseDir(cwd)`), state transitions are persisted to `.pi-subagent/jobs/<jobId>/state.json` using atomic writes via [`background-job-store.ts`](../../background-job-store.ts). On startup, `reloadPersistedJobs()` loads persisted jobs from disk into the in-memory registry.

Jobs that were `running` when the process exited are reloaded with status `interrupted`. Jobs that were `cancelling` are reloaded as `cancelled` only when the persisted call states show cancellation had already reached unfinished calls; otherwise they become `interrupted`. Unserializable fields (promise, abortController, live callbacks) are excluded from the persisted state.

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
- optional `worktreeMode`
- optional `worktreeScope`
- optional `worktreeMetadata`

Per-call state tracks phase, timestamps, tool call count, recent activity, and an activity cursor used to avoid replaying duplicate tool-call activity from partial updates.

## Start restrictions

`subagent_start` intentionally rejects features that would complicate background semantics:

- It can only run at root delegation depth.
- It cannot use persistent sessions.
- It does not support `initialContext: "parent"` yet.
- It is subject to the active job limit.
- It still uses the normal cycle guard.
- For `worktreeMode: "isolated"`, cwd must be inside a clean git repository on a named branch.

In shared mode, child processes run in the parent working tree and can race with the parent or with each other if prompts do not use disjoint scopes. In isolated mode, the job is isolated from the parent working tree, but sibling calls inside the same job still share one isolated worktree.

## Execution

`runBackgroundSubagentJob` executes calls with concurrency 2 through the same `runAgent` path used by foreground calls.

For `worktreeMode: "isolated"`, execution first creates a git worktree under a sibling `.pi-worktrees/<project-slug>/<jobId>` directory using a branch named `codex/subjob_<jobId>`. Calls run at their corresponding repo-relative cwd inside that worktree. After completion, the extension records changed files and writes `.pi-subagent/jobs/<jobId>/worktree.patch` when there are changes.

Streaming partial updates are captured into per-call lifecycle state:
- tool call counts
- recent activity text for status output

When execution finishes:

- If the job was cancelling, final status becomes `cancelled`.
- Else if any call failed, final status becomes `failed`.
- Else final status becomes `completed`.

On each status change the persisted state.json is updated. For terminal jobs a result.md artifact is also written to disk containing the formatted output available via `subagent_result`.

## Lifecycle events

Background jobs emit best-effort lifecycle events through `pi.events.emit` when that API is available. Event names use the Pi extension namespace:

- `pi-subagent:started`
- `pi-subagent:escalated`
- `pi-subagent:continued`
- `pi-subagent:completed`
- `pi-subagent:failed`
- `pi-subagent:cancelled`

Payloads include `version: 1`, `source: "pi-subagent"`, stable job IDs, status, timestamps, optional call/agent identity, and worktree metadata when available. Escalation and continuation events also include the escalation ID, question, kind, and the user answer when present. Event delivery is telemetry-only; listener errors are ignored so job execution continues.

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
2. Pending, spawning, and running call states are immediately marked `cancelled`.
3. The updated job state is persisted.
4. The job `AbortController` is aborted.
5. Each running child process receives termination through `runAgent`.
6. When the job settles, status becomes `cancelled`.
7. A completion/cancellation message is posted unless completion mode is silent.
