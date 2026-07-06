---
name: debug-subagent-job
description: Debugging background subagent jobs in pi-subagent — how to locate event journals, interpret state dumps, trace the agent_end lifecycle, and diagnose named-session exit timer issues. Use when a subagent job failed unexpectedly, produced partial output, or a "Named subagent session did not exit within 30000ms" error appears.
---

# Debugging Background Subagent Jobs

## Quick Start

A failed background subagent job has three data sources you need to check in order:

1. **Job state** — `.pi-subagent/jobs/<jobId>/state.json` (the `BackgroundJob` snapshot)
2. **Raw event journal** — `.pi-subagent/jobs/<jobId>/calls/<callIndex>/events.jsonl` (every JSON line the child Pi emitted to stdout)
3. **Subagent session file** — `~/.pi/agent/sessions/<cwd-slug>/<session-id>.jsonl` (the child Pi's persisted conversation)

## Where to Find Things

### Job persistence directory

```bash
# All persisted jobs (from the project root)
ls -la .pi-subagent/jobs/

# A specific job's artifacts
ls -la .pi-subagent/jobs/<jobId>
# state.json   — serialized BackgroundJob (status, calls, results, messages)
# result.md    — human-readable summary of the job outcome
# calls/0/events.jsonl  — raw Pi JSON-mode event stream
```

### The job ID

The job ID is shown when `subagent_start` is called. It follows the pattern `subjob_<8-hex-chars>`. You can also list all known jobs with `subagent_status` (omit the `jobId` parameter).

### Session files

Subagent sessions are stored under Pi's session directory:

```bash
# Sessions scoped to the pi-subagent project
ls ~/.pi/agent/sessions/--Users-phil-Projects-pi-subagent--/

# Subagent sessions have IDs starting with "subagent."
# Named/job-owned sessions use a deterministic ID derived from:
#   pi-subagent/v1 + parent session id + cwd + agent name + session handle
```

## Reading the Event Journal

The events.jsonl file contains every JSON line emitted by the child `pi --mode json` process. This is the **most authoritative source** for understanding what happened.

### Key event types

| Event | Meaning | When to look |
|---|---|---|
| `agent_start` | Pi agent cycle begins | Start of a turn or retry |
| `turn_start` | A new turn begins | Follows `agent_start`; also appears after `auto_retry_start` for retries |
| `message_start` | A new message begins (user, assistant, or tool result) | |
| `message_update` | Streaming assistant output — contains `assistantMessageEvent.delta` with partial text | **Check the last few events to see if output was truncated mid-word** |
| `message_end` | A message is complete | |
| `turn_end` | A turn completes | Check `stopReason` — `"stop"` = normal, `"toolUse"` = more tool calls coming, `"error"` = model error |
| `agent_end` | Agent cycle completes | **Critical**: sets `sawAgentEnd = true` in the runner. Check `messages[].stopReason` — if `"error"`, the runner starts the 30s named-session exit timer |
| `auto_retry_start` | Pi's built-in retry mechanism activates | Appears after a transient model error. Contains `attempt`, `maxAttempts`, `delayMs`, and the `errorMessage` |
| `auto_retry_end` | Retry completes | `success: true` or `false` |
| `tool_execution_start` | A tool call begins | Check `args` for what tool was called with what params |
| `tool_execution_end` | A tool call ends | Check `result` for the tool's output |

### How to grep efficiently

```bash
# Count events by type
grep '"type"' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl | sort | uniq -c | sort -rn

# Find agent_end events (there should be one per agent cycle)
grep '"agent_end"' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl | head -5

# Find auto-retry events
grep '"auto_retry' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl

# Find the last few events (to check for mid-stream truncation)
grep '"type"' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl | tail -10

# Extract streaming deltas (the actual text the assistant was writing)
grep '"message_update"' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        delta = obj.get('assistantMessageEvent', {}).get('delta', '')
        if delta:
            print(delta, end='')
    except:
        pass
" | tail -c 500
# This shows the last 500 chars of streamed text — check if it ends mid-word
```

### Python analysis script

For a comprehensive view of the event stream:

```bash
python3 << 'PYEOF'
import json

events_path = '.pi-subagent/jobs/<jobId>/calls/0/events.jsonl'
events = []
with open(events_path) as f:
    for line in f:
        try:
            events.append(json.loads(line.strip()))
        except:
            pass

# Show last 15 events with type, stopReason, and text delta
for evt in events[-15:]:
    t = evt.get('type', '?')
    stop = evt.get('message', {}).get('stopReason', '') if isinstance(evt.get('message'), dict) else ''
    delta = evt.get('assistantMessageEvent', {}).get('delta', '')[:40] if evt.get('assistantMessageEvent') else ''
    extra = f' stopReason={stop}' if stop else ''
    extra += f' delta="{delta}"' if delta else ''
    print(f'{t}{extra}')

# Count agent_end events and check their stopReason
for evt in events:
    if evt.get('type') == 'agent_end':
        msgs = evt.get('messages', [])
        last = msgs[-1] if msgs else {}
        print(f'agent_end: stopReason={last.get("stopReason")}, '
              f'error={bool(last.get("errorMessage"))}, '
              f'text_len={len(last.get("content", [{}])[0].get("text", "") if last.get("content") else "")}')
PYEOF
```

## Common Failure Patterns

### Pattern 1: "Named subagent session did not exit within 30000ms"

**Error message**: `Named subagent session did not exit within 30000ms after completing; terminated to avoid hanging.`

**Root cause**: The child `pi` process emitted `agent_end`, but didn't exit within 30 seconds. For named (persistent) sessions, `runner.ts` waits for natural exit so the session file can flush. If the process lingers, the timer fires.

**Diagnosis**:
1. Check if there was an auto-retry before the final `agent_end`:
   ```bash
   grep '"auto_retry' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl
   ```
2. Check the last `message_update` delta — if it ends mid-word, the timer fired during streaming (see Pattern 2)
3. Check `state.json` for `result.sawAgentEnd` and `result.processError`

**Fix**: If the output was truncated, the issue is likely Pattern 2. If the output was complete but the process lingered, this is a policy tradeoff — the runner treats `agent_end` as semantic success but the timer still fires.

### Pattern 2: Output truncated mid-word (error → auto-retry → timer kills streaming)

**Symptoms**:
- The assistant's final text ends mid-sentence or mid-word
- The event journal shows: `agent_end (error)` → `auto_retry_start` → `turn_start` → streaming → **last event is `message_update` with no following `message_end` or `agent_end`**
- `state.json` shows `processError: true` and the timeout error message

**Root cause**: Pi auto-retried after a transient model error. The first (error) `agent_end` started the 30s exit timer. The retry's streaming output took >30s (tool calls + long response), and the timer from the first `agent_end` fired during streaming.

**Check with**:
```bash
grep '"type"' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl | grep -A2 'agent_end' | head -10
# Look for: agent_end → auto_retry_start → turn_start
```

**Potential fix**: The runner should detect `turn_start` or `agent_start` after an error `agent_end` and reset the exit timer. See `agent_plans/07-persistent-session-exit-timer-reset-on-retry.md` for the planned fix.

### Pattern 3: Job shows "failed" but useful output exists

**Symptoms**:
- `state.json` shows `status: "failed"` and `processError: true`
- But `result.messages` contains a complete assistant response with the answer
- The error message is the "session did not exit" timeout

**Root cause**: The assistant completed its work and the output was fully captured in `result.messages` (from stdout), but the child process didn't exit within 30s. The runner's named-session policy treated the lingering process as a failure even though the useful output was already captured.

**What to do**: Use `subagent_result` (or check `state.json`'s `result.messages`) to extract the output. The job was marked as failed due to process cleanup, not due to missing content.

### Pattern 4: Empty output, immediate timeout

**Symptoms**:
- `agent_end` with `stopReason=error` or `stopReason=stop` but empty content
- Timer fires shortly after with no useful output
- No `auto_retry_start` events

**Root cause**: Non-transient model error (e.g., auth failure, invalid request, context overflow). Pi didn't retry because the error was not retryable. The timer correctly fired because the process had genuinely stopped producing work.

### Pattern 5: Codex API / model error

**Symptoms**:
- Event journal shows `message_end` or `turn_end` with `stopReason: "error"` and an `errorMessage` containing "Codex error" or similar
- May or may not be followed by `auto_retry_start`

**Root cause**: The model API returned an error (transient 5xx, rate limit, or non-transient failure). Pi's behavior depends on error type:
- **Transient** (5xx, timeout): Pi auto-retries (Pattern 2)
- **Non-transient** (auth, invalid request): Pi does not retry (Pattern 4)

**If you see this and need to reproduce**: The exact request ID is in the error message. The Codex API can return transient errors under load; retrying the same prompt at a different time may succeed.

## Reading state.json

The `state.json` file contains the full serialized `BackgroundJob`:

```json
{
  "schemaVersion": 1,
  "jobId": "subjob_<id>",
  "createdAt": <timestamp>,
  "updatedAt": <timestamp>,
  "status": "running" | "needs_input" | "cancelling" | "cancelled" | "completed" | "failed" | "interrupted",
  "calls": [ { "agent": "...", "prompt": "...", "session": {...}, ... } ],
  "callStates": [
    {
      "phase": "running" | "completed" | "failed" | "cancelled",
      "toolCalls": <number>,
      "startedAt": <timestamp>,
      "completedAt": <timestamp>,
      "recentActivity": ["→ read some-file.ts", ...]
    }
  ],
  "results": [
    {
      "exitCode": -1 | 0 | 1,
      "sawAgentEnd": true | false,
      "processError": true | false,
      "stopReason": "stop" | "toolUse" | "error",
      "errorMessage": "...",
      "messages": [ ... ],
      "usage": { "input": ..., "output": ..., "totalTokens": ..., "cost": ... }
    }
  ]
}
```

### Key fields to check

| Field | What it tells you |
|---|---|
| `status` | Terminal state. `"failed"` doesn't mean no output was produced — check `results[].messages` |
| `results[0].sawAgentEnd` | Did Pi emit `agent_end`? If `false`, the child was killed before completing |
| `results[0].processError` | Was the result overridden by a process-level error (e.g., timeout)? |
| `results[0].stopReason` | `"stop"` = normal, `"toolUse"` = more tool calls, `"error"` = model error |
| `results[0].errorMessage` | The specific error, if any |
| `results[0].messages` | The full conversation messages — check the last assistant message for output |
| `results[0].usage` | Token usage — helps understand if a token limit was hit |

## Session File Anatomy

The subagent's session file (`~/.pi/agent/sessions/<cwd-slug>/<session-id>.jsonl`) contains the persisted conversation. It uses Pi's JSONL format:

```
Line 0:  {"type":"session","version":3,"id":"...","cwd":"..."}
Line 1:  {"type":"session_info","name":"subagent: <agent> · <handle>"}
Line 2+: {"type":"message","message":{"role":"user"|"assistant"|"toolResult", ...}}
         {"type":"model_change", ...}
         {"type":"thinking_level_change", ...}
```

Note: The session file only contains **committed messages** — it does not contain lifecycle events (`agent_start`, `turn_start`, `auto_retry_*`). If the process was killed before the session file flushed, the last messages may be missing from the session file even though they were captured in the runner's `result.messages` from stdout.

**Use the session file for**: Understanding the conversation history (what the user sent, what tools were called, what the assistant said)
**Use the event journal for**: Understanding process lifecycle (retries, errors, streaming, timers)

## Runner Code Map

When debugging, these are the key files and their roles:

| File | Role | Key functions/variables |
|---|---|---|
| `runner.ts` | Spawns child `pi` process, reads stdout, manages lifecycle | `runAgent`, `maybeFinishFromAgentEnd`, `PERSISTENT_SESSION_EXIT_TIMEOUT_MS=30000`, `flushLine`, `onStdoutData` |
| `runner-events.js` | Parses Pi JSON-mode events into `SingleResult` | `processPiEvent`, `processPiJsonLine`, `addAssistantMessage`, `getFinalAssistantText` |
| `types.ts` | Type definitions and result normalization | `SingleResult`, `normalizeCompletedResult`, `isResultError`, `sawAgentEnd` |
| `index.ts` | Extension entry point, tool registration, background job orchestration | `runBackgroundCall`, `continueBackgroundSubagentJob`, `PendingSessionExitTimeout` |

## Reproducing Issues

Since transient API errors are hard to reproduce on demand, use the **event journal fixtures** approach:

1. Capture the raw events from a real failed job:
   ```bash
   cp .pi-subagent/jobs/<jobId>/calls/0/events.jsonl test/fixtures/repro-<description>.jsonl
   ```

2. Write a test that replays the events through `processPiEvent` / `processPiJsonLine`:
   ```javascript
   const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");
   const result = makeResult();
   for (const line of lines) {
     processPiJsonLine(line, result);
   }
   // Assert on result.sawAgentEnd, result.messages, etc.
   ```

3. For runner-level timer tests (harder), mock the child process or test the event parsing in isolation and verify the `sawAgentEnd` toggling behavior.

## Quick Reference

```bash
# 1. Find failed jobs
ls .pi-subagent/jobs/

# 2. Check job status
python3 -c "import json; j=json.load(open('.pi-subagent/jobs/<jobId>/state.json')); print(f'status={j[\"status\"]}, sawAgentEnd={j.get(\"results\",[{}])[0].get(\"sawAgentEnd\")}, processError={j.get(\"results\",[{}])[0].get(\"processError\")}')"

# 3. Check for auto-retry
grep -c 'auto_retry' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl

# 4. Check last event type
grep '"type"' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl | tail -1

# 5. Check for truncation (last streaming delta)
grep '"message_update"' .pi-subagent/jobs/<jobId>/calls/0/events.jsonl | tail -1 | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('assistantMessageEvent',{}).get('delta',''))"

# 6. View the final output from state.json
python3 -c "
import json
j=json.load(open('.pi-subagent/jobs/<jobId>/state.json'))
for m in j.get('results',[{}])[0].get('messages',[]):
    if m.get('role')=='assistant':
        for c in m.get('content',[]):
            if c.get('type')=='text': print(c['text'][:500])
"
```
