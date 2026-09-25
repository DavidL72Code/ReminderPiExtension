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

	it("persistState writes the reminded date to disk", () => {
		shouldRemind(atTime(2, 0)); // marks today
		persistState();
		const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		expect(saved.lastRemindedDate).toBe(atTime(2, 0).toDateString());
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
	it("registers session_start, session_shutdown, and reminder-check", () => {
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
		expect(commands).toEqual(["reminder-check"]);
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
});
