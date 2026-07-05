# Plan: Background Result Parameter Validation

## Goal

Harden `subagent_result` input validation so invalid indexes and output limits fail clearly before formatting.

This covers the known risk that `subagent_result` params should enforce an integer `callIndex` and sane `maxOutputLength` bounds.

## Non-goals

- No changes to how completed results are summarized.
- No changes to completion injection excerpts.
- No running-job collection behavior.
- No durable result storage.

## Recommended Implementation Order

Implement after lifecycle correctness, or earlier as a small independent cleanup.

## Current Problem

The tool schema uses `Type.Number` for `callIndex` and `maxOutputLength`. The execute path checks only that `callIndex` is within array bounds. Fractional, `NaN`-like, or otherwise unsafe numeric values can flow into result selection and truncation logic. `maxOutputLength` also has no lower or upper bound.

## Proposed Behavior

- `callIndex` must be a safe non-negative integer.
- `callIndex` must be less than `job.results.length`.
- `maxOutputLength`, when provided, must be a safe positive integer.
- `maxOutputLength` should be clamped or rejected above a clear maximum.
- Error messages should state the accepted range.

Suggested V1 limits:

- `callIndex`: integer from `0` to `job.results.length - 1`.
- `maxOutputLength`: integer from `1` to `50000`.

Reject rather than silently clamp. Rejection makes model mistakes obvious and avoids surprising context use.

## Implementation Notes

- Update the `SubagentResultParams` schema if TypeBox supports integer/minimum/maximum constraints in the local version.
- Keep runtime validation even if the schema is tightened; tool callers can still send unexpected values.
- Add small helpers if useful:
  - `parseOptionalSafeInteger(value, fieldName)`
  - `validateMaxOutputLength(value)`
- Ensure `formatJobResults` is called only with validated values.
- Consider making `formatJobResults` defensive too, but the primary behavior belongs in the tool execute path.

## Tests

Add focused tests for:

- Fractional `callIndex` returns an error.
- Negative `callIndex` returns an error.
- Out-of-range `callIndex` returns an error showing the valid range.
- `maxOutputLength` of `0`, negative, fractional, and too-large values return clear errors.
- A valid `maxOutputLength` still truncates output as expected.

## Definition of Done

- Invalid `subagent_result` parameters cannot produce confusing headings, empty output, or accidental large context dumps.
- Error messages are specific enough for the parent agent to retry correctly.
- Existing valid `subagent_result` behavior is unchanged.
- `npm test` passes.
