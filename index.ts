/**
 * Pi Subagent Extension
 *
 * Delegates prompts to specialized subagents, each running as an isolated `pi`
 * process. The tool accepts a single `calls` array for both one and many
 * subagent invocations.
 */

import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, STARTER_AGENT_NAME, discoverAgentsWithStarter } from "./agents.js";
import { getMisplacedBackgroundWorktreeFieldError } from "./background-params.js";
import {
  getActiveBackgroundJobCount,
  generateJobId,
  MAX_BACKGROUND_JOBS,
  registerBackgroundJob,
  getBackgroundJob,
  getAllBackgroundJobs,
  getOpenEscalations,
  setJobStoreBaseDir,
  reloadPersistedJobs,
  updateBackgroundJobStatus,
  setBackgroundJobResults,
  persistJobResultArtifact,
  persistBackgroundJob,
  appendBackgroundJobEventLine,
  readBackgroundJobEventLines,
} from "./background-jobs.js";
import {
  CALLS_SCHEMA_DESCRIPTION,
  formatAvailableSubagentsPrompt,
  formatSubagentCancelToolDescription,
  formatSubagentContinueToolDescription,
  formatSubagentPeekToolDescription,
  formatSubagentResultToolDescription,
  formatSubagentStartToolDescription,
  formatSubagentEnqueueToolDescription,
  formatSubagentGetPlanToolDescription,
  formatSubagentStatusToolDescription,
  formatSubagentToolDescription,
  formatSubagentUsageErrorExample,
  getCallFieldSchemaDescription,
} from "./contract.js";
import {
  formatBackgroundCompletion,
  formatBackgroundEscalation,
  formatCallCompletion,
  formatPlanDetail,
  formatPlanFired,
  formatJobPeek,
  formatJobList,
  formatJobResults,
  formatJobStatus,
  renderBackgroundCall,
  renderBackgroundResult,
  renderCall,
  renderCancelCall,
  renderCancelResult,
  renderContinueCall,
  renderContinueResult,
  renderJobStatusCall,
  renderJobStatusResult,
  renderSubagentPeekCall,
  renderSubagentPeekResult,
  renderResult,
  renderSubagentResultCall,
  renderSubagentResultResult,
} from "./render.js";
import { updateCallStateFromPartial } from "./background-activity.js";
import {
  markPendingCallsCancelled,
  finishCallState,
} from "./background-lifecycle.js";
import {
  getPendingPlans,
  getPlan,
  registerPlan,
  setPlanStoreBaseDir,
  reloadPersistedPlans,
  arePlanDepsTerminal,
  updatePlanStatus,
  purgeOldPlans,
} from "./plan-queue.js";
import { ensureDefaultSessionDir, getDefaultSessionDirPath } from "./session-paths.js";
import { getResultSummaryText } from "./runner-events.js";
import { mapConcurrent, runAgent } from "./runner.js";
import { acquireSessionLocks, releaseSessionLocks, type SessionLockTarget } from "./session-lock.js";
import { emitSubagentLifecycleEvent } from "./subagent-events.js";
import {
  createWorktree,
  createWorktreePatch,
  getRepoRoot,
  getWorktreeChangedFiles,
  mapRepoPathToWorktree,
} from "./worktree.js";
import {
  type BackgroundCompletionMode,
  type BackgroundJob,
  type CallState,
  type InitialContext,
  type NormalizedCall,
  type QueuedPlan,
  type SingleResult,
  type SubagentDetails,
  type SubagentSessionDetails,
  type WorktreeMode,
  DEFAULT_INITIAL_CONTEXT,
  DEFAULT_INTERACTIVE_AWAIT_MARKER,
  appendInteractiveWaitInstructions,
  createBackgroundEscalation,
  emptyUsage,
  formatBackgroundEscalationDetails,
  formatSubagentContinueAcknowledgement,
  getFinalOutput,
  isJobTerminal,
  isResultError,
  isResultSuccess,
  recordBackgroundEscalationAnswer,
  upsertBackgroundEscalation,
  validateCallIndex,
  validateMaxEvents,
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
const DEMO_AGENT_NAMES = ["explorer", STARTER_AGENT_NAME];

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
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "When true, the subagent may stop to ask the user for direction. The extension handles the internal wait marker automatically.",
      default: false,
    }),
  ),
  awaitMarker: Type.Optional(
    Type.String({
      description:
        "Advanced/debug marker override. For single-call jobs, successful output containing this marker parks the job as needs_input for subagent_continue.",
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

const SubagentPeekParams = Type.Object({
  jobId: Type.String({
    description: "ID of the background job to peek.",
  }),
  callIndex: Type.Optional(
    Type.Integer({
      description: "0-based index of a specific call to peek. Omit to peek all calls.",
      minimum: 0,
    }),
  ),
  maxEvents: Type.Optional(
    Type.Integer({
      description: "Maximum raw events to read per call (1–200). Default: 20.",
      minimum: 1,
      maximum: 200,
      default: 20,
    }),
  ),
  includeRawEvents: Type.Optional(
    Type.Boolean({
      description: "When true, include the raw JSON event tail. Default: false.",
      default: false,
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

const SubagentContinueParams = Type.Object({
  jobId: Type.Optional(
    Type.String({
      description: "ID of the background job parked in needs_input. Optional when escalationId is provided.",
    }),
  ),
  escalationId: Type.Optional(
    Type.String({
      description: "ID of the open escalation to answer. Prefer this over callIndex when hidden routing metadata is available.",
    }),
  ),
  prompt: Type.String({
    description: "Direction to send to the waiting subagent session.",
  }),
  callIndex: Type.Optional(
    Type.Integer({
      description: "0-based call index to continue. Omit to use the parked call.",
      minimum: 0,
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

const SubagentEnqueueParams = Type.Object({
  plan: Type.String({
    description:
      "The plan text describing what to do with the results. Written as if reminding the agent what it intended.",
  }),
  dependsOn: Type.Array(Type.String, {
    description:
      "One or more background job IDs to wait on. All must reach a terminal state before the plan fires.",
    minItems: 1,
  }),
  replace: Type.Optional(
    Type.Boolean({
      description:
        "If true, replace any existing queued plan that depends on exactly the same job ID set.",
      default: false,
    }),
  ),
});

const SubagentGetPlanParams = Type.Object({
  planId: Type.String({
    description: "ID of the plan to retrieve (e.g. plan_ce19fdf0).",
  }),
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

interface DemoState {
  id: string;
  cwd: string;
  filePath: string;
  agent: string;
  sessionHandle: string;
  session: SubagentSessionDetails;
  phase: "running" | "needs_input" | "completed" | "failed";
  lastOutput?: string;
  updatedAt: number;
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

/**
 * Resolve the correct default working directory for subagent tool handlers.
 *
 * Pi's `ctx.cwd` may resolve to `process.cwd()` rather than the session's actual
 * working directory (e.g. when Pi started in one directory and the session lives in
 * another). The SessionManager records the correct session cwd and is available via
 * `getCwd()` (preferred) or the session header's `cwd` field.
 *
 * Falls back to `ctx.cwd` when neither source is available.
 */
function getEffectiveSessionCwd(ctx: {
  sessionManager: { getCwd?: () => string; getHeader?: () => unknown };
  cwd: string;
}): string {
  // Prefer SessionManager.getCwd() — this is the authoritative session cwd.
  if (typeof ctx.sessionManager.getCwd === "function") {
    try {
      const cwd = ctx.sessionManager.getCwd();
      if (typeof cwd === "string" && cwd.trim().length > 0) {
        return path.resolve(cwd.trim());
      }
    } catch {
      /* fall through */
    }
  }

  // Fall back to the session header's cwd field.
  if (typeof ctx.sessionManager.getHeader === "function") {
    try {
      const header = ctx.sessionManager.getHeader();
      if (header && typeof header === "object" && "cwd" in header) {
        const sessionCwd = (header as Record<string, unknown>).cwd;
        if (typeof sessionCwd === "string" && sessionCwd.trim().length > 0) {
          return path.resolve(sessionCwd.trim());
        }
      }
    } catch {
      /* fall through */
    }
  }

  return ctx.cwd;
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

function getPersistentSessionDir(
  ctx: ExtensionExecutionContext,
  effectiveCwd?: string,
): string | undefined {
  const manager = ctx.sessionManager as unknown as {
    usesDefaultSessionDir?: () => boolean;
  };

  if (typeof manager.usesDefaultSessionDir === "function") {
    return manager.usesDefaultSessionDir() ? undefined : ctx.sessionManager.getSessionDir();
  }

  try {
    const current = path.resolve(ctx.sessionManager.getSessionDir());
    const cwd = effectiveCwd ?? ctx.cwd;
    const defaultDir = path.resolve(getDefaultSessionDirPath(cwd));
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

function getBackgroundSessionParentError(ctx: ExtensionExecutionContext): string | null {
  if (parseBoolean(process.env[SUBAGENT_TEMP_PARENT_SESSION_ENV]) === true) {
    return "Interactive background subagent jobs are not available from temporary parent-seeded subagent sessions.";
  }
  if (ctx.sessionManager.getSessionFile()) return null;
  return "Interactive background subagent jobs require a persisted parent Pi session. Run the parent without --no-session, or omit `interactive`/`awaitMarker` for a non-interactive background job.";
}

function assignBackgroundOwnedSessions(
  job: BackgroundJob,
  parentSessionId: string,
): void {
  for (const call of job.calls) {
    const handle = `background:${job.id}:call:${call.index}`;
    call.sessionHandle = handle;
    call.session = {
      handle,
      id: deriveSessionId(parentSessionId, call.effectiveCwd, call.agent, handle),
      name: formatSessionDisplayName(call.agent, handle),
      cwd: call.effectiveCwd,
      created: true,
      initialContextApplied: call.initialContext,
    };
  }
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

function commandArgsToString(args: unknown): string {
  if (Array.isArray(args)) return args.map((arg) => String(arg)).join(" ").trim();
  if (typeof args === "string") return args.trim();
  if (args === undefined || args === null) return "";
  return String(args).trim();
}

function buildDemoExplorePrompt(filePath: string): string {
  return `Explore this file: ${filePath}

Goal: identify three promising follow-up topics the user could choose for deeper exploration.

Instructions:
- Read only; do not edit files.
- Inspect the file enough to make the options specific and useful.
- Return exactly three numbered options.
- End by asking the user to choose one option.
- End your final line with exactly: AWAITING_CHOICE`;
}

function buildDemoContinuePrompt(previousOutput: string, choice: string): string {
  return `Continue the exploration demo.

Your previous response was:
${previousOutput}

The user chose or directed:
${choice}

Now explore that choice further. Use the existing session context where possible, inspect any necessary nearby files, and finish with a concise evidence-backed summary. Do not end with AWAITING_CHOICE.`;
}

function selectDemoAgent(agents: AgentConfig[]): AgentConfig | undefined {
  for (const name of DEMO_AGENT_NAMES) {
    const found = agents.find((agent) => agent.name === name);
    if (found) return found;
  }
  return undefined;
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
  const demoStates = new Map<string, DemoState>();

  let discoveredAgents: AgentConfig[] = [];

  function demoStateKey(ctx: ExtensionExecutionContext): string {
    return `${ctx.sessionManager.getSessionId()}\0${path.resolve(ctx.cwd)}`;
  }

  function postDemoMessage(text: string): void {
    pi.sendMessage(
      {
        customType: "subagent-demo",
        display: true,
        content: [{ type: "text", text }],
      },
      { deliverAs: "followUp", triggerTurn: false },
    );
  }

  // Initialize background job persistence and auto-discover agents on session start.
  pi.on("session_start", async (_event, ctx) => {
    // Set up the persistent job and plan stores under the project's .pi-subagent directory.
    setJobStoreBaseDir(ctx.cwd);
    setPlanStoreBaseDir(ctx.cwd);
    const reloadedJobs = reloadPersistedJobs();
    const reloadedPlans = reloadPersistedPlans();
    if (reloadedJobs > 0) {
      const label = reloadedJobs === 1 ? "job" : "jobs";
      const message = `Reloaded ${reloadedJobs} persisted background ${label}. Use \`subagent_status\` to inspect.`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "info");
      }
    }
    if (reloadedPlans > 0) {
      const label = reloadedPlans === 1 ? "plan" : "plans";
      const message = `Reloaded ${reloadedPlans} persisted queued ${label}.`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "info");
      }

      // Fire any pending plans whose dependencies completed in a previous session.
      const pendingPlans = getPendingPlans();
      for (const plan of pendingPlans) {
        const { ready, details } = arePlanDepsTerminal(plan, getBackgroundJob);
        if (!ready) continue;
        updatePlanStatus(plan.id, "fired");
        const depDetails = details.map((d) => {
          const job = getBackgroundJob(d.id);
          const resultCount = job?.results?.length ?? 0;
          return {
            ...d,
            summary: resultCount > 0 ? `${resultCount} result${resultCount === 1 ? "" : "s"}` : undefined,
          };
        });
        pi.sendMessage(
          {
            customType: "subagent-plan-fired",
            display: true,
            content: [{ type: "text", text: formatPlanFired(plan, depDetails) }],
            details: { planId: plan.id, plan: plan.plan },
          },
          { deliverAs: "followUp", triggerTurn: false },
        );
      }
      purgeOldPlans();
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
    pi.registerCommand("subagent-demo", {
      description:
        "Demo persisted child-session continuation: explore a file, wait for a choice, then continue the same subagent session.",
      handler: async (args: unknown, commandCtx: ExtensionCommandContext) => {
        const ctx = commandCtx as unknown as ExtensionExecutionContext;
        const key = demoStateKey(ctx);
        const input = commandArgsToString(args);
        const existing = demoStates.get(key);

        if (currentDepth > 0) {
          postDemoMessage("`/subagent-demo` can only be run from the root parent Pi session.");
          return;
        }

        const effectiveCwd = getEffectiveSessionCwd(ctx);
        const starterDiscovery = discoverAgentsWithStarter(effectiveCwd);
        const discovery = starterDiscovery.discovery;
        const agents = discovery.agents;
        const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);
        const persistentSessionDir = getPersistentSessionDir(ctx, effectiveCwd);
        const demoAgent = selectDemoAgent(agents);

        if (!demoAgent) {
          postDemoMessage(
            `Cannot run \`/subagent-demo\`: no demo exploration agent found.\n\n` +
            `Expected one of: ${DEMO_AGENT_NAMES.map((name) => `\`${name}\``).join(", ")}.`,
          );
          return;
        }

        const runDemoCall = async (
          state: DemoState,
          prompt: string,
          created: boolean,
        ): Promise<SingleResult> => {
          const call: NormalizedCall = {
            index: 0,
            agent: state.agent,
            prompt,
            effectiveCwd: state.cwd,
            initialContext: "empty",
            sessionHandle: state.sessionHandle,
            session: {
              ...state.session,
              created,
              initialContextApplied: created ? "empty" : null,
            },
          };

          const lockResult = acquireSessionLocks(
            getSessionLockTargets([call], persistentSessionDir),
          );
          if (lockResult.error) {
            throw new Error(lockResult.error);
          }

          activeSessionIds.add(call.session!.id);
          try {
            return await runAgent({
              cwd: ctx.cwd,
              agents,
              callIndex: call.index,
              agentName: call.agent,
              prompt: call.prompt,
              callModel: call.model,
              callCwd: call.effectiveCwd,
              initialContext: call.initialContext,
              parentSessionSnapshotJsonl: undefined,
              session: call.session,
              persistentSessionDir,
              parentDepth: currentDepth,
              parentAgentStack: ancestorAgentStack,
              maxDepth,
              preventCycles,
              makeDetails,
            });
          } finally {
            activeSessionIds.delete(call.session!.id);
            releaseSessionLocks(lockResult.locks);
          }
        };

        if (existing?.phase === "needs_input") {
          if (!input) {
            postDemoMessage(
              `Subagent demo \`${existing.id}\` is waiting for your choice.\n\n` +
              `${existing.lastOutput ?? "(no prior output captured)"}\n\n` +
              `Run \`/subagent-demo <choice or direction>\` to continue the same child session.`,
            );
            return;
          }

          existing.phase = "running";
          existing.updatedAt = Date.now();
          postDemoMessage(`Continuing subagent demo \`${existing.id}\` in the same child session...`);

          try {
            const result = await runDemoCall(
              existing,
              buildDemoContinuePrompt(existing.lastOutput ?? "", input),
              false,
            );
            const output = getFinalOutput(result.messages).trim() || getResultSummaryText(result);
            existing.lastOutput = output;
            existing.phase = isResultError(result) ? "failed" : "completed";
            existing.updatedAt = Date.now();

            postDemoMessage(
              `Subagent demo \`${existing.id}\` ${existing.phase}.\n\n${output}`,
            );
          } catch (error) {
            existing.phase = "failed";
            existing.updatedAt = Date.now();
            const message = error instanceof Error ? error.message : String(error);
            postDemoMessage(`Subagent demo \`${existing.id}\` failed while continuing: ${message}`);
          }
          return;
        }

        const rawFilePath = input || "runner.ts";
        const filePath = path.resolve(ctx.cwd, rawFilePath);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          postDemoMessage(
            `Cannot start subagent demo: file does not exist: ${filePath}\n\n` +
            `Usage: \`/subagent-demo [file]\`, then \`/subagent-demo <choice>\` when it asks.`,
          );
          return;
        }

        const demoId = `demo_${randomUUID().slice(0, 8)}`;
        const sessionHandle = `subagent-demo:${demoId}`;
        const session: SubagentSessionDetails = {
          handle: sessionHandle,
          id: deriveSessionId(
            ctx.sessionManager.getSessionId(),
            path.resolve(ctx.cwd),
            demoAgent.name,
            sessionHandle,
          ),
          name: formatSessionDisplayName(demoAgent.name, sessionHandle),
          cwd: path.resolve(ctx.cwd),
          created: true,
          initialContextApplied: "empty",
        };

        const state: DemoState = {
          id: demoId,
          cwd: path.resolve(ctx.cwd),
          filePath,
          agent: demoAgent.name,
          sessionHandle,
          session,
          phase: "running",
          updatedAt: Date.now(),
        };
        demoStates.set(key, state);

        postDemoMessage(
          `Starting subagent demo \`${demoId}\` with a persisted child session.\n\n` +
          `Agent: ${demoAgent.name}\n` +
          `File: ${filePath}\n` +
          `The subagent will explore the file, offer three follow-up topics, and stop at \`AWAITING_CHOICE\`.`,
        );

        try {
          const result = await runDemoCall(
            state,
            buildDemoExplorePrompt(filePath),
            true,
          );
          const output = getFinalOutput(result.messages).trim() || getResultSummaryText(result);
          state.lastOutput = output;
          state.phase = !isResultError(result) && output.includes("AWAITING_CHOICE")
            ? "needs_input"
            : isResultError(result)
              ? "failed"
              : "completed";
          state.updatedAt = Date.now();

          if (state.phase === "needs_input") {
            postDemoMessage(
              `Subagent demo \`${demoId}\` needs input.\n\n` +
              `${output}\n\n` +
              `Continue with: \`/subagent-demo <your choice or direction>\``,
            );
          } else {
            postDemoMessage(
              `Subagent demo \`${demoId}\` ${state.phase} before reaching \`AWAITING_CHOICE\`.\n\n${output}`,
            );
          }
        } catch (error) {
          state.phase = "failed";
          state.updatedAt = Date.now();
          const message = error instanceof Error ? error.message : String(error);
          postDemoMessage(`Subagent demo \`${demoId}\` failed: ${message}`);
        }
      },
    });

    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: formatSubagentToolDescription(),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const effectiveCwd = getEffectiveSessionCwd(ctx);
        const starterDiscovery = discoverAgentsWithStarter(effectiveCwd);
        const discovery = starterDiscovery.discovery;
        const { agents } = discovery;
        const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);

        const normalized = normalizeCalls(params.calls, effectiveCwd);
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

        const persistentSessionDir = getPersistentSessionDir(ctx as ExtensionExecutionContext, effectiveCwd);

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
            effectiveCwd,
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
        const effectiveCwd = getEffectiveSessionCwd(ctx);
        const starterDiscovery = discoverAgentsWithStarter(effectiveCwd);
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
        const misplacedWorktreeFieldError = getMisplacedBackgroundWorktreeFieldError(params.calls);
        if (misplacedWorktreeFieldError) {
          return {
            content: [{ type: "text", text: misplacedWorktreeFieldError }],
            details: makeDetails([]),
            isError: true,
          };
        }

        const normalized = normalizeCalls(params.calls, effectiveCwd);
        if (normalized.error || !normalized.calls) {
          return {
            content: [{ type: "text", text: normalized.error ?? "Invalid subagent_start parameters." }],
            details: makeDetails([]),
            isError: true,
          };
        }
        const calls = normalized.calls;
        const interactive = params.interactive === true;
        const callerAwaitMarker = typeof params.awaitMarker === "string"
          ? params.awaitMarker.trim()
          : undefined;
        if (params.awaitMarker !== undefined && !callerAwaitMarker) {
          return {
            content: [{ type: "text", text: "`awaitMarker` must be a non-empty string when provided." }],
            details: makeDetails([]),
            isError: true,
          };
        }
        const awaitMarker = callerAwaitMarker ?? (interactive ? DEFAULT_INTERACTIVE_AWAIT_MARKER : undefined);
        if (interactive && calls.length !== 1) {
          return {
            content: [{ type: "text", text: "`interactive: true` is currently supported only for single-call background jobs." }],
            details: makeDetails([]),
            isError: true,
          };
        }
        if (awaitMarker && calls.length !== 1) {
          return {
            content: [{ type: "text", text: "`awaitMarker` is currently supported only for single-call background jobs." }],
            details: makeDetails([]),
            isError: true,
          };
        }
        if (awaitMarker) {
          const parentError = getBackgroundSessionParentError(ctx as ExtensionExecutionContext);
          if (parentError) {
            return {
              content: [{ type: "text", text: parentError }],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        // --- Reject persistent sessions in background mode ---
        for (const call of calls) {
          if (call.sessionHandle) {
            return {
              content: [
                {
                  type: "text",
                  text: `Background subagent calls cannot use caller-supplied persistent sessions. calls[${call.index}] specifies session="${call.sessionHandle}". Omit \`session\` for background delegation; interactive jobs create their own child session automatically.`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        const displayCalls = calls.map((call) => ({
          agent: call.agent,
          prompt: call.prompt,
        }));

        if (interactive) {
          calls[0].prompt = appendInteractiveWaitInstructions(calls[0].prompt, awaitMarker!);
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
          const gitError = checkGitPreconditions(effectiveCwd);
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
          const repoRoot = getRepoRoot(effectiveCwd);
          for (const call of calls) {
            if (!mapRepoPathToWorktree(repoRoot, repoRoot, call.effectiveCwd)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Cannot start background job with worktreeMode="isolated": calls[${call.index}].cwd must be inside the git repository: ${call.effectiveCwd}`,
                  },
                ],
                details: makeDetails([]),
                isError: true,
              };
            }
          }
        }

        // --- Create background job ---
        const jobId = generateJobId();
        const createdAt = Date.now();
        const abortController = new AbortController();
        const persistentSessionDir = getPersistentSessionDir(ctx as ExtensionExecutionContext, effectiveCwd);

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
          callCompletionNotified: new Array(calls.length).fill(false),
          promise: Promise.resolve(),
          onComplete,
          abortController,
          worktreeMode,
          worktreeScope: params.worktreeScope,
          awaitMarker,
          interactive,
        };

        registerBackgroundJob(job);
        emitSubagentLifecycleEvent(pi, "pi-subagent:started", job);
        job.promise = runBackgroundSubagentJob(
          job,
          agents,
          effectiveCwd,
          ctx.sessionManager.getSessionId(),
          persistentSessionDir,
          makeDetails,
        );

        // --- Immediate return ---
        const callList = displayCalls
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
              text: `Started background subagent job \`${jobId}\` with ${calls.length} call${calls.length === 1 ? "" : "s"}.\n\n${callList}\n\n${interactive ? "This interactive job will pause for user direction if needed." : awaitMarker ? "This job will pause for `subagent_continue` if it reaches its configured wait point." : "**End your turn now.** Do not poll \`subagent_status\` — a completion message will be auto-injected when this job finishes, triggering a new assistant turn with results."}\n\n${worktreeNote}\n\n**End your turn.**`,
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
    // subagent_peek — inspect raw background event journals
    // -----------------------------------------------------------------------

    pi.registerTool({
      name: "subagent_peek",
      label: "Peek background subagent",
      description: formatSubagentPeekToolDescription(),
      parameters: SubagentPeekParams,

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const job = getBackgroundJob(params.jobId);
        if (!job) {
          const ids = getAllBackgroundJobs().map((j) => `  ${j.id} (${j.status})`).join("\n");
          const hint = ids ? `Known jobs:\n${ids}` : "No background subagent jobs.";
          return {
            content: [{ type: "text", text: `Unknown background job: \`${params.jobId}\`.\n${hint}` }],
            isError: true,
          };
        }

        const callIndex = params.callIndex;
        const callIndexError = validateCallIndex(callIndex, job.calls.length - 1);
        if (callIndexError) {
          return {
            content: [{ type: "text", text: callIndexError }],
            isError: true,
          };
        }

        const maxEvents = params.maxEvents ?? 20;
        const maxEventsError = validateMaxEvents(maxEvents);
        if (maxEventsError) {
          return {
            content: [{ type: "text", text: maxEventsError }],
            isError: true,
          };
        }

        const indices = callIndex !== undefined
          ? [callIndex]
          : job.calls.map((_call, index) => index);
        const eventLinesByCall = indices.map((index) => ({
          callIndex: index,
          lines: readBackgroundJobEventLines(job.id, index, maxEvents),
        }));

        return {
          content: [
            {
              type: "text",
              text: formatJobPeek(job, {
                callIndex,
                eventLinesByCall,
                includeRawEvents: params.includeRawEvents ?? false,
              }),
            },
          ],
        };
      },

      renderCall: (args, theme) => renderSubagentPeekCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderSubagentPeekResult(result, expanded, theme),
    });

    // -----------------------------------------------------------------------
    // subagent_continue — resume a parked background subagent session
    // -----------------------------------------------------------------------

    pi.registerTool({
      name: "subagent_continue",
      label: "Continue background subagent",
      description: formatSubagentContinueToolDescription(),
      parameters: SubagentContinueParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const effectiveCwd = getEffectiveSessionCwd(ctx);
        const starterDiscovery = discoverAgentsWithStarter(effectiveCwd);
        const discovery = starterDiscovery.discovery;
        const { agents } = discovery;
        const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);

        if (currentDepth > 0) {
          return {
            content: [
              {
                type: "text",
                text: "`subagent_continue` can only be run from the root parent Pi session.",
              },
            ],
            details: makeDetails([]),
            isError: true,
          };
        }

        let job: BackgroundJob | undefined;
        const escalationId = typeof params.escalationId === "string"
          ? params.escalationId.trim()
          : "";
        const jobId = typeof params.jobId === "string" ? params.jobId.trim() : "";

        if (!jobId && !escalationId) {
          return {
            content: [
              {
                type: "text",
                text: "`subagent_continue` requires either `jobId` or `escalationId`.",
              },
            ],
            details: makeDetails([]),
            isError: true,
          };
        }

        if (escalationId) {
          const target = getOpenEscalations().find((item) => item.escalationId === escalationId);
          if (!target) {
            const waiting = getOpenEscalations()
              .map((item) => `  ${item.escalationId} (${item.jobId} ${item.agent})`)
              .join("\n");
            const hint = waiting ? `Open escalations:\n${waiting}` : "No open subagent escalations.";
            return {
              content: [{ type: "text", text: `Unknown open escalation: \`${escalationId}\`.\n${hint}` }],
              details: makeDetails([]),
              isError: true,
            };
          }
          if (jobId && jobId !== target.jobId) {
            return {
              content: [
                {
                  type: "text",
                  text: `Escalation \`${escalationId}\` belongs to job \`${target.jobId}\`, not \`${jobId}\`.`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
          job = getBackgroundJob(target.jobId);
        } else {
          job = getBackgroundJob(jobId);
        }

        if (!job) {
          const ids = getAllBackgroundJobs().map((j) => `  ${j.id} (${j.status})`).join("\n");
          const hint = ids ? `Known jobs:\n${ids}` : "No background subagent jobs.";
          return {
            content: [{ type: "text", text: `Unknown background job: \`${jobId}\`.\n${hint}` }],
            details: makeDetails([]),
            isError: true,
          };
        }

        if (job.status !== "needs_input" || !job.waitingForInput) {
          return {
            content: [
              {
                type: "text",
                text: `Job \`${job.id}\` is ${job.status}, not needs_input. Only parked jobs can be continued.`,
              },
            ],
            details: makeDetails(job.results ?? []),
            isError: true,
          };
        }

        if (typeof params.prompt !== "string" || params.prompt.trim().length === 0) {
          return {
            content: [{ type: "text", text: "`prompt` must be a non-empty string." }],
            details: makeDetails(job.results ?? []),
            isError: true,
          };
        }

        if (escalationId && job.waitingForInput.id !== escalationId) {
          return {
            content: [
              {
                type: "text",
                text: `Escalation \`${escalationId}\` is no longer open on job \`${job.id}\`.`,
              },
            ],
            details: makeDetails(job.results ?? []),
            isError: true,
          };
        }

        const callIndex = escalationId
          ? job.waitingForInput.callIndex
          : params.callIndex ?? job.waitingForInput.callIndex;
        const callIndexError = validateCallIndex(callIndex, job.calls.length - 1);
        if (callIndexError) {
          return {
            content: [{ type: "text", text: callIndexError }],
            details: makeDetails(job.results ?? []),
            isError: true,
          };
        }
        if (callIndex !== job.waitingForInput.callIndex) {
          return {
            content: [
              {
                type: "text",
                text: `Job \`${job.id}\` is waiting on call ${job.waitingForInput.callIndex}. Continue that call or omit \`callIndex\`.`,
              },
            ],
            details: makeDetails(job.results ?? []),
            isError: true,
          };
        }

        const originalCall = job.calls[callIndex];
        if (!originalCall.session) {
          return {
            content: [
              {
                type: "text",
                text: `Job \`${job.id}\` has no job-owned session metadata for call ${callIndex}; it cannot be continued.`,
              },
            ],
            details: makeDetails(job.results ?? []),
            isError: true,
          };
        }

        if (getActiveBackgroundJobCount() >= MAX_BACKGROUND_JOBS) {
          return {
            content: [
              {
                type: "text",
                text: `Too many background subagent jobs already running (max ${MAX_BACKGROUND_JOBS}). Wait for a running job to complete, then retry \`subagent_continue\`.`,
              },
            ],
            details: makeDetails(job.results ?? []),
            isError: true,
          };
        }

        const persistentSessionDir = getPersistentSessionDir(ctx as ExtensionExecutionContext, effectiveCwd);
        const continuationCall: NormalizedCall = {
          ...originalCall,
          prompt: params.prompt,
          initialContext: "empty",
          session: {
            ...originalCall.session,
            created: false,
            initialContextApplied: null,
          },
        };
        const now = Date.now();
        const answeredEscalation = recordBackgroundEscalationAnswer(
          job.waitingForInput,
          params.prompt,
          now,
        );
        job.escalations = upsertBackgroundEscalation(job.escalations, answeredEscalation);
        job.waitingForInput = undefined;
        job.calls[callIndex] = continuationCall;
        job.status = "running";
        job.abortController = new AbortController();
        job.updatedAt = now;
        job.callStates[callIndex] = {
          phase: "queued",
          toolCalls: 0,
          recentActivity: [],
        };
        persistBackgroundJob(job);
        emitSubagentLifecycleEvent(pi, "pi-subagent:continued", job, {
          callIndex,
          escalation: answeredEscalation,
          answer: params.prompt,
        });

        job.promise = continueBackgroundSubagentJob(
          job,
          continuationCall,
          callIndex,
          agents,
          effectiveCwd,
          persistentSessionDir,
          makeDetails,
        );
        persistBackgroundJob(job);

        return {
          content: [
            {
              type: "text",
              text: formatSubagentContinueAcknowledgement(originalCall.agent),
            },
          ],
          details: {
            ...makeDetails(job.results ?? []),
            jobId: job.id,
            escalationId: answeredEscalation.id,
            callIndex,
            status: "running",
          },
        };
      },

      renderCall: (args, theme) => renderContinueCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderContinueResult(result, expanded, theme),
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
        const now = Date.now();
        job.status = "cancelling";
        job.updatedAt = now;
        markPendingCallsCancelled(job, now);
        persistBackgroundJob(job);
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

    // -----------------------------------------------------------------------
    // subagent_enqueue — store a plan to fire when background jobs complete
    // -----------------------------------------------------------------------

    pi.registerTool({
      name: "subagent_enqueue",
      label: "Subagent enqueue plan",
      description: formatSubagentEnqueueToolDescription(),
      parameters: SubagentEnqueueParams,

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        // Validate dependsOn job IDs exist
        const unknownJobs: string[] = [];
        for (const jobId of params.dependsOn) {
          const job = getBackgroundJob(jobId);
          if (!job) {
            unknownJobs.push(jobId);
          }
        }

        if (unknownJobs.length > 0) {
          const known = getAllBackgroundJobs()
            .map((j) => `  ${j.id} (${j.status})`)
            .join("\n");
          const hint = known ? `Known jobs:\n${known}` : "No background subagent jobs.";
          return {
            content: [
              {
                type: "text",
                text: `Unknown background job${unknownJobs.length === 1 ? "" : "s"}: ${unknownJobs.join(", ")}.\n${hint}`,
              },
            ],
            isError: true,
          };
        }

        // Register the plan
        const plan = registerPlan(
          params.plan,
          params.dependsOn,
          params.replace === true,
        );

        // Check if all deps are already terminal — fire immediately
        const { ready, details } = arePlanDepsTerminal(plan, getBackgroundJob);

        if (ready) {
          updatePlanStatus(plan.id, "fired");
          purgeOldPlans();

          // Build dependency summaries
          const depDetails = details.map((d) => ({
            ...d,
            summary: getBackgroundJob(d.id)?.results
              ? `${getBackgroundJob(d.id)!.results!.length} result${getBackgroundJob(d.id)!.results!.length === 1 ? "" : "s"}`
              : undefined,
          }));

          const planMessage = formatPlanFired(plan, depDetails);

          return {
            content: [
              {
                type: "text",
                text: `Queued plan \`${plan.id}\` — all dependencies are already terminal, plan fired immediately.\n\n${planMessage}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Queued plan \`${plan.id}\` with ${plan.dependsOn.length} dependenc${plan.dependsOn.length === 1 ? "y" : "ies"}. The plan will fire when all background jobs complete.\n\nPlan: "${plan.plan}"`,
            },
          ],
        };
      },
    });

    // -----------------------------------------------------------------------
    // subagent_get_plan — retrieve stored plan text
    // -----------------------------------------------------------------------

    pi.registerTool({
      name: "subagent_get_plan",
      label: "Subagent get plan",
      description: formatSubagentGetPlanToolDescription(),
      parameters: SubagentGetPlanParams,

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const plan = getPlan(params.planId);
        if (!plan) {
          return {
            content: [{ type: "text", text: `Unknown plan: \`${params.planId}\`. Use \`subagent_status\` to list active plans.` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: formatPlanDetail(plan) }],
        };
      },
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
  function postCompletionMessage(job: BackgroundJob, options?: { callLevel?: boolean }): void {
    if (job.onComplete === "silent") return;

    if (job.status === "needs_input" && job.waitingForInput) {
      const details = formatBackgroundEscalationDetails(job);
      pi.sendMessage(
        {
          customType: "subagent-escalation",
          display: true,
          content: [{ type: "text", text: formatBackgroundEscalation(job) }],
          details,
        },
        {
          deliverAs: "followUp",
          triggerTurn: job.onComplete === "trigger",
        },
      );
      return;
    }

    const isCallLevel = options?.callLevel === true;
    pi.sendMessage(
      {
        customType: "subagent-background-result",
        display: true,
        content: [{ type: "text", text: formatBackgroundCompletion(job, { callLevel: isCallLevel }) }],
        details: {
          jobId: job.id,
          status: job.status,
          results: job.results,
          error: job.error,
          callLevel: isCallLevel,
        },
      },
      {
        deliverAs: "followUp",
        triggerTurn: job.onComplete === "trigger",
      },
    );

    // After the job completion message, check if any queued plans are now ready to fire.
    processPlanQueue(job.id);
  }

  /**
   * Send a per-call completion notification for an individual call within a multi-call job.
   * Fires as soon as the call finishes, while siblings may still be running.
   */
  function postCallCompletion(
    job: BackgroundJob,
    result: SingleResult,
    callIndex: number,
  ): void {
    if (job.onComplete === "silent") return;

    job.callCompletionNotified![callIndex] = true;

    pi.sendMessage(
      {
        customType: "subagent-call-completed",
        display: true,
        content: [{ type: "text", text: formatCallCompletion(job, result, callIndex) }],
        details: {
          jobId: job.id,
          callIndex,
          agent: result.agent,
          status: job.status,
        },
      },
      {
        deliverAs: "followUp",
        triggerTurn: job.onComplete === "trigger",
      },
    );
  }

  /**
   * Check all pending plans whose dependencies include the given completed job ID.
   * If all deps of a plan are terminal, mark the plan as fired and inject a consolidated
   * plan-fired message into the parent session.
   */
  function processPlanQueue(completedJobId: string): void {
    const pendingPlans = getPendingPlans();
    if (pendingPlans.length === 0) return;

    for (const plan of pendingPlans) {
      if (!plan.dependsOn.includes(completedJobId)) continue;

      const { ready, details } = arePlanDepsTerminal(plan, getBackgroundJob);
      if (!ready) continue;

      // Mark as fired
      updatePlanStatus(plan.id, "fired");

      // Build dependency summaries with result sizes
      const depDetails = details.map((d) => {
        const job = getBackgroundJob(d.id);
        const resultCount = job?.results?.length ?? 0;
        const summary =
          resultCount > 0
            ? `${resultCount} result${resultCount === 1 ? "" : "s"}`
            : undefined;
        return { ...d, summary };
      });

      // Inject plan-fired message (non-triggering — the job completion already wakes the agent)
      pi.sendMessage(
        {
          customType: "subagent-plan-fired",
          display: true,
          content: [{ type: "text", text: formatPlanFired(plan, depDetails) }],
          details: {
            planId: plan.id,
            plan: plan.plan,
          },
        },
        {
          deliverAs: "followUp",
          triggerTurn: false,
        },
      );
    }

    // Clean up old fired plans from disk
    purgeOldPlans();
  }

  function emitTerminalSubagentLifecycleEvent(job: BackgroundJob): void {
    if (job.status === "completed") {
      emitSubagentLifecycleEvent(pi, "pi-subagent:completed", job);
    } else if (job.status === "failed") {
      emitSubagentLifecycleEvent(pi, "pi-subagent:failed", job);
    } else if (job.status === "cancelled") {
      emitSubagentLifecycleEvent(pi, "pi-subagent:cancelled", job);
    }
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
    parentSessionId: string,
    persistentSessionDir: string | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ): Promise<void> {
    if (job.worktreeMode === "isolated") {
      try {
        const repoRoot = getRepoRoot(defaultCwd);
        job.worktreeMetadata = createWorktree(defaultCwd, job.id);
        for (const call of job.calls) {
          const worktreeCallCwd = mapRepoPathToWorktree(
            repoRoot,
            job.worktreeMetadata.path,
            call.effectiveCwd,
          );
          if (!worktreeCallCwd) {
            throw new Error(
              `calls[${call.index}].cwd must be inside the git repository for isolated worktree mode: ${call.effectiveCwd}`,
            );
          }
          if (!fs.existsSync(worktreeCallCwd) || !fs.statSync(worktreeCallCwd).isDirectory()) {
            throw new Error(
              `calls[${call.index}].cwd does not exist in isolated worktree: ${worktreeCallCwd}`,
            );
          }
          call.effectiveCwd = worktreeCallCwd;
        }
        job.updatedAt = Date.now();
        persistBackgroundJob(job);
      } catch (error) {
        job.status = "failed";
        job.updatedAt = Date.now();
        job.error = error instanceof Error ? error.message : String(error);
        updateBackgroundJobStatus(job.id, "failed");
        setBackgroundJobResults(job.id, []);
        emitSubagentLifecycleEvent(pi, "pi-subagent:failed", job);
        postCompletionMessage(job);
        return;
      }
    }

    try {
      if (job.awaitMarker) {
        assignBackgroundOwnedSessions(job, parentSessionId);
        try {
          await resolveSessionCreationState(job.calls, persistentSessionDir);
        } catch (error) {
          throw new Error(
            `Failed to inspect existing background subagent sessions: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        job.updatedAt = Date.now();
        persistBackgroundJob(job);
      }

      const results = await mapConcurrent(
        job.calls,
        MAX_BACKGROUND_CONCURRENCY,
        async (call, index) => {
          const result = await runBackgroundCall(
            job,
            call,
            index,
            agents,
            defaultCwd,
            persistentSessionDir,
            makeDetails,
          );
          // Fire per-call notification immediately for multi-call jobs
          if (job.calls.length > 1) {
            postCallCompletion(job, result, index);
          }
          return result;
        },
      );

      // Determine final status. Cancellation takes priority.
      if (job.status === "cancelling") {
        job.status = "cancelled";
      } else {
        const hasError = results.some((r) => isResultError(r));
        const waitingCallIndex = getAwaitingInputCallIndex(job, results);
        if (!hasError && waitingCallIndex !== null) {
          const now = Date.now();
          job.status = "needs_input";
          job.waitingForInput = createBackgroundEscalation(
            results[waitingCallIndex],
            waitingCallIndex,
            job.awaitMarker!,
            now,
          );
          job.escalations = upsertBackgroundEscalation(job.escalations, job.waitingForInput);
          const cs = job.callStates[waitingCallIndex];
          cs.phase = "needs_input";
          cs.completedAt = now;
        } else {
          job.status = hasError ? "failed" : "completed";
          if (job.waitingForInput?.status === "open") {
            job.waitingForInput = undefined;
          }
        }
      }
      job.results = results;
      job.updatedAt = Date.now();
      if (job.status === "needs_input" && job.waitingForInput) {
        emitSubagentLifecycleEvent(pi, "pi-subagent:escalated", job, {
          escalation: job.waitingForInput,
        });
      }

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

      emitTerminalSubagentLifecycleEvent(job);

      postCompletionMessage(job, { callLevel: job.calls.length > 1 });
    } catch (error) {
      job.status = "failed";
      job.updatedAt = Date.now();
      job.error = error instanceof Error ? error.message : String(error);
      updateBackgroundJobStatus(job.id, "failed");
      setBackgroundJobResults(job.id, []);
      emitSubagentLifecycleEvent(pi, "pi-subagent:failed", job);
      postCompletionMessage(job, { callLevel: job.callCompletionNotified?.some(Boolean) ?? false });
    }
  }

  async function continueBackgroundSubagentJob(
    job: BackgroundJob,
    call: NormalizedCall,
    callIndex: number,
    agents: AgentConfig[],
    defaultCwd: string,
    persistentSessionDir: string | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ): Promise<void> {
    try {
      const result = await runBackgroundCall(
        job,
        call,
        callIndex,
        agents,
        defaultCwd,
        persistentSessionDir,
        makeDetails,
      );

      const results = job.results ? [...job.results] : [];
      results[callIndex] = result;

      if (job.status === "cancelling") {
        job.status = "cancelled";
      } else if (isResultError(result)) {
        job.status = "failed";
        if (job.waitingForInput?.status === "open") {
          job.waitingForInput = undefined;
        }
      } else if (job.awaitMarker && getFinalOutput(result.messages).includes(job.awaitMarker)) {
        const now = Date.now();
        job.status = "needs_input";
        job.waitingForInput = createBackgroundEscalation(
          result,
          callIndex,
          job.awaitMarker,
          now,
        );
        job.escalations = upsertBackgroundEscalation(job.escalations, job.waitingForInput);
        job.callStates[callIndex].phase = "needs_input";
        job.callStates[callIndex].completedAt = now;
      } else {
        job.status = "completed";
        if (job.waitingForInput?.status === "open") {
          job.waitingForInput = undefined;
        }
      }

      job.results = results;
      job.updatedAt = Date.now();
      if (job.status === "needs_input" && job.waitingForInput) {
        emitSubagentLifecycleEvent(pi, "pi-subagent:escalated", job, {
          escalation: job.waitingForInput,
        });
      }

      if (job.worktreeMode === "isolated" && job.worktreeMetadata) {
        collectWorktreeMetadata(job, defaultCwd);
      }

      updateBackgroundJobStatus(job.id, job.status as any);
      setBackgroundJobResults(job.id, results);
      const resultText = formatJobResults(job as any, {});
      persistJobResultArtifact(job.id, resultText);
      emitTerminalSubagentLifecycleEvent(job);
      postCompletionMessage(job);
    } catch (error) {
      job.status = "failed";
      job.updatedAt = Date.now();
      job.error = error instanceof Error ? error.message : String(error);
      updateBackgroundJobStatus(job.id, "failed");
      setBackgroundJobResults(job.id, job.results ?? [], job.error);
      emitSubagentLifecycleEvent(pi, "pi-subagent:failed", job);
      postCompletionMessage(job);
    }
  }

  async function runBackgroundCall(
    job: BackgroundJob,
    call: NormalizedCall,
    index: number,
    agents: AgentConfig[],
    defaultCwd: string,
    persistentSessionDir: string | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ): Promise<SingleResult> {
    const cs = job.callStates[index];
    cs.phase = "spawning";
    cs.startedAt = Date.now();
    cs.completedAt = undefined;
    cs.phase = "running";
    persistBackgroundJob(job);

    const lockResult = acquireSessionLocks(
      getSessionLockTargets([call], persistentSessionDir),
    );
    if (lockResult.error) {
      const result: SingleResult = {
        ...makePlaceholderResult(call),
        exitCode: 1,
        stderr: lockResult.error,
        stopReason: "error",
        errorMessage: lockResult.error,
        processError: true,
      };
      finishCallState(job, index, result, Date.now());
      return result;
    }

    const reservedSessionId = call.session?.id;
    if (reservedSessionId) activeSessionIds.add(reservedSessionId);

    try {
      const result = await runAgent({
        cwd: defaultCwd,
        agents,
        callIndex: call.index,
        agentName: call.agent,
        prompt: call.prompt,
        callModel: call.model,
        callCwd: call.effectiveCwd,
        initialContext: call.initialContext,
        parentSessionSnapshotJsonl: undefined,
        session: call.session,
        persistentSessionDir,
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
        onEvent: (_event, rawLine) => {
          appendBackgroundJobEventLine(job.id, index, rawLine);
        },
        makeDetails,
      });

      finishCallState(job, index, result, Date.now());
      persistBackgroundJob(job);
      return result;
    } finally {
      if (reservedSessionId) activeSessionIds.delete(reservedSessionId);
      releaseSessionLocks(lockResult.locks);
    }
  }

  function getAwaitingInputCallIndex(job: BackgroundJob, results: SingleResult[]): number | null {
    if (!job.awaitMarker) return null;
    for (const [index, result] of results.entries()) {
      if (isResultError(result)) continue;
      if (getFinalOutput(result.messages).includes(job.awaitMarker)) return index;
    }
    return null;
  }

  function collectWorktreeMetadata(job: BackgroundJob, defaultCwd: string): void {
    if (!job.worktreeMetadata) return;
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
}
