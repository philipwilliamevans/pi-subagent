import test from "node:test";
import assert from "node:assert/strict";
import {
  CALL_FIELDS,
  formatAvailableSubagentsPrompt,
  formatSubagentStartToolDescription,
  formatSubagentToolDescription,
  getCallFieldSchemaDescription,
} from "../contract.ts";
import {
  DEFAULT_INTERACTIVE_AWAIT_MARKER,
  appendInteractiveWaitInstructions,
} from "../types.ts";

const agents = [
  {
    name: "review",
    description: "Review code changes",
    source: "user",
    filePath: "/tmp/review.md",
    systemPrompt: "You review code.",
    sessionPreference: "ephemeral",
  },
  {
    name: "repo-helper",
    description: "Repository helper",
    source: "project",
    filePath: "/repo/.pi/agents/repo-helper.md",
    systemPrompt: "You help in this repo.",
    sessionHint: "Use only for repository-local questions.",
  },
];

function makePrompt() {
  return formatAvailableSubagentsPrompt(agents, {
    currentDepth: 1,
    maxDepth: 3,
    preventCycles: true,
    ancestorAgentStack: ["review"],
  });
}

test("schema and generated prompt use the shared call field contract", () => {
  const prompt = makePrompt();
  const toolDescription = formatSubagentToolDescription();

  for (const field of CALL_FIELDS) {
    assert.equal(getCallFieldSchemaDescription(field.name), field.schemaDescription);
    assert.match(prompt, new RegExp(`\\\`${field.name}\\\``));
    assert.match(toolDescription, new RegExp(`\\\`${field.name}\\\``));
  }
});

test("generated contract has no project-agent confirmation option", () => {
  const combined = `${makePrompt()}\n${formatSubagentToolDescription()}`;

  assert.doesNotMatch(combined, /confirmProjectAgents/);
  assert.doesNotMatch(combined, /project-local agent confirmation/i);
});

test("available subagent prompt labels agent source and guard state", () => {
  const prompt = makePrompt();

  assert.match(prompt, /\*\*review\*\* \(user\): Review code changes/);
  assert.match(prompt, /\*\*repo-helper\*\* \(project\): Repository helper/);
  assert.match(prompt, /Project agents come from this repository/);
  assert.match(prompt, /Max depth: current depth 1, max depth 3/);
  assert.match(prompt, /Current delegation stack: review/);
});

test("background contract prefers interactive mode over marker plumbing", () => {
  const combined = `${makePrompt()}\n${formatSubagentStartToolDescription()}`;

  assert.match(combined, /interactive: true/);
  assert.match(combined, /advanced\/debug override/i);
  assert.match(combined, /normal follow-up\s+question while routing metadata is attached/i);
  assert.match(combined, /exactly one unresolved subagent escalation/i);
  assert.match(combined, /pass the user's reply verbatim/i);
  assert.match(combined, /do not ask the user for a job ID/i);
});

test("appendInteractiveWaitInstructions adds default wait guidance", () => {
  const prompt = appendInteractiveWaitInstructions(
    "Inspect runner.ts and offer options.",
    DEFAULT_INTERACTIVE_AWAIT_MARKER,
  );

  assert.match(prompt, /^Inspect runner\.ts and offer options\./);
  assert.match(prompt, /Ask a concise question/);
  assert.match(prompt, new RegExp(`End your final line with exactly: ${DEFAULT_INTERACTIVE_AWAIT_MARKER}`));
});
