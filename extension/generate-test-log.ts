/**
 * generate-test-log.ts
 *
 * Runs the reminder policy through realistic scenarios and writes a
 * machine-readable audit log to test.json. Each entry records the
 * simulated time, whether the time is in the reminder window, whether
 * the user had already been reminded that day, and exactly what the
 * Pi UI would show (notifications + yes/no popup + answer).
 *
 * Run: jiti generate-log-cli.ts   (or: npm run generate-log)
 */

import {
	checkAndNotify,
	resetState,
	isInWindow,
	getRemindedDate,
} from "./reminder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PopupRecord {
	title: string;
	message: string;
	answer: "yes" | "no";
}

interface CheckRecord {
	simulatedTime: string;
	localTime: string;
	inWindow: boolean;
	alreadyRemindedToday: boolean;
	remindedDateBefore: string | null;
	outcome: "popup+notify" | "silent";
	notifications: string[];
	popup: PopupRecord | null;
	remindedDateAfter: string | null;
}

interface Scenario {
	name: string;
	description: string;
	checks: CheckRecord[];
}

// ---------------------------------------------------------------------------
// Recording fake Pi UI
// ---------------------------------------------------------------------------

function makeRecordingCtx(answer: boolean) {
	const notifications: string[] = [];
	let pendingPopup: { title: string; message: string } | null = null;

	return {
		notifications,
		get pendingPopup() {
			return pendingPopup;
		},
		ui: {
			notify(msg: string) {
				notifications.push(msg);
			},
			async confirm(title: string, message: string) {
				pendingPopup = { title, message };
				return answer;
			},
		},
	};
}

/** Run one check at `time` and record the full interaction. */
async function runCheck(time: Date, answer: boolean): Promise<CheckRecord> {
	const ctx = makeRecordingCtx(answer);
	const remindedDateBefore = getRemindedDate();
	const alreadyRemindedToday = remindedDateBefore === time.toDateString();

	await checkAndNotify(ctx, time);

	const popup = ctx.pendingPopup
		? {
				title: ctx.pendingPopup.title,
				message: ctx.pendingPopup.message,
				answer: (answer ? "yes" : "no") as "yes" | "no",
			}
		: null;

	return {
		simulatedTime: time.toISOString(),
		localTime: `${String(time.getHours()).padStart(2, "0")}:${String(
			time.getMinutes(),
		).padStart(2, "0")}`,
		inWindow: isInWindow(time),
		alreadyRemindedToday,
		remindedDateBefore,
		outcome: popup ? "popup+notify" : "silent",
		notifications: ctx.notifications,
		popup,
		remindedDateAfter: getRemindedDate(),
	};
}

// ---------------------------------------------------------------------------
// Build the log
// ---------------------------------------------------------------------------

export async function buildLog() {
	const scenarios: Scenario[] = [];

	// Scenario 1: first trigger at 00:00, answers YES, keeps coding.
	resetState();
	scenarios.push({
		name: "First trigger at 00:00, user answers YES, keeps coding",
		description:
			"Shows one notification + yes/no popup on first trigger; all later in-window checks are silent.",
		checks: [
			await runCheck(new Date(2025, 0, 1, 0, 0), true),
			await runCheck(new Date(2025, 0, 1, 0, 5), true),
			await runCheck(new Date(2025, 0, 1, 3, 0), true),
			await runCheck(new Date(2025, 0, 1, 5, 59), true),
		],
	});

	// Scenario 2: first trigger at 05:59, answers NO.
	resetState();
	scenarios.push({
		name: "First trigger at 05:59, user answers NO",
		description:
			"A 'no' answer still suppresses further reminders: the advice was delivered.",
		checks: [
			await runCheck(new Date(2025, 0, 1, 5, 59), false),
			await runCheck(new Date(2025, 0, 1, 5, 59), false),
		],
	});

	// Scenario 3: boundary times across the whole day.
	resetState();
	scenarios.push({
		name: "Boundary sweep: 23:59, 00:00, 05:59, 06:00",
		description:
			"Confirms inclusive start (00:00), exclusive end (06:00), and no daytime reminders.",
		checks: [
			await runCheck(new Date(2025, 0, 1, 23, 59), true),
			await runCheck(new Date(2025, 0, 1, 0, 0), true),
			await runCheck(new Date(2025, 0, 1, 5, 59), true),
			await runCheck(new Date(2025, 0, 1, 6, 0), true),
		],
	});

	// Scenario 4: no reminders 06:00–23:59.
	resetState();
	const daytimeChecks: CheckRecord[] = [];
	for (let h = 6; h <= 23; h++) {
		daytimeChecks.push(await runCheck(new Date(2025, 0, 1, h, 30), true));
	}
	scenarios.push({
		name: "No reminders from 06:00 to 23:59",
		description: "Every hour of the daytime is silent and no popup is shown.",
		checks: daytimeChecks,
	});

	// Scenario 5: next day resets.
	resetState();
	scenarios.push({
		name: "Next calendar day resumes reminders",
		description:
			"After midnight the dedup resets, so the next window reminds again.",
		checks: [
			await runCheck(new Date(2025, 0, 1, 2, 0), true),
			await runCheck(new Date(2025, 0, 2, 1, 0), true),
		],
	});

	return {
		generatedAt: new Date().toISOString(),
		systemTime: new Date().toString(),
		pi: {
			provider: process.env.PI_PROVIDER ?? null,
			model: process.env.PI_MODEL ?? null,
			sessionId: process.env.PI_SESSION_ID ?? null,
			codingAgent: process.env.PI_CODING_AGENT ?? null,
		},
		policy: {
			window: "00:00 (inclusive) to 06:00 (exclusive)",
			dedup: "once per calendar day (yes or no acknowledgment both count)",
			daytime: "06:00-23:59 never reminds",
		},
		answers: {
			notifyOnFirstTrigger: true,
			popupOnFirstTrigger: "yes/no acknowledgment",
			repeatTrigger: "silent (no notify, no popup)",
		},
		scenarios,
	};
}

export type ReminderLog = Awaited<ReturnType<typeof buildLog>>;
