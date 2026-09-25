# PiReminder

A Pi extension that reminds you to take a break during the late-night hours.

## Behavior

While Pi is running between **00:00 and 05:59**, PiReminder reminds you **once
per day** to take a break and continue again in the morning:

1. The **first** time you're active in the window, a notification appears and a
   **yes/no popup** asks you to acknowledge the advice.
2. After you answer (yes or no), **no further reminders** are shown that day —
   even if you keep coding.
3. **No reminders** fire between **06:00 and 23:59**.
4. At the next day's window, reminders resume.

## Files

| File | Purpose |
|---|---|
| `reminder.py` | Pure Python time policy (`should_remind`) |
| `test_reminder.py` | Python unit tests (simulated time) |
| `extension/reminder.ts` | Pi TypeScript extension (policy + UI + lifecycle) |
| `extension/reminder.test.ts` | Jest tests (policy, UI flow, factory wiring) |
| `SPEC.md` | Requirements, acceptance criteria, and testing strategy |

## Run the tests

```bash
# Python policy tests
python3 -m unittest test_reminder -v

# TypeScript extension tests
cd extension && npm install && npm test
```

## How time is simulated

The extension reads the clock through a single `getNow()` indirection, so real
waiting is never required:

| Layer | Mechanism | Proves |
|---|---|---|
| Python tests | explicit `datetime` argument | pure policy |
| Jest tests | explicit `Date` / `setClock()` | policy + Pi UI flow |
| Live Pi | `/reminder-check HH:MM` command | real notification + popup |
| Production | `new Date()` + 5-minute interval | automatic checking |

To verify the popup live without waiting until 2 AM, run Pi and type:

```
/reminder-check 02:30
```

This runs the **real** `ctx.ui.notify` + `ctx.ui.confirm` flow at the simulated
time `02:30`.

## Install into Pi

Place the extension (or a symlink to it) in `~/.pi/agent/extensions/`:

```bash
ln -s "$(pwd)/extension/reminder.ts" ~/.pi/agent/extensions/reminder.ts
```
