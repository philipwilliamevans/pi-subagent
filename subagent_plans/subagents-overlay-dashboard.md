# Plan: `/subagents` Overlay Dashboard

## Goal

Add a first proper `/subagents` command that opens a full-screen-ish TUI
overlay for supervising background subagent jobs. Keep the first pass close to
the Claude Code subagent dashboard: grouped by human attention, compact rows,
keyboard navigation, live refresh, and minimal prose.

This should feel like the place a user instinctively opens to see the current
subagent fleet.

## Product Shape

The overlay should show rows grouped by state:

```text
Needs input
  * reviewer             Ready for review. Expand the migration section?       4m
  * docs-check           Found 3 broken anchors. Fix queued?                   2m

Working
  * perf-hunt            Bisecting commits - 6 of 11 steps done                47s
  * dep-sweep            Running tests - 14/19 packages green                  12s

Completed
> * changelog-review     Delivered: tightened wording on 6 entries             57s
  · design-summary       Three-paragraph summary written                       4m

↑↓ select   esc/q close
```

The first pass is read-only. It should not answer escalations, cancel jobs,
attach to sessions, or tail consoles yet.

## Current Foundation

The repository already has most of the data needed:

- `getAllBackgroundJobs()` returns the current durable job registry.
- `BackgroundJob` includes status, calls, call states, results, artifacts,
  worktree metadata, and open escalation state.
- `callStates` tracks phase, tool-call counts, and recent activity.
- `subagent_status` already has a fleet formatter that can be reused or mined.
- Pi supports extension overlays through `ctx.ui.custom(..., { overlay: true })`.

No persistence schema change should be required for this pass.

## Non-goals

- No live console/attach mode.
- No job mutation from inside the overlay.
- No `subagent_continue` input from inside the overlay.
- No search/filter UI.
- No workflow graph view.
- No Agentflow UI integration.
- No Pi core changes.

## Implementation

### Change 1: Add `/subagents`

Register a new command in `index.ts` near the existing `/subagent-demo`
command.

Behavior:

- Open an overlay with `ctx.ui.custom`.
- Use `overlay: true`.
- Prefer a centered, wide layout, for example width `95%` and max height
  `95%`.
- Close with `escape` or `q`.
- If invoked outside TUI mode, fall back to a notification or compact text
  output.

### Change 2: Add dashboard component

Add a new module such as `subagents-dashboard.ts`.

Suggested shape:

```ts
export class SubagentsDashboardComponent implements Component {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
}
```

Constructor inputs should be small and testable:

```ts
{
  getJobs: () => BackgroundJob[];
  theme: Theme;
  tui: { requestRender(): void };
  done: () => void;
}
```

The component owns:

- selected row index
- cached rows
- refresh timer
- keyboard handling
- row rendering

### Change 3: Normalize dashboard rows

Introduce a row model before rendering:

```ts
type SubagentsDashboardGroup =
  | "needs_input"
  | "working"
  | "completed"
  | "failed";

type SubagentsDashboardRow = {
  group: SubagentsDashboardGroup;
  jobId: string;
  callIndex?: number;
  agent: string;
  title: string;
  statusText: string;
  ageText: string;
  marker: "*" | ".";
};
```

Group mapping:

- `needs_input`: jobs with `status === "needs_input"`.
- `working`: `running` and `cancelling`.
- `completed`: recent `completed`.
- `failed`: `failed`, `cancelled`, and `interrupted`.

For multi-call jobs, prefer one row per call when useful. Keep the parent
`jobId` on every row so future detail/console actions have a stable route.

### Change 4: Match the Claude Code visual language

Keep the overlay mostly text, with very light chrome:

- Section headers: `Needs input`, `Working`, `Completed`, `Failed`.
- Selected row: full-width highlighted background where practical.
- Marker:
  - `*` for rows needing attention or still active.
  - `.` for quiet terminal rows.
- Left column: agent/task label.
- Middle column: question, latest activity, result summary, or error excerpt.
- Right column: age/elapsed.
- Footer: only real keybindings for pass 1, likely `↑↓ select   esc/q close`.

Avoid verbose instructional text inside the overlay.

### Change 5: Live refresh

Refresh the overlay while it is open:

- Use a 1000ms interval.
- Rebuild rows on each render or each tick.
- Clamp the selected row if rows disappear.
- Clear the interval in `dispose()`.

This is enough to make running jobs feel alive without needing a streaming
subscription.

### Change 6: Reuse existing formatting helpers carefully

Use existing render helpers where they are already exportable and appropriate,
for example artifact summaries and duration formatting.

If a helper in `render.ts` is useful but private, either:

- export it if it is generally useful, or
- move small generic helpers into the dashboard module if they are display
  specific.

Do not couple the overlay to full `subagent_status` text output. The overlay
should consume structured jobs and produce its own rows.

## File-by-file Changes

| File | Changes |
|------|---------|
| `index.ts` | Register `/subagents` and wire it to the overlay component. |
| `subagents-dashboard.ts` | New component, row model, grouping, rendering, keyboard handling, refresh timer. |
| `render.ts` | Optionally export small reusable helpers if needed. |
| `package.json` | Add new source file to `files` for npm publishing. |
| `test/subagents-dashboard.test.mjs` | Add row-model and rendering tests. |
| `README.md` | Document `/subagents` once behavior lands. |

## Test Cases

- Empty dashboard renders a concise empty state.
- Jobs group in attention order: needs input, failed, working, completed.
- Needs-input rows show the escalation question.
- Running rows show recent activity when available.
- Cancelling rows remain under working with a clear status.
- Failed/interrupted rows show compact error/status text.
- Completed rows show compact result/artifact summary without large excerpts.
- Old terminal jobs are hidden consistently with the existing fleet view policy.
- Selection moves with up/down and clamps at boundaries.
- Selection clamps when rows shrink after refresh.
- `escape` and `q` close the overlay.
- Refresh timer is disposed when the overlay closes.

## First-pass Definition of Done

- `/subagents` opens an overlay in interactive Pi mode.
- The overlay is readable at normal terminal widths.
- Active and blocked jobs are easy to notice.
- Rows update while the overlay remains open.
- Keyboard navigation works.
- Closing the overlay restores the normal session.
- `npm test` passes.
- The package publish file list includes any new source file.

## Follow-up Passes

After the read-only dashboard feels good:

1. `enter`: show selected job detail panel.
2. `p`: show event journal tail from persisted `events.jsonl`.
3. `r`: show completed result summary.
4. `c`: cancel selected running job after confirmation.
5. `a`: answer selected escalation through a small input overlay.

