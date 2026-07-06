/**
 * Background job lifecycle helpers.
 *
 * Centralizes cancellation and terminal-state transitions for background
 * subagent jobs so that call states are consistent during and after
 * cancellation, regardless of worker completion ordering.
 */

import type { BackgroundJob, SingleResult } from "./types.js";
import { isResultError } from "./types.js";

/**
 * Mark all actively-running call states (queued, spawning, running) as cancelled.
 *
 * Called synchronously when the cancellation is confirmed so that
 * in-flight or not-yet-started calls are immediately reflected as
 * cancelled in status queries and completion messages.
 */
export function markPendingCallsCancelled(job: BackgroundJob, now: number): void {
  for (const cs of job.callStates) {
    if (cs.phase === "queued" || cs.phase === "spawning" || cs.phase === "running") {
      cs.phase = "cancelled";
      if (!cs.completedAt) cs.completedAt = now;
    }
  }
}

/**
 * Transition a call to its terminal result state, but refuse to overwrite
 * a pre-existing cancelled phase when the job is being cancelled.
 *
 * Rules:
 *  - If the job is/was being cancelled and the call is already marked
 *    cancelled, preserve that cancelled status.
 *  - If the call already reached a terminal state before cancellation
 *    (needs_input / completed / failed / cancelled), keep it unchanged.
 *  - Otherwise, set the phase based on the result (completed or failed).
 *
 * Returns the phase that was set (or preserved).
 */
export function finishCallState(
  job: BackgroundJob,
  index: number,
  result: SingleResult,
  now: number,
): "needs_input" | "completed" | "failed" | "cancelled" {
  const cs = job.callStates[index];

  // If the job is/was being cancelled and the call was already marked
  // cancelled, preserve the cancelled status — do not let the result
  // overwrite it as "failed" or "completed".
  if ((job.status === "cancelling" || job.status === "cancelled") && cs.phase === "cancelled") {
    return "cancelled";
  }

  // Skip if already in a terminal state (e.g. completed before cancellation).
  if (cs.phase === "needs_input" || cs.phase === "completed" || cs.phase === "failed" || cs.phase === "cancelled") {
    return cs.phase;
  }

  // Normal terminal transition from the result.
  cs.phase = isResultError(result) ? "failed" : "completed";
  cs.completedAt = now;
  return cs.phase;
}
