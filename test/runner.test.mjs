import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isResultError, isResultSuccess, normalizeCompletedResult } from "../types.ts";

const AGENTFLOW_ENV_VARS = [
  "AGENTFLOW_ENABLED",
  "AGENTFLOW_URL",
  "AGENTFLOW_WORKITEM_ID",
];

function createTestableRunnerModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runner-"));
  const modulePath = path.join(tmpDir, "runner.testable.ts");
  const source = fs
    .readFileSync(path.join(process.cwd(), "runner.ts"), "utf-8")
    .replace('from "./runner-cli.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-cli.js")).href)}`)
    .replace('from "./runner-events.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-events.js")).href)}`)
    .replace('from "./types.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "types.ts")).href)}`);
  fs.writeFileSync(modulePath, source);
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function makeResult(overrides = {}) {
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
    ...overrides,
  };
}

test("normalizeCompletedResult keeps intermediate assistant output as a failure without agent_end", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Let me check that for you." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult treats agent_end with final assistant output as semantic success", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "No matches found; exit code 1 was expected." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult preserves process-level errors despite semantic completion", () => {
  const result = makeResult({
    exitCode: 1,
    processError: true,
    stopReason: "error",
    errorMessage: "Named subagent session did not exit.",
    stderr: "Named subagent session did not exit.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Named subagent session did not exit.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult does not mask process-level errors on abort", () => {
  const result = makeResult({
    exitCode: 1,
    processError: true,
    stopReason: "error",
    errorMessage: "Named subagent session did not exit.",
    stderr: "Named subagent session did not exit.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Named subagent session did not exit.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult preserves semantic completion when the process is aborted after agent_end", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "aborted",
    errorMessage: "Subagent was aborted.",
    stderr: "Subagent was aborted.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult keeps aborts as errors without semantic completion", () => {
  const result = makeResult({
    exitCode: 130,
    stderr: "",
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Subagent was aborted.");
  assert.equal(result.stderr, "Subagent was aborted.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("running results are neither success nor error", () => {
  const result = makeResult({ exitCode: -1 });

  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), false);
});

test("rewriteSessionHeaderCwd updates only the session header cwd", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { rewriteSessionHeaderCwd } = await import(moduleUrl);
    const input = [
      JSON.stringify({ type: "session", id: "parent", cwd: "/old", version: 3 }),
      JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "hi" } }),
      "",
    ].join("\n");

    const output = rewriteSessionHeaderCwd(input, "/new");
    assert.ok(output);
    const lines = output.trimEnd().split("\n");
    assert.deepEqual(JSON.parse(lines[0]), {
      type: "session",
      id: "parent",
      cwd: "/new",
      version: 3,
    });
    assert.equal(JSON.parse(lines[1]).message.content, "hi");
  } finally {
    cleanup();
  }
});

test("runAgent returns immediately when the signal is already aborted", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { runAgent } = await import(moduleUrl);
    const controller = new AbortController();
    controller.abort();

    const result = await runAgent({
      cwd: process.cwd(),
      agents: [
        {
          name: "review",
          description: "reviewer",
          source: "user",
          systemPrompt: "",
        },
      ],
      callIndex: 0,
      agentName: "review",
      prompt: "hello",
      initialContext: "empty",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      signal: controller.signal,
      makeDetails: (results) => ({ projectAgentsDir: null, results }),
    });

    assert.equal(result.exitCode, 130);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.errorMessage, "Subagent was aborted.");
  } finally {
    cleanup();
  }
});

test("processRunnerJsonLine invokes onEvent for valid JSON and preserves result parsing", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { processRunnerJsonLine } = await import(moduleUrl);
    const result = makeResult();
    const seen = [];
    const rawLine = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Peekable output." }],
        timestamp: 1,
      },
    });

    const changed = processRunnerJsonLine(rawLine, result, (event, raw) => {
      seen.push({ event, raw });
    });

    assert.equal(changed, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event.type, "message_end");
    assert.equal(seen[0].raw, rawLine);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content[0].text, "Peekable output.");
  } finally {
    cleanup();
  }
});

test("processRunnerJsonLine skips onEvent for malformed JSON", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { processRunnerJsonLine } = await import(moduleUrl);
    const result = makeResult();
    let eventCount = 0;

    const changed = processRunnerJsonLine("not json", result, () => {
      eventCount++;
    });

    assert.equal(changed, false);
    assert.equal(eventCount, 0);
    assert.equal(result.messages.length, 0);
  } finally {
    cleanup();
  }
});

test("buildPiArgs plans ephemeral and persistent session flags", async () => {
  const previousEnv = {};
  for (const key of AGENTFLOW_ENV_VARS) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }

  try {
    const { moduleUrl, cleanup } = createTestableRunnerModule();
    try {
      const { buildPiArgs } = await import(moduleUrl);
      const agent = {
        name: "review",
        description: "reviewer",
        source: "user",
        systemPrompt: "",
      };
      const session = {
        handle: "api-review",
        id: "subagent.abc123",
        name: "subagent: review · api-review",
        cwd: "/repo",
        created: true,
        initialContextApplied: "parent",
      };

      assert.deepEqual(
        buildPiArgs(agent, null, "hello", "empty", null, undefined, undefined),
        ["--mode", "json", "-p", "--no-session", "hello"],
      );

      assert.deepEqual(
        buildPiArgs(agent, null, "hello", "parent", "/tmp/parent.jsonl", undefined, undefined),
        ["--mode", "json", "-p", "--session", "/tmp/parent.jsonl", "hello"],
      );

      assert.deepEqual(
        buildPiArgs(agent, null, "hello", "parent", "/tmp/parent.jsonl", session, undefined),
        [
          "--mode",
          "json",
          "-p",
          "--fork",
          "/tmp/parent.jsonl",
          "--session-id",
          "subagent.abc123",
          "--name",
          "subagent: review · api-review",
          "hello",
        ],
      );

      assert.deepEqual(
        buildPiArgs(
          agent,
          null,
          "hello",
          "parent",
          "/tmp/parent.jsonl",
          { ...session, created: false, initialContextApplied: null },
          undefined,
        ),
        ["--mode", "json", "-p", "--session-id", "subagent.abc123", "hello"],
      );

      assert.deepEqual(
        buildPiArgs({ ...agent, model: "agent-model" }, null, "hello", "empty", null, undefined, undefined),
        ["--mode", "json", "-p", "--no-session", "--model", "agent-model", "hello"],
      );

      assert.deepEqual(
        buildPiArgs({ ...agent, model: "agent-model" }, null, "hello", "empty", null, undefined, undefined, "call-model"),
        ["--mode", "json", "-p", "--no-session", "--model", "call-model", "hello"],
      );
    } finally {
      cleanup();
    }
  } finally {
    for (const key of AGENTFLOW_ENV_VARS) {
      if (previousEnv[key] !== undefined) {
        process.env[key] = previousEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }
});

test("buildPiArgs does not add Agentflow flags when env vars are absent", async () => {
  const previousEnv = {};
  for (const key of AGENTFLOW_ENV_VARS) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }

  try {
    const { moduleUrl, cleanup } = createTestableRunnerModule();
    try {
      const { buildPiArgs } = await import(moduleUrl);
      const agent = {
        name: "review",
        description: "reviewer",
        source: "user",
        systemPrompt: "",
      };

      const args = buildPiArgs(agent, null, "hello", "empty", null, undefined, undefined);

      assert.ok(args.includes("--no-session"));
      assert.ok(args.includes("hello"));
      assert.ok(!args.includes("--agentflow"));
      assert.ok(!args.includes("--agentflow-url"));
      assert.ok(!args.includes("--agentflow-workitem-id"));
    } finally {
      cleanup();
    }
  } finally {
    for (const key of AGENTFLOW_ENV_VARS) {
      if (previousEnv[key] !== undefined) {
        process.env[key] = previousEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }
});

test("buildPiArgs adds --agentflow when AGENTFLOW_ENABLED=1", async () => {
  const previousEnv = {};
  for (const key of AGENTFLOW_ENV_VARS) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTFLOW_ENABLED = "1";

  try {
    const { moduleUrl, cleanup } = createTestableRunnerModule();
    try {
      const { buildPiArgs } = await import(moduleUrl);
      const agent = {
        name: "review",
        description: "reviewer",
        source: "user",
        systemPrompt: "",
      };

      const args = buildPiArgs(agent, null, "hello", "empty", null, undefined, undefined);

      assert.ok(args.includes("--agentflow"));
      assert.ok(!args.includes("--agentflow-url"));
      assert.ok(!args.includes("--agentflow-workitem-id"));
    } finally {
      cleanup();
    }
  } finally {
    for (const key of AGENTFLOW_ENV_VARS) {
      if (previousEnv[key] !== undefined) {
        process.env[key] = previousEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }
});

test("buildPiArgs adds --agentflow-url from AGENTFLOW_URL", async () => {
  const previousEnv = {};
  for (const key of AGENTFLOW_ENV_VARS) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTFLOW_URL = "http://127.0.0.1:8765";

  try {
    const { moduleUrl, cleanup } = createTestableRunnerModule();
    try {
      const { buildPiArgs } = await import(moduleUrl);
      const agent = {
        name: "review",
        description: "reviewer",
        source: "user",
        systemPrompt: "",
      };

      const args = buildPiArgs(agent, null, "hello", "empty", null, undefined, undefined);

      assert.ok(!args.includes("--agentflow"));
      const idx = args.indexOf("--agentflow-url");
      assert.notEqual(idx, -1);
      assert.equal(args[idx + 1], "http://127.0.0.1:8765");
      assert.ok(!args.includes("--agentflow-workitem-id"));
    } finally {
      cleanup();
    }
  } finally {
    for (const key of AGENTFLOW_ENV_VARS) {
      if (previousEnv[key] !== undefined) {
        process.env[key] = previousEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }
});

test("buildPiArgs adds --agentflow-workitem-id from AGENTFLOW_WORKITEM_ID", async () => {
  const previousEnv = {};
  for (const key of AGENTFLOW_ENV_VARS) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTFLOW_WORKITEM_ID = "62";

  try {
    const { moduleUrl, cleanup } = createTestableRunnerModule();
    try {
      const { buildPiArgs } = await import(moduleUrl);
      const agent = {
        name: "review",
        description: "reviewer",
        source: "user",
        systemPrompt: "",
      };

      const args = buildPiArgs(agent, null, "hello", "empty", null, undefined, undefined);

      assert.ok(!args.includes("--agentflow"));
      assert.ok(!args.includes("--agentflow-url"));
      const idx = args.indexOf("--agentflow-workitem-id");
      assert.notEqual(idx, -1);
      assert.equal(args[idx + 1], "62");
    } finally {
      cleanup();
    }
  } finally {
    for (const key of AGENTFLOW_ENV_VARS) {
      if (previousEnv[key] !== undefined) {
        process.env[key] = previousEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }
});

test("buildPiArgs adds all three Agentflow flags when all env vars are set", async () => {
  const previousEnv = {};
  for (const key of AGENTFLOW_ENV_VARS) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTFLOW_ENABLED = "1";
  process.env.AGENTFLOW_URL = "http://127.0.0.1:8765";
  process.env.AGENTFLOW_WORKITEM_ID = "62";

  try {
    const { moduleUrl, cleanup } = createTestableRunnerModule();
    try {
      const { buildPiArgs } = await import(moduleUrl);
      const agent = {
        name: "review",
        description: "reviewer",
        source: "user",
        systemPrompt: "",
      };

      const args = buildPiArgs(agent, null, "hello", "empty", null, undefined, undefined);

      assert.ok(args.includes("--agentflow"));

      const urlIdx = args.indexOf("--agentflow-url");
      assert.notEqual(urlIdx, -1);
      assert.equal(args[urlIdx + 1], "http://127.0.0.1:8765");

      const idIdx = args.indexOf("--agentflow-workitem-id");
      assert.notEqual(idIdx, -1);
      assert.equal(args[idIdx + 1], "62");
    } finally {
      cleanup();
    }
  } finally {
    for (const key of AGENTFLOW_ENV_VARS) {
      if (previousEnv[key] !== undefined) {
        process.env[key] = previousEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }
});

test("buildPiArgs agentflow flags coexist with extension, model, tools, and session flags", async () => {
  const previousEnv = {};
  for (const key of AGENTFLOW_ENV_VARS) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTFLOW_ENABLED = "1";
  process.env.AGENTFLOW_URL = "http://127.0.0.1:8765";
  process.env.AGENTFLOW_WORKITEM_ID = "62";

  try {
    const { moduleUrl, cleanup } = createTestableRunnerModule();
    try {
      const { buildPiArgs } = await import(moduleUrl);
      const agent = {
        name: "review",
        description: "reviewer",
        source: "user",
        systemPrompt: "",
      };
      const session = {
        handle: "test-session",
        id: "subagent.def456",
        name: "subagent: review · test",
        cwd: "/repo",
        created: true,
        initialContextApplied: "parent",
      };

      const args = buildPiArgs(
        { ...agent, model: "anthropic/claude-3-7-sonnet", thinking: "high", tools: ["read", "bash"] },
        null,
        "hello",
        "parent",
        "/tmp/parent.jsonl",
        session,
        undefined,
        "call-model-override",
      );

      // Agentflow flags present
      assert.ok(args.includes("--agentflow"));

      const urlIdx = args.indexOf("--agentflow-url");
      assert.notEqual(urlIdx, -1);
      assert.equal(args[urlIdx + 1], "http://127.0.0.1:8765");

      const idIdx = args.indexOf("--agentflow-workitem-id");
      assert.notEqual(idIdx, -1);
      assert.equal(args[idIdx + 1], "62");

      // Other flags still present
      assert.ok(args.includes("--model"));
      assert.ok(args.includes("call-model-override"));
      assert.ok(args.includes("--thinking"));
      assert.ok(args.includes("high"));
      assert.ok(args.includes("--tools"));
      assert.ok(args.includes("--fork"));
      assert.ok(args.includes("--session-id"));
      assert.ok(args.includes("subagent.def456"));
      assert.ok(args.includes("--name"));
    } finally {
      cleanup();
    }
  } finally {
    for (const key of AGENTFLOW_ENV_VARS) {
      if (previousEnv[key] !== undefined) {
        process.env[key] = previousEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }
});
