# Phase 2: Add Structured Escalation Records

## Goal

Promote `waitingForInput` from a marker holder into a durable escalation record.

This aligns with [docs/VISION.md](../docs/VISION.md)'s `Escalation` concept: a structured request for human input that records what decision is needed, why it was asked, and how the human answered.

## Target Model

Replace or extend:

```ts
waitingForInput?: {
  callIndex: number;
  marker: string;
  updatedAt: number;
}
```

with:

```ts
interface BackgroundEscalation {
  id: string;
  callIndex: number;
  kind: "freeform" | "choice";
  question: string;
  marker: string;
  status: "open" | "answered" | "cancelled";
  createdAt: number;
  updatedAt: number;
  answeredAt?: number;
  answer?: string;
}
```

For MVP:

- `kind` can default to `"freeform"`.
- `question` can be the final assistant output with the marker removed.
- Only one open escalation per job is required.

## Implementation Details

### Types

In `types.ts`:

- Add `BackgroundEscalation`.
- Replace `BackgroundInputRequest` or keep it as a compatibility alias during migration.
- Add `waitingForInput?: BackgroundEscalation` to `BackgroundJob`.

### Persistence

In `background-job-store.ts`:

- Persist `waitingForInput`.
- Hydrate old state that lacks `id`, `kind`, or `status`.
- Keep schema version unchanged if the shape is tolerant, or bump if strict migration is preferred.

Recommended MVP: tolerant hydration.

### Escalation Creation

When a job parks:

```ts
job.waitingForInput = {
  id: `esc_${randomUUID().slice(0, 8)}`,
  callIndex,
  kind: "freeform",
  question: stripAwaitMarker(getFinalOutput(result.messages), marker),
  marker,
  status: "open",
  createdAt: now,
  updatedAt: now,
};
```

Add:

```ts
function stripAwaitMarker(output: string, marker: string): string
```

This should remove a final marker line without damaging the actual question text.

### Continue Handling

When `subagent_continue` accepts an answer:

- store the user answer on the escalation
- set `status: "answered"`
- set `answeredAt`
- preserve it in a history if practical

For MVP, storing only the latest answered escalation is acceptable, but a future `escalations: BackgroundEscalation[]` array would be better for traceability.

## Definition of Done

- Persisted jobs include a structured escalation object when parked.
- The escalation question does not include the internal marker.
- `subagent_continue` records the answer before resuming.
- Reloading a parked job preserves its escalation ID, question, and status.
- Tests cover escalation creation, marker stripping, persistence, and answer recording.
