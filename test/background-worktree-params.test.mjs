import test from "node:test";
import assert from "node:assert/strict";

test("misplaced worktreeMode inside a call returns a clear error", async () => {
  const { getMisplacedBackgroundWorktreeFieldError } = await import("../background-params.ts");

  const error = getMisplacedBackgroundWorktreeFieldError([
    {
      agent: "implementer",
      prompt: "Review architecture.",
      worktreeMode: "isolated",
    },
  ]);

  assert.match(error, /calls\[0\]\.worktreeMode/);
  assert.match(error, /top-level/);
  assert.match(error, /outside the calls array/);
});

test("misplaced worktreeScope inside a call returns a clear error", async () => {
  const { getMisplacedBackgroundWorktreeFieldError } = await import("../background-params.ts");

  const error = getMisplacedBackgroundWorktreeFieldError([
    {
      agent: "implementer",
      prompt: "Review architecture.",
      worktreeScope: "ARCHITECTURE.md",
    },
  ]);

  assert.match(error, /calls\[0\]\.worktreeScope/);
  assert.match(error, /top-level/);
});

test("top-level-only background worktree params produce no call-level error", async () => {
  const { getMisplacedBackgroundWorktreeFieldError } = await import("../background-params.ts");

  const error = getMisplacedBackgroundWorktreeFieldError([
    {
      agent: "implementer",
      prompt: "Review architecture.",
    },
  ]);

  assert.equal(error, null);
});
