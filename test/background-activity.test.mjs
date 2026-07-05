import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Activity tracking tests
// ---------------------------------------------------------------------------

test("formatActivityLine formats read calls", async () => {
  const { formatActivityLine } = await import("../background-activity.ts");
  assert.equal(formatActivityLine("read", { path: "src/main.ts" }), "→ read src/main.ts");
});

test("formatActivityLine formats bash calls", async () => {
  const { formatActivityLine } = await import("../background-activity.ts");
  assert.equal(formatActivityLine("bash", { command: "npm test" }), "$ npm test");
});

test("formatActivityLine truncates long bash commands", async () => {
  const { formatActivityLine } = await import("../background-activity.ts");
  const long = "x".repeat(100);
  const result = formatActivityLine("bash", { command: long });
  assert.equal(result, `$ ${long.slice(0, 60)}`);
});

test("formatActivityLine formats write calls", async () => {
  const { formatActivityLine } = await import("../background-activity.ts");
  assert.equal(formatActivityLine("write", { path: "README.md" }), "→ write README.md");
});

test("formatActivityLine formats edit calls", async () => {
  const { formatActivityLine } = await import("../background-activity.ts");
  assert.equal(formatActivityLine("edit", { path: "index.ts" }), "→ edit index.ts");
});

test("formatActivityLine formats grep calls", async () => {
  const { formatActivityLine } = await import("../background-activity.ts");
  assert.equal(formatActivityLine("grep", { pattern: "foo", path: "src" }), "→ grep /foo/ src");
});

test("formatActivityLine handles unknown tool names", async () => {
  const { formatActivityLine } = await import("../background-activity.ts");
  assert.equal(formatActivityLine("curl", { url: "example.com" }), "→ curl");
});

test("formatActivityLine falls back to file_path for read", async () => {
  const { formatActivityLine } = await import("../background-activity.ts");
  assert.equal(formatActivityLine("read", { file_path: "doc.md" }), "→ read doc.md");
});

test("formatActivityLine uses ? for missing args", async () => {
  const { formatActivityLine } = await import("../background-activity.ts");
  assert.equal(formatActivityLine("write", {}), "→ write ?");
});

// ---------------------------------------------------------------------------
// updateCallStateFromPartial
// ---------------------------------------------------------------------------

function makeCallState(initial) {
  return {
    phase: "running",
    toolCalls: 0,
    recentActivity: [],
    ...(initial || {}),
  };
}

function makePartialMessage(toolNames) {
  return {
    callIndex: 0,
    agent: "test",
    agentSource: "user",
    prompt: "test",
    initialContext: "empty",
    exitCode: -1,
    messages: [
      {
        role: "assistant",
        content: toolNames.map((name) => ({
          type: "toolCall",
          name,
          arguments: {},
        })),
        timestamp: Date.now(),
      },
    ],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
}

test("updateCallStateFromPartial records tool calls", async () => {
  const { updateCallStateFromPartial } = await import("../background-activity.ts");
  const cs = makeCallState({ phase: "spawning" });
  const partial = makePartialMessage(["read", "bash"]);

  updateCallStateFromPartial(cs, partial);

  assert.equal(cs.toolCalls, 2);
  assert.equal(cs.recentActivity.length, 2);
  assert.match(cs.recentActivity[0], /→ read/);
  assert.match(cs.recentActivity[1], /^\$ /);
});

test("updateCallStateFromPartial sets toolCalls to max seen", async () => {
  const { updateCallStateFromPartial } = await import("../background-activity.ts");
  const cs = makeCallState({ toolCalls: 3 });
  const partial = makePartialMessage(["read"]);

  updateCallStateFromPartial(cs, partial);

  // 3 > 1, so toolCalls stays at 3
  assert.equal(cs.toolCalls, 3);
});

test("updateCallStateFromPartial only appends new items via cursor", async () => {
  const { updateCallStateFromPartial } = await import("../background-activity.ts");
  const cs = makeCallState({ phase: "spawning" });

  // First update: 2 tool calls
  updateCallStateFromPartial(cs, makePartialMessage(["read", "bash"]));
  assert.equal(cs.toolCalls, 2);
  assert.equal(cs.recentActivity.length, 2);

  // Second update with the same message — cursor should prevent duplicates
  updateCallStateFromPartial(cs, makePartialMessage(["read", "bash"]));
  assert.equal(cs.toolCalls, 2);
  // Should NOT have grown to 4
  assert.equal(cs.recentActivity.length, 2);
});

test("updateCallStateFromPartial appends new calls beyond cursor", async () => {
  const { updateCallStateFromPartial } = await import("../background-activity.ts");
  const cs = makeCallState({ phase: "spawning" });

  // First update: 1 tool call
  updateCallStateFromPartial(cs, makePartialMessage(["read"]));
  assert.equal(cs.toolCalls, 1);
  assert.equal(cs.recentActivity.length, 1);

  // Second update with 2 tool calls (one old, one new)
  const partial = {
    ...makePartialMessage(["read", "bash"]),
  };
  updateCallStateFromPartial(cs, partial);
  assert.equal(cs.toolCalls, 2);
  // Should now have 2 (read was already there, bash is new)
  assert.equal(cs.recentActivity.length, 2);
  assert.match(cs.recentActivity[1], /^\$ /);
});

test("updateCallStateFromPartial bounds recentActivity to 5", async () => {
  const { updateCallStateFromPartial } = await import("../background-activity.ts");
  const cs = makeCallState({ phase: "spawning" });

  // Simulate many tool calls across partial updates
  const allTools = ["read", "bash", "write", "edit", "grep", "curl", "ls"];
  for (let i = 0; i < allTools.length; i++) {
    const partial = makePartialMessage([allTools[i]]);
    updateCallStateFromPartial(cs, partial);
  }

  // recentActivity should be bounded to 5
  assert.ok(cs.recentActivity.length <= 5);
});

test("updateCallStateFromPartial does not update cancelled calls", async () => {
  const { updateCallStateFromPartial } = await import("../background-activity.ts");
  const cs = makeCallState({ phase: "cancelled" });

  updateCallStateFromPartial(cs, makePartialMessage(["read"]));

  assert.equal(cs.toolCalls, 0);
  assert.equal(cs.recentActivity.length, 0);
});

test("updateCallStateFromPartial records spawnedAt on first activity", async () => {
  const { updateCallStateFromPartial } = await import("../background-activity.ts");
  const cs = makeCallState({ phase: "spawning", spawnedAt: undefined });

  const before = Date.now();
  updateCallStateFromPartial(cs, makePartialMessage(["read"]));
  const after = Date.now();

  assert.ok(cs.spawnedAt);
  assert.ok(cs.spawnedAt >= before);
  assert.ok(cs.spawnedAt <= after);
});

test("updateCallStateFromPartial does not overwrite existing spawnedAt", async () => {
  const { updateCallStateFromPartial } = await import("../background-activity.ts");
  const cs = makeCallState({ phase: "running", spawnedAt: 1000 });

  updateCallStateFromPartial(cs, makePartialMessage(["read"]));

  assert.equal(cs.spawnedAt, 1000);
});

test("updateCallStateFromPartial handles empty messages", async () => {
  const { updateCallStateFromPartial } = await import("../background-activity.ts");
  const cs = makeCallState();

  updateCallStateFromPartial(cs, makePartialMessage([]));

  assert.equal(cs.toolCalls, 0);
  assert.equal(cs.recentActivity.length, 0);
});
