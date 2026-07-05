/**
 * Shared type definitions for the subagent extension.
 */

import type { Message } from "@earendil-works/pi-ai";
import { getFinalAssistantText } from "./runner-events.js";

/** Initial context for a newly-created subagent conversation. */
export type InitialContext = "empty" | "parent";

/** Default initial context for delegated calls. */
export const DEFAULT_INITIAL_CONTEXT: InitialContext = "empty";

/** Metadata for a named persistent subagent session. */
export interface SubagentSessionDetails {
	handle: string;
	id: string;
	name: string;
	cwd: string;
	created: boolean;
	initialContextApplied: InitialContext | null;
}

/** Normalized representation of a single subagent call (after validation). */
export interface NormalizedCall {
	index: number;
	agent: string;
	prompt: string;
	model?: string;
	effectiveCwd: string;
	initialContext: InitialContext;
	sessionHandle?: string;
	session?: SubagentSessionDetails;
}

/** Background job status. */
export type BackgroundJobStatus =
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "interrupted";

/** Lifecycle phase of a single background subagent call. */
export type CallLifecyclePhase =
  | "queued"
  | "spawning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface CallState {
  phase: CallLifecyclePhase;
  startedAt?: number;
  spawnedAt?: number;
  completedAt?: number;
  toolCalls: number;
  recentActivity: string[];
  /** Cursor into the tool-call items array, used to avoid replaying the same activity on partial updates. */
  activityCursor?: number;
}

/** Worktree execution mode for background jobs. */
export type WorktreeMode = "shared" | "isolated";

/** How to deliver completion of a background job. */
export type BackgroundCompletionMode = "silent" | "message" | "trigger";

/** Metadata about an isolated worktree for a background job. */
export interface WorktreeMetadata {
	path: string;
	branch: string;
	baseCommit: string;
	changedFiles?: string[];
	patchPath?: string;
}

/** In-memory background job tracking entry. */
export interface BackgroundJob {
	id: string;
	createdAt: number;
	updatedAt: number;
	status: BackgroundJobStatus;
	calls: NormalizedCall[];
	promise: Promise<void>;
	results?: SingleResult[];
	error?: string;
	onComplete: BackgroundCompletionMode;
	/** AbortController for cancellation. Created when the job starts. */
	abortController?: AbortController;
	/** Per-call lifecycle states, populated at job creation. */
	callStates: CallState[];

	/** Worktree execution mode (defaults to "shared" when unset). */
	worktreeMode?: WorktreeMode;
	/** Declared file/path scope for this job, if provided by the caller. */
	worktreeScope?: string;
	/** Populated when running in isolated worktree mode. */
	worktreeMetadata?: WorktreeMetadata;
}

/** Aggregated token usage from a subagent run. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Result of a single subagent call. */
export interface SingleResult {
	callIndex?: number;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	prompt: string;
	initialContext: InitialContext;
	session?: SubagentSessionDetails;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAgentEnd?: boolean;
	/** Process-level failures that should not be normalized away by semantic assistant completion. */
	processError?: boolean;
}

/** Metadata attached to every tool result for rendering. */
export interface SubagentDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** A display-friendly representation of a message part. */
export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Create an empty UsageStats object. */
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Sum usage across multiple results. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

/** Whether the child emitted a final assistant text response. */
export function hasFinalAssistantOutput(r: Pick<SingleResult, "messages">): boolean {
	return getFinalAssistantText(r.messages).trim().length > 0;
}

/** Whether the child semantically completed the run. */
export function hasSemanticCompletion(r: Pick<SingleResult, "messages" | "sawAgentEnd">): boolean {
	return Boolean(r.sawAgentEnd) && hasFinalAssistantOutput(r);
}

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isResultSuccess(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	if (r.processError) return false;
	if (hasSemanticCompletion(r)) return true;
	return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
}

/** Whether a result represents an error. */
export function isResultError(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	return !isResultSuccess(r);
}

/** Reconcile process exit status with semantic completion observed from Pi's event stream. */
export function normalizeCompletedResult(result: SingleResult, wasAborted: boolean): SingleResult {
	const hasSemanticSuccess = hasSemanticCompletion(result);

	if (wasAborted) {
		if (hasSemanticSuccess && !result.processError) {
			result.exitCode = 0;
			if (result.stopReason === "aborted") result.stopReason = undefined;
			if (result.errorMessage === "Subagent was aborted.") {
				result.errorMessage = undefined;
			}
		} else if (result.processError) {
			if (result.exitCode <= 0) result.exitCode = 1;
			if (!result.stopReason) result.stopReason = "error";
			if (!result.errorMessage && result.stderr.trim()) {
				result.errorMessage = result.stderr.trim();
			}
		} else {
			result.exitCode = 130;
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted.";
			if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
		}
		return result;
	}

	if (result.exitCode > 0) {
		if (hasSemanticSuccess && !result.processError) {
			result.exitCode = 0;
			if (result.stopReason === "error") result.stopReason = undefined;
			if (result.errorMessage === result.stderr.trim()) {
				result.errorMessage = undefined;
			}
		} else {
			if (!result.stopReason) result.stopReason = "error";
			if (!result.errorMessage && result.stderr.trim()) {
				result.errorMessage = result.stderr.trim();
			}
		}
	}

	return result;
}

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: Message[]): string {
	return getFinalAssistantText(messages);
}

/** Extract all display-worthy items from a message history. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
				}
			}
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// Subagent_result parameter validation
// ---------------------------------------------------------------------------

/** Maximum allowed value for maxOutputLength in subagent_result. */
export const MAX_OUTPUT_LENGTH_LIMIT = 50000;

/**
 * Validate callIndex for subagent_result.
 * Returns an error message string if invalid, or null if valid/absent.
 */
export function validateCallIndex(value: unknown, maxIndex: number): string | null {
	if (value === undefined) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		return `Invalid callIndex ${String(value)}. Must be a non-negative integer.`;
	}
	if (value > maxIndex) {
		return `Invalid callIndex ${value}. Job has ${maxIndex + 1} call${maxIndex === 0 ? "" : "s"} (0–${maxIndex}).`;
	}
	return null;
}

/**
 * Validate maxOutputLength for subagent_result.
 * Returns an error message string if invalid, or null if absent.
 */
export function validateMaxOutputLength(value: unknown): string | null {
	if (value === undefined) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_OUTPUT_LENGTH_LIMIT) {
		return `Invalid maxOutputLength ${String(value)}. Must be an integer from 1 to ${MAX_OUTPUT_LENGTH_LIMIT}.`;
	}
	return null;
}
