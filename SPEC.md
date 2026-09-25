# PiReminder — Requirements Specification

## Overview
While Pi is running during the late-night window (00:00–05:59), remind the user
**once per day** to take a break and continue again in the morning. The first
trigger presents a yes/no acknowledgment dialog. Subsequent checks in the same
window are silent. No reminders fire from 06:00–23:59.

## Behavior Specification

### Time Policy (`reminder.py`, `reminder.ts`)
`should_remind(now)` decides whether a reminder may fire at time `now`.

| Input `now` | Already reminded today | Result | Rationale |
|---|---|---|---|
| 23:59 | no | **false** | Outside window |
| 00:00 | no | **true** | Window start (inclusive) |
| 05:59 | no | **true** | Inside window |
| 06:00 | no | **false** | Window end (exclusive) |
| any hour 06–23 | no | **false** | Never remind in daytime |
| any in-window time | yes | **false** | No duplicate |

- **Reminder window**: `00:00 <= local time < 06:00` (inclusive start, exclusive end).
- **Deduplication**: once reminded (acknowledged) on a calendar day, no further
  reminders that day. Resets at midnight.

### Acknowledgment Flow (`reminder.ts`, Pi UI)
On the **first** trigger inside the window:
1. `ctx.ui.notify("It's late — take a break and continue again in the morning.", "info")`
2. `ctx.ui.confirm("Time for a Break", "...Do you acknowledge this advice?")` → yes/no popup
3. Respond to the answer (positive or neutral message)
4. Mark the day as reminded → all later checks (timer ticks) are silent

Whether the user answers **yes or no**, we have delivered the reminder, so no
further reminders are shown that day.

### Pi Lifecycle (`reminder.ts`)
- `session_start`: run one immediate check, then `setInterval` every 5 minutes.
- `session_shutdown`: `clearInterval` + reset state (idempotent cleanup).
- Timers are **not** started in the factory (per Pi extension rules).

### Test/Demo Command
- `/reminder-check HH:MM` runs a check against the real Pi UI using a simulated
  time. Lets you verify the notification + popup at any hour without waiting.

## Acceptance Criteria
1. 23:59 → no reminder
2. 00:00 → reminder (inclusive)
3. 05:59 → reminder
4. 06:00 → no reminder (exclusive)
5. All hours 06:00–23:59 → no reminder
6. Already reminded today → no duplicate notification or popup
7. First in-window trigger shows exactly one yes/no popup
8. Answering yes or no suppresses all later reminders that day
9. Next calendar day resets and reminds again
10. `session_shutdown` clears the interval timer

## How Time Is Simulated / Verified
The extension reads the clock through a single `getNow()` indirection:

| Layer | How time is controlled | What it proves |
|---|---|---|
| Python unit tests | explicit `datetime` argument | pure policy logic |
| TS unit tests (Jest) | explicit `Date` arg + `setClock()` | policy + UI flow |
| Live Pi demo | `/reminder-check HH:MM` | real notify + confirm UI |
| Production | `new Date()` + 5-min interval | automatic behavior |
