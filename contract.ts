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

> **﹟ Cardinal rule: never dump verbatim subagent output in your response.**
>
> When a subagent returns results — whether via escalation (\`needs_input\`),
> completion notification, or \`subagent_result\` — read the output for your
> own context, then present a **concise summary in your own words**.
>
> **Do not quote, re-display, or reproduce the subagent's output verbatim.**
> The user already sees the escalation question or completion notification in
> the injected message. Your job is to react, decide what to do next, or ask
> the user for direction — not to parrot what the subagent said.
>
> **Bad:** "The explorer delivered this plan:\n\n## Step 1 ... (hundreds of lines)"
> **Good:** "The explorer produced a refactor plan for TraceProjectionService
> with 7 steps (envelope type, service class, route handler, etc.)."
>
> **Bad:** "Here are the explorer's findings:\n\nThe file imports ... (wall of text)"
> **Good:** "The explorer found 3 circular imports and 2 unused dependencies.
> I'll address them next."

**Fleet view is your primary state source.** Use \`subagent_status\` without
a \`jobId\` to see all background jobs grouped by attention priority:
  1. \`needs_input\` — jobs waiting for user direction
  2. \`failed\` — jobs that errored
  3. \`running\` / \`cancelling\` — active jobs
  4. \`completed\` / \`cancelled\` / \`interrupted\` — recent terminal jobs (last 5 min)

Check the fleet view before making parent-worktree edits to see what is alive,
waiting for input, failed, or ready. Prioritize \`needs_input\` and \`failed\`
jobs — they need your attention first.

**Fire-and-forget rule:** After calling \`subagent_start\`, end your turn.
Do not poll or wait. The auto-injected completion message will wake you
when the job finishes. Use the fleet view if you need a progress check.

**Completion notifications are state changes, not reports.**
The auto-injected message is a compact notification showing only the
job ID, status, agents, duration, and a result summary.
Do not quote or summarize the notification content as if it were
subagent output. Treat it as a signal to inspect, not as a report to relay.

**Use \`subagent_result\` only when you need details.**
This tool retrieves the full output from a completed job. Read it for your
own context, then present a concise summary in your own words. Never dump
the full verbatim output into your response.
For live activity, use \`subagent_peek\`. For structured job detail
(lifecycle, artifacts, next actions), use \`subagent_status { jobId }\`.
Cancel a running job with \`subagent_cancel\` (requires \`confirm: true\`).

**Per-call completion:** Multi-call background jobs fire a completion
notification as each individual call finishes, not just when all calls
are done. The per-call message tells you which call completed and its
result. When all calls finish, a final job-level message gives the
aggregate summary.
You can inspect individual call results immediately via \`subagent_result\`
with \`callIndex\`. Use \`subagent_status\` to see which calls are still
running.

For interactive background jobs, set top-level \`interactive: true\`.
The extension will instruct the subagent how to pause for user direction.
When the job parks as \`needs_input\`, the user sees a normal follow-up
question while routing metadata is attached in hidden message details.
If exactly one unresolved subagent escalation exists and the user replies
with an answer, call \`subagent_continue\` and pass the user's reply verbatim
as \`prompt\`. Use hidden \`escalationId\` routing metadata when available;
otherwise use the job shown by \`subagent_status\`. If multiple escalations
are open and the target is unclear, ask a normal clarification question like
"Which subagent should I answer?" If the user names an agent, topic, or
obvious option, use that to pick the escalation. Do not ask the user for a job ID
unless they are intentionally using advanced tooling. Do not expose tool syntax,
and do not mention markers.
After calling \`subagent_continue\`, acknowledge briefly and naturally. Do not
repeat the subagent's previous question unless the user asks, and do not claim
the subagent has finished until a completion message arrives.

**The escalation message already shows the subagent's output to the user.**
The injected message from a parked subagent already contains its full
question, plan, or findings. Do **not** re-display or re-summarise that
content in your response. The user sees it in the escalation message.
Your job is to react — ask for direction, decide next steps, or take
action. A one-line acknowledgement ("The explorer is asking which area
to inspect next.") is sufficient. Longer quotes waste context and irritate
the user.

**Use \`subagent_close\` when no further action is needed.** If the user says
they're done, or dismisses the subagent without giving it more work to do,
do **not** use \`subagent_continue\` to say goodbye — that would wake the
child agent and create another \`needs_input\` cycle. Instead, call
\`subagent_close\` which marks the job as completed without resuming the child.
Provide the \`escalationId\` from hidden routing metadata when available.
\`awaitMarker\` exists only as an advanced/debug override.

Background jobs do not support caller-supplied persistent sessions (\`session\`).
Omit \`session\` for background delegation. Jobs that use \`awaitMarker\`
create an internal job-owned child session for continuation.
Jobs that use \`interactive: true\` do the same without exposing the marker.

**Continuing a completed background job's investigation:**
Every background job call already creates a persistent child Pi session
with a handle like \`background:<jobId>:call:<index>\` (visible in the
job detail view and hinted in fleet/completion views).
When the user wants to continue the same line of inquiry (e.g. "dig into
topic X from your earlier analysis"), use the **foreground** \`subagent\`
tool with \`session: "background:<jobId>:call:<index>"\` from the
completed job. This continues the exact same child Pi session, so the
subagent retains the full conversation history.

Example:
- Job \`subjob_8c920f76\` completed with explorer findings.
- \`subagent_status { jobId: "subjob_8c920f76" }\` shows
  \`Session: background:subjob_8c920f76:call:0\`.
- Call \`subagent\` with \`session: "background:subjob_8c920f76:call:0"\`
  and a prompt like \"Continue your investigation into §8 Config...\".
- The subagent resumes the same conversation with full history.

Do NOT start a background job for continuation — that would create an
entirely new subagent without the previous context. Use foreground
\`subagent\` with the session handle for continuation, and
\`subagent_start\` for separate new tasks.

**Important:** Background jobs run in the same working tree by default
and can edit files concurrently with the parent or sibling jobs. Always:
- Give each subagent a clearly disjoint scope of work.
- Use \`subagent_status\` (fleet view) to check running jobs before making changes.
- Use \`subagent_result\` to review full output before integrating.
- Note the job ID at start time for later queries.

### Plan queue

Use \`subagent_enqueue\` to store a plan that fires when background jobs
complete. The plan is stored and fires when all background jobs reach a
terminal state.

**When a plan fires, you do not see the plan text.** The auto-injected
message only notifies you that a plan is ready. It will say:

> "A queued plan (plan_xxx) is now ready."

This is intentional: the plan text is hidden to prevent you from executing
it without the user's consent.

Always ask the user if they still want the plan executed before proceeding.
Their priorities may have changed since the plan was queued.

If the user is interested or confirms, retrieve the plan text with:
\`subagent_get_plan\` with the plan ID shown in the notification.

Never include the plan text in your response until the user has asked about
it or explicitly confirmed they want it executed.

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
    "> **Important:** After starting background jobs, **end your turn immediately.**",
    "> Do not poll `subagent_status`. A completion message will be auto-injected",
    "> when the job finishes and will trigger a new assistant turn automatically.",
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
    "Optional top-level field `interactive` (default: false):",
    "  - Set to true when the subagent may need to pause and ask the user for direction.",
    "  - The extension handles the internal wait marker and child prompt instructions.",
    "  - When the job parks as `needs_input`, continue the same child session with `subagent_continue`.",
    "",
    "Optional top-level field `awaitMarker`:",
    "  - Advanced/debug override for the internal wait marker.",
    "  - When a successful single-call job's final output contains this marker,",
    "    the job parks as `needs_input` instead of completing.",
    "  - Prefer `interactive: true` for ordinary interactive background jobs.",
    "",
    "Restrictions:",
    "- Only available from the root parent Pi session (not from subagents).",
    "- Caller-supplied persistent sessions (`session`) are not supported in background mode.",
    "- `interactive: true` and `awaitMarker` are currently single-call only.",
    `- Maximum ${2} concurrent background jobs.`,
    "- `initialContext: \"parent\"` is not yet supported.",
    "",
    "Agent behavior:",
    "- After starting background jobs, end your turn. Do not poll. The auto-injected completion message will deliver results.",
    "- For multi-call jobs, each call fires its own per-call completion message when it finishes,",
    "  so you can act on early results while waiting for remaining calls.",
    "- A final job-level message arrives when all calls are done.",
    "",
    "Shared-worktree safety:",
    "  - Use the \`subagent_status\` fleet view to check running jobs before making parent edits.",
    "  - Use \`subagent_result\` to review full output before integrating changes.",
    "  - The job ID is shown at start — note it for later queries.",
    "  - When isolated mode is available, set `worktreeMode: \"isolated\"` to run each job in a separate git worktree.",
    "",
    "Example (onComplete defaults to trigger, so you can omit it):",
    '  { "calls": [{ "agent": "explorer", "prompt": "Find all test files" }] }',
    "",
    "Interactive example:",
    '  { "interactive": true, "calls": [{ "agent": "explorer", "prompt": "Inspect runner.ts and offer three follow-up directions." }] }',
  "Continuing a completed job's investigation:",
    "  - Every background job call already creates a persistent child Pi",
    "    session with handle \`background:<jobId>:call:<index>\`.",
    "  - When the user wants to continue a completed investigation",
    "    (e.g. \"dig into topic X from your earlier analysis\"), use the",
    "    **foreground** \`subagent\` tool with",
    "    \`session: \"background:<jobId>:call:<index>\"\`.",
    "    This resumes the exact same child Pi session with full history.",
    "  - The session handle is visible in \`subagent_status { jobId }\`",
    "    under the \`Session:\` field, and hinted in completion notifications.",
    "  - For separate parallel tasks, use \`subagent_start\` as normal.",
    "  - Do NOT start a background job for continuation — use foreground",
    "    \`subagent\` with the session handle instead.",
  ].join("\n");
}

export function formatSubagentStatusToolDescription(): string {
  return [
    "Query the status of a background subagent job.",
    "",
    "Provide a `jobId` to inspect a specific job. Omit `jobId` to list all known jobs.",
    "Read-only. No confirmation needed.",
    "",
    "**When to use this:**",
    "  - With `jobId`: structured job detail page — shows lifecycle state, calls, artifacts,",
    "    waiting-for-input questions, and next-action hints.",
    "  - Without `jobId`: fleet overview grouped by attention priority. Use before making",
    "    parent-worktree edits to check for conflicting background jobs.",
    "",
    "When called without `jobId`, displays a **fleet view** grouped by attention priority:",
    "  1. `needs_input` — jobs waiting for user direction",
    "  2. `failed` — jobs that errored",
    "  3. `running` / `cancelling` — active jobs",
    "  4. `completed` / `cancelled` / `interrupted` — recent terminal jobs (last 5 min)",
    "",
    "Each row shows job ID, agent names, age, status-specific fields (question, error,",
    "tool counts, worktree mode), and a next-action hint.",
    "",
    "Use the fleet view before making parent-worktree edits to check for",
    "conflicting background jobs.",
    "",
    "> **Do not poll in a loop.** After starting background jobs with `subagent_start`,",
    "> end your turn and wait for the auto-injected completion message.",
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
    "Use this while a job is running to see what the subagent is currently doing.",
    "",
    "**When to use this:**",
    "  - Live activity timeline: shows tool calls and recent events for a running job.",
    "  - By default, shows a clean activity summary without raw JSON lines.",
    "  - For full output from a completed job, use `subagent_result`.",
    "  - For structured job detail (lifecycle, artifacts, next actions), use `subagent_status { jobId }`.",
    "",
    "Provide `jobId` to inspect a job. Optionally provide `callIndex` for one call.",
    "Use `maxEvents` to control the event tail size (default 20, max 200).",
    "Set `includeRawEvents` to true only when you need the raw JSON event tail (debugging).",
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
    "**When to use this:**",
    "  - For the complete response text from a finished subagent.",
    "  - For inspecting captured output, tool call traces, and error details.",
    "  - For live activity, use `subagent_peek`.",
    "  - For structured job detail (lifecycle, artifacts, next actions), use `subagent_status { jobId }`.",
    "",
    "Use this tool when you need to read the complete response text from a",
    "finished subagent. **Do not dump the full output verbatim into your response.**",
    "Read it for context, then present a concise summary of key findings to the user.",
    "If the user asks for specific details, share targeted excerpts — not the full report.",
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
    "Use this after an interactive `subagent_start` job stops to ask for",
    "direction. The prompt is sent to the same job-owned child session.",
    "Parent agents should route the user's natural reply here silently.",
    "When available, provide `escalationId`; it selects the parked call and takes precedence over `callIndex`.",
    "`jobId` remains supported for advanced/manual use and older routing.",
    "",
    "Examples:",
    '  { "jobId": "subjob_abc123", "prompt": "Explore option 2." }',
    '  { "escalationId": "esc_abc123", "prompt": "Explore option 2." }',
    '  { "jobId": "subjob_abc123", "callIndex": 0, "prompt": "Go deeper on cleanup risk." }',
  ].join("\n");
}

export function formatSubagentEnqueueToolDescription(): string {
  return [
    "Store a plan to be executed when background subagent jobs complete.",
    "",
    "The plan is stored verbatim but is NOT shown in the auto-injected",
    "completion message. This is intentional: you must ask the user first,",
    "then retrieve the plan text with \`subagent_get_plan\` if they confirm.",
    "",
    "When the plan fires, ask the user if they still want it done before",
    "proceeding. Use \`subagent_get_plan\` with the plan ID shown in the",
    "notification to retrieve the plan text when needed.",
    "",
    "If \`replace: true\`, any existing queued plan for the same job set is",
    "replaced with this one.",
    "",
    "Example:",
    '  { "plan": "Compile the results into REPORT.md",',
    '    "dependsOn": ["subjob_abc123", "subjob_def456"],',
    '    "replace": true }',
  ].join("\n");
}

export function formatSubagentGetPlanToolDescription(): string {
  return [
    "Retrieve the full plan text for a previously queued plan.",
    "",
    "The plan text is intentionally hidden from auto-injected messages",
    "to prevent premature execution. Use this tool when the user is",
    "interested in what the plan was, or has confirmed they want it executed.",
    "",
    "Example:",
    '  { "planId": "plan_ce19fdf0" }',
  ].join("\n");
}

export function formatSubagentCloseToolDescription(): string {
  return [
    "Close a background subagent job that is parked in `needs_input`.",
    "",
    "Use this when the user says no further action is needed from the waiting",
    "subagent. Unlike `subagent_continue`, this does **not** wake the child",
    "agent — it marks the job as completed directly on the parent side.",
    "",
    "Resolves the target by `escalationId` or `jobId`. Only parked jobs",
    "with an open escalation can be closed. Running jobs require",
    "`subagent_cancel` instead.",
    "",
    "`confirm: true` is not required — closing only applies to already-parked",
    "jobs and does not terminate a running process.",
    "",
    "Examples:",
    '  { "jobId": "subjob_abc123" }',
    '  { "escalationId": "esc_1234abcd", "reason": "User chose to end the conversation." }',
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
