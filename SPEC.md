# PiReminder — Requirements Specification

## Overview
A morning-window reminder that fires once per day during the early-morning hours (00:00–06:00) while Pi is running. The extension integrates with Pi's lifecycle to show notifications automatically.

## Behavior Specification

### Time Policy (`reminder.py`)

The core policy function `should_remind(now, reminded_today)` determines whether a reminder should be shown:

| Input: `now` | Input: `reminded_today` | Output | Rationale |
|---|---|---|---|
| 23:59 | false | **false** | Outside window (after 06:00) |
| 00:00 | false | **true** | Inside window, not yet reminded |
| 05:59 | false | **true** | Inside window, not yet reminded |
| 06:00 | false | **false** | Outside window (at or after 06:00) |
| Any time in window | true | **false** | Already reminded today — no duplicate |

**Reminder window**: 00:00 ≤ local time < 06:00 (inclusive start, exclusive end).
**Deduplication**: Once `reminded_today` is `true`, no further reminders for that day regardless of time.

### Acceptance Criteria

1. `should_remind(datetime(2025,1,1,23,59), False)` returns `False`
2. `should_remind(datetime(2025,1,1,0,0), False)` returns `True`
3. `should_remind(datetime(2025,1,1,5,59), False)` returns `True`
4. `should_remind(datetime(2025,1,1,6,0), False)` returns `False`
5. `should_remind(datetime(2025,1,1,3,0), True)` returns `False` (already reminded)
6. `should_remind(datetime(2025,1,1,0,0), False)` returns `True`, then `should_remind(datetime(2025,1,1,1,0), True)` returns `False` (dedup after first reminder)

### Pi Extension (`reminder.ts`)

- On `session_start`: begin periodic time checks at a configurable interval
- When policy says remind: call `ctx.ui.notify(message, "info")` and mark today as reminded
- On `session_shutdown`: clear the interval timer (cleanup)
- Do NOT start timers in the factory — start from `session_start` (per Pi lifecycle rules)
