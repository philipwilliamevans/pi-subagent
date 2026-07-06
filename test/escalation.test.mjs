import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const types = await import(pathToFileURL(path.join(process.cwd(), "types.ts")).href);

test("stripAwaitMarker removes only a final marker line", () => {
  assert.equal(
    types.stripAwaitMarker("Which direction should I inspect?\nAWAITING_SUBAGENT_INPUT", "AWAITING_SUBAGENT_INPUT"),
    "Which direction should I inspect?",
  );
  assert.equal(
    types.stripAwaitMarker("Mention AWAITING_SUBAGENT_INPUT in the body.\nDone", "AWAITING_SUBAGENT_INPUT"),
    "Mention AWAITING_SUBAGENT_INPUT in the body.\nDone",
  );
  assert.equal(
    types.stripAwaitMarker("Question?\n  AWAITING.SUBAGENT+INPUT  \n", "AWAITING.SUBAGENT+INPUT"),
    "Question?",
  );
});

test("createBackgroundEscalation records a marker-free question", () => {
  const result = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Choose a path:\n1. Tests\n2. Docs\nAWAITING_CHOICE" }],
        timestamp: 1,
      },
    ],
  };

  const escalation = types.createBackgroundEscalation(result, 0, "AWAITING_CHOICE", 1234);

  assert.match(escalation.id, /^esc_[0-9a-f]{8}$/);
  assert.equal(escalation.callIndex, 0);
  assert.equal(escalation.kind, "freeform");
  assert.equal(escalation.question, "Choose a path:\n1. Tests\n2. Docs");
  assert.equal(escalation.marker, "AWAITING_CHOICE");
  assert.equal(escalation.status, "open");
  assert.equal(escalation.createdAt, 1234);
  assert.equal(escalation.updatedAt, 1234);
});

test("recordBackgroundEscalationAnswer preserves identity and stores the answer", () => {
  const escalation = {
    id: "esc_answer1",
    callIndex: 0,
    kind: "freeform",
    question: "Which path?",
    marker: "AWAITING_CHOICE",
    status: "open",
    createdAt: 100,
    updatedAt: 100,
  };

  const answered = types.recordBackgroundEscalationAnswer(escalation, "Take option 2", 200);

  assert.equal(answered.id, "esc_answer1");
  assert.equal(answered.question, "Which path?");
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "Take option 2");
  assert.equal(answered.answeredAt, 200);
  assert.equal(answered.updatedAt, 200);
  assert.equal(answered.createdAt, 100);
});

test("upsertBackgroundEscalation appends and updates escalation history", () => {
  const first = {
    id: "esc_first1",
    callIndex: 0,
    kind: "freeform",
    question: "Which path?",
    marker: "AWAITING_CHOICE",
    status: "open",
    createdAt: 100,
    updatedAt: 100,
  };
  const second = {
    id: "esc_second",
    callIndex: 0,
    kind: "freeform",
    question: "Anything else?",
    marker: "AWAITING_CHOICE",
    status: "open",
    createdAt: 300,
    updatedAt: 300,
  };

  const answered = types.recordBackgroundEscalationAnswer(first, "Take option 2", 200);
  const withFirst = types.upsertBackgroundEscalation(undefined, first);
  const withAnswered = types.upsertBackgroundEscalation(withFirst, answered);
  const withSecond = types.upsertBackgroundEscalation(withAnswered, second);

  assert.equal(withSecond.length, 2);
  assert.deepEqual(withSecond[0], answered);
  assert.deepEqual(withSecond[1], second);
});

test("formatSubagentContinueAcknowledgement is concise and parent-facing", () => {
  const text = types.formatSubagentContinueAcknowledgement("explorer");

  assert.equal(
    text,
    "Sent that direction to the waiting explorer subagent.\n\nThe subagent will continue in the same session. I will report back when it finishes or asks another question.",
  );
  assert.doesNotMatch(text, /job|call|marker|subagent_continue/i);
});

test("dismissBackgroundEscalation marks escalation as dismissed with default reason", () => {
  const escalation = {
    id: "esc_close1",
    callIndex: 0,
    kind: "freeform",
    question: "Which path?",
    marker: "AWAITING_SUBAGENT_INPUT",
    status: "open",
    createdAt: 100,
    updatedAt: 100,
  };

  const dismissed = types.dismissBackgroundEscalation(escalation, undefined, 200);

  assert.equal(dismissed.id, "esc_close1");
  assert.equal(dismissed.question, "Which path?");
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.closeReason, "Closed by parent: no further action requested.");
  assert.equal(dismissed.closedAt, 200);
  assert.equal(dismissed.updatedAt, 200);
  assert.equal(dismissed.createdAt, 100);
  assert.equal(dismissed.answeredAt, undefined);
  assert.equal(dismissed.answer, undefined);
});

test("dismissBackgroundEscalation accepts custom reason", () => {
  const escalation = {
    id: "esc_close2",
    callIndex: 1,
    kind: "freeform",
    question: "Proceed?",
    marker: "AWAITING_CHOICE",
    status: "open",
    createdAt: 300,
    updatedAt: 300,
  };

  const dismissed = types.dismissBackgroundEscalation(escalation, "User ended the session.", 500);

  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.closeReason, "User ended the session.");
  assert.equal(dismissed.closedAt, 500);
  assert.equal(dismissed.updatedAt, 500);
});

test("BackgroundEscalation accepts dismissed status and closeReason", () => {
  // Verify the new fields are usable at runtime
  const escalation = {
    id: "esc_dismissed_type",
    callIndex: 0,
    kind: "freeform",
    question: "Done?",
    marker: "AWAITING_INPUT",
    status: "dismissed",
    createdAt: 100,
    updatedAt: 200,
    closedAt: 200,
    closeReason: "Closed by parent.",
  };
  assert.equal(escalation.status, "dismissed");
  assert.equal(escalation.closeReason, "Closed by parent.");
  assert.equal(escalation.closedAt, 200);
});

test("formatBackgroundEscalationDetails returns hidden routing metadata", () => {
  const details = types.formatBackgroundEscalationDetails({
    id: "subjob_waiting",
    calls: [{ index: 0, agent: "explorer", prompt: "Offer options", effectiveCwd: "/tmp", initialContext: "empty" }],
    waitingForInput: {
      id: "esc_waiting",
      callIndex: 0,
      kind: "freeform",
      question: "Which path?",
      marker: "AWAITING_SUBAGENT_INPUT",
      status: "open",
      createdAt: 100,
      updatedAt: 100,
    },
  });

  assert.deepEqual(details, {
    type: "subagent_escalation",
    jobId: "subjob_waiting",
    escalationId: "esc_waiting",
    callIndex: 0,
    agent: "explorer",
    status: "needs_input",
  });
});
