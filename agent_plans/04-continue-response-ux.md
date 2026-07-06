# Phase 4: Polish Continue Response UX

## Goal

Make continuation feel like the parent agent quietly handled the user's answer, not like the user operated a tool.

The vision in [docs/VISION.md](../docs/VISION.md) says the parent Pi agent remains the user's primary interface. `subagent_continue` should therefore be a parent-agent mechanism, not a user-facing ritual.

## Desired User Flow

```text
Subagent:
Which direction should I explore?

User:
The worktree one.

Parent:
Got it. I'll send that to the explorer.
```

Then the subagent either finishes or parks again with a new natural question.

## Implementation Details

### Continue Tool Result

Current `subagent_continue` can return an implementation-heavy message. Replace with a compact parent-facing acknowledgement:

```text
Sent that direction to the waiting explorer subagent.

The subagent will continue in the same session. I will report back when it finishes or asks another question.
```

The details can still include:

```ts
{
  jobId,
  escalationId,
  callIndex,
  status: "running"
}
```

### Escalation Answer Recording

Before resuming:

- mark the current escalation as answered
- store the exact user reply
- store `answeredAt`

If an `escalations` history exists, append/update there.

### Parent Prompt Guidance

Teach the parent agent:

- After calling `subagent_continue`, respond briefly and naturally.
- Do not summarize the subagent's previous question again unless the user asks.
- Do not claim the subagent has finished until a completion message arrives.

### Repeat Parking

If the continuation output contains the marker again:

- create a new escalation ID
- post a new natural escalation message
- keep the same job and child session

## Definition of Done

- `subagent_continue` returns a concise acknowledgement suitable for parent-agent narration.
- The user answer is persisted on the escalation record.
- A continuation can park again with a fresh escalation ID.
- The parent-facing contract tells the parent how to acknowledge continuation without exposing internals.
- Tests cover answer recording and the `subagent_continue` result text.
