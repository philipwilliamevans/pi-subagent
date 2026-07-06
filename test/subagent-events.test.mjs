import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSubagentLifecyclePayload,
  emitSubagentLifecycleEvent,
} from "../subagent-events.ts";

function makeJob(overrides = {}) {
  return {
    id: "subjob_test1234",
    createdAt: 1000,
    updatedAt: 2000,
    status: "running",
    calls: [
      {
        index: 0,
        agent: "explore",
        prompt: "Inspect the code",
        effectiveCwd: "/repo",
        initialContext: "empty",
      },
    ],
    promise: Promise.resolve(),
    onComplete: "trigger",
    callStates: [{ phase: "running", toolCalls: 0, recentActivity: [] }],
    worktreeMode: "isolated",
    worktreeMetadata: {
      path: "/repo/.pi-worktrees/project/subjob_test1234",
      branch: "codex/subjob_test1234",
      baseCommit: "abc123",
    },
    ...overrides,
  };
}

function makeEscalation(overrides = {}) {
  return {
    id: "esc_test1234",
    callIndex: 0,
    kind: "freeform",
    question: "Which direction should I take?",
    marker: "AWAITING_SUBAGENT_INPUT",
    status: "open",
    createdAt: 1500,
    updatedAt: 1500,
    ...overrides,
  };
}

test("buildSubagentLifecyclePayload includes stable common fields and worktree metadata", () => {
  const job = makeJob({ status: "completed" });

  assert.deepEqual(buildSubagentLifecyclePayload(job), {
    version: 1,
    source: "pi-subagent",
    jobId: "subjob_test1234",
    status: "completed",
    createdAt: 1000,
    updatedAt: 2000,
    worktreeMode: "isolated",
    worktreeMetadata: {
      path: "/repo/.pi-worktrees/project/subjob_test1234",
      branch: "codex/subjob_test1234",
      baseCommit: "abc123",
    },
  });
});

test("buildSubagentLifecyclePayload includes escalation question and continuation answer", () => {
  const job = makeJob();
  const escalation = makeEscalation();
  const payload = buildSubagentLifecyclePayload(job, {
    escalation,
    answer: "Use option B",
  });

  assert.equal(payload.callIndex, 0);
  assert.equal(payload.agent, "explore");
  assert.equal(payload.escalationId, "esc_test1234");
  assert.equal(payload.question, "Which direction should I take?");
  assert.equal(payload.kind, "freeform");
  assert.equal(payload.answer, "Use option B");
});

test("emitSubagentLifecycleEvent emits the namespaced event and payload", () => {
  const calls = [];
  const pi = {
    events: {
      emit(name, payload) {
        calls.push({ name, payload });
      },
    },
  };
  const job = makeJob();
  const escalation = makeEscalation();

  emitSubagentLifecycleEvent(pi, "pi-subagent:escalated", job, { escalation });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "pi-subagent:escalated");
  assert.equal(calls[0].payload.version, 1);
  assert.equal(calls[0].payload.source, "pi-subagent");
  assert.equal(calls[0].payload.jobId, "subjob_test1234");
  assert.equal(calls[0].payload.escalationId, "esc_test1234");
});

test("emitSubagentLifecycleEvent supports the full phase 6 event set", () => {
  const names = [
    "pi-subagent:started",
    "pi-subagent:escalated",
    "pi-subagent:continued",
    "pi-subagent:completed",
    "pi-subagent:failed",
    "pi-subagent:cancelled",
  ];
  const emitted = [];
  const pi = { events: { emit: (name) => emitted.push(name) } };
  const job = makeJob();

  for (const name of names) {
    emitSubagentLifecycleEvent(pi, name, job);
  }

  assert.deepEqual(emitted, names);
});

test("emitSubagentLifecycleEvent is best effort", () => {
  const job = makeJob();

  assert.doesNotThrow(() => {
    emitSubagentLifecycleEvent({}, "pi-subagent:started", job);
  });
  assert.doesNotThrow(() => {
    emitSubagentLifecycleEvent(
      {
        events: {
          emit() {
            throw new Error("listener failed");
          },
        },
      },
      "pi-subagent:started",
      job,
    );
  });
});
