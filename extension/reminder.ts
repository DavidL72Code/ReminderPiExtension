/**
 * PiReminder Extension
 *
 * While Pi is running during the late-night window, remind the user once per
 * day to take a break and continue again in the morning. The first trigger
 * shows a yes/no acknowledgment dialog. Subsequent checks in the same window
 * are silent (no duplicate notification). Outside the window nothing fires.
 *
 * The window defaults to the original 00:00–05:59 and can be changed to a
 * custom window with /bedtime-test time. Reminders can be switched off and on
 * with /bedtime-test off / /bedtime-test on; both settings persist across
 * sessions. /bedtime-test run_test runs an in-extension self-test.
 *
 * Uses Pi's session lifecycle for resource cleanup.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Default reminder window: 00:00 (inclusive) to 06:00 (exclusive), in
 * minutes since midnight. This is the original built-in behavior; it stays in
 * effect unless the user explicitly sets a custom window via /bedtime-test
 * time.
 */
export const DEFAULT_WINDOW_START_MINUTES = 0;
export const DEFAULT_WINDOW_END_MINUTES = 6 * 60; // 360

/** Check interval: every 5 minutes. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Test/demo escape hatch: set PIREMINDER_NOW=HH:MM to pretend the wall clock
 * is that time. This lets the automatic session_start reminder be exercised
 * without waiting until the middle of the night. It has no effect when unset.
 */
export const NOW_OVERRIDE_ENV = "PIREMINDER_NOW";

/** Resolve "now", honoring the PIREMINDER_NOW override if present. */
function resolveNow(): Date {
	const override = process.env[NOW_OVERRIDE_ENV];
	if (override) {
		const match = override.match(/^(\d{1,2}):(\d{2})$/);
		if (match) {
			const hour = Number(match[1]);
			const minute = Number(match[2]);
			if (hour <= 23 && minute <= 59) {
				const d = new Date();
				d.setHours(hour, minute, 0, 0);
				return d;
			}
		}
	}
	return new Date();
}

/** Date string of the last day we reminded (dedup state). */
let remindedDate: string | null = null;

/**
 * Whether the automatic reminder is enabled. Persisted so a /bedtime-test off
 * choice survives closing and reopening Pi. Manual /bedtime-test HH:MM checks
 * ignore this flag so the extension stays testable.
 */
let enabled = true;

/**
 * Reminder window bounds, in minutes since midnight. Defaults to the original
 * [00:00, 06:00) window and only changes when the user picks a custom window.
 */
let windowStartMinutes = DEFAULT_WINDOW_START_MINUTES;
let windowEndMinutes = DEFAULT_WINDOW_END_MINUTES;

/** Timer handle for the periodic check. */
let timer: ReturnType<typeof setInterval> | null = null;

/** Clock function — overridable for deterministic testing. */
let getNow: () => Date = resolveNow;

const REMINDER_MESSAGE =
	"It's late — take a break and continue again in the morning.";

/**
 * Env var to override the persistent state file path (used by tests/tools).
 * Defaults to ~/.pi/agent/pireminder-state.json so the once-per-day rule
 * survives closing and reopening Pi.
 */
export const STATE_ENV = "PIREMINDER_STATE";

function statePath(): string {
	return (
		process.env[STATE_ENV] ||
		path.join(os.homedir(), ".pi", "agent", "pireminder-state.json")
	);
}

/** Load the last-reminded date from disk (if any). */
export function loadState(): void {
	try {
		const raw = fs.readFileSync(statePath(), "utf8");
		const data = JSON.parse(raw);
		if (typeof data?.lastRemindedDate === "string") {
			remindedDate = data.lastRemindedDate;
		}
		if (typeof data?.enabled === "boolean") {
			enabled = data.enabled;
		}
		if (
			Number.isInteger(data?.windowStart) &&
			Number.isInteger(data?.windowEnd)
		) {
			windowStartMinutes = data.windowStart;
			windowEndMinutes = data.windowEnd;
		}
	} catch {
		// No state file yet, or unreadable — treat as never reminded.
	}
}

/** Persist the current last-reminded date to disk (best effort). */
export function persistState(): void {
	try {
		const p = statePath();
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(
			p,
			JSON.stringify(
				{
					lastRemindedDate: remindedDate,
					enabled,
					windowStart: windowStartMinutes,
					windowEnd: windowEndMinutes,
				},
				null,
				2,
			) + "\n",
		);
	} catch {
		// Best effort — a failed write must not break the session.
	}
}

/** Delete the persisted state (used by tests and /bedtime-test reset). */
export function clearPersistedState(): void {
	try {
		fs.rmSync(statePath(), { force: true });
	} catch {
		// Ignore.
	}
}

/** Is the automatic reminder currently enabled? */
export function isEnabled(): boolean {
	return enabled;
}

/** Enable/disable the automatic reminder and persist the choice. */
export function setEnabled(value: boolean): void {
	enabled = value;
	persistState();
}

/** Format minutes-since-midnight as HH:MM. */
function formatMinutes(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Current reminder window bounds (minutes since midnight). */
export function getWindow(): { start: number; end: number } {
	return { start: windowStartMinutes, end: windowEndMinutes };
}

/** Human-readable current window, e.g. "00:00–06:00". */
export function getWindowLabel(): string {
	return `${formatMinutes(windowStartMinutes)}–${formatMinutes(windowEndMinutes)}`;
}

/** True when the window is still the original default. */
export function isDefaultWindow(): boolean {
	return (
		windowStartMinutes === DEFAULT_WINDOW_START_MINUTES &&
		windowEndMinutes === DEFAULT_WINDOW_END_MINUTES
	);
}

/**
 * Set a custom reminder window (minutes since midnight) and persist it.
 * A window whose start is after its end wraps across midnight.
 */
export function setWindow(startMinutes: number, endMinutes: number): void {
	windowStartMinutes = startMinutes;
	windowEndMinutes = endMinutes;
	persistState();
}

/** Restore the original default window and persist it. */
export function resetWindow(): void {
	windowStartMinutes = DEFAULT_WINDOW_START_MINUTES;
	windowEndMinutes = DEFAULT_WINDOW_END_MINUTES;
	persistState();
}

/**
 * Determine whether the current time falls inside the reminder window.
 * Defaults to [00:00, 06:00); supports custom windows that wrap midnight
 * (e.g. 22:00–06:00).
 */
export function isInWindow(now: Date): boolean {
	const minutes = now.getHours() * 60 + now.getMinutes();
	if (windowStartMinutes < windowEndMinutes) {
		return minutes >= windowStartMinutes && minutes < windowEndMinutes;
	}
	// Wrap-around window (start >= end).
	return minutes >= windowStartMinutes || minutes < windowEndMinutes;
}

/**
 * Core policy: should we show a reminder right now?
 * Returns true only the first time, per calendar day, inside the window.
 */
export function shouldRemind(now: Date): boolean {
	const today = now.toDateString();
	// Deduplication: already reminded today → silent.
	if (remindedDate === today) return false;
	// Only remind inside [00:00, 06:00).
	if (isInWindow(now)) {
		remindedDate = today;
		return true;
	}
	// 06:00–23:59 → never remind.
	return false;
}

/**
 * Perform one reminder check.
 *
 * First trigger in the window: notify + ask for yes/no acknowledgment.
 * Once acknowledged (either answer), no further reminders that day.
 *
 * @param now Optional simulated time (used by tests and /bedtime-test).
 */
export async function checkAndNotify(
	ctx: {
		ui: {
			notify(message: string, type: string): void;
			confirm(title: string, message: string): Promise<boolean>;
		};
	},
	now?: Date,
): Promise<void> {
	const time = now ?? getNow();
	if (!shouldRemind(time)) return;
	await showReminder(ctx);
}

/** Show the notification and yes/no acknowledgment dialog. */
async function showReminder(ctx: {
	ui: {
		notify(message: string, type: string): void;
		confirm(title: string, message: string): Promise<boolean>;
	};
}): Promise<void> {
	// First (and only) reminder for today: pop up the acknowledgment dialog.
	ctx.ui.notify(REMINDER_MESSAGE, "info");
	const acknowledged = await ctx.ui.confirm(
		"Time for a Break",
		"It's late — take a break and continue again in the morning. Do you acknowledge this advice?",
	);

	// Record acknowledgment (yes or no). No more reminders today.
	if (acknowledged) {
		ctx.ui.notify("Great — rest well and pick it up in the morning. 👋", "info");
	} else {
		ctx.ui.notify("Understood — you won't be reminded again today.", "info");
	}
}

/**
 * Like checkAndNotify, but persists the reminded date so a new session on the
 * same night does not prompt again. Used by the real session/timer/command
 * paths; unit tests call checkAndNotify directly and never touch disk.
 *
 * The date is persisted BEFORE the dialog is shown: the reminder has already
 * been decided and delivered at that point, so dedup stays robust even if the
 * dialog is slow or never answered (e.g. some non-interactive modes).
 */
async function checkAndPersist(
	ctx: Parameters<typeof checkAndNotify>[0],
	now?: Date,
	options?: { force?: boolean },
): Promise<void> {
	// The automatic path is silent while reminders are off; manual checks pass
	// { force: true } so /bedtime-test HH:MM keeps working for testing.
	if (!enabled && !options?.force) return;
	const time = now ?? getNow();
	if (!shouldRemind(time)) return;
	persistState();
	await showReminder(ctx);
}

export default function (pi: ExtensionAPI) {
	// Start periodic checks when a session begins.
	// Per Pi lifecycle rules, timers must not be started in the factory.
	// NOTE: Pi event handlers receive (event, ctx) — the context is the
	// SECOND argument. Taking only one parameter would capture the event.
	pi.on("session_start", async (_event, ctx) => {
		// Load any persisted reminder state first, so a new session on the same
		// night honors the once-per-day rule instead of prompting again.
		loadState();
		await checkAndPersist(ctx);
		timer = setInterval(() => checkAndPersist(ctx), CHECK_INTERVAL_MS);
	});

	// Clean up the timer when the session ends.
	pi.on("session_shutdown", async () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		remindedDate = null;
	});

	// Bedtime test/control command, run against the REAL Pi UI:
	//   /bedtime-test 4:30          (simulate a check; respects today's dedup)
	//   /bedtime-test 4:30 reset    (clear dedup first)
	//   /bedtime-test on | off | status | time ...
	//   /bedtime-test run_test      (run the in-extension self-test)
	pi.registerCommand("bedtime-test", {
		description:
			"Bedtime reminder: test at HH:MM, manage on/off/time, or run_test (add 'reset' to clear dedup)",
		handler: (args, ctx) => runBedtimeTestCommand(args, ctx, pi),
	});
}

/**
 * Shared handler for /bedtime-test. Parses an HH:MM argument, optionally
 * clears today's dedup state when 'reset' is present, then runs a reminder
 * check at the simulated time against the real Pi UI. Also handles the
 * on/off/status/time subcommands.
 */
async function runBedtimeTestCommand(
	args: string,
	ctx: ExtensionContext,
	pi?: ExtensionAPI,
): Promise<void> {
	const parts = (args || "").trim().toLowerCase().split(/\s+/);
	const sub = parts[0] || "";

	// No argument (or "help"): show the numbered command menu.
	if (sub === "" || sub === "help") {
		ctx.ui.notify("Bedtime reminder — available commands.", "info");
		writeReport(ctx, pi, "bedtime-test-help", formatHelp().join("\n"));
		return;
	}

	// on / off / status: toggle the automatic reminder (persisted).
	if (sub === "on") {
		setEnabled(true);
		ctx.ui.notify("Reminders enabled.", "info");
		return;
	}
	if (sub === "off") {
		setEnabled(false);
		ctx.ui.notify("Reminders disabled.", "info");
		return;
	}
	if (sub === "status") {
		const kind = isDefaultWindow() ? "default" : "custom";
		ctx.ui.notify(
			`Reminders are currently ${enabled ? "on" : "off"} ` +
				`(window ${getWindowLabel()}, ${kind}).`,
			"info",
		);
		return;
	}

	// time: view, reset to default, or set a custom reminder window.
	if (sub === "time") {
		const arg = parts[1] || "";
		if (!arg || arg === "status") {
			const kind = isDefaultWindow() ? "default" : "custom";
			ctx.ui.notify(
				`Reminder window: ${getWindowLabel()} (${kind}).`,
				"info",
			);
			return;
		}
		if (arg === "default") {
			resetWindow();
			ctx.ui.notify(
				`Reminder window reset to default ${getWindowLabel()}.`,
				"info",
			);
			return;
		}
		const startMatch = arg.match(/^(\d{1,2}):(\d{2})$/);
		const endMatch = (parts[2] || "").match(/^(\d{1,2}):(\d{2})$/);
		if (!startMatch || !endMatch) {
			ctx.ui.notify(
				"Usage: /bedtime-test time [default | HH:MM HH:MM] (e.g. /bedtime-test time 22:00 06:00)",
				"warning",
			);
			return;
		}
		const startH = Number(startMatch[1]);
		const startM = Number(startMatch[2]);
		const endH = Number(endMatch[1]);
		const endM = Number(endMatch[2]);
		if (startH > 23 || startM > 59 || endH > 23 || endM > 59) {
			ctx.ui.notify("Invalid time. Use HH:MM (00:00–23:59).", "warning");
			return;
		}
		const start = startH * 60 + startM;
		const end = endH * 60 + endM;
		if (start === end) {
			ctx.ui.notify("Start and end times must differ.", "warning");
			return;
		}
		setWindow(start, end);
		ctx.ui.notify(`Reminder window set to ${getWindowLabel()}.`, "info");
		return;
	}

	// run_test: run the built-in self-test against the live extension code.
	if (sub === "run_test" || sub === "run-test" || sub === "test") {
		// Optional numeric seed: /bedtime-test run_test 12345 reproduces a run.
		const seedArg = parts[1];
		const seed =
			seedArg && /^\d+$/.test(seedArg) ? Number(seedArg) : undefined;
		const summary = runSelfTest({ seed });
		ctx.ui.notify(
			summary.failed === 0
				? `Self-test passed: ${summary.passed}/${summary.total} checks OK.`
				: `Self-test FAILED: ${summary.failed}/${summary.total} checks failed.`,
			summary.failed === 0 ? "info" : "error",
		);
		writeReport(
			ctx,
			pi,
			"bedtime-test-selftest",
			formatSelfTestReport(summary).join("\n"),
		);
		return;
	}

	const match = sub.match(/^(\d{1,2}):(\d{2})$/);
	if (!match) {
		ctx.ui.notify(
			"Usage: /bedtime-test HH:MM [reset] | on | off | status | time | run_test (run /bedtime-test with no args for the full list)",
			"warning",
		);
		return;
	}
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) {
		ctx.ui.notify("Invalid time. Use HH:MM (00:00–23:59).", "warning");
		return;
	}
	const simulated = new Date();
	simulated.setHours(hour, minute, 0, 0);
	// Optional reset so the demo can be repeated in one session. Only the dedup
	// date is cleared; the on/off choice is preserved.
	if (parts.includes("reset")) {
		remindedDate = null;
		persistState();
	}
	// Manual checks always run, even when the automatic reminder is off.
	await checkAndPersist(ctx, simulated, { force: true });
}

// --- Testing utilities ---

/** Override the clock (leave undefined to restore the default resolver). */
export function setClock(fn?: () => Date): void {
	getNow = fn ?? resolveNow;
}

/** Reset all state (for testing). */
export function resetState(): void {
	remindedDate = null;
	enabled = true;
	windowStartMinutes = DEFAULT_WINDOW_START_MINUTES;
	windowEndMinutes = DEFAULT_WINDOW_END_MINUTES;
	if (timer !== null) {
		clearInterval(timer);
		timer = null;
	}
}

/** Inspect the dedup state: the date string last reminded, or null. */
export function getRemindedDate(): string | null {
	return remindedDate;
}

/** One check in the in-extension self-test. */
export interface SelfTestCase {
	name: string;
	/** Scenario group shown in the report, e.g. "Consecutive (dedup)". */
	scenario: string;
	/** Window-setup command shared by the scenario's checks, if any. */
	setup?: string;
	/** Simulated time label, e.g. "23:59". */
	time: string;
	/** Equivalent /bedtime-test command to reproduce the check. */
	command: string;
	/** Was the day already marked as reminded before the check? */
	alreadyReminded: boolean;
	/** What the policy should have decided. */
	expected: boolean;
	/** Did the policy decide a reminder should be shown? */
	reminded: boolean;
	/** Whether `reminded` matched the expectation. */
	pass: boolean;
}

/** Result of `runSelfTest`. */
export interface SelfTestSummary {
	seed: number;
	total: number;
	passed: number;
	failed: number;
	results: SelfTestCase[];
}

/** Small seeded PRNG (mulberry32) so randomized times are reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Run a fast, self-contained check of the reminder policy without touching the
 * user's persisted state. Backs the `/bedtime-test run_test` command so the
 * extension can be verified from inside a live Pi session.
 *
 * Times are randomized within each scenario's category (regular in-window,
 * inclusive boundaries, out-of-boundary, consecutive/dedup, next day, custom
 * window, wrap window). Values that define a category (00:00, 05:59, 06:00)
 * stay fixed. A seed makes every run reproducible. The user's dedup date,
 * on/off setting, and window are snapshotted and restored, so running the
 * self-test never changes real behavior.
 */
export function runSelfTest(options?: { seed?: number }): SelfTestSummary {
	const seed = options?.seed ?? Math.floor(Math.random() * 0xffffffff) >>> 0;
	const rng = mulberry32(seed);
	const randInt = (min: number, max: number) =>
		min + Math.floor(rng() * (max - min + 1));
	const fmt = (m: number) =>
		`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

	// Snapshot so the test never disturbs the user's real configuration.
	const savedReminded = remindedDate;
	const savedEnabled = enabled;
	const savedStart = windowStartMinutes;
	const savedEnd = windowEndMinutes;

	const results: SelfTestCase[] = [];
	const at = (h: number, m = 0) => new Date(2025, 0, 1, h, m);
	const atMin = (m: number, day = 1) =>
		new Date(2025, 0, day, Math.floor(m / 60), m % 60, 0, 0);
	const record = (c: {
		name: string;
		scenario: string;
		setup?: string;
		time: string;
		command: string;
		alreadyReminded: boolean;
		expected: boolean;
		actual: boolean;
	}) => {
		results.push({
			name: c.name,
			scenario: c.scenario,
			setup: c.setup,
			time: c.time,
			command: c.command,
			alreadyReminded: c.alreadyReminded,
			expected: c.expected,
			reminded: c.actual,
			pass: c.actual === c.expected,
		});
	};

	try {
		// Deterministic baseline: default window, enabled, no dedup.
		enabled = true;
		windowStartMinutes = DEFAULT_WINDOW_START_MINUTES;
		windowEndMinutes = DEFAULT_WINDOW_END_MINUTES;

		// 1. A regular single in-window reminder at a random in-window time.
		const regular = randInt(0, DEFAULT_WINDOW_END_MINUTES - 1);
		remindedDate = null;
		record({
			name: "regular in-window",
			scenario: "Regular in-window",
			time: fmt(regular),
			command: `/bedtime-test ${fmt(regular)} reset`,
			alreadyReminded: false,
			expected: true,
			actual: shouldRemind(atMin(regular)),
		});

		// 2. Inclusive window boundaries still remind.
		remindedDate = null;
		record({
			name: "inclusive start",
			scenario: "Boundary (inclusive)",
			time: "00:00",
			command: "/bedtime-test 00:00 reset",
			alreadyReminded: false,
			expected: true,
			actual: shouldRemind(at(0, 0)),
		});
		remindedDate = null;
		record({
			name: "inclusive end",
			scenario: "Boundary (inclusive)",
			time: "05:59",
			command: "/bedtime-test 05:59 reset",
			alreadyReminded: false,
			expected: true,
			actual: shouldRemind(at(5, 59)),
		});

		// 3. Out-of-boundary times never remind: fixed 06:00 + two random
		// times between 06:00 and 23:59.
		const outsideMinutes = [
			DEFAULT_WINDOW_END_MINUTES,
			randInt(DEFAULT_WINDOW_END_MINUTES + 1, 1439),
			randInt(DEFAULT_WINDOW_END_MINUTES + 1, 1439),
		];
		for (let i = 0; i < outsideMinutes.length; i++) {
			const m = outsideMinutes[i];
			remindedDate = null;
			record({
				name: `outside ${i + 1}`,
				scenario: "Out of boundary",
				time: fmt(m),
				command: `/bedtime-test ${fmt(m)} reset`,
				alreadyReminded: false,
				expected: false,
				actual: shouldRemind(atMin(m)),
			});
		}

		// 4. Two consecutive in-window checks: the second must be silent.
		const firstTime = randInt(0, DEFAULT_WINDOW_END_MINUTES - 2);
		const secondTime = randInt(firstTime + 1, DEFAULT_WINDOW_END_MINUTES - 1);
		remindedDate = null;
		record({
			name: "first in-window",
			scenario: "Consecutive (dedup)",
			time: fmt(firstTime),
			command: `/bedtime-test ${fmt(firstTime)} reset`,
			alreadyReminded: false,
			expected: true,
			actual: shouldRemind(atMin(firstTime)),
		});
		record({
			name: "second in-window",
			scenario: "Consecutive (dedup)",
			time: fmt(secondTime),
			command: `/bedtime-test ${fmt(secondTime)}`,
			alreadyReminded: true,
			expected: false,
			actual: shouldRemind(atMin(secondTime)),
		});

		// 5. A new calendar day resets the dedup.
		const nextTime = randInt(0, DEFAULT_WINDOW_END_MINUTES - 1);
		remindedDate = null;
		shouldRemind(atMin(nextTime, 1));
		record({
			name: "next day",
			scenario: "Next day",
			time: `${fmt(nextTime)} next day`,
			command: `/bedtime-test ${fmt(nextTime)} reset`,
			alreadyReminded: false,
			expected: true,
			actual: shouldRemind(atMin(nextTime, 2)),
		});

		// 6. Custom (non-wrapping) window with random bounds.
		const customStart = randInt(0, 600);
		const customEnd = randInt(
			customStart + 60,
			Math.min(customStart + 600, 1439),
		);
		const customSetup = `/bedtime-test time ${fmt(customStart)} ${fmt(customEnd)}`;
		windowStartMinutes = customStart;
		windowEndMinutes = customEnd;
		const customInside = randInt(customStart, customEnd - 1);
		remindedDate = null;
		record({
			name: "custom inside",
			scenario: "Custom window",
			setup: customSetup,
			time: fmt(customInside),
			command: `/bedtime-test ${fmt(customInside)} reset`,
			alreadyReminded: false,
			expected: true,
			actual: shouldRemind(atMin(customInside)),
		});
		remindedDate = null;
		record({
			name: "custom outside",
			scenario: "Custom window",
			setup: customSetup,
			time: fmt(customEnd),
			command: `/bedtime-test ${fmt(customEnd)} reset`,
			alreadyReminded: false,
			expected: false,
			actual: shouldRemind(atMin(customEnd)),
		});

		// 7. Wrap-around window with random bounds (start > end).
		const wrapStart = randInt(720, 1380); // 12:00–23:00
		const wrapEnd = randInt(60, Math.min(660, wrapStart - 60)); // 01:00–11:00
		const wrapSetup = `/bedtime-test time ${fmt(wrapStart)} ${fmt(wrapEnd)}`;
		windowStartMinutes = wrapStart;
		windowEndMinutes = wrapEnd;
		const wrapChecks: Array<[string, number, boolean]> = [
			["wrap evening", randInt(wrapStart, 1439), true],
			["wrap early", randInt(0, wrapEnd - 1), true],
			["wrap midday", randInt(wrapEnd, wrapStart - 1), false],
		];
		for (const [name, m, expected] of wrapChecks) {
			remindedDate = null;
			record({
				name,
				scenario: "Wrap window",
				setup: wrapSetup,
				time: fmt(m),
				command: `/bedtime-test ${fmt(m)} reset`,
				alreadyReminded: false,
				expected,
				actual: shouldRemind(atMin(m)),
			});
		}
	} finally {
		remindedDate = savedReminded;
		enabled = savedEnabled;
		windowStartMinutes = savedStart;
		windowEndMinutes = savedEnd;
	}

	const passed = results.filter((r) => r.pass).length;
	return {
		seed,
		total: results.length,
		passed,
		failed: results.length - passed,
		results,
	};
}

/** One scenario row in the self-test report. */
export interface SelfTestScenarioRow {
	scenario: string;
	command: string;
	output: string;
	expected: string;
	pass: boolean;
}

/**
 * Group the individual self-test checks into scenario rows for display. Each
 * scenario (regular, boundary, out-of-boundary, consecutive/dedup, next day,
 * custom, wrap) becomes one row, so related checks such as the two consecutive
 * in-window commands appear together on a single line.
 */
export function groupSelfTestScenarios(
	summary: SelfTestSummary,
): SelfTestScenarioRow[] {
	const order: string[] = [];
	const groups = new Map<string, SelfTestCase[]>();
	for (const r of summary.results) {
		if (!groups.has(r.scenario)) {
			groups.set(r.scenario, []);
			order.push(r.scenario);
		}
		groups.get(r.scenario)!.push(r);
	}
	return order.map((scenario) => {
		const checks = groups.get(scenario)!;
		const setup = checks.find((c) => c.setup)?.setup;
		const command = [setup, ...checks.map((c) => c.command)]
			.filter((c): c is string => Boolean(c))
			.join("; ");
		return {
			scenario,
			command,
			output: checks
				.map((c) => (c.reminded ? "reminder shown" : "no reminder"))
				.join(", "),
			expected: checks
				.map((c) => (c.expected ? "reminder shown" : "no reminder"))
				.join(", "),
			pass: checks.every((c) => c.pass),
		};
	});
}

/**
 * Build the report shown by `/bedtime-test run_test`: one labeled block per
 * test situation, with Command / Output / Expected / Pass-Fail lines.
 *
 * Returned as individual lines; the command joins them and sends them to the
 * Pi transcript (which is scrollable), avoiding the 10-line widget cap.
 */
export function formatSelfTestReport(summary: SelfTestSummary): string[] {
	const scenarios = groupSelfTestScenarios(summary);
	const lines: string[] = [
		`Bedtime reminder self-test — ${summary.passed}/${summary.total} passed` +
			(summary.failed ? ` (${summary.failed} FAILED)` : ""),
		`Seed: ${summary.seed} (reproduce: /bedtime-test run_test ${summary.seed})`,
	];
	for (const s of scenarios) {
		lines.push("");
		lines.push(`Test situation: ${s.scenario}`);
		lines.push(`  Command:   ${s.command}`);
		lines.push(`  Output:    ${s.output}`);
		lines.push(`  Expected:  ${s.expected}`);
		lines.push(`  Pass/Fail: ${s.pass ? "PASS" : "FAIL"}`);
	}
	return lines;
}

/**
 * Numbered menu shown by `/bedtime-test` with no arguments (or `help`).
 * Each entry lists the exact command and what it does.
 */
export function formatHelp(): string[] {
	return [
		"Bedtime reminder — available commands",
		"",
		"  1. /bedtime-test HH:MM [reset]",
		"       Simulate a reminder check at a time (e.g. /bedtime-test 4:30).",
		"       Add 'reset' to clear today's dedup first so it can fire again.",
		"",
		"  2. /bedtime-test on | off",
		"       Enable or disable the automatic reminder (persisted).",
		"",
		"  3. /bedtime-test status",
		"       Show whether reminders are on/off and the active window.",
		"",
		"  4. /bedtime-test time [default | HH:MM HH:MM]",
		"       Show or set the reminder window. Default is 00:00–06:00;",
		"       a custom window may wrap midnight (e.g. 22:00 06:00).",
		"",
		"  5. /bedtime-test run_test [seed]",
		"       Run the built-in self-test (randomized). Pass a seed to repeat.",
	];
}

/**
 * Write a multi-line report either to the Pi transcript (preferred, not
 * line-capped) or, as a fallback, to an above-editor widget.
 */
function writeReport(
	ctx: ExtensionContext,
	pi: ExtensionAPI | undefined,
	customType: string,
	text: string,
): void {
	if (pi?.sendMessage) {
		pi.sendMessage({ customType, content: text, display: true });
	} else {
		ctx.ui.setWidget?.(customType, [text], { placement: "aboveEditor" });
	}
}
