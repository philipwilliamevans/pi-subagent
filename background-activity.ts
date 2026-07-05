/**
 * Background subagent activity tracking — deduplicated recent activity
 * from partial snapshot updates.
 *
 * Uses a cursor (activityCursor) on CallState to avoid duplicating activity
 * strings when the same message history is replayed in partial onUpdate calls.
 */

import { type CallState, type SingleResult, getDisplayItems } from "./types.ts";

/**
 * Format a tool-call display line for recent activity.
 */
export function formatActivityLine(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "read":
      return `→ read ${args.path || args.file_path || "?"}`;
    case "bash":
      return `$ ${String(args.command || "").slice(0, 60)}`;
    case "write":
      return `→ write ${args.path || "?"}`;
    case "edit":
      return `→ edit ${args.path || "?"}`;
    case "grep":
      return `→ grep /${args.pattern || ""}/ ${args.path || ""}`;
    default:
      return `→ ${toolName}`;
  }
}

/**
 * Update call state from partial subagent results (streamed via onUpdate).
 *
 * Uses a cursor (activityCursor) on CallState to avoid duplicating activity
 * strings when the same message history is replayed in partial snapshots.
 *
 * New activity is appended (newest-last) for simpler deduplication.
 * recentActivity is bounded to the latest 5 entries.
 */
export function updateCallStateFromPartial(
  cs: CallState,
  partial: SingleResult,
): void {
  // Do not update cancelled calls — their phase is final.
  if (cs.phase === "cancelled") return;

  const items = getDisplayItems(partial.messages);
  const toolCallItems = items.filter(
    (i) => i.type === "toolCall",
  ) as Array<{ type: "toolCall"; name: string; args: Record<string, unknown> }>;
  const totalToolCalls = toolCallItems.length;

  // Update tool call count.
  if (totalToolCalls > cs.toolCalls) {
    cs.toolCalls = totalToolCalls;
  }

  // Append-only by cursor — only process new tool call items.
  const cursor = cs.activityCursor ?? 0;
  const newItems = toolCallItems.slice(cursor);
  if (newItems.length > 0) {
    const newActivity = newItems.map((i) => formatActivityLine(i.name, i.args));
    // Append newest-last, keep latest 5.
    cs.recentActivity = [...cs.recentActivity, ...newActivity].slice(-5);
    cs.activityCursor = totalToolCalls;
  }

  // Record spawnedAt on first evidence of process activity.
  if (!cs.spawnedAt && totalToolCalls > 0) {
    cs.spawnedAt = Date.now();
  }
}
