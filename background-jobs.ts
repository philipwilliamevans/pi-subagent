/**
 * In-memory background subagent job registry.
 *
 * Tracks running/completed/failed background jobs and provides helpers
 * for job ID generation, querying, and cleanup.
 */

import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "./types.js";

const backgroundJobs = new Map<string, BackgroundJob>();
const MAX_BACKGROUND_JOBS = 2;

function generateJobId(): string {
  return `subjob_${randomUUID().slice(0, 8)}`;
}

/**
 * Number of currently active background jobs (running or being cancelled).
 */
export function getActiveBackgroundJobCount(): number {
  let count = 0;
  for (const job of backgroundJobs.values()) {
    if (job.status === "running" || job.status === "cancelling") count++;
  }
  return count;
}

/**
 * Look up a background job by ID.
 */
export function getBackgroundJob(id: string): BackgroundJob | undefined {
  return backgroundJobs.get(id);
}

/**
 * Return all registered background jobs (most recent first).
 */
export function getAllBackgroundJobs(): BackgroundJob[] {
  const jobs = Array.from(backgroundJobs.values());
  jobs.reverse(); // most recent first
  return jobs;
}

/**
 * Register a new background job.
 */
export function registerBackgroundJob(job: BackgroundJob): void {
  backgroundJobs.set(job.id, job);
}

/**
 * Remove a background job from the registry.
 */
export function removeBackgroundJob(id: string): void {
  backgroundJobs.delete(id);
}

/**
 * Clear all background jobs (for testing).
 */
export function clearBackgroundJobs(): void {
  backgroundJobs.clear();
}

export { generateJobId, MAX_BACKGROUND_JOBS };
