# Extension Lifecycle and Tool Surface

[`index.ts`](../../index.ts) is the extension entry point declared by `package.json` under `pi.extensions`. It registers Pi flags, listens to lifecycle events, discovers subagents, injects guidance into the parent system prompt, and registers the public tools.

## Startup sequence

1. Pi imports the default export from `index.ts`.
2. The extension registers:
   - `--subagent-max-depth`
   - `--subagent-prevent-cycles` / `--no-subagent-prevent-cycles`
3. Runtime delegation config is resolved from CLI flags, Pi runtime flags, and environment variables.
4. On `session_start`, the extension configures the background job store under the current cwd, reloads persisted jobs, discovers agents, and may create the starter `explore` agent.
5. On `before_agent_start`, the extension appends available subagent information and tool rules to the parent agent system prompt.
6. If depth allows delegation, the extension registers the foreground and background tool set.

## Registered tools

| Tool | Purpose | Execution style |
| --- | --- | --- |
| `subagent` | Run one or more subagent calls and wait for results | Foreground, bounded parallelism |
| `subagent_start` | Start a background job and return immediately | Root parent only, live job with persisted state |
| `subagent_status` | List jobs or inspect one job | Read-only |
| `subagent_cancel` | Abort a running background job | Requires `confirm: true` |
| `subagent_result` | Retrieve full output from completed background jobs | Read-only |

## Foreground tool flow

The `subagent` tool performs these steps:

1. Rediscover agents for the current cwd.
2. Normalize `params.calls`.
3. Derive persistent session identities when `session` handles are present.
4. Reject duplicate or active session use.
5. Enforce parent session requirements for named sessions.
6. Enforce cycle prevention.
7. Acquire filesystem locks for persistent sessions.
8. Resolve whether each named session is being created or continued.
9. Snapshot the parent session if needed for `initialContext: "parent"`.
10. Execute calls through `executeCalls`, which delegates to `runAgent`.
11. Release locks and active-session reservations.

## Background tool flow

The `subagent_start` tool is deliberately narrower:

- It only runs at root delegation depth.
- It rejects persistent sessions.
- It rejects `initialContext: "parent"`.
- It enforces the active background job limit.
- It accepts `worktreeMode: "shared"` (default) or `"isolated"`.
- It checks git preconditions before starting isolated worktree jobs.
- It creates a live `BackgroundJob` and persists state when the job store is configured.
- It starts asynchronous execution and returns the job ID immediately.

Completion is posted back into the parent session with `pi.sendMessage` unless the job uses `onComplete: "silent"`.

## Architectural role of `index.ts`

`index.ts` is intentionally the coordination layer. It should own:

- Pi API integration.
- Tool parameter validation.
- Cross-cutting guards.
- Session identity and lock orchestration.
- Job lifecycle transitions.

It should not grow low-level parsing, rendering, or process-spawning details. Those are already separated into dedicated modules.
