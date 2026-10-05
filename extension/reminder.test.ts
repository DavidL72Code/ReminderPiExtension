/**
 * Unit tests for the PiReminder TypeScript extension.
 *
 * Uses simulated time (explicit Date arguments / setClock) and a mocked
 * Pi UI so the policy and the acknowledgment flow are deterministic.
 */

import reminder, {
	shouldRemind,
	isInWindow,
	resetState,
	checkAndNotify,
	setClock,
	NOW_OVERRIDE_ENV,
	STATE_ENV,
	loadState,
	persistState,
	clearPersistedState,
	isEnabled,
	setEnabled,
	getWindow,
	getWindowLabel,
	isDefaultWindow,
	setWindow,
	resetWindow,
	getRemindedDate,
	runSelfTest,
	formatSelfTestReport,
	groupSelfTestScenarios,
	formatHelp,
	DEFAULT_WINDOW_START_MINUTES,
	DEFAULT_WINDOW_END_MINUTES,
} from "./reminder";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A mock ctx with spyable ui methods. */
function mockCtx(overrides?: {
	confirm?: jest.Mock;
	notify?: jest.Mock;
}) {
	return {
		ui: {
			notify: overrides?.notify ?? jest.fn(),
			confirm: overrides?.confirm ?? jest.fn().mockResolvedValue(true),
		},
	};
}

/** A date at the given hour/minute on 2025-01-01. */
function atTime(hour: number, minute: number = 0): Date {
	return new Date(2025, 0, 1, hour, minute);
}

const REMINDER_MESSAGE =
	"It's late — take a break and continue again in the morning.";

// ---------------------------------------------------------------------------
// isInWindow / shouldRemind — core policy
// ---------------------------------------------------------------------------

describe("shouldRemind", () => {
	beforeEach(() => resetState());
	afterEach(() => setClock());

	it("23:59 → no reminder (outside window)", () => {
		expect(shouldRemind(atTime(23, 59))).toBe(false);
	});

	it("00:00 → reminder (window start, inclusive)", () => {
		expect(shouldRemind(atTime(0, 0))).toBe(true);
	});

	it("05:59 → reminder (inside window)", () => {
		expect(shouldRemind(atTime(5, 59))).toBe(true);
	});

	it("06:00 → no reminder (window end, exclusive)", () => {
		expect(shouldRemind(atTime(6, 0))).toBe(false);
	});

	it("no reminder anywhere from 06:00 to 23:59", () => {
		for (let h = 6; h <= 23; h++) {
			resetState();
			expect(shouldRemind(atTime(h, 0))).toBe(false);
			expect(shouldRemind(atTime(h, 30))).toBe(false);
		}
	});

	it("already reminded today → no duplicate", () => {
		expect(shouldRemind(atTime(3, 0))).toBe(true);
		expect(shouldRemind(atTime(4, 0))).toBe(false);
	});

	it("next day resets dedup", () => {
		expect(shouldRemind(atTime(3, 0))).toBe(true);
		expect(shouldRemind(atTime(4, 0))).toBe(false);
		expect(shouldRemind(new Date(2025, 0, 2, 1, 0))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// checkAndNotify — integration with Pi UI
// ---------------------------------------------------------------------------

describe("checkAndNotify", () => {
	beforeEach(() => resetState());
	afterEach(() => setClock());

	it("first trigger notifies + asks confirmation", async () => {
		const ctx = mockCtx();
		await checkAndNotify(ctx, atTime(2, 0));

		// Reminder message first, then acknowledgment response.
		expect(ctx.ui.notify).toHaveBeenNthCalledWith(1, REMINDER_MESSAGE, "info");
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		expect(ctx.ui.confirm).toHaveBeenCalledWith(
			"Time for a Break",
			expect.stringContaining("take a break and continue again in the morning"),
		);
	});

	it("does nothing outside the window", async () => {
		const ctx = mockCtx();
		await checkAndNotify(ctx, atTime(23, 59));
		await checkAndNotify(ctx, atTime(12, 0));
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});

	it("does not notify/callback again on subsequent checks same day", async () => {
		const ctx = mockCtx();
		await checkAndNotify(ctx, atTime(0, 30)); // first → reminds
		const notifyCountAfterFirst = ctx.ui.notify.mock.calls.length;
		const confirmCountAfterFirst = ctx.ui.confirm.mock.calls.length;
		expect(confirmCountAfterFirst).toBe(1);

		// Repeated checks (simulating the 5-minute timer) → silent.
		await checkAndNotify(ctx, atTime(1, 0));
		await checkAndNotify(ctx, atTime(2, 0));
		await checkAndNotify(ctx, atTime(5, 59));

		expect(ctx.ui.notify.mock.calls.length).toBe(notifyCountAfterFirst);
		expect(ctx.ui.confirm.mock.calls.length).toBe(confirmCountAfterFirst);
	});

	it("acknowledgment 'no' still suppresses further reminders", async () => {
		const ctx = mockCtx({ confirm: jest.fn().mockResolvedValue(false) });
		await checkAndNotify(ctx, atTime(1, 0));
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Understood — you won't be reminded again today.",
			"info",
		);
		await checkAndNotify(ctx, atTime(2, 0));
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
	});

	it("acknowledgment 'yes' shows a positive response", async () => {
		const ctx = mockCtx({ confirm: jest.fn().mockResolvedValue(true) });
		await checkAndNotify(ctx, atTime(1, 0));
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Great — rest well and pick it up in the morning. 👋",
			"info",
		);
	});

	it("uses the injected clock when no explicit time is given", async () => {
		setClock(() => atTime(3, 0));
		const ctx = mockCtx();
		await checkAndNotify(ctx); // no explicit `now`
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
	});

	it("honors PIREMINDER_NOW for the automatic path", async () => {
		const original = process.env[NOW_OVERRIDE_ENV];
		process.env[NOW_OVERRIDE_ENV] = "02:30";
		try {
			setClock(); // restore default resolver (reads env)
			resetState();
			const ctx = mockCtx();
			await checkAndNotify(ctx); // no explicit time → resolveNow()
			expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);

			// Repeat same (simulated) day is silent.
			const ctx2 = mockCtx();
			await checkAndNotify(ctx2);
			expect(ctx2.ui.confirm).not.toHaveBeenCalled();
		} finally {
			if (original === undefined) delete process.env[NOW_OVERRIDE_ENV];
			else process.env[NOW_OVERRIDE_ENV] = original;
			setClock();
		}
	});
});

// ---------------------------------------------------------------------------
// isInWindow boundary checks
// ---------------------------------------------------------------------------

describe("isInWindow", () => {
	it("accepts 00:00 and 05:59, rejects 06:00 and 23:59", () => {
		expect(isInWindow(atTime(0, 0))).toBe(true);
		expect(isInWindow(atTime(5, 59))).toBe(true);
		expect(isInWindow(atTime(6, 0))).toBe(false);
		expect(isInWindow(atTime(23, 59))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// persistence — survives closing and reopening Pi
// ---------------------------------------------------------------------------

describe("persistent dedup across sessions", () => {
	let stateFile: string;

	beforeEach(() => {
		stateFile = path.join(
			os.tmpdir(),
			`pireminder-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
		);
		process.env[STATE_ENV] = stateFile;
		resetState();
	});

	afterEach(() => {
		clearPersistedState();
		delete process.env[STATE_ENV];
		resetState();
		setClock();
	});

	it("persistState writes the reminded dates to disk", () => {
		shouldRemind(atTime(2, 0)); // marks today
		persistState();
		const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		expect(saved.remindedDates).toContain(atTime(2, 0).toDateString());
	});

	it("loadState restores the date so a new session does not re-remind", async () => {
		// Session 1: remind and persist.
		shouldRemind(atTime(2, 0));
		persistState();

		// Simulate a brand-new Pi session: in-memory state is gone.
		resetState();
		expect(shouldRemind(atTime(2, 5))).toBe(true); // fresh process would remind

		// Now start the "new session": load from disk and check.
		resetState();
		loadState();
		const ctx = mockCtx();
		await checkAndNotify(ctx, atTime(2, 5));
		expect(ctx.ui.confirm).not.toHaveBeenCalled(); // silent
	});

	it("a stale (yesterday) persisted date still reminds today", async () => {
		fs.writeFileSync(
			stateFile,
			JSON.stringify({ lastRemindedDate: "Tue Jan 01 2002" }),
		);
		loadState();
		const ctx = mockCtx();
		await checkAndNotify(ctx, atTime(2, 0));
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
	});

	it("clearPersistedState removes the file", () => {
		persistState();
		expect(fs.existsSync(stateFile)).toBe(true);
		clearPersistedState();
		expect(fs.existsSync(stateFile)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// factory registration — Pi lifecycle wiring
// ---------------------------------------------------------------------------

describe("extension factory", () => {
	it("registers session_start, session_shutdown, /bedtime-test", () => {
		const events: string[] = [];
		const commands: string[] = [];
		const fakePi = {
			on: (event: string) => {
				events.push(event);
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			registerTool: () => {},
		} as any;

		const factory = reminder;
		factory(fakePi);

		expect(events).toEqual(["session_start", "session_shutdown"]);
		expect(commands).toEqual(["bedtime-test"]);
	});

	it("session_start handler takes (event, ctx) so the automatic reminder fires", async () => {
		jest.useFakeTimers();
		try {
			const handlers: Record<string, (...args: any[]) => any> = {};
			const fakePi = {
				on: (event: string, handler: (...args: any[]) => any) => {
					handlers[event] = handler;
				},
				registerCommand: () => {},
				registerTool: () => {},
			} as any;

			reminder(fakePi);
			resetState();
			setClock(() => atTime(2, 30)); // simulate 02:30

			// Isolate persistence to a temp file so the test writes nothing real.
			const stateFile = path.join(
				os.tmpdir(),
				`pireminder-handler-${Date.now()}.json`,
			);
			process.env[STATE_ENV] = stateFile;
			clearPersistedState();

			const ctx = mockCtx();
			// Emit exactly as Pi does: (event, ctx). The ctx must be second.
			await handlers["session_start"](
				{ type: "session_start", reason: "startup" },
				ctx,
			);
			expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);

			// Cleanup the interval the handler registered and the temp state.
			resetState();
			clearPersistedState();
			delete process.env[STATE_ENV];
		} finally {
			setClock();
			jest.useRealTimers();
		}
	});

	it("session_shutdown clears the interval timer", async () => {
		jest.useFakeTimers();
		try {
			const handlers: Record<string, (...args: any[]) => any> = {};
			const fakePi = {
				on: (event: string, handler: (...args: any[]) => any) => {
					handlers[event] = handler;
				},
				registerCommand: () => {},
				registerTool: () => {},
			} as any;

			reminder(fakePi);
			resetState(); // ensure no timer from a previous test
			setClock(() => atTime(2, 30));

			const stateFile = path.join(
				os.tmpdir(),
				`pireminder-shutdown-${Date.now()}.json`,
			);
			process.env[STATE_ENV] = stateFile;
			clearPersistedState();

			const ctx = mockCtx();
			await handlers["session_start"]({ type: "session_start" }, ctx);
			expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);

			await handlers["session_shutdown"]({ type: "session_shutdown" });

			// If the timer were still alive, the next 5-minute tick would remind
			// again (shutdown reset the in-memory dedup date to null).
			jest.advanceTimersByTime(5 * 60 * 1000);
			expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);

			clearPersistedState();
			delete process.env[STATE_ENV];
		} finally {
			resetState();
			setClock();
			jest.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// enable/disable toggle
// ---------------------------------------------------------------------------

describe("enable/disable", () => {
	const stateFile = path.join(
		os.tmpdir(),
		`pireminder-enabled-${process.pid}.json`,
	);

	/** Register the factory and return its command handlers. */
	function registeredCommands() {
		const commands: Record<string, (args: string, ctx: any) => Promise<void>> =
			{};
		const fakePi = {
			on: () => {},
			registerCommand: (name: string, cfg: any) => {
				commands[name] = cfg.handler;
			},
			registerTool: () => {},
		} as any;
		reminder(fakePi);
		return commands;
	}

	beforeEach(() => {
		process.env[STATE_ENV] = stateFile;
		clearPersistedState();
		resetState();
	});

	afterEach(() => {
		clearPersistedState();
		resetState();
		delete process.env[STATE_ENV];
	});

	it("defaults to enabled", () => {
		expect(isEnabled()).toBe(true);
	});

	it("setEnabled(false) persists across loadState", () => {
		setEnabled(false);
		expect(isEnabled()).toBe(false);
		resetState(); // memory back to default; disk still says off
		expect(isEnabled()).toBe(true);
		loadState();
		expect(isEnabled()).toBe(false);
	});

	it("/bedtime-test off, status, and on toggle the reminder", async () => {
		const commands = registeredCommands();

		const off = mockCtx();
		await commands["bedtime-test"]("off", off);
		expect(isEnabled()).toBe(false);
		expect(off.ui.notify).toHaveBeenCalledWith("Reminders disabled.", "info");

		const status = mockCtx();
		await commands["bedtime-test"]("status", status);
		expect(status.ui.notify).toHaveBeenCalledWith(
			"Reminders are currently off (window 00:00–06:00, default).",
			"info",
		);

		const on = mockCtx();
		await commands["bedtime-test"]("on", on);
		expect(isEnabled()).toBe(true);
		expect(on.ui.notify).toHaveBeenCalledWith("Reminders enabled.", "info");
	});

	it("automatic session_start stays silent while disabled", async () => {
		jest.useFakeTimers();
		try {
			const handlers: Record<string, (...args: any[]) => any> = {};
			const fakePi = {
				on: (event: string, handler: (...args: any[]) => any) => {
					handlers[event] = handler;
				},
				registerCommand: () => {},
				registerTool: () => {},
			} as any;
			reminder(fakePi);

			setClock(() => atTime(2, 30)); // inside the window
			setEnabled(false); // persisted to the temp state file

			const ctx = mockCtx();
			await handlers["session_start"]({ type: "session_start" }, ctx);
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
			expect(ctx.ui.notify).not.toHaveBeenCalled();
		} finally {
			resetState(); // clears the interval before restoring real timers
			setClock();
			jest.useRealTimers();
		}
	});

	it("manual /bedtime-test HH:MM still works while disabled", async () => {
		const commands = registeredCommands();
		setEnabled(false);

		const ctx = mockCtx();
		await commands["bedtime-test"]("4:30", ctx);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// configurable reminder window (default + custom)
// ---------------------------------------------------------------------------

describe("reminder window", () => {
	const stateFile = path.join(
		os.tmpdir(),
		`pireminder-window-${process.pid}.json`,
	);

	function registeredCommands() {
		const commands: Record<string, (args: string, ctx: any) => Promise<void>> =
			{};
		const fakePi = {
			on: () => {},
			registerCommand: (name: string, cfg: any) => {
				commands[name] = cfg.handler;
			},
			registerTool: () => {},
		} as any;
		reminder(fakePi);
		return commands;
	}

	beforeEach(() => {
		process.env[STATE_ENV] = stateFile;
		clearPersistedState();
		resetState();
	});

	afterEach(() => {
		clearPersistedState();
		resetState();
		delete process.env[STATE_ENV];
	});

	it("defaults to the original [00:00, 06:00) window", () => {
		expect(isDefaultWindow()).toBe(true);
		expect(getWindow()).toEqual({
			start: DEFAULT_WINDOW_START_MINUTES,
			end: DEFAULT_WINDOW_END_MINUTES,
		});
		expect(getWindowLabel()).toBe("00:00–06:00");
	});

	it("isInWindow uses a custom window", () => {
		setWindow(1 * 60, 3 * 60); // 01:00–03:00
		expect(isInWindow(atTime(2, 0))).toBe(true);
		expect(isInWindow(atTime(4, 0))).toBe(false);
	});

	it("supports a custom window that wraps past midnight", () => {
		setWindow(22 * 60, 6 * 60); // 22:00–06:00
		expect(isInWindow(atTime(23, 0))).toBe(true);
		expect(isInWindow(atTime(2, 0))).toBe(true);
		expect(isInWindow(atTime(12, 0))).toBe(false);
	});

	it("fires once inside a custom window, then stays silent", async () => {
		setWindow(1 * 60, 4 * 60); // 01:00–04:00
		const first = mockCtx();
		await checkAndNotify(first, atTime(2, 0));
		expect(first.ui.confirm).toHaveBeenCalledTimes(1);

		// Same day, later, still inside the custom window → silent.
		const repeat = mockCtx();
		await checkAndNotify(repeat, atTime(3, 0));
		expect(repeat.ui.confirm).not.toHaveBeenCalled();
		expect(repeat.ui.notify).not.toHaveBeenCalled();
	});

	it("stays silent outside a custom window, then reminds inside it", async () => {
		setWindow(1 * 60, 4 * 60); // 01:00–04:00
		const outside = mockCtx();
		await checkAndNotify(outside, atTime(5, 0));
		expect(outside.ui.confirm).not.toHaveBeenCalled();
		expect(outside.ui.notify).not.toHaveBeenCalled();

		// Entering the custom window still reminds.
		const inside = mockCtx();
		await checkAndNotify(inside, atTime(2, 0));
		expect(inside.ui.confirm).toHaveBeenCalledTimes(1);
	});

	it("fires once inside a wrap-around custom window, then silent", async () => {
		setWindow(22 * 60, 6 * 60); // 22:00–06:00
		const first = mockCtx();
		await checkAndNotify(first, atTime(23, 0));
		expect(first.ui.confirm).toHaveBeenCalledTimes(1);

		const repeat = mockCtx();
		await checkAndNotify(repeat, atTime(2, 0));
		expect(repeat.ui.confirm).not.toHaveBeenCalled();
	});

	it("a custom window set via /bedtime-test time drives the reminder flow", async () => {
		const commands = registeredCommands();
		await commands["bedtime-test"]("time 02:00 04:00", mockCtx());

		const inside = mockCtx();
		await checkAndNotify(inside, atTime(3, 0)); // inside 02:00–04:00
		expect(inside.ui.confirm).toHaveBeenCalledTimes(1);

		const evening = mockCtx();
		await checkAndNotify(evening, atTime(20, 0)); // outside
		expect(evening.ui.confirm).not.toHaveBeenCalled();
	});

	it("a custom window persists across loadState", () => {
		setWindow(22 * 60, 6 * 60);
		resetState(); // memory back to default; disk still custom
		expect(isDefaultWindow()).toBe(true);
		loadState();
		expect(getWindow()).toEqual({ start: 22 * 60, end: 6 * 60 });
	});

	it("/bedtime-test time sets, reports, and resets the window", async () => {
		const commands = registeredCommands();

		const set = mockCtx();
		await commands["bedtime-test"]("time 22:00 06:00", set);
		expect(getWindow()).toEqual({ start: 22 * 60, end: 6 * 60 });
		expect(set.ui.notify).toHaveBeenCalledWith(
			"Reminder window set to 22:00–06:00.",
			"info",
		);

		const show = mockCtx();
		await commands["bedtime-test"]("time", show);
		expect(show.ui.notify).toHaveBeenCalledWith(
			"Reminder window: 22:00–06:00 (custom).",
			"info",
		);

		const reset = mockCtx();
		await commands["bedtime-test"]("time default", reset);
		expect(isDefaultWindow()).toBe(true);
		expect(reset.ui.notify).toHaveBeenCalledWith(
			"Reminder window reset to default 00:00–06:00.",
			"info",
		);
	});

	it("/bedtime-test time warns on invalid or equal times", async () => {
		const commands = registeredCommands();

		const bad = mockCtx();
		await commands["bedtime-test"]("time 9:00", bad);
		expect(bad.ui.notify).toHaveBeenCalledWith(
			"Usage: /bedtime-test time [default | HH:MM HH:MM] (e.g. /bedtime-test time 22:00 06:00)",
			"warning",
		);

		const equal = mockCtx();
		await commands["bedtime-test"]("time 03:00 03:00", equal);
		expect(equal.ui.notify).toHaveBeenCalledWith(
			"Start and end times must differ.",
			"warning",
		);
	});

	it("resetWindow is exported and restores defaults", () => {
		setWindow(1, 2);
		resetWindow();
		expect(isDefaultWindow()).toBe(true);
	});

	it("standalone /bedtime-test reset clears dedup without a time", async () => {
		const commands = registeredCommands();

		// Remind once and confirm dedup is set.
		await commands["bedtime-test"]("3:00", mockCtx());
		expect(getRemindedDate()).not.toBeNull();

		// Standalone reset clears dedup.
		const resetCtx = mockCtx();
		await commands["bedtime-test"]("reset", resetCtx);
		expect(getRemindedDate()).toBeNull();
		expect(resetCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("dedup cleared"),
			"info",
		);
	});

	it("/bedtime-test reset clears dedup but preserves on/off and window", async () => {
		const commands = registeredCommands();
		setEnabled(false);
		setWindow(2 * 60, 5 * 60); // 02:00–05:00

		// First check inside the custom window reminds and sets the dedup date.
		await commands["bedtime-test"]("3:00", mockCtx());
		// A second check without reset would be silent; reset lets it fire again.
		const again = mockCtx();
		await commands["bedtime-test"]("3:00 reset", again);
		expect(again.ui.confirm).toHaveBeenCalledTimes(1);

		// Only the dedup date was cleared; the other settings survived.
		expect(isEnabled()).toBe(false);
		expect(getWindow()).toEqual({ start: 2 * 60, end: 5 * 60 });
	});
});

// ---------------------------------------------------------------------------
// /bedtime-test run_test — in-extension self-test
// ---------------------------------------------------------------------------

describe("run_test self-test", () => {
	const stateFile = path.join(
		os.tmpdir(),
		`pireminder-selftest-${process.pid}.json`,
	);

	beforeEach(() => {
		process.env[STATE_ENV] = stateFile;
		clearPersistedState();
		resetState();
	});

	afterEach(() => {
		clearPersistedState();
		resetState();
		delete process.env[STATE_ENV];
	});

	it("passes every built-in check", () => {
		const summary = runSelfTest();
		expect(summary.failed).toBe(0);
		expect(summary.passed).toBe(summary.total);
		expect(summary.total).toBeGreaterThan(0);
	});

	it("records time, already-reminded, and outcome for each check", () => {
		const summary = runSelfTest({ seed: 12345 });
		const byName = (n: string) => summary.results.find((r) => r.name === n)!;

		// Inclusive end boundary is fixed and reminds.
		expect(byName("inclusive end")).toMatchObject({
			time: expect.stringMatching(/05:59/),
			command: expect.stringMatching(/\/bedtime-test \d{4}-\d{2}-\d{2} 05:59 reset/),
			alreadyReminded: false,
			reminded: true,
			pass: true,
		});

		// First out-of-boundary check is the fixed 06:00 exclusive end.
		expect(byName("outside 1")).toMatchObject({
			time: expect.stringMatching(/06:00/),
			alreadyReminded: false,
			reminded: false,
			pass: true,
		});

		// Second consecutive check is already reminded → no reminder.
		expect(byName("second in-window")).toMatchObject({
			alreadyReminded: true,
			reminded: false,
			pass: true,
		});
	});

	it("is reproducible from a seed", () => {
		const a = runSelfTest({ seed: 777 }).results.map((r) => r.command);
		const b = runSelfTest({ seed: 777 }).results.map((r) => r.command);
		expect(a).toEqual(b);
	});

	it("groups the two consecutive checks onto one row with both commands", () => {
		const rows = groupSelfTestScenarios(runSelfTest());
		const consecutive = rows.find((r) => r.scenario === "Consecutive (dedup)")!;
		expect(consecutive.command).toMatch(
			/^\/bedtime-test \d{4}-\d{2}-\d{2} \d{2}:\d{2} reset; \/bedtime-test \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
		);
		expect(consecutive.output).toBe("reminder shown, no reminder");
		expect(consecutive.expected).toBe("reminder shown, no reminder");
		expect(consecutive.pass).toBe(true);
	});

	it("formats a labeled report per test situation", () => {
		const text = formatSelfTestReport(runSelfTest()).join("\n");
		expect(text).toContain("Test situation: Regular in-window");
		expect(text).toContain("Command:");
		expect(text).toContain("Output:");
		expect(text).toContain("Expected:");
		expect(text).toContain("Pass/Fail: PASS");
		expect(text).toMatch(/\/bedtime-test \d{4}-\d{2}-\d{2} 05:59 reset/);
		expect(text).toMatch(/Seed: \d+/);
	});

	it("does not disturb the user's real state", async () => {
		await checkAndNotify(mockCtx(), atTime(2, 0)); // set a dedup date
		const before = getRemindedDate();
		setEnabled(false);
		setWindow(2 * 60, 5 * 60);

		runSelfTest();

		expect(getRemindedDate()).toBe(before);
		expect(isEnabled()).toBe(false);
		expect(getWindow()).toEqual({ start: 2 * 60, end: 5 * 60 });
	});

	it("/bedtime-test run_test reports a pass", async () => {
		const commands: Record<string, (args: string, ctx: any) => Promise<void>> =
			{};
		const fakePi = {
			on: () => {},
			registerCommand: (name: string, cfg: any) => {
				commands[name] = cfg.handler;
			},
			registerTool: () => {},
		} as any;
		reminder(fakePi);

		const ctx = mockCtx();
		await commands["bedtime-test"]("run_test", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Self-test passed"),
			"info",
		);
	});

	it("/bedtime-test run_test writes the report to the transcript", async () => {
		const commands: Record<string, (args: string, ctx: any) => Promise<void>> =
			{};
		const sendMessage = jest.fn();
		const fakePi = {
			on: () => {},
			registerCommand: (name: string, cfg: any) => {
				commands[name] = cfg.handler;
			},
			registerTool: () => {},
			sendMessage,
		} as any;
		reminder(fakePi);

		const ctx = mockCtx();
		await commands["bedtime-test"]("run_test", ctx);

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "bedtime-test-selftest",
				display: true,
				content: expect.stringContaining("Test situation: Regular in-window"),
			}),
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Self-test passed"),
			"info",
		);
	});

	it("bare /bedtime-test shows the numbered command menu", async () => {
		const commands: Record<string, (args: string, ctx: any) => Promise<void>> =
			{};
		const sendMessage = jest.fn();
		const fakePi = {
			on: () => {},
			registerCommand: (name: string, cfg: any) => {
				commands[name] = cfg.handler;
			},
			registerTool: () => {},
			sendMessage,
		} as any;
		reminder(fakePi);

		const ctx = mockCtx();
		await commands["bedtime-test"]("", ctx);

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "bedtime-test-help",
				display: true,
				content: expect.stringContaining("1. /bedtime-test [YYYY-MM-DD | Month D YYYY] HH:MM [reset]"),
			}),
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("available commands"),
			"info",
		);
	});

	it("the menu lists every option with a description", () => {
		const text = formatHelp().join("\n");
		expect(text).toContain("1. /bedtime-test [YYYY-MM-DD | Month D YYYY] HH:MM [reset]");
		expect(text).toContain("2. /bedtime-test reset");
		expect(text).toContain("3. /bedtime-test on | off");
		expect(text).toContain("4. /bedtime-test status");
		expect(text).toContain("5. /bedtime-test time");
		expect(text).toContain("6. /bedtime-test run_test");
	});

	it("/bedtime-test run_test falls back to a widget without sendMessage", async () => {
		const commands: Record<string, (args: string, ctx: any) => Promise<void>> =
			{};
		const fakePi = {
			on: () => {},
			registerCommand: (name: string, cfg: any) => {
				commands[name] = cfg.handler;
			},
			registerTool: () => {},
		} as any;
		reminder(fakePi);

		const setWidget = jest.fn();
		const ctx = {
			ui: { notify: jest.fn(), confirm: jest.fn().mockResolvedValue(true), setWidget },
		} as any;
		await commands["bedtime-test"]("run_test", ctx);

		expect(setWidget).toHaveBeenCalledWith(
			"bedtime-test-selftest",
			[expect.stringContaining("Test situation:")],
			{ placement: "aboveEditor" },
		);
	});
});

// ---------------------------------------------------------------------------
// /bedtime-test date tracking
// ---------------------------------------------------------------------------

describe("bedtime-test date tracking", () => {
	const stateFile = path.join(
		os.tmpdir(),
		`pireminder-date-${process.pid}.json`,
	);

	function registeredCommands() {
		const commands: Record<string, (args: string, ctx: any) => Promise<void>> =
			{};
		const fakePi = {
			on: () => {},
			registerCommand: (name: string, cfg: any) => {
				commands[name] = cfg.handler;
			},
			registerTool: () => {},
		} as any;
		reminder(fakePi);
		return commands;
	}

	beforeEach(() => {
		process.env[STATE_ENV] = stateFile;
		clearPersistedState();
		resetState();
	});

	afterEach(() => {
		clearPersistedState();
		resetState();
		delete process.env[STATE_ENV];
	});

	it("accepts a natural-language date before the time", async () => {
		const commands = registeredCommands();
		const ctx = mockCtx();
		await commands["bedtime-test"]("october 6 2026 4:30", ctx);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
	});

	it("accepts YYYY-MM-DD format", async () => {
		const commands = registeredCommands();
		const ctx = mockCtx();
		await commands["bedtime-test"]("2026-10-06 4:30", ctx);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
	});

	it("tracks dedup across different dates and reset", async () => {
		const commands = registeredCommands();

		// Oct 6 → first time, should remind
		await commands["bedtime-test"]("october 6 2026 4:30", mockCtx());

		// Oct 7 → new day, should remind
		await commands["bedtime-test"]("october 7 2026 5:00", mockCtx());

		// Same Oct 7 without reset → should be silent
		const silent = mockCtx();
		await commands["bedtime-test"]("october 7 2026 5:30", silent);
		expect(silent.ui.confirm).not.toHaveBeenCalled();

		// Same Oct 7 with reset → should remind again
		const again = mockCtx();
		await commands["bedtime-test"]("october 7 2026 5:30 reset", again);
		expect(again.ui.confirm).toHaveBeenCalledTimes(1);
	});
});

