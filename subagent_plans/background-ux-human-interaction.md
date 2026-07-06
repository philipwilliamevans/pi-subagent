# Plan: Human Interaction Polish

## Goal

Make the background subagent system feel like supervision by exception. The
human should mainly see:

- questions that need input
- failures or blocked states
- completed work that produced artifacts worth reviewing
- queued plans that are ready for confirmation

The parent agent should not narrate every event or treat every completion as a
chat interruption.

## Problem

The background management layer can now park for input, continue sessions, and
queue follow-up plans. The interaction contract needs to catch up:

- escalation messages should read like natural questions
- plan-ready messages should ask for confirmation before execution
- parent-agent instructions should discourage unsolicited result dumps
- internal IDs should route actions without becoming the human-facing story

## Non-goals

- No multi-escalation concurrent continuation UI yet.
- No choice-button TUI controls.
- No new scheduling system.
- No full Agentflow approval records.

## Interaction Rules

### Completion

Quiet by default. Say what completed, where the result is, and what the next
inspect action is.

### Needs input

Loud and natural. Show the question, key context, and a concise way to answer.
Hide marker/session plumbing.

### Failure

Loud enough to notice. Show the error summary and the inspect action.

### Queued plan ready

Ask before acting. The plan text should remain hidden until the user asks or
confirms that they want the plan executed.

### Result retrieval

Intentional. Use `subagent_result` only when the user or follow-up plan needs
the report.

## Implementation

### Change 1: Rewrite background contract section

In `contract.ts`, update the parent-facing instructions:

- treat the fleet view as the source of current state
- do not poll after `subagent_start`
- do not quote hidden or compact completion metadata as if it were a report
- use `subagent_result` only when details are needed
- ask the user before executing fired queued plans
- prioritize `needs_input` and `failed`

### Change 2: Improve escalation wording

In `render.ts`, ensure `formatBackgroundEscalation` includes:

- job ID only as routing context
- agent name
- natural question
- concise instruction that the user can answer normally

Avoid exposing:

- await marker
- session ID
- call index unless needed for ambiguity

### Change 3: Improve plan-ready wording

`formatPlanFired` should stay explicit:

- dependencies are done
- plan ID is ready
- ask the user whether to proceed
- retrieve plan with `subagent_get_plan` only after interest/confirmation

Also consider showing plan-ready items in the fleet view later.

### Change 4: Add rendering tests for parent-facing copy

Tests should assert absence of internal plumbing words and presence of next
actions.

## File-by-file Changes

| File | Changes |
|------|---------|
| `contract.ts` | Rewrite background UX guidance around fleet/status/result/plan confirmation. |
| `render.ts` | Polish escalation, plan-ready, and next-action wording. |
| `test/contract.test.mjs` | Assert guidance discourages output dumping and encourages cockpit workflow. |
| `test/render.test.mjs` | Assert escalation/plan messages hide internals and include next action. |

## Test Cases

- Escalation text contains the natural question and no await marker.
- Escalation details still include hidden routing metadata.
- Plan-fired message does not include plan text.
- Plan-fired message instructs the parent agent to ask the user first.
- Contract tells parent to use `subagent_result` for full reports.
- Contract tells parent to use `subagent_status` as fleet overview.

## Open Questions

1. Should escalation support structured choices soon, or keep `freeform` until
   real workflows force the shape?
2. Should the plan queue expose a list/status tool, or is `subagent_status`
   enough once fleet view includes plan sections?
3. Should the parent agent automatically call `subagent_status` when a compact
   completion wakes it, or should the completion message carry enough state?

