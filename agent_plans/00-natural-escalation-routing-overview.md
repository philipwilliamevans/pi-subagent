# Plan Overview: Natural Subagent Escalation Routing

## Goal

Make interactive background subagents feel like normal conversation.

When a subagent needs human direction, the user should see the question and answer naturally. They should not need to know about `awaitMarker`, `needs_input`, `subagent_continue`, job IDs, call indexes, or any other internal protocol detail.

This plan supports the cockpit model described in [docs/VISION.md](../docs/VISION.md), especially:

- human supervision by exception
- structured escalation requests
- durable jobs and agent runs
- parent Pi as the user's primary interface
- Agentflow as the eventual system of record

## Desired User Experience

```text
Subagent:
I found three useful directions:
1. Session handling
2. Worktree ownership
3. Escalation state

Which should I explore?

User:
2, but compare it against the current isolated worktree code too.
```

The parent agent should silently route the user's answer to the waiting subagent. The user should not have to write tool syntax or mention the job ID.

## Phase List

1. [Hide marker plumbing](./01-hide-marker-plumbing.md)
2. [Add structured escalation records](./02-structured-escalation-records.md)
3. [Post natural follow-up messages with routing metadata](./03-natural-follow-up-routing.md)
4. [Polish continue response UX](./04-continue-response-ux.md)
5. [Handle multiple pending escalations](./05-multiple-pending-escalations.md)
6. [Emit Agentflow-ready lifecycle events](./06-agentflow-lifecycle-events.md)

## Architectural Direction

The current slice already has the useful foundation:

- background job persistence
- job-owned child sessions
- `needs_input` lifecycle state
- `subagent_continue`
- event journals and result artifacts

The next work should refine that into an explicit escalation loop:

```text
subagent_start(interactive)
  -> child asks for input
  -> job parks with structured escalation
  -> parent receives a natural follow-up with hidden metadata
  -> user replies normally
  -> parent calls subagent_continue
  -> same child session resumes
```

## Non-Goals

- Do not build a full live attach UI in this phase.
- Do not clone the richer `pi-subagents` plugin's Fleet view, widgets, or menus.
- Do not require the child to emit machine-readable JSON yet.
- Do not solve multi-call interactive jobs until single-call routing is smooth.
- Do not expose marker strings to humans.

## Definition of Done

- The human can complete a simple interactive subagent flow without seeing or typing internal tool syntax.
- The marker remains available as internal plumbing or advanced debugging only.
- The parent-facing contract clearly instructs the parent agent to route natural replies to the pending escalation.
- The durable job state records enough information to explain what question was asked and what answer was sent.
- Tests cover the new state model and routing guidance surfaces.
