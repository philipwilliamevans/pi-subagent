/**
 * TUI rendering for subagent tool calls and results.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getProcessErrorText, getResultSummaryText } from "./runner-events.js";
import {
	type BackgroundArtifact,
	type BackgroundArtifactKind,
	type BackgroundJob,
	type BackgroundJobStatus,
	type BackgroundOpenEscalation,
	type CallState,
	type DisplayItem,
	type InitialContext,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
	type WorktreeMode,
	aggregateUsage,
	getDisplayItems,
	getFinalOutput,
	isJobTerminal,
	isResultError,
	isResultSuccess,
} from "./types.js";

const COLLAPSED_LINE_COUNT = 8;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Partial<UsageStats>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function stripInteractiveMarker(text: string, marker: string | undefined): string {
	if (!marker) return text;
	return text.split(marker).join("").replace(/[ \t]+\n/g, "\n").trimEnd();
}

function getBackgroundResultSummary(job: BackgroundJob, result: SingleResult): string {
	const summary = getResultSummaryText(result);
	return job.interactive ? stripInteractiveMarker(summary, job.awaitMarker) : summary;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function oneLine(text: unknown): string {
	return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function truncateOneLine(text: string, maxLen: number): string {
	return truncate(oneLine(text), maxLen);
}

function getResultPrompt(result: SingleResult & { task?: unknown }): string {
	if (typeof result.prompt === "string") return result.prompt;
	if (typeof result.task === "string") return result.task;
	return "";
}

type ThemeFg = (color: string, text: string) => string;

function formatToolCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const pathArg = (args.file_path || args.path || "...") as string;

	switch (toolName) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			return fg("muted", "$ ") + fg("toolOutput", truncate(cmd, 60));
		}
		case "read": {
			let text = fg("accent", shortenPath(pathArg));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const lines = ((args.content || "") as string).split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(pathArg));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenPath(pathArg));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenPath((args.path || ".") as string));
		case "find":
			return fg("muted", "find ") + fg("accent", (args.pattern || "*") as string) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${(args.pattern || "") as string}/`) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		default:
			return fg("accent", toolName) + fg("dim", ` ${truncate(JSON.stringify(args), 50)}`);
	}
}

function formatInitialContext(context?: InitialContext): string {
	return context === "parent" ? "parent" : "empty";
}

function formatResultLabel(r: SingleResult, fallbackIndex: number): string {
	const displayIndex = (r.callIndex ?? fallbackIndex) + 1;
	const sessionText = r.session ? ` session=${oneLine(r.session.handle)}` : "";
	return `${displayIndex}: ${r.agent}${sessionText}`;
}

function formatInitialContextStatus(r: SingleResult): string {
	if (!r.session) return formatInitialContext(r.initialContext);
	if (r.session.initialContextApplied) {
		return `${formatInitialContext(r.session.initialContextApplied)} applied`;
	}
	return `${formatInitialContext(r.initialContext)} requested, ignored (continued session)`;
}

// ---------------------------------------------------------------------------
// Artifact derivation and formatting
// ---------------------------------------------------------------------------

/**
 * Derive a stable artifact ID from a job ID and artifact kind.
 */
function artifactId(jobId: string, kind: BackgroundArtifactKind, suffix?: string): string {
  return suffix ? `${jobId}-${kind}-${suffix}` : `${jobId}-${kind}`;
}

/**
 * Derive structured artifacts from existing job fields at render time.
 *
 * The result artifact gets a stable id that can be referenced externally.
 * Other artifact types are derived from worktree metadata, escalations, etc.
 *
 * Legacy jobs without artifacts render correctly because this derivation
 * runs every time and handles partial/missing fields gracefully.
 */
export function deriveArtifacts(job: BackgroundJob): BackgroundArtifact[] {
  const now = job.updatedAt || Date.now();
  const artifacts: BackgroundArtifact[] = [];

  // Result artifact — from terminal results
  if (job.results && job.results.length > 0 && isJobTerminal(job.status)) {
    artifacts.push({
      id: artifactId(job.id, "result"),
      kind: "result",
      label: "result",
      value: `${job.results.filter((r) => !isResultError(r)).length}/${job.results.length} calls`,
      createdAt: now,
    });
  }

  // Event journal artifact — if any call has activity
  if (job.callStates) {
    const totalToolCalls = job.callStates.reduce((sum, cs) => sum + (cs?.toolCalls || 0), 0);
    if (totalToolCalls > 0) {
      artifacts.push({
        id: artifactId(job.id, "event_journal"),
        kind: "event_journal",
        label: "event journal",
        count: totalToolCalls,
        createdAt: now,
      });
    }
  }

  // Worktree artifacts — from worktree metadata
  const meta = job.worktreeMetadata;
  if (meta) {
    if (meta.path) {
      artifacts.push({
        id: artifactId(job.id, "worktree"),
        kind: "worktree",
        label: "worktree",
        path: meta.path,
        createdAt: now,
      });
    }
    if (meta.branch) {
      artifacts.push({
        id: artifactId(job.id, "branch"),
        kind: "branch",
        label: "branch",
        value: meta.branch,
        createdAt: now,
      });
    }
    if (meta.patchPath) {
      artifacts.push({
        id: artifactId(job.id, "patch"),
        kind: "patch",
        label: "patch",
        path: meta.patchPath,
        createdAt: now,
      });
    }
    if (meta.changedFiles && meta.changedFiles.length > 0) {
      artifacts.push({
        id: artifactId(job.id, "changed_files"),
        kind: "changed_files",
        label: "changed files",
        count: meta.changedFiles.length,
        createdAt: now,
      });
    }
  }

  // Escalation artifacts — from escalation history
  if (job.escalations && job.escalations.length > 0) {
    for (const esc of job.escalations) {
      artifacts.push({
        id: artifactId(job.id, "escalation", esc.id),
        kind: "escalation",
        label: `escalation ${esc.id}`,
        value: esc.status,
        createdAt: esc.createdAt || now,
        metadata: { callIndex: esc.callIndex, status: esc.status },
      });
    }
  }

  return artifacts;
}

/**
 * Compact artifact summary for completion notifications and fleet rows.
 * Returns a human-readable string like "result, patch, 4 files" or empty.
 */
export function formatArtifactSummary(job: BackgroundJob): string {
  const artifacts = deriveArtifacts(job);
  if (artifacts.length === 0) return "";

  const parts: string[] = [];

  for (const art of artifacts) {
    switch (art.kind) {
      case "result":
        parts.push("result");
        break;
      case "patch":
        parts.push("patch");
        break;
      case "branch":
        parts.push("branch");
        break;
      case "changed_files":
        parts.push(`${art.count ?? "?"} files`);
        break;
      case "worktree":
        parts.push("worktree");
        break;
      case "event_journal":
        parts.push(`${art.count ?? "?"} events`);
        break;
      case "escalation":
        // Skip listing individual escalations in compact summary
        break;
      case "plan":
        parts.push("plan");
        break;
    }
  }

  return parts.join(", ");
}

/**
 * If a completed background job has a persisted session that can be continued
 * via the foreground \`subagent\` tool, return a hint showing the session handle.
 * Returns empty string if there is no usable session.
 */
export function formatSessionContinueHint(job: BackgroundJob): string {
  if (job.status !== "completed") return "";
  if (!job.calls || job.calls.length === 0) return "";

  // Find the first call with a session handle
  const firstCall = job.calls.find((c) => c.sessionHandle);
  if (!firstCall?.sessionHandle) return "";

  const agentName = firstCall.agent;
  return `continue: subagent session "${firstCall.sessionHandle}" agent ${agentName}`;
}

/**
 * Detailed artifact listing for job detail view (subagent_status { jobId }).
 * Shows each artifact's kind, path/value, and count.
 */
export function formatArtifactDetail(job: BackgroundJob): string {
  const artifacts = deriveArtifacts(job);
  if (artifacts.length === 0) return "No artifacts.";

  const lines: string[] = ["Artifacts"];
  for (const art of artifacts) {
    const parts: string[] = [`  ${art.label}`];
    if (art.path) parts.push(shortenPath(art.path));
    if (art.value) parts.push(art.value);
    if (art.count !== undefined) parts.push(String(art.count));
    lines.push(parts.join("  "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared rendering building blocks
// ---------------------------------------------------------------------------

function splitOutputLines(text: string): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function countDisplayLines(items: DisplayItem[]): number {
	let count = 0;
	for (const item of items) {
		count += item.type === "text" ? splitOutputLines(item.text).length : 1;
	}
	return count;
}

function renderDisplayItems(
	items: DisplayItem[],
	expanded: boolean,
	theme: { fg: ThemeFg },
	limit?: number,
): string {
	const lines: string[] = [];
	for (const item of items) {
		if (item.type === "text") {
			for (const line of splitOutputLines(item.text)) {
				lines.push(theme.fg("toolOutput", line));
			}
		} else {
			lines.push(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)));
		}
	}

	const shouldTail = !expanded && typeof limit === "number";
	const toShow = shouldTail ? lines.slice(-limit) : lines;
	const skipped = shouldTail && lines.length > limit ? lines.length - limit : 0;

	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier lines\n`);
	text += toShow.join("\n");
	return text.trimEnd();
}

function statusIcon(r: SingleResult, theme: { fg: ThemeFg }): string {
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	return isResultError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

// ---------------------------------------------------------------------------
// renderCall — shown while the tool is being invoked
// ---------------------------------------------------------------------------

export function renderCall(args: Record<string, any>, theme: { fg: ThemeFg; bold: (s: string) => string }): Text {
	const calls = Array.isArray(args.calls) ? args.calls : [];
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `${calls.length || "?"} call${calls.length === 1 ? "" : "s"}`);

	for (const call of calls.slice(0, 3)) {
		const agent = typeof call.agent === "string" ? call.agent : "...";
		const session = typeof call.session === "string" && call.session.trim()
			? theme.fg("muted", ` session=${oneLine(call.session)}`)
			: "";
		const model = typeof call.model === "string" && call.model.trim()
			? theme.fg("muted", ` model=${oneLine(call.model)}`)
			: "";
		const context = call.initialContext === "parent"
			? theme.fg("warning", " parent")
			: "";
		const preview = typeof call.prompt === "string" ? truncate(oneLine(call.prompt), 45) : "...";
		text += `\n  ${theme.fg("accent", agent)}${session}${model}${context}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (calls.length > 3) text += `\n  ${theme.fg("muted", `... +${calls.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult — shown after the tool completes
// ---------------------------------------------------------------------------

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container | Text {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "(no output)", 0, 0);
	}

	return expanded
		? renderCallsExpanded(details, theme)
		: renderCallsCollapsed(details, theme);
}

function renderCallsExpanded(
	details: SubagentDetails,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();
	const running = details.results.filter((r) => r.exitCode === -1).length;
	const successCount = details.results.filter((r) => isResultSuccess(r)).length;
	const failCount = details.results.filter((r) => isResultError(r)).length;
	const icon = running > 0
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");

	const status = running > 0
		? `${successCount + failCount}/${details.results.length} done, ${running} running`
		: `${successCount}/${details.results.length} succeeded`;

	container.addChild(
		new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", status)}`,
			0,
			0,
		),
	);

	for (const [index, r] of details.results.entries()) {
		const rIcon = statusIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);
		const processErrorText = getProcessErrorText(r);
		const label = formatResultLabel(r, index);

		container.addChild(new Spacer(1));
		container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", label)} ${rIcon}`, 0, 0));
		container.addChild(new Text(theme.fg("muted", "Source: ") + theme.fg("dim", r.agentSource), 0, 0));
		container.addChild(new Text(theme.fg("muted", "Initial context: ") + theme.fg("dim", formatInitialContextStatus(r)), 0, 0));
		if (r.session) {
			const sessionStatus = r.session.created ? "created" : "continued";
			container.addChild(new Text(theme.fg("muted", "Session: ") + theme.fg("dim", `${r.session.handle} (${sessionStatus}, id ${r.session.id})`), 0, 0));
			container.addChild(new Text(theme.fg("muted", "Session cwd: ") + theme.fg("dim", shortenPath(r.session.cwd)), 0, 0));
		}
		container.addChild(new Text(theme.fg("muted", "Prompt: ") + theme.fg("dim", oneLine(getResultPrompt(r))), 0, 0));

		for (const item of displayItems) {
			if (item.type === "toolCall") {
				container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
			}
		}

		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		} else if (r.exitCode === -1) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "(running...)"), 0, 0));
		} else if (isResultError(r)) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("error", getResultSummaryText(r)), 0, 0));
		}

		if (processErrorText && finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("error", processErrorText), 0, 0));
		}

		const taskUsage = formatUsage(r.usage, r.model);
		if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
	}

	const totalUsage = formatUsage(aggregateUsage(details.results));
	if (totalUsage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
	}

	return container;
}

function renderCallsCollapsed(
	details: SubagentDetails,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const running = details.results.filter((r) => r.exitCode === -1).length;
	const successCount = details.results.filter((r) => isResultSuccess(r)).length;
	const failCount = details.results.filter((r) => isResultError(r)).length;
	const icon = running > 0
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = running > 0
		? `${successCount + failCount}/${details.results.length} done, ${running} running`
		: `${successCount}/${details.results.length} succeeded`;

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", status)}`;

	for (const [index, r] of details.results.entries()) {
		const rIcon = statusIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const processErrorText = getProcessErrorText(r);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", formatResultLabel(r, index))} ${rIcon}`;
		if (displayItems.length === 0) {
			text += `\n${theme.fg(r.exitCode === -1 ? "muted" : isResultError(r) ? "error" : "muted", r.exitCode === -1 ? "(running...)" : getResultSummaryText(r))}`;
		} else {
			text += `\n${renderDisplayItems(displayItems, false, theme, COLLAPSED_LINE_COUNT)}`;
			if (processErrorText) text += `\n${theme.fg("error", processErrorText)}`;
			if (countDisplayLines(displayItems) > COLLAPSED_LINE_COUNT) {
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
		}
	}

	if (running === 0) {
		const totalUsage = formatUsage(aggregateUsage(details.results));
		if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
	}

	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Background subagent job formatting and rendering
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

function formatElapsed(createdAt: number, updatedAt: number): string {
	return formatDuration(updatedAt - createdAt);
}

function formatAge(createdAt: number): string {
	return formatDuration(Date.now() - createdAt);
}

function formatCallStatusLabel(r: SingleResult | undefined): string {
	if (!r) return "queued";
	if (r.exitCode === -1) return "running";
	if (r.stopReason === "aborted") return "cancelled";
	if (isResultError(r)) return "failed";
	return "completed";
}

/**
 * Compact summary of a background job completion, suitable for message injection.
 * Does not include output excerpts — use subagent_result for full results.
 * Supports completed, failed, cancelled, interrupted, and needs_input states.
 */
export function formatBackgroundCompletion(
	job: BackgroundJob,
	options?: { callLevel?: boolean },
): string {
	const isCallLevel = options?.callLevel === true;
	const duration = job.createdAt ? formatDuration(Date.now() - job.createdAt) : "";
	const agentNames = [...new Set(job.calls.map((c) => c.agent))];

	const lines: string[] = [];

	// Status header — callLevel uses "All calls in job" phrasing
	const jobRef = `\`${job.id}\``;
	if (isCallLevel) {
		if (job.status === "cancelled") {
			lines.push(`All calls in job ${jobRef} finished. Job was cancelled.`);
		} else if (job.status === "interrupted") {
			lines.push(`All calls in job ${jobRef} were interrupted (the parent process exited before completion).`);
		} else if (job.status === "failed") {
			lines.push(`All calls in job ${jobRef} finished. Some calls failed.`);
		} else {
			const suffix = job.worktreeMode === "isolated" ? " in an isolated worktree" : "";
			lines.push(`All calls in job ${jobRef} completed${suffix}.`);
		}
		lines.push("");
		if (duration) lines.push(`Duration: ${duration}`);
	} else {
		if (job.status === "cancelled") {
			lines.push(`Background job ${jobRef} was cancelled.`);
		} else if (job.status === "interrupted") {
			lines.push(`Background job ${jobRef} was interrupted (the parent process exited before it completed).`);
		} else if (job.status === "failed") {
			lines.push(`Background job ${jobRef} failed.`);
		} else if (job.status === "needs_input") {
			lines.push(`Background job ${jobRef} is awaiting your input.`);
		} else {
			const suffix = job.worktreeMode === "isolated" ? " in an isolated worktree" : "";
			lines.push(`Background job ${jobRef} completed${suffix}.`);
		}
		lines.push("");
		lines.push(`Agents: ${agentNames.join(", ")}`);
		if (duration) lines.push(`Duration: ${duration}`);
	}

	// Worktree metadata (shown in both modes)
	if (job.worktreeMetadata) {
		const m = job.worktreeMetadata;
		if (m.branch) lines.push(`Branch: ${m.branch}`);
		if (m.changedFiles?.length) lines.push(`Changed files: ${m.changedFiles.length}`);
		if (m.patchPath) lines.push(`Patch: ${m.patchPath}`);
	}

	// Result summary (shown in both modes for terminal states)
	if (job.results && job.results.length > 0 && !["needs_input", "interrupted"].includes(job.status)) {
		const completed = job.results.filter((r) => !isResultError(r)).length;
		const total = job.results.length;
		const toolCalls = job.results.reduce((sum, r) => {
			return sum + getDisplayItems(r.messages).filter((i) => i.type === "toolCall").length;
		}, 0);
		lines.push(`Result: ${completed}/${total} calls completed, ${toolCalls} tool calls`);
	}

	// Error for failed jobs
	if (job.status === "failed" && job.error) {
		lines.push(`Error: ${job.error}`);
	}

	// Artifacts summary (non-callLevel)
	if (!isCallLevel) {
		const artifactSummary = formatArtifactSummary(job);
		if (artifactSummary) {
			lines.push(`Artifacts: ${artifactSummary}`);
		}
	}

	// Question for needs_input (if available, non-callLevel)
	if (!isCallLevel && job.status === "needs_input" && job.waitingForInput?.question) {
		lines.push("");
		lines.push(job.waitingForInput.question.trim());
	}

	// Next action
	lines.push("");
	if (isCallLevel) {
		// Fleet-oriented next action after per-call notifications
		if (["failed", "cancelled"].includes(job.status)) {
			lines.push(`Use \`subagent_status\` to inspect, or \`subagent_result\` with jobId ${jobRef} for call details.`);
		} else if (job.worktreeMetadata) {
			lines.push(`Next: inspect with \`subagent_result\` before integrating changes.`);
		} else {
			lines.push(`Next: use \`subagent_result\` with jobId ${jobRef} to inspect individual call results, or \`subagent_status\` for the fleet view.`);
		}
	} else if (job.status === "failed") {
		lines.push(`Next: use \`subagent_result\` with jobId ${jobRef} for captured output, or \`subagent_peek\` for recent events.`);
	} else if (job.status === "needs_input") {
		if (job.interactive) {
			lines.push(`Reply with your choice or instruction, or use \`subagent_status\` for details.`);
		} else {
			lines.push(`Continue with \`subagent_continue\` using jobId ${jobRef}.`);
		}
	} else if (["cancelled", "interrupted"].includes(job.status)) {
		lines.push(`Use \`subagent_status\` to inspect remaining jobs.`);
	} else if (job.worktreeMetadata) {
		lines.push(`Next: inspect with \`subagent_result\` before integrating changes.`);
	} else {
		const sessionHint = formatSessionContinueHint(job);
		if (sessionHint) {
			lines.push(`Next: ${sessionHint}, or \`subagent_result\` with jobId ${jobRef}.`);
		} else {
			lines.push(`Next: use \`subagent_result\` with jobId ${jobRef} to inspect the full report.`);
		}
	}

	return lines.join("\n");
}

/**
 * Per-call completion notification for a single subagent call within a multi-call job.
 * Very compact — no excerpts, no job-level summary.
 */
export function formatCallCompletion(
	job: BackgroundJob,
	result: SingleResult,
	callIndex: number,
): string {
	const totalCalls = job.calls.length;
	const agent = result.agent || job.calls[callIndex]?.agent || `call ${callIndex}`;
	const cs = job.callStates[callIndex];
	let duration = "";
	if (cs?.startedAt) {
		const endTime = cs.completedAt ?? Date.now();
		duration = formatDuration(endTime - cs.startedAt);
	}

	// Determine per-call status
	let statusWord: string;
	if (result.stopReason === "aborted") {
		statusWord = "was cancelled";
	} else if (isResultError(result)) {
		statusWord = "failed";
	} else {
		statusWord = "completed";
	}

	const lines: string[] = [
		`Call ${callIndex + 1}/${totalCalls} (${agent}) in job \`${job.id}\` ${statusWord}.`,
		"",
		`Agent: ${agent}`,
	];

	if (duration) lines.push(`Duration: ${duration}`);

	// Tool calls (for completed or failed)
	if (statusWord !== "was cancelled") {
		const toolCalls = getDisplayItems(result.messages).filter((i) => i.type === "toolCall").length;
		const label = statusWord === "completed" ? "completed" : "failed";
		const toolInfo = toolCalls > 0 ? `, ${toolCalls} tool calls` : "";
		lines.push(`Result: ${label}${toolInfo}`);
	}

	// Error for failed calls
	if (result.stopReason !== "aborted" && (result.errorMessage || result.stderr?.trim())) {
		lines.push(`Error: ${(result.errorMessage || result.stderr).trim()}`);
	}

	// Next action (skip for cancelled — nothing actionable)
	if (result.stopReason !== "aborted") {
		lines.push("");
		if (isResultError(result)) {
			lines.push(`Next: use \`subagent_result\` with jobId \`${job.id}\` for captured output, or \`subagent_peek\` for recent events.`);
		} else {
			lines.push(`Next: use \`subagent_result\` with jobId \`${job.id}\` to inspect this call.`);
		}
	}

	return lines.join("\n");
}

/**
 * Natural human-facing text for a parked background job.
 *
 * Routing metadata is attached separately to the injected message details, so
 * this text intentionally avoids job IDs, call indexes, markers, and tool syntax.
 */
export function formatBackgroundEscalation(job: BackgroundJob): string {
	const waitingForInput = job.waitingForInput;
	const call = waitingForInput ? job.calls[waitingForInput.callIndex] : job.calls[0];
	const agentName = call?.agent ?? "background";
	const question = waitingForInput?.question.trim() || "The subagent is waiting for your direction.";

	return [
		`The ${agentName} subagent is waiting for your direction:`,
		"",
		question,
		"",
		"Reply with your choice or instruction.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Status formatting helpers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Job detail section helpers — for subagent_status { jobId }
// ---------------------------------------------------------------------------

function formatJobHeader(job: BackgroundJob): string[] {
	const age = job.createdAt ? formatAge(job.createdAt) : "";
	const update = job.updatedAt ? formatAge(job.updatedAt) : "";
	const lines = [
		`Job ${job.id}`,
		`Status: ${job.status}`,
		`Created: ${age} ago`,
		`Updated: ${update} ago`,
	];
	if (job.worktreeMode === "isolated") {
		lines.push(`Mode: isolated worktree`);
		if (job.worktreeMetadata?.branch) {
			lines.push(`Branch: ${job.worktreeMetadata.branch}`);
		}
	} else if (job.worktreeScope) {
		lines.push(`Scope: ${job.worktreeScope}`);
	}

	// Expose session handle for completed jobs so the parent can continue the conversation
	if (job.status === "completed") {
		const firstCall = job.calls.find((c) => c.sessionHandle);
		if (firstCall?.sessionHandle) {
			lines.push(`Session: ${firstCall.sessionHandle}`);
		}
	}

	return lines;
}

function formatJobCalls(job: BackgroundJob): string[] {
	const lines = ["Calls"];
	for (let i = 0; i < job.calls.length; i++) {
		const call = job.calls[i];
		const cs = job.callStates?.[i];
		const r = job.results?.[i];
		// Use callState.phase when available (more granular), fall back to result-derived label
		const status = cs?.phase ?? formatCallStatusLabel(r);
		const elapsed = cs?.completedAt && cs?.startedAt
			? `took ${formatDuration(cs.completedAt - cs.startedAt)}`
			: cs?.startedAt
				? `${formatAge(cs.startedAt)} elapsed`
				: "";
		const toolCount = cs?.toolCalls ? `${cs.toolCalls} tool${cs.toolCalls > 1 ? "s" : ""}` : "";
		const latest = cs?.recentActivity?.[0] ? `latest: ${cs.recentActivity[0]}` : "";
		const extra = [elapsed, toolCount, latest].filter(Boolean).join("  ");
		lines.push(`  ${i} ${call.agent}  ${status}${extra ? `   ${extra}` : ""}`);
	}
	return lines;
}

function formatJobArtifacts(job: BackgroundJob): string[] {
	const artifacts = deriveArtifacts(job);
	if (artifacts.length === 0) return ["No artifacts."];

	const lines = ["Artifacts"];
	for (const art of artifacts) {
		switch (art.kind) {
			case "result":
				lines.push(`  result  ${art.value ?? "available"}`);
				break;
			case "event_journal":
				lines.push(`  event journal  ${art.count ?? "?"} tool calls`);
				break;
			case "worktree":
				lines.push(`  worktree  ${shortenPath(art.path ?? "?")}`);
				break;
			case "branch":
				lines.push(`  branch  ${art.value ?? "?"}`);
				break;
			case "patch":
				lines.push(`  patch  ${shortenPath(art.path ?? "?")}`);
				break;
			case "changed_files":
				lines.push(`  changed files  ${art.count ?? "?"}`);
				break;
			case "escalation":
				lines.push(`  escalation  ${art.metadata?.status ?? art.value ?? "?"}`);
				break;
			case "plan":
				lines.push(`  plan  ${art.value ?? "pending"}`);
				break;
		}
	}
	return lines;
}

function formatJobEscalations(job: BackgroundJob): string[] {
	const lines: string[] = [];

	// Current waiting escalation
	if (job.status === "needs_input" && job.waitingForInput) {
		const question = job.waitingForInput.question.trim();
		lines.push("Waiting for input");
		lines.push(`  ${truncateOneLine(question, 160)}`);
	}

	// Historical escalations (dismissed, answered, cancelled)
	if (job.escalations && job.escalations.length > 0) {
		const historical = job.escalations.filter(
			(e) => e.status !== "open" || e.id !== job.waitingForInput?.id,
		);
		if (historical.length > 0) {
			lines.push("Escalations");
			for (const esc of historical) {
				const statusLabel =
					esc.status === "dismissed"
						? `dismissed${esc.closeReason ? `: ${esc.closeReason}` : ""}`
						: esc.status === "answered"
							? "answered"
							: esc.status === "cancelled"
								? "cancelled"
								: esc.status;
				lines.push(`  ${esc.id} ${statusLabel}`);
			}
		}
	}

	return lines;
}

function formatJobNextActions(job: BackgroundJob): string[] {
	const lines = ["Next"];
	if (job.status === "running" || job.status === "cancelling") {
		lines.push(`  peek: subagent_peek jobId ${job.id}`);
		lines.push(`  cancel: subagent_cancel jobId ${job.id} confirm true`);
	} else if (job.status === "needs_input") {
		if (job.interactive) {
			lines.push("  Reply with your choice or instruction.");
		} else {
			lines.push(`  continue: subagent_continue jobId ${job.id}`);
		}
	} else {
		// Terminal states
		if (job.status === "completed" && job.worktreeMetadata) {
			lines.push(`  inspect: subagent_result jobId ${job.id} before integrating changes`);
		} else {
			lines.push(`  inspect: subagent_result jobId ${job.id}`);
		}
	}
	return lines;
}

/** Acknowledgement text for a closed parked job. */
export function formatSubagentCloseAcknowledgement(
	job: BackgroundJob,
	reason?: string,
): string {
	const lines: string[] = [
		`Closed waiting subagent job \`${job.id}\`.`,
		"",
		`No further action was requested. The job is now completed.`,
		`Use \`subagent_result\` with jobId \`${job.id}\` to inspect the captured output.`,
	];
	if (reason) {
		lines.splice(2, 0, `Reason: ${reason}`);
	}
	return lines.join("\n");
}

/**
 * Full structured detail for a single background job.
 * Delegates to section helpers for header, calls, artifacts, escalations, and next actions.
 */
export function formatJobStatus(job: BackgroundJob): string {
	const sections: string[] = [];
	sections.push(formatJobHeader(job).join("\n"));
	sections.push(formatJobCalls(job).join("\n"));
	sections.push(formatJobArtifacts(job).join("\n"));

	const escalations = formatJobEscalations(job);
	if (escalations.length > 0) sections.push(escalations.join("\n"));

	sections.push(formatJobNextActions(job).join("\n"));
	return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Fleet view — for subagent_status without jobId
// ---------------------------------------------------------------------------

export interface FleetGroup {
	title: string;
	jobs: BackgroundJob[];
}

const FLEET_STATUS_ORDER: BackgroundJobStatus[] = [
	"needs_input",
	"failed",
	"running",
	"cancelling",
	"completed",
	"cancelled",
	"interrupted",
];

/** Recent terminal jobs within this window (ms) appear in the fleet view. */
const TERMINAL_WINDOW_MS = 5 * 60 * 1000;

function getGroupTitle(status: BackgroundJobStatus): string {
	switch (status) {
		case "needs_input": return "Needs input";
		case "failed": return "Failed";
		case "running": return "Running";
		case "cancelling": return "Cancelling";
		case "completed": return "Recent completed";
		case "cancelled": return "Recent cancelled";
		case "interrupted": return "Recent interrupted";
	}
}

/**
 * Group background jobs by attention priority, filtering out old terminal jobs.
 * Within each group, sort most recently updated first.
 */
export function groupJobsForFleet(jobs: BackgroundJob[]): FleetGroup[] {
	const now = Date.now();

	// Only show terminal jobs that finished recently
	const visible = jobs.filter((job) => {
		if (isJobTerminal(job.status)) {
			return now - job.updatedAt < TERMINAL_WINDOW_MS;
		}
		return true;
	});

	// Group by status
	const groups = new Map<BackgroundJobStatus, BackgroundJob[]>();
	for (const job of visible) {
		const arr = groups.get(job.status);
		if (arr) {
			arr.push(job);
		} else {
			groups.set(job.status, [job]);
		}
	}

	// Build ordered groups, jobs sorted by updatedAt descending
	return FLEET_STATUS_ORDER
		.filter((status) => groups.has(status))
		.map((status) => ({
			title: getGroupTitle(status),
			jobs: groups.get(status)!.sort((a, b) => b.updatedAt - a.updatedAt),
		}));
}

/**
 * Format a single job row for the fleet view.
 * Returns an array of lines (no trailing newline).
 */
function formatFleetJobRow(job: BackgroundJob): string[] {
	const lines: string[] = [];

	const agentNames = [...new Set(job.calls.map((c) => c.agent))].join(", ");
	const age = job.createdAt ? formatAge(job.createdAt) : "";

	let statusFields = "";
	let secondaryLine = "";
	let nextAction = "";

	if (job.status === "needs_input" && job.waitingForInput) {
		statusFields = `asks: ${truncateOneLine(job.waitingForInput.question, 120)}`;
		nextAction = `next: subagent_continue escalationId ${job.waitingForInput.id}`;
	} else if (job.status === "failed") {
		statusFields = `error: ${truncateOneLine(job.error || "job failed", 120)}`;
		nextAction = `next: subagent_result jobId ${job.id}`;
	} else if (job.status === "running" || job.status === "cancelling") {
		const toolCalls = job.callStates
			? job.callStates.reduce((sum, cs) => sum + (cs?.toolCalls || 0), 0)
			: 0;
		const parts: string[] = [];
		if (toolCalls > 0) parts.push(`${toolCalls} tools`);
		if (job.worktreeMode === "isolated") {
			parts.push("isolated");
			if (job.worktreeMetadata?.branch) {
				parts.push(`branch ${job.worktreeMetadata.branch}`);
			}
		}
		statusFields = parts.join("  ");
		nextAction = `next: subagent_peek jobId ${job.id}`;

		// Latest activity from any call
		if (job.callStates) {
			for (const cs of job.callStates) {
				if (cs?.recentActivity?.length > 0) {
					secondaryLine = `latest: ${cs.recentActivity[0]}`;
					break;
				}
			}
		}
	} else if (job.status === "completed") {
		const artifactSummary = formatArtifactSummary(job);
		statusFields = artifactSummary ? `artifacts: ${artifactSummary}` : "completed";
		// Show session handle hint if this job has a session that can be continued
		const sessionHint = formatSessionContinueHint(job);
		nextAction = sessionHint
			? sessionHint
			: `next: subagent_result jobId ${job.id}`;
	} else if (job.status === "cancelled" || job.status === "interrupted") {
		nextAction = `next: subagent_status`;
	}

	// First line: jobId  agents  age  [status fields]
	const firstParts = [job.id, agentNames];
	if (age) firstParts.push(age);
	if (statusFields) firstParts.push(statusFields);
	lines.push(`  ${firstParts.join("  ")}`);

	// Secondary line (latest activity for running/cancelling)
	if (secondaryLine) {
		lines.push(`    ${secondaryLine}`);
	}

	// Next-action hint
	if (nextAction) {
		lines.push(`    ${nextAction}`);
	}

	return lines;
}

/**
 * Format the full fleet view — a cockpit dashboard for all background jobs.
 * Groups jobs by attention priority with a summary header.
 */
export function formatJobFleet(jobs: BackgroundJob[]): string {
	if (jobs.length === 0) return "No background subagent jobs.";

	const groups = groupJobsForFleet(jobs);

	// Compute summary counts (same visibility as groups)
	const now = Date.now();
	const summaryCounts = new Map<string, number>();
	for (const job of jobs) {
		const visible = isJobTerminal(job.status)
			? now - job.updatedAt < TERMINAL_WINDOW_MS
			: true;
		if (visible) {
			summaryCounts.set(job.status, (summaryCounts.get(job.status) || 0) + 1);
		}
	}

	// Build summary line in fleet order
	const summaryParts = FLEET_STATUS_ORDER
		.map((status) => {
			const count = summaryCounts.get(status) || 0;
			if (count === 0) return null;
			return `${count} ${status}`;
		})
		.filter((part): part is string => part !== null)
		.join(" \u00b7 ");

	const lines: string[] = [
		"Background subagents",
		summaryParts,
		"",
	];

	for (const group of groups) {
		lines.push(group.title);
		for (const job of group.jobs) {
			for (const rowLine of formatFleetJobRow(job)) {
				lines.push(rowLine);
			}
		}
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

/**
 * Format a list of all background jobs (fleet view).
 * Delegates to formatJobFleet for the cockpit-style output.
 */
export function formatJobList(jobs: BackgroundJob[]): string {
	return formatJobFleet(jobs);
}

// ---------------------------------------------------------------------------
// FormatJobResults — for the subagent_result tool
// ---------------------------------------------------------------------------

/**
 * Format the full results of a completed background job.
 */
export function formatJobResults(
	job: BackgroundJob,
	options: {
		callIndex?: number;
		includeToolCalls?: boolean;
		maxOutputLength?: number;
	},
): string {
	const { callIndex, includeToolCalls, maxOutputLength } = options;
	const results = job.results;
	if (!results || results.length === 0) {
		return "No results available for this job.";
	}

	// Defensive validation for callIndex — should be pre-validated by caller.
	if (callIndex !== undefined && (!Number.isSafeInteger(callIndex) || callIndex < 0 || callIndex >= results.length)) {
		return "No results available for this job.";
	}

	const targetResults =
		callIndex !== undefined ? [results[callIndex]] : results;

	// Defensive: clamp maxOutputLength to a safe positive integer for truncation.
	const effectiveMaxOutputLength =
		typeof maxOutputLength === "number" && Number.isFinite(maxOutputLength) && maxOutputLength > 0
			? Math.floor(maxOutputLength)
			: undefined;

	const lines: string[] = [];
	for (const r of targetResults) {
		if (r.exitCode === -1) {
			lines.push(`## ${r.agent} (still running)`);
			continue;
		}

		const summary = getBackgroundResultSummary(job, r);
		const items = includeToolCalls ? getDisplayItems(r.messages) : [];

		const headingStatus =
			job.status === "needs_input" && job.waitingForInput?.callIndex === (r.callIndex ?? targetResults.indexOf(r))
				? "needs_input"
				: isResultError(r) ? "failed" : "completed";
		lines.push(`## ${r.agent} — ${headingStatus}`);
		lines.push("");

		if (summary && summary !== "(no output)") {
			const output =
				effectiveMaxOutputLength !== undefined && summary.length > effectiveMaxOutputLength
					? summary.slice(0, effectiveMaxOutputLength) +
						`\n\n[... truncated at ${effectiveMaxOutputLength} characters]`
					: summary;
			lines.push(output);
			lines.push("");
		}

		if (includeToolCalls && items.length > 0) {
			lines.push("### Tool calls");
			for (const item of items) {
				if (item.type === "toolCall") {
					lines.push(`- ${item.name}(${JSON.stringify(item.args)})`);
				}
			}
			lines.push("");
		}

		const usage = formatUsage(r.usage, r.model);
		if (usage) {
			lines.push(`*${usage}*`);
			lines.push("");
		}
	}

	return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// FormatJobPeek — for the subagent_peek tool
// ---------------------------------------------------------------------------

interface PeekCallEvents {
	callIndex: number;
	lines: string[];
}

interface PeekOptions {
	callIndex?: number;
	includeRawEvents?: boolean;
	eventLinesByCall: PeekCallEvents[];
}

function parseEventLine(line: string): Record<string, any> | null {
	try {
		const parsed = JSON.parse(line);
		return parsed && typeof parsed === "object" ? parsed as Record<string, any> : null;
	} catch {
		return null;
	}
}

function extractMessageExcerpt(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const typed = part as { type?: unknown; text?: unknown; thinking?: unknown };
		if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim()) {
			parts.push(typed.text.trim());
		} else if (typed.type === "thinking" && typeof typed.thinking === "string" && typed.thinking.trim()) {
			parts.push(`Thinking: ${typed.thinking.trim()}`);
		}
	}
	return parts.join("\n\n");
}

function formatPlainToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const obj = args as Record<string, unknown>;
	const pathArg = obj.path || obj.file_path;
	if (typeof pathArg === "string" && pathArg.trim()) return shortenPath(pathArg);
	if (typeof obj.command === "string" && obj.command.trim()) return truncate(oneLine(obj.command), 80);
	if (typeof obj.pattern === "string" && obj.pattern.trim()) return truncate(oneLine(obj.pattern), 80);
	const json = JSON.stringify(obj);
	return json && json !== "{}" ? truncate(json, 80) : "";
}

/** Maximum character length for a text payload inside a raw peek event. */
const RAW_EVENT_TEXT_TRUNCATION_LIMIT = 500;
/** Maximum character length for the entire serialized raw event line. */
const RAW_EVENT_LINE_LIMIT = 2000;

/**
 * Truncate oversized text payloads in a raw JSON event line so that peek
 * output remains readable even when the subagent read or wrote large files.
 *
 * Text fields in tool-execution results are the main source of bloat.
 * This parses the event, truncates any text longer than the limit,
 * and re-serializes it. Non-JSON or malformed lines pass through unchanged.
 */
function truncateRawEventPayloads(line: string): string {
	if (line.length <= RAW_EVENT_LINE_LIMIT) return line;

	try {
		const event = JSON.parse(line);
		if (!event || typeof event !== "object") return line;

		// Truncate result.text fields in tool_execution_end events
		if (event.type === "tool_execution_end" && event.result?.content) {
			const content = event.result.content;
			if (Array.isArray(content)) {
				for (const part of content) {
					if (part?.type === "text" && typeof part.text === "string" && part.text.length > RAW_EVENT_TEXT_TRUNCATION_LIMIT) {
						part.text = part.text.slice(0, RAW_EVENT_TEXT_TRUNCATION_LIMIT) +
							`\n[... truncated ${part.text.length - RAW_EVENT_TEXT_TRUNCATION_LIMIT} more chars]`;
					}
				}
			}
		}

		// Truncate assistant text or thinking content in message events
		if (event.message?.content && Array.isArray(event.message.content)) {
			for (const part of event.message.content) {
				if (part?.type === "text" && typeof part.text === "string" && part.text.length > RAW_EVENT_TEXT_TRUNCATION_LIMIT) {
					part.text = part.text.slice(0, RAW_EVENT_TEXT_TRUNCATION_LIMIT) +
						`\n[... truncated ${part.text.length - RAW_EVENT_TEXT_TRUNCATION_LIMIT} more chars]`;
				}
				if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.length > RAW_EVENT_TEXT_TRUNCATION_LIMIT) {
					part.thinking = part.thinking.slice(0, RAW_EVENT_TEXT_TRUNCATION_LIMIT) +
						`\n[... truncated ${part.thinking.length - RAW_EVENT_TEXT_TRUNCATION_LIMIT} more chars]`;
				}
			}
		}

		// Truncate toolResults text in turn_end events
		if (event.type === "turn_end" && Array.isArray(event.toolResults)) {
			for (const tr of event.toolResults) {
				if (tr?.content && Array.isArray(tr.content)) {
					for (const part of tr.content) {
						if (part?.type === "text" && typeof part.text === "string" && part.text.length > RAW_EVENT_TEXT_TRUNCATION_LIMIT) {
							part.text = part.text.slice(0, RAW_EVENT_TEXT_TRUNCATION_LIMIT) +
								`\n[... truncated ${part.text.length - RAW_EVENT_TEXT_TRUNCATION_LIMIT} more chars]`;
						}
					}
				}
			}
		}

		// Truncate the full messages text in agent_end events
		if (event.type === "agent_end" && Array.isArray(event.messages)) {
			for (const msg of event.messages) {
				if (msg?.content && Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part?.type === "text" && typeof part.text === "string" && part.text.length > RAW_EVENT_TEXT_TRUNCATION_LIMIT) {
							part.text = part.text.slice(0, RAW_EVENT_TEXT_TRUNCATION_LIMIT) +
								`\n[... truncated ${part.text.length - RAW_EVENT_TEXT_TRUNCATION_LIMIT} more chars]`;
						}
					}
				}
			}
		}

		const serialized = JSON.stringify(event);
		if (serialized.length < line.length) {
			return serialized;
		}
		// If truncation didn't reduce size much, fall back to the original
		return line;
	} catch {
		// Malformed JSON — pass through
		return line;
	}
}

interface SummarizedToolEvent {
	name: string;
	args: string;
	status: "started" | "completed" | "failed";
}

function summarizePeekEvents(lines: string[]): {
	toolCalls: SummarizedToolEvent[];
	assistantExcerpt: string;
	rawEvents: string[];
} {
	const toolCalls: SummarizedToolEvent[] = [];
	let assistantExcerpt = "";
	const openTools = new Map<string, number>();

	for (const line of lines) {
		const event = parseEventLine(line);
		if (!event) continue;
		const type = typeof event.type === "string" ? event.type : "";

		// Extract assistant text from messages
		if (!assistantExcerpt && (type === "message_start" || type === "message_update" || type === "message_end" || type === "turn_end")) {
			const excerpt = extractMessageExcerpt(event.message);
			if (excerpt) assistantExcerpt = excerpt;
		} else if (!assistantExcerpt && type === "agent_end" && Array.isArray(event.messages)) {
			for (const message of event.messages) {
				const excerpt = extractMessageExcerpt(message);
				if (excerpt) { assistantExcerpt = excerpt; break; }
			}
		}

		// Tool call activity — track start and end for each toolCallId
		if (type === "tool_execution_start") {
			const id = typeof event.toolCallId === "string" ? event.toolCallId : `${toolCalls.length}`;
			const name = typeof event.toolName === "string" ? event.toolName : "tool";
			const args = formatPlainToolArgs(event.args);
			const index = toolCalls.length;
			openTools.set(id, index);
			toolCalls.push({ name, args, status: "started" });
		} else if (type === "tool_execution_end") {
			const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
			if (id && openTools.has(id)) {
				const idx = openTools.get(id)!;
				toolCalls[idx] = { ...toolCalls[idx], status: event.isError ? "failed" : "completed" };
				openTools.delete(id);
			}
		}
	}

	return {
		toolCalls,
		assistantExcerpt: assistantExcerpt ? truncate(assistantExcerpt, 300) : "",
		rawEvents: lines,
	};
}

/**
 * Format a live activity snapshot for a background job.
 *
 * By default shows a clean timeline of tool calls without raw JSON event lines.
 * Set `includeRawEvents: true` to include the full raw event tail.
 */
export function formatJobPeek(job: BackgroundJob, options: PeekOptions): string {
	const targetCalls = options.callIndex !== undefined
		? [{ call: job.calls[options.callIndex], index: options.callIndex }]
		: job.calls.map((call, index) => ({ call, index }));

	const lines: string[] = [
		`Recent activity for ${job.id}`,
	];

	for (const { call, index } of targetCalls) {
		if (!call) continue;
		const events = options.eventLinesByCall.find((entry) => entry.callIndex === index)?.lines ?? [];
		const summary = summarizePeekEvents(events);

		lines.push("");
		lines.push(`Call ${index} ${call.agent}`);

		if (events.length === 0) {
			lines.push("  No events yet");
			continue;
		}

		// Activity-first: show tool call timeline
		if (summary.toolCalls.length > 0) {
			for (const tc of summary.toolCalls) {
				const suffix = tc.status === "completed" ? "" : tc.status === "failed" ? " (failed)" : "";
				const label = tc.args ? `${tc.name} ${tc.args}` : tc.name;
				lines.push(`  ${label}${suffix}`);
			}
		} else {
			// No tool calls — show assistant excerpt if short and useful
			if (summary.assistantExcerpt && summary.assistantExcerpt.length < 200) {
				lines.push(`  ${truncateOneLine(summary.assistantExcerpt, 100)}`);
			} else {
				lines.push("  No tool activity yet");
			}
		}
	}

	// Footer line: raw events hint or raw events body
	if (!options.includeRawEvents) {
		lines.push("");
		lines.push("Raw events hidden. Use includeRawEvents: true for debugging.");
	} else {
		for (const { index } of targetCalls) {
			if (!job.calls[index]) continue;
			const events = options.eventLinesByCall.find((entry) => entry.callIndex === index)?.lines ?? [];
			if (events.length > 0) {
				lines.push("");
				lines.push(`Raw events for Call ${index} (truncated oversized payloads):`);
				for (const raw of events) lines.push(truncateRawEventPayloads(raw));
			}
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Render for subagent_start
// ---------------------------------------------------------------------------

/**
 * Render for subagent_start tool call — shown in the TUI while being invoked.
 */
export function renderBackgroundCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const calls = Array.isArray(args.calls) ? args.calls : [];
	const onComplete = typeof args.onComplete === "string" ? args.onComplete : "trigger";

	let text =
		theme.fg("toolTitle", theme.bold("subagent_start ")) +
		theme.fg("accent", `${calls.length || "?"} call${calls.length === 1 ? "" : "s"}`) +
		theme.fg("dim", ` · ${onComplete}`);

	for (const call of calls.slice(0, 3)) {
		const agent = typeof call.agent === "string" ? call.agent : "...";
		const model = typeof call.model === "string" && call.model.trim()
			? theme.fg("muted", ` model=${call.model.trim()}`)
			: "";
		const preview = typeof call.prompt === "string" ? truncate(oneLine(call.prompt), 45) : "...";
		text += `\n  ${theme.fg("warning", agent)}${model}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (calls.length > 3) text += `\n  ${theme.fg("muted", `... +${calls.length - 3} more`)}`;

	return new Text(text, 0, 0);
}

/**
 * Render for subagent_start tool result — shown immediately after starting.
 */
export function renderBackgroundResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	_expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text | Container {
	const firstContent = result.content[0];
	const text = firstContent?.type === "text" && firstContent.text ? firstContent.text : "";

	if (!text) {
		return new Text("Started background subagent job.", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(new Text(theme.fg("success", "✓ ") + theme.fg("toolTitle", theme.bold("subagent_start ")) + theme.fg("muted", "started"), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text.trim(), 0, 0, mdTheme));
	return container;
}

// ---------------------------------------------------------------------------
// Render for subagent_status
// ---------------------------------------------------------------------------

/**
 * Render for subagent_status tool call.
 */
export function renderJobStatusCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const jobId = typeof args.jobId === "string" ? args.jobId : "(all)";
	return new Text(
		theme.fg("toolTitle", theme.bold("subagent_status ")) + theme.fg("dim", jobId),
		0,
		0,
	);
}

/**
 * Render for subagent_status tool result.
 */
export function renderJobStatusResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	_expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const first = result.content[0];
	const text = first?.type === "text" && first.text ? first.text : "(no status)";
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Render for subagent_peek
// ---------------------------------------------------------------------------

/**
 * Render for subagent_peek tool call.
 */
export function renderSubagentPeekCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const jobId = typeof args.jobId === "string" ? args.jobId : "?";
	const callIndex = typeof args.callIndex === "number" ? ` call=${args.callIndex}` : "";
	return new Text(
		theme.fg("toolTitle", theme.bold("subagent_peek ")) + theme.fg("dim", `${jobId}${callIndex}`),
		0,
		0,
	);
}

/**
 * Render for subagent_peek tool result.
 */
export function renderSubagentPeekResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	_expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container | Text {
	const first = result.content[0];
	const text = first?.type === "text" && first.text ? first.text : "";

	if (!text) {
		return new Text("(no peek data)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(
		new Text(
			theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("subagent_peek ")) +
				theme.fg("muted", "events"),
			0,
			0,
		),
	);
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text.trim(), 0, 0, mdTheme));
	return container;
}

// ---------------------------------------------------------------------------
// Render for subagent_result
// ---------------------------------------------------------------------------

/**
 * Render for subagent_result tool call.
 */
export function renderSubagentResultCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const jobId = typeof args.jobId === "string" ? args.jobId : "?";
	return new Text(
		theme.fg("toolTitle", theme.bold("subagent_result ")) + theme.fg("dim", jobId),
		0,
		0,
	);
}

/**
 * Render for subagent_result tool result.
 */
export function renderSubagentResultResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	_expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container | Text {
	const first = result.content[0];
	const text = first?.type === "text" && first.text ? first.text : "";

	if (!text) {
		return new Text("(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(
		new Text(
			theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("subagent_result ")) +
				theme.fg("muted", "results"),
			0,
			0,
		),
	);
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text.trim(), 0, 0, mdTheme));
	return container;
}

// ---------------------------------------------------------------------------
// Render for subagent_continue
// ---------------------------------------------------------------------------

/**
 * Render for subagent_continue tool call.
 */
export function renderContinueCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const jobId = typeof args.jobId === "string" ? args.jobId : "?";
	const prompt = typeof args.prompt === "string" ? truncate(oneLine(args.prompt), 60) : "";
	const callIndex = Number.isInteger(args.callIndex)
		? theme.fg("muted", ` call=${args.callIndex}`)
		: "";
	const preview = prompt ? theme.fg("dim", ` ${prompt}`) : "";
	return new Text(
		theme.fg("toolTitle", theme.bold("subagent_continue ")) +
			theme.fg("accent", jobId) +
			callIndex +
			preview,
		0,
		0,
	);
}

/**
 * Render for subagent_continue tool result.
 */
export function renderContinueResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	_expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text | Container {
	const first = result.content[0];
	const text = first?.type === "text" && first.text ? first.text : "";

	if (!text) {
		return new Text("(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(new Text(theme.fg("warning", "◐ ") + theme.fg("toolTitle", theme.bold("subagent_continue ")) + theme.fg("muted", "resumed"), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text.trim(), 0, 0, mdTheme));
	return container;
}

// ---------------------------------------------------------------------------
// Plan queue rendering
// ---------------------------------------------------------------------------

/**
 * Format a consolidated plan-fired message for injection into the parent session.
 *
 * Shows the original plan text alongside the status of each dependency,
 * and instructs the agent to ask the user before proceeding.
 */
export function formatPlanFired(
  plan: { id: string; plan: string },
  depDetails: { id: string; status: string; summary?: string }[],
): string {
  const lines: string[] = [
    `📋 A queued plan (\`${plan.id}\`) is now ready.`,
    "",
    "The required jobs have completed:",
  ];

  for (const dep of depDetails) {
    const label = dep.summary ? ` (${dep.summary})` : "";
    lines.push(`  ${dep.id} — ${dep.status}${label}`);
  }

  lines.push(
    "",
    "Ask the user if they still want this done before proceeding.",
    "Do NOT include the plan details in your response yet.",
    "If the user is interested, use \`subagent_get_plan\` to retrieve the plan text and share it.",
  );

  return lines.join("\n");
}

/**
 * Format the full plan text for retrieval via subagent_get_plan.
 */
export function formatPlanDetail(plan: { id: string; plan: string }): string {
  return [
    `Plan \`${plan.id}\`:`, 
    "",
    plan.plan,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Render for subagent_cancel
// ---------------------------------------------------------------------------

/**
 * Render for subagent_cancel tool call.
 */
export function renderCancelCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const jobId = typeof args.jobId === "string" ? args.jobId : "?";
	return new Text(
		theme.fg("toolTitle", theme.bold("subagent_cancel ")) + theme.fg("warning", jobId),
		0,
		0,
	);
}

/**
 * Render for subagent_cancel tool result.
 */
export function renderCancelResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	_expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text | Container {
	const first = result.content[0];
	const text = first?.type === "text" && first.text ? first.text : "";

	if (!text) {
		return new Text("(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(new Text(theme.fg("warning", "◐ ") + theme.fg("toolTitle", theme.bold("subagent_cancel ")) + theme.fg("muted", "cancel"), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text.trim(), 0, 0, mdTheme));
	return container;
}

// ---------------------------------------------------------------------------
// Render for subagent_close
// ---------------------------------------------------------------------------

/**
 * Render for subagent_close tool call.
 */
export function renderCloseCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const jobId = typeof args.jobId === "string" ? args.jobId : "?";
	return new Text(
		theme.fg("toolTitle", theme.bold("subagent_close ")) + theme.fg("accent", jobId),
		0,
		0,
	);
}

/**
 * Render for subagent_close tool result.
 */
export function renderCloseResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	_expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text | Container {
	const first = result.content[0];
	const text = first?.type === "text" && first.text ? first.text : "";

	if (!text) {
		return new Text("(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(new Text(theme.fg("toolTitle", theme.bold("subagent_close ")) + theme.fg("muted", "closed"), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text.trim(), 0, 0, mdTheme));
	return container;
}
