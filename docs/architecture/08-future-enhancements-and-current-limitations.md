# Future Enhancements and Current Limitations

This note captures design considerations that are useful but not urgent. The intent is to avoid optimizing the current background-agent implementation before the product shape is clearer.

## Current state

Background jobs now support:

- durable job state under `.pi-subagent/jobs/<jobId>/`
- `subagent_start`, `subagent_status`, `subagent_cancel`, and `subagent_result`
- per-call lifecycle state and recent activity
- shared parent-workspace execution
- isolated job-level worktree execution via `worktreeMode: "isolated"`

The important current limitation is that isolated mode creates one worktree for the background job, not one worktree per call.

## Isolation semantics

Current behavior:

```text
subagent_start(worktreeMode="isolated", calls=[A, B])
  -> one background job
  -> one isolated worktree
  -> A and B both run in that same worktree
```

This isolates the job from the parent workspace, but sibling calls can still interfere with each other if multiple write-capable agents run concurrently in the same job.

This is not automatically wrong. A shared isolated workspace can be useful when sibling agents are cooperating on one unit of work:

- implementer writes changes while reviewer reads the same worktree
- implementer writes changes while test runner runs tests in the same worktree
- migrator writes changes while auditor inspects the resulting diff
- planner or explorer reads the isolated job state before an implementer acts

The risky case is multiple concurrent writers:

- two implementers editing different features
- fixer and refactorer editing at the same time
- reviewer that is allowed to edit while implementer is still editing

Even "disjoint" prompts can collide on shared files such as package metadata, tests, imports, formatting, generated files, or lockfiles.

## Nested jobs

Nested background jobs are currently disallowed. `subagent_start` is root-session-only, so subagents cannot start their own background jobs or request fresh isolated worktrees.

This is separate from the sibling-call issue above.

Future orchestration may need nested jobs. For example:

- an overseer agent starts separate implementation jobs for separate GitLab issues
- an implementer asks for a read-only reviewer against its worktree
- a workflow agent starts a test runner against an implementation worktree

Those cases should not all receive fresh worktrees automatically. A reviewer or test runner usually needs to inspect the implementation workspace, not a new empty branch.

## Workspace model under consideration

A simpler model than separate workspace and write modes is to treat write capability as derived from the agent's tool permissions. An `Explore` or `Reviewer` agent with only read tools is read-only by construction. An `Implementer` with edit/write tools is write-capable by construction.

The runtime question then becomes:

```ts
workspace:
  | "parent"
  | { jobId: string }
  | "fresh-worktree"
```

Meanings:

- `parent`: run in the main Pi session workspace.
- `{ jobId }`: run in a workspace produced by another job, usually for review, testing, or follow-up fixes.
- `fresh-worktree`: create a new isolated worktree/branch for independent implementation work.

Example workflow:

```text
Implementer:
  workspace = "fresh-worktree"
  tools include edit/write

Reviewer:
  workspace = { jobId: implementerJobId }
  tools are read-only
  findings go back to the parent agent

Parent or implementer applies fixes:
  workspace = { jobId: implementerJobId }

Fresh reviewer:
  workspace = { jobId: implementerJobId }
  tools are read-only
```

The review loop decision captured here is:

- reviewer agents report findings to the parent agent
- the parent agent decides how fixes are made
- a second review uses a fresh reviewer agent against the same implementation workspace

## Possible future policy

For the current `worktreeMode: "isolated"` behavior, a pragmatic policy would be:

1. Allow one-call isolated jobs.
2. Allow multi-call isolated jobs when all calls are read-only.
3. Allow multi-call isolated jobs with exactly one write-capable agent and one or more read-only collaborators.
4. Reject or require an explicit override when more than one sibling call is write-capable.

This requires reliable agent capability metadata from the agent definition files, especially tool permissions.

## Deferred enhancements

These are useful but not immediate:

- per-call isolated worktrees for multi-call jobs
- nested background jobs
- workspace targeting by job ID
- explicit job/workflow ownership for target workspaces
- richer worktree cleanup and recovery
- runtime validation based on read-only vs write-capable agent tool sets
- Agentflow trace mapping from parent job to child runs, reviewers, fixes, and merge requests
- human escalation prompts with context, recommended choices, and simple reply handling

## Current recommendation

Do not optimize isolation further until concrete workflows require it.

The immediate implementation should treat `worktreeMode: "isolated"` as a job-level isolated workspace. If multi-call isolated jobs become common, add capability-aware validation before implementing per-call worktrees.
