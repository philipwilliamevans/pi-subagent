# Plan: Artifact and Workflow Bridge

## Goal

Prepare the UX layer for the broader Agentflow cockpit vision by treating
background job outputs as artifacts rather than chat text.

This plan is not the full workflow graph. It is a bridge: make current outputs
more structured so future implementation/review/fix/MR workflows have stable
things to point at.

## Problem

The current job model already stores several artifact-like fields:

- final result text
- raw event journals
- isolated worktree path
- branch
- changed files
- patch path
- escalation history
- queued plans

But these are scattered across job fields and renderer assumptions. The UX can
refer to them, but the product model does not yet say "this job produced these
artifacts."

## Non-goals

- No full Agentflow integration.
- No GitLab issue or merge request creation.
- No automatic branch cleanup.
- No workflow state machine yet.
- No migration of existing persisted jobs beyond graceful fallback.

## Proposed Artifact Model

Add a minimal artifact type in `types.ts`:

```typescript
export type BackgroundArtifactKind =
  | "result"
  | "event_journal"
  | "worktree"
  | "branch"
  | "patch"
  | "changed_files"
  | "escalation"
  | "plan";

export interface BackgroundArtifact {
  id: string;
  kind: BackgroundArtifactKind;
  label: string;
  path?: string;
  value?: string;
  count?: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
}
```

Then add:

```typescript
artifacts?: BackgroundArtifact[];
```

to `BackgroundJob`.

## First Slice

Do not rewrite everything at once. Start by deriving artifacts from existing
fields at render time:

- result artifact from terminal `job.results`
- event journal artifact when event lines exist
- worktree artifact from `worktreeMetadata.path`
- branch artifact from `worktreeMetadata.branch`
- patch artifact from `worktreeMetadata.patchPath`
- changed files artifact from `worktreeMetadata.changedFiles`
- escalation artifact from `job.escalations`

Once the render-time shape is stable, persist `artifacts` directly.

## UX Use

Fleet rows should show artifact counts, not artifact dumps:

```text
subjob_ab12cd34 completed review  artifacts: result, patch, 4 files
```

Job detail should show artifact locations:

```text
Artifacts
  result        .pi-subagent/jobs/subjob_ab12cd34/result.md
  patch         .pi-subagent/jobs/subjob_ab12cd34/worktree.patch
  branch        codex/subjob_subjob_ab12cd34
  changed files 4
```

Completion notifications should mention only artifact hints.

## Workflow Bridge

After artifacts are visible, introduce a minimal workflow record:

```typescript
interface BackgroundWorkflow {
  id: string;
  kind: "implementation_review" | "scheduled_audit" | "manual";
  status: "running" | "needs_input" | "completed" | "failed";
  jobIds: string[];
  createdAt: number;
  updatedAt: number;
}
```

This can later support:

- implementation job
- review job
- fix job
- second review job
- merge request job

But the first bridge should stop at artifact clarity.

## File-by-file Changes

| File | Changes |
|------|---------|
| `types.ts` | Add optional artifact types after render-time helper proves useful. |
| `render.ts` | Add artifact summary/detail helpers; use them in compact completion and job detail. |
| `background-job-store.ts` | Persist artifacts once the job type includes them. |
| `docs/VISION.md` | Optionally update current-progress notes once artifact model lands. |
| `test/render.test.mjs` | Cover artifact summaries for result, patch, branch, changed files, and legacy fallback. |
| `test/background-job-store.test.mjs` | Cover persistence once artifacts are stored. |

## Test Cases

- Result artifact appears for completed jobs.
- Patch artifact appears for isolated jobs with changes.
- Changed file count appears without listing every file in compact views.
- Legacy jobs without artifacts still render from worktree metadata.
- Persisted artifacts round-trip when direct artifact storage is added.

## Open Questions

1. Should artifacts be persisted as explicit records now, or derived until the
   workflow model needs stable artifact IDs?
2. Should raw event journals be user-facing artifacts or debugging-only
   artifacts?
3. Should future Agentflow trace IDs attach to jobs, runs, artifacts, or all
   three?

