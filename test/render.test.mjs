import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function createTestableRenderModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-render-"));
  const codingAgentStub = path.join(tmpDir, "pi-coding-agent-stub.mjs");
  const tuiStub = path.join(tmpDir, "pi-tui-stub.mjs");
  const modulePath = path.join(tmpDir, "render.testable.ts");

  fs.writeFileSync(codingAgentStub, `export function getMarkdownTheme() { return {}; }\n`);
  fs.writeFileSync(
    tuiStub,
    `export class Container {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); return child; }
    }
    export class Text { constructor(text) { this.text = text; } }
    export class Markdown { constructor(text) { this.text = text; } }
    export class Spacer { constructor(size) { this.size = size; } }
`,
  );

  const source = fs
    .readFileSync(path.join(process.cwd(), "render.ts"), "utf-8")
    .replace(
      'from "@earendil-works/pi-coding-agent"',
      'from "./pi-coding-agent-stub.mjs"',
    )
    .replace('from "@earendil-works/pi-tui"', 'from "./pi-tui-stub.mjs"')
    .replace(
      'from "./runner-events.js"',
      `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-events.js")).href)}`,
    )
    .replace(
      'from "./types.js"',
      `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "types.ts")).href)}`,
    );
  fs.writeFileSync(modulePath, source);

  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function collectText(component) {
  if (!component) return [];
  const own = typeof component.text === "string" ? [component.text] : [];
  const children = Array.isArray(component.children)
    ? component.children.flatMap((child) => collectText(child))
    : [];
  return [...own, ...children];
}

test("expanded renderer tolerates legacy pre-prompt results with task", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderResult } = await import(moduleUrl);
    const component = renderResult(
      {
        content: [{ type: "text", text: "legacy" }],
        details: {
          projectAgentsDir: null,
          results: [
            {
              callIndex: 0,
              agent: "review",
              agentSource: "user",
              task: "old task field",
              initialContext: "empty",
              exitCode: 0,
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
            },
          ],
        },
      },
      true,
      theme,
    );

    const renderedText = collectText(component);
    assert.ok(renderedText.some((text) => text.includes("1: review")));
    assert.ok(renderedText.some((text) => text.includes("Prompt: old task field")));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Compact background completion notification tests
// ---------------------------------------------------------------------------

function makeMessage(role, parts) {
  return { role, content: parts };
}

function makeCompletedJob(overrides = {}) {
  const now = Date.now();
  return {
    id: "subjob_ab12cd34",
    createdAt: now - 134000,
    updatedAt: now,
    status: "completed",
    calls: [{ agent: "review" }, { agent: "test" }],
    results: [
      {
        callIndex: 0,
        agent: "review",
        agentSource: "user",
        prompt: "Review the diff",
        initialContext: "empty",
        exitCode: 0,
        messages: [
          makeMessage("assistant", [
            { type: "text", text: "I reviewed the changes." },
            { type: "toolCall", name: "read", arguments: { path: "file.ts" } },
            { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
          ]),
        ],
        stderr: "",
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.002, contextTokens: 0, turns: 1 },
        sawAgentEnd: true,
      },
      {
        callIndex: 1,
        agent: "test",
        agentSource: "user",
        prompt: "Run tests",
        initialContext: "empty",
        exitCode: 0,
        messages: [
          makeMessage("assistant", [
            { type: "text", text: "All tests passed." },
            { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
          ]),
        ],
        stderr: "",
        usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
        sawAgentEnd: true,
      },
    ],
    onComplete: "trigger",
    worktreeMode: "shared",
    callStates: [],
    ...overrides,
  };
}

test("compact completion: completed job notification contains job ID, status, agents, duration, result, and next action", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);
    const text = formatBackgroundCompletion(makeCompletedJob());
    assert.ok(text.includes("subjob_ab12cd34"), "includes job ID");
    assert.ok(text.includes("completed"), "includes status");
    assert.ok(text.includes("review"), "includes agent name");
    assert.ok(text.includes("test"), "includes agent name");
    assert.ok(text.includes("Duration:"), "includes duration");
    assert.ok(text.includes("Result:"), "includes result summary");
    assert.ok(text.includes("tool calls"), "includes tool call count");
    assert.ok(text.includes("result.md"), "includes artifacts note");
    assert.ok(text.includes("subagent_result"), "includes next action");
  } finally {
    cleanup();
  }
});

test("compact completion: completed job does not include assistant output excerpts", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);
    const text = formatBackgroundCompletion(makeCompletedJob());
    assert.ok(!text.includes("I reviewed the changes."), "no output excerpt");
    assert.ok(!text.includes("All tests passed."), "no output excerpt");
    // Should be compact — no more than 25 lines
    const lines = text.split("\n").filter(Boolean);
    assert.ok(lines.length <= 12, `compact output (${lines.length} lines)`);
  } finally {
    cleanup();
  }
});

test("compact completion: failed job includes error summary", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);
    const job = makeCompletedJob({
      id: "subjob_fail001",
      status: "failed",
      calls: [{ agent: "review" }],
      results: [{
        callIndex: 0,
        agent: "review",
        agentSource: "user",
        prompt: "Review",
        initialContext: "empty",
        exitCode: 1,
        sawAgentEnd: false,
        stopReason: "error",
        messages: [makeMessage("assistant", [{ type: "text", text: "Failed." }])],
        stderr: "",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
      error: "child process exited with code 1",
    });
    const text = formatBackgroundCompletion(job);
    assert.ok(text.includes("failed"), "includes status");
    assert.ok(text.includes("Error:"), "includes error prefix");
    assert.ok(text.includes("child process exited with code 1"), "includes error text");
    assert.ok(text.includes("subagent_result"), "includes result retrieval hint");
    assert.ok(text.includes("subagent_peek"), "includes peek hint");
  } finally {
    cleanup();
  }
});

test("compact completion: cancelled job shows cancelled status", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);
    const text = formatBackgroundCompletion(makeCompletedJob({ id: "subjob_can001", status: "cancelled" }));
    assert.ok(text.includes("was cancelled"), "includes cancelled status");
    assert.ok(text.includes("subagent_status"), "includes status hint");
  } finally {
    cleanup();
  }
});

test("compact completion: interrupted job shows interrupted status", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);
    const text = formatBackgroundCompletion(makeCompletedJob({ id: "subjob_int001", status: "interrupted" }));
    assert.ok(text.includes("interrupted"), "includes interrupted status");
    assert.ok(text.includes("parent process exited"), "explains interruption");
    assert.ok(text.includes("subagent_status"), "includes status hint");
    // Interrupted jobs should NOT include a result summary (no results to show)
    assert.ok(!text.includes("Result:"), "no result summary for interrupted");
  } finally {
    cleanup();
  }
});

test("compact completion: isolated worktree job includes worktree metadata", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);
    const job = makeCompletedJob({
      id: "subjob_wt001",
      worktreeMode: "isolated",
      worktreeMetadata: {
        path: "/tmp/worktree",
        branch: "codex/subjob_subjob_wt001",
        baseCommit: "abc123",
        changedFiles: ["src/main.ts", "README.md"],
        patchPath: ".pi-subagent/jobs/subjob_wt001/worktree.patch",
      },
    });
    const text = formatBackgroundCompletion(job);
    assert.ok(text.includes("isolated worktree"), "mentions isolated worktree");
    assert.ok(text.includes("Branch:"), "includes branch");
    assert.ok(text.includes("codex/subjob_subjob_wt001"), "includes branch name");
    assert.ok(text.includes("Changed files: 2"), "includes changed file count");
    assert.ok(text.includes("Patch:"), "includes patch path");
    assert.ok(text.includes(".pi-subagent/jobs/subjob_wt001/worktree.patch"), "includes patch path value");
    assert.ok(text.includes("subagent_result"), "includes result retrieval hint");
    // Isolated worktree should NOT show "Artifacts: result.md available" — that's for shared worktree
    assert.ok(!text.includes("artifacts:") && !text.includes("Artifacts:"), "no generic artifacts line for isolated");
  } finally {
    cleanup();
  }
});

test("compact completion: subagent_result still returns full output via formatJobResults", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);
    const job = makeCompletedJob();
    const result = formatJobResults(job, {});
    // formatJobResults should still include the full assistant text
    assert.ok(result.includes("I reviewed the changes."), "full output includes assistant text");
    assert.ok(result.includes("All tests passed."), "full output includes all calls");
  } finally {
    cleanup();
  }
});
