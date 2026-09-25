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
8. **Session ends** — `session_shutdown` clears the interval timer and resets
   state (idempotent cleanup).

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
| `extension/live-rpc-test.js` | Drives a **real Pi process** to verify live behavior |
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
| 4. **Live Pi (RPC)** | `/reminder-check HH:MM` over RPC | **real Pi UI, in-process** |

### Running the tests

```bash
# Python policy tests
python3 -m unittest test_reminder -v

# TypeScript unit tests + audit-log tests (20 tests)
cd extension && npm install && npm test

# Regenerate the audit log
npm run generate-log

# Live Pi RPC test (spawns a real `pi` process)
npm run test:live
```

### Live Pi environment testing

This is the important part: the behavior is verified inside a **real running Pi
process**, not just mocks.

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

```
[command registered] get_commands → reminder-check: true

[first trigger (reset)] /reminder-check 02:30 reset
      notify(info): It's late — take a break and continue again in the morning.
      confirm [Time for a Break]: It's late — take a break and continue again
        in the morning. Do you acknowledge this advice?
      → answering: confirmed=true
      notify(info): Great — rest well and pick it up in the morning. 👋

[repeat same day] /reminder-check 02:35
      silent

[daytime out-of-window] /reminder-check 14:00 reset
      silent

[invalid hour] /reminder-check 25:00 reset
      notify(warning): Invalid time. Use HH:MM (00:00–23:59).

[invalid format] /reminder-check abc reset
      notify(warning): Usage: /reminder-check HH:MM [reset] (…)

=== allPass: true ===
```

**C. Manual check in interactive Pi.** Start Pi and type:

```
/reminder-check 02:30
```

This runs the real notification + yes/no popup at the simulated time `02:30`,
without touching the system clock. Add `reset` to clear the dedup for a repeat:
`/reminder-check 02:30 reset`.

The same `/reminder-check` idea is also why the extension exposes the clock as
`getNow()` — the real path uses `new Date()` + the 5-minute interval, while
every test path injects a time.

## Success cases

| # | Case | Expected | Verified by | Result |
|---|---|---|---|---|
| 1 | Extension loads in real Pi | starts cleanly | live `pi -p` run | ✅ |
| 2 | `reminder-check` command registered | present in `get_commands` | live RPC | ✅ |
| 3 | First trigger at 00:00 | notification + yes/no popup | live RPC + Jest + `test.json` | ✅ |
| 4 | First trigger at 05:59 | notification + yes/no popup | `test.json`, Jest | ✅ |
| 5 | Answer **yes** | positive reply, no repeats | live RPC + Jest | ✅ |
| 6 | Answer **no** | neutral reply, no repeats | `test.json`, Jest | ✅ |
| 7 | Repeat same day | silent | live RPC + Jest + `test.json` | ✅ |
| 8 | Next calendar day | reminds again | `test.json`, Jest | ✅ |

## Failure cases (negative tests)

| # | Case | Expected | Verified by | Result |
|---|---|---|---|---|
| 1 | 23:59 | no reminder (outside window) | Python + Jest + `test.json` | ✅ |
| 2 | 06:00 | no reminder (exclusive end) | Python + Jest + `test.json` | ✅ |
| 3 | Any time 06:00–23:59 | no popup, no notification | live RPC + Jest + `test.json` (18 checks) | ✅ |
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
