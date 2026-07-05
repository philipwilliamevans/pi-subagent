/**
 * Background subagent job registry with optional disk persistence.
 *
 * Tracks running/completed/failed background jobs and provides helpers
 * for job ID generation, querying, and cleanup.
 *
 * When a base directory is configured (via `setJobStoreBaseDir`), every
 * state transition is persisted to `.pi-subagent/jobs/<jobId>/state.json`
 * so that terminal jobs survive process restarts.
 */

import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "./types.js";
// Note: .ts extension required — this is a runtime value import (not type-only), and
// Node.js cannot resolve .js -> .ts for local files without a custom loader.
import {
  persistJobState,
  persistJobResult,
  loadPersistedJobs,
  removePersistedJob,
  listPersistedJobIds,
  ensureJobsDir,
} from "./background-job-store.ts";

const backgroundJobs = new Map<string, BackgroundJob>();
const MAX_BACKGROUND_JOBS = 2;

/** Base directory for persistence, or null if persistence is disabled. */
let storeBaseDir: string | null = null;

function generateJobId(): string {
  return `subjob_${randomUUID().slice(0, 8)}`;
}

/**
 * Configure the base directory for background job persistence.
 *
 * Call this once on extension startup. Set to `null` to disable
 * persistence (useful in tests or ephemeral contexts).
 */
export function setJobStoreBaseDir(baseDir: string | null): void {
  storeBaseDir = baseDir;
  if (baseDir !== null) {
    ensureJobsDir(baseDir);
  }
}

/**
 * Get the current base directory for job persistence, or null if
 * persistence is disabled.
 */
export function getJobStoreBaseDir(): string | null {
  return storeBaseDir;
}

/**
 * Persist a job's current state to disk, if a base directory is configured.
 */
function persistJobIfEnabled(job: BackgroundJob): void {
  if (storeBaseDir !== null) {
    try {
      persistJobState(storeBaseDir, job);
    } catch (error) {
      console.warn(
        `[pi-subagent] Failed to persist job "${job.id}" state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Startup / reload
// ---------------------------------------------------------------------------

/**
 * Load all terminal (completed, failed, cancelled, interrupted) jobs from disk
 * into the in-memory registry.
 *
 * Jobs that were running or cancelling when the process exited are loaded
 * with status "interrupted".
 *
 * Returns the number of jobs loaded.
 */
export function reloadPersistedJobs(): number {
  if (storeBaseDir === null) return 0;

  const loaded = loadPersistedJobs(storeBaseDir);
  let count = 0;

  for (const job of loaded) {
    // Only load terminal jobs — don't re-add jobs already in memory
    if (!backgroundJobs.has(job.id)) {
      backgroundJobs.set(job.id, job);
      count++;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Query / lookup
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Register a new background job and persist its state to disk.
 */
export function registerBackgroundJob(job: BackgroundJob): void {
  backgroundJobs.set(job.id, job);
  persistJobIfEnabled(job);
}

/**
 * Update a job's status in the registry and persist the change.
 */
export function updateBackgroundJobStatus(
  id: string,
  status: BackgroundJob["status"],
): BackgroundJob | undefined {
  const job = backgroundJobs.get(id);
  if (!job) return undefined;

  job.status = status;
  job.updatedAt = Date.now();
  persistJobIfEnabled(job);
  return job;
}

/**
 * Store results on a completed/failed/cancelled job and persist.
 */
export function setBackgroundJobResults(
  id: string,
  results: NonNullable<BackgroundJob["results"]>,
  error?: string,
): BackgroundJob | undefined {
  const job = backgroundJobs.get(id);
  if (!job) return undefined;

  job.results = results;
  job.updatedAt = Date.now();
  if (error !== undefined) job.error = error;
  persistJobIfEnabled(job);
  return job;
}

/**
 * Persist a result artifact (result.md) for a completed job.
 */
export function persistJobResultArtifact(
  id: string,
  resultText: string,
): void {
  if (storeBaseDir === null) return;
  try {
    persistJobResult(storeBaseDir, id, resultText);
  } catch (error) {
    console.warn(
      `[pi-subagent] Failed to persist result artifact for job "${id}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Remove a background job from the registry and delete its persisted files.
 */
export function removeBackgroundJob(id: string): void {
  backgroundJobs.delete(id);
  if (storeBaseDir !== null) {
    try {
      removePersistedJob(storeBaseDir, id);
    } catch (error) {
      console.warn(
        `[pi-subagent] Failed to remove persisted job "${id}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Clear all background jobs from the registry without removing persisted data.
 * Useful for testing.
 */
export function clearBackgroundJobs(): void {
  backgroundJobs.clear();
}

/**
 * Return the total number of jobs in the registry (all statuses).
 */
export function getTotalJobCount(): number {
  return backgroundJobs.size;
}

export { generateJobId, MAX_BACKGROUND_JOBS };
