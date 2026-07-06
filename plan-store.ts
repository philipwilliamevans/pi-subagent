/**
 * Plan persistence (durable registry).
 *
 * Persists queued plans under `.pi-subagent/plans/<planId>/` so that
 * pending plans survive parent process restart and can fire when
 * background jobs complete in a later session.
 *
 * Atomic writes (write to temp file, then rename) prevent partial writes
 * from being read on reload. Persisted state excludes runtime-only fields.
 *
 * Fired plans are kept for debugging (last MAX_PERSISTED_PLANS) and purged
 * oldest-first on each new enqueue.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { QueuedPlan } from "./types.js";
import { MAX_PERSISTED_PLANS } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLANS_DIR_NAME = "plans";
const STATE_FILE = "state.json";
const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Persisted state shape (schema v1)
// ---------------------------------------------------------------------------

interface PersistedPlanState {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  id: string;
  plan: string;
  dependsOn: string[];
  replace: boolean;
  status: "pending" | "ready" | "fired";
  createdAt: number;
  firedAt?: number;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Return the full path to the `.pi-subagent/plans` directory under `baseDir`.
 */
function getPlansDir(baseDir: string): string {
  return path.join(baseDir, ".pi-subagent", PLANS_DIR_NAME);
}

/**
 * Return the per-plan directory path under `baseDir`.
 */
function getPlanDir(baseDir: string, planId: string): string {
  return path.join(getPlansDir(baseDir), planId);
}

/**
 * Return the state.json path for a plan.
 */
function getStatePath(baseDir: string, planId: string): string {
  return path.join(getPlanDir(baseDir, planId), STATE_FILE);
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function hydratePlan(state: PersistedPlanState): QueuedPlan {
  return {
    id: state.id,
    plan: state.plan,
    dependsOn: state.dependsOn,
    replace: state.replace,
    status: state.status,
    createdAt: state.createdAt,
    firedAt: state.firedAt,
  };
}

function serializePlan(plan: QueuedPlan): PersistedPlanState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: plan.id,
    plan: plan.plan,
    dependsOn: plan.dependsOn,
    replace: plan.replace,
    status: plan.status,
    createdAt: plan.createdAt,
    firedAt: plan.firedAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the plans directory tree exists under `baseDir`.
 */
export function ensurePlansDir(baseDir: string): string {
  const dir = getPlansDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist a plan's state to disk atomically.
 *
 * Writes to a temp file in the same directory, then renames to the final
 * path. This prevents partial writes from being read on restart.
 */
export function persistPlanState(baseDir: string, plan: QueuedPlan): void {
  const planDir = getPlanDir(baseDir, plan.id);
  fs.mkdirSync(planDir, { recursive: true });

  const state = serializePlan(plan);
  const tmpName = `.${STATE_FILE}.${randomUUID()}.tmp`;
  const tmpPath = path.join(planDir, tmpName);

  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmpPath, getStatePath(baseDir, plan.id));
}

/**
 * Remove a persisted plan's directory from disk.
 */
export function removePersistedPlan(baseDir: string, planId: string): void {
  const planDir = getPlanDir(baseDir, planId);
  try {
    fs.rmSync(planDir, { recursive: true, force: true });
  } catch {
    // Ignore — the directory may already be gone.
  }
}

/**
 * Load one persisted plan from disk by its planId.
 * Returns undefined if the plan does not exist or cannot be parsed.
 */
export function loadPersistedPlan(
  baseDir: string,
  planId: string,
): QueuedPlan | undefined {
  const statePath = getStatePath(baseDir, planId);
  try {
    if (!fs.existsSync(statePath)) return undefined;
    const raw = fs.readFileSync(statePath, "utf-8");
    const state: PersistedPlanState = JSON.parse(raw);

    if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      console.warn(
        `[pi-subagent] Skipping persisted plan "${planId}": unsupported schema version ${state.schemaVersion}.`,
      );
      return undefined;
    }

    return hydratePlan(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pi-subagent] Failed to load persisted plan "${planId}": ${message}`,
    );
    return undefined;
  }
}

/**
 * Load all persisted plans from disk under `baseDir`.
 *
 * Returns both pending and ready plans so that pending plans from a previous
 * session can be re-checked for terminal dependencies.
 *
 * Corrupted entries are skipped with a warning.
 */
export function loadPersistedPlans(baseDir: string): QueuedPlan[] {
  const plansDir = getPlansDir(baseDir);
  try {
    if (!fs.existsSync(plansDir)) return [];

    const entries = fs.readdirSync(plansDir, { withFileTypes: true });
    const plans: QueuedPlan[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const plan = loadPersistedPlan(baseDir, entry.name);
      if (plan) plans.push(plan);
    }

    return plans;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pi-subagent] Failed to load persisted plans: ${message}`,
    );
    return [];
  }
}

/**
 * List all persisted plan IDs under `baseDir`.
 */
export function listPersistedPlanIds(baseDir: string): string[] {
  const plansDir = getPlansDir(baseDir);
  try {
    if (!fs.existsSync(plansDir)) return [];
    const entries = fs.readdirSync(plansDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Purge oldest fired plans beyond MAX_PERSISTED_PLANS.
 *
 * Keeps only the most recent `keepCount` fired plans on disk.
 * Pending and ready plans are never purged.
 */
export function purgeOldFiredPlans(baseDir: string, keepCount: number = MAX_PERSISTED_PLANS): void {
  const plansDir = getPlansDir(baseDir);
  try {
    if (!fs.existsSync(plansDir)) return;

    const entries = fs.readdirSync(plansDir, { withFileTypes: true });
    const firedPlans: { id: string; firedAt: number }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const plan = loadPersistedPlan(baseDir, entry.name);
      if (plan && plan.status === "fired" && plan.firedAt) {
        firedPlans.push({ id: entry.name, firedAt: plan.firedAt });
      }
    }

    if (firedPlans.length <= keepCount) return;

    // Sort oldest-first
    firedPlans.sort((a, b) => a.firedAt - b.firedAt);

    const toRemove = firedPlans.slice(0, firedPlans.length - keepCount);
    for (const entry of toRemove) {
      removePersistedPlan(baseDir, entry.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pi-subagent] Failed to purge old fired plans: ${message}`,
    );
  }
}
