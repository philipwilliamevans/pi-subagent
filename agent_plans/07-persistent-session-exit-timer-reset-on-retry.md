# Phase 7: Reset Persistent Session Exit Timer on Pi Auto-Retry

## Goal

Prevent the named-session exit timer from killing a subagent process mid-stream when Pi auto-retries after a transient model API error. The subagent's useful output should be captured even when the first model call in a turn fails and Pi's built-in retry mechanism produces the real answer.

## Observed Bug

When Pi's model API returns a transient error (e.g., a Codex API 5xx), Pi:

1. Records the error message in the conversation.
2. Emits `turn_end` with `stopReason=error`.
3. Emits `agent_end` — **this tells the runner "the agent is done."**
4. Starts an auto-retry via its built-in mechanism (`auto_retry_start`, then `agent_start`, `turn_start`).
5. The retry succeeds and the model streams a complete response.

The problem is in step 3: `runner.ts` sees `agent_end`, sets `sawAgentEnd = true`, and starts the **30s named-session exit timer**. The timer is set once and never cleared. When the retry's response takes >30s (tool calls + streaming), the timer fires **mid-stream**, killing the child process and truncating the output.

### Concrete trace from `subjob_a26627c6`

```
[event 779] agent_end (stopReason=error)       → sawAgentEnd=true, 30s timer starts
[event 780] auto_retry_start (attempt 1/3)      → Pi begins retry
[event 782] turn_start                          → new agent cycle
[event 783+] message_start → tool calls → tool results → message_update (streaming)...
[event 1429] message_update delta="ists"        ← KILLED MID-WORD
```

The last captured delta is `"ists"` — the tail of the word `"Persists"` — the assistant was actively writing when the timer from step 1 fired and killed the process.

## Solution

Two changes that work together:

### 1. `runner-events.js` — Reset `sawAgentEnd` on new cycle events

Add handling for `agent_start` and `turn_start` so the runner knows the previous `agent_end` was not terminal:

```javascript
case "agent_start":
case "turn_start":
  // Pi has started a new agent cycle (e.g., auto-retry after a transient
  // model error). Clear the semantic-completion flag so the runner does
  // not treat the previous agent_end as terminal.
  result.sawAgentEnd = false;
  return false;
```

### 2. `runner.ts` — Clear the exit timer when a new cycle begins

In the `flushLine` callback, detect new agent cycles and cancel the running exit timer. When the retry's own `agent_end` arrives, a fresh timer will be created:

```typescript
/**
 * Quick JSON-type check for Pi lifecycle events that signal a new agent
 * cycle has begun (typically after an auto-retry from a transient error).
 */
function isNewAgentCycle(line: string): boolean {
  try {
    const event = JSON.parse(line);
    return event.type === "agent_start" || event.type === "turn_start";
  } catch {
    return false;
  }
}

// Inside the Promise callback, in flushLine:
const flushLine = (line: string) => {
  // If Pi starts a new cycle after agent_end (auto-retry), cancel the
  // named-session exit timer so the retry gets a full timeout window.
  if (session && isNewAgentCycle(line)) {
    clearPersistentSessionExitTimer();
  }
  if (processRunnerJsonLine(line, result, onEvent)) emitUpdate();
  maybeFinishFromAgentEnd();
};
```

### How it works end-to-end

| Scenario | `agent_end` fires | Timer starts | `turn_start` / `agent_start` fires? | Timer cancelled? | Outcome |
|---|---|---|---|---|---|
| **Transient error → retry succeeds** | Yes (error) | Yes | ✅ Yes | ✅ Cancelled on turn_start → fresh 30s timer starts on retry's agent_end | Retry completes normally, full output captured |
| **Transient error → all retries fail** | Yes (error × N) | Yes (×N) | ✅ Yes for retries 1..N-1, ❌ No after final retry | ✅ Cancelled on each retry's turn_start; final timer not cancelled | Timer fires after last retry — process killed correctly |
| **Non-transient error (no retry)** | Yes (error) | Yes | ❌ No | ❌ Never cancelled | Timer fires — process killed correctly |
| **Successful answer → process exits** | Yes (stop) | Yes | ❌ No | ❌ Never cancelled | `finish()` called before timer — timer cleared by `clearPersistentSessionExitTimer()` in `finish()` |
| **Successful answer → process lingers** | Yes (stop) | Yes | ❌ No | ❌ Never cancelled | Timer fires — existing policy tradeoff, unchanged by this fix |

## Acceptance Criteria

1. **Error → retry → success**: When Pi emits `agent_end` with `stopReason=error` followed by `auto_retry_start`, `agent_start`, `turn_start`, and a successful retry `agent_end`, the runner preserves the retry's full output without truncation. The job is not marked as failed due to the timer from the first `agent_end`.

2. **Error → no retry (non-transient)**: When Pi emits `agent_end` with `stopReason=error` and no `turn_start` follows, the 30s timer fires and the job is marked as failed. Existing behavior unchanged.

3. **Error → all retries exhausted**: When Pi emits `auto_retry_start` followed by retry errors for all attempts, the final `auto_retry_end` with `success=false` does not trigger a new turn. The timer from the final error `agent_end` fires and kills the process. Existing behavior unchanged.

4. **Successful answer → process exits**: When Pi emits `agent_end` with `stopReason=stop` and the child process exits within 30s, `finish()` clears the timer. The result is marked as successful. Existing behavior unchanged.

5. **`sawAgentEnd` correctly toggles**: `runner-events.js` resets `sawAgentEnd` to `false` on `agent_start` and `turn_start` events. It is set back to `true` on the next `agent_end`.

## Code Changes

### Files to modify

| File | Change | Risk |
|---|---|---|
| `runner-events.js` | Add `agent_start` / `turn_start` cases to `processPiEvent` that set `result.sawAgentEnd = false` | Low — new event types, no existing behavior affected |
| `runner.ts` | Add `isNewAgentCycle()` helper and call `clearPersistentSessionExitTimer()` in `flushLine` when a new cycle is detected | Low — only affects the timer-clear path; no effect when no new cycle follows |

### Files to create

| File | Purpose |
|---|---|
| `docs/adr/001-persistent-session-exit-timer-reset.md` | Architecture Decision Record documenting the observed failure, analysis, decision, and trade-offs |

### Files to update (documentation)

| File | Change |
|---|---|
| `docs/architecture/06-events-and-rendering.md` | Add note about `agent_start`/`turn_start` handling and timer reset logic |
| `docs/architecture/07-operational-limits.md` | Update the "Persistent session post-completion exit timeout" description to note the re-arm behavior on auto-retry |

## Tests

### `test/runner-events.test.mjs`

Add test cases for `processPiEvent`:

1. **`agent_start resets sawAgentEnd`**: Call `processPiEvent({ type: "agent_start" })` on a result that has `sawAgentEnd = true`. Verify `sawAgentEnd` is `false` after the call.

2. **`turn_start resets sawAgentEnd`**: Same as above but with `turn_start`.

3. **`sawAgentEnd remains false on other events`**: Call `processPiEvent` with `message_start`, `message_update`, `auto_retry_start`, etc. and verify `sawAgentEnd` is unchanged.

4. **`sawAgentEnd goes true → false → true`**: Sequence: `agent_end` (sets true) → `turn_start` (sets false) → `agent_end` (sets true). Verify the final value is `true`.

### `test/runner.test.mjs`

The timer logic lives inside the `Promise` callback in `runAgent`, which makes it hard to test in isolation. Strategies:

1. **Extract `isNewAgentCycle` as an exported function** from `runner.ts` and test it directly:
   - Returns `true` for `{"type":"agent_start"}` and `{"type":"turn_start"}`
   - Returns `false` for `{"type":"agent_end"}`, `{"type":"message_update"}`, malformed JSON, empty string

2. **Fixture-based integration test**: Create a fixture JSONL that simulates the error → retry → success event sequence (modeled on the real `subjob_a26627c6` events). Feed it through `processRunnerJsonLine` and verify:
   - After the error `agent_end`, `result.sawAgentEnd` is `true`
   - After the subsequent `turn_start`, `result.sawAgentEnd` is `false`
   - After the retry's `agent_end`, `result.sawAgentEnd` is `true` again

3. **Timer behavior test**: This is harder to test without real timers. Options:
   - Use `vi.useFakeTimers`-style approach with `sinon` or a manual mock (but this project uses Node's built-in test runner)
   - Extract the timer logic into a separate function/class that can be tested with fake timers
   - Test indirectly by checking that `flushLine` triggers `clearPersistentSessionExitTimer` when called with a new-cycle line (needs the closure variables to be accessible)
   
   **Recommendation**: Accept that the timer-clear logic in `flushLine` is an emergent behavior of the closure and test it through the `runAgent` function with a mocked child process that emits the right events. Keep these tests focused on the `sawAgentEnd` toggling (which is testable via `processPiEvent`) and document the timer behavior as covered by manual verification or future integration tests.

### Test fixtures

Create `test/fixtures/error-retry-success.jsonl`:

```jsonl
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"some-file.ts"}}],"model":"test-model","stopReason":"toolUse","usage":{"input":10,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":12,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"timestamp":1}}
{"type":"tool_execution_end","toolCallId":"call_1","toolName":"read","result":{"content":[{"type":"text","text":"file content"}],"isError":false}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"I read the file"}],"model":"test-model","stopReason":"toolUse","usage":{"input":12,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":13,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"timestamp":2},"toolResults":[]}
{"type":"message_start","message":{"role":"assistant","content":[],"model":"test-model","timestamp":3}}
{"type":"message_end","message":{"role":"assistant","content":[],"model":"test-model","stopReason":"error","errorMessage":"Codex error: transient API failure","usage":{"input":14,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":14,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"timestamp":3}}
{"type":"turn_end","message":{"role":"assistant","content":[],"model":"test-model","stopReason":"error","errorMessage":"Codex error: transient API failure","usage":{"input":14,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":14,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"timestamp":3},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"Your prompt here"}],"timestamp":0},{"role":"assistant","content":[{"type":"toolCall",...}],"timestamp":1},{"role":"toolResult",...},{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Codex error: transient API failure","timestamp":3}]}
{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":1,"errorMessage":"Codex error: transient API failure"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],"timestamp":4}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Here is the complete output I wanted to produce."}],"model":"test-model","stopReason":"stop","usage":{"input":4,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":14,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"timestamp":4}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Here is the complete output I wanted to produce."}],"model":"test-model","stopReason":"stop","usage":{"input":4,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":14,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"timestamp":4},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"Here is the complete output I wanted to produce."}],"stopReason":"stop","timestamp":4}]}
```

## Architecture Decision Record

Create `docs/adr/001-persistent-session-exit-timer-reset.md` covering:

- **Title**: Reset persistent session exit timer on Pi agent cycle restart
- **Status**: Accepted
- **Context**: Named subagent sessions wait 30s after `agent_end` for the child process to exit naturally (to flush the session file). However, Pi may auto-retry after a transient model error, emitting a second `agent_end` when the retry succeeds. The 30s timer from the first (error) `agent_end` can fire during the retry's output streaming, truncating useful results.
- **Decision**: Detect `agent_start` and `turn_start` lifecycle events as signals that a new agent cycle has begun. When these events arrive after an `agent_end`, reset the exit timer so the retry has a full timeout window.
- **Consequences**: Transient errors no longer cause output truncation. Non-transient errors (no retry) still trigger the timer correctly. Successful completions are unaffected.
- **Alternatives considered**: Extending the timeout, disabling the timer on errors, or requiring Pi to suppress `agent_end` on retryable errors — each had drawbacks (masking hangs, losing error-detection, coupling to Pi internals).
- **Evidence**: Real event journal from `subjob_a26627c6` showing the error → retry → mid-word truncation sequence.

## Implementation Notes

### Order of implementation

1. `runner-events.js` — Add the two new event cases. This is the simplest change and can be tested immediately.
2. `runner.ts` — Add `isNewAgentCycle`, modify `flushLine`. Test via fixture.
3. Create test fixture and add test cases.
4. Create ADR document.
5. Update architecture docs.

### Edge case: rapid retries

Pi's auto-retry has `delayMs: 2000` between attempts and `maxAttempts: 3`. If all three retries fail, the sequence would be:

```
agent_end (error 1) → auto_retry_start → agent_start → turn_start → agent_end (error 2) → auto_retry_start → agent_start → turn_start → agent_end (error 3, no retry)
```

Each `turn_start` resets the timer. The final error `agent_end` starts a timer that is never reset. The timer fires after 30s. This is correct behavior — the process has genuinely stopped producing useful work.

### Edge case: `agent_start` without preceding `agent_end`

This is the normal case at process start. `sawAgentEnd` is already `false`, so setting it to `false` again is a no-op. No timer exists yet, so clearing is a no-op as well. Safe.

### Edge case: `turn_start` for tool execution within a turn

During normal operation (no error), Pi emits `turn_start` at the start of each turn, which may be followed by `agent_end` when the turn completes. Then the next `turn_start` is for a new user input or continuation. In this case, `sawAgentEnd` would be set to `false` at the start of the new turn, and a new `agent_end` would follow. The timer would be cleared and restarted. This is safe — the 30s clock restarts for each turn.

## Non-Goals

- Do not change the 30s timeout value. This is a separate tuning concern.
- Do not suppress `agent_end` events in Pi's runtime. The event is correct for Pi's internal lifecycle.
- Do not add a new runtime dependency (e.g., a test framework with fake timers). Use Node's built-in test runner.
- Do not change the non-session (ephemeral) agent completion path. The 250ms `AGENT_END_GRACE_MS` path is unaffected.

## Definition of Done

- `processPiEvent` in `runner-events.js` handles `agent_start` and `turn_start` by resetting `result.sawAgentEnd = false`.
- `isNewAgentCycle` is exported from `runner.ts` and correctly identifies `agent_start` and `turn_start` events.
- `flushLine` in `runner.ts` calls `clearPersistentSessionExitTimer()` when a new agent cycle is detected in a named session.
- The error → retry → success sequence preserves the retry's full output (verified by fixture test).
- The error → no-retry → timeout sequence still fires the timer (unchanged behavior, verified by existing tests).
- ADR document `docs/adr/001-persistent-session-exit-timer-reset.md` exists and covers context, decision, and trade-offs.
- Architecture docs `06-events-and-rendering.md` and `07-operational-limits.md` are updated.
- `just check` (ruff lint + semgrep + pyright typecheck + pytest) passes — wait, this is a TypeScript project. The project uses `npm test` or Node's test runner. Verify the test suite passes with `npm test`.
- The implementer uses TDD (see `tdd` skill): write failing test first, then implement the code change, then verify the test passes.
