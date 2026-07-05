import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-worktree-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "Initial commit"]);
  return root;
}

function makeRepoAt(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "Initial commit"]);
  return root;
}

test("createWorktree creates an isolated worktree with branch metadata", async () => {
  const mod = await import("../worktree.ts");
  const repo = makeRepo();
  try {
    const metadata = mod.createWorktree(repo, "subjob_test123");
    const expectedPath = mod.getWorktreePath(repo, "subjob_test123");

    assert.ok(fs.existsSync(metadata.path));
    assert.equal(metadata.path, expectedPath);
    assert.equal(path.relative(repo, metadata.path).startsWith(".."), true);
    assert.match(metadata.path, new RegExp(`${path.sep}\\.pi-worktrees${path.sep}`));
    assert.match(path.basename(path.dirname(metadata.path)), new RegExp(`^${path.basename(repo)}-[0-9a-f]{8}$`));
    assert.match(metadata.branch, /^codex\/subjob_subjob_test123$/);
    assert.match(metadata.baseCommit, /^[0-9a-f]{40}$/);
    assert.equal(git(metadata.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), metadata.branch);
    assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(repo), ".pi-worktrees"), { recursive: true, force: true });
  }
});

test("worktree change detection and patch include untracked files", async () => {
  const mod = await import("../worktree.ts");
  const repo = makeRepo();
  try {
    const metadata = mod.createWorktree(repo, "subjob_patch123");
    fs.writeFileSync(path.join(metadata.path, "isolated-test-output.md"), "summary\n");

    const changed = mod.getWorktreeChangedFiles(metadata.path);
    assert.deepEqual(changed, ["isolated-test-output.md"]);

    const patchPath = path.join(repo, ".pi-subagent", "jobs", "subjob_patch123", "worktree.patch");
    const actualPatchPath = mod.createWorktreePatch(metadata.path, metadata.baseCommit, patchPath);
    assert.equal(actualPatchPath, patchPath);
    assert.ok(fs.existsSync(patchPath));
    assert.match(fs.readFileSync(patchPath, "utf-8"), /isolated-test-output\.md/);
    assert.match(fs.readFileSync(patchPath, "utf-8"), /summary/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(repo), ".pi-worktrees"), { recursive: true, force: true });
  }
});

test("worktree project slugs distinguish repos with the same basename", async () => {
  const mod = await import("../worktree.ts");
  const parentA = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-worktree-a-"));
  const parentB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-worktree-b-"));
  const repoA = makeRepoAt(path.join(parentA, "same-name"));
  const repoB = makeRepoAt(path.join(parentB, "same-name"));

  try {
    const slugA = mod.getWorktreeProjectSlug(repoA);
    const slugB = mod.getWorktreeProjectSlug(repoB);

    assert.match(slugA, /^same-name-[0-9a-f]{8}$/);
    assert.match(slugB, /^same-name-[0-9a-f]{8}$/);
    assert.notEqual(slugA, slugB);
    assert.notEqual(mod.getWorktreeBaseDir(repoA), mod.getWorktreeBaseDir(repoB));
  } finally {
    fs.rmSync(parentA, { recursive: true, force: true });
    fs.rmSync(parentB, { recursive: true, force: true });
  }
});
