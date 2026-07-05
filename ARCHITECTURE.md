# Pi Subagent Architecture

This is the top-level architectural map for `@mjakl/pi-subagent`. It is written for maintainers and new contributors who need to understand how delegation works end to end before changing the extension.

For the interactive one-page version, open [`architecture.html`](architecture.html).

## System at a glance

`pi-subagent` is a Pi extension that teaches the parent Pi agent about available specialist agents, then exposes tools that run those specialists in separate `pi` child processes.

The main path is:

1. Pi loads [`index.ts`](index.ts) as the extension entry point.
2. The extension discovers Markdown agent definitions through [`agents.ts`](agents.ts).
3. [`contract.ts`](contract.ts) injects the available subagents and usage rules into the parent agent prompt.
4. The parent agent calls `subagent`, `subagent_start`, `subagent_status`, `subagent_cancel`, or `subagent_result`.
5. [`index.ts`](index.ts) validates and normalizes calls, applies depth/cycle/session guards, then delegates process execution to [`runner.ts`](runner.ts).
6. [`runner.ts`](runner.ts) spawns isolated `pi --mode json -p ...` processes, streams JSON events through [`runner-events.js`](runner-events.js), and returns normalized results from [`types.ts`](types.ts).
7. [`render.ts`](render.ts) formats progress, results, background job status, and expanded TUI output.

## Focused architecture notes

- [Extension lifecycle and tool surface](docs/architecture/01-extension-lifecycle.md)
- [Agent discovery and configuration](docs/architecture/02-agent-discovery.md)
- [Delegation execution pipeline](docs/architecture/03-delegation-execution.md)
- [Persistent sessions and context propagation](docs/architecture/04-sessions-and-context.md)
- [Background jobs and cancellation](docs/architecture/05-background-jobs.md)
- [Events, result normalization, and rendering](docs/architecture/06-events-and-rendering.md)
- [Operational limits and risk areas](docs/architecture/07-operational-limits.md)
- [Future enhancements and current limitations](docs/architecture/08-future-enhancements-and-current-limitations.md)

## Architectural responsibilities

| Area | Owner | Responsibility |
| --- | --- | --- |
| Extension entry point | [`index.ts`](index.ts) | Pi lifecycle hooks, tool registration, validation, orchestration, guards, background job execution |
| Agent loading | [`agents.ts`](agents.ts) | User/project agent discovery, Markdown frontmatter parsing, starter `explore` creation |
| Contract text | [`contract.ts`](contract.ts) | Tool descriptions, schema wording, injected prompt instructions |
| Child process runtime | [`runner.ts`](runner.ts) | Temp prompt/session files, CLI argument construction, process spawning, streaming updates, abort handling |
| Event parsing | [`runner-events.js`](runner-events.js) | Pi JSON event parsing, assistant message deduplication, final text/error summaries |
| Shared state model | [`types.ts`](types.ts) | Normalized calls, result shape, usage aggregation, success/error semantics |
| Background registry | [`background-jobs.ts`](background-jobs.ts) | Live in-memory job registry, job mutation helpers, active counts, ID generation, optional disk persistence |
| Background job store | [`background-job-store.ts`](background-job-store.ts) | Durable persistence for background job state (atomic writes, load/save/delete) |
| Background activity | [`background-activity.ts`](background-activity.ts) | Deduplicated recent activity tracking from streamed partial results |
| Background lifecycle | [`background-lifecycle.ts`](background-lifecycle.ts) | Cancellation-safe per-call lifecycle transitions |
| Isolated worktrees | [`worktree.ts`](worktree.ts) | Git worktree creation, changed-file detection, and patch artifact generation |
| Session locking | [`session-lock.ts`](session-lock.ts) | Filesystem locks for named persistent subagent sessions |
| Session paths | [`session-paths.ts`](session-paths.ts) | Default Pi session directory derivation and creation |
| TUI rendering | [`render.ts`](render.ts) | Collapsed and expanded displays for foreground and background tools |
| CLI inheritance | [`runner-cli.js`](runner-cli.js) | Parent Pi flag parsing and child-safe forwarding |

## Core design choices

### Child processes instead of in-process agents

Each subagent runs in an isolated `pi` process. This keeps specialist runtime state, tools, model selection, and session files independent from the parent process. The parent observes the child through Pi JSON-mode events rather than sharing memory.

### Contract text is centralized

The tool schema descriptions, tool help text, and injected parent prompt all flow from [`contract.ts`](contract.ts). This reduces drift between what the parent agent is told and what the TypeBox schemas accept.

### Calls are normalized once

`index.ts` converts raw tool parameters into `NormalizedCall` records before execution. Later code works with absolute cwd values, parsed `initialContext`, optional per-call model overrides, and optional derived session identities.

### Persistent sessions are deterministic

Named subagent session IDs are derived from parent session ID, effective cwd, agent name, and logical session handle. The same logical handle used with different agents or cwd values intentionally resolves to different Pi sessions.

### Background jobs are durable

Background jobs have a live in-memory registry and an optional disk-backed store under `.pi-subagent/jobs/<jobId>/` via [`background-job-store.ts`](background-job-store.ts). Terminal jobs (completed, failed, cancelled, interrupted) survive parent process restarts and can still be inspected via `subagent_status` and `subagent_result`. Jobs that were running when the process exited are reloaded with status `interrupted`; jobs that were cancelling are only reloaded as `cancelled` when their persisted call states already prove cancellation completed.

Persistence uses atomic writes (write to temp file, then rename) and excludes unserializable fields (promise, abortController, live callbacks).

### Isolated worktrees are optional and job-scoped

Background jobs default to the parent working tree. With `worktreeMode: "isolated"`, the extension creates one git worktree for the whole job, runs every call at the corresponding repo-relative cwd inside that worktree, records changed files, and writes a `worktree.patch` artifact when changes exist. Multi-call isolated jobs still share that one isolated worktree.

## High-level data flow

```text
User request
  -> parent Pi agent
  -> injected subagent contract
  -> subagent tool call
  -> index.ts validation, guards, session identity
  -> runner.ts child pi process
  -> runner-events.js assistant event parsing
  -> types.ts result normalization
  -> render.ts TUI output and parent-facing summary
```

## Important constraints

- Foreground `subagent` accepts up to 8 calls and runs up to 4 concurrently.
- Background jobs are root-session-only, accept no persistent sessions, do not support `initialContext: "parent"` yet, and are limited to 2 active jobs with 2 calls running concurrently per job.
- Delegation defaults to max depth 3 and cycle prevention enabled.
- Named sessions require a persisted parent Pi session and are blocked from temporary parent-seeded subagent sessions.
- Background jobs can run in the parent working tree or in a job-level isolated worktree. Isolated mode requires a clean git worktree and a named branch.
- Session locks are filesystem directories with heartbeat metadata, not OS-level advisory locks.

## Where to start for changes

- To change the public API or prompt guidance, start in [`contract.ts`](contract.ts), then update schema handling in [`index.ts`](index.ts).
- To change process behavior, start in [`runner.ts`](runner.ts) and check [`runner-cli.js`](runner-cli.js).
- To change named session behavior, review [`index.ts`](index.ts), [`session-lock.ts`](session-lock.ts), and [`session-paths.ts`](session-paths.ts) together.
- To change background execution, review [`index.ts`](index.ts), [`background-jobs.ts`](background-jobs.ts), [`background-job-store.ts`](background-job-store.ts), [`background-activity.ts`](background-activity.ts), [`background-lifecycle.ts`](background-lifecycle.ts), [`worktree.ts`](worktree.ts), [`types.ts`](types.ts), and the background rendering helpers in [`render.ts`](render.ts).
- To change user-visible TUI output, change [`render.ts`](render.ts) and keep result shape compatibility with [`types.ts`](types.ts).
