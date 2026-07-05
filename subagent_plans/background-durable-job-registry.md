# Plan: Background Durable Job Registry

## Goal

Persist background job state so jobs do not vanish when the parent process reloads or restarts.

This covers the known risk that the current background job registry is in-memory only.

## Non-goals

- No cross-machine synchronization.
- No automatic process resurrection after restart.
- No worktree creation or branch management.
- No Agent View UI in this slice.
- No long-term retention policy beyond a simple local history limit.

## Recommended Implementation Order

Implement after lifecycle/status semantics are stable. Durability should persist the model users already trust.

## Current Problem

Background jobs are stored in a module-level map. Once the parent Pi process exits, reloads, or crashes, the job list and results disappear. This makes long-running background agents hard to inspect and blocks reliable Agent View, result collection, and recovery workflows.

## Proposed Behavior

Persist each background job under a local directory such as:

```text
.pi-subagent/jobs/<jobId>/
  state.json
  events.jsonl
  result.md
```

Minimum V1 behavior:

- On job creation, write `state.json` with job metadata, calls, lifecycle state, and status.
- On lifecycle updates, rewrite `state.json` atomically.
- On completion, write final `state.json` and `result.md`.
- On extension startup, load known terminal jobs from disk for `subagent_status` and `subagent_result`.
- Jobs that were `running` or `cancelling` when the process exited should reload as `failed` or `interrupted`, depending on the chosen status model.

## Data Model

Suggested persisted state:

- `schemaVersion`
- `jobId`
- `createdAt`
- `updatedAt`
- `status`
- `onComplete`
- `calls`
- `callStates`
- `error`
- compact `results` metadata or a pointer to result artifacts

Do not persist unserializable fields:

- `promise`
- `abortController`
- live callbacks

## Implementation Notes

- Add a small persistence module rather than embedding file writes in `index.ts`.
- Use atomic writes: write to a temp file in the same directory, then rename.
- Keep persisted JSON intentionally boring and forward-compatible.
- Decide whether `.pi-subagent/jobs` should be gitignored. If so, update docs and ignore rules in the same change.
- Avoid writing full transcripts into `state.json`; use `events.jsonl` or `result.md` for larger artifacts.
- If a non-terminal job is found on startup, mark it as interrupted with a clear message explaining that the process was not resumed.

## Tests

Add focused tests for:

- Creating a persisted job directory and `state.json`.
- Updating lifecycle state atomically.
- Reloading completed/failed/cancelled jobs from disk.
- Reloading an active job as interrupted or failed after restart.
- `subagent_status` and `subagent_result` can operate on reloaded terminal jobs.

## Definition of Done

- Completed background jobs survive parent process restart for status/result lookup.
- Interrupted active jobs are visible and clearly marked after restart.
- No live-only fields are serialized.
- Persistence failures produce a clear warning or error path without crashing unrelated synchronous `subagent` use.
- `npm test` passes.
