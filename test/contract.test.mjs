import test from "node:test";
import assert from "node:assert/strict";
import {
  CALL_FIELDS,
  formatAvailableSubagentsPrompt,
  formatSubagentCloseToolDescription,
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

test("background contract tells parent to use subagent_status as fleet overview", () => {
  const prompt = makePrompt();
  assert.match(prompt, /Fleet view is your primary state source/);
  assert.ok(prompt.includes("needs_input") && prompt.includes("failed") && prompt.includes("running") && prompt.includes("completed"), "lists status groups");
  assert.match(prompt, /grouped by attention priority/);
});

test("background contract tells parent to use subagent_result only for details", () => {
  const prompt = makePrompt();
  assert.ok(prompt.includes("Use `subagent_result` only when you need details"));
  assert.match(prompt, /Never dump/);
  assert.match(prompt, /not as a report to relay/);
});

test("background contract discourages quoting completion notification content", () => {
  const prompt = makePrompt();
  assert.match(prompt, /Do not quote or summarize/);
  assert.match(prompt, /signal to inspect/);
});

test("background contract has a cardinal rule about never dumping verbatim output", () => {
  const prompt = makePrompt();
  assert.match(prompt, /Cardinal rule: never dump verbatim subagent output/);
  assert.match(prompt, /concise summary in your own words/);
  assert.match(prompt, /\*\*Bad:\*\*/);
  assert.match(prompt, /\*\*Good:\*\*/);
});

test("background contract warns parent not to re-display escalation content", () => {
  const prompt = makePrompt();
  assert.match(prompt, /already shows the subagent's output to the user/);
  assert.match(prompt, /re-display or re-summarise/);
  assert.match(prompt, /Longer quotes waste context/);
});

test("background contract prioritizes needs_input and failed jobs", () => {
  const prompt = makePrompt();
  assert.ok(prompt.includes("Prioritize `needs_input` and `failed`"));
  assert.match(prompt, /they need your attention first/);
});

test("subagent_close tool description is present and explains close vs continue", () => {
  const desc = formatSubagentCloseToolDescription();

  assert.match(desc, /Close a background subagent job/);
  assert.match(desc, /does \*\*not\*\* wake the child/);
  assert.match(desc, /subagent_cancel/);
  assert.match(desc, /escalationId/);
  assert.match(desc, /confirm: true/);
});

test("background contract tells parent to use subagent_close instead of continue for goodbye", () => {
  const prompt = makePrompt();

  assert.match(prompt, /Use \`subagent_close\` when no further action is needed/);
  assert.match(prompt, /do \*\*not\*\* use \`subagent_continue\` to say goodbye/);
  assert.match(prompt, /would wake the[^]*child agent/);
  assert.match(prompt, /marks the job as completed without resuming the child/);
});
