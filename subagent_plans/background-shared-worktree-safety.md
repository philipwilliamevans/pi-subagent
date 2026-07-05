# Plan: Background Shared-Worktree Safety

## Goal

Reduce conflicts caused by background agents editing the same working tree as the parent or sibling subagents.

This covers the known risk that shared-worktree background editing can conflict with parent edits or other background jobs.

## Non-goals

- No automatic merging by default.
- No hidden checkpoint commits in V1.
- No full Agent View dashboard.
- No durable job registry implementation in this plan, though durable artifacts will complement the work.

## Recommended Implementation Order

Implement after lifecycle/status/result hardening. Start with policy and guardrails, then add worktree mode.

## Current Problem

The current thin slice warns that background subagents run in the same working tree. That is useful for experimentation, but unsafe as a default product posture: the parent, one background job, and sibling jobs can edit the same files concurrently with no isolation or conflict detection.

## Proposed Behavior

Ship this in two phases.

### Phase 1: Shared-Worktree Guardrails

- Keep same-worktree mode available for the thin slice.
- Make the warning more actionable:
  - mention that scopes should be disjoint;
  - suggest using status/result tools before integrating changes;
  - show the job ID prominently.
- Optionally require an explicit parameter such as `worktreeMode: "shared"` once isolated mode exists.
- Track declared file/path scope if the user provides it in prompts or a future structured field.
- Add status output that reminds the parent when a running job is using shared mode.

### Phase 2: Isolated Worktree Mode

- Add an opt-in mode where each background job or call gets a git worktree and branch.
- Branch from the parent branch/current checkpoint.
- If the parent worktree is dirty, refuse by default and explain why.
- Allow explicit `checkpoint: true` later, using a visible local WIP commit rather than a hidden history mutation.
- Return artifact metadata:
  - worktree path;
  - branch name;
  - base commit;
  - changed files;
  - optional patch path.
- Do not auto-merge results back into the parent branch.

## Implementation Notes

- Start with read-only git checks:
  - current branch;
  - working tree cleanliness;
  - base commit.
- Keep branch naming deterministic and recoverable, for example `codex/subjob_<id>-<agent>`.
- Do not delete worktrees automatically in the first implementation; users need inspectable artifacts.
- Use explicit tool output to tell the parent how to review or integrate a branch.
- Treat worktree creation as a separate product milestone from the current risk-hardening commit if the change gets large.

## Tests

Add focused tests for:

- Same-worktree start output includes the intended warning.
- Worktree mode refuses dirty parent state unless checkpointing is explicitly requested.
- Worktree mode records branch/path/base metadata on the job.
- Multiple background jobs get distinct worktree paths/branches.
- Completion/status output includes artifact metadata.

## Definition of Done

- Users are clearly warned when background jobs share the parent working tree.
- There is a documented path to isolated execution that does not auto-merge.
- Dirty parent worktrees are not silently checkpointed or branched from ambiguous state.
- Background job metadata includes enough information for review and cleanup.
- `npm test` passes.
