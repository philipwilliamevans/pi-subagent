import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorktreeMetadata } from "./types.js";

const WORKTREE_BRANCH_PREFIX = "codex/subjob";

function git(cwd: string, args: string[], timeout = 30_000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
  });
}

export function getRepoRoot(cwd: string): string {
  return fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
}

export function getHeadCommit(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

export function hashRepoRoot(repoRoot: string): string {
  return createHash("sha256").update(fs.realpathSync(repoRoot)).digest("hex").slice(0, 8);
}

export function getWorktreeProjectSlug(repoRoot: string): string {
  return `${path.basename(repoRoot)}-${hashRepoRoot(repoRoot)}`;
}

export function getWorktreeBaseDir(repoRoot: string): string {
  return path.join(path.dirname(repoRoot), ".pi-worktrees", getWorktreeProjectSlug(repoRoot));
}

export function getWorktreePath(cwd: string, jobId: string): string {
  const repoRoot = getRepoRoot(cwd);
  return path.join(getWorktreeBaseDir(repoRoot), jobId);
}

export function mapRepoPathToWorktree(
  repoRoot: string,
  worktreePath: string,
  targetPath: string,
): string | null {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRepoRoot, resolvedTarget);
  if (relative === "") return path.resolve(worktreePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return path.resolve(worktreePath, relative);
}

export function createWorktree(cwd: string, jobId: string): WorktreeMetadata {
  const repoRoot = getRepoRoot(cwd);
  const baseCommit = getHeadCommit(repoRoot);
  const worktreesDir = getWorktreeBaseDir(repoRoot);
  fs.mkdirSync(worktreesDir, { recursive: true });

  const worktreePath = path.join(worktreesDir, jobId);
  const branch = `${WORKTREE_BRANCH_PREFIX}_${jobId}`;

  git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);

  return {
    path: worktreePath,
    branch,
    baseCommit,
  };
}

export function getWorktreeChangedFiles(worktreePath: string): string[] {
  const output = git(worktreePath, ["status", "--porcelain"], 5_000);
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();
}

export function createWorktreePatch(
  worktreePath: string,
  baseCommit: string,
  outputPath: string,
): string | null {
  // Include untracked files in the diff without staging content.
  git(worktreePath, ["add", "-N", "."], 5_000);
  const patch = git(worktreePath, ["diff", "--binary", baseCommit, "--", "."], 10_000);
  if (!patch.trim()) return null;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, patch, { encoding: "utf-8", mode: 0o644 });
  return outputPath;
}
