# Phase 6: Emit Agentflow-Ready Lifecycle Events

## Goal

Emit structured lifecycle events for background subagent jobs and escalations so Agentflow can become the system of record.

This directly supports [docs/VISION.md](../docs/VISION.md)'s Agentflow integration section, especially the need to answer:

- Which agent picked this issue?
- Which prompt was used?
- Which worktree/branch was created?
- Why did the workflow escalate?
- What did the human choose?
- Which artifact resulted?

## Event Set

Initial event names:

```text
subagent.started
subagent.escalated
subagent.continued
subagent.completed
subagent.failed
subagent.cancelled
```

If Pi conventions prefer namespaced event bus strings, use:

```text
pi-subagent:started
pi-subagent:escalated
pi-subagent:continued
pi-subagent:completed
pi-subagent:failed
pi-subagent:cancelled
```

Pick one convention and document it.

## Event Payloads

Common fields:

```ts
{
  jobId: string;
  callIndex?: number;
  agent?: string;
  status: BackgroundJobStatus;
  createdAt: number;
  updatedAt: number;
  worktreeMode?: WorktreeMode;
  worktreeMetadata?: WorktreeMetadata;
}
```

Escalation fields:

```ts
{
  escalationId: string;
  question: string;
  kind: "freeform" | "choice";
  answer?: string;
}
```

Future Agentflow fields:

```ts
{
  agentflowTraceId?: string;
  agentflowRunId?: string;
  promptRef?: string;
  parentJobId?: string;
  artifactIds?: string[];
}
```

## Implementation Details

### Event Helper

Add a small helper in `index.ts` or a new module:

```ts
function emitSubagentEvent(type: string, payload: Record<string, unknown>): void {
  pi.events?.emit?.(type, {
    version: 1,
    source: "pi-subagent",
    ...payload,
  });
}
```

Guard against missing event APIs if needed.

### Emission Points

Emit:

- after job registration: `started`
- when a job parks: `escalated`
- when `subagent_continue` accepts a user answer: `continued`
- after terminal success: `completed`
- after terminal failure: `failed`
- after cancellation: `cancelled`

### Testing

Use a mocked `pi.events.emit` to verify:

- event name
- stable `version`
- required IDs
- escalation question and answer
- worktree metadata when available

## Definition of Done

- Events are emitted for start, escalation, continuation, completion, failure, and cancellation.
- Event payloads contain stable job/run/escalation identifiers.
- Escalation events include the question; continuation events include the user answer.
- Event emission is best-effort and does not break job execution if listeners fail.
- Tests cover each event type and payload shape.
