# Vision: Pi as the Agentflow Cockpit

`pi-subagent` is intended to become a small, controllable foundation for Agentflow-native software engineering workflows inside Pi.

The goal is not just to run subagents. The goal is to let a human supervise durable, traceable agent work from a normal Pi session, while Agentflow records how each issue moved through planning, implementation, review, fixing, merge-request creation, and escalation.

## Why this extension

There are richer Pi subagent extensions with more product surface area already built. This repository deliberately starts from a smaller base.

That is useful because the desired product needs control over interaction points that are difficult to retrofit into a mature, opinionated plugin:

- how prompts are selected from a prompt store
- how agent runs are traced into Agentflow
- how parent, child, reviewer, fixer, and merge agents relate to one another
- how GitLab issues become durable jobs
- how worktrees, branches, patches, and merge requests are owned and reviewed
- how agents escalate decisions to a human with useful context
- how scheduled agents create backlog findings rather than just chat messages

The extension should stay simple where possible, but the core model should be designed for orchestration rather than ad hoc subprocess execution.

## Product north star

A Pi session should act as the cockpit for an autonomous engineering workflow.

From the main Pi session, the user should be able to:

- start or approve a collection of agent jobs
- see all active and recent agents at a glance
- inspect status, artifacts, branches, worktrees, and merge requests
- peek into a running agent without taking it over
- steer an agent when necessary
- enter an agent session interactively when direct intervention is needed
- answer structured escalation requests with minimal friction
- trace the path of a GitLab issue through Agentflow

The parent Pi agent remains the user's primary interface. Agentflow remains the system of record.

## Example workflow

A representative workflow:

```text
Human in Pi
  -> parent agent
  -> overseer agent checks GitLab for ready stories
  -> overseer selects a story
  -> implementation agent creates an isolated worktree and implements it
  -> reviewer agent reviews the implementation worktree read-only
  -> reviewer returns findings to the parent agent
  -> parent agent coordinates fixes
  -> fresh reviewer agent performs a second review
  -> merge-request agent creates or updates the MR
  -> final merge agent performs final checks and merge when approved
```

Scheduled agents can run separately:

```text
Scheduled architecture/security/performance audit
  -> inspect project at configured time
  -> produce findings
  -> add backlog items or Agentflow records
  -> notify the parent/human only when useful
```

## Core concepts

### Agent run

One execution by one agent.

An agent run should have:

- agent name and resolved definition
- prompt and prompt-store reference when applicable
- model and runtime configuration
- parent run/job reference
- transcript and result
- lifecycle status
- Agentflow trace/run ID
- produced artifacts

### Job

A durable unit of work that may contain many agent runs.

Examples:

- implement GitLab issue `#123`
- review an implementation branch
- run scheduled architecture audit
- prepare a merge request

A job should be inspectable from Pi and traceable in Agentflow.

### Workflow

A graph or state machine that coordinates jobs and agent runs.

Examples:

- backlog selection -> implementation -> review -> fixes -> second review -> MR
- scheduled audit -> findings -> backlog update
- flaky test investigation -> patch -> verification

### Artifact

Something an agent produces or acts on.

Examples:

- worktree
- branch
- patch
- merge request
- report
- test log
- review finding
- backlog item

Artifacts should be linked to the job and Agentflow trace that produced them.

### Escalation

A structured request for human input.

Escalations should include:

- what decision is needed
- why the agent escalated
- what the agent already tried or observed
- recommended choice
- alternative choices
- consequences or tradeoffs

The human should be able to answer with a short selection or concise instruction.

## Workspace direction

Workspace allocation should not be based only on agent depth.

The current useful model is:

```ts
workspace:
  | "parent"
  | { jobId: string }
  | "fresh-worktree"
```

Meanings:

- `parent`: run in the main Pi session workspace.
- `{ jobId }`: run in the workspace produced by another job.
- `fresh-worktree`: create a new isolated worktree/branch for independent implementation work.

Write capability should be inferred primarily from the agent's tool permissions. A read-only reviewer does not need a separate write mode; it simply lacks edit/write tools.

Example:

```text
Implementation agent:
  workspace = "fresh-worktree"
  tools include edit/write

Reviewer agent:
  workspace = { jobId: implementationJobId }
  tools are read-only
  findings go back to the parent agent

Parent/fixer applies changes:
  workspace = { jobId: implementationJobId }

Fresh reviewer:
  workspace = { jobId: implementationJobId }
  tools are read-only
```

The important distinction is whether agents are cooperating on the same unit of work or independently writing separate changes.

## Agentflow integration

Agentflow should eventually see more than isolated subprocess calls. It should see the shape of the work.

Useful trace relationships:

```text
GitLab issue
  -> orchestration job
  -> implementation run
  -> implementation worktree/branch
  -> review run
  -> review findings
  -> fix run
  -> second review run
  -> merge request run
  -> final merge/check run
```

Agentflow should make it possible to answer:

- Which agent picked this issue?
- Which prompt was used?
- Which worktree/branch was created?
- What did the reviewer find?
- Who or what fixed it?
- Why did the workflow escalate?
- What did the human choose?
- Which merge request resulted from the work?

## Human supervision

The user should not need to watch every step. They should be able to supervise by exception.

The main Pi session should prioritize:

- agents waiting for human input
- failed or blocked jobs
- jobs that produced artifacts needing review
- merge requests ready for approval
- scheduled findings that deserve backlog action

The product should avoid turning every agent event into a chat interruption. Most events belong in status views and traces. Human-facing interruptions should be reserved for completion, failure, blocked state, or explicit escalation.

## Near-term product priorities

The next investments should strengthen the foundation rather than chase every mature-agent UI feature immediately.

Recommended order:

1. Make lifecycle persistence reliable for every important state transition.
2. Define the durable job/run/artifact model.
3. Emit Agentflow-friendly lifecycle events.
4. Add prompt-store references to agent invocations.
5. Tighten workspace/worktree ownership semantics.
6. Add structured escalation records and simple human response handling.
7. Build richer overview/peek/attach surfaces once the state model is stable.

## Explicit non-goals for now

- Do not clone every feature from richer subagent plugins.
- Do not optimize per-call worktree allocation until real workflows require it.
- Do not auto-merge agent branches by default.
- Do not make nested background jobs automatic just because delegation depth allows nested calls.
- Do not treat chat messages as the durable system of record.

## Design principle

The extension should remain a clear foundation for Agentflow-native orchestration.

When choosing between a quick feature and a clean lifecycle/artifact/trace model, prefer the model. The eventual product depends on being able to explain what happened, why it happened, which agent did it, and what the human approved.
