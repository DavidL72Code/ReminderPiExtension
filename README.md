# PiReminder

A Pi extension that reminds you to step away when you are still coding in the
middle of the night.

## Purpose

It is very easy to lose track of time while working with an AI coding agent and
keep going at 1 AM, 2 AM, 3 AM. PiReminder exists to nudge you once — and only
once — during the late-night window:

> _"It's late — take a break and continue again in the morning."_

The goal is **one well-placed interruption per night**, not a nagging loop.
Once the advice has been delivered and acknowledged, Pi stays quiet for the rest
of the night and never interrupts daytime work.

## What the reminder does (the process)

```
                 ┌─────────────────────────────────────────┐
                 │  Pi session running                     │
                 │  session_start → immediate check         │
                 │  then every 5 minutes (setInterval)      │
                 └───────────────────┬─────────────────────┘
                                     │
                        Is current time in window?
                        00:00 ≤ time < 06:00
                                     │
                 ┌───────────────────┴───────────────────┐
                 │ NO (06:00–23:59)                      │ YES
                 ▼                                       ▼
            do nothing                     Already reminded today?
                                           (dedup state = today's date)
                                           ┌──────────┴──────────┐
                                           │ YES                 │ NO
                                           ▼                     ▼
                                      do nothing      1. notify(...)
                                                      2. confirm(...) yes/no popup
                                                      3. reply to the answer
                                                      4. mark day as reminded
```

Step by step:

1. **Session starts** — PiReminder runs one check immediately, then schedules a
   check every 5 minutes.
2. **Window check** — a reminder is only allowed between **00:00 (inclusive)**
   and **06:00 (exclusive)**. From **06:00 to 23:59** nothing ever fires.
3. **Dedup check** — the extension remembers the calendar date it last reminded.
   If it is still "today", the check exits silently.
4. **First trigger** — a notification is shown, then a **yes/no popup** asks the
   user to acknowledge the advice.
5. **Acknowledgment** — whether the answer is **yes or no**, the reminder has
   been delivered, so the day is marked as reminded.
6. **Every later check that day** — silent. No notification, no popup.
7. **Next calendar day** — the dedup resets at midnight and the window reminds
   again.
8. **Session ends** — `session_shutdown` clears the interval timer. The
   reminded date stays on disk, so closing and reopening Pi the same night does
   **not** prompt again.

### Persistence across sessions

The once-per-day rule is stored in a small state file, so it survives closing
Pi and starting a new session:

- **Default path**: `~/.pi/agent/pireminder-state.json`
- **Override**: set `PIREMINDER_STATE=/path/to/file.json`
- The date is written **before** the popup is shown, so dedup still holds even
  if a dialog is slow or never answered.
- `/reminder-check HH:MM reset` clears both the in-memory and persisted state.

So: if you were reminded at 02:30, quit Pi, and reopen a new session at 02:45
the same night, it stays **silent**. The next calendar day it reminds again.

## Behavior rules

| Time | Already reminded today? | What happens |
|---|---|---|
| 23:59 | — | silent |
| 00:00 | no | notification + yes/no popup |
| 00:05 – 05:59 | no | notification + yes/no popup |
| 00:00 – 05:59 | yes | silent |
| 05:59 | no | notification + yes/no popup |
| 06:00 | — | silent |
| 06:00 – 23:59 | — | silent (never reminds in daytime) |

## Files

| File | Purpose |
|---|---|
| `reminder.py` | Pure Python time policy (`should_remind`) |
| `test_reminder.py` | Python unit tests (simulated time) |
| `extension/reminder.ts` | Pi TypeScript extension (policy + UI + lifecycle) |
| `extension/reminder.test.ts` | Jest tests (policy, UI flow, factory wiring) |
| `extension/generate-test-log.ts` | Builds a machine-readable audit log |
| `extension/generate-log-cli.ts` | CLI that writes `test.json` |
| `extension/test.json` | Simulated-time audit log of every interaction |
| `extension/test-log.test.ts` | Jest tests validating the audit log |
| `extension/live-rpc-test.js` | Drives a **real Pi process** to verify live command behavior |
| `extension/live-startup-test.js` | Drives **real Pi startup** to verify the automatic reminder |
| `extension/write-test-files.ts` | Runs every case and writes `test/test_N.json` files |
| `test/test_N.json` | One file per test case: input, expected, actual, pass |
| `test/summary.json` | Roll-up of all test cases (totals + index) |
| `extension/types/pi-coding-agent.d.ts` | Local type declarations for the Pi API |
| `SPEC.md` | Requirements, acceptance criteria, and testing strategy |

## How it was tested

Testing a time-based reminder is hard because you cannot wait until 2 AM, and
you cannot easily change the clock of a live Pi process. PiReminder solves this
by reading the clock through a single `getNow()` indirection, so tests can
inject any time. Testing happened in four layers:

| Layer | Mechanism | What it proves |
|---|---|---|
| 1. Python unit tests | explicit `datetime` argument | pure time policy |
| 2. Jest unit tests | explicit `Date` arg + `setClock()` | policy + mocked UI flow |
| 3. Audit log | `test.json` via `npm run generate-log` | every check is recorded |
| 4. **Live Pi command (RPC)** | `/reminder-check HH:MM` over RPC | **real Pi UI, in-process** |
| 5. **Live Pi startup** | `PIREMINDER_NOW=HH:MM pi …` | **the automatic `session_start` reminder** |

### Running the tests

```bash
# Python policy tests
python3 -m unittest test_reminder -v

# TypeScript unit tests + audit-log tests (26 tests)
cd extension && npm install && npm test

# Regenerate the audit log
npm run generate-log

# Live Pi RPC test: spawns a real `pi` process, 6 success/fail cases
npm run test:live

# Live Pi startup test: proves the automatic reminder fires without a command
npm run test:startup

# Regenerate every test/test_N.json result file + test/summary.json
npm run test:report
```

## Test result files (`test/`)

Every test case is written to its own numbered JSON file so the result is easy
to inspect. Regenerate them with `npm run test:report`:

```bash
cd extension
npm run test:report          # all cases, including live Pi
npm run test:report -- --no-live   # skip spawning Pi (fast)
```

This produces `test/test_1.json` … `test/test_23.json` plus `test/summary.json`.
Each numbered file records the case name, category, input, expected value,
actual value, and pass/fail:

```json
// test/test_10.json
{
  "id": 10,
  "name": "Repeat same day is silent (no popup, no notify)",
  "category": "ui",
  "input": { "first": "02:30", "repeat": "02:35" },
  "expected": { "repeatPopup": false, "repeatNotifications": 0 },
  "actual": { "repeatPopup": false, "repeatNotifications": 0 },
  "pass": true
}
```

The files are grouped by category:

| Files | Category | What they cover |
|---|---|---|
| `test_1` – `test_7` | `policy` | 23:59, 00:00, 05:59, 06:00, dedup, next day, daytime sweep |
| `test_8` – `test_11` | `ui` | first trigger yes/no, silent repeat, daytime silent |
| `test_12` – `test_13` | `automatic` | `PIREMINDER_NOW` override |
| `test_14` – `test_19` | `live-rpc` | real Pi process driven over RPC |
| `test_20` – `test_23` | `live-boot` | real Pi startup, including **cross-session persistence** |

`test_22` and `test_23` start **two separate Pi processes** sharing one state
file: the first reminds, the second stays silent — proving the once-per-day rule
survives closing and reopening Pi.

`test/summary.json` lists the totals and every case with a link to its file.

## Test it yourself (no need to wait until midnight)

You do **not** have to change your system clock or stay up until 00:00. There
are three ways, from easiest to most thorough.

### 1. Type a simulated time into a running Pi — fastest

Restart Pi (so it loads the extension) and type:

```
/reminder-check 02:30
```

You will immediately see the real notification and the yes/no popup, as if it
were 02:30. Try the other cases:

| Type this | What you should see |
|---|---|
| `/reminder-check 02:30 reset` | notification + yes/no popup (clears dedup first) |
| `/reminder-check 02:35` | **silent** — already reminded today |
| `/reminder-check 05:59 reset` | notification + yes/no popup |
| `/reminder-check 06:00 reset` | **silent** — outside the window |
| `/reminder-check 14:00 reset` | **silent** — daytime |
| `/reminder-check 25:00` | warning notification (invalid hour) |
| `/reminder-check abc` | usage warning (invalid format) |

### 2. Launch Pi with a fake clock so the AUTOMATIC reminder fires

This tests the real `session_start` path (no command needed). Set the
`PIREMINDER_NOW` environment variable to any `HH:MM`:

```bash
PIREMINDER_NOW=02:30 pi --extension ~/.pi/agent/extensions/reminder.ts
```

When the session starts, PiReminder believes it is 02:30 and shows the real
notification + yes/no popup on its own.

| Launch with | Result at startup |
|---|---|
| `PIREMINDER_NOW=02:30 pi …` | reminder + popup |
| `PIREMINDER_NOW=05:59 pi …` | reminder + popup |
| `PIREMINDER_NOW=06:00 pi …` | silent |
| `PIREMINDER_NOW=14:00 pi …` | silent |

`PIREMINDER_NOW` only overrides the reminder's view of the clock. It has **no
effect when unset**, so normal behavior is unchanged.

### 3. Run the automated live tests

```bash
cd extension
npm run test:startup   # spawns a real Pi with PIREMINDER_NOW and expects the popup
npm run test:live      # spawns a real Pi and runs 6 success/fail command cases
```

Both print `pass: true` when the live Pi behavior is correct.

## Live Pi test details (actual output)

**A. Quick load check.** Pi starts with the extension and runs normally:

```bash
pi --verbose --no-session --no-tools \
   --extension ~/.pi/agent/extensions/reminder.ts \
   -p "Reply with exactly: LOADED"
# → LOADED
```

**B. Full UI test over RPC.** `extension/live-rpc-test.js` spawns Pi in RPC mode,
asks it for its command list, and then runs the extension's `/reminder-check`
command at simulated times. In RPC mode Pi forwards the extension's real
`ctx.ui.notify` and `ctx.ui.confirm` calls over stdout, and the script answers
the yes/no dialog. Run it with `npm run test:live`. Actual output:

```text
[command registered] get_commands → reminder-check: true

[first trigger (reset)] /reminder-check 02:30 reset
      notify(info): It's late — take a break and continue again in the morning.
      confirm [Time for a Break]: It's late — take a break and continue again
        in the morning. Do you acknowledge this advice?
      → answering: confirmed=true
      notify(info): Great — rest well and pick it up in the morning. 👋
      expected=popup+notify observed=dialogs=1 notifications=2 → PASS

[repeat same day] /reminder-check 02:35
      expected=silent observed=dialogs=0 notifications=0 → PASS

[daytime out-of-window] /reminder-check 14:00 reset
      expected=silent observed=dialogs=0 notifications=0 → PASS

[invalid hour] /reminder-check 25:00 reset
      notify(warning): Invalid time. Use HH:MM (00:00–23:59).
      expected=warning observed=dialogs=0 notifications=1 warning=true → PASS

[invalid format] /reminder-check abc reset
      notify(warning): Usage: /reminder-check HH:MM [reset] (…)
      expected=warning observed=dialogs=0 notifications=1 warning=true → PASS

=== allPass: true ===
```

**C. Automatic startup test.** `extension/live-startup-test.js` spawns Pi with
`PIREMINDER_NOW=02:30` and **no command**, proving the extension fires the
reminder on its own from `session_start`. Run it with `npm run test:startup`.
(Note: `session_start` does not fire under `--no-session`, so this test uses a
temporary `--session-dir`.) Verified results:

| Launch with | Result |
|---|---|
| `PIREMINDER_NOW=02:30` | reminder + popup |
| `PIREMINDER_NOW=05:59` | reminder + popup |
| `PIREMINDER_NOW=06:00` | silent |
| `PIREMINDER_NOW=14:00` | silent |

**D. Manual check in interactive Pi.** Start Pi and type `/reminder-check 02:30`
to see the real notification + yes/no popup at that simulated time. Add `reset`
to clear the dedup for a repeat. See "Test it yourself" above for the full list.

The extension exposes the clock as `getNow()` — the real path uses `new Date()`
(optionally overridden by `PIREMINDER_NOW`) plus the 5-minute interval, while
every unit-test path injects a time.

## Success cases

| # | Case | Expected | Verified by | Result |
|---|---|---|---|---|
| 1 | Extension loads in real Pi | starts cleanly | live `pi -p` run + `test_20`/`test_21` | ✅ |
| 2 | `reminder-check` command registered | present in `get_commands` | live RPC | ✅ |
| 3 | **Automatic** reminder at startup | popup fires with no command | live startup test (`PIREMINDER_NOW=02:30`) | ✅ |
| 3 | First trigger at 00:00 | notification + yes/no popup | live RPC + Jest + `test.json` | ✅ |
| 4 | First trigger at 05:59 | notification + yes/no popup | `test.json`, Jest | ✅ |
| 5 | Answer **yes** | positive reply, no repeats | live RPC + Jest | ✅ |
| 6 | Answer **no** | neutral reply, no repeats | `test.json`, Jest | ✅ |
| 7 | Repeat same day | silent | live RPC + Jest + `test.json` | ✅ |
| 8 | Next calendar day | reminds again | `test.json`, Jest | ✅ |
| 9 | **New Pi session same night** | silent (persisted dedup) | live `test_22`/`test_23` (two real Pi processes) | ✅ |

## Failure cases (negative tests)

| # | Case | Expected | Verified by | Result |
|---|---|---|---|---|
| 1 | 23:59 | no reminder (outside window) | Python + Jest + `test.json` | ✅ |
| 2 | 06:00 | no reminder (exclusive end) | Python + Jest + `test.json` | ✅ |
| 3 | Any time 06:00–23:59 | no popup, no notification | live startup test + RPC + Jest + `test.json` | ✅ |
| 4 | Already reminded today | silent, no duplicate | live RPC + Jest + `test.json` | ✅ |
| 5 | Invalid hour (`25:00`) | warning notification, no popup | live RPC | ✅ |
| 6 | Invalid format (`abc`) | usage warning, no popup | live RPC | ✅ |

## Audit log (`extension/test.json`)

`test.json` records, for every simulated check: the simulated time, whether it
is in the window, whether the day was already reminded, the outcome
(`popup+notify` or `silent`), the notifications, the yes/no popup, and the
user's answer. It also records the system time and the Pi provider/model/session
under which it was generated.

It answers the behavior questions directly:

| Question | Field in `test.json` | Value |
|---|---|---|
| Does it notify on the first trigger? | `scenarios[].checks[].outcome` | `popup+notify` |
| Is there a yes/no acknowledgment? | `scenarios[].checks[].popup.answer` | `yes` / `no` |
| Does it re-notify after being reminded? | `checks[].alreadyRemindedToday` + `outcome` | `true` + `silent` |
| Any daytime reminders? | scenario "No reminders from 06:00 to 23:59" | all `silent` |

## Install into Pi

Place the extension (or a symlink to it) in `~/.pi/agent/extensions/`:

```bash
ln -s "$(pwd)/extension/reminder.ts" ~/.pi/agent/extensions/reminder.ts
```

## Notes

- The extension starts its timer in `session_start`, not in the factory, and
  clears it in `session_shutdown`, following Pi's extension lifecycle rules.
- Cleanup is idempotent so cancellation, reload, and session replacement all
  converge safely.
- `/reminder-check` is a test/demo command; the real reminder path does not
  depend on it.
