# Roadmap: Background Job Risk Hardening

This roadmap groups the known background-agent implementation risks into focused implementation plans. Each group is intended to be independently shippable where possible, with a recommended order for reducing user-visible confusion first and product-level risk next.

## Recommended Order

1. **Lifecycle state correctness**
   - Plan: `background-lifecycle-state-correctness.md`
   - Covers cancellation semantics and calls that appear stuck in `spawning`.
   - Rationale: status must tell the truth before other status/result features can be trusted.

2. **Status activity hygiene**
   - Plan: `background-status-activity-hygiene.md`
   - Covers duplicated recent activity and the unused `intermediateResults` field.
   - Rationale: once lifecycle states are reliable, the status surface should be concise and useful.

3. **Result parameter validation**
   - Plan: `background-result-validation.md`
   - Covers `subagent_result` parameter hardening.
   - Rationale: small, low-risk correctness slice that protects context and prevents confusing output.

4. **Durable job registry**
   - Plan: `background-durable-job-registry.md`
   - Covers the current in-memory registry losing jobs on reload/restart.
   - Rationale: durability unlocks later Agent View, recovery, collection, and audit trails.

5. **Shared-worktree safety**
   - Plan: `background-shared-worktree-safety.md`
   - Covers background agents editing the same working tree as the parent or sibling agents.
   - Rationale: this has the broadest product implications, so it should build on the clearer job model above.

## Dependency Notes

- Plans 1, 2, and 3 can be implemented in any order, but the recommended order minimizes confusing intermediate states.
- Plan 4 can begin independently after the current in-memory job shape is accepted, but it should persist the corrected lifecycle model from Plan 1 if both are in flight.
- Plan 5 can start as policy and warnings without Plan 4, but full worktree/checkpoint mode will benefit from durable job artifacts.

## Cross-Cutting Definition of Done

- The affected user-facing tools have focused unit tests.
- `npm test` passes.
- Tool descriptions in `contract.ts` match any changed behavior.
- Existing plans remain accurate enough that a later implementer can pick them up without reading the full handoff.
