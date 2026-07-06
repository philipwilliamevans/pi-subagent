# Phase 1: Hide Marker Plumbing

## Goal

Replace user-visible `awaitMarker` ceremony with a semantic tool option.

The user or parent agent should be able to request an interactive background subagent without saying "Use awaitMarker AWAITING_CHOICE." The marker should become implementation plumbing.

This directly supports [docs/VISION.md](../docs/VISION.md)'s product north star: the parent Pi session should be the cockpit, and the user should supervise decisions rather than operate internal mechanics.

## User-Facing Behavior

Preferred model-facing call:

```json
{
  "calls": [
    {
      "agent": "explorer",
      "prompt": "Inspect runner.ts and offer three follow-up directions."
    }
  ],
  "interactive": true
}
```

The extension internally:

- sets a default marker such as `AWAITING_SUBAGENT_INPUT`
- appends waiting instructions to the child prompt
- stores the marker in job state
- parks the job if the marker appears in successful final output

`awaitMarker` can remain as an advanced escape hatch, but parent-facing documentation should prefer `interactive: true`.

## Implementation Details

### Schema

Add top-level `interactive` to `SubagentStartParams`:

```ts
interactive: Type.Optional(
  Type.Boolean({
    description:
      "When true, the subagent may stop to ask the user for direction. The extension handles the internal wait marker automatically.",
    default: false,
  }),
)
```

### Validation

Rules:

- `interactive: true` is single-call only for now.
- `interactive: true` requires a persisted parent Pi session, same as current marker mode.
- `interactive: true` cannot be combined with caller-provided `session`.
- If `awaitMarker` is also provided, either:
  - reject the combination as ambiguous, or
  - treat `awaitMarker` as an advanced override.

Recommended MVP: allow `awaitMarker` to override but keep it undocumented in primary guidance.

### Prompt Injection

Add a helper:

```ts
function appendInteractiveWaitInstructions(prompt: string, marker: string): string {
  return `${prompt}

When you need the user's choice, clarification, approval, or direction before continuing:
- Ask a concise question.
- Include the relevant options or tradeoffs when helpful.
- Stop after asking the question.
- End your final line with exactly: ${marker}`;
}
```

Only append this when `interactive: true`.

### State

Map:

```ts
interactive: true
```

to:

```ts
awaitMarker = DEFAULT_INTERACTIVE_AWAIT_MARKER
```

Keep the persisted `awaitMarker` field so restart/reload remains clear.

### Contract Updates

Update `formatSubagentStartToolDescription()` and the injected available-subagents prompt:

- Teach parent agents to use `interactive: true` when a subagent should pause for human direction.
- Stop using marker examples in the primary path.
- Say `awaitMarker` is advanced/debug-only if it remains in the schema.

## Definition of Done

- A parent agent can call `subagent_start` with `interactive: true` and no `awaitMarker`.
- The child prompt receives automatic wait instructions.
- The job parks in `needs_input` when the internal marker appears.
- No user-visible start or parked message tells the human to type or mention a marker.
- Existing explicit `awaitMarker` tests still pass or are updated for the new advanced behavior.
- New tests cover validation and prompt injection for `interactive: true`.
