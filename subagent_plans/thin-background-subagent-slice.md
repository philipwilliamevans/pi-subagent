# Thin Slice Plan: Background Subagent Start + Auto Completion

## Goal

Prove the core interaction loop:

1. A parent interactive Pi session starts one or more subagents in the background.
2. The tool returns immediately so the user can keep talking to the parent agent.
3. Background subagents continue running in the same working tree.
4. When they finish, the extension injects a completion message into the parent session.
5. The parent agent can react automatically without the user manually polling.

This slice intentionally avoids persistence, cancellation, worktrees, workflow DAGs, and session recovery.

## Non-goals for this slice

- No `subagent_collect`.
- No `subagent_cancel`.
- No persisted background job recovery after parent Pi exits.
- No DAG/YAML workflow orchestration.
- No git worktree isolation.
- No patch-only mode.
- No named persistent subagent sessions in background mode.
- No nested background delegation from subagents.
- No rich event capture beyond existing final `SingleResult` summaries.

## User-facing behavior

Add a new model-facing tool, probably named `subagent_start`.

Example call:

```json
{
  "calls": [
    {
      "agent": "fixer",
      "prompt": "Fix review finding 1. Only touch runner.ts and runner tests."
    },
    {
      "agent": "fixer",
      "prompt": "Fix review finding 2. Only touch render.ts and render tests."
    }
  ],
  "onComplete": "trigger"
}
```

Immediate tool result:

```text
Started background subagent job subjob_abc123 with 2 calls.

The result will be posted to this session when complete.

Warning: background subagents run in the same working tree and may edit files concurrently. Give each subagent a clearly disjoint scope.
```

Completion message injected later:

```text
Background subagent job subjob_abc123 completed.

- fixer call 1: success
- fixer call 2: success

Results:
...
```

If `onComplete: "trigger"`, the injected message should trigger a parent agent turn when the parent is idle, or queue as a follow-up while the parent is busy.

## API shape

### Tool parameters

Use the same call item shape as the existing `subagent` tool, but initially reject persistent sessions.

```ts
const SubagentStartParams = Type.Object({
  calls: Type.Array(CallItem),
  onComplete: Type.Optional(
    Type.Union([
      Type.Literal("message"),
      Type.Literal("trigger"),
      Type.Literal("silent"),
    ]),
  ),
});
```

Suggested default:

```ts
onComplete = "trigger"
```

Semantics:

- `silent`: record job completion in memory only.
- `message`: inject a custom message into the session but do not trigger a turn.
- `trigger`: inject a custom message and trigger/follow-up a parent turn.

For the thin slice, `trigger` is the primary path to prove.

## Runtime restrictions

Reject background starts when:

- Current process is already a subagent, i.e. delegation depth > 0.
- Any call specifies `session`.
- Normal call validation fails.
- Normal delegation depth/cycle guards fail.
- Active background job count exceeds a small limit, e.g. `MAX_BACKGROUND_JOBS = 2`.

Allow:

- Multiple calls in one background job.
- Same working tree editing.
- Per-call `model`.
- Per-call `cwd`.
- `initialContext: "empty"` and `initialContext: "parent"` for ephemeral calls.

## Internal data model

Add an in-memory registry in `index.ts` or a new `background-jobs.ts`.

```ts
type BackgroundJobStatus = "running" | "completed" | "failed";
type BackgroundCompletionMode = "silent" | "message" | "trigger";

interface BackgroundJob {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: BackgroundJobStatus;
  calls: NormalizedCall[];
  promise: Promise<SingleResult[]>;
  results?: SingleResult[];
  error?: string;
  onComplete: BackgroundCompletionMode;
}

const backgroundJobs = new Map<string, BackgroundJob>();
```

Use a simple ID generator:

```ts
const jobId = `subjob_${randomUUID().slice(0, 8)}`;
```

## Execution flow

`subagent_start.execute(...)` should mirror the existing synchronous tool through validation and setup, then diverge at execution.

1. Discover/load agents as current `subagent` does.
2. Validate and normalize calls.
3. Enforce root-only background policy.
4. Reject named persistent sessions.
5. Attach session identities only if still needed for compatibility, but do not allow `session`.
6. Build parent session snapshot if any call requests `initialContext: "parent"`.
7. Create a background job entry.
8. Start async execution without awaiting it.
9. Return immediate start result.

Execution promise:

```ts
const promise = (async () => {
  try {
    const results = await mapConcurrent(calls, MAX_CONCURRENCY, (call) =>
      runAgent({
        ...existingOptions,
        callIndex: call.index,
        agentName: call.agent,
        prompt: call.prompt,
        callModel: call.model,
        callCwd: call.effectiveCwd,
        initialContext: call.initialContext,
        parentSessionSnapshotJsonl: snapshot ?? undefined,
        session: undefined,
        // no session locks for thin slice
      }),
    );

    job.status = results.some(isResultError) ? "failed" : "completed";
    job.results = results;
    job.updatedAt = Date.now();
    postCompletionMessage(job);
    return results;
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = Date.now();
    postCompletionMessage(job);
    throw error;
  }
})();
```

Important: attach a `.catch(() => {})` or handle errors inside the promise so unhandled promise rejections do not crash the parent process.

## Completion message injection

Use `pi.sendMessage(...)` from the extension closure.

```ts
function postCompletionMessage(job: BackgroundJob): void {
  if (job.onComplete === "silent") return;

  pi.sendMessage(
    {
      customType: "subagent-background-result",
      display: true,
      content: [{ type: "text", text: formatBackgroundCompletion(job) }],
      details: {
        jobId: job.id,
        status: job.status,
        results: job.results,
        error: job.error,
      },
    },
    {
      deliverAs: "followUp",
      triggerTurn: job.onComplete === "trigger",
    },
  );
}
```

Use `deliverAs: "followUp"` so completion does not steer an in-progress turn mid-tool execution.

## Formatting

Add a compact formatter, probably in `render.ts` or a small helper in `index.ts` for the first slice.

Completion should include:

- Job ID.
- Final status.
- Per-call agent name and success/failure.
- Final output summary from each result.
- Error message/stderr excerpt for failures.

Keep it concise to avoid flooding context.

## Optional tiny status command/tool

Not required for the proof, but a minimal `subagent_status` tool would be useful if very cheap.

Input:

```json
{ "jobId": "subjob_abc123" }
```

Output:

```text
subjob_abc123: running, 2 calls, started 74s ago
```

If this adds complexity, defer it.

## Tests

Add tests where possible without needing real child Pi processes.

### Unit tests

- Normalization rejects `session` in `subagent_start`.
- Root-only guard rejects background starts when `PI_SUBAGENT_DEPTH > 0`.
- Completion formatter summarizes success/failure results.
- Job status transitions from running to completed/failed using a mocked runner.

### Existing tests to update

- Contract/render tests if tool descriptions include `subagent_start`.
- Any TypeScript checks affected by new types.

### Manual validation

1. Start Pi with local extension:

   ```bash
   pi -e .
   ```

2. Ask parent agent to start a background explorer/reviewer task.
3. Verify tool returns immediately.
4. Continue chatting while child runs.
5. Verify completion message appears automatically.
6. Verify parent agent reacts when `onComplete: "trigger"`.
7. Try two background calls that edit separate files in the same working tree.

## Risks and accepted limitations

### Concurrent edits

Accepted for this slice. The user/parent agent must assign disjoint scopes.

Tool description should clearly warn:

> Background subagents run in the same working tree and may edit files concurrently. Give each subagent a clearly disjoint scope.

### Parent process exit

If the parent Pi process exits, in-memory jobs and child processes may be lost or orphaned depending on process behavior. Recovery is out of scope.

### No cancellation

User cannot stop a background job via tool yet. They can terminate the parent process if needed. Proper cancellation comes later.

### Context flooding

Completion summaries should be concise. Full event capture and artifacts come later.

## Success criteria

The slice is successful when:

- `subagent_start` starts background child processes and returns immediately.
- The parent interactive session remains usable.
- Background subagents can edit the current working tree.
- Completion is injected into the same session.
- `onComplete: "trigger"` causes the parent agent to respond without manual polling.
- Existing synchronous `subagent` behavior remains unchanged.
