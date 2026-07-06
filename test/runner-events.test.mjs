import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getFinalAssistantText,
  getProcessErrorText,
  getResultSummaryText,
  processPiEvent,
  processPiJsonLine,
} from "../runner-events.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function makeResult() {
  return {
    agent: "oracle",
    agentSource: "user",
    prompt: "repro",
    initialContext: "empty",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

test("repro: captures final assistant output from agent_end after non-zero tool exit", async () => {
  const fixturePath = path.join(testDir, "fixtures", "agent-end-error-only.jsonl");
  const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");
  const result = makeResult();

  for (const line of lines) {
    processPiJsonLine(line, result);
  }

  result.exitCode = 1;

  assert.equal(result.messages.length, 2);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(result.usage.turns, 2);
  assert.equal(
    getFinalAssistantText(result.messages),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
  assert.equal(
    getResultSummaryText(result),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
});

test("deduplicates assistant messages repeated across message_end, turn_end, and agent_end", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Still here" }],
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  };

  const result = makeResult();
  processPiEvent({ type: "message_end", message }, result);
  processPiEvent({ type: "turn_end", message, toolResults: [] }, result);
  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 1);
  assert.equal(result.usage.output, 2);
  assert.equal(result.sawAgentEnd, true);
});

test("non-zero exit code does not hide the final assistant text", () => {
  const result = makeResult();
  result.exitCode = 1;
  result.errorMessage = "Command exited with code 1";
  result.stderr = "stderr noise that should be a fallback only";
  result.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "No matches found" }],
    timestamp: 1,
  });

  assert.equal(getResultSummaryText(result), "No matches found");
});

test("stderr remains a fallback only for error results", () => {
  const okResult = makeResult();
  okResult.exitCode = 0;
  okResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(okResult), "(no output)");

  const failedResult = makeResult();
  failedResult.exitCode = 1;
  failedResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(failedResult), "warning on stderr");
});

test("agent_start resets sawAgentEnd", () => {
  const result = makeResult();

  result.sawAgentEnd = true;
  processPiEvent({ type: "agent_start" }, result);
  assert.equal(result.sawAgentEnd, false);
});

test("turn_start resets sawAgentEnd", () => {
  const result = makeResult();
  result.sawAgentEnd = true;
  processPiEvent({ type: "turn_start" }, result);
  assert.equal(result.sawAgentEnd, false);
});

test("sawAgentEnd remains false on other events", () => {
  const result = makeResult();
  result.sawAgentEnd = false;

  processPiEvent({ type: "message_start" }, result);
  processPiEvent({ type: "message_update" }, result);
  processPiEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 }, result);
  processPiEvent({ type: "tool_execution_end", toolCallId: "call_1" }, result);

  assert.equal(result.sawAgentEnd, false);
});

test("sawAgentEnd goes true → false → true", () => {
  const result = makeResult();

  processPiEvent({ type: "agent_end", messages: [] }, result);
  assert.equal(result.sawAgentEnd, true);

  processPiEvent({ type: "turn_start" }, result);
  assert.equal(result.sawAgentEnd, false);

  processPiEvent({ type: "agent_end", messages: [] }, result);
  assert.equal(result.sawAgentEnd, true);
});

test("error → retry → success fixture preserves retry output", () => {
  const fixturePath = path.join(testDir, "fixtures", "error-retry-success.jsonl");
  const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");
  const result = makeResult();

  for (const line of lines) {
    processPiJsonLine(line, result);
  }

  // After the error agent_end, sawAgentEnd was true; after the retry's
  // turn_start it was reset; after the retry's agent_end it is true again.
  assert.equal(result.sawAgentEnd, true);
  // The fixture has 7 assistant messages: the normal turns (tool call,
  // text), the error (message_end + agent_end re-adds without model/usage),
  // and the retry (message_end + agent_end re-adds without model/usage).
  assert.equal(result.messages.length, 7);
  // The retry's message_end set stopReason to "stop".
  assert.equal(result.stopReason, "stop");
  // Final output is the retry's complete text.
  assert.equal(
    getFinalAssistantText(result.messages),
    "Here is the complete output I wanted to produce.",
  );
});

test("process errors remain visible alongside final assistant text", () => {
  const result = makeResult();
  result.exitCode = 1;
  result.processError = true;
  result.errorMessage = "Named session did not exit.";
  result.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    timestamp: 1,
  });

  assert.equal(
    getProcessErrorText(result),
    "Subagent process error after completion: Named session did not exit.",
  );
  assert.equal(
    getResultSummaryText(result),
    "Done\n\nSubagent process error after completion: Named session did not exit.",
  );
});
