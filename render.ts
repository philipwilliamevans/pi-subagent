/**
 * TUI rendering for subagent tool calls and results.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getProcessErrorText, getResultSummaryText } from "./runner-events.js";
import {
	type BackgroundJob,
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

function isParkedJob(job: BackgroundJob): boolean {
	return job.status === "needs_input";
}

const EXCERPT_MAX_LENGTH = 2000;

/**
 * Compact summary of a completed background job, suitable for message injection.
 * Supports completed, failed, and cancelled states.
 */
export function formatBackgroundCompletion(job: BackgroundJob): string {
	const duration = job.createdAt ? formatDuration(Date.now() - job.createdAt) : "";
	const durationLine = duration ? ` (took ${duration})` : "";

	let verb: string;
	let statusLabel: string;
	if (job.status === "needs_input") {
		verb = "Background subagent job";
		statusLabel = "is awaiting input";
	} else if (job.status === "cancelled") {
		verb = "Background subagent job";
		statusLabel = "was cancelled";
	} else if (job.status === "interrupted") {
		verb = "Background subagent job";
		statusLabel = "was interrupted (the parent process exited before it completed)";
	} else if (job.status === "failed") {
		verb = "Background subagent job";
		statusLabel = "completed with errors";
	} else {
		verb = "Background subagent job";
		statusLabel = "completed successfully";
	}

	const worktreeLabel = formatWorktreeLabel(job);
	const worktreeSuffix = worktreeLabel ? ` ${worktreeLabel}` : "";

	const lines: string[] = [
		`${verb} \`${job.id}\` ${statusLabel}${durationLine}${worktreeSuffix}.`,
		...formatWorktreeMetadataLines(job),
		"",
	];

	if (job.results) {
		for (const [index, r] of job.results.entries()) {
			const callStatus = formatCallStatusLabel(r);
			const agentName = r.agent || job.calls[index]?.agent || `call ${index}`;
			const summary = getBackgroundResultSummary(job, r);

			// Tool call count and output size in the per-call header
			const displayItems = getDisplayItems(r.messages);
			const toolCallItems = displayItems.filter((i) => i.type === "toolCall");
			const toolCallInfo = toolCallItems.length > 0
				? ` (${toolCallItems.length} tool call${toolCallItems.length === 1 ? "" : "s"}, ${formatTokens(summary.length)} output)`
				: "";

			const excerpt = summary && summary !== "(no output)"
				? `\n  ${truncate(summary, EXCERPT_MAX_LENGTH).replace(/\n/g, "\n  ")}`
				: "";

			const wasTruncated = summary && summary.length > EXCERPT_MAX_LENGTH;
			const truncationNotice = wasTruncated
				? `\n  *Output truncated at ${EXCERPT_MAX_LENGTH} characters. Full report available via \`subagent_result\`.*`
				: "";

			lines.push(`- ${agentName} call ${index + 1}: ${callStatus}${toolCallInfo}${excerpt}${truncationNotice}`);
		}
	}

	if (isParkedJob(job) && job.waitingForInput) {
		const waitingText = job.interactive
			? `Waiting on call ${job.waitingForInput.callIndex} for user direction.`
			: `Waiting on call ${job.waitingForInput.callIndex} at marker \`${job.waitingForInput.marker}\`.`;
		lines.push(
			"",
			waitingText,
			`Continue with \`subagent_continue\` using jobId \`${job.id}\`.`,
		);
	}

	if (job.error) {
		lines.push("", `Error: ${job.error}`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Status formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a single call's status line for subagent_status output.
 */
function formatCallStatusLine(
	call: BackgroundJob["calls"][number],
	callState: CallState | undefined,
	_result: SingleResult | undefined,
): string {
	if (!callState) {
		const label = _result ? formatCallStatusLabel(_result) : "queued";
		return `  ${call.agent} — ${label}`;
	}

	const label = callState.phase;
	let elapsed = "";
	if (callState.completedAt && callState.startedAt) {
		elapsed = ` (took ${formatDuration(callState.completedAt - callState.startedAt)})`;
	} else if (callState.startedAt) {
		elapsed = ` (${formatAge(callState.startedAt)} elapsed)`;
	}

	let line = `  ${call.agent} — ${label}${elapsed}`;

	if (callState.recentActivity.length > 0 && callState.phase === "running") {
		line += `\n    Latest: ${callState.recentActivity[0]}`;
	}

	if (callState.toolCalls > 0) {
		line += `\n    ${callState.toolCalls} tool call${callState.toolCalls === 1 ? "" : "s"} so far`;
	}

	return line;
}

/**
 * Format the status of a single background job.
 */
function formatWorktreeLabel(job: BackgroundJob): string {
	if (job.worktreeMode === "isolated") return "[isolated worktree]";
	if (job.worktreeMode === "shared") return "[shared worktree]";
	return "";
}

function formatWorktreeScopeLine(job: BackgroundJob): string {
	if (!job.worktreeScope) return "";
	return `\n  Scope: ${job.worktreeScope}`;
}

function formatWorktreeMetadataLines(job: BackgroundJob): string[] {
	const metadata = job.worktreeMetadata;
	if (!metadata) return [];
	const lines = [
		`  Worktree: ${metadata.path}`,
		`  Branch: ${metadata.branch}`,
		`  Base: ${metadata.baseCommit}`,
	];
	if (metadata.changedFiles && metadata.changedFiles.length > 0) {
		const shown = metadata.changedFiles.slice(0, 10);
		const suffix = metadata.changedFiles.length > shown.length
			? `, ... +${metadata.changedFiles.length - shown.length} more`
			: "";
		lines.push(`  Changed files: ${shown.join(", ")}${suffix}`);
	}
	if (metadata.patchPath) lines.push(`  Patch: ${metadata.patchPath}`);
	return lines;
}

export function formatJobStatus(job: BackgroundJob): string {
	const age = job.createdAt ? formatAge(job.createdAt) : "";
	const duration = job.results ? formatElapsed(job.createdAt, job.updatedAt) : "";

	const callLines = job.calls.map((call, index) => {
		const cs = job.callStates?.[index];
		const r = job.results?.[index];
		return formatCallStatusLine(call, cs, r);
	});

	const worktreeLabel = formatWorktreeLabel(job);
	const worktreeSuffix = worktreeLabel ? ` ${worktreeLabel}` : "";

	const scopeLine = formatWorktreeScopeLine(job);

	const when = job.status === "running" || job.status === "cancelling"
		? `started ${age} ago`
		: job.status === "needs_input"
			? `waiting ${age} ago (ran ${duration})`
		: job.status === "interrupted"
			? `interrupted ${age} ago (took ${duration})`
			: `took ${duration} (finished ${age} ago)`;

	const waitingLines = job.status === "needs_input" && job.waitingForInput
		? [
			job.interactive
				? `  Waiting on call ${job.waitingForInput.callIndex} for user direction`
				: `  Waiting on call ${job.waitingForInput.callIndex} at marker \`${job.waitingForInput.marker}\``,
			`  Continue: subagent_continue({ jobId: "${job.id}", prompt: "..." })`,
		]
		: [];

	return [
		`${job.id}: ${job.status}, ${job.calls.length} call${job.calls.length === 1 ? "" : "s"}, ${when}${worktreeSuffix}${scopeLine}`,
		...formatWorktreeMetadataLines(job),
		...waitingLines,
		...callLines,
	].join("\n");
}

/**
 * Format a list of all background jobs.
 */
export function formatJobList(jobs: BackgroundJob[]): string {
	if (jobs.length === 0) return "No background subagent jobs.";

	const lines: string[] = ["Background subagent jobs:", ""];
	for (const job of jobs) {
		const age = job.createdAt ? formatAge(job.createdAt) : "";
		const duration = job.results ? formatElapsed(job.createdAt, job.updatedAt) : "";

		const worktreeLabel = formatWorktreeLabel(job);
		const worktreeSuffix = worktreeLabel ? ` ${worktreeLabel}` : "";

		let when: string;
		if (job.status === "running" || job.status === "cancelling") {
			when = `started ${age} ago`;
		} else if (job.status === "needs_input") {
			when = `waiting ${age} ago (ran ${duration})`;
		} else if (job.status === "interrupted") {
			when = `interrupted ${age} ago (took ${duration})`;
		} else {
			when = `took ${duration} (finished ${age} ago)`;
		}
		lines.push(`  ${job.id}: ${job.status}, ${job.calls.length} call${job.calls.length === 1 ? "" : "s"}, ${when}${worktreeSuffix}`);
	}

	lines.push("");

	const running = jobs.filter((j) => j.status === "running" || j.status === "cancelling").length;
	const needsInput = jobs.filter((j) => j.status === "needs_input").length;
	const completed = jobs.filter((j) => j.status === "completed").length;
	const failed = jobs.filter((j) => j.status === "failed").length;
	const cancelled = jobs.filter((j) => j.status === "cancelled").length;
	const interrupted = jobs.filter((j) => j.status === "interrupted").length;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (needsInput > 0) parts.push(`${needsInput} needs_input`);
	if (completed > 0) parts.push(`${completed} completed`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (cancelled > 0) parts.push(`${cancelled} cancelled`);
	if (interrupted > 0) parts.push(`${interrupted} interrupted`);
	lines.push(parts.join(", "));

	return lines.join("\n");
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

function summarizePeekEvents(lines: string[]): {
	eventTypes: string[];
	assistantExcerpt: string;
	toolActivity: string;
	rawEvents: string[];
} {
	const eventTypes: string[] = [];
	let assistantExcerpt = "";
	let toolActivity = "";
	const activeTools = new Map<string, string>();

	for (const line of lines) {
		const event = parseEventLine(line);
		if (!event) continue;
		const type = typeof event.type === "string" ? event.type : "(unknown)";
		eventTypes.push(type);

		if (type === "message_start" || type === "message_update" || type === "message_end" || type === "turn_end") {
			const excerpt = extractMessageExcerpt(event.message);
			if (excerpt) assistantExcerpt = excerpt;
		} else if (type === "agent_end" && Array.isArray(event.messages)) {
			for (const message of event.messages) {
				const excerpt = extractMessageExcerpt(message);
				if (excerpt) assistantExcerpt = excerpt;
			}
		}

		if (type === "tool_execution_start" || type === "tool_execution_update") {
			const id = typeof event.toolCallId === "string" ? event.toolCallId : `${eventTypes.length}`;
			const name = typeof event.toolName === "string" ? event.toolName : "tool";
			const args = formatPlainToolArgs(event.args);
			const label = args ? `${name} ${args}` : name;
			activeTools.set(id, label);
			toolActivity = type === "tool_execution_update" ? `${label} (running, updated)` : `${label} (running)`;
		} else if (type === "tool_execution_end") {
			const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
			const name = typeof event.toolName === "string" ? event.toolName : "tool";
			if (id) activeTools.delete(id);
			toolActivity = `${name} (${event.isError ? "failed" : "completed"})`;
		}
	}

	if (activeTools.size > 0) {
		const latest = Array.from(activeTools.values()).at(-1);
		if (latest) toolActivity = `${latest} (running)`;
	}

	return {
		eventTypes: eventTypes.slice(-10),
		assistantExcerpt: assistantExcerpt ? truncate(assistantExcerpt, 1200) : "",
		toolActivity,
		rawEvents: lines,
	};
}

export function formatJobPeek(job: BackgroundJob, options: PeekOptions): string {
	const age = job.createdAt ? formatAge(job.createdAt) : "";
	const duration = job.results ? formatElapsed(job.createdAt, job.updatedAt) : "";
	const when = job.status === "running" || job.status === "cancelling"
		? `started ${age} ago`
		: job.status === "interrupted"
			? `interrupted ${age} ago${duration ? ` after ${duration}` : ""}`
			: `finished ${age} ago${duration ? ` after ${duration}` : ""}`;

	const targetCalls = options.callIndex !== undefined
		? [{ call: job.calls[options.callIndex], index: options.callIndex }]
		: job.calls.map((call, index) => ({ call, index }));

	const lines: string[] = [
		`${job.id}: ${job.status}, ${job.calls.length} call${job.calls.length === 1 ? "" : "s"}, ${when}`,
	];

	for (const { call, index } of targetCalls) {
		if (!call) continue;
		const state = job.callStates?.[index];
		const events = options.eventLinesByCall.find((entry) => entry.callIndex === index)?.lines ?? [];
		const summary = summarizePeekEvents(events);
		const phase = state?.phase ?? formatCallStatusLabel(job.results?.[index]);

		lines.push("");
		lines.push(`## Call ${index}: ${call.agent} — ${phase}`);
		lines.push(`Prompt: ${truncate(oneLine(call.prompt), 160)}`);
		if (state?.startedAt) {
			const elapsed = state.completedAt
				? formatDuration(state.completedAt - state.startedAt)
				: `${formatAge(state.startedAt)} elapsed`;
			lines.push(`Elapsed: ${elapsed}`);
		}

		if (events.length === 0) {
			lines.push("Events: no events yet");
			continue;
		}

		if (summary.toolActivity) lines.push(`Tool: ${summary.toolActivity}`);
		if (summary.assistantExcerpt) {
			lines.push("");
			lines.push("Assistant excerpt:");
			lines.push(summary.assistantExcerpt.replace(/\n/g, "\n  "));
		}

		lines.push("");
		lines.push(`Recent events: ${summary.eventTypes.join(" -> ") || "(none)"}`);

		if (options.includeRawEvents) {
			lines.push("");
			lines.push("Raw events:");
			for (const raw of summary.rawEvents) lines.push(raw);
		}
	}

	return lines.join("\n").trim();
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
