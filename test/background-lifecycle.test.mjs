/**
 * Tests for background-lifecycle.ts helpers.
 *
 * These tests verify that markPendingCallsCancelled and finishCallState
 * produce consistent call states during and after cancellation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Create a testable version of the module by rewriting import paths
// ---------------------------------------------------------------------------

function createTestableLifecycleModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lifecycle-"));
  const modulePath = path.join(tmpDir, "background-lifecycle.testable.ts");
  const source = fs
    .readFileSync(path.join(process.cwd(), "background-lifecycle.ts"), "utf-8")
    .replaceAll(
      'from "./types.js"',
      `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "types.ts")).href)}`,
    );
  fs.writeFileSync(modulePath, source);
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides = {}) {
  return {
    id: "subjob_test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    calls: [],
    callStates: [],
    promise: Promise.resolve(),
    onComplete: "trigger",
    ...overrides,
  };
}

function makeCallState(phase, overrides = {}) {
  return {
    phase,
    toolCalls: 0,
    recentActivity: [],
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    callIndex: 0,
    agent: "test",
    agentSource: "user",
    prompt: "test",
    initialContext: "empty",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// markPendingCallsCancelled
// ---------------------------------------------------------------------------

test("markPendingCallsCancelled sets queued, spawning, and running to cancelled", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { markPendingCallsCancelled } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      callStates: [
        makeCallState("queued"),
        makeCallState("spawning", { startedAt: now - 5000 }),
        makeCallState("running", { startedAt: now - 10000 }),
      ],
    });

    markPendingCallsCancelled(job, now);

    for (const cs of job.callStates) {
      assert.equal(cs.phase, "cancelled");
      assert.ok(cs.completedAt, "completedAt should be set");
    }
  } finally {
    cleanup();
  }
});

test("markPendingCallsCancelled preserves completed and failed states", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { markPendingCallsCancelled } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      callStates: [
        makeCallState("completed", { completedAt: now - 20000 }),
        makeCallState("failed", { completedAt: now - 10000 }),
        makeCallState("running", { startedAt: now - 5000 }),
      ],
    });

    markPendingCallsCancelled(job, now);

    assert.equal(job.callStates[0].phase, "completed");
    assert.equal(job.callStates[0].completedAt, now - 20000);

    assert.equal(job.callStates[1].phase, "failed");
    assert.equal(job.callStates[1].completedAt, now - 10000);

    assert.equal(job.callStates[2].phase, "cancelled");
    assert.equal(job.callStates[2].completedAt, now);
  } finally {
    cleanup();
  }
});

test("markPendingCallsCancelled preserves already cancelled state", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { markPendingCallsCancelled } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      callStates: [
        makeCallState("cancelled", { completedAt: now - 5000 }),
      ],
    });

    markPendingCallsCancelled(job, now);

    assert.equal(job.callStates[0].phase, "cancelled");
    // completedAt should remain the original value
    assert.equal(job.callStates[0].completedAt, now - 5000);
  } finally {
    cleanup();
  }
});

test("markPendingCallsCancelled sets completedAt only when absent", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { markPendingCallsCancelled } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      callStates: [
        makeCallState("queued"),
        makeCallState("running", { startedAt: now - 5000, completedAt: now - 1000 }),
      ],
    });

    markPendingCallsCancelled(job, now);

    // queued had no completedAt → should be set
    assert.equal(job.callStates[0].phase, "cancelled");
    assert.equal(job.callStates[0].completedAt, now);

    // running had an existing completedAt → should be preserved
    assert.equal(job.callStates[1].phase, "cancelled");
    assert.equal(job.callStates[1].completedAt, now - 1000);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// finishCallState
// ---------------------------------------------------------------------------

test("finishCallState refuses to overwrite cancelled call state during job cancellation", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { finishCallState } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      status: "cancelling",
      callStates: [
        makeCallState("cancelled", { completedAt: now - 1000 }),
      ],
    });

    // Simulate an aborted result coming back
    const abortedResult = makeResult({
      exitCode: 130,
      stopReason: "aborted",
      errorMessage: "Subagent was aborted.",
    });

    const phase = finishCallState(job, 0, abortedResult, now);

    assert.equal(phase, "cancelled");
    assert.equal(job.callStates[0].phase, "cancelled");
    // completedAt should not have been overwritten
    assert.equal(job.callStates[0].completedAt, now - 1000);
  } finally {
    cleanup();
  }
});

test("finishCallState refuses to overwrite cancelled call state when job is already cancelled", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { finishCallState } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      status: "cancelled",
      callStates: [
        makeCallState("cancelled", { completedAt: now - 1000 }),
      ],
    });

    const failedResult = makeResult({
      exitCode: 1,
      stopReason: "error",
      errorMessage: "Something failed",
    });

    const phase = finishCallState(job, 0, failedResult, now);

    assert.equal(phase, "cancelled");
    assert.equal(job.callStates[0].phase, "cancelled");
  } finally {
    cleanup();
  }
});

test("finishCallState does not overwrite completed state even during cancellation", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { finishCallState } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      status: "cancelling",
      callStates: [
        makeCallState("completed", { completedAt: now - 20000 }),
      ],
    });

    const abortedResult = makeResult({
      exitCode: 130,
      stopReason: "aborted",
    });

    const phase = finishCallState(job, 0, abortedResult, now);

    assert.equal(phase, "completed");
    assert.equal(job.callStates[0].phase, "completed");
    assert.equal(job.callStates[0].completedAt, now - 20000);
  } finally {
    cleanup();
  }
});

test("finishCallState does not overwrite failed state during cancellation", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { finishCallState } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      status: "cancelling",
      callStates: [
        makeCallState("failed", { completedAt: now - 10000 }),
      ],
    });

    const abortedResult = makeResult({
      exitCode: 130,
      stopReason: "aborted",
    });

    const phase = finishCallState(job, 0, abortedResult, now);

    assert.equal(phase, "failed");
    assert.equal(job.callStates[0].phase, "failed");
  } finally {
    cleanup();
  }
});

test("finishCallState sets completed for successful result", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { finishCallState } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      status: "running",
      callStates: [
        makeCallState("running", { startedAt: now - 5000 }),
      ],
    });

    const successResult = makeResult({
      exitCode: 0,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1 },
      ],
      sawAgentEnd: true,
    });

    const phase = finishCallState(job, 0, successResult, now);

    assert.equal(phase, "completed");
    assert.equal(job.callStates[0].phase, "completed");
    assert.equal(job.callStates[0].completedAt, now);
  } finally {
    cleanup();
  }
});

test("finishCallState sets failed for error result", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { finishCallState } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      status: "running",
      callStates: [
        makeCallState("running", { startedAt: now - 5000 }),
      ],
    });

    const errorResult = makeResult({
      exitCode: 1,
      stopReason: "error",
      errorMessage: "Command failed",
    });

    const phase = finishCallState(job, 0, errorResult, now);

    assert.equal(phase, "failed");
    assert.equal(job.callStates[0].phase, "failed");
    assert.equal(job.callStates[0].completedAt, now);
  } finally {
    cleanup();
  }
});

test("finishCallState does not change state when job is not cancelled and call is already completed", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { finishCallState } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      status: "running",
      callStates: [
        makeCallState("completed", { completedAt: now - 10000 }),
      ],
    });

    const phase = finishCallState(job, 0, makeResult({ exitCode: 0 }), now);

    assert.equal(phase, "completed");
    assert.equal(job.callStates[0].completedAt, now - 10000);
  } finally {
    cleanup();
  }
});

test("finishCallState does not change state when job is not cancelled and call is already failed", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { finishCallState } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      status: "running",
      callStates: [
        makeCallState("failed", { completedAt: now - 10000 }),
      ],
    });

    const phase = finishCallState(job, 0, makeResult({ exitCode: 0 }), now);

    assert.equal(phase, "failed");
    assert.equal(job.callStates[0].completedAt, now - 10000);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Integration: cancelled before worker finishes
// ---------------------------------------------------------------------------

test("simulated cancellation flow: completed calls keep phase, running calls become cancelled", async () => {
  const { moduleUrl, cleanup } = createTestableLifecycleModule();
  try {
    const { markPendingCallsCancelled, finishCallState } = await import(moduleUrl);
    const now = Date.now();
    const job = makeJob({
      status: "running",
      callStates: [
        // Already completed before cancellation
        makeCallState("completed", { completedAt: now - 30000, startedAt: now - 60000 }),
        // Still running when cancellation arrives
        makeCallState("running", { startedAt: now - 10000 }),
        // Not yet picked up
        makeCallState("queued"),
        // Already failed before cancellation
        makeCallState("failed", { completedAt: now - 20000, startedAt: now - 40000 }),
      ],
    });

    // Step 1: cancellation confirmed
    const cancelTime = now;
    job.status = "cancelling";
    markPendingCallsCancelled(job, cancelTime);

    // Verify immediate state
    assert.equal(job.callStates[0].phase, "completed");  // preserved
    assert.equal(job.callStates[1].phase, "cancelled");   // was running
    assert.equal(job.callStates[2].phase, "cancelled");   // was queued
    assert.equal(job.callStates[3].phase, "failed");      // preserved

    // Step 2: running worker finishes with aborted result
    const finishTime = cancelTime + 2000;
    const abortedResult = makeResult({
      exitCode: 130,
      stopReason: "aborted",
      errorMessage: "Subagent was aborted.",
    });

    // For the call that was running (index 1)
    const phase1 = finishCallState(job, 1, abortedResult, finishTime);
    assert.equal(phase1, "cancelled");                     // preserved
    assert.equal(job.callStates[1].phase, "cancelled");    // preserved

    // For the queued call that never started (index 2)
    const phase2 = finishCallState(job, 2, abortedResult, finishTime);
    assert.equal(phase2, "cancelled");                     // preserved
    assert.equal(job.callStates[2].phase, "cancelled");    // preserved

    // Completed call (index 0) — if finishCallState is called for it somehow
    const phase0 = finishCallState(job, 0, abortedResult, finishTime);
    assert.equal(phase0, "completed");                     // preserved
    assert.equal(job.callStates[0].phase, "completed");    // preserved

    // Failed call (index 3) — preserved
    const phase3 = finishCallState(job, 3, abortedResult, finishTime);
    assert.equal(phase3, "failed");                        // preserved
    assert.equal(job.callStates[3].phase, "failed");       // preserved
  } finally {
    cleanup();
  }
});
