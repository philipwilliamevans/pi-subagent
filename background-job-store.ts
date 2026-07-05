/**
 * Background job persistence (durable registry).
 *
 * Persists background jobs under `.pi-subagent/jobs/<jobId>/` so that
 * terminal jobs survive parent process restart and can be inspected via
 * `subagent_status` and `subagent_result`.
 *
 * Atomic writes (write to temp file, then rename) prevent partial writes
 * from being read on reload. Persisted state excludes unserializable fields
 * (promise, abortController, live callbacks).
 *
 * Jobs that were `running` or `cancelling` when the process exited are
 * reloaded as `interrupted`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BackgroundJob,
  BackgroundJobStatus,
  NormalizedCall,
  SingleResult,
  BackgroundCompletionMode,
  CallState,
  WorktreeMode,
  WorktreeMetadata,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JOBS_DIR_NAME = "jobs";
const STATE_FILE = "state.json";
const RESULT_FILE = "result.md";

const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Persisted state shape (schema v1)
// ---------------------------------------------------------------------------

interface PersistedJobState {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  jobId: string;
  createdAt: number;
  updatedAt: number;
  status: BackgroundJobStatus;
  onComplete: BackgroundCompletionMode;
  calls: NormalizedCall[];
  callStates: CallState[];
  results?: SingleResult[];
  error?: string;
  worktreeMode?: WorktreeMode;
  worktreeScope?: string;
  worktreeMetadata?: WorktreeMetadata;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Return the full path to the `.pi-subagent/jobs` directory under `baseDir`.
 */
function getJobsDir(baseDir: string): string {
  return path.join(baseDir, ".pi-subagent", JOBS_DIR_NAME);
}

/**
 * Return the per-job directory path under `baseDir`.
 */
function getJobDir(baseDir: string, jobId: string): string {
  return path.join(getJobsDir(baseDir), jobId);
}

/**
 * Return the state.json path for a job.
 */
function getStatePath(baseDir: string, jobId: string): string {
  return path.join(getJobDir(baseDir, jobId), STATE_FILE);
}

/**
 * Return the result.md path for a job.
 */
function getResultPath(baseDir: string, jobId: string): string {
  return path.join(getJobDir(baseDir, jobId), RESULT_FILE);
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

/**
 * Convert a PersistedJobState to a BackgroundJob suitable for the in-memory
 * registry. Unserializable fields (promise, abortController) are left as
 * defaults.
 *
 * If the persisted status was "running" or "cancelling" it is upgraded to
 * "interrupted" so that the caller knows the job did not complete normally.
 */
function hydrateJob(state: PersistedJobState): BackgroundJob {
  let status = state.status;
  if (status === "running" || status === "cancelling") {
    status = "interrupted";
  }

  return {
    id: state.jobId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    status,
    onComplete: state.onComplete,
    calls: state.calls ?? [],
    callStates: state.callStates ?? [],
    results: state.results,
    error: state.error,
    worktreeMode: state.worktreeMode,
    worktreeScope: state.worktreeScope,
    worktreeMetadata: state.worktreeMetadata,
    // Unserializable — set to safe defaults
    promise: Promise.resolve(),
    abortController: undefined,
    intermediateResults: undefined,
  };
}

/**
 * Serialize a BackgroundJob to a plain PersistedJobState for disk storage.
 * Unserializable fields are excluded.
 */
function serializeJob(job: BackgroundJob): PersistedJobState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    jobId: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    onComplete: job.onComplete,
    calls: job.calls,
    callStates: job.callStates,
    results: job.results,
    error: job.error,
    worktreeMode: job.worktreeMode,
    worktreeScope: job.worktreeScope,
    worktreeMetadata: job.worktreeMetadata,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the jobs directory tree exists under `baseDir`.
 */
export function ensureJobsDir(baseDir: string): string {
  const dir = getJobsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist a background job's state to disk atomically.
 *
 * Writes to a temp file in the same directory, then renames to the final
 * path. This prevents partial writes from being read on restart.
 */
export function persistJobState(baseDir: string, job: BackgroundJob): void {
  const jobDir = getJobDir(baseDir, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  const state = serializeJob(job);
  const tmpName = `.${STATE_FILE}.${randomUUID()}.tmp`;
  const tmpPath = path.join(jobDir, tmpName);

  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmpPath, getStatePath(baseDir, job.id));
}

/**
 * Persist a background job's result text to disk.
 *
 * This stores the full result.md artifact generated from `formatJobResults`.
 */
export function persistJobResult(
  baseDir: string,
  jobId: string,
  resultText: string,
): void {
  const jobDir = getJobDir(baseDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const tmpName = `.${RESULT_FILE}.${randomUUID()}.tmp`;
  const tmpPath = path.join(jobDir, tmpName);

  fs.writeFileSync(tmpPath, resultText, "utf-8");
  fs.renameSync(tmpPath, getResultPath(baseDir, jobId));
}

/**
 * Remove a persisted job's directory from disk.
 */
export function removePersistedJob(baseDir: string, jobId: string): void {
  const jobDir = getJobDir(baseDir, jobId);
  try {
    fs.rmSync(jobDir, { recursive: true, force: true });
  } catch {
    // Ignore — the directory may already be gone.
  }
}

/**
 * Load one persisted job from disk by its jobId.
 * Returns undefined if the job does not exist or cannot be parsed.
 */
export function loadPersistedJob(
  baseDir: string,
  jobId: string,
): BackgroundJob | undefined {
  const statePath = getStatePath(baseDir, jobId);
  try {
    if (!fs.existsSync(statePath)) return undefined;
    const raw = fs.readFileSync(statePath, "utf-8");
    const state: PersistedJobState = JSON.parse(raw);

    if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      console.warn(
        `[pi-subagent] Skipping persisted job "${jobId}": unsupported schema version ${state.schemaVersion}.`,
      );
      return undefined;
    }

    return hydrateJob(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pi-subagent] Failed to load persisted job "${jobId}": ${message}`,
    );
    return undefined;
  }
}

/**
 * Load all persisted terminal jobs from disk under `baseDir`.
 *
 * Returns only jobs that have reached a terminal state (completed, failed,
 * cancelled, interrupted). Active/running jobs from a previous session are
 * returned as `interrupted`.
 *
 * Corrupted entries are skipped with a warning.
 */
export function loadPersistedJobs(baseDir: string): BackgroundJob[] {
  const jobsDir = getJobsDir(baseDir);
  try {
    if (!fs.existsSync(jobsDir)) return [];

    const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
    const jobs: BackgroundJob[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = loadPersistedJob(baseDir, entry.name);
      if (job) jobs.push(job);
    }

    return jobs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pi-subagent] Failed to load persisted jobs: ${message}`,
    );
    return [];
  }
}

/**
 * List all persisted job IDs under `baseDir`.
 */
export function listPersistedJobIds(baseDir: string): string[] {
  const jobsDir = getJobsDir(baseDir);
  try {
    if (!fs.existsSync(jobsDir)) return [];
    const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
