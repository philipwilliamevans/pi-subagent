/**
 * Tests for background-job-store.ts — durable persistence of background jobs.
 *
 * Each test uses an isolated temporary directory so that persisted state
 * from one test does not leak into another.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

let storeModule;
let typesModule;

test.before(async () => {
  const base = process.cwd();
  storeModule = await import(
    pathToFileURL(path.join(base, "background-job-store.ts")).href
  );
  typesModule = await import(
    pathToFileURL(path.join(base, "types.ts")).href
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-store-test-"));
}

function makeMinimalJob(id, status = "completed", overrides = {}) {
  return {
    id,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now(),
    status,
    onComplete: "trigger",
    calls: [
      {
        index: 0,
        agent: "test-agent",
        prompt: "Test prompt",
        effectiveCwd: "/tmp",
        initialContext: "empty",
      },
    ],
    callStates: [{ phase: "completed", toolCalls: 0, recentActivity: [] }],
    results: [
      {
        callIndex: 0,
        agent: "test-agent",
        agentSource: "user",
        prompt: "Test prompt",
        initialContext: "empty",
        exitCode: 0,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
            timestamp: 1000,
          },
        ],
        stderr: "",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 1,
        },
      },
    ],
    promise: Promise.resolve(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ensureJobsDir
// ---------------------------------------------------------------------------

test("ensureJobsDir creates the .pi-subagent/jobs directory tree", () => {
  const baseDir = createTempBase();
  try {
    const dir = storeModule.ensureJobsDir(baseDir);
    assert.ok(fs.existsSync(dir));
    assert.match(dir, /\.pi-subagent\/jobs$/);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("ensureJobsDir is idempotent", () => {
  const baseDir = createTempBase();
  try {
    const dir1 = storeModule.ensureJobsDir(baseDir);
    const dir2 = storeModule.ensureJobsDir(baseDir);
    assert.equal(dir1, dir2);
    assert.ok(fs.existsSync(dir2));
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// persistJobState
// ---------------------------------------------------------------------------

test("persistJobState writes state.json atomically", () => {
  const baseDir = createTempBase();
  try {
    const job = makeMinimalJob("subjob_atomic_001");
    storeModule.persistJobState(baseDir, job);

    const statePath = path.join(
      baseDir,
      ".pi-subagent",
      "jobs",
      "subjob_atomic_001",
      "state.json",
    );
    assert.ok(fs.existsSync(statePath));

    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.jobId, "subjob_atomic_001");
    assert.equal(raw.status, "completed");
    assert.equal(raw.calls.length, 1);
    assert.equal(raw.results.length, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("persistJobState round-trips needs_input metadata", () => {
  const baseDir = createTempBase();
  try {
    const escalation = {
      id: "esc_wait123",
      callIndex: 0,
      kind: "freeform",
      question: "Which area should I inspect?",
      marker: "AWAITING_CHOICE",
      status: "open",
      createdAt: 12300,
      updatedAt: 12345,
    };
    const job = makeMinimalJob("subjob_waiting_001", "needs_input", {
      callStates: [{ phase: "needs_input", toolCalls: 0, recentActivity: [], completedAt: 12345 }],
      awaitMarker: "AWAITING_CHOICE",
      interactive: true,
      waitingForInput: escalation,
    });

    storeModule.persistJobState(baseDir, job);
    const loaded = storeModule.loadPersistedJob(baseDir, "subjob_waiting_001");

    assert.ok(loaded);
    assert.equal(loaded.status, "needs_input");
    assert.equal(loaded.awaitMarker, "AWAITING_CHOICE");
    assert.equal(loaded.interactive, true);
    assert.deepEqual(loaded.waitingForInput, escalation);
    assert.equal(loaded.callStates[0].phase, "needs_input");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("persistJobState round-trips dismissed escalation metadata", () => {
  const baseDir = createTempBase();
  try {
    const dismissed = {
      id: "esc_dismissed_store",
      callIndex: 0,
      kind: "freeform",
      question: "Should I continue inspecting?",
      marker: "AWAITING_CHOICE",
      status: "dismissed",
      createdAt: 10000,
      updatedAt: 12000,
      closedAt: 12000,
      closeReason: "User ended the session.",
    };
    const job = makeMinimalJob("subjob_dismissed_001", "completed", {
      callStates: [{ phase: "completed", toolCalls: 0, recentActivity: [], completedAt: 12000 }],
      awaitMarker: "AWAITING_CHOICE",
      escalations: [dismissed],
    });

    storeModule.persistJobState(baseDir, job);
    const loaded = storeModule.loadPersistedJob(baseDir, "subjob_dismissed_001");

    assert.ok(loaded);
    assert.ok(loaded.escalations);
    assert.equal(loaded.escalations.length, 1);
    const loadedEsc = loaded.escalations[0];
    assert.equal(loadedEsc.id, "esc_dismissed_store");
    assert.equal(loadedEsc.status, "dismissed");
    assert.equal(loadedEsc.closedAt, 12000);
    assert.equal(loadedEsc.closeReason, "User ended the session.");
    assert.equal(loadedEsc.question, "Should I continue inspecting?");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("persistJobState round-trips escalation history", () => {
  const baseDir = createTempBase();
  try {
    const answered = {
      id: "esc_answered",
      callIndex: 0,
      kind: "freeform",
      question: "Which area should I inspect?",
      marker: "AWAITING_CHOICE",
      status: "answered",
      answer: "Runner",
      createdAt: 10000,
      answeredAt: 11000,
      updatedAt: 11000,
    };
    const waiting = {
      id: "esc_waiting2",
      callIndex: 0,
      kind: "freeform",
      question: "Should I inspect tests next?",
      marker: "AWAITING_CHOICE",
      status: "open",
      createdAt: 12000,
      updatedAt: 12000,
    };
    const job = makeMinimalJob("subjob_history_001", "needs_input", {
      callStates: [{ phase: "needs_input", toolCalls: 0, recentActivity: [], completedAt: 12000 }],
      awaitMarker: "AWAITING_CHOICE",
      escalations: [answered, waiting],
      waitingForInput: waiting,
    });

    storeModule.persistJobState(baseDir, job);
    const loaded = storeModule.loadPersistedJob(baseDir, "subjob_history_001");

    assert.ok(loaded);
    assert.deepEqual(loaded.waitingForInput, waiting);
    assert.deepEqual(loaded.escalations, [answered, waiting]);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadPersistedJob hydrates legacy needs_input metadata", () => {
  const baseDir = createTempBase();
  try {
    const job = makeMinimalJob("subjob_legacy_waiting_001", "needs_input", {
      callStates: [{ phase: "needs_input", toolCalls: 0, recentActivity: [], completedAt: 12345 }],
      awaitMarker: "AWAITING_CHOICE",
      waitingForInput: { callIndex: 0, marker: "AWAITING_CHOICE", updatedAt: 12345 },
      results: [
        {
          callIndex: 0,
          agent: "test-agent",
          agentSource: "user",
          prompt: "Test prompt",
          initialContext: "empty",
          exitCode: 0,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Which area should I inspect?\nAWAITING_CHOICE" }],
              timestamp: 1000,
            },
          ],
          stderr: "",
          usage: typesModule.emptyUsage(),
        },
      ],
    });

    storeModule.persistJobState(baseDir, job);
    const loaded = storeModule.loadPersistedJob(baseDir, "subjob_legacy_waiting_001");
    const loadedAgain = storeModule.loadPersistedJob(baseDir, "subjob_legacy_waiting_001");

    assert.ok(loaded);
    assert.match(loaded.waitingForInput.id, /^esc_[0-9a-f]{8}$/);
    assert.equal(loadedAgain.waitingForInput.id, loaded.waitingForInput.id);
    assert.equal(loaded.waitingForInput.kind, "freeform");
    assert.equal(loaded.waitingForInput.status, "open");
    assert.equal(loaded.waitingForInput.question, "Which area should I inspect?");
    assert.equal(loaded.waitingForInput.marker, "AWAITING_CHOICE");
    assert.equal(loaded.waitingForInput.createdAt, 12345);
    assert.equal(loaded.waitingForInput.updatedAt, 12345);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("persistJobState updates existing state", () => {
  const baseDir = createTempBase();
  try {
    const job = makeMinimalJob("subjob_update_001");
    storeModule.persistJobState(baseDir, job);

    // Update the job
    job.status = "failed";
    job.error = "Something went wrong";
    storeModule.persistJobState(baseDir, job);

    const statePath = path.join(
      baseDir,
      ".pi-subagent",
      "jobs",
      "subjob_update_001",
      "state.json",
    );
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(raw.status, "failed");
    assert.equal(raw.error, "Something went wrong");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// event journal helpers
// ---------------------------------------------------------------------------

test("appendJobEventLine creates a per-call event journal", () => {
  const baseDir = createTempBase();
  try {
    storeModule.appendJobEventLine(
      baseDir,
      "subjob_events_001",
      0,
      JSON.stringify({ type: "turn_start" }),
    );

    const eventPath = path.join(
      baseDir,
      ".pi-subagent",
      "jobs",
      "subjob_events_001",
      "calls",
      "0",
      "events.jsonl",
    );
    assert.ok(fs.existsSync(eventPath));
    assert.equal(
      fs.readFileSync(eventPath, "utf-8"),
      `${JSON.stringify({ type: "turn_start" })}\n`,
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("tailJobEventLines returns the latest bounded event lines", () => {
  const baseDir = createTempBase();
  try {
    for (let i = 0; i < 5; i++) {
      storeModule.appendJobEventLine(
        baseDir,
        "subjob_events_002",
        1,
        JSON.stringify({ type: "event", index: i }),
      );
    }

    const lines = storeModule.tailJobEventLines(
      baseDir,
      "subjob_events_002",
      1,
      2,
    );
    assert.deepEqual(lines.map((line) => JSON.parse(line).index), [3, 4]);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("tailJobEventLines returns empty for missing event journal", () => {
  const baseDir = createTempBase();
  try {
    assert.deepEqual(
      storeModule.tailJobEventLines(baseDir, "subjob_missing_events", 0, 20),
      [],
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadPersistedJob
// ---------------------------------------------------------------------------

test("loadPersistedJob returns a hydrated BackgroundJob", () => {
  const baseDir = createTempBase();
  try {
    const job = makeMinimalJob("subjob_load_001");
    storeModule.persistJobState(baseDir, job);

    const loaded = storeModule.loadPersistedJob(baseDir, "subjob_load_001");
    assert.ok(loaded);
    assert.equal(loaded.id, "subjob_load_001");
    assert.equal(loaded.status, "completed");
    assert.equal(loaded.calls.length, 1);
    assert.equal(loaded.results.length, 1);
    assert.equal(loaded.results[0].exitCode, 0);
    // Unserializable fields should have safe defaults
    assert.ok(typeof loaded.promise?.then === "function");
    assert.equal(loaded.abortController, undefined);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadPersistedJob returns undefined for missing job", () => {
  const baseDir = createTempBase();
  try {
    assert.equal(
      storeModule.loadPersistedJob(baseDir, "subjob_nonexistent"),
      undefined,
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadPersistedJob returns undefined for corrupted state.json", () => {
  const baseDir = createTempBase();
  try {
    const jobDir = path.join(baseDir, ".pi-subagent", "jobs", "subjob_corrupt");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "state.json"), "not valid json", "utf-8");

    assert.equal(
      storeModule.loadPersistedJob(baseDir, "subjob_corrupt"),
      undefined,
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadPersistedJobs — terminal states
// ---------------------------------------------------------------------------

test("loadPersistedJobs loads completed jobs from disk", () => {
  const baseDir = createTempBase();
  try {
    storeModule.persistJobState(
      baseDir,
      makeMinimalJob("subjob_completed_001"),
    );
    storeModule.persistJobState(
      baseDir,
      makeMinimalJob("subjob_failed_002", "failed"),
    );
    storeModule.persistJobState(
      baseDir,
      makeMinimalJob("subjob_cancelled_003", "cancelled"),
    );

    const jobs = storeModule.loadPersistedJobs(baseDir);
    assert.equal(jobs.length, 3);

    const ids = jobs.map((j) => j.id).sort();
    assert.deepEqual(ids, [
      "subjob_cancelled_003",
      "subjob_completed_001",
      "subjob_failed_002",
    ]);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Interrupted jobs (active on restart)
// ---------------------------------------------------------------------------

test("loadPersistedJobs upgrades running jobs to interrupted", () => {
  const baseDir = createTempBase();
  try {
    const running = makeMinimalJob("subjob_running_001", "running", {
      results: undefined,
      callStates: [{ phase: "running", toolCalls: 2, recentActivity: [] }],
    });
    storeModule.persistJobState(baseDir, running);

    const jobs = storeModule.loadPersistedJobs(baseDir);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, "subjob_running_001");
    assert.equal(jobs[0].status, "interrupted");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadPersistedJobs upgrades ambiguous cancelling jobs to interrupted", () => {
  const baseDir = createTempBase();
  try {
    const cancelling = makeMinimalJob("subjob_cancelling_001", "cancelling", {
      results: undefined,
      callStates: [{ phase: "running", toolCalls: 1, recentActivity: [] }],
    });
    storeModule.persistJobState(baseDir, cancelling);

    const jobs = storeModule.loadPersistedJobs(baseDir);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, "subjob_cancelling_001");
    assert.equal(jobs[0].status, "interrupted");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadPersistedJobs reloads confirmed cancelling jobs as cancelled", () => {
  const baseDir = createTempBase();
  try {
    const cancelling = makeMinimalJob("subjob_cancelling_cancelled_001", "cancelling", {
      results: undefined,
      callStates: [
        { phase: "cancelled", toolCalls: 1, recentActivity: [], completedAt: 12345 },
        { phase: "completed", toolCalls: 2, recentActivity: [], completedAt: 12000 },
      ],
    });
    storeModule.persistJobState(baseDir, cancelling);

    const jobs = storeModule.loadPersistedJobs(baseDir);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, "subjob_cancelling_cancelled_001");
    assert.equal(jobs[0].status, "cancelled");
    assert.equal(jobs[0].callStates[0].phase, "cancelled");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadPersistedJobs — empty / missing directory
// ---------------------------------------------------------------------------

test("loadPersistedJobs returns empty array when no jobs directory exists", () => {
  const baseDir = createTempBase();
  try {
    const jobs = storeModule.loadPersistedJobs(baseDir);
    assert.deepEqual(jobs, []);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadPersistedJobs returns empty array when jobs directory is empty", () => {
  const baseDir = createTempBase();
  try {
    storeModule.ensureJobsDir(baseDir);
    const jobs = storeModule.loadPersistedJobs(baseDir);
    assert.deepEqual(jobs, []);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// persistJobResult
// ---------------------------------------------------------------------------

test("persistJobResult writes result.md", () => {
  const baseDir = createTempBase();
  try {
    storeModule.persistJobState(
      baseDir,
      makeMinimalJob("subjob_result_001"),
    );
    storeModule.persistJobResult(
      baseDir,
      "subjob_result_001",
      "## explorer — completed\n\nFull analysis.",
    );

    const resultPath = path.join(
      baseDir,
      ".pi-subagent",
      "jobs",
      "subjob_result_001",
      "result.md",
    );
    assert.ok(fs.existsSync(resultPath));
    const content = fs.readFileSync(resultPath, "utf-8");
    assert.match(content, /Full analysis/);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// removePersistedJob
// ---------------------------------------------------------------------------

test("removePersistedJob deletes the job directory", () => {
  const baseDir = createTempBase();
  try {
    storeModule.persistJobState(
      baseDir,
      makeMinimalJob("subjob_remove_001"),
    );

    const jobDir = path.join(baseDir, ".pi-subagent", "jobs", "subjob_remove_001");
    assert.ok(fs.existsSync(jobDir));

    storeModule.removePersistedJob(baseDir, "subjob_remove_001");
    assert.ok(!fs.existsSync(jobDir));
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("removePersistedJob does not throw for nonexistent job", () => {
  const baseDir = createTempBase();
  try {
    // Should not throw
    storeModule.removePersistedJob(baseDir, "subjob_ghost");
    assert.ok(true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// listPersistedJobIds
// ---------------------------------------------------------------------------

test("listPersistedJobIds returns job IDs sorted by creation order", () => {
  const baseDir = createTempBase();
  try {
    storeModule.persistJobState(
      baseDir,
      makeMinimalJob("subjob_list_001"),
    );
    storeModule.persistJobState(
      baseDir,
      makeMinimalJob("subjob_list_002"),
    );

    const ids = storeModule.listPersistedJobIds(baseDir).sort();
    assert.deepEqual(ids, ["subjob_list_001", "subjob_list_002"]);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("listPersistedJobIds returns empty when no jobs directory", () => {
  const baseDir = createTempBase();
  try {
    assert.deepEqual(storeModule.listPersistedJobIds(baseDir), []);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// No unserializable fields leak into persisted state
// ---------------------------------------------------------------------------

test("persisted state.json excludes promise, abortController", () => {
  const baseDir = createTempBase();
  try {
    const job = makeMinimalJob("subjob_no_leak_001");
    // These are set on the live object but should not be serialized
    job.promise = "should not appear";
    job.abortController = "should not appear";

    storeModule.persistJobState(baseDir, job);

    const statePath = path.join(
      baseDir,
      ".pi-subagent",
      "jobs",
      "subjob_no_leak_001",
      "state.json",
    );
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(raw.promise, undefined);
    assert.equal(raw.abortController, undefined);
    assert.equal(raw.jobId, "subjob_no_leak_001");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Artifact persistence round-trip
// ---------------------------------------------------------------------------

test("persistJobState round-trips artifacts", () => {
  const baseDir = createTempBase();
  try {
    const artifacts = [
      {
        id: "subjob_art_001-result",
        kind: "result",
        label: "result",
        value: "1/1 calls",
        createdAt: Date.now(),
      },
      {
        id: "subjob_art_001-patch",
        kind: "patch",
        label: "patch",
        path: ".pi-subagent/jobs/subjob_art_001/worktree.patch",
        createdAt: Date.now(),
      },
      {
        id: "subjob_art_001-changed_files",
        kind: "changed_files",
        label: "changed files",
        count: 3,
        createdAt: Date.now(),
      },
    ];
    const job = makeMinimalJob("subjob_art_001", "completed", { artifacts });
    storeModule.persistJobState(baseDir, job);

    const loaded = storeModule.loadPersistedJob(baseDir, "subjob_art_001");
    assert.ok(loaded);
    assert.ok(loaded.artifacts, "artifacts field present after round-trip");
    assert.equal(loaded.artifacts.length, 3);
    assert.equal(loaded.artifacts[0].kind, "result");
    assert.equal(loaded.artifacts[1].kind, "patch");
    assert.equal(loaded.artifacts[2].kind, "changed_files");
    assert.equal(loaded.artifacts[2].count, 3);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("persistJobState legacy job without artifacts still loads correctly", () => {
  const baseDir = createTempBase();
  try {
    // A job stored without the artifacts field
    const job = makeMinimalJob("subjob_legacy_no_art", "completed");
    storeModule.persistJobState(baseDir, job);

    const loaded = storeModule.loadPersistedJob(baseDir, "subjob_legacy_no_art");
    assert.ok(loaded);
    assert.equal(loaded.artifacts, undefined, "legacy job has no artifacts field");
    // Core fields still present
    assert.equal(loaded.status, "completed");
    assert.equal(loaded.results.length, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
