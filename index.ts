/**
 * Pi Subagent Extension
 *
 * Delegates prompts to specialized subagents, each running as an isolated `pi`
 * process. The tool accepts a single `calls` array for both one and many
 * subagent invocations.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, STARTER_AGENT_NAME, discoverAgentsWithStarter } from "./agents.js";
import {
  getActiveBackgroundJobCount,
  generateJobId,
  MAX_BACKGROUND_JOBS,
  registerBackgroundJob,
  getBackgroundJob,
  getAllBackgroundJobs,
  setJobStoreBaseDir,
  reloadPersistedJobs,
  updateBackgroundJobStatus,
  setBackgroundJobResults,
  persistJobResultArtifact,
} from "./background-jobs.js";
import {
  CALLS_SCHEMA_DESCRIPTION,
  formatAvailableSubagentsPrompt,
  formatSubagentCancelToolDescription,
  formatSubagentResultToolDescription,
  formatSubagentStartToolDescription,
  formatSubagentStatusToolDescription,
  formatSubagentToolDescription,
  formatSubagentUsageErrorExample,
  getCallFieldSchemaDescription,
} from "./contract.js";
import {
  formatBackgroundCompletion,
  formatJobList,
  formatJobResults,
  formatJobStatus,
  renderBackgroundCall,
  renderBackgroundResult,
  renderCall,
  renderCancelCall,
  renderCancelResult,
  renderJobStatusCall,
  renderJobStatusResult,
  renderResult,
  renderSubagentResultCall,
  renderSubagentResultResult,
} from "./render.js";
import { updateCallStateFromPartial } from "./background-activity.js";
import {
  markPendingCallsCancelled,
  finishCallState,
} from "./background-lifecycle.js";
import { ensureDefaultSessionDir, getDefaultSessionDirPath } from "./session-paths.js";
import { getResultSummaryText } from "./runner-events.js";
import { mapConcurrent, runAgent } from "./runner.js";
import { acquireSessionLocks, releaseSessionLocks, type SessionLockTarget } from "./session-lock.js";
import {
  createWorktree,
  createWorktreePatch,
  getRepoRoot,
  getWorktreeChangedFiles,
} from "./worktree.js";
import {
  type BackgroundCompletionMode,
  type BackgroundJob,
  type CallState,
  type InitialContext,
  type NormalizedCall,
  type SingleResult,
  type SubagentDetails,
  type SubagentSessionDetails,
  type WorktreeMode,
  DEFAULT_INITIAL_CONTEXT,
  emptyUsage,
  isResultError,
  isResultSuccess,
  validateCallIndex,
  validateMaxOutputLength,
} from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_CALLS = 8;
const MAX_CONCURRENCY = 4;
const CALLS_HEARTBEAT_MS = 1000;
const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TEMP_PARENT_SESSION_ENV = "PI_SUBAGENT_TEMP_PARENT_SESSION";
const SESSION_ID_NAMESPACE = "pi-subagent/v1";
const SESSION_ID_PREFIX = "subagent.";
const SESSION_HANDLE_MAX_LENGTH = 120;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const CallItem = Type.Object({
  agent: Type.String({
    description: getCallFieldSchemaDescription("agent"),
  }),
  prompt: Type.String({
    description: getCallFieldSchemaDescription("prompt"),
  }),
  model: Type.Optional(
    Type.String({ description: getCallFieldSchemaDescription("model") }),
  ),
  cwd: Type.Optional(
    Type.String({ description: getCallFieldSchemaDescription("cwd") }),
  ),
  initialContext: Type.Optional(
    Type.Union([Type.Literal("empty"), Type.Literal("parent")], {
      description: getCallFieldSchemaDescription("initialContext"),
      default: DEFAULT_INITIAL_CONTEXT,
    }),
  ),
  session: Type.Optional(
    Type.String({
      description: getCallFieldSchemaDescription("session"),
    }),
  ),
});

const SubagentParams = Type.Object({
  calls: Type.Array(CallItem, {
    description: CALLS_SCHEMA_DESCRIPTION,
  }),
});

const SubagentStartParams = Type.Object({
  calls: Type.Array(CallItem, {
    description: CALLS_SCHEMA_DESCRIPTION,
  }),
  onComplete: Type.Optional(
    Type.Union(
      [Type.Literal("message"), Type.Literal("trigger"), Type.Literal("silent")],
      {
        description:
          'How to deliver completion: "trigger" (default) injects a message and triggers a parent turn; "message" injects without triggering; "silent" records in memory only.',
        default: "trigger",
      },
    ),
  ),
  worktreeMode: Type.Optional(
    Type.Union(
      [Type.Literal("shared"), Type.Literal("isolated")],
      {
        description:
          'Worktree execution mode: "shared" (default) runs in the parent working tree; "isolated" creates a separate git worktree with its own branch for safe parallel edits.',
        default: "shared",
      },
    ),
  ),
  worktreeScope: Type.Optional(
    Type.String({
      description:
        'Optional file/path scope declaration for this job, e.g. "src/*.ts" or "docs/". Helps identify potential conflicts between concurrent jobs.',
    }),
  ),
});

const SubagentStatusParams = Type.Object({
  jobId: Type.Optional(
    Type.String({
      description: "Job ID to inspect. Omit to list all jobs.",
    }),
  ),
});

const SubagentResultParams = Type.Object({
  jobId: Type.String({
    description: "ID of the completed background job to retrieve results for.",
  }),
  callIndex: Type.Optional(
    Type.Integer({
      description:
        "0-based index of a specific call to retrieve. Omit to get all calls.",
      minimum: 0,
    }),
  ),
  includeToolCalls: Type.Optional(
    Type.Boolean({
      description:
        "When true, include tool calls in addition to final assistant text. Default: false (final text only).",
      default: false,
    }),
  ),
  maxOutputLength: Type.Optional(
    Type.Integer({
      description:
        "Maximum characters of output text per call (1–50000). Default: no limit.",
      minimum: 1,
      maximum: 50000,
    }),
  ),
});

const SubagentCancelParams = Type.Object({
  jobId: Type.String({
    description: "ID of the background job to cancel.",
  }),
  confirm: Type.Optional(
    Type.Boolean({
      description: "Explicit confirmation flag.",
      default: false,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DelegationDepthConfig {
  currentDepth: number;
  maxDepth: number;
  canDelegate: boolean;
  ancestorAgentStack: string[];
  preventCycles: boolean;
}

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

interface NormalizedCallsResult {
  calls?: NormalizedCall[];
  error?: string;
}

interface ExtensionExecutionContext {
  cwd: string;
  sessionManager: SessionSnapshotSource & {
    getSessionId: () => string;
    getSessionDir: () => string;
    getSessionFile: () => string | undefined;
  };
}

function parseInitialContext(raw: unknown): InitialContext | null {
  if (raw === undefined) return DEFAULT_INITIAL_CONTEXT;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (normalized === "empty" || normalized === "parent") return normalized;
  return null;
}

function buildParentSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  const branchEntries = sessionManager.getBranch();
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}

function parseNonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseAgentStack(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((value) => typeof value === "string")) return null;
  return parsed
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getMaxDepthFlagFromArgv(argv: string[]): string | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-max-depth") {
      return argv[i + 1] ?? "";
    }
    if (arg.startsWith("--subagent-max-depth=")) {
      return arg.slice("--subagent-max-depth=".length);
    }
  }
  return null;
}

function getPreventCyclesFlagFromArgv(
  argv: string[],
): string | boolean | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-prevent-cycles") {
      const maybeValue = argv[i + 1];
      if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
        return maybeValue;
      }
      return true;
    }
    if (arg === "--no-subagent-prevent-cycles") return false;
    if (arg.startsWith("--subagent-prevent-cycles=")) {
      return arg.slice("--subagent-prevent-cycles=".length);
    }
  }
  return null;
}

function resolveDelegationDepthConfig(pi: ExtensionAPI): DelegationDepthConfig {
  const depthRaw = process.env[SUBAGENT_DEPTH_ENV];
  const parsedDepth = parseNonNegativeInt(depthRaw);
  if (depthRaw !== undefined && parsedDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_DEPTH_ENV}="${depthRaw}". Expected a non-negative integer.`,
    );
  }
  const currentDepth = parsedDepth ?? 0;

  const stackRaw = process.env[SUBAGENT_STACK_ENV];
  const ancestorAgentStack = parseAgentStack(stackRaw);
  if (stackRaw !== undefined && ancestorAgentStack === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_STACK_ENV} value. Expected a JSON array of agent names.`,
    );
  }

  const envMaxDepthRaw = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
  if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
    );
  }

  const argvFlagRaw = getMaxDepthFlagFromArgv(process.argv);
  const argvFlagMaxDepth =
    argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
  if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
    );
  }

  const runtimeFlagValue = pi.getFlag("subagent-max-depth");
  const runtimeFlagMaxDepth =
    typeof runtimeFlagValue === "string"
      ? parseNonNegativeInt(runtimeFlagValue)
      : null;
  if (
    argvFlagRaw === null &&
    typeof runtimeFlagValue === "string" &&
    runtimeFlagMaxDepth === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${runtimeFlagValue}". Expected a non-negative integer.`,
    );
  }

  const envPreventCyclesRaw = process.env[SUBAGENT_PREVENT_CYCLES_ENV];
  const envPreventCycles = parseBoolean(envPreventCyclesRaw);
  if (envPreventCyclesRaw !== undefined && envPreventCycles === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_PREVENT_CYCLES_ENV}="${envPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(process.argv);
  const argvPreventCycles =
    typeof argvPreventCyclesRaw === "boolean"
      ? argvPreventCyclesRaw
      : parseBoolean(argvPreventCyclesRaw);
  if (
    typeof argvPreventCyclesRaw === "string" &&
    argvPreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const runtimePreventCyclesRaw = pi.getFlag("subagent-prevent-cycles");
  const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
  if (
    argvPreventCyclesRaw === null &&
    runtimePreventCyclesRaw !== undefined &&
    runtimePreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
    );
  }

  const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
  const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const preventCycles =
    argvPreventCycles ??
    runtimePreventCycles ??
    envPreventCycles ??
    DEFAULT_PREVENT_CYCLE_DELEGATION;

  return {
    currentDepth,
    maxDepth,
    canDelegate: currentDepth < maxDepth,
    ancestorAgentStack: ancestorAgentStack ?? [],
    preventCycles,
  };
}

function makeDetailsFactory(projectAgentsDir: string | null) {
  return (results: SingleResult[]): SubagentDetails => ({
    projectAgentsDir,
    results,
  });
}

function normalizeCalls(rawCalls: unknown, defaultCwd: string): NormalizedCallsResult {
  if (!Array.isArray(rawCalls)) {
    return { error: `Invalid subagent parameters: missing calls array.\n${formatSubagentUsageErrorExample()}` };
  }
  if (rawCalls.length === 0) {
    return { error: `Invalid subagent parameters: calls must contain at least one call.\n${formatSubagentUsageErrorExample()}` };
  }
  if (rawCalls.length > MAX_CALLS) {
    return { error: `Too many subagent calls (${rawCalls.length}). Max is ${MAX_CALLS}.` };
  }

  const calls: NormalizedCall[] = [];
  for (let index = 0; index < rawCalls.length; index++) {
    const raw = rawCalls[index];
    if (!raw || typeof raw !== "object") {
      return { error: `calls[${index}] must be an object.` };
    }
    const call = raw as Record<string, unknown>;

    if (typeof call.agent !== "string" || call.agent.trim().length === 0) {
      return { error: `calls[${index}].agent must be a non-empty string.` };
    }
    const agent = call.agent.trim();

    if (typeof call.prompt !== "string" || call.prompt.trim().length === 0) {
      return { error: `calls[${index}].prompt must be a non-empty string.` };
    }
    const prompt = call.prompt;

    let model: string | undefined;
    if (call.model !== undefined) {
      if (typeof call.model !== "string") {
        return { error: `calls[${index}].model must be a string when provided.` };
      }
      model = call.model.trim();
      if (!model) {
        return { error: `calls[${index}].model must not be empty when provided.` };
      }
    }

    const initialContext = parseInitialContext(call.initialContext);
    if (!initialContext) {
      return { error: `calls[${index}].initialContext must be "empty" or "parent".` };
    }

    let effectiveCwd: string;
    if (call.cwd !== undefined) {
      if (typeof call.cwd !== "string" || call.cwd.trim().length === 0) {
        return { error: `calls[${index}].cwd must be a non-empty string when provided.` };
      }
      effectiveCwd = path.resolve(defaultCwd, call.cwd);
      try {
        if (!fs.statSync(effectiveCwd).isDirectory()) {
          return { error: `calls[${index}].cwd is not a directory: ${effectiveCwd}` };
        }
      } catch {
        return { error: `calls[${index}].cwd does not exist or is not accessible: ${effectiveCwd}` };
      }
    } else {
      effectiveCwd = path.resolve(defaultCwd);
    }

    let sessionHandle: string | undefined;
    if (call.session !== undefined) {
      if (typeof call.session !== "string") {
        return { error: `calls[${index}].session must be a string when provided.` };
      }
      sessionHandle = call.session.trim();
      if (!sessionHandle) {
        return { error: `calls[${index}].session must not be empty when provided.` };
      }
      if (sessionHandle.length > SESSION_HANDLE_MAX_LENGTH) {
        return {
          error: `calls[${index}].session must be at most ${SESSION_HANDLE_MAX_LENGTH} characters.`,
        };
      }
    }

    calls.push({
      index,
      agent,
      prompt,
      model,
      effectiveCwd,
      initialContext,
      sessionHandle,
    });
  }

  return { calls };
}

function stableSessionSeed(values: unknown[]): string {
  return JSON.stringify(values);
}

function deriveSessionId(
  parentSessionId: string,
  effectiveCwd: string,
  agentName: string,
  sessionHandle: string,
): string {
  const digest = createHash("sha256")
    .update(stableSessionSeed([
      SESSION_ID_NAMESPACE,
      parentSessionId,
      effectiveCwd,
      agentName,
      sessionHandle,
    ]))
    .digest("hex")
    .slice(0, 16);
  return `${SESSION_ID_PREFIX}${digest}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatSessionDisplayName(agentName: string, sessionHandle: string): string {
  return `subagent: ${agentName} · ${oneLine(sessionHandle)}`;
}

function attachSessionIdentities(calls: NormalizedCall[], parentSessionId: string): void {
  for (const call of calls) {
    if (!call.sessionHandle) continue;
    const id = deriveSessionId(
      parentSessionId,
      call.effectiveCwd,
      call.agent,
      call.sessionHandle,
    );
    call.session = {
      handle: call.sessionHandle,
      id,
      name: formatSessionDisplayName(call.agent, call.sessionHandle),
      cwd: call.effectiveCwd,
      created: false,
      initialContextApplied: null,
    };
  }
}

function getDuplicateSessionError(calls: NormalizedCall[]): string | null {
  const firstById = new Map<string, NormalizedCall>();
  for (const call of calls) {
    if (!call.session) continue;
    const first = firstById.get(call.session.id);
    if (first) {
      return `Invalid subagent calls: calls[${first.index}] and calls[${call.index}] resolve to the same persistent session (${call.session.id}).\nA persistent subagent session can only be used by one call at a time. Use different session handles or combine the prompts.`;
    }
    firstById.set(call.session.id, call);
  }
  return null;
}

function getActiveSessionError(
  calls: NormalizedCall[],
  activeSessionIds: Set<string>,
): string | null {
  for (const call of calls) {
    if (call.session && activeSessionIds.has(call.session.id)) {
      return `Invalid subagent calls: calls[${call.index}] uses persistent session ${call.session.id}, which is already running in another subagent call. Retry after that call finishes.`;
    }
  }
  return null;
}

async function resolveSessionCreationState(
  calls: NormalizedCall[],
  sessionDir: string | undefined,
): Promise<void> {
  const sessionIdsByListKey = new Map<string, Set<string>>();

  for (const call of calls) {
    if (!call.session) continue;
    const key = `${sessionDir ?? ""}\0${call.effectiveCwd}`;
    let ids = sessionIdsByListKey.get(key);
    if (!ids) {
      const sessions = await SessionManager.list(call.effectiveCwd, sessionDir);
      ids = new Set(sessions.map((session) => session.id));
      sessionIdsByListKey.set(key, ids);
    }

    const exists = ids.has(call.session.id);
    call.session.created = !exists;
    call.session.initialContextApplied = exists ? null : call.initialContext;
  }
}

function needsParentSnapshot(calls: NormalizedCall[]): boolean {
  return calls.some(
    (call) => call.initialContext === "parent" && (!call.session || call.session.created),
  );
}

function getPersistentSessionDir(ctx: ExtensionExecutionContext): string | undefined {
  const manager = ctx.sessionManager as unknown as {
    usesDefaultSessionDir?: () => boolean;
  };

  if (typeof manager.usesDefaultSessionDir === "function") {
    return manager.usesDefaultSessionDir() ? undefined : ctx.sessionManager.getSessionDir();
  }

  try {
    const current = path.resolve(ctx.sessionManager.getSessionDir());
    const defaultDir = path.resolve(getDefaultSessionDirPath(ctx.cwd));
    return current === defaultDir ? undefined : ctx.sessionManager.getSessionDir();
  } catch {
    return undefined;
  }
}

function getNamedSessionParentError(
  calls: NormalizedCall[],
  ctx: ExtensionExecutionContext,
): string | null {
  if (!calls.some((call) => call.session)) return null;
  if (parseBoolean(process.env[SUBAGENT_TEMP_PARENT_SESSION_ENV]) === true) {
    return "Named subagent sessions are not available from temporary parent-seeded subagent sessions. Omit `session` or use a named parent subagent session first.";
  }
  if (ctx.sessionManager.getSessionFile()) return null;
  return "Named subagent sessions require a persisted parent Pi session. Omit `session` for ephemeral delegation, or run the parent without --no-session.";
}

function sessionBaseDir(call: NormalizedCall, sessionDir: string | undefined): string {
  return sessionDir ?? ensureDefaultSessionDir(call.effectiveCwd);
}

function getSessionLockTargets(
  calls: NormalizedCall[],
  sessionDir: string | undefined,
): SessionLockTarget[] {
  return calls
    .filter((call) => call.session)
    .map((call) => ({
      sessionId: call.session!.id,
      lockRoot: path.join(sessionBaseDir(call, sessionDir), ".pi-subagent-locks"),
      agent: call.agent,
      handle: call.session!.handle,
      cwd: call.effectiveCwd,
    }));
}

function getCycleViolations(
  requestedNames: Set<string>,
  ancestorAgentStack: string[],
): string[] {
  if (requestedNames.size === 0 || ancestorAgentStack.length === 0) return [];
  const stackSet = new Set(ancestorAgentStack);
  return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

function makePlaceholderResult(call: NormalizedCall): SingleResult {
  return {
    callIndex: call.index,
    agent: call.agent,
    agentSource: "unknown",
    prompt: call.prompt,
    initialContext: call.initialContext,
    session: call.session,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: call.model,
  };
}

function formatResultLabel(result: SingleResult, fallbackIndex: number): string {
  const displayIndex = (result.callIndex ?? fallbackIndex) + 1;
  const sessionText = result.session ? ` session=${oneLine(result.session.handle)}` : "";
  return `${displayIndex}: ${result.agent}${sessionText}`;
}

function formatCallsSummary(results: SingleResult[]): string {
  const successCount = results.filter((r) => isResultSuccess(r)).length;
  const summaries = results.map((r, index) => {
    const status = isResultError(r) ? "failed" : "completed";
    return `[${formatResultLabel(r, index)}] ${status}:\n${getResultSummaryText(r)}`;
  });
  return `${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 3).",
    type: "string",
  });
  pi.registerFlag("subagent-prevent-cycles", {
    description:
      "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });

  const depthConfig = resolveDelegationDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;
  const activeSessionIds = new Set<string>();

  let discoveredAgents: AgentConfig[] = [];

  // Initialize background job persistence and auto-discover agents on session start.
  pi.on("session_start", async (_event, ctx) => {
    // Set up the persistent job store under the project's .pi-subagent directory.
    setJobStoreBaseDir(ctx.cwd);
    const reloadedCount = reloadPersistedJobs();
    if (reloadedCount > 0) {
      const label = reloadedCount === 1 ? "job" : "jobs";
      const message = `Reloaded ${reloadedCount} persisted background ${label}. Use \`subagent_status\` to inspect.`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "info");
      }
    }

    if (!canDelegate) return;

    const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
    const discovery = starterDiscovery.discovery;
    discoveredAgents = discovery.agents;

    if (ctx.hasUI) {
      if (starterDiscovery.createdAgentPath) {
        ctx.ui.notify(
          `Created starter subagent "${STARTER_AGENT_NAME}" at:\n${starterDiscovery.createdAgentPath}\n\nEdit this file or add more agents in the same directory to customize delegation.`,
          "info",
        );
      } else if (starterDiscovery.error && discoveredAgents.length === 0) {
        ctx.ui.notify(
          `No subagents found. ${starterDiscovery.error}`,
          "info",
        );
      } else if (discoveredAgents.length > 0) {
        const list = discoveredAgents
          .map((a) => `  - ${a.name} (${a.source})`)
          .join("\n");
        ctx.ui.notify(
          `Found ${discoveredAgents.length} subagent(s):\n${list}`,
          "info",
        );
      }
    }
  });

  // Inject available agents into the system prompt.
  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    if (discoveredAgents.length === 0) return;

    return {
      systemPrompt:
        event.systemPrompt +
        formatAvailableSubagentsPrompt(discoveredAgents, {
          currentDepth,
          maxDepth,
          preventCycles,
          ancestorAgentStack,
        }),
    };
  });

  // Register the subagent tool.
  if (canDelegate) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: formatSubagentToolDescription(),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
        const discovery = starterDiscovery.discovery;
        const { agents } = discovery;
        const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);

        const normalized = normalizeCalls(params.calls, ctx.cwd);
        if (normalized.error || !normalized.calls) {
          return {
            content: [{ type: "text", text: normalized.error ?? "Invalid subagent parameters." }],
            details: makeDetails([]),
            isError: true,
          };
        }
        const calls = normalized.calls;

        attachSessionIdentities(calls, ctx.sessionManager.getSessionId());

        const duplicateSessionError = getDuplicateSessionError(calls);
        if (duplicateSessionError) {
          return {
            content: [{ type: "text", text: duplicateSessionError }],
            details: makeDetails([]),
            isError: true,
          };
        }

        const parentSessionError = getNamedSessionParentError(
          calls,
          ctx as ExtensionExecutionContext,
        );
        if (parentSessionError) {
          return {
            content: [{ type: "text", text: parentSessionError }],
            details: makeDetails([]),
            isError: true,
          };
        }

        const requested = new Set(calls.map((call) => call.agent));

        if (preventCycles) {
          const cycleViolations = getCycleViolations(
            requested,
            ancestorAgentStack,
          );
          if (cycleViolations.length > 0) {
            const stackText =
              ancestorAgentStack.length > 0
                ? ancestorAgentStack.join(" -> ")
                : "(root)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        const persistentSessionDir = getPersistentSessionDir(ctx as ExtensionExecutionContext);

        const activeSessionError = getActiveSessionError(calls, activeSessionIds);
        if (activeSessionError) {
          return {
            content: [{ type: "text", text: activeSessionError }],
            details: makeDetails([]),
            isError: true,
          };
        }

        const lockResult = acquireSessionLocks(
          getSessionLockTargets(calls, persistentSessionDir),
        );
        if (lockResult.error) {
          return {
            content: [{ type: "text", text: lockResult.error }],
            details: makeDetails([]),
            isError: true,
          };
        }

        const reservedSessionIds = calls
          .map((call) => call.session?.id)
          .filter((id): id is string => Boolean(id));
        for (const id of reservedSessionIds) activeSessionIds.add(id);

        try {
          try {
            await resolveSessionCreationState(calls, persistentSessionDir);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to inspect existing subagent sessions: ${message}`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }

          let parentSessionSnapshotJsonl: string | undefined;
          if (needsParentSnapshot(calls)) {
            const snapshot = buildParentSessionSnapshotJsonl(ctx.sessionManager);
            if (!snapshot) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Cannot run subagent calls: failed to snapshot current parent session context for calls requiring initialContext=\"parent\".",
                  },
                ],
                details: makeDetails([]),
                isError: true,
              };
            }
            parentSessionSnapshotJsonl = snapshot;
          }

          return await executeCalls(
            calls,
            parentSessionSnapshotJsonl,
            persistentSessionDir,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
          );
        } finally {
          for (const id of reservedSessionIds) activeSessionIds.delete(id);
          releaseSessionLocks(lockResult.locks);
        }
      },

      renderCall: (args, theme) => renderCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderResult(result, expanded, theme),
    });

    // -----------------------------------------------------------------------
    // subagent_start — background subagent jobs
    // -----------------------------------------------------------------------

    pi.registerTool({
      name: "subagent_start",
      label: "Start background subagent",
      description: formatSubagentStartToolDescription(),
      parameters: SubagentStartParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
        const discovery = starterDiscovery.discovery;
        const { agents } = discovery;
        const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);

        // --- Root-only guard ---
        if (currentDepth > 0) {
          return {
            content: [
              {
                type: "text",
                text: "Background subagent jobs can only be started from the root parent Pi session, not from a subagent. Use the synchronous `subagent` tool for nested delegation.",
              },
            ],
            details: makeDetails([]),
            isError: true,
          };
        }

        // --- Validate calls ---
        const normalized = normalizeCalls(params.calls, ctx.cwd);
        if (normalized.error || !normalized.calls) {
          return {
            content: [{ type: "text", text: normalized.error ?? "Invalid subagent_start parameters." }],
            details: makeDetails([]),
            isError: true,
          };
        }
        const calls = normalized.calls;

        // --- Reject persistent sessions in background mode ---
        for (const call of calls) {
          if (call.sessionHandle) {
            return {
              content: [
                {
                  type: "text",
                  text: `Background subagent calls cannot use persistent sessions. calls[${call.index}] specifies session="${call.sessionHandle}". Omit \`session\` for background delegation.`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        // --- Reject initialContext "parent" when no snapshot possible ---
        for (const call of calls) {
          if (call.initialContext === "parent") {
            return {
              content: [
                {
                  type: "text",
                  text: `Background subagent calls with initialContext="parent" are not yet supported in this thin slice. calls[${call.index}] requests parent context. Use initialContext="empty" or the synchronous subagent tool.`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        // --- Check max concurrent background jobs ---
        if (getActiveBackgroundJobCount() >= MAX_BACKGROUND_JOBS) {
          return {
            content: [
              {
                type: "text",
                text: `Too many background subagent jobs already running (max ${MAX_BACKGROUND_JOBS}). Wait for a running job to complete or use the synchronous \`subagent\` tool.`,
              },
            ],
            details: makeDetails([]),
            isError: true,
          };
        }

        // --- Cycle prevention ---
        const requested = new Set(calls.map((call) => call.agent));
        if (preventCycles) {
          const cycleViolations = getCycleViolations(requested, ancestorAgentStack);
          if (cycleViolations.length > 0) {
            const stackText =
              ancestorAgentStack.length > 0
                ? ancestorAgentStack.join(" -> ")
                : "(root)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        // --- Resolve onComplete mode ---
        const onComplete: BackgroundCompletionMode =
          params.onComplete === undefined ? "trigger" : params.onComplete;

        // --- Resolve worktreeMode ---
        const worktreeMode: WorktreeMode =
          params.worktreeMode === undefined ? "shared" : params.worktreeMode;

        // --- Git checks for isolated mode ---
        if (worktreeMode === "isolated") {
          const gitError = checkGitPreconditions(ctx.cwd);
          if (gitError) {
            return {
              content: [
                {
                  type: "text",
                  text: `Cannot start background job with worktreeMode="isolated": ${gitError}\n\nUse worktreeMode="shared" (default) to run in the parent working tree, or resolve the git issue and retry.`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        // --- Create background job ---
        const jobId = generateJobId();
        const createdAt = Date.now();
        const abortController = new AbortController();

        const callStates: CallState[] = calls.map(() => ({
          phase: "queued" as const,
          toolCalls: 0,
          recentActivity: [],
        }));

        const job: BackgroundJob = {
          id: jobId,
          createdAt,
          updatedAt: createdAt,
          status: "running",
          calls,
          callStates,
          promise: Promise.resolve(),
          onComplete,
          abortController,
          worktreeMode,
          worktreeScope: params.worktreeScope,
        };

        // Populate promise with async execution.
        job.promise = runBackgroundSubagentJob(
          job,
          agents,
          ctx.cwd,
          makeDetails,
        );

        registerBackgroundJob(job);

        // --- Immediate return ---
        const callList = calls
          .map((c) => `  - ${c.agent}: ${c.prompt.slice(0, 60)}${c.prompt.length > 60 ? "..." : ""}`)
          .join("\n");

        const scopeLine = params.worktreeScope
          ? `\n**Declared scope:** ${params.worktreeScope}`
          : "";

        const worktreeNote =
          worktreeMode === "isolated"
            ? `**Isolated worktree mode:** This job will run in a separate git worktree with its own branch. Its changes do not affect the parent working tree.${scopeLine}`
            : `**Shared-worktree mode:** This job shares the parent working tree. Use \`subagent_status\` to check running jobs before making parent edits, and \`subagent_result\` to review full output before integrating changes. Give each subagent a clearly disjoint scope.${scopeLine}`;

        return {
          content: [
            {
              type: "text",
              text: `Started background subagent job \`${jobId}\` with ${calls.length} call${calls.length === 1 ? "" : "s"}.\n\n${callList}\n\nThe result will be posted to this session when complete.\n\n${worktreeNote}`,
            },
          ],
          details: makeDetails([]),
        };
      },

      renderCall: (args, theme) => renderBackgroundCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderBackgroundResult(result, expanded, theme),
    });

    // -----------------------------------------------------------------------
    // subagent_status — query background job state
    // -----------------------------------------------------------------------

    pi.registerTool({
      name: "subagent_status",
      label: "Background subagent status",
      description: formatSubagentStatusToolDescription(),
      parameters: SubagentStatusParams,

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const { jobId } = params;

        if (jobId !== undefined) {
          // Specific job lookup
          const job = getBackgroundJob(jobId);
          if (!job) {
            const ids = getAllBackgroundJobs().map((j) => `  ${j.id} (${j.status})`).join("\n");
            const hint = ids ? `Known jobs:\n${ids}` : "No background subagent jobs.";
            return {
              content: [{ type: "text", text: `Unknown background job: \`${jobId}\`.\n${hint}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: formatJobStatus(job) }],
          };
        }

        // List all jobs
        const jobs = getAllBackgroundJobs();
        return {
          content: [{ type: "text", text: formatJobList(jobs) }],
        };
      },

      renderCall: (args, theme) => renderJobStatusCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderJobStatusResult(result, expanded, theme),
    });

    // -----------------------------------------------------------------------
    // subagent_cancel — terminate a running background job
    // -----------------------------------------------------------------------

    pi.registerTool({
      name: "subagent_cancel",
      label: "Cancel background subagent",
      description: formatSubagentCancelToolDescription(),
      parameters: SubagentCancelParams,

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const { jobId, confirm } = params;

        const job = getBackgroundJob(jobId);
        if (!job) {
          return {
            content: [{ type: "text", text: `Unknown background job: \`${jobId}\`. Use \`subagent_status\` to list active jobs.` }],
            isError: true,
          };
        }

        if (job.status !== "running") {
          return {
            content: [{ type: "text", text: `Job \`${jobId}\` is already ${job.status}. Nothing to cancel.` }],
            isError: true,
          };
        }

        if (!confirm) {
          const duration = job.createdAt
            ? `${Math.round((Date.now() - job.createdAt) / 1000)}s`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Dry-run: would cancel background job \`${jobId}\` with ${job.calls.length} running call${job.calls.length === 1 ? "" : "s"}${duration ? ` (started ${duration} ago)` : ""}. Pass "confirm": true to proceed.`,
              },
            ],
            isError: true,
          };
        }

        // Proceed with cancellation
        job.status = "cancelling";
        job.updatedAt = Date.now();
        markPendingCallsCancelled(job, Date.now());
        job.abortController?.abort();

        return {
          content: [
            {
              type: "text",
              text: `Cancelling background job \`${jobId}\`...\n\nThe subagent processes will be terminated. A cancellation message will be posted when the job has stopped.`,
            },
          ],
        };
      },

      renderCall: (args, theme) => renderCancelCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderCancelResult(result, expanded, theme),
    });

    // -----------------------------------------------------------------------
    // subagent_result — retrieve full output from a completed background job
    // -----------------------------------------------------------------------

    pi.registerTool({
      name: "subagent_result",
      label: "Subagent result",
      description: formatSubagentResultToolDescription(),
      parameters: SubagentResultParams,

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const job = getBackgroundJob(params.jobId);
        if (!job) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown background job: \`${params.jobId}\`. Use \`subagent_status\` to list known jobs.`,
              },
            ],
            isError: true,
          };
        }

        if (job.status === "running" || job.status === "cancelling") {
          return {
            content: [
              {
                type: "text",
                text: `Job \`${job.id}\` is still ${job.status}. Wait for completion, then retrieve results.`,
              },
            ],
            isError: true,
          };
        }

        if (job.status === "interrupted") {
          return {
            content: [
              {
                type: "text",
                text: `Job \`${job.id}\` was interrupted (the parent process exited before it completed). No results are available.`,
              },
            ],
            isError: true,
          };
        }

        if (!job.results || job.results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Job \`${job.id}\` has no results (status: ${job.status}).`,
              },
            ],
            isError: true,
          };
        }

        const callIndex = params.callIndex;
        const callIndexError = validateCallIndex(callIndex, job.results.length - 1);
        if (callIndexError) {
          return {
            content: [{ type: "text", text: callIndexError }],
            isError: true,
          };
        }

        const maxOutputLength = params.maxOutputLength;
        const maxOutputLengthError = validateMaxOutputLength(maxOutputLength);
        if (maxOutputLengthError) {
          return {
            content: [{ type: "text", text: maxOutputLengthError }],
            isError: true,
          };
        }

        const text = formatJobResults(job, {
          callIndex,
          includeToolCalls: params.includeToolCalls ?? false,
          maxOutputLength,
        });

        return {
          content: [{ type: "text", text }],
        };
      },

      renderCall: (args, theme) => renderSubagentResultCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderSubagentResultResult(result, expanded, theme),
    });
  }

  // -----------------------------------------------------------------------
  // Call execution (synchronous)
  // -----------------------------------------------------------------------

  async function executeCalls(
    calls: NormalizedCall[],
    parentSessionSnapshotJsonl: string | undefined,
    persistentSessionDir: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    const allResults: SingleResult[] = calls.map(makePlaceholderResult);

    const emitProgress = () => {
      if (!onUpdate) return;
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      onUpdate({
        content: [
          {
            type: "text",
            text: `Subagents: ${done}/${allResults.length} done, ${running} running...`,
          },
        ],
        details: makeDetails([...allResults]),
      });
    };

    let heartbeat: NodeJS.Timeout | undefined;
    if (onUpdate) {
      emitProgress();
      heartbeat = setInterval(() => {
        if (allResults.some((r) => r.exitCode === -1)) emitProgress();
      }, CALLS_HEARTBEAT_MS);
    }

    let results: SingleResult[];
    try {
      results = await mapConcurrent(
        calls,
        MAX_CONCURRENCY,
        async (call, workerIndex) => {
          const result = await runAgent({
            cwd: defaultCwd,
            agents,
            callIndex: call.index,
            agentName: call.agent,
            prompt: call.prompt,
            callModel: call.model,
            callCwd: call.effectiveCwd,
            initialContext: call.initialContext,
            parentSessionSnapshotJsonl,
            session: call.session,
            persistentSessionDir,
            parentDepth: currentDepth,
            parentAgentStack: ancestorAgentStack,
            maxDepth,
            preventCycles,
            signal,
            onUpdate: (partial) => {
              if (partial.details?.results[0]) {
                allResults[workerIndex] = partial.details.results[0];
                emitProgress();
              }
            },
            makeDetails,
          });
          allResults[workerIndex] = result;
          emitProgress();
          return result;
        },
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const hasErrors = results.some((r) => isResultError(r));
    return {
      content: [
        {
          type: "text" as const,
          text: formatCallsSummary(results),
        },
      ],
      details: makeDetails(results),
      isError: hasErrors || undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Background job helpers
  // -----------------------------------------------------------------------

  const MAX_BACKGROUND_CONCURRENCY = 2;

  /**
   * Check git preconditions for isolated worktree mode.
   * Returns an error message if preconditions are not met, or null if OK.
   *
   * Validates:
   *  - The cwd is inside a git repository.
   *  - The working tree is clean (no uncommitted changes).
   *  - The current branch can be determined.
   */
  function checkGitPreconditions(cwd: string): string | null {
    try {
      // Check if we're in a git repository
      const isRepo = execSync("git rev-parse --git-dir", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      if (!isRepo.trim()) {
        return "Not inside a git repository.";
      }

      // Check working tree cleanliness
      const status = execSync("git status --porcelain", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      if (status.trim().length > 0) {
        const modifiedCount = status.trim().split("\n").length;
        return `Working tree has ${modifiedCount} uncommitted change${modifiedCount === 1 ? "" : "s"}. Use a clean working tree for isolated worktree mode, or use worktreeMode="shared" (default).`;
      }

      // Get current branch name
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      if (!branch.trim() || branch.trim() === "HEAD") {
        return "Not on a named branch (detached HEAD). Switch to a branch for isolated worktree mode.";
      }

      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not a git repository") || message.includes("Not a git repository")) {
        return "Not inside a git repository.";
      }
      return `Git check failed: ${message}`;
    }
  }

  /**
   * Inject a completion message into the parent session.
   */
  function postCompletionMessage(job: BackgroundJob): void {
    if (job.onComplete === "silent") return;

    pi.sendMessage(
      {
        customType: "subagent-background-result",
        display: true,
        content: [{ type: "text", text: formatBackgroundCompletion(job) }],
        details: {
          jobId: job.id,
          status: job.status,
          results: job.results,
          error: job.error,
        },
      },
      {
        deliverAs: "followUp",
        triggerTurn: job.onComplete === "trigger",
      },
    );
  }

  /**
   * Execute a background job's calls and update its state upon completion.
   */
  /**
   * Update call state from partial subagent results (streamed via onUpdate).
   */

  async function runBackgroundSubagentJob(
    job: BackgroundJob,
    agents: AgentConfig[],
    defaultCwd: string,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ): Promise<void> {
    if (job.worktreeMode === "isolated") {
      try {
        job.worktreeMetadata = createWorktree(defaultCwd, job.id);
        job.updatedAt = Date.now();
      } catch (error) {
        job.status = "failed";
        job.updatedAt = Date.now();
        job.error = error instanceof Error ? error.message : String(error);
        updateBackgroundJobStatus(job.id, "failed");
        setBackgroundJobResults(job.id, []);
        postCompletionMessage(job);
        return;
      }
    }

    try {
      const worktreeCwd = job.worktreeMetadata?.path;
      const results = await mapConcurrent(
        job.calls,
        MAX_BACKGROUND_CONCURRENCY,
        async (call, index) => {
          const cs = job.callStates[index];
          cs.phase = "spawning";
          cs.startedAt = Date.now();
          cs.phase = "running";

          const result = await runAgent({
            cwd: defaultCwd,
            agents,
            callIndex: call.index,
            agentName: call.agent,
            prompt: call.prompt,
            callModel: call.model,
            callCwd: worktreeCwd ?? call.effectiveCwd,
            initialContext: call.initialContext,
            parentSessionSnapshotJsonl: undefined,
            session: undefined,
            parentDepth: currentDepth,
            parentAgentStack: ancestorAgentStack,
            maxDepth,
            preventCycles,
            signal: job.abortController?.signal,
            onUpdate: (partial) => {
              const details = partial.details as SubagentDetails | undefined;
              if (details?.results?.[0]) {
                updateCallStateFromPartial(cs, details.results[0]);
              }
            },
            makeDetails,
          });

          // Phase transition based on result (use finishCallState to
          // preserve cancelled status if cancellation fired mid‑run).
          finishCallState(job, index, result, Date.now());
          return result;
        },
      );

      // Determine final status. Cancellation takes priority.
      if (job.status === "cancelling") {
        job.status = "cancelled";
      } else {
        const hasError = results.some((r) => isResultError(r));
        job.status = hasError ? "failed" : "completed";
      }
      job.results = results;
      job.updatedAt = Date.now();

      if (job.worktreeMode === "isolated" && job.worktreeMetadata) {
        try {
          const changedFiles = getWorktreeChangedFiles(job.worktreeMetadata.path);
          job.worktreeMetadata.changedFiles = changedFiles;
          if (changedFiles.length > 0) {
            const patchPath = createWorktreePatch(
              job.worktreeMetadata.path,
              job.worktreeMetadata.baseCommit,
              path.join(
                getRepoRoot(defaultCwd),
                ".pi-subagent",
                "jobs",
                job.id,
                "worktree.patch",
              ),
            );
            if (patchPath) job.worktreeMetadata.patchPath = patchPath;
          }
          job.updatedAt = Date.now();
        } catch (error) {
          console.warn(
            `[pi-subagent] Failed to collect worktree metadata for job "${job.id}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // Persist state and result artifact.
      updateBackgroundJobStatus(job.id, job.status as any);
      setBackgroundJobResults(job.id, results);
      if (job.status !== "cancelling") {
        const resultText = formatJobResults(job as any, {});
        persistJobResultArtifact(job.id, resultText);
      }

      postCompletionMessage(job);
    } catch (error) {
      job.status = "failed";
      job.updatedAt = Date.now();
      job.error = error instanceof Error ? error.message : String(error);
      updateBackgroundJobStatus(job.id, "failed");
      setBackgroundJobResults(job.id, []);
      postCompletionMessage(job);
    }
  }
}
