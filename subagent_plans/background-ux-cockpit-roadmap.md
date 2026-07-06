# Roadmap: Background UX Cockpit

## Goal

Level up the human-facing background subagent experience now that the job
management foundation is usable. The current problem is not primarily
lifecycle correctness; it is that too much subagent text is dumped into the
TUI at completion time, making the parent session feel like a transcript
firehose instead of a cockpit.

The UX direction is:

- completion messages should wake the parent, not become the report
- `subagent_status` should be the fleet overview
- `subagent_result` should be the intentional report/artifact view
- `subagent_peek` should be the live activity tail
- `needs_input` should be the most prominent state

## Recommended Order

1. **Compact completion notifications**
   - Plan: `background-ux-compact-completions.md`
   - Reduce auto-injected completion messages to status, summary, artifacts,
     and next action.
   - Rationale: this fixes the immediate TUI mess without changing the job
     model.

2. **Fleet status view**
   - Plan: `background-ux-fleet-view.md`
   - Make `subagent_status` without a `jobId` act like a compact dashboard for
     active and recent background jobs.
   - Rationale: once completions are quiet, the user needs one reliable place
     to see what is alive, blocked, failed, or ready.

3. **Job detail and peek cleanup**
   - Plan: `background-ux-detail-and-peek.md`
   - Make `subagent_status { jobId }` the structured job page and make
     `subagent_peek` a live activity tail rather than a raw-event dump by
     default.
   - Rationale: the overview should stay compact, with drilldown available
     only when requested.

4. **Human interaction polish**
   - Plan: `background-ux-human-interaction.md`
   - Improve parked-job, escalation, queued-plan, and parent-agent guidance so
     the human supervises by exception.
   - Rationale: after the basic cockpit is readable, the interaction patterns
     should guide the parent agent away from over-narrating.

5. **Artifact and workflow bridge**
   - Plan: `background-ux-artifact-workflow-bridge.md`
   - Start turning results, patches, branches, changed files, and future merge
     requests into explicit artifacts that can support the broader Agentflow
     vision.
   - Rationale: this is the bridge from background job management to durable
     workflow orchestration.

## Design Principles

- Prefer status and affordances over prose.
- Show large text only after an explicit inspect/retrieve action.
- Sort by human attention, not creation time alone.
- Keep the parent Pi session as the primary interface.
- Treat reports, patches, branches, and future merge requests as artifacts,
  not chat messages.
- Preserve the existing small extension surface area; do not clone a full
  mature-agent UI before the state model needs it.

## Cross-Cutting Definition of Done

- `npm test` passes.
- Any changed tool behavior is reflected in `contract.ts`.
- Render tests cover compact completion, fleet rows, and important states.
- The default completion path no longer injects large report excerpts.
- `needs_input` and `failed` jobs are easy to notice in the fleet view.
- Full report output remains available through `subagent_result`.

