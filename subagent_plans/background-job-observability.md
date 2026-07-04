# Plan: Background Job Observability & Results Access

## Goal

Improve the parent agent's ability to inspect, understand, and retrieve results from background subagent jobs. This addresses three specific UX gaps identified in the handoff interaction analysis:

1. **Status accuracy** — `subagent_status` showed "queued" even while a call was actively running, because `job.results` is `undefined` until all calls finish.
2. **Mid-flight visibility** — The parent had no way to see what the subagent was doing (which file it was reading, how many tool calls it had made).
3. **Post-completion results access** — The injected completion message truncated the explorer's report to 200 characters, and the parent had no tool to retrieve the full output.

## Non-goals

- No persistent session support for background jobs (deferred to a separate plan).
- No `initialContext: "parent"` for background jobs.
- No worktree isolation or patch mode.
- No per-call cancellation within a multi-call job.
- No workflow DAG orchestration.
- No filesystem persistence of job state beyond the in-memory registry.
- No changes to the synchronous `subagent` tool or its rendering.
- No changes to the cancellation lifecycle (already handled in the status/cancel slice).

---

## Change 1: Accurate per-call lifecycle status

### Problem

`formatCallStatusLabel` in `render.ts` shows "queued" when `job.results?.[index]` is `undefined`:

```typescript
function formatCallStatusLabel(r: SingleResult | undefined): string {
  if (!r) return "queued";               // ← fires for entire job duration
  if (r.exitCode === -1) return "running";
  ...
}
```

`job.results` is set only *after* `mapConcurrent` settles in `runBackgroundSubagentJob`. For the whole running period, results are `undefined`, so the status permanently reads "queued".

The synchronous `subagent` path solves this with `makePlaceholderResult(call)` — pre-populating results with `exitCode: -1` before execution starts. Background jobs lack this.

### Solution: Call State Tracking

Add a per-call lifecycle state to `BackgroundJob` that is independent of the final `results` array.

#### Type changes (`types.ts`)

```typescript
/** Lifecycle phase of a single background subagent call. */
export type CallLifecyclePhase =
  | "queued"       /** Not yet picked up by a worker. */
  | "spawning"     /** Worker picked it up; process is starting. */
  | "running"      /** Subagent pi process is executing. */
  | "completed"    /** Completed successfully. */
  | "failed"       /** Completed with an error. */
  | "cancelled";   /** Cancelled before or during execution. */

export interface CallState {
  phase: CallLifecyclePhase;
  startedAt?: number;     /** When the worker picked it up (epoch ms). */
  spawnedAt?: number;     /** When the pi process started (epoch ms). */
  completedAt?: number;   /** When it finished (epoch ms). */
  toolCalls: number;      /** Number of tool calls made so far. */
  /** Last N tool calls or activity descriptions, newest first. */
  recentActivity: string[];
}

export interface BackgroundJob {
  // ... existing fields
  /** Per-call lifecycle states, populated at job creation. */
  callStates: CallState[];
}
```

#### Job creation (`index.ts`)

In `subagent_start.execute()`, immediately after normalizing calls and before creating the `BackgroundJob`:

```typescript
const callStates: CallState[] = calls.map((call) => ({
  phase: "queued",
  toolCalls: 0,
  recentActivity: [],
}));

const job: BackgroundJob = {
  id: jobId,
  createdAt,
  updatedAt: createdAt,
  status: "running",
  calls,
  callStates,  // ← new
  promise: Promise.resolve(),
  onComplete,
  abortController,
};
```

#### Worker wiring (`index.ts` → `runBackgroundSubagentJob`)

When `mapConcurrent` picks up a call, the worker transitions the phase. This requires the worker to have mutable access to `job.callStates`.

Since `mapConcurrent`'s callback receives `(call, index)`, we can transition inline:

```typescript
async function runBackgroundSubagentJob(
  job: BackgroundJob,
  agents: AgentConfig[],
  defaultCwd: string,
  makeDetails: ReturnType<typeof makeDetailsFactory>,
): Promise<void> {
  try {
    const results = await mapConcurrent(
      job.calls,
      MAX_BACKGROUND_CONCURRENCY,
      async (call, index) => {
        const cs = job.callStates[index];
        cs.phase = "spawning";
        cs.startedAt = Date.now();

        const result = await runAgent({
          // ... existing options ...
          signal: job.abortController?.signal,
          onUpdate: (partial) => {
            // This callback fires as the subagent processes events.
            // Extract tool calls and final output for the journal.
            const details = partial.details as SubagentDetails | undefined;
            if (details?.results?.[0]) {
              updateCallStateFromPartial(cs, details.results[0]);
            }
          },
          makeDetails,
        });

        // Phase transition based on result
        cs.phase = isResultError(result) ? "failed" : "completed";
        cs.completedAt = Date.now();
        return result;
      },
    );

    // ... existing completion logic ...
  }
}
```

#### `updateCallStateFromPartial` helper

```typescript
function updateCallStateFromPartial(cs: CallState, partial: SingleResult): void {
  const items = getDisplayItems(partial.messages);
  const toolCallCount = items.filter((i) => i.type === "toolCall").length;

  if (toolCallCount > cs.toolCalls) {
    cs.toolCalls = toolCallCount;
  }

  // Collect recent tool calls as activity strings
  const newCalls = items
    .filter((i) => i.type === "toolCall")
    .slice(-3)  // last 3 tool calls
    .map((i) => formatActivityLine(i.name, i.args));

  // Prepend new activity, keep latest 5
  cs.recentActivity = [...newCalls, ...cs.recentActivity].slice(0, 5);

  // Phase transition on first tool call or activity
  if (cs.phase === "spawning" && (cs.toolCalls > 0 || toolCallCount > 0)) {
    cs.phase = "running";
    cs.spawnedAt = Date.now();
  }
}

function formatActivityLine(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read":
      return `→ read ${args.path || args.file_path || "?"}`;
    case "bash":
      return `$ ${String(args.command || "").slice(0, 60)}`;
    case "write":
      return `→ write ${args.path || "?"}`;
    case "edit":
      return `→ edit ${args.path || "?"}`;
    case "grep":
      return `→ grep /${args.pattern || ""}/ ${args.path || ""}`;
    default:
      return `→ ${toolName}`;
  }
}
```

#### Status rendering (`render.ts`)

Update `formatCallStatusLine` to read from `callStates` instead of deriving from results:

```typescript
function formatCallStatusLine(
  call: BackgroundJob["calls"][number],
  callState: CallState | undefined,
  result: SingleResult | undefined,
): string {
  if (!callState) {
    return `  ${call.agent} — queued`;
  }

  const label = callState.phase;
  let elapsed = "";
  if (callState.completedAt && callState.startedAt) {
    elapsed = ` (took ${formatDuration(callState.completedAt - callState.startedAt)})`;
  } else if (callState.startedAt) {
    elapsed = ` (${formatAge(callState.startedAt)} elapsed)`;
  }

  let line = `  ${call.agent} — ${label}${elapsed}`;

  if (callState.recentActivity.length > 0 && callState.phase === "running") {
    line += `\n    Latest: ${callState.recentActivity[0]}`;
  }

  if (callState.toolCalls > 0) {
    line += `\n    ${callState.toolCalls} tool call${callState.toolCalls === 1 ? "" : "s"} so far`;
  }

  return line;
}
```

Update `formatJobStatus` to accept and pass `callStates`:

```typescript
export function formatJobStatus(job: BackgroundJob): string {
  const age = job.createdAt ? formatAge(job.createdAt) : "";
  const duration = job.results ? formatElapsed(job.createdAt, job.updatedAt) : "";

  const callLines = job.calls.map((call, index) => {
    const cs = job.callStates?.[index];
    const r = job.results?.[index];
    return formatCallStatusLine(call, cs, r);
  });

  const when = job.status === "running" || job.status === "cancelling"
    ? `started ${age} ago`
    : `took ${duration} (finished ${age} ago)`;

  return [
    `${job.id}: ${job.status}, ${job.calls.length} call${job.calls.length === 1 ? "" : "s"}, ${when}`,
    ...callLines,
  ].join("\n");
}
```

#### Placeholder fallback (optional simplification)

If the `callStates` approach feels too heavyweight for a first pass, a simpler intermediate step: pre-populate `job.results` with `exitCode: -1` placeholders at job creation (same pattern as `makePlaceholderResult` in the sync path). This changes "queued" → "running" without adding lifecycle granularity.

The `callStates` approach is preferred because it also provides the foundation for Change 2 (activity tracking). If implementing in stages, do placeholders first, then layer `callStates` on top.

---

## Change 2: Mid-flight activity visibility

### Problem

Background subagent processes are completely opaque during execution. `subagent_status` can only report "running" or "queued" — it cannot show what the agent is actually doing (e.g., "reading file X", "searching for pattern Y").

The synchronous `subagent` tool has this capability: `runAgent` accepts an `onUpdate` callback that fires on every parsed event, streaming tool calls and partial output back through the heartbeat mechanism. But `runBackgroundSubagentJob` passes `onUpdate: undefined`, throwing this data away.

### Solution: Wire onUpdate through to the job registry

#### Add an `intermediateResults` field to `BackgroundJob`

```typescript
export interface BackgroundJob {
  // ... existing fields
  callStates: CallState[];
  /** Streaming partial results, updated as calls progress. */
  intermediateResults?: SingleResult[];
}
```

#### Pass a real onUpdate callback

In `runBackgroundSubagentJob`, replace `onUpdate: undefined` with a callback that:

1. Writes the partial result into `job.intermediateResults[callIndex]`.
2. Updates `callStates[callIndex]` with tool call counts and recent activity.

```typescript
async function runBackgroundSubagentJob(
  job: BackgroundJob,
  agents: AgentConfig[],
  defaultCwd: string,
  makeDetails: ReturnType<typeof makeDetailsFactory>,
): Promise<void> {
  // Initialize intermediate results
  job.intermediateResults = job.calls.map(() => emptyPlaceholder());

  try {
    const results = await mapConcurrent(
      job.calls,
      MAX_BACKGROUND_CONCURRENCY,
      async (call, index) => {
        const cs = job.callStates[index];
        cs.phase = "spawning";
        cs.startedAt = Date.now();

        const result = await runAgent({
          // ... existing options ...
          signal: job.abortController?.signal,
          onUpdate: (partial) => {
            if (partial.details?.results?.[0]) {
              // Store intermediate result for status queries
              if (job.intermediateResults) {
                job.intermediateResults[index] = partial.details.results[0];
              }
              // Extract activity for call state
              updateCallStateFromPartial(cs, partial.details.results[0]);
            }
          },
          makeDetails,
        });

        cs.phase = isResultError(result) ? "failed" : "completed";
        cs.completedAt = Date.now();
        return result;
      },
    );

    // ... existing completion logic, then clean up intermediate results
    job.intermediateResults = undefined;  // release memory
  }
}
```

#### Status display includes activity

Update `formatJobStatus` to show recent activity when inspecting a single job:

```
subjob_5764e545: running, 1 call, started 1m 12s ago
  explorer — running (1m 12s elapsed)
    23 tool calls so far
    Latest: → read /Users/phil/Projects/pi-subagent/docs/ARCHITECTURE_GUIDELINES.md

  Recent activity:
    → read docs/ARCHITECTURE_GUIDELINES.md
    → grep /Persistence/ in src/
    → read src/persistence.py:42-89
    $ find . -name "*.ts" | head -20
```

The recent activity list shows the last 5 tool calls in reverse chronological order, each formatted compactly. File paths are shortened with `shortenPath`.

#### Display only on single-job status queries

Show activity details only when querying a specific job (not in the list-all-jobs view, where compactness is more important).

---

## Change 3: Post-completion results access

### Problem

`formatBackgroundCompletion` calls `truncate(summary, 200)` on each call's result:

```typescript
const excerpt = summary && summary !== "(no output)"
  ? `\n  ${truncate(summary, 200).replace(/\n/g, "\n  ")}`
  : "";
```

200 characters is far too short for a detailed explorer report. The parent agent sees the message and feels the output was truncated, but has no way to retrieve the full content.

Additionally, the injected message is delivered via `pi.sendMessage` with `customType: "subagent-background-result"` — plain text with no expand/collapse support. The full `result.messages` (which contain the final assistant text) are already stored in `job.results`, but nothing exposes them to the parent agent.

### Solution: New `subagent_result` tool + better completion excerpts

#### Part A — New tool `subagent_result`

Register a new read-only tool that returns the full final output from a completed job's results.

**Schema:**

```typescript
const SubagentResultParams = Type.Object({
  jobId: Type.String({
    description: "ID of the completed background job to retrieve results for.",
  }),
  callIndex: Type.Optional(
    Type.Number({
      description:
        "0-based index of a specific call to retrieve. Omit to get all calls.",
    }),
  ),
  includeToolCalls: Type.Optional(
    Type.Boolean({
      description:
        "When true, include tool calls in addition to final assistant text. Default: false (final text only).",
      default: false,
    }),
  ),
  maxOutputLength: Type.Optional(
    Type.Number({
      description:
        "Maximum characters of output text per call. Default: no limit. Set to avoid flooding context.",
    }),
  ),
});
```

**Tool description:**

```
Retrieve the full output from a completed background subagent job.

Use this when the completion message excerpt was truncated or you need the
complete response text from a finished subagent.

By default returns only the final assistant text (tool calls excluded).
Set includeToolCalls to true to see the full tool call trace.
Use maxOutputLength to cap the response size.

Examples:
  { "jobId": "subjob_abc123" }
  { "jobId": "subjob_abc123", "callIndex": 0 }
  { "jobId": "subjob_abc123", "callIndex": 0, "includeToolCalls": true, "maxOutputLength": 8000 }
```

**Validation:**

- `jobId` must refer to a known job (via `getBackgroundJob`).
- If job is still running, return an error: "Job is still running. Wait for completion or use `subagent_status` to check progress."
- If `callIndex` is provided, it must be within bounds.
- If job has no results (e.g., cancelled before execution started), return an error.

**Formatting (`render.ts`):**

```typescript
export function formatJobResults(
  job: BackgroundJob,
  options: {
    callIndex?: number;
    includeToolCalls?: boolean;
    maxOutputLength?: number;
  },
): string {
  const { callIndex, includeToolCalls, maxOutputLength } = options;
  const results = job.results;
  if (!results || results.length === 0) {
    return "No results available for this job.";
  }

  const targetResults = callIndex !== undefined
    ? [results[callIndex]]
    : results;

  const lines: string[] = [];
  for (const r of targetResults) {
    if (r.exitCode === -1) {
      lines.push(`## ${r.agent} (still running)`);
      continue;
    }

    const summary = getResultSummaryText(r);
    const items = includeToolCalls ? getDisplayItems(r.messages) : [];

    lines.push(`## ${r.agent} — ${isResultError(r) ? "failed" : "completed"}`);
    lines.push("");

    if (summary && summary !== "(no output)") {
      const output = maxOutputLength && summary.length > maxOutputLength
        ? summary.slice(0, maxOutputLength) + `\n\n[... truncated at ${maxOutputLength} characters]`
        : summary;
      lines.push(output);
      lines.push("");
    }

    if (includeToolCalls && items.length > 0) {
      lines.push("### Tool calls");
      for (const item of items) {
        if (item.type === "toolCall") {
          lines.push(`- ${item.name}(${JSON.stringify(item.args)})`);
        }
      }
      lines.push("");
    }

    const usage = formatUsage(r.usage, r.model);
    if (usage) {
      lines.push(`*${usage}*`);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
```

**Execute handler:**

```typescript
async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
  const job = getBackgroundJob(params.jobId);
  if (!job) {
    return {
      content: [{ type: "text", text: `Unknown background job: \`${params.jobId}\`. Use \`subagent_status\` to list known jobs.` }],
      isError: true,
    };
  }

  if (job.status === "running" || job.status === "cancelling") {
    return {
      content: [{ type: "text", text: `Job \`${job.id}\` is still ${job.status}. Wait for completion, then retrieve results.` }],
      isError: true,
    };
  }

  if (!job.results || job.results.length === 0) {
    return {
      content: [{ type: "text", text: `Job \`${job.id}\` has no results (status: ${job.status}).` }],
      isError: true,
    };
  }

  const callIndex = params.callIndex;
  if (callIndex !== undefined) {
    if (callIndex < 0 || callIndex >= job.results.length) {
      return {
        content: [{ type: "text", text: `Invalid callIndex ${callIndex}. Job has ${job.results.length} call${job.results.length === 1 ? "" : "s"} (0–${job.results.length - 1}).` }],
        isError: true,
      };
    }
  }

  const text = formatJobResults(job, {
    callIndex,
    includeToolCalls: params.includeToolCalls ?? false,
    maxOutputLength: params.maxOutputLength,
  });

  return {
    content: [{ type: "text", text }],
  };
}
```

#### Part B — Better completion excerpts

1. **Raise the truncation limit** from 200 to 2000 characters in `formatBackgroundCompletion`:

```typescript
const EXCERPT_MAX_LENGTH = 2000;

const excerpt = summary && summary !== "(no output)"
  ? `\n  ${truncate(summary, EXCERPT_MAX_LENGTH).replace(/\n/g, "\n  ")}`
  : "";
```

2. **Add a truncation notice** when content was clipped:

```typescript
const wasTruncated = summary && summary.length > EXCERPT_MAX_LENGTH;
const truncationNotice = wasTruncated
  ? `\n  *Output truncated at ${EXCERPT_MAX_LENGTH} characters. Full report available via \`subagent_result\`.*`
  : "";
```

3. **Include tool call count and output size** in the excerpt header:

```typescript
const toolCallItems = getDisplayItems(r.messages).filter((i) => i.type === "toolCall");
const toolCallInfo = toolCallItems.length > 0
  ? ` (${toolCallItems.length} tool call${toolCallItems.length === 1 ? "" : "s"}, ${formatTokens(summary.length)} output)`
  : "";
```

Resulting message:

```
Background subagent job `subjob_5764e545` completed successfully (took 2m 1s).

- explorer call 1: completed (28 tool calls, 12.4k output)
  I've now thoroughly examined the entire codebase. Here is my comprehensive report.

  [...truncated at 2000 chars. Full report via `subagent_result subjob_5764e545`]
```

#### Part C — Register the tool description in the system prompt

Add the new tool to `formatAvailableSubagentsPrompt` in `contract.ts`, in the "Background subagent jobs" section:

```
Retrieve full completed job output with \`subagent_result\`.
Use it when the auto-injected completion excerpt is too brief.
```

---

## Tool description and contract changes (`contract.ts`)

### Updated Background subagent jobs section

Add to `formatAvailableSubagentsPrompt`:

```
### Background subagent jobs

Use the \`subagent_start\` tool to fire-and-forget work in the background.
The tool returns immediately; results arrive via an auto-injected message.
By default the completion auto-triggers a parent turn — just omit \`onComplete\`.

Check status anytime with \`subagent_status\` (omit \`jobId\` to list all).
Cancel a running job with \`subagent_cancel\` (requires \`confirm: true\`).

Retrieve the full output from a completed job using \`subagent_result\`.
The auto-injected message includes a compact excerpt; use \`subagent_result\`
when you need the complete response text.

Background jobs do not support persistent sessions (\`session\`).
Omit \`session\` for background delegation.
```

### New `formatSubagentResultToolDescription`

```typescript
export function formatSubagentResultToolDescription(): string {
  return [
    "Retrieve the full output from a completed background subagent job.",
    "",
    "Use this tool when the auto-injected completion message excerpt",
    "was truncated or you need the complete response text from a",
    "finished subagent.",
    "",
    "By default returns only the final assistant text (tool calls excluded).",
    "Set includeToolCalls to true to see the full tool call trace.",
    "Use maxOutputLength to cap the response size.",
    "",
    "Examples:",
    '  { "jobId": "subjob_abc123" }',
    '  { "jobId": "subjob_abc123", "callIndex": 0 }',
    '  { "jobId": "subjob_abc123", "callIndex": 0, "includeToolCalls": true, "maxOutputLength": 8000 }',
  ].join("\n");
}
```

---

## Files changed

| File | What changes |
|------|-------------|
| `types.ts` | Add `CallLifecyclePhase`, `CallState` types. Add `callStates` and `intermediateResults` to `BackgroundJob`. |
| `index.ts` | Populate `callStates` at job creation. Wire `onUpdate` in `runBackgroundSubagentJob`. Add `updateCallStateFromPartial` helper. Register new `subagent_result` tool. |
| `render.ts` | Update `formatCallStatusLine` to use `callStates`. Add activity display. Raise truncation limit in `formatBackgroundCompletion`. Add truncation notice. Add `formatJobResults` for the new tool. |
| `contract.ts` | Update system prompt section for background jobs. Add `formatSubagentResultToolDescription`. |
| `background-jobs.ts` | No changes (the Map-based registry is unchanged; just new fields on the stored objects). |

---

## Tests

### Unit tests

**1. Call state transitions**

- `callStates` initialized to "queued" for all calls at job creation.
- Worker transitions to "spawning" → "running" → "completed" for a successful call.
- Worker transitions to "spawning" → "running" → "failed" for a failed call.
- Worker transitions to "spawning" → "cancelled" on cancellation.
- Tool call counts and recent activity updated correctly from partial results.

**2. `formatCallStatusLine` with call states**

- Queued call → output contains "queued".
- Running call with activity → output contains "running", tool call count, latest activity.
- Completed call → output contains "completed" and duration.
- Failed call → output contains "failed".
- Cancelled call → output contains "cancelled".

**3. `subagent_result` tool**

- Unknown job ID → error message.
- Running job → error: still running.
- Completed job with no results → error: no results.
- Invalid `callIndex` → error with valid range.
- Valid request → returns full final assistant text.
- With `includeToolCalls` → text also contains tool call lines.
- With `maxOutputLength` → text is truncated with a notice.

**4. Completion excerpt improvements**

- Output under 2000 chars → no truncation, no truncation notice.
- Output over 2000 chars → truncated with notice.
- Tool call count and output size included in the per-call header.

**5. Format tokens**

- `formatTokens(0)` → `"0"`
- `formatTokens(500)` → `"500"`
- `formatTokens(1500)` → `"1.5k"`
- `formatTokens(12000)` → `"12k"`
- `formatTokens(1500000)` → `"1.5M"`

### Existing tests to update

- `render.test.*` — if tests exist for `formatBackgroundCompletion`, update expected output for the new truncation limit and format.
- `types.test.*` — if tests check `BackgroundJob` shape, add `callStates` and `intermediateResults`.

### Manual validation

1. Start Pi with `pi -e .`
2. Start a background explorer job: `subagent_start` with a prompt that reads multiple files.
3. Immediately check `subagent_status { "jobId": "subjob_..." }` — confirm it shows "spawning" or "running" (not "queued").
4. Wait a few seconds, check again — confirm tool call count and recent activity are populated.
5. Wait for completion message — confirm the excerpt is more generous (2000 chars) and includes tool call count + output size.
6. If the output was truncated, run `subagent_result { "jobId": "subjob_..." }` — confirm full text is returned.
7. Try `subagent_result` with `callIndex`, `includeToolCalls`, and `maxOutputLength` — each works as expected.
8. Try `subagent_result` on a running job — confirm error message.
9. Start two background jobs, verify independent call state tracking for each.

## Edge cases

- **Job with 0 tool calls** (e.g., agent errors out immediately before any tool use): `callStates` shows the agent phase but recent activity is empty. Status display shows "running" (or "failed") with no tool calls.
- **Rapid completion**: If `mapConcurrent` picks up a call and the subagent finishes within milliseconds, `callStates` transitions from "queued" → "spawning" → "completed" in quick succession. The "running" phase may be skipped if `onUpdate` never fires (no intermediate events). Acceptable — status shows meaningful final state.
- **Cancellation during "spawning"**: If the job is cancelled before the worker picks up the call, `callStates[callIndex].phase` is still "queued". On cancellation, set all non-terminal call states to "cancelled".
- **Multiple calls in one job**: Each call has its own `callStates` entry, updated independently by its `mapConcurrent` worker. No sharing conflicts.
- **Subagent with enormous output**: `maxOutputLength` on `subagent_result` caps the return size. Default (no limit) returns the full output, which could be large but matches user intent.

## Success criteria

- `subagent_status` no longer shows "queued" for actively running calls. It shows "spawning" → "running" → "completed".
- `subagent_status` shows tool call counts and recent activity for running calls.
- Completion excerpts are generous (2000 chars) with a clear truncation notice when clipped.
- `subagent_result` retrieves the complete final output text.
- All three UX gaps from the handoff analysis are addressed.
- Existing synchronous `subagent` behavior is completely unchanged.
- All existing tests pass.
