# Plan: Remove Unused `intermediateResults` Field

## Goal

Remove the `intermediateResults` field from the `BackgroundJob` type and all associated writes, reads, and cleanup code, because no consumer uses this mutable state and it adds complexity without benefit.

This addresses the known risk that unused mutable state makes the lifecycle harder to reason about.

## Non-goals

- No changes to the activity-tracking cursor mechanism (`activityCursor`, `updateCallStateFromPartial` in `background-activity.ts`).
- No changes to `recentActivity` or `toolCalls` on `CallState` (those are consumed by `formatJobStatus`).
- No changes to the `SingleResult` or `CallState` types.
- No changes to cancellation semantics or phase transitions.
- No changes to durable persistence.
- No changes to `subagent_status`, `subagent_result`, or any other tool surface.

## Recommended Implementation Order

Implement after or alongside the `running`-phase fix (plan `background-set-running-phase.md`), or independently at any time. This is a small, safe removal with no user-visible effect.

## Current Problem

The `intermediateResults` field is declared on the `BackgroundJob` interface in `types.ts`:

```ts
/** Streaming partial results, updated as calls progress. */
intermediateResults?: SingleResult[];
```

It is written and read in three places inside `runBackgroundSubagentJob` in `index.ts`:

1. **Initialisation** (line ~1559): `job.intermediateResults = job.calls.map((call) => makePlaceholderResult(call));`
2. **Update** (line ~1590–1592): Inside the `onUpdate` callback, the partial result is stored at `job.intermediateResults[index]`.
3. **Cleanup** (lines ~1607, ~1629): `job.intermediateResults = undefined;` in both the success and catch paths.

In `background-job-store.ts` (line ~126), the persisted state explicitly overrides `intermediateResults` to `undefined` during serialisation — confirming the field is intentionally excluded from storage.

No public API (neither `subagent_status` nor `subagent_result`) reads `intermediateResults`. The `CallState` fields (`phase`, `toolCalls`, `recentActivity`, `activityCursor`) already carry the live execution state that status rendering needs. The intermediate `SingleResult` objects stored in `intermediateResults` are populated but never surfaced.

This unused mutable state:
- Makes the lifecycle harder to reason about.
- Risks stale partial data being inspected if someone adds a consumer without understanding the lifecycle.
- Creates a serialisation exclusion in `background-job-store.ts` that would be unnecessary without the field.

## Proposed Behaviour

- Delete the `intermediateResults` field declaration from the `BackgroundJob` type.
- Remove the initialisation (`job.intermediateResults = ...`) in `runBackgroundSubagentJob`.
- Remove the update (`job.intermediateResults[index] = ...`) in the `onUpdate` callback.
- Remove the two cleanup lines (`job.intermediateResults = undefined`).
- Remove the serialisation override in `background-job-store.ts` that sets `intermediateResults: undefined`.
- Ensure TypeScript compiles and all tests pass with no remaining references.

The `onUpdate` callback should still call `updateCallStateFromPartial(cs, details.results[0])` — that is the consumer-facing update path that populates `CallState` fields (tool call count, recent activity, spawnedAt). The `intermediateResults` assignment was an additional, unused store.

## Implementation Notes

### Changes by file

**`types.ts`**
- Remove the `intermediateResults?: SingleResult[];` line from the `BackgroundJob` interface.

**`index.ts`**
- Remove `job.intermediateResults = job.calls.map((call) => makePlaceholderResult(call));` from the top of `runBackgroundSubagentJob`'s try block.
- Remove the `if (job.intermediateResults) { job.intermediateResults[index] = ... }` block from the `onUpdate` callback inside `mapConcurrent`.
- Remove the two `job.intermediateResults = undefined;` lines (success path and catch path).

The `onUpdate` callback body reduces to just:
```ts
onUpdate: (partial) => {
  const details = partial.details as SubagentDetails | undefined;
  if (details?.results?.[0]) {
    updateCallStateFromPartial(cs, details.results[0]);
  }
},
```

**`background-job-store.ts`**
- Remove `intermediateResults: undefined,` from the `serializeJob` return object.

**`background-jobs.ts`** — no changes needed (the field was never read or written in this module; the test helper objects don't include it).

**`render.ts`** — no changes needed (it never references the field).

### Type safety

- After removing the field from `BackgroundJob`, TypeScript will flag any remaining reference. Run `npx tsc --noEmit` to verify zero references remain.
- Test fixtures in `test/background-jobs.test.mjs` and `test/background-job-store.test.mjs` that construct partial `BackgroundJob` objects without `intermediateResults` will continue to compile (the field was optional).

### Upgrade path for persisted state

- Old state files on disk created by a previous version may still have `"intermediateResults"` keys. This is harmless — the `hydrateJob` function in `background-job-store.ts` only reads fields it knows about. The extra key is ignored during hydration.
- No migration is needed.

## Tests

Add focused tests for:

- TypeScript compiles with no remaining references to `intermediateResults`.
- The `onUpdate` callback still updates `CallState` fields (`toolCalls`, `recentActivity`, `spawnedAt`) after the field is removed.
- No existing test fails due to the removal (existing tests should not reference the field).

Existing test files that exercise job lifecycle (background-jobs.test.mjs, background-job-store.test.mjs, background-lifecycle.test.mjs) already construct `BackgroundJob` objects without explicitly setting `intermediateResults` (it was optional). No test changes are expected, but verify all pass.

## Definition of Done

- The `BackgroundJob` type has no `intermediateResults` field.
- No code in `index.ts` writes to `job.intermediateResults`.
- No code in `background-job-store.ts` overrides `intermediateResults` during serialisation.
- TypeScript `npx tsc --noEmit` produces zero errors.
- `npm test` passes with no modifications to existing tests.
- Background subagent jobs start, run, complete, fail, cancel, and persist identically to before.
- Tool descriptions in `contract.ts` remain accurate (no changes needed).
