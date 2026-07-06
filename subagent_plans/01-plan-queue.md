# Plan Queue: Preserving Agent Intent Across Turns

## Motivation

Background subagent jobs (`subagent_start`) return immediately, so the parent
agent cannot hold a synchronous conversation about their results. The current
auto-injected completion message delivers results but **does not tell the agent
what it was planning to do with them**. The agent has to guess or re-derive
intent from the conversation history — which may be many turns old by the time
results arrive.

The plan queue solves this by letting the agent explicitly **store a plan**
alongside the dispatched jobs. When all dependencies complete, the plan is
replayed verbatim in the injected message, so the agent knows exactly what it
was going to do — and can confirm with the user before acting.

## Design

### Data model (`types.ts`)

```typescript
interface QueuedPlan {
  id: string;                  // unique ID (plan_<uuid>)
  plan: string;                // the plan text — verbatim agent-authored
  dependsOn: string[];         // job IDs to wait on
  replace: boolean;            // replace any existing plan for same dependsOn set
  status: "pending" | "ready" | "fired";
  createdAt: number;
  firedAt?: number;
}
```

### Storage

- In-memory `Map<string, QueuedPlan>` (like `BackgroundJob` registry)
- Persisted alongside jobs in `.pi-subagent/jobs/` — plans live in
  `.pi-subagent/plans/<planId>/state.json`
- Survives process restart for pending plans
- Cleaned up when fired (optional: keep last N for debugging)

### New tool: `subagent_enqueue`

**Schema:**

```typescript
const SubagentEnqueueParams = Type.Object({
  plan: Type.String({
    description: "The plan text describing what to do with the results. Written as if reminding the agent what it intended.",
  }),
  dependsOn: Type.Array(Type.String, {
    description: "One or more background job IDs to wait on. All must reach a terminal state before the plan fires.",
    minItems: 1,
  }),
  replace: Type.Optional(Type.Boolean({
    description: "If true, replace any existing queued plan that depends on exactly the same job ID set.",
    default: false,
  })),
});
```

**Handler logic:**

1. Validate all `dependsOn` job IDs exist (running, completed, or terminal)
2. If `replace: true`, find and remove any existing plan whose `dependsOn`
   set matches exactly (same IDs in any order)
3. Create `QueuedPlan` with status `"pending"`
4. Check if all deps are already terminal — if so, mark `"ready"` immediately
   and inject the message
5. Return the plan ID

### Completion hook

In `postCompletionMessage` (or a new `processPlanQueue` function called from
each terminal path), after the job is marked terminal:

```
for each plan where plan.status === "pending":
  if plan.dependsOn.every(id => isJobTerminal(id)):
    mark plan as "ready"
    inject consolidated message
```

**Consolidated message format:**

```
📋 You had queued this plan:

  "compile the compliance ratings, violation list, and remediation
   priorities from both analyzers into REPORT.md"

The required jobs have completed:
  subjob_xxx — completed (8.2k output)
  subjob_yyy — completed (9.1k output)

Ask the user if they still want this done before proceeding.
Include the results above when explaining what's available.
```

The agent sees the plan it wrote, the results, and a clear instruction to
**ask the user before executing**. This avoids stale-instruction execution.

### System prompt addition

In `formatAvailableSubagentsPrompt()`, add to the background-jobs section:

```
### Plan queue

Use \`subagent_enqueue\` to store a plan that fires when background jobs
complete. The plan is replayed verbatim in the completion message so you
remember what you intended to do with the results.

When a queued plan fires, do not execute it immediately. Ask the user
if they still want it done before proceeding. They may have changed priorities.
```

### Tool description (`formatSubagentEnqueueToolDescription`)

```
Store a plan to be executed when background subagent jobs complete.

The plan is stored verbatim and replayed in the auto-injected completion
message. This helps the agent remember what it intended to do with the
results, even after many turns of other conversation.

When the plan fires, ask the user if they still want it done before
proceeding.

If `replace: true`, any existing queued plan for the same job set is
replaced with this one.

Example:
  { "plan": "Compile the results into REPORT.md",
    "dependsOn": ["subjob_abc123", "subjob_def456"],
    "replace": true }
```

## File-by-file changes

### New files

| File | Contents |
|------|----------|
| `plan-queue.ts` | Plan registry (create, get, list, persist, remove, check terminal) |
| `plan-store.ts` | Disk persistence for queued plans (mirrors `background-job-store.ts` pattern) |

### Modified files

| File | Changes |
|------|---------|
| `types.ts` | Add `QueuedPlan` interface |
| `contract.ts` | Add `formatSubagentEnqueueToolDescription()`; add plan-queue section to system prompt |
| `index.ts` | Register `subagent_enqueue` tool; call `processPlanQueue` in `postCompletionMessage` / terminal paths |
| `render.ts` | Add `formatPlanFired()` rendering function |
| `contract.ts` | Add plan-queue section to system prompt |

## Reverts already done

The following were reverted in this commit (polling-friction / Option 2):

- `types.ts`: removed `pollCount` field from `BackgroundJob`
- `index.ts`: removed `job.pollCount` increment in `subagent_status` handler
- `render.ts`: removed `formatPollingFrictionHint()` helper and integrations

The Option 1 contract changes (tool descriptions and return text about
"end your turn") are retained — they set correct expectations for the
fire-and-forget pattern.

## Open questions

1. **Multiple plans for overlapping job sets** — two plans waiting on the
   same job. Both fire independently. Should they be merged? (Current
   proposal: no, they fire separately. The agent handles them.)

2. **Plan deduplication** — `replace: true` matches exact `dependsOn` sets.
   Should we also support matching on a named key? (e.g. `planKey: "report"`)

3. **Cancellation** — if a depended-on job is cancelled, should the plan
   fire with partial results, or be cancelled too? (Proposal: fire with a
   note that X was cancelled, let the agent decide.)

4. **Session lifecycle** — pending plans survive process restart. What
   happens if the user starts a brand-new session in the same directory?
   (Proposal: reload pending plans on startup, fire any whose deps are
   terminal, but only inject if the session matches.)

5. **Cleanup** — how long do fired plans stay on disk? (Proposal: keep
   last 50, purge oldest on each new enqueue.)
