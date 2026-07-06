# Events, Result Normalization, and Rendering

The child process boundary is JSON event based. [`runner.ts`](../../runner.ts) reads child stdout, [`runner-events.js`](../../runner-events.js) converts Pi events into assistant messages, [`types.ts`](../../types.ts) defines success semantics, and [`render.ts`](../../render.ts) turns results into TUI output.

## Event parsing

`runner-events.js` recognizes:

- `message_end`
- `turn_end`
- `agent_end`
- `agent_start` — resets `sawAgentEnd = false` so the runner does not treat a previous error `agent_end` as terminal
- `turn_start` — also resets `sawAgentEnd = false`; in a named session this cancels the post-completion exit timer so an auto-retry gets a full timeout window

Assistant messages are deduplicated by stable JSON stringification. Each accepted assistant message updates:

- `result.messages`
- `result.model`
- `result.stopReason`
- `result.errorMessage`
- token usage counters
- turn count

`agent_end` also sets `sawAgentEnd = true`. `agent_start` and `turn_start` set it back to `false`.

## Final output

`getFinalAssistantText` walks backward through assistant messages and returns the last non-empty text part. This is the core text surfaced in summaries and completion messages.

Tool calls are retained in `messages` and exposed through `getDisplayItems`, but the default parent-facing summary focuses on final assistant text.

## Success semantics

`types.ts` separates process exit status from semantic completion:

- A result with `exitCode === -1` is still running.
- A process error always makes the result fail.
- If the child emitted `agent_end` and final assistant text, the result can be considered successful even if the process later returned a non-zero exit code, unless `processError` is set.
- Aborted runs become exit code 130 unless semantic success had already arrived.

This design accounts for Pi child processes that have delivered useful final output but do not exit cleanly.

## TUI rendering

`render.ts` provides renderers for every tool:

- foreground call and result
- background start
- background status
- background cancellation
- background result retrieval

Foreground results have collapsed and expanded views:

- Collapsed view shows status, recent output/tool calls, and total usage.
- Expanded view shows each call, source, initial context status, session metadata, prompt, tool calls, final Markdown output, errors, and usage.

## Background formatting

The same module formats text for:

- completion messages injected into the parent session
- job list output
- single-job status
- full job result retrieval

Background completion excerpts are capped at 2000 characters per call. `subagent_result` can return full final text and optionally tool call traces.

## Rendering boundary

Rendering code depends on the stable result structures from `types.ts`; execution code should avoid embedding UI formatting. That separation keeps tool behavior testable without the TUI and keeps user-facing presentation localized.

