/**
 * PiReminder Extension
 *
 * While Pi is running during the late-night window (00:00–05:59), remind the
 * user once per day to take a break and continue again in the morning.
 * The first trigger shows a yes/no acknowledgment dialog. Subsequent checks
 * in the same window are silent (no duplicate notification). No reminders fire
 * from 06:00–23:59.
 *
 * Uses Pi's session lifecycle for resource cleanup.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Reminder window: 00:00 (inclusive) to 06:00 (exclusive). */
const WINDOW_END_MINUTES = 6 * 60; // 360 minutes

/** Check interval: every 5 minutes. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Date string of the last day we reminded (dedup state). */
let remindedDate: string | null = null;

/** Timer handle for the periodic check. */
let timer: ReturnType<typeof setInterval> | null = null;

/** Clock function — overridable for deterministic testing. */
let getNow: () => Date = () => new Date();

const REMINDER_MESSAGE =
	"It's late — take a break and continue again in the morning.";

/**
 * Determine whether the current time falls inside the reminder window.
 * Window is [00:00, 06:00).
 */
export function isInWindow(now: Date): boolean {
	const minutes = now.getHours() * 60 + now.getMinutes();
	return minutes >= 0 && minutes < WINDOW_END_MINUTES;
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
 * @param now Optional simulated time (used by tests and /reminder-check).
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

export default function (pi: ExtensionAPI) {
	// Start periodic checks when a session begins.
	// Per Pi lifecycle rules, timers must not be started in the factory.
	pi.on("session_start", async (ctx) => {
		await checkAndNotify(ctx);
		timer = setInterval(() => checkAndNotify(ctx), CHECK_INTERVAL_MS);
	});

	// Clean up the timer when the session ends.
	pi.on("session_shutdown", async () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		remindedDate = null;
	});

	// Test/demo command: simulate any time against the REAL Pi UI.
	// Usage: /reminder-check 02:30
	pi.registerCommand("reminder-check", {
		description: "Simulate a reminder check at HH:MM (e.g. /reminder-check 02:30)",
		handler: async (args, ctx) => {
			const match = (args || "").trim().match(/^(\d{1,2}):(\d{2})$/);
			if (!match) {
				ctx.ui.notify("Usage: /reminder-check HH:MM (e.g. /reminder-check 02:30)", "warning");
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
			// Clear today's dedup state so the command can demonstrate repeatedly.
			remindedDate = null;
			await checkAndNotify(ctx, simulated);
		},
	});
}

// --- Testing utilities ---

/** Override the clock (leave undefined to restore real time). */
export function setClock(fn?: () => Date): void {
	getNow = fn ?? (() => new Date());
}

/** Reset all state (for testing). */
export function resetState(): void {
	remindedDate = null;
	if (timer !== null) {
		clearInterval(timer);
		timer = null;
	}
}
