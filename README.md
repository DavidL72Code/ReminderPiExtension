# PiReminder

A Pi extension that reminds you once per night (default window `00:00–06:00`) to
take a break, with duplicate suppression.

## Commands (run in the Pi terminal)

| Command | What it does |
|---|---|
| `/bedtime-test` | Show the command menu |
| `/bedtime-test HH:MM [reset]` | Simulate a check at that time (`reset` clears dedup so it fires again) |
| `/bedtime-test reset` | Clear today's dedup in a live session so the automatic check fires again |
| `/bedtime-test on` / `off` | Enable / disable the automatic reminder (persisted) |
| `/bedtime-test status` | Show on/off and the active window |
| `/bedtime-test time` | Show the current window (`default` / `custom`) |
| `/bedtime-test time default` | Restore the default window `00:00–06:00` |
| `/bedtime-test time HH:MM HH:MM` | Set a custom window (start later than end wraps midnight) |
| `/bedtime-test run_test [seed]` | Run the built-in self-test report |

## Run the extension in Pi

```bash
ln -s "$(pwd)/extension/reminder.ts" ~/.pi/agent/extensions/reminder.ts
```

Restart Pi (or run `/reload`), then verify with `/bedtime-test status`.

It checks once at session start, then every 5 minutes; it only reminds inside the
window, at most once per day, and the dedup survives restarts.

## Test inside Pi

### Manual checks with `reset`

`/bedtime-test HH:MM` simulates a check against the real Pi UI without changing
your clock. Add `reset` to clear today's dedup so it can fire again:

| Command | What you should see |
|---|---|
| `/bedtime-test 4:30` | reminder + yes/no popup (first time today) |
| `/bedtime-test 4:35` | **silent** — already reminded today (no `reset`) |
| `/bedtime-test 4:30 reset` | reminder + popup (clears dedup, fires again) |
| `/bedtime-test reset` | dedup cleared — next automatic check will fire |
| `/bedtime-test 0:00 reset` | reminder (window start, inclusive) |
| `/bedtime-test 5:59 reset` | reminder (inside window) |
| `/bedtime-test 6:00 reset` | **silent** (window end, exclusive) |
| `/bedtime-test 14:00 reset` | **silent** (daytime) |
| `/bedtime-test 23:59 reset` | **silent** (outside window) |
| `/bedtime-test 25:00` | warning (invalid hour) |
| `/bedtime-test abc` | warning (invalid format) |

`/reset` after `HH:MM` clears that check's dedup. Standalone `/bedtime-test reset` works in a live session to clear dedup without needing a time — useful when the automatic timer already fired and you want it to trigger again.

### Full self-test

```text
/bedtime-test run_test
```

Runs the extension's self-test and writes a labeled PASS/FAIL report to the
transcript. The seed is printed so you can reproduce a run:
`/bedtime-test run_test 12345`.

### Automatic startup check

Start Pi with a fake clock so the real `session_start` reminder fires:

```bash
PIREMINDER_NOW=02:30 pi --extension ~/.pi/agent/extensions/reminder.ts
```

## Test outside Pi (VS Code terminal)

```bash
# Python policy tests
python3 -m unittest test_reminder -v

# TypeScript unit tests
cd extension
npm install
npm test

# Live tests (spawn a real Pi process)
npm run test:live        # drives a real Pi over RPC (request/response), checks commands
npm run test:startup     # starts a real Pi with a fake clock, checks the automatic reminder

# Batch testing: run every case and write JSON reports
npm run test:report      # -> test/test_N.json + test/summary.json
npm run generate-log     # -> extension/test.json
npm run test:report -- --no-live   # batch without spawning Pi (fast)
```

## Project layout

| Path | What it is |
|---|---|
| `extension/reminder.ts` | The Pi extension (code under test) |
| `extension/reminder.test.ts` | Jest test code |
| `extension/live-rpc-test.js`, `extension/live-startup-test.js` | Live Pi test code |
| `test_reminder.py` | Python test code (`reminder.py` is the Python policy) |
| `extension/write-test-files.ts`, `extension/generate-test-log.ts`, `extension/generate-log-cli.ts` | Report code that writes JSON |
| `extension/test.json`, `test/test_N.json`, `test/summary.json` | Generated eval reports |