# Phase 3: Post Natural Follow-Up Messages With Routing Metadata

## Goal

When a subagent parks, show the human a normal question and hide the routing metadata in tool details.

This supports [docs/VISION.md](../docs/VISION.md)'s human supervision principle: interruptions should be reserved for explicit escalation, and the human should be able to answer with minimal friction.

## Desired Message

Human-visible text:

```text
The explorer subagent is waiting for your direction:

I found three useful directions:
1. Session handling
2. Worktree ownership
3. Escalation state

Which should I explore?

Reply with your choice or instruction.
```

Machine-readable details:

```ts
{
  type: "subagent_escalation",
  jobId,
  escalationId,
  callIndex,
  agent,
  status: "needs_input"
}
```

The human should not need to see the job ID in the main text.

## Implementation Details

### Completion Message Formatting

Split parked formatting from completed formatting:

```ts
formatBackgroundCompletion(job)
formatBackgroundEscalation(job)
```

`formatBackgroundEscalation` should:

- show the subagent's question
- omit the marker
- include a simple natural instruction: "Reply with your choice or instruction."
- avoid internal syntax

### `pi.sendMessage`

When `job.status === "needs_input"`:

```ts
pi.sendMessage(
  {
    customType: "subagent-escalation",
    display: true,
    content: [{ type: "text", text: formatBackgroundEscalation(job) }],
    details: {
      type: "subagent_escalation",
      jobId: job.id,
      escalationId: job.waitingForInput.id,
      callIndex: job.waitingForInput.callIndex,
      agent: job.calls[job.waitingForInput.callIndex]?.agent,
      status: "needs_input",
    },
  },
  {
    deliverAs: "followUp",
    triggerTurn: job.onComplete === "trigger",
  },
);
```

### Parent Contract

Update `formatAvailableSubagentsPrompt()`:

- Explain that subagent escalation messages include hidden routing details.
- Instruct the parent agent:
  - If exactly one unresolved subagent escalation exists and the user replies with an answer, call `subagent_continue`.
  - Pass the user's reply verbatim as `prompt`.
  - Do not ask for the job ID.
  - Do not expose tool syntax.

### Tracking Pending Escalations

For this phase, rely on the latest injected escalation message and persisted job state. The parent agent can call `subagent_status` if it is unsure.

Future phase handles multiple pending escalations explicitly.

## Definition of Done

- Parked jobs inject a natural human-facing escalation message.
- The message content does not include marker strings, job IDs, call indexes, or tool syntax unless needed for debugging.
- The message details include `jobId`, `escalationId`, and `callIndex`.
- Parent-facing prompt guidance tells the parent agent to route a natural user reply to `subagent_continue`.
- Tests cover parked message formatting and details shape.
