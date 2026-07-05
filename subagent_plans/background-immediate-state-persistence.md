# Plan: Immediate Background Job State Persistence

## Goal

Persist important in-memory background job mutations immediately, not only at job completion.

This addresses two durability gaps:

1. Confirmed cancellation updates `job.status`, `updatedAt`, and `callStates`, but the new state is not persisted before the abort settles.
2. Isolated worktree creation sets `job.worktreeMetadata`, but the path/branch/base commit are not persisted until final completion.

Both issues have the same root cause: some code paths mutate the live `BackgroundJob` object directly without a registry helper that flushes the full current state to `state.json`.

## Non-goals

- No event log or `events.jsonl` implementation.
- No process resurrection for interrupted jobs.
- No change to result artifact writing.
- No change to worktree creation strategy.
- No change to cancellation semantics beyond persistence timing.

## Recommended Implementation Order

Implement before adding Agentflow tracing or richer Agent View state. These systems should be able to trust that every important lifecycle transition has a durable state snapshot.

## Current Problem

The durable registry persists through helpers such as `registerBackgroundJob`, `updateBackgroundJobStatus`, and `setBackgroundJobResults`. Those helpers work for simple status/result transitions, but not for arbitrary object mutations.

Two current mutation sites are vulnerable:

- `subagent_cancel` sets the job to `cancelling`, marks pending call states as `cancelled`, then aborts child processes. If Pi exits before workers settle, the last persisted state can still be `running`, so reload reports `interrupted` rather than preserving that the user explicitly cancelled the job.
- `runBackgroundSubagentJob` creates an isolated worktree and assigns `job.worktreeMetadata`. If Pi exits while the job is running, the reloaded interrupted job may not show the worktree path, branch, or base commit needed for inspection and cleanup.

## Proposed Behavior

Add a small registry helper that persists the current full job state after arbitrary in-memory mutations.

Suggested API:

```ts
export function persistBackgroundJob(job: BackgroundJob): void {
  persistJobIfEnabled(job);
}
```

Then call it after stateful mutations that should survive a restart:

```ts
job.status = "cancelling";
job.updatedAt = Date.now();
markPendingCallsCancelled(job, Date.now());
persistBackgroundJob(job);
job.abortController?.abort();
```

And after worktree creation:

```ts
job.worktreeMetadata = createWorktree(defaultCwd, job.id);
job.updatedAt = Date.now();
persistBackgroundJob(job);
```

Any future code that mutates `callStates`, `worktreeMetadata`, `error`, or other nested job fields should either use a specific update helper or call this generic persist helper.

## Implementation Notes

- Keep the helper in `background-jobs.ts`, close to the existing registry/persistence boundary.
- Do not expose low-level `persistJobState` to `index.ts`; `index.ts` should not know the store base directory.
- Prefer the name `persistBackgroundJob` or `saveBackgroundJob` over another status-specific helper, because the important mutations are nested fields as well as `status`.
- The helper can return `void`, matching existing persistence helpers that warn on failure.
- Consider using the helper in completion after worktree metadata collection too, but avoid redundant writes if the existing result/status helpers already persist the final object after all metadata fields are set.

## Tests

Add focused tests for the registry helper:

- With a configured store dir, mutating `job.callStates` and calling `persistBackgroundJob(job)` writes the updated call phases to `state.json`.
- With persistence disabled, `persistBackgroundJob(job)` does not throw.
- With a configured store dir, mutating `job.worktreeMetadata` and calling `persistBackgroundJob(job)` writes path, branch, and base commit to `state.json`.

Add integration-level or targeted tests for the two call sites if practical:

- Confirmed cancellation persists `status: "cancelling"` and cancelled call phases before workers settle.
- Isolated worktree creation persists `worktreeMetadata` before the agent run completes.

## Definition of Done

- Confirmed cancellation is durably visible as `cancelling` with cancelled pending call states before child processes finish.
- If the process exits after cancellation confirmation but before final settlement, reload preserves enough state to distinguish user cancellation from an ordinary interrupted run.
- Isolated worktree path, branch, and base commit are persisted immediately after creation.
- A reloaded interrupted isolated job includes worktree metadata for inspection and cleanup.
- `npm test` passes.

## Relationship to Other Plans

This is a follow-up to `background-durable-job-registry.md`, not a replacement. The durable registry exists; this plan tightens the write boundaries so important lifecycle mutations are not lost between job creation and final completion.
