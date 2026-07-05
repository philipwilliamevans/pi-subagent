# Delegation Execution Pipeline

Foreground delegation moves from a parent tool call to one or more child Pi processes. The orchestration lives in [`index.ts`](../../index.ts); the process runtime lives in [`runner.ts`](../../runner.ts).

## Call normalization

`normalizeCalls` validates and converts raw tool parameters into `NormalizedCall` objects:

- `agent` must be a non-empty string.
- `prompt` must be a non-empty string and is passed verbatim.
- `model`, when present, must be a non-empty string.
- `cwd`, when present, is resolved relative to the parent cwd and must exist as a directory.
- `initialContext` is `"empty"` by default and may be `"parent"`.
- `session`, when present, is trimmed and length-limited.

The foreground call limit is 8.

## Concurrency model

`executeCalls` uses `mapConcurrent` from `runner.ts`.

| Mode | Limit |
| --- | --- |
| Foreground `subagent` calls per invocation | 8 |
| Foreground concurrent child processes | 4 |
| Background active jobs | 2 |
| Background concurrent calls per job | 2 |

`executeCalls` maintains placeholder results for running calls and emits heartbeat updates every second while work is still active.

Background calls use the same `runAgent` primitive. In shared mode they run in each call's effective cwd. In isolated mode every call in the job runs at the corresponding repo-relative cwd inside the same job-level git worktree.

## Child process creation

`runAgent` builds and starts a child process equivalent to:

```text
pi --mode json [inherited flags] --cwd <effective cwd> -p [session flags] [model/tools/thinking flags] [system prompt file] <prompt>
```

The actual command is derived from the current process:

- If Pi is running through Node, the child uses `process.execPath` plus the current script path.
- Otherwise, the child uses `process.execPath` directly.
- `shell: false` is used.

## Temporary files

`runner.ts` writes temporary files under the OS temp directory:

- The agent system prompt is written to `prompt-<agent>.md`.
- Parent session snapshots for `initialContext: "parent"` are written to `parent-<agent>.jsonl`.

Temp directories are removed in a `finally` block after the child process completes.

## Environment propagation

Child processes receive:

- The parent environment.
- Incremented `PI_SUBAGENT_DEPTH`.
- Propagated `PI_SUBAGENT_MAX_DEPTH`.
- JSON `PI_SUBAGENT_STACK`.
- `PI_SUBAGENT_PREVENT_CYCLES`.
- `PI_SUBAGENT_TEMP_PARENT_SESSION` for temporary parent-seeded calls.
- `PI_OFFLINE=1` to avoid Pi startup network work.

Agentflow environment variables are also translated into child CLI flags when present.

## CLI inheritance

[`runner-cli.js`](../../runner-cli.js) parses the parent process arguments and separates them into:

- `extensionArgs`: extension-related flags forwarded with path resolution.
- `alwaysProxy`: provider, theme, skill, session-dir, telemetry, and similar flags forwarded to every child.
- fallback model/thinking/tools values used only when the agent file and call do not override them.

This keeps child Pi invocations aligned with the parent without forwarding flags that would conflict with child execution.

## Completion handling

`runAgent` streams stdout by line and passes each JSON event line to `processPiJsonLine`. A child can complete in two ways:

- The process exits normally.
- For non-persistent sessions, an `agent_end` event with assistant output is treated as semantic completion after a short grace period, then the child is terminated to avoid waiting on extra process shutdown.

Named persistent sessions are allowed to exit naturally so their session files can flush. If they do not exit within 30 seconds after semantic completion, the process is terminated and marked as a process error.
