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
