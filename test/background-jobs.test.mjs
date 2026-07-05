import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Create a testable render module that stubs out external dependencies.
function createTestableRenderModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-render-bg-"));
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

// ---------------------------------------------------------------------------
// Background job registry tests — isolated via clearBackgroundJobs()
// ---------------------------------------------------------------------------

test("generateJobId produces subjob_ prefixed IDs", async () => {
  const { generateJobId } = await import("../background-jobs.ts");
  const id = generateJobId();
  assert.match(id, /^subjob_[0-9a-f]{8}$/);
});

test("generateJobId produces unique IDs", async () => {
  const { generateJobId } = await import("../background-jobs.ts");
  const ids = new Set(Array.from({ length: 10 }, () => generateJobId()));
  assert.equal(ids.size, 10);
});

test("getActiveBackgroundJobCount returns 0 initially", async () => {
  const { clearBackgroundJobs, getActiveBackgroundJobCount } = await import("../background-jobs.ts");
  clearBackgroundJobs();
  assert.equal(getActiveBackgroundJobCount(), 0);
});

test("register a background job and look it up", async () => {
  const { clearBackgroundJobs, generateJobId, registerBackgroundJob, getBackgroundJob, getActiveBackgroundJobCount, removeBackgroundJob } = await import("../background-jobs.ts");
  clearBackgroundJobs();

  const id = generateJobId();
  const job = { id, createdAt: Date.now(), updatedAt: Date.now(), status: "running", calls: [], promise: Promise.resolve(), onComplete: "trigger" };

  assert.equal(getActiveBackgroundJobCount(), 0);
  registerBackgroundJob(job);
  assert.equal(getActiveBackgroundJobCount(), 1);

  const retrieved = getBackgroundJob(id);
  assert.ok(retrieved);
  assert.equal(retrieved.id, id);
  assert.equal(retrieved.status, "running");

  removeBackgroundJob(id);
});

test("job transitions to completed do not count as active", async () => {
  const { clearBackgroundJobs, generateJobId, registerBackgroundJob, getActiveBackgroundJobCount, getBackgroundJob, removeBackgroundJob } = await import("../background-jobs.ts");
  clearBackgroundJobs();

  const id = generateJobId();
  registerBackgroundJob({ id, createdAt: Date.now(), updatedAt: Date.now(), status: "running", calls: [], promise: Promise.resolve(), onComplete: "trigger" });
  assert.equal(getActiveBackgroundJobCount(), 1);

  const retrieved = getBackgroundJob(id);
  if (retrieved) { retrieved.status = "completed"; retrieved.updatedAt = Date.now(); }
  assert.equal(getActiveBackgroundJobCount(), 0);
  removeBackgroundJob(id);
});

test("getAllBackgroundJobs returns jobs most recent first", async () => {
  const { clearBackgroundJobs, generateJobId, registerBackgroundJob, getAllBackgroundJobs, removeBackgroundJob } = await import("../background-jobs.ts");
  clearBackgroundJobs();

  const id1 = generateJobId();
  const id2 = generateJobId();
  const id3 = generateJobId();

  registerBackgroundJob({ id: id1, createdAt: 100, updatedAt: 100, status: "completed", calls: [], promise: Promise.resolve(), onComplete: "silent" });
  registerBackgroundJob({ id: id2, createdAt: 200, updatedAt: 200, status: "running", calls: [], promise: Promise.resolve(), onComplete: "trigger" });
  registerBackgroundJob({ id: id3, createdAt: 300, updatedAt: 300, status: "failed", calls: [], promise: Promise.resolve(), onComplete: "message" });

  const all = getAllBackgroundJobs();
  assert.equal(all.length, 3);
  assert.equal(all[0].id, id3);
  assert.equal(all[1].id, id2);
  assert.equal(all[2].id, id1);

  for (const id of [id1, id2, id3]) removeBackgroundJob(id);
  assert.equal(getAllBackgroundJobs().length, 0);
});

test("removeBackgroundJob removes from registry", async () => {
  const { clearBackgroundJobs, generateJobId, registerBackgroundJob, getBackgroundJob, removeBackgroundJob } = await import("../background-jobs.ts");
  clearBackgroundJobs();

  const id = generateJobId();
  registerBackgroundJob({ id, createdAt: 0, updatedAt: 0, status: "running", calls: [], promise: Promise.resolve(), onComplete: "trigger" });
  assert.ok(getBackgroundJob(id));
  removeBackgroundJob(id);
  assert.equal(getBackgroundJob(id), undefined);
});

// ---------------------------------------------------------------------------
// Active count with new status values
// ---------------------------------------------------------------------------

test("cancelling jobs count as active", async () => {
  const { clearBackgroundJobs, generateJobId, registerBackgroundJob, getActiveBackgroundJobCount, removeBackgroundJob } = await import("../background-jobs.ts");
  clearBackgroundJobs();

  const id = generateJobId();
  registerBackgroundJob({ id, createdAt: 0, updatedAt: 0, status: "cancelling", calls: [], promise: Promise.resolve(), onComplete: "trigger" });
  assert.equal(getActiveBackgroundJobCount(), 1);
  removeBackgroundJob(id);
});

test("cancelled jobs do not count as active", async () => {
  const { clearBackgroundJobs, generateJobId, registerBackgroundJob, getActiveBackgroundJobCount, removeBackgroundJob } = await import("../background-jobs.ts");
  clearBackgroundJobs();

  const id = generateJobId();
  registerBackgroundJob({ id, createdAt: 0, updatedAt: 0, status: "cancelled", calls: [], promise: Promise.resolve(), onComplete: "message" });
  assert.equal(getActiveBackgroundJobCount(), 0);
  removeBackgroundJob(id);
});

// ---------------------------------------------------------------------------
// FormatBackgroundCompletion — cancellation
// ---------------------------------------------------------------------------

test("formatBackgroundCompletion shows cancelled state", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const job = {
      id: "subjob_cancelled1",
      createdAt: Date.now() - 8000,
      updatedAt: Date.now(),
      status: "cancelled",
      onComplete: "trigger",
      calls: [{ index: 0, agent: "runner", prompt: "Long task", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "runner", agentSource: "user", prompt: "Long task", initialContext: "empty",
        exitCode: 130, messages: [], stderr: "Subagent was aborted.",
        usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        stopReason: "aborted", errorMessage: "Subagent was aborted.",
      }],
    };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /subjob_cancelled1/);
    assert.match(text, /was cancelled/);
    assert.match(text, /call 1: cancelled/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FormatJobStatus
// ---------------------------------------------------------------------------

test("formatJobStatus shows running job", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_run1",
      createdAt: Date.now() - 30000,
      updatedAt: Date.now() - 30000,
      status: "running",
      calls: [
        { index: 0, agent: "explorer", prompt: "Find tests", effectiveCwd: "/tmp", initialContext: "empty" },
        { index: 1, agent: "reviewer", prompt: "Review code", effectiveCwd: "/tmp", initialContext: "empty" },
      ],
      results: [],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_run1/);
    assert.match(text, /running/);
    assert.match(text, /2 calls/);
    assert.match(text, /started/);
    assert.match(text, /explorer/);
    assert.match(text, /reviewer/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus shows completed job with call results", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_done1",
      createdAt: Date.now() - 120000,
      updatedAt: Date.now() - 60000,
      status: "completed",
      calls: [{ index: 0, agent: "explorer", prompt: "Find files", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Find files", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1000 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_done1/);
    assert.match(text, /completed/);
    assert.match(text, /1 call/);
    assert.match(text, /took/);
    assert.match(text, /explorer/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus shows failed job", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_fail1",
      createdAt: Date.now() - 60000,
      updatedAt: Date.now(),
      status: "failed",
      calls: [{ index: 0, agent: "fixer", prompt: "Fix", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "fixer", agentSource: "user", prompt: "Fix", initialContext: "empty",
        exitCode: 1, messages: [], stderr: "Error",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        stopReason: "error", errorMessage: "Error",
      }],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_fail1/);
    assert.match(text, /failed/);
    assert.match(text, /1 call/);
    assert.match(text, /fixer/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus shows cancelling job", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_cancel1",
      createdAt: Date.now() - 15000,
      updatedAt: Date.now() - 5000,
      status: "cancelling",
      calls: [{ index: 0, agent: "runner", prompt: "Run", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_cancel1/);
    assert.match(text, /cancelling/);
    assert.match(text, /1 call/);
    assert.match(text, /runner/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FormatJobList
// ---------------------------------------------------------------------------

test("formatJobList shows empty state", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobList } = await import(moduleUrl);
    assert.equal(formatJobList([]), "No background subagent jobs.");
  } finally {
    cleanup();
  }
});

test("formatJobList shows mixed states with summary", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobList } = await import(moduleUrl);

    const jobs = [
      { id: "subjob_a", createdAt: Date.now() - 10000, updatedAt: Date.now() - 10000, status: "running", calls: [{ index: 0, agent: "a", prompt: "", effectiveCwd: "/tmp", initialContext: "empty" }], promise: Promise.resolve(), onComplete: "trigger" },
      { id: "subjob_b", createdAt: Date.now() - 60000, updatedAt: Date.now() - 10000, status: "completed", calls: [], promise: Promise.resolve(), onComplete: "message" },
      { id: "subjob_c", createdAt: Date.now() - 120000, updatedAt: Date.now() - 60000, status: "failed", calls: [], promise: Promise.resolve(), onComplete: "silent" },
      { id: "subjob_d", createdAt: Date.now() - 300000, updatedAt: Date.now() - 120000, status: "cancelled", calls: [], promise: Promise.resolve(), onComplete: "trigger" },
    ];

    const text = formatJobList(jobs);
    assert.match(text, /Background subagent jobs/);
    assert.match(text, /subjob_a.*running/);
    assert.match(text, /subjob_b.*completed/);
    assert.match(text, /subjob_c.*failed/);
    assert.match(text, /subjob_d.*cancelled/);
    assert.match(text, /1 running.*1 completed.*1 failed.*1 cancelled/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Render for subagent_status
// ---------------------------------------------------------------------------

test("renderJobStatusCall shows jobId or default", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderJobStatusCall } = await import(moduleUrl);

    const specific = renderJobStatusCall({ jobId: "subjob_abc123" }, theme);
    assert.match(collectText(specific).join(" "), /subagent_status.*subjob_abc123/);

    const all = renderJobStatusCall({}, theme);
    assert.match(collectText(all).join(" "), /subagent_status.*\(all\)/);
  } finally {
    cleanup();
  }
});

test("renderJobStatusResult shows text content", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderJobStatusResult } = await import(moduleUrl);

    const component = renderJobStatusResult(
      { content: [{ type: "text", text: "subjob_abc123: running, 1 call" }], details: {} },
      false, theme,
    );
    assert.match(collectText(component).join(" "), /running/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Render for subagent_cancel
// ---------------------------------------------------------------------------

test("renderCancelCall shows jobId", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderCancelCall } = await import(moduleUrl);

    const component = renderCancelCall({ jobId: "subjob_abc123", confirm: true }, theme);
    assert.match(collectText(component).join(" "), /subagent_cancel.*subjob_abc123/);
  } finally {
    cleanup();
  }
});

test("renderCancelResult shows cancellation message", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderCancelResult } = await import(moduleUrl);

    const component = renderCancelResult(
      { content: [{ type: "text", text: "Cancelling background job `subjob_abc123`..." }], details: {} },
      false, theme,
    );
    const text = collectText(component).join(" ");
    assert.match(text, /subagent_cancel/);
    assert.match(text, /Cancelling/);
  } finally {
    cleanup();
  }
});

test("renderCancelResult handles empty content gracefully", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderCancelResult } = await import(moduleUrl);

    const component = renderCancelResult({ content: [], details: {} }, false, theme);
    assert.match(collectText(component).join(" "), /no output/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FormatBackgroundCompletion — existing tests
// ---------------------------------------------------------------------------

test("formatBackgroundCompletion shows success state", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const job = {
      id: "subjob_test123",
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
      status: "completed",
      onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Find tests", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Find tests", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Found 5 test files." }], timestamp: 1 }],
        stderr: "", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 50, turns: 1 },
      }],
    };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /subjob_test123/);
    assert.match(text, /completed successfully/);
    assert.match(text, /explorer/);
    assert.match(text, /call 1: completed/);
    assert.match(text, /Found 5 test files/);
  } finally {
    cleanup();
  }
});

test("formatBackgroundCompletion shows failure state", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const job = {
      id: "subjob_bad456",
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
      status: "failed",
      onComplete: "trigger",
      calls: [{ index: 0, agent: "fixer", prompt: "Fix types", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "fixer", agentSource: "user", prompt: "Fix types", initialContext: "empty",
        exitCode: 1, messages: [], stderr: "Unknown file: types.ts",
        usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 10, turns: 0 },
        stopReason: "error", errorMessage: "Unknown file: types.ts",
      }],
    };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /subjob_bad456/);
    assert.match(text, /completed with errors/);
    assert.match(text, /fixer/);
    assert.match(text, /call 1: failed/);
    assert.match(text, /Unknown file/);
  } finally {
    cleanup();
  }
});

test("formatBackgroundCompletion shows error when job has error but no results", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const job = {
      id: "subjob_crash789",
      createdAt: Date.now() - 2000,
      updatedAt: Date.now(),
      status: "failed",
      onComplete: "message",
      calls: [{ index: 0, agent: "runner", prompt: "Run", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
      error: "Child process crashed with SIGKILL",
    };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /subjob_crash789/);
    assert.match(text, /completed with errors/);
    assert.match(text, /Error: Child process crashed/);
  } finally {
    cleanup();
  }
});

test("formatBackgroundCompletion handles empty results gracefully", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const job = { id: "subjob_empty", createdAt: Date.now() - 3000, updatedAt: Date.now(), status: "completed", onComplete: "silent", calls: [], results: [] };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /subjob_empty/);
    assert.match(text, /completed successfully/);
    assert.doesNotMatch(text, /call 1/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Render for subagent_start — existing tests
// ---------------------------------------------------------------------------

test("renderBackgroundCall shows calls and onComplete mode", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderBackgroundCall } = await import(moduleUrl);

    const component = renderBackgroundCall({ calls: [{ agent: "explorer", prompt: "Find all test files" }, { agent: "reviewer", prompt: "Review types.ts" }], onComplete: "trigger" }, theme);
    const text = collectText(component).join(" ");
    assert.match(text, /subagent_start/);
    assert.match(text, /2 calls/);
    assert.match(text, /trigger/);
    assert.match(text, /explorer/);
    assert.match(text, /reviewer/);
  } finally {
    cleanup();
  }
});

test("renderBackgroundResult shows the started message", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderBackgroundResult } = await import(moduleUrl);

    const component = renderBackgroundResult({ content: [{ type: "text", text: "Started background subagent job `subjob_abc123` with 2 calls." }], details: {} }, false, theme);
    const text = collectText(component).join(" ");
    assert.match(text, /subagent_start/);
    assert.match(text, /started/);
    assert.match(text, /subjob_abc123/);
    assert.match(text, /2 calls/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FormatBackgroundCompletion — new excerpt features
// ---------------------------------------------------------------------------

test("formatBackgroundCompletion shows tool call count and output size", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const job = {
      id: "subjob_toolcount",
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
      status: "completed",
      onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Find files", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Find files", initialContext: "empty",
        exitCode: 0,
        messages: [
          { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "find . -name '*.ts'" } }], timestamp: 1 },
          { role: "tool", content: [{ type: "text", text: "file1.ts\nfile2.ts" }], timestamp: 2 },
          { role: "assistant", content: [{ type: "text", text: "Found 2 TypeScript files." }], timestamp: 3 },
        ],
        stderr: "", usage: { input: 10, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50, turns: 2 },
      }],
    };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /call 1: completed/);
    assert.match(text, /1 tool call/);
    assert.match(text, /output\)/);
  } finally {
    cleanup();
  }
});

test("formatBackgroundCompletion does not truncate output under 2000 chars", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const shortOutput = "A".repeat(500);
    const job = {
      id: "subjob_short",
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
      status: "completed",
      onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Short task", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Short task", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: shortOutput }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /completed successfully/);
    assert.doesNotMatch(text, /Output truncated/);
    assert.match(text, /A{500}/);
  } finally {
    cleanup();
  }
});

test("formatBackgroundCompletion shows truncation notice for output over 2000 chars", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const longOutput = "B".repeat(2500);
    const job = {
      id: "subjob_long",
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
      status: "completed",
      onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Long task", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Long task", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: longOutput }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /Output truncated/);
    assert.match(text, /subagent_result/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FormatJobResults — subagent_result tool
// ---------------------------------------------------------------------------

test("formatJobResults returns error for missing results", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = { id: "subjob_noresults", createdAt: 0, updatedAt: 0, status: "completed", onComplete: "trigger", calls: [], results: [] };
    assert.equal(formatJobResults(job, {}), "No results available for this job.");
  } finally {
    cleanup();
  }
});

test("formatJobResults returns full output for completed job", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_full",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Analyze", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Analyze", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Full analysis report here." }], timestamp: 1 }],
        stderr: "", usage: { input: 10, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50, turns: 1 },
      }],
    };

    const text = formatJobResults(job, {});
    assert.match(text, /## explorer/);
    assert.match(text, /completed/);
    assert.match(text, /Full analysis report here/);
  } finally {
    cleanup();
  }
});

test("formatJobResults respects callIndex", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_multi",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [
        { index: 0, agent: "explorer", prompt: "Find", effectiveCwd: "/tmp", initialContext: "empty" },
        { index: 1, agent: "reviewer", prompt: "Check", effectiveCwd: "/tmp", initialContext: "empty" },
      ],
      results: [
        { callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Find", initialContext: "empty", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Search results" }], timestamp: 1 }], stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } },
        { callIndex: 1, agent: "reviewer", agentSource: "user", prompt: "Check", initialContext: "empty", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Review results" }], timestamp: 2 }], stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } },
      ],
    };

    const textCall0 = formatJobResults(job, { callIndex: 0 });
    assert.match(textCall0, /## explorer/);
    assert.doesNotMatch(textCall0, /## reviewer/);

    const textCall1 = formatJobResults(job, { callIndex: 1 });
    assert.match(textCall1, /## reviewer/);
    assert.doesNotMatch(textCall1, /## explorer/);
  } finally {
    cleanup();
  }
});

test("formatJobResults respects maxOutputLength", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const longOutput = "C".repeat(500);
    const job = {
      id: "subjob_capped",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Long task", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Long task", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: longOutput }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobResults(job, { maxOutputLength: 100 });
    assert.match(text, /truncated at 100 characters/);
  } finally {
    cleanup();
  }
});

test("formatJobResults includes tool calls when requested", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_toolcalls",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Search", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Search", initialContext: "empty",
        exitCode: 0,
        messages: [
          { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "test", path: "." } }], timestamp: 1 },
          { role: "tool", content: [{ type: "text", text: "found" }], timestamp: 2 },
          { role: "assistant", content: [{ type: "text", text: "Done searching." }], timestamp: 3 },
        ],
        stderr: "", usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 10, turns: 2 },
      }],
    };

    const textWithout = formatJobResults(job, { includeToolCalls: false });
    assert.doesNotMatch(textWithout, /Tool calls/);

    const textWith = formatJobResults(job, { includeToolCalls: true });
    assert.match(textWith, /### Tool calls/);
    assert.match(textWith, /grep/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Render for subagent_result
// ---------------------------------------------------------------------------

test("renderSubagentResultCall shows jobId", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderSubagentResultCall } = await import(moduleUrl);

    const component = renderSubagentResultCall({ jobId: "subjob_abc123" }, theme);
    assert.match(collectText(component).join(" "), /subagent_result.*subjob_abc123/);
  } finally {
    cleanup();
  }
});

test("renderSubagentResultResult shows results content", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderSubagentResultResult } = await import(moduleUrl);

    const component = renderSubagentResultResult(
      { content: [{ type: "text", text: "## explorer — completed\n\nFull report here." }], details: {} },
      false, theme,
    );
    const text = collectText(component).join(" ");
    assert.match(text, /subagent_result/);
    assert.match(text, /results/);
    assert.match(text, /Full report/);
  } finally {
    cleanup();
  }
});

test("renderSubagentResultResult handles empty content", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderSubagentResultResult } = await import(moduleUrl);

    const component = renderSubagentResultResult({ content: [], details: {} }, false, theme);
    assert.match(collectText(component).join(" "), /no output/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FormatJobStatus with call states
// ---------------------------------------------------------------------------

test("formatJobStatus falls back gracefully without callStates", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_nocs",
      createdAt: Date.now() - 30000,
      updatedAt: Date.now() - 30000,
      status: "running",
      calls: [{ index: 0, agent: "explorer", prompt: "Find tests", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_nocs/);
    assert.match(text, /running/);
    assert.match(text, /explorer/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus honors callStates when present", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_cs",
      createdAt: Date.now() - 30000,
      updatedAt: Date.now() - 30000,
      status: "running",
      calls: [{ index: 0, agent: "explorer", prompt: "Find tests", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
      callStates: [
        { phase: "running", startedAt: Date.now() - 25000, toolCalls: 3, recentActivity: ["→ read file.ts", "$ find . -name '*.ts'", "→ grep /test/ ."] },
      ],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_cs/);
    assert.match(text, /running/);
    assert.match(text, /3 tool calls/);
    assert.match(text, /read file\.ts/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus shows queued for callState without phase data", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_queued",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
      status: "running",
      calls: [{ index: 0, agent: "explorer", prompt: "Wait", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
      callStates: [
        { phase: "queued", toolCalls: 0, recentActivity: [] },
      ],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_queued/);
    assert.match(text, /queued/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus shows completed state with duration from callStates", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_donecs",
      createdAt: Date.now() - 120000,
      updatedAt: Date.now() - 60000,
      status: "completed",
      calls: [{ index: 0, agent: "explorer", prompt: "Find files", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Find files", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1000 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
      callStates: [
        { phase: "completed", startedAt: Date.now() - 120000, completedAt: Date.now() - 60000, toolCalls: 2, recentActivity: [] },
      ],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_donecs/);
    assert.match(text, /completed/);
    assert.match(text, /took/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus shows mixed running and queued call states (simulating concurrency queue)", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_mixed",
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
      status: "running",
      calls: [
        { index: 0, agent: "explorer", prompt: "Search files", effectiveCwd: "/tmp", initialContext: "empty" },
        { index: 1, agent: "reviewer", prompt: "Review code", effectiveCwd: "/tmp", initialContext: "empty" },
      ],
      results: [],
      callStates: [
        { phase: "running", startedAt: Date.now() - 5000, toolCalls: 2, recentActivity: ["→ read src/index.ts"] },
        { phase: "queued", toolCalls: 0, recentActivity: [] },
      ],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_mixed/);
    assert.match(text, /running/);
    // First call shows running with activity
    assert.match(text, /explorer/);
    assert.match(text, /running.*elapsed/);
    assert.match(text, /read src\/index\.ts/);
    // Second call shows queued
    assert.match(text, /reviewer/);
    assert.match(text, /queued/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus shows spawning phase for starting call", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_spawn1",
      createdAt: Date.now() - 3000,
      updatedAt: Date.now() - 3000,
      status: "running",
      calls: [{ index: 0, agent: "explorer", prompt: "Do work", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
      callStates: [
        { phase: "spawning", startedAt: Date.now() - 500, toolCalls: 0, recentActivity: [] },
      ],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_spawn1/);
    assert.match(text, /spawning/);
    assert.match(text, /elapsed/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FormatJobResults — defensive validation
// ---------------------------------------------------------------------------

test("formatJobResults handles fractional callIndex defensively", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_frac",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Find", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Find", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Results" }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobResults(job, { callIndex: 1.5 });
    assert.equal(text, "No results available for this job.");
  } finally {
    cleanup();
  }
});

test("formatJobResults handles negative callIndex defensively", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_neg",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Find", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Find", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Results" }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobResults(job, { callIndex: -1 });
    assert.equal(text, "No results available for this job.");
  } finally {
    cleanup();
  }
});

test("formatJobResults handles out-of-range callIndex defensively", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_oob",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Find", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Find", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Results" }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobResults(job, { callIndex: 5 });
    assert.equal(text, "No results available for this job.");
  } finally {
    cleanup();
  }
});

test("formatJobResults handles maxOutputLength of 0 defensively", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_zero",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Task", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Task", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Some output here." }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobResults(job, { maxOutputLength: 0 });
    // maxOutputLength of 0 is falsy, so no truncation is applied
    assert.match(text, /Some output here/);
    assert.doesNotMatch(text, /truncated/);
  } finally {
    cleanup();
  }
});

test("formatJobResults handles negative maxOutputLength defensively", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_negmax",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Task", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Task", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Some output here." }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobResults(job, { maxOutputLength: -1 });
    // Negative maxOutputLength is falsy via the && check, so no truncation
    assert.match(text, /Some output here/);
    assert.doesNotMatch(text, /truncated/);
  } finally {
    cleanup();
  }
});

test("formatJobResults handles fractional maxOutputLength defensively", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_fracmax",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Task", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Task", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Some output here." }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobResults(job, { maxOutputLength: 2.5 });
    // The defensive check floors to 2, so output is truncated at 2 characters.
    assert.match(text, /truncated at 2 characters/);
    assert.equal(text.includes("So"), true); // "Some output here." truncated to "So" (first 2 chars)
  } finally {
    cleanup();
  }
});

test("formatJobResults handles large maxOutputLength defensively", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const job = {
      id: "subjob_largemax",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Task", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Task", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Short output." }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobResults(job, { maxOutputLength: 100000 });
    // Output is shorter than limit, so no truncation even though limit > 50000
    assert.match(text, /Short output/);
    assert.doesNotMatch(text, /truncated/);
  } finally {
    cleanup();
  }
});

test("formatJobResults valid maxOutputLength still truncates", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobResults } = await import(moduleUrl);

    const longOutput = "C".repeat(500);
    const job = {
      id: "subjob_validcap",
      createdAt: 0, updatedAt: 1000,
      status: "completed", onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Long task", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Long task", initialContext: "empty",
        exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: longOutput }], timestamp: 1 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatJobResults(job, { maxOutputLength: 100 });
    assert.match(text, /truncated at 100 characters/);
    assert.equal(text.includes("C".repeat(100)), true);
    assert.equal(text.includes("C".repeat(101)), false);
  } finally {
    cleanup();
  }
});

// ===================================================================
// Interrupted status rendering
// ===================================================================

test("formatBackgroundCompletion shows interrupted state", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const job = {
      id: "subjob_interrupted",
      createdAt: Date.now() - 30000,
      updatedAt: Date.now(),
      status: "interrupted",
      onComplete: "trigger",
      calls: [{ index: 0, agent: "explorer", prompt: "Find tests", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
    };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /subjob_interrupted/);
    assert.match(text, /interrupted/);
    assert.match(text, /parent process exited/);
  } finally {
    cleanup();
  }
});

test("formatJobList shows interrupted jobs in summary", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobList } = await import(moduleUrl);

    const jobs = [
      { id: "subjob_run", createdAt: Date.now() - 10000, updatedAt: Date.now() - 10000, status: "running", calls: [{ index: 0, agent: "a", prompt: "", effectiveCwd: "/tmp", initialContext: "empty" }], promise: Promise.resolve(), onComplete: "trigger" },
      { id: "subjob_int", createdAt: Date.now() - 60000, updatedAt: Date.now() - 30000, status: "interrupted", calls: [{ index: 0, agent: "b", prompt: "", effectiveCwd: "/tmp", initialContext: "empty" }], promise: Promise.resolve(), onComplete: "message" },
    ];

    const text = formatJobList(jobs);
    assert.match(text, /subjob_int.*interrupted/);
    assert.match(text, /interrupted/);
    assert.match(text, /1 running.*1 interrupted/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus shows interrupted job", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_statint",
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 30000,
      status: "interrupted",
      calls: [{ index: 0, agent: "explorer", prompt: "Find", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_statint/);
    assert.match(text, /interrupted/);
  } finally {
    cleanup();
  }
});

// ===================================================================
// Worktree safety tests
// ===================================================================

test("formatJobStatus shows shared worktree mode", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_shared",
      createdAt: Date.now() - 30000,
      updatedAt: Date.now() - 30000,
      status: "running",
      calls: [{ index: 0, agent: "explorer", prompt: "Find tests", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
      worktreeMode: "shared",
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_shared/);
    assert.match(text, /\[shared worktree\]/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus shows isolated worktree mode", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_isolated",
      createdAt: Date.now() - 30000,
      updatedAt: Date.now() - 30000,
      status: "running",
      calls: [{ index: 0, agent: "explorer", prompt: "Find tests", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
      worktreeMode: "isolated",
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_isolated/);
    assert.match(text, /\[isolated worktree\]/);
  } finally {
    cleanup();
  }
});

test("formatJobStatus omits worktree label for legacy jobs without mode", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobStatus } = await import(moduleUrl);

    const job = {
      id: "subjob_legacy",
      createdAt: Date.now() - 30000,
      updatedAt: Date.now() - 30000,
      status: "running",
      calls: [{ index: 0, agent: "explorer", prompt: "Find tests", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [],
    };

    const text = formatJobStatus(job);
    assert.match(text, /subjob_legacy/);
    assert.doesNotMatch(text, /\[.*worktree\]/);
  } finally {
    cleanup();
  }
});

test("formatJobList shows worktree mode in listing", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatJobList } = await import(moduleUrl);

    const jobs = [
      { id: "subjob_a", createdAt: Date.now() - 10000, updatedAt: Date.now() - 10000, status: "running", calls: [{ index: 0, agent: "a", prompt: "", effectiveCwd: "/tmp", initialContext: "empty" }], promise: Promise.resolve(), onComplete: "trigger", worktreeMode: "isolated" },
      { id: "subjob_b", createdAt: Date.now() - 60000, updatedAt: Date.now() - 10000, status: "completed", calls: [], promise: Promise.resolve(), onComplete: "message", worktreeMode: "shared" },
    ];

    const text = formatJobList(jobs);
    assert.match(text, /subjob_a.*\[isolated worktree\]/);
    assert.match(text, /subjob_b.*\[shared worktree\]/);
  } finally {
    cleanup();
  }
});

test("formatBackgroundCompletion shows worktree mode", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { formatBackgroundCompletion } = await import(moduleUrl);

    const job = {
      id: "subjob_done_wt",
      createdAt: Date.now() - 8000,
      updatedAt: Date.now(),
      status: "completed",
      onComplete: "trigger",
      worktreeMode: "isolated",
      calls: [{ index: 0, agent: "explorer", prompt: "Find", effectiveCwd: "/tmp", initialContext: "empty" }],
      results: [{
        callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Find", initialContext: "empty",
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: "Found." }], timestamp: 1000 }],
        stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      }],
    };

    const text = formatBackgroundCompletion(job);
    assert.match(text, /subjob_done_wt/);
    assert.match(text, /\[isolated worktree\]/);
  } finally {
    cleanup();
  }
});

test("BackgroundJob type accepts worktreeMode field", async () => {
  const { getAllBackgroundJobs, clearBackgroundJobs, generateJobId, registerBackgroundJob, getBackgroundJob, removeBackgroundJob } = await import("../background-jobs.ts");
  clearBackgroundJobs();

  const id = generateJobId();
  const job = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    calls: [{ index: 0, agent: "isolated-agent", prompt: "Do work", effectiveCwd: "/tmp", initialContext: "empty" }],
    callStates: [{ phase: "queued", toolCalls: 0, recentActivity: [] }],
    promise: Promise.resolve(),
    onComplete: "trigger",
    worktreeMode: "isolated",
    worktreeMetadata: { path: "/tmp/worktrees/subjob_abc", branch: "subjob/subjob_abc-isolated-agent", baseCommit: "abc123" },
  };

  registerBackgroundJob(job);
  const retrieved = getBackgroundJob(id);
  assert.ok(retrieved);
  assert.equal(retrieved.worktreeMode, "isolated");
  assert.equal(retrieved.worktreeMetadata?.branch, "subjob/subjob_abc-isolated-agent");
  assert.equal(retrieved.worktreeMetadata?.baseCommit, "abc123");
  removeBackgroundJob(id);
});

// ===================================================================
// Background jobs registry persistence integration
// ===================================================================

test("setJobStoreBaseDir creates the jobs directory", async () => {
  const mod = await import("../background-jobs.ts");
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bg-integration-"));
  try {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(baseDir);

    const jobsDir = path.join(baseDir, ".pi-subagent", "jobs");
    assert.ok(fs.existsSync(jobsDir));
  } finally {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(null);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("setJobStoreBaseDir(null) disables persistence", async () => {
  const mod = await import("../background-jobs.ts");
  mod.clearBackgroundJobs();
  mod.setJobStoreBaseDir(null);
  assert.equal(mod.getJobStoreBaseDir(), null);
});

test("registerBackgroundJob persists when store is configured", async () => {
  const mod = await import("../background-jobs.ts");
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bg-persist-"));
  try {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(baseDir);

    const id = mod.generateJobId();
    const job = { id, createdAt: Date.now(), updatedAt: Date.now(), status: "running", calls: [], callStates: [], promise: Promise.resolve(), onComplete: "trigger" };

    mod.registerBackgroundJob(job);

    const statePath = path.join(baseDir, ".pi-subagent", "jobs", id, "state.json");
    assert.ok(fs.existsSync(statePath));

    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(raw.jobId, id);
    assert.equal(raw.status, "running");
  } finally {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(null);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("updateBackgroundJobStatus persists status change", async () => {
  const mod = await import("../background-jobs.ts");
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bg-status-"));
  try {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(baseDir);

    const id = mod.generateJobId();
    const job = { id, createdAt: Date.now(), updatedAt: Date.now(), status: "running", calls: [], callStates: [], promise: Promise.resolve(), onComplete: "trigger" };
    mod.registerBackgroundJob(job);

    mod.updateBackgroundJobStatus(id, "completed");

    const statePath = path.join(baseDir, ".pi-subagent", "jobs", id, "state.json");
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(raw.status, "completed");

    const retrieved = mod.getBackgroundJob(id);
    assert.equal(retrieved.status, "completed");
  } finally {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(null);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("setBackgroundJobResults persists results", async () => {
  const mod = await import("../background-jobs.ts");
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bg-results-"));
  try {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(baseDir);

    const id = mod.generateJobId();
    const job = { id, createdAt: Date.now(), updatedAt: Date.now(), status: "running", calls: [], callStates: [], promise: Promise.resolve(), onComplete: "trigger" };
    mod.registerBackgroundJob(job);

    const results = [{
      callIndex: 0, agent: "explorer", agentSource: "user", prompt: "Test", initialContext: "empty",
      exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1 }],
      stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    }];

    mod.setBackgroundJobResults(id, results);

    const statePath = path.join(baseDir, ".pi-subagent", "jobs", id, "state.json");
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(raw.results.length, 1);
    assert.equal(raw.results[0].exitCode, 0);
  } finally {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(null);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reloadPersistedJobs loads terminal and interrupted jobs", async () => {
  const mod = await import("../background-jobs.ts");
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bg-reload-"));
  try {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(baseDir);

    // Persist some jobs directly via the store
    const storeMod = await import("../background-job-store.ts");
    const completed = makeMinimalJobFromStore("reload_completed", "completed");
    const failed = makeMinimalJobFromStore("reload_failed", "failed");
    const running = makeMinimalJobFromStore("reload_running", "running", undefined);

    storeMod.persistJobState(baseDir, completed);
    storeMod.persistJobState(baseDir, failed);
    storeMod.persistJobState(baseDir, running);

    mod.clearBackgroundJobs();
    const count = mod.reloadPersistedJobs();

    // Should have loaded 3 jobs
    assert.equal(count, 3);
    assert.equal(mod.getTotalJobCount(), 3);

    // Running job should be interrupted
    const interrupted = mod.getBackgroundJob("reload_running");
    assert.equal(interrupted.status, "interrupted");

    // Completed/failed should keep their status
    assert.equal(mod.getBackgroundJob("reload_completed").status, "completed");
    assert.equal(mod.getBackgroundJob("reload_failed").status, "failed");
  } finally {
    mod.clearBackgroundJobs();
    mod.setJobStoreBaseDir(null);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

function makeMinimalJobFromStore(id, status, results) {
  return {
    id,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now(),
    status,
    onComplete: "trigger",
    calls: [{ index: 0, agent: "test-agent", prompt: "Test", effectiveCwd: "/tmp", initialContext: "empty" }],
    callStates: [{ phase: status === "running" ? "running" : "completed", toolCalls: 0, recentActivity: [] }],
    results: results !== undefined ? results : [{
      callIndex: 0, agent: "test-agent", agentSource: "user", prompt: "Test", initialContext: "empty",
      exitCode: status === "failed" ? 1 : 0,
      messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1 }],
      stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    }],
    promise: Promise.resolve(),
  };
}
