/**
 * Plan queue registry.
 *
 * In-memory registry for queued plans with optional disk persistence.
 * Plans are stored alongside background jobs under `.pi-subagent/plans/`.
 *
 * When a background job reaches a terminal state, the plan queue is
 * checked and any pending plan whose dependencies are all terminal is
 * marked "ready" and surfaced to the parent agent via an injected message.
 */

import { randomUUID } from "node:crypto";
import type { QueuedPlan } from "./types.js";
import { isJobTerminal } from "./types.js";
import {
  persistPlanState,
  removePersistedPlan,
  loadPersistedPlans,
  purgeOldFiredPlans,
  ensurePlansDir,
} from "./plan-store.ts";
import type { BackgroundJob } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

const plans = new Map<string, QueuedPlan>();

/** Base directory for persistence, or null if persistence is disabled. */
let storeBaseDir: string | null = null;

// ---------------------------------------------------------------------------
// Storage configuration
// ---------------------------------------------------------------------------

/**
 * Configure the base directory for plan persistence.
 *
 * Call this once on extension startup alongside the job store setup.
 * Set to `null` to disable persistence (useful in tests or ephemeral contexts).
 */
export function setPlanStoreBaseDir(baseDir: string | null): void {
  storeBaseDir = baseDir;
  if (baseDir !== null) {
    ensurePlansDir(baseDir);
  }
}

/**
 * Get the current base directory for plan persistence, or null if
 * persistence is disabled.
 */
export function getPlanStoreBaseDir(): string | null {
  return storeBaseDir;
}

/**
 * Persist a plan's state to disk, if a base directory is configured.
 */
function persistPlanIfEnabled(plan: QueuedPlan): void {
  if (storeBaseDir !== null) {
    try {
      persistPlanState(storeBaseDir, plan);
    } catch (error) {
      console.warn(
        `[pi-subagent] Failed to persist plan "${plan.id}" state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generatePlanId(): string {
  return `plan_${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Startup / reload
// ---------------------------------------------------------------------------

/**
 * Load all persisted plans from disk into the in-memory registry.
 *
 * Plans marked "ready" are re-checked (their dependencies may have
 * completed in a previous session). Plans whose deps are still pending
 * stay pending for processing when jobs complete.
 *
 * Returns the number of plans loaded.
 */
export function reloadPersistedPlans(): number {
  if (storeBaseDir === null) return 0;

  const loaded = loadPersistedPlans(storeBaseDir);
  let count = 0;

  for (const plan of loaded) {
    if (!plans.has(plan.id)) {
      plans.set(plan.id, plan);
      count++;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Query / lookup
// ---------------------------------------------------------------------------

/**
 * Look up a queued plan by ID.
 */
export function getPlan(id: string): QueuedPlan | undefined {
  return plans.get(id);
}

/**
 * Return all registered queued plans (most recent first).
 */
export function getAllPlans(): QueuedPlan[] {
  const result = Array.from(plans.values());
  result.reverse(); // most recent first
  return result;
}

/**
 * Return all pending plans (not yet ready or fired).
 */
export function getPendingPlans(): QueuedPlan[] {
  return Array.from(plans.values()).filter((p) => p.status === "pending");
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Register a new queued plan and persist it to disk.
 *
 * If `replace: true` and an existing plan has the same dependsOn set
 * (same IDs in any order), the existing plan is replaced.
 *
 * Returns the registered plan.
 */
export function registerPlan(
  planText: string,
  dependsOn: string[],
  replace: boolean,
): QueuedPlan {
  const now = Date.now();

  // If replace, find and remove any existing plan with exactly the same dependsOn set
  if (replace) {
    const normalized = new Set(dependsOn);
    for (const [id, existing] of plans) {
      if (existing.status !== "fired" && setsEqual(new Set(existing.dependsOn), normalized)) {
        plans.delete(id);
        if (storeBaseDir !== null) {
          try {
            removePersistedPlan(storeBaseDir, id);
          } catch {
            // Best-effort cleanup
          }
        }
      }
    }
  }

  const plan: QueuedPlan = {
    id: generatePlanId(),
    plan: planText,
    dependsOn,
    replace,
    status: "pending",
    createdAt: now,
  };

  plans.set(plan.id, plan);
  persistPlanIfEnabled(plan);
  return plan;
}

/**
 * Update a plan's status in the registry and persist the change.
 */
export function updatePlanStatus(
  id: string,
  status: QueuedPlan["status"],
  now?: number,
): QueuedPlan | undefined {
  const plan = plans.get(id);
  if (!plan) return undefined;

  plan.status = status;
  if (status === "fired") {
    plan.firedAt = now ?? Date.now();
  }
  persistPlanIfEnabled(plan);
  return plan;
}

/**
 * Remove a plan from the registry and delete its persisted files.
 */
export function removePlan(id: string): void {
  plans.delete(id);
  if (storeBaseDir !== null) {
    try {
      removePersistedPlan(storeBaseDir, id);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Purge old fired plans from disk.
 */
export function purgeOldPlans(): void {
  if (storeBaseDir !== null) {
    purgeOldFiredPlans(storeBaseDir);
  }
}

/**
 * Check if a plan's dependencies have all reached terminal status.
 */
export function arePlanDepsTerminal(
  plan: QueuedPlan,
  getJob: (id: string) => BackgroundJob | undefined,
): { ready: boolean; details: { id: string; status: string }[] } {
  const details = plan.dependsOn.map((jobId) => {
    const job = getJob(jobId);
    const status = job ? job.status : "unknown";
    return { id: jobId, status };
  });

  const ready = plan.dependsOn.every((jobId) => {
    const job = getJob(jobId);
    return job !== undefined && isJobTerminal(job.status);
  });

  return { ready, details };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/**
 * Clear all plans from the registry without removing persisted data.
 * Useful for testing.
 */
export function clearPlans(): void {
  plans.clear();
}

/**
 * Return the total number of plans in the registry (all statuses).
 */
export function getTotalPlanCount(): number {
  return plans.size;
}
