# Plan: Background Status Activity Hygiene

## Goal

Make live background status concise, non-duplicative, and backed by fields that are actually consumed.

This covers two known risks:

1. Recent activity can repeatedly prepend the same tool calls from partial snapshots.
2. `intermediateResults` is populated but not currently used by status or result rendering.

## Non-goals

- No durable event log.
- No Agent View dashboard.
- No full transcript streaming in `subagent_status`.
- No changes to final `subagent_result` output beyond optional use of partial data while a job is still running.

## Recommended Implementation Order

Implement after lifecycle state correctness and before durable persistence.

## Current Problem

`updateCallStateFromPartial` reads the latest partial result, counts tool calls, then prepends the last few formatted tool calls to `recentActivity`. Because partial snapshots can contain the same message history repeatedly, the same activity lines can appear multiple times.

`job.intermediateResults` stores partial `SingleResult` objects during execution, but the current status/result rendering does not use that field. Keeping unused mutable state makes the lifecycle harder to reason about.

## Proposed Behavior

- Recent activity should be append-only by event identity, not by repeated snapshot rendering.
- Each call state should track a cursor or fingerprint for the last consumed activity.
- Status should show the latest meaningful activity without duplicates.
- `intermediateResults` should either:
  - be exposed in `subagent_status` as a compact partial-output/status source, or
  - be removed until a consumer exists.

Preferred V1: keep the status surface compact and remove `intermediateResults` unless it is needed for a specific rendered field. Use `CallState` for live status.

## Implementation Notes

- Extend `CallState` with one of:
  - `activityCursor: number`, based on the number of display items already consumed, or
  - `recentActivityFingerprints: string[]`, based on tool name and stable argument serialization.
- Cursor-based tracking is simpler if partial snapshots always contain the cumulative message history.
- Fingerprints are safer if partial snapshots can be non-cumulative.
- Keep `recentActivity` bounded, for example latest 5 entries.
- Prefer newest-last storage internally and reverse only for display if that makes deduplication simpler.
- If `intermediateResults` is removed:
  - delete it from `BackgroundJob`;
  - remove initialization, update, and cleanup from `runBackgroundSubagentJob`;
  - update tests and any comments that mention partial result storage.
- If `intermediateResults` is exposed:
  - document exactly which status fields are derived from it;
  - add tests proving those fields update mid-flight.

## Tests

Add focused tests for:

- Replaying the same partial snapshot twice does not duplicate `recentActivity`.
- A later partial snapshot with one new tool call adds only that new activity.
- `recentActivity` remains bounded.
- If removing `intermediateResults`, TypeScript/tests prove no code still writes or reads it.
- If exposing `intermediateResults`, `formatJobStatus` includes the intended partial information.

## Definition of Done

- `subagent_status` never shows duplicated latest activity caused by repeated partial snapshots.
- Live status still reports tool-call counts accurately.
- `intermediateResults` has a clear consumer or is removed from the data model.
- Tool descriptions remain accurate.
- `npm test` passes.
