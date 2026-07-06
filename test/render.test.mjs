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
    assert.ok(text.includes("Artifacts:"), "includes artifacts summary");
    assert.ok(text.includes("result"), "includes result in artifacts");
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
    // Isolated worktree shows artifact summary from derived artifacts
    assert.ok(text.includes("Artifacts:"), "includes artifacts summary");
    assert.ok(text.includes("patch"), "includes patch in artifacts");
    assert.ok(text.includes("2 files"), "includes file count in artifacts");
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

// ---------------------------------------------------------------------------
// Fleet view tests — subagent_status without jobId
// ---------------------------------------------------------------------------

function makeFleetJob(overrides = {}) {
  const now = Date.now();
  return {
    id: "subjob_fleet001",
    createdAt: now - 120000,
    updatedAt: now - 60000,
    status: "completed",
    calls: [{ agent: "explorer", index: 0, prompt: "Explore", effectiveCwd: "/tmp", initialContext: "empty" }],
    callStates: [{ phase: "completed", toolCalls: 3, recentActivity: [] }],
    onComplete: "trigger",
    ...overrides,
  };
}

test("fleet view: empty state", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobFleet } = await import(moduleUrl);
    assert.equal(formatJobFleet([]), "No background subagent jobs.");
  } finally {
    cleanup();
  }
});

test("fleet view: groups by attention priority", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { groupJobsForFleet } = await import(moduleUrl);
    const now = Date.now();

    const jobs = [
      makeFleetJob({
        id: "job_running",
        status: "running",
        updatedAt: now - 5000,
        callStates: [{ phase: "running", toolCalls: 5, recentActivity: ["read src/main.ts"] }],
      }),
      makeFleetJob({
        id: "job_failed",
        status: "failed",
        updatedAt: now - 10000,
        error: "process error",
      }),
      makeFleetJob({
        id: "job_needs_input",
        status: "needs_input",
        updatedAt: now - 3000,
        waitingForInput: {
          id: "esc_123",
          callIndex: 0,
          question: "Which area to inspect?",
          marker: "MARKER",
          status: "open",
          createdAt: now - 3000,
          updatedAt: now - 3000,
        },
      }),
      makeFleetJob({
        id: "job_completed",
        status: "completed",
        updatedAt: now - 310000, // older than 5 min window
      }),
    ];

    const groups = groupJobsForFleet(jobs);
    assert.equal(groups.length, 3, "three groups: needs_input, failed, running (completed too old to show)");
    assert.equal(groups[0].title, "Needs input", "first group is needs_input");
    assert.equal(groups[1].title, "Failed", "second group is failed");
    assert.equal(groups[2].title, "Running", "third group is running");
  } finally {
    cleanup();
  }
});

test("fleet view: needs_input row includes question and escalation ID", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobFleet } = await import(moduleUrl);
    const now = Date.now();
    const job = makeFleetJob({
      id: "subjob_input",
      status: "needs_input",
      updatedAt: now - 2000,
      waitingForInput: {
        id: "esc_abc123",
        callIndex: 0,
        question: "Which area should I inspect next?",
        marker: "MARKER",
        status: "open",
        createdAt: now - 2000,
        updatedAt: now - 2000,
      },
    });

    const text = formatJobFleet([job]);
    assert.ok(text.includes("Needs input"), "includes section header");
    assert.ok(text.includes("subjob_input"), "includes job ID");
    assert.ok(text.includes("explorer"), "includes agent name");
    assert.ok(text.includes("asks:"), "includes question prefix");
    assert.ok(text.includes("Which area should I inspect next?"), "includes question excerpt");
    assert.ok(text.includes("subagent_continue"), "includes continue hint");
    assert.ok(text.includes("esc_abc123"), "includes escalation ID");
  } finally {
    cleanup();
  }
});

test("fleet view: running row includes activity and tool count", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobFleet } = await import(moduleUrl);
    const now = Date.now();
    const job = makeFleetJob({
      id: "subjob_run",
      status: "running",
      updatedAt: now - 10000,
      callStates: [
        { phase: "running", toolCalls: 7, recentActivity: ["read src/auth/session.ts", "bash npm test"] },
      ],
    });

    const text = formatJobFleet([job]);
    assert.ok(text.includes("Running"), "includes section header");
    assert.ok(text.includes("subjob_run"), "includes job ID");
    assert.ok(text.includes("7 tools"), "includes tool count");
    assert.ok(text.includes("read src/auth/session.ts"), "includes latest activity");
    assert.ok(text.includes("subagent_peek"), "includes peek hint");
  } finally {
    cleanup();
  }
});

test("fleet view: isolated worktree row includes branch hint", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobFleet } = await import(moduleUrl);
    const now = Date.now();
    const job = makeFleetJob({
      id: "subjob_iso",
      status: "running",
      updatedAt: now - 5000,
      worktreeMode: "isolated",
      worktreeMetadata: {
        path: "/tmp/wt",
        branch: "codex/subjob_iso",
        baseCommit: "abc123",
      },
      callStates: [{ phase: "running", toolCalls: 2, recentActivity: ["edit src/main.ts"] }],
    });

    const text = formatJobFleet([job]);
    assert.ok(text.includes("isolated"), "includes isolated label");
    assert.ok(text.includes("codex/subjob_iso"), "includes branch name");
  } finally {
    cleanup();
  }
});

test("fleet view: completed row does not include large result excerpts", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobFleet } = await import(moduleUrl);
    const now = Date.now();
    const job = makeFleetJob({
      id: "subjob_done",
      status: "completed",
      updatedAt: now - 30000,
      calls: [
        { agent: "docs", index: 0, prompt: "Write docs", effectiveCwd: "/tmp", initialContext: "empty" },
      ],
    });

    const text = formatJobFleet([job]);
    assert.ok(text.includes("subjob_done"), "includes job ID");
    assert.ok(text.includes("3 events"), "includes event count from artifacts");
    assert.ok(text.includes("subagent_result"), "includes result hint");
    // Must NOT include the full output (there is no results array, so no excerpts to leak)
    assert.doesNotMatch(text, /I reviewed the changes/);
  } finally {
    cleanup();
  }
});

test("fleet view: legacy jobs without callStates still render", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobFleet } = await import(moduleUrl);
    const now = Date.now();
    const job = makeFleetJob({
      id: "subjob_legacy",
      status: "running",
      updatedAt: now - 5000,
      // No callStates field
    });
    delete job.callStates;

    const text = formatJobFleet([job]);
    assert.ok(text.includes("subjob_legacy"), "includes job ID");
    assert.ok(text.includes("explorer"), "includes agent name");
    assert.ok(text.includes("subagent_peek"), "includes peek hint");
    // No tool count since callStates is missing
    assert.doesNotMatch(text, /tools/);
  } finally {
    cleanup();
  }
});

test("fleet view: failed row includes error and result hint", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobFleet } = await import(moduleUrl);
    const now = Date.now();
    const job = makeFleetJob({
      id: "subjob_err",
      status: "failed",
      updatedAt: now - 8000,
      error: "child process exited with code 1",
    });

    const text = formatJobFleet([job]);
    assert.ok(text.includes("Failed"), "includes section header");
    assert.ok(text.includes("subjob_err"), "includes job ID");
    assert.ok(text.includes("error:"), "includes error prefix");
    assert.ok(text.includes("child process exited with code 1"), "includes error text");
    assert.ok(text.includes("subagent_result"), "includes result hint");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Background escalation tests
// ---------------------------------------------------------------------------

test("escalation text contains natural question and no await marker", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundEscalation } = await import(moduleUrl);
    const now = Date.now();
    const job = makeFleetJob({
      id: "subjob_esc001",
      status: "needs_input",
      updatedAt: now - 5000,
      waitingForInput: {
        id: "esc_xyz789",
        callIndex: 0,
        question: "Which approach should I take for the API design?",
        marker: "AWAIT_MARKER",
        status: "open",
        createdAt: now - 5000,
        updatedAt: now - 5000,
      },
    });

    const text = formatBackgroundEscalation(job);
    // Natural question is present
    assert.ok(text.includes("Which approach should I take for the API design?"), "includes natural question");
    // Agent name is present
    assert.ok(text.includes("explorer"), "includes agent name");
    // Concise instruction
    assert.ok(text.includes("Reply with your choice or instruction"), "includes instruction");
    // No await marker text leaked
    assert.ok(!text.includes("AWAIT_MARKER"), "no await marker in text");
    // No session ID exposed
    assert.ok(!text.includes("session"), "no session plumbing in text");
    // No call index exposed
    assert.ok(!text.includes("callIndex") && !text.includes("call 0"), "no call index in text");
  } finally {
    cleanup();
  }
});

test("escalation job object still includes hidden routing metadata", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundEscalation } = await import(moduleUrl);
    const now = Date.now();
    const waitingForInput = {
      id: "esc_route123",
      callIndex: 0,
      question: "Should I refactor this module?",
      marker: "MARKER",
      status: "open",
      createdAt: now - 5000,
      updatedAt: now - 5000,
    };
    const job = makeFleetJob({
      id: "subjob_route001",
      status: "needs_input",
      updatedAt: now - 5000,
      waitingForInput,
    });

    // Verify routing metadata is available on the job object (hidden details)
    assert.equal(job.waitingForInput.id, "esc_route123", "escalation ID available as routing metadata");
    assert.equal(job.waitingForInput.callIndex, 0, "call index available as routing metadata");
    assert.equal(job.waitingForInput.marker, "MARKER", "marker available as routing metadata");

    const text = formatBackgroundEscalation(job);
    // The text itself should NOT expose these internal details
    assert.ok(!text.includes("esc_route123"), "escalation ID not leaked in text");
    assert.ok(!text.includes("MARKER"), "marker not leaked in text");
    assert.ok(text.includes("Should I refactor this module?"), "natural question present in text");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Plan-fired message tests
// ---------------------------------------------------------------------------

test("plan-fired message does not include plan text", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatPlanFired } = await import(moduleUrl);
    const text = formatPlanFired(
      { id: "plan_abc123", plan: "Compile the results into REPORT.md and create an MR." },
      [{ id: "subjob_001", status: "completed" }],
    );

    // The plan text is NOT exposed in the fired message
    assert.ok(!text.includes("Compile the results into REPORT.md"), "plan text not included");
    assert.ok(!text.includes("create an MR"), "plan details not included");
    // Plan ID is shown (for retrieval routing)
    assert.ok(text.includes("plan_abc123"), "includes plan ID");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Artifact derivation tests
// ---------------------------------------------------------------------------

function makeArtifactJob(overrides = {}) {
  const now = Date.now();
  return {
    id: "subjob_art_test",
    createdAt: now - 60000,
    updatedAt: now,
    status: "completed",
    calls: [{ index: 0, agent: "explorer", prompt: "Explore", effectiveCwd: "/tmp", initialContext: "empty" }],
    callStates: [{ phase: "completed", toolCalls: 5, recentActivity: [] }],
    results: [{
      callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Explore", initialContext: "empty",
      exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1000 }],
      stderr: "", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    }],
    onComplete: "trigger",
    ...overrides,
  };
}

test("deriveArtifacts: result artifact appears for completed jobs", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { deriveArtifacts } = await import(moduleUrl);
    const artifacts = deriveArtifacts(makeArtifactJob());
    const resultArtifact = artifacts.find((a) => a.kind === "result");
    assert.ok(resultArtifact, "result artifact present");
    assert.equal(resultArtifact.value, "1/1 calls");
  } finally {
    cleanup();
  }
});

test("deriveArtifacts: result artifact absent for non-terminal jobs", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { deriveArtifacts } = await import(moduleUrl);
    const artifacts = deriveArtifacts(makeArtifactJob({ status: "running" }));
    const resultArtifact = artifacts.find((a) => a.kind === "result");
    assert.equal(resultArtifact, undefined, "no result artifact for running job");
  } finally {
    cleanup();
  }
});

test("deriveArtifacts: patch artifact appears for isolated jobs with changes", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { deriveArtifacts } = await import(moduleUrl);
    const artifacts = deriveArtifacts(makeArtifactJob({
      worktreeMetadata: {
        path: "/tmp/wt",
        branch: "codex/subjob_art_test",
        baseCommit: "abc123",
        changedFiles: ["src/main.ts"],
        patchPath: ".pi-subagent/jobs/subjob_art_test/worktree.patch",
      },
    }));
    const patchArtifact = artifacts.find((a) => a.kind === "patch");
    assert.ok(patchArtifact, "patch artifact present");
    assert.equal(patchArtifact.path, ".pi-subagent/jobs/subjob_art_test/worktree.patch");
  } finally {
    cleanup();
  }
});

test("deriveArtifacts: changed file count appears without listing every file", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { deriveArtifacts, formatArtifactSummary } = await import(moduleUrl);
    const job = makeArtifactJob({
      worktreeMetadata: {
        path: "/tmp/wt",
        branch: "codex/subjob_art_test",
        baseCommit: "abc123",
        changedFiles: ["a.ts", "b.ts", "c.ts"],
        patchPath: ".pi-subagent/jobs/subjob_art_test/worktree.patch",
      },
    });
    const artifacts = deriveArtifacts(job);
    const cfArtifact = artifacts.find((a) => a.kind === "changed_files");
    assert.ok(cfArtifact, "changed_files artifact present");
    assert.equal(cfArtifact.count, 3, "count is 3 without listing files");

    // Compact summary uses count, not file names
    const summary = formatArtifactSummary(job);
    assert.ok(summary.includes("3 files"), "summary uses count");
    assert.ok(!summary.includes("a.ts"), "summary does not list individual files");
  } finally {
    cleanup();
  }
});

test("deriveArtifacts: legacy jobs without callStates render event journal only from results", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { deriveArtifacts } = await import(moduleUrl);
    const job = makeArtifactJob({
      callStates: undefined,
      worktreeMetadata: {
        path: "/tmp/wt",
        branch: "codex/subjob_legacy",
        baseCommit: "abc123",
        changedFiles: ["x.ts"],
        patchPath: ".pi-subagent/jobs/subjob_legacy/worktree.patch",
      },
    });
    // Legacy job: undefined callStates, so no event_journal, but worktree metadata still works
    delete job.callStates;
    const artifacts = deriveArtifacts(job);
    assert.ok(artifacts.find((a) => a.kind === "result"), "result artifact from results");
    assert.ok(artifacts.find((a) => a.kind === "worktree"), "worktree artifact from metadata");
    assert.ok(artifacts.find((a) => a.kind === "branch"), "branch artifact from metadata");
    assert.ok(artifacts.find((a) => a.kind === "patch"), "patch artifact from metadata");
    assert.ok(artifacts.find((a) => a.kind === "changed_files"), "changed_files artifact from metadata");
    const eventJournal = artifacts.find((a) => a.kind === "event_journal");
    assert.equal(eventJournal, undefined, "no event journal without callStates");
  } finally {
    cleanup();
  }
});

test("formatArtifactDetail produces formatted artifact listing", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatArtifactDetail } = await import(moduleUrl);
    const text = formatArtifactDetail(makeArtifactJob());
    assert.ok(text.includes("Artifacts"), "includes header");
    assert.ok(text.includes("result"), "includes result artifact");
    assert.ok(text.includes("1/1 calls"), "includes result value");
  } finally {
    cleanup();
  }
});

test("formatArtifactDetail handles empty artifacts", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatArtifactDetail } = await import(moduleUrl);
    const job = makeArtifactJob({
      status: "running",
      results: undefined,
      callStates: [{ phase: "running", toolCalls: 0, recentActivity: [] }],
    });
    const text = formatArtifactDetail(job);
    assert.equal(text, "No artifacts.");
  } finally {
    cleanup();
  }
});

test("plan-fired message instructs parent agent to ask the user first", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatPlanFired } = await import(moduleUrl);
    const text = formatPlanFired(
      { id: "plan_def456", plan: "Push the changes." },
      [
        { id: "subjob_a", status: "completed", summary: "2 calls" },
        { id: "subjob_b", status: "completed" },
      ],
    );

    // Instructions to ask user first
    assert.ok(text.includes("Ask the user if they still want this done before proceeding"), "asks to consult user");
    assert.ok(text.includes("Do NOT include the plan details"), "warns about plan details");
    assert.ok(text.includes("subagent_get_plan"), "mentions retrieval tool");
    // Dependencies are listed
    assert.ok(text.includes("subjob_a"), "includes first dependency");
    assert.ok(text.includes("subjob_b"), "includes second dependency");
    assert.ok(text.includes("completed"), "includes status");
    assert.ok(text.includes("2 calls"), "includes summary");
  } finally {
    cleanup();
  }
});

test("fleet view: summary reflects counts", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobFleet } = await import(moduleUrl);
    const now = Date.now();
    const jobs = [
      makeFleetJob({ id: "j1", status: "needs_input", updatedAt: now - 2000, waitingForInput: { id: "e1", callIndex: 0, question: "q?", marker: "M", status: "open", createdAt: now - 2000, updatedAt: now - 2000 } }),
      makeFleetJob({ id: "j2", status: "running", updatedAt: now - 5000, callStates: [{ phase: "running", toolCalls: 0, recentActivity: [] }] }),
      makeFleetJob({ id: "j3", status: "running", updatedAt: now - 6000, callStates: [{ phase: "running", toolCalls: 0, recentActivity: [] }] }),
      makeFleetJob({ id: "j4", status: "failed", updatedAt: now - 10000, error: "err" }),
      makeFleetJob({ id: "j5", status: "completed", updatedAt: now - 60000 }), // recent enough
    ];

    const text = formatJobFleet(jobs);
    assert.ok(text.includes("1 needs_input"), "counts needs_input");
    assert.ok(text.includes("2 running"), "counts running");
    assert.ok(text.includes("1 failed"), "counts failed");
    assert.ok(text.includes("1 completed"), "counts completed");
  } finally {
    cleanup();
  }
});
