/**
 * Parent-facing subagent tool contract.
 *
 * This module owns the wording taught to the parent agent through the tool
 * schema, tool description, and injected system prompt. Keep API semantics here
 * so those surfaces do not drift independently.
 */

import type { AgentConfig } from "./agents.js";

export interface DelegationGuardSummary {
  currentDepth: number;
  maxDepth: number;
  preventCycles: boolean;
  ancestorAgentStack: string[];
}

interface CallFieldContract {
  name: "agent" | "prompt" | "model" | "cwd" | "initialContext" | "session";
  required: boolean;
  schemaDescription: string;
  promptDescription: string;
}

export const CALLS_SCHEMA_DESCRIPTION =
  "One or more subagent calls. A single call and multiple parallel calls use the same shape.";

export const CALL_FIELDS: CallFieldContract[] = [
  {
    name: "agent",
    required: true,
    schemaDescription: "Name of an available agent (must match exactly)",
    promptDescription: "exact available agent name",
  },
  {
    name: "prompt",
    required: true,
    schemaDescription: "Prompt sent verbatim to the subagent for this call",
    promptDescription: "non-empty prompt sent verbatim to the subagent",
  },
  {
    name: "model",
    required: false,
    schemaDescription: "Model to use for this call. Overrides the agent file's default model.",
    promptDescription: "model to use for this call. Overrides the agent file's default model. If omitted, the agent's default model is used when configured; otherwise Pi uses the inherited/default model",
  },
  {
    name: "cwd",
    required: false,
    schemaDescription: "Working directory for this subagent process",
    promptDescription: "working directory for this subagent process",
  },
  {
    name: "initialContext",
    required: false,
    schemaDescription:
      "Initial context for a newly-created child conversation: 'empty' (default) or 'parent'. Existing named sessions ignore this field.",
    promptDescription:
      '`"empty"` (default) starts without parent history; `"parent"` seeds a newly-created child conversation from the current parent session snapshot. Existing named sessions ignore this field',
  },
  {
    name: "session",
    required: false,
    schemaDescription:
      "Optional logical handle for a persistent subagent session. Scoped by parent session, effective cwd, and agent name.",
    promptDescription:
      "durable conversation handle. If present, the call continues or creates a persistent child Pi session. The handle is scoped by parent session, effective cwd, and agent name. The same handle used with different agents resolves to different sessions. Requires a persisted parent Pi session",
  },
];

export function getCallFieldSchemaDescription(name: CallFieldContract["name"]): string {
  const field = CALL_FIELDS.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`Unknown subagent call field: ${name}`);
  return field.schemaDescription;
}

function formatCallFieldList(): string {
  return CALL_FIELDS
    .map((field) => {
      const requirement = field.required ? "required" : "optional";
      return `- \`${field.name}\` — ${requirement}: ${field.promptDescription}.`;
    })
    .join("\n");
}

function formatDelegationRules(): string {
  return [
    "- Do not use the same resolved session in more than one concurrent call. Same handle + same agent + same cwd conflicts; same handle + different agent is allowed. If a stale session lock is reported, remove the lock directory only after confirming no subagent is still running.",
    "- Use `session` for multi-turn specialist work; omit it for one-off delegation, when the parent is running with `--no-session`, or from temporary parent-seeded subagent sessions.",
    "- Agent-specific session preference and hint lines are advisory only. The tool creates or continues a persistent session only when a call includes `session`.",
  ].join("\n");
}

export function formatSubagentUsageExample(): string {
  return `Use exactly one top-level \`calls\` array:\n\`\`\`json\n{\n  "calls": [\n    {\n      "agent": "agent-name",\n      "prompt": "Prompt sent verbatim to the subagent",\n      "model": "optional-model",\n      "initialContext": "empty",\n      "session": "optional-logical-handle"\n    }\n  ]\n}\n\`\`\``;
}

export function formatSubagentUsageErrorExample(): string {
  return `Use the current API shape:\n{\n  "calls": [\n    { "agent": "agent-name", "prompt": "Prompt sent verbatim to the subagent" }\n  ]\n}`;
}

function formatSessionPreference(preference: AgentConfig["sessionPreference"]): string {
  switch (preference) {
    case "persistent":
      return "Prefer topic-specific named persistent sessions when context should carry across related calls.";
    case "ephemeral":
      return "Prefer ephemeral calls unless the caller explicitly needs continuation.";
    case "either":
      return "Choose ephemeral or persistent sessions based on the task.";
    default:
      return "";
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatAgentForPrompt(agent: AgentConfig): string {
  const lines = [`- **${agent.name}** (${agent.source}): ${agent.description}`];
  if (agent.sessionPreference) {
    lines.push(
      `  Session preference: ${agent.sessionPreference} — ${formatSessionPreference(agent.sessionPreference)}`,
    );
  }
  if (agent.sessionHint) {
    lines.push(`  Session hint: ${oneLine(agent.sessionHint)}`);
  }
  return lines.join("\n");
}

export function formatAvailableSubagentsPrompt(
  agents: AgentConfig[],
  guards: DelegationGuardSummary,
): string {
  const agentList = agents.map((agent) => formatAgentForPrompt(agent)).join("\n");
  const stack = guards.ancestorAgentStack.length > 0
    ? guards.ancestorAgentStack.join(" -> ")
    : "(root)";

  return `\n\n## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

Agent source labels are informational. Project agents come from this repository and can override user agents with the same name.

### How to call the subagent tool

${formatSubagentUsageExample()}

Each call runs in an isolated \`pi\` process. Multiple calls may run concurrently.

Fields:
${formatCallFieldList()}

Rules:
${formatDelegationRules()}

### Background subagent jobs

Use the \`subagent_start\` tool to fire-and-forget work in the background.
The tool returns immediately; results arrive via an auto-injected message.
By default the completion auto-triggers a parent turn — just omit \`onComplete\`.

Check status anytime with \`subagent_status\` (omit \`jobId\` to list all).
Peek at live activity with \`subagent_peek\` when you need to see what a
running background subagent is currently doing.
Cancel a running job with \`subagent_cancel\` (requires \`confirm: true\`).

Retrieve the full output from a completed job using \`subagent_result\`.
The auto-injected message includes a compact excerpt; use \`subagent_result\`
when you need the complete response text.

For interactive background jobs, set top-level \`awaitMarker\` and instruct
the subagent to end with that exact marker when it needs user direction.
The job parks as \`needs_input\`; continue it with \`subagent_continue\`.

Background jobs do not support caller-supplied persistent sessions (\`session\`).
Omit \`session\` for background delegation. Jobs that use \`awaitMarker\`
create an internal job-owned child session for continuation.

**Important:** Background jobs run in the same working tree by default
and can edit files concurrently with the parent or sibling jobs. Always:
- Give each subagent a clearly disjoint scope of work.
- Use \`subagent_status\` to check running jobs before making changes.
- Use \`subagent_result\` to review full output before integrating.
- Note the job ID at start time for later queries.

### Runtime delegation guards

- Max depth: current depth ${guards.currentDepth}, max depth ${guards.maxDepth}
- Cycle prevention: ${guards.preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${stack}
`;
}

export function formatSubagentToolDescription(): string {
  return [
    "Delegate work to specialized subagents running in isolated pi processes.",
    "",
    "Use exactly one top-level `calls` array for both one and many invocations.",
    "Each call requires `agent` and `prompt`; `prompt` is sent verbatim.",
    "",
    "Fields:",
    formatCallFieldList(),
    "",
    "Rules:",
    formatDelegationRules(),
    "",
    "Multiple calls may run concurrently.",
    "",
    'Example: { calls: [{ agent: "review", prompt: "Review this diff", model: "anthropic/claude-sonnet-4", session: "api-review", initialContext: "parent" }] }',
  ].join("\n");
}

export function formatSubagentStartToolDescription(): string {
  return [
    "Start background subagent jobs. Like `subagent` but returns immediately.",
    "",
    "By default, completion auto-triggers a parent turn — just omit `onComplete`.",
    "",
    "Background jobs run in the same working tree and may edit files concurrently.",
    "Give each call a clearly disjoint scope.",
    "",
    "Each call in the `calls` array requires `agent` and `prompt`.",
    "",
    "Fields (per call):",
    formatCallFieldList(),
    "",
    "Optional top-level field `onComplete` (default: \"trigger\"):",
    '  - `"trigger"` — inject a completion message and trigger a parent turn (default).',
    '  - `"message"` — inject a completion message without triggering a turn.',
    '  - `"silent"` — record in memory only; no message injected.',
    "",
    "Optional top-level field `worktreeMode` (default: \"shared\"):",
    '  - `"shared"` — run in the parent\'s working tree (default).',
    '  - `"isolated"` — run in a separate git worktree with its own branch.',
    "    Requires a clean git working tree. The job's changes are isolated",
    "    and do not automatically merge back.",
    "  - This is a top-level field on the tool call, not a field inside each call.",
    "",
    "Optional top-level field `worktreeScope`:",
    '  - A string describing the file/path scope of the job, e.g. "src/*.ts" or "docs/".',
    "    Helps identify potential conflicts between concurrent background jobs.",
    "  - This is also top-level, not per-call.",
    "",
    "Optional top-level field `awaitMarker`:",
    '  - A non-empty string such as "AWAITING_CHOICE".',
    "  - When a successful single-call job's final output contains this marker,",
    "    the job parks as `needs_input` instead of completing.",
    "  - Continue the same child session with `subagent_continue`.",
    "",
    "Restrictions:",
    "- Only available from the root parent Pi session (not from subagents).",
    "- Caller-supplied persistent sessions (`session`) are not supported in background mode.",
    "- `awaitMarker` is currently single-call only.",
    `- Maximum ${2} concurrent background jobs.`,
    "- `initialContext: \"parent\"` is not yet supported.",
    "",
    "Shared-worktree safety:",
    "  - Use \`subagent_status\` to check running jobs before making parent edits.",
    "  - Use \`subagent_result\` to review full output before integrating changes.",
    "  - The job ID is shown at start — note it for later queries.",
    "  - When isolated mode is available, set `worktreeMode: \"isolated\"` to run each job in a separate git worktree.",
    "",
    "Example (onComplete defaults to trigger, so you can omit it):",
    '  { "calls": [{ "agent": "explorer", "prompt": "Find all test files" }] }',
  ].join("\n");
}

export function formatSubagentStatusToolDescription(): string {
  return [
    "Query the status of a background subagent job.",
    "",
    "Provide a `jobId` to inspect a specific job. Omit `jobId` to list all known jobs.",
    "Read-only. No confirmation needed.",
    "",
    "Examples:",
    '  { "jobId": "subjob_abc123" }',
    '  {}',
  ].join("\n");
}

export function formatSubagentPeekToolDescription(): string {
  return [
    "Peek at recent live activity from a background subagent job.",
    "",
    "Reads the raw child Pi event journal captured for each background call.",
    "Use this while a job is running to inspect current assistant text, tool activity, and recent event types.",
    "",
    "Provide `jobId` to inspect a job. Optionally provide `callIndex` for one call.",
    "Use `maxEvents` to control the event tail size (default 20, max 200).",
    "Set `includeRawEvents` to true only when you need the raw JSON event tail.",
    "",
    "Examples:",
    '  { "jobId": "subjob_abc123" }',
    '  { "jobId": "subjob_abc123", "callIndex": 0, "maxEvents": 50 }',
    '  { "jobId": "subjob_abc123", "includeRawEvents": true }',
  ].join("\n");
}

export function formatSubagentResultToolDescription(): string {
  return [
    "Retrieve the full output from a completed or parked background subagent job.",
    "",
    "Use this tool when the auto-injected completion message excerpt",
    "was truncated or you need the complete response text from a",
    "finished subagent.",
    "",
    "By default returns only the final assistant text (tool calls excluded).",
    "Set includeToolCalls to true to see the full tool call trace.",
    "Use maxOutputLength to cap the response size.",
    "",
    "Examples:",
    '  { "jobId": "subjob_abc123" }',
    '  { "jobId": "subjob_abc123", "callIndex": 0 }',
    '  { "jobId": "subjob_abc123", "callIndex": 0, "includeToolCalls": true, "maxOutputLength": 8000 }',
  ].join("\n");
}

export function formatSubagentContinueToolDescription(): string {
  return [
    "Continue a background subagent job that is parked in `needs_input`.",
    "",
    "Use this after `subagent_start` was called with `awaitMarker` and the",
    "subagent stopped to ask for direction. The prompt is sent to the same",
    "job-owned child session.",
    "",
    "Examples:",
    '  { "jobId": "subjob_abc123", "prompt": "Explore option 2." }',
    '  { "jobId": "subjob_abc123", "callIndex": 0, "prompt": "Go deeper on cleanup risk." }',
  ].join("\n");
}

export function formatSubagentCancelToolDescription(): string {
  return [
    "Cancel a running background subagent job.",
    "",
    "Terminates all running subagent processes in the job and marks it as cancelled.",
    "A cancellation message is injected into the session when the job has stopped.",
    "",
    "Requires `confirm: true` to proceed. Without it, returns a dry-run message.",
    "",
    "Example:",
    '  { "jobId": "subjob_abc123", "confirm": true }',
  ].join("\n");
}
