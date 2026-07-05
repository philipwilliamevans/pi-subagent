/**
 * Background subagent parameter validation helpers.
 */

export function getMisplacedBackgroundWorktreeFieldError(rawCalls: unknown): string | null {
  if (!Array.isArray(rawCalls)) return null;

  for (const [index, raw] of rawCalls.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const misplacedFields = ["worktreeMode", "worktreeScope"].filter((field) =>
      Object.prototype.hasOwnProperty.call(item, field),
    );
    if (misplacedFields.length === 0) continue;

    return `Invalid subagent_start parameters: ${misplacedFields.map((field) => `calls[${index}].${field}`).join(", ")} must be top-level field${misplacedFields.length === 1 ? "" : "s"}, not per-call field${misplacedFields.length === 1 ? "" : "s"}. Move ${misplacedFields.join(" and ")} outside the calls array.`;
  }

  return null;
}
