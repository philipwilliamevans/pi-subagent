# ADR 001: Reset Persistent Session Exit Timer on Pi Agent Cycle Restart

**Status:** Accepted

## Context

Named subagent sessions wait 30 s after `agent_end` for the child process to exit naturally (to flush the session file to disk before the parent reports completion). The timer is set once when `agent_end` arrives and fires if the child has not terminated within the window.

However, Pi may auto-retry after a transient model API error (e.g., a Codex 5xx). The event sequence is:

1. `agent_end` with `stopReason=error` → 30 s exit timer starts.
2. `auto_retry_start` → Pi begins a retry.
3. `agent_start` / `turn_start` → Pi starts a new agent cycle.
4. The retry model call succeeds and streams output.
5. If step 4 takes >30 s (tool calls + streaming), the timer from step 1 fires **mid-stream**, killing the child process and truncating useful output.

Real event journaling from `subjob_a26627c6` confirmed the pattern: a timer set during an error `agent_end` fired mid-word (`"ists"` — the tail of `"Persists"`) during the retry's output streaming.

## Decision

Detect `agent_start` and `turn_start` lifecycle events as signals that a new agent cycle has begun after a previous `agent_end`. When these events arrive in a named-session context, reset the exit timer so the retry has a full timeout window.

Two changes implement this decision:

1. **`runner-events.js`**: `processPiEvent` handles `agent_start` and `turn_start` by setting `result.sawAgentEnd = false`, signalling to the runner that the previous `agent_end` was not terminal.

2. **`runner.ts`**: The `flushLine` callback in the named-session path checks each line for new-cycle events via `isNewAgentCycle()` and calls `clearPersistentSessionExitTimer()` when one is detected. A new exported helper `isNewAgentCycle` parses a JSON line and returns `true` for `agent_start` and `turn_start` types.

## Consequences

### Positive

- Transient errors followed by a successful retry no longer cause output truncation. The retry's full output is preserved.
- The change is event-driven and does not introduce new state machines or async control flow.
- The fix is specific to the named-session exit timer; the ephemeral (250 ms) completion path is unaffected.

### Negative

- None identified.

### Neutral

- Non-transient errors (no retry) still trigger the timer correctly — the timer fires and the job is marked as failed.
- Successful completions are unaffected — the timer is set once and cleared by `finish()` or fires after the grace period.
- Each `turn_start` during a normal multi-turn session also resets the timer, but this is safe: the 30 s clock restarts for each new turn.

## Alternatives Considered

1. **Extend the timeout**: Increasing `PERSISTENT_SESSION_EXIT_TIMEOUT_MS` would reduce the chance of truncation but would also delay error detection for genuinely hung processes. It does not fix the root cause.

2. **Disable the timer on error**: Would lose the safety net for cases where the process never emits a second cycle. The error-detection value of the timer would be lost.

3. **Suppress `agent_end` on retryable errors in Pi's runtime**: Would couple the extension to Pi's internal retry logic and require changes outside this repository. Not feasible without Pi runtime cooperation.

4. **Count retry attempts and extend the timer proportionally**: More complex and fragile; couples the extension to retry parameters (count, delay) that Pi may change.

The chosen approach is minimal, testable, and relies only on observable event types that are already part of Pi's JSON-mode protocol.

## Evidence

Real event journal from `subjob_a26627c6`:

```
[event 779] agent_end (stopReason=error)       → sawAgentEnd=true, 30s timer starts
[event 780] auto_retry_start (attempt 1/3)      → Pi begins retry
[event 782] turn_start                          → new agent cycle
[event 783+] message_start → tool calls → tool results → message_update (streaming)...
[event 1429] message_update delta="ists"        ← KILLED MID-WORD
```

The last captured delta `"ists"` came from a timer set at event 779. After this fix, event 782 (`turn_start`) resets the timer, giving the retry the full 30 s window.

## Edge Cases

- **Rapid retries (all fail)**: Each `turn_start` resets the timer. The final `agent_end` (no retry) starts a timer that is never reset. The timer fires after 30 s — correct, the process is genuinely done.
- **`agent_start` without preceding `agent_end`** (normal start): `sawAgentEnd` is already `false`; clearing timer is a no-op.
- **Multi-turn conversation**: `turn_start` between turns resets the timer. Safe — the 30 s clock restarts for each new turn.

## Related Documents

- [Architecture: Events and Rendering](../architecture/06-events-and-rendering.md)
- [Architecture: Operational Limits](../architecture/07-operational-limits.md)
