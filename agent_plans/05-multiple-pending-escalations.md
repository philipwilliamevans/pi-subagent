# Phase 5: Handle Multiple Pending Escalations

## Goal

Support natural replies when more than one subagent is waiting for input.

The user should still avoid job IDs and tool syntax. If the answer is ambiguous, the parent agent should ask a normal clarification question.

This supports [docs/VISION.md](../docs/VISION.md)'s cockpit view: the main session should prioritize agents waiting for human input without turning every event into a chat interruption.

## Desired Behavior

If exactly one escalation is open:

```text
User:
Pick option 2.

Parent silently routes to that escalation.
```

If multiple escalations are open:

```text
Parent:
Two subagents are waiting:
1. explorer: choose a follow-up topic
2. reviewer: approve a fix strategy

Which one should I answer?
```

The user can answer:

```text
The reviewer.
```

Then the parent routes the original or follow-up instruction.

## Implementation Details

### Status Formatting

Update `subagent_status` with a compact pending input section:

```text
Waiting for input:
1. subjob_abc explorer: Which follow-up topic should I explore?
2. subjob_def reviewer: Should I approve the simpler fix or investigate root cause?
```

This is mostly for parent-agent reasoning and advanced inspection.

### Parent Contract

Add routing rules:

- If one pending escalation exists, treat a likely answer as the response.
- If multiple pending escalations exist and the target is unclear, ask the user to disambiguate naturally.
- If the user names an agent, topic, or obvious option, use that to pick the escalation.
- Never ask the user to provide `jobId` unless the user is intentionally using advanced tooling.

### Optional Helper

Consider a small helper function:

```ts
getOpenEscalations(): Array<{
  jobId: string;
  escalationId: string;
  agent: string;
  question: string;
  createdAt: number;
}>
```

This can power formatting and future RPC/event surfaces.

### Tool Validation

If `subagent_continue` receives an `escalationId`, prefer it over `callIndex`.

Potential schema:

```ts
{
  jobId?: string;
  escalationId?: string;
  prompt: string;
}
```

For backward compatibility, keep `jobId` required until the helper exists.

## Definition of Done

- `subagent_status` clearly lists open escalations.
- Parent-facing guidance covers one-pending and many-pending routing behavior.
- Multiple parked jobs do not force the human to know job IDs.
- `subagent_continue` either supports `escalationId` or has a documented path to do so.
- Tests cover formatting for zero, one, and multiple pending escalations.
