# Product Vision: Interactive Background Subagents for Pi

## Vision

Turn `pi-subagent` from a synchronous delegation helper into an interactive orchestration layer for Pi.

The parent agent should be able to delegate focused work to specialized subagents, keep the main conversation moving, and receive structured completion updates when background work finishes. Over time, this should support lightweight ad-hoc delegation, persistent background jobs, multi-agent workflows, richer progress reporting, safer editing isolation, and robust debugging.

The target experience:

> I ask the main agent to implement something. It does the work. I ask a reviewer subagent to review it. The reviewer finds three issues. I then tell the main agent to spin up two fixer subagents for findings 1 and 2. They start in the background while I keep talking to the main agent. When they finish, the parent session is automatically updated and the main agent reacts without me polling.

## Core principles

### 1. Preserve the simple synchronous API

The existing `subagent` tool remains the foreground convenience API.

It should continue to mean:

- run these subagent calls now
- wait for them to finish
- return their results directly

All background behavior is additive.

### 2. Optimize for interactive orchestration

The main use case is an active human + parent agent session, not only unattended workflows.

The parent should be able to:

- start background work
- continue talking with the user
- receive job completion automatically
- decide how to reconcile results
- start more work if needed

### 3. Make background work visible

Background jobs must not feel hidden.

The user and parent agent should be able to see:

- what is running
- who started it
- which agents are involved
- what each agent is currently doing
- whether anything failed
- what artifacts/results were produced

### 4. Start conservative, deepen over time

Begin with in-memory root-only background jobs. Add persistence, recovery, cancellation, workflows, and worktree isolation after the core loop is proven.

### 5. Prefer existing subagent semantics

Background execution should reuse current subagent concepts:

- Markdown-discovered agents
- agent frontmatter
- per-call model override
- per-call cwd
- parent-context seeding
- depth limits
- cycle prevention
- TUI rendering
- result normalization

## Target user stories

### Background fixer delegation

1. Parent agent implements feature.
2. Reviewer subagent reports findings.
3. Parent starts background fixer subagents for selected findings.
4. Fixers edit the working tree.
5. Parent continues interacting with user.
6. Fixers finish.
7. Completion message is injected into the parent session.
8. Parent agent inspects changes, runs tests, and summarizes outcome.

### Background exploration

1. User asks parent a broad architectural question.
2. Parent starts several explorer subagents in background:
   - one maps API surface
   - one maps tests
   - one maps data flow
3. Parent continues clarifying requirements with the user.
4. Results arrive and become context for the next response.

### Parallel review passes

1. Parent starts multiple reviewer subagents:
   - standards review
   - spec review
   - security review
   - test coverage review
2. Reviews run in parallel.
3. Parent receives a consolidated result and prioritizes findings.

### Long-running workflows

1. User starts a named workflow from a YAML/JSON definition.
2. Jobs run through dependency waves.
3. Status persists to disk.
4. User can inspect status from another shell or later session.
5. Parent can collect final artifacts.

## Execution modes

Each call or agent can eventually support an execution mode.

### Foreground

Current behavior.

- parent waits
- result returned directly from tool
- best for small tasks and tasks required before continuing

### Background

New behavior.

- tool returns immediately with a job ID
- subagents continue running
- completion is reported later
- best for independent or long-running tasks

### Either

Future agent preference.

- agent advertises that both modes are appropriate
- parent chooses based on task shape

## Proposed tool lifecycle

### `subagent`

Existing synchronous tool.

Used when parent needs results before continuing.

### `subagent_start`

Starts one or more background calls and returns immediately.

Returns:

- job ID
- started calls
- warnings
- completion delivery mode

### `subagent_status`

Inspects a job without dumping full results.

Returns:

- job status
- per-call status
- last activity
- short progress snippets
- errors if any

### `subagent_collect`

Waits for or retrieves final results.

Suggested semantics:

```json
{
  "jobId": "subjob_123",
  "waitMs": 300000
}
```

Behavior:

- if complete, return immediately
- if running, wait up to `waitMs`
- if completed during wait, return final result
- if still running after timeout, return compact status
- if interrupted, respect `AbortSignal`

### `subagent_cancel`

Requests cancellation.

Should:

- abort child processes
- mark job cancelled
- release locks
- post/update status

## Completion delivery

Background jobs should support completion modes.

```ts
type CompletionMode = "silent" | "notify" | "message" | "trigger";
```

### `silent`

No session message. Job can be inspected with `status` or `collect`.

### `notify`

TUI notification/widget only. Does not add context.

### `message`

Inject a custom session message with job summary. Does not automatically trigger a parent response.

### `trigger`

Inject a custom session message and trigger/follow-up a parent response.

This is the key mode for interactive orchestration.

Implementation likely uses:

```ts
pi.sendMessage(..., {
  deliverAs: "followUp",
  triggerTurn: true,
});
```

## Background job model

Initial in-memory shape:

```ts
interface BackgroundJob {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: "running" | "completed" | "failed" | "cancelled";
  calls: BackgroundCall[];
  results: SingleResult[];
  error?: string;
  promise: Promise<SingleResult[]>;
  abortController: AbortController;
  completionMode: CompletionMode;
}
```

Future filesystem-backed shape:

```text
.pi-subagent/jobs/<jobId>/
  state.json
  events.jsonl
  result.md
  logs/
  artifacts/
```

Filesystem state enables:

- debugging
- status from outside Pi
- future recovery
- large artifacts without flooding context
- durable audit trail

## Rich event capture

Current runner output mostly preserves final assistant text. The product should eventually capture a structured execution trace.

Target event types:

- process start
- process exit
- assistant message
- tool start
- tool result
- errors
- artifacts
- file reads/writes
- command summaries
- progress updates

Purpose:

- better `subagent_status`
- better TUI expansion
- better debugging
- better parent summaries
- safer background orchestration

Important constraint:

Do not dump raw event streams into the parent context by default. Store structured events externally and return compact summaries.

## TUI experience

Background work should be visible while staying unobtrusive.

Possible collapsed widget:

```text
Subagents
  [....] subjob_123: fixer x2, 1 running, 1 done
  [wait] subjob_124: reviewer
```

Expanded view:

```text
subjob_123 running for 2m14s
  fixer #1: running
    last: edited runner.ts
  fixer #2: completed
    result: fixed render test failure
```

Final message should be concise and evidence-backed.

## Editing model

### Phase 1: shared working tree

Background subagents run in the same working tree and may edit files concurrently.

The parent/user is responsible for assigning disjoint scopes.

The tool contract should warn:

> Background subagents share the same working tree. Give each subagent a clearly disjoint file/task scope to avoid conflicting edits.

### Future: safer isolation modes

Possible modes:

```ts
type WorkspaceMode = "shared" | "patch" | "worktree";
```

#### `shared`

Current/simple behavior.

#### `patch`

Subagent does not edit working tree directly. It writes proposed patches/artifacts.

#### `worktree`

Each background call gets its own git worktree/branch. Parent collects diffs and decides how to merge.

This is the safest long-term model for concurrent fixer agents.

## Runtime limits and safety

Make limits configurable over time.

Potential controls:

- max active background jobs
- max calls per job
- max concurrency per job
- timeoutMs
- maxTurns
- token/cost budget
- allow background from subagents
- allow shared working tree edits
- allow persistent sessions in background

Initial defaults should be conservative:

- root-only background starts
- small active job limit
- no named persistent sessions in background v1
- existing delegation depth/cycle prevention still applies

## Persistent sessions and locks

Current persistent subagent sessions use lock directories. Background jobs complicate this because locks must remain held until the actual background work completes, not until `subagent_start` returns.

Future design:

- job owns lock lifecycle
- locks released in job `finally`
- status exposes lock metadata
- stale lock cleanup detects dead local PIDs
- explicit unlock/cleanup command exists
- force unlock only when clearly requested

For the first background slice, named persistent sessions should be disallowed.

## Agent discovery diagnostics

Background orchestration makes agent visibility more important.

Add a diagnostics/list tool eventually:

```text
subagent_list
```

It should report:

- available agents
- source paths
- parsed frontmatter
- source precedence/project overrides
- invalid skipped files
- name conflicts
- close-match suggestions for unknown agents

This improves debugging when agent files change mid-session or project agents override user agents.

## Agent definition validation

Add schema/lint validation for agent Markdown files.

Validate:

- names
- duplicate names
- model values
- thinking values
- tools
- unsupported frontmatter fields
- trust/source metadata

Project-local agents are repo-controlled and can override user agents, so trust signals matter.

## Workflow orchestration

After background jobs are proven, add optional workflow support inspired by `oh-my-pi` swarm.

Useful borrowed concepts:

- DAG dependencies
- execution waves
- sequential/parallel/pipeline modes
- filesystem state directory
- progress renderer
- YAML workflow format

But execution should use this repository’s existing `runAgent` path so it preserves:

- Markdown agent discovery
- sessions
- parent-context seeding
- depth/cycle guards
- Pi process invocation semantics

Possible workflow YAML shape adapted to existing subagents:

```yaml
workflow:
  name: codebase-audit
  workspace: .
  mode: parallel
  agents:
    security:
      agent: reviewer
      prompt: |
        Review security concerns in src/.
      reports_to: [lead]

    performance:
      agent: reviewer
      prompt: |
        Review performance concerns in src/.
      reports_to: [lead]

    lead:
      agent: reviewer
      prompt: |
        Read the security and performance reports and synthesize priorities.
      waits_for: [security, performance]
```

## Product phases

### Phase 0: Thin proof

- `subagent_start`
- in-memory job registry
- root-only
- ephemeral sessions only
- shared working tree allowed
- completion message injection
- `onComplete: trigger`

### Phase 1: Basic lifecycle

- `subagent_status`
- `subagent_collect`
- `subagent_cancel`
- active job limits
- TTL cleanup
- compact TUI widget

### Phase 2: Rich observability

- structured child events
- progress state
- event logs
- better failure diagnostics
- expanded TUI rendering

### Phase 3: Safer execution

- optional patch mode
- optional git worktree mode
- better conflict detection
- parent-driven merge/reconcile flow

### Phase 4: Persistence and recovery

- filesystem job state
- status after reload/restart
- stale process detection
- recovery/cleanup commands

### Phase 5: Workflows

- DAG/wave execution
- YAML/JSON workflow start
- pipeline/sequential/parallel modes
- artifacts and reports

### Phase 6: Advanced policy/config

- configurable budgets
- model/cost controls
- per-agent execution preferences
- background permissions
- nested background delegation policy

## Open questions

1. Should background starts from subagents ever be allowed, or only from root sessions?
2. Should completion use custom messages or user messages by default?
3. How much detail should completion inject into context vs store externally?
4. When should same-tree editing warn vs require confirmation?
5. What is the right default for `onComplete`: `message` or `trigger`?
6. Should background jobs survive `/new`, `/reload`, or session switch?
7. How should child process cancellation interact with Pi tool cancellation and session flush?
8. Should workflow YAML define inline agents, reference existing agents, or support both?

## North-star experience

The final product should feel like this:

```text
User: Fix the auth bug, then have someone review it.
Parent: I implemented the fix and started a reviewer in the background.

[Subagents]
  [....] subjob_42 reviewer

User: While that runs, can you explain the tradeoff?
Parent: Sure...

System: Background subagent job subjob_42 completed.
Parent: The reviewer found two issues. I can fix both independently, so I’m starting two background fixers.

[Subagents]
  [....] subjob_43 fixer/auth-tests
  [....] subjob_44 fixer/error-handling

System: Background subagent jobs completed.
Parent: Both fixers completed. I inspected the diffs, ran tests, and everything passes. Here is what changed...
```

That is the core value: Pi becomes an interactive orchestrator with visible, useful, asynchronous specialist work.
