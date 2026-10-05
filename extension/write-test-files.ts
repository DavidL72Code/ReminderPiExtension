/**
 * write-test-files.ts
 *
 * Runs every reminder test case and writes two sets of JSON reports:
 *
 *   ../test/single-test/test_1.json …   individual checks (one scenario each)
 *   ../test/batch-test/test_1.json …    multi-scenario batches (sweeps, dedup
 *                                       chains, multi-day tracking, etc.)
 *
 * Each directory gets its own summary.json.
 *
 * Five kinds of cases are included:
 *   - policy    : pure time-policy checks (simulated Date)
 *   - ui        : notification + yes/no popup flow with a mock Pi UI
 *   - automatic : PIREMINDER_NOW override on the automatic path
 *   - live-rpc  : a REAL Pi process driven over RPC
 *   - live-boot : a REAL Pi process started with a fake clock
 *
 * Run: jiti write-test-files.ts        (or: npm run test:report)
 *      jiti write-test-files.ts --no-live   (skip spawning Pi)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import * as readline from "readline";
import {
	shouldRemind,
	checkAndNotify,
	resetState,
	setClock,
	NOW_OVERRIDE_ENV,
} from "./reminder";

const BASE_DIR = path.join(__dirname, "..", "test");
const SINGLE_DIR = path.join(BASE_DIR, "single-test");
const BATCH_DIR = path.join(BASE_DIR, "batch-test");
const PI_BIN = process.env.PI_BIN || "/Users/davidle/.pi/agent/bin/pi";
const EXTENSION = path.join(__dirname, "reminder.ts");
const RUN_LIVE = !process.argv.includes("--no-live");

interface CaseResult {
	id?: number;
	name: string;
	category: "policy" | "ui" | "automatic" | "live-rpc" | "live-boot";
	input: unknown;
	expected: unknown;
	actual: unknown;
	pass: boolean;
	details?: unknown;
}

const singleResults: CaseResult[] = [];
const batchResults: CaseResult[] = [];

function recordSingle(r: Omit<CaseResult, "id">): void {
	singleResults.push(r);
}
function recordBatch(r: Omit<CaseResult, "id">): void {
	batchResults.push(r);
}

function atTime(hour: number, minute: number = 0): Date {
	return new Date(2025, 0, 1, hour, minute);
}

function mockCtx(answer: boolean) {
	const notifications: string[] = [];
	let popup: { title: string; message: string } | null = null;
	return {
		notifications,
		get popup() {
			return popup;
		},
		ui: {
			notify(msg: string) {
				notifications.push(msg);
			},
			async confirm(title: string, message: string) {
				popup = { title, message };
				return answer;
			},
		},
	};
}

// ---------------------------------------------------------------------------
// 1a. Single policy cases  — one simulated Date, one boolean expectation
// ---------------------------------------------------------------------------

function singlePolicyCases(): void {
	const cases: Array<{ name: string; time: Date; expected: boolean }> = [
		{ name: "23:59 does not remind (outside window)", time: atTime(23, 59), expected: false },
		{ name: "00:00 reminds (window start, inclusive)", time: atTime(0, 0), expected: true },
		{ name: "05:59 reminds (inside window)", time: atTime(5, 59), expected: true },
		{ name: "06:00 does not remind (window end, exclusive)", time: atTime(6, 0), expected: false },
	];
	for (const c of cases) {
		resetState();
		const actual = shouldRemind(c.time);
		recordSingle({
			name: c.name,
			category: "policy",
			input: { now: c.time.toISOString(), localTime: `${String(c.time.getHours()).padStart(2, "0")}:${String(c.time.getMinutes()).padStart(2, "0")}` },
			expected: c.expected,
			actual,
			pass: actual === c.expected,
		});
	}
}

// ---------------------------------------------------------------------------
// 1b. Batch policy cases — multiple checks grouped into one scenario
// ---------------------------------------------------------------------------

function batchPolicyCases(): void {
	// Already reminded today → no duplicate
	resetState();
	const first = shouldRemind(atTime(3, 0));
	const second = shouldRemind(atTime(4, 0));
	recordBatch({
		name: "Already reminded today → no duplicate",
		category: "policy",
		input: { times: ["03:00", "04:00"], sameDay: true },
		expected: { first: true, second: false },
		actual: { first, second },
		pass: first === true && second === false,
	});

	// Next calendar day resets
	resetState();
	const day1 = shouldRemind(atTime(3, 0));
	const day1b = shouldRemind(atTime(4, 0));
	const day2 = shouldRemind(new Date(2025, 0, 2, 1, 0));
	recordBatch({
		name: "Next calendar day resumes reminders",
		category: "policy",
		input: { day1: "2025-01-01 03:00/04:00", day2: "2025-01-02 01:00" },
		expected: { day1: true, day1Repeat: false, day2: true },
		actual: { day1, day1Repeat: day1b, day2 },
		pass: day1 === true && day1b === false && day2 === true,
	});

	// Daytime sweep 06:00–23:59 → all silent
	resetState();
	const sweep: Record<string, boolean> = {};
	let sweepPass = true;
	for (let h = 6; h <= 23; h++) {
		resetState();
		const r = shouldRemind(atTime(h, 30));
		sweep[`${String(h).padStart(2, "0")}:30`] = r;
		if (r !== false) sweepPass = false;
	}
	recordBatch({
		name: "No reminders from 06:00 to 23:59 (18 checks)",
		category: "policy",
		input: { hours: "06:30 … 23:30" },
		expected: "all false",
		actual: sweep,
		pass: sweepPass,
	});

	// Multi-day explicit date tracking (simulates /bedtime-test with dates)
	resetState();
	const oct6_430 = shouldRemind(new Date(2026, 9, 6, 4, 30));
	const oct7_500 = shouldRemind(new Date(2026, 9, 7, 5, 0));
	const oct7_530_no_reset = shouldRemind(new Date(2026, 9, 7, 5, 30));
	resetState();
	const oct7_530_reset = shouldRemind(new Date(2026, 9, 7, 5, 30));
	recordBatch({
		name: "Multi-day date tracking: Oct 6 → Oct 7 → Oct 7 silent → Oct 7 reset",
		category: "policy",
		input: {
			checks: [
				"2026-10-06 04:30",
				"2026-10-07 05:00",
				"2026-10-07 05:30 (no reset)",
				"2026-10-07 05:30 (reset)",
			],
		},
		expected: {
			oct6_430: true,
			oct7_500: true,
			oct7_530_no_reset: false,
			oct7_530_reset: true,
		},
		actual: { oct6_430, oct7_500, oct7_530_no_reset, oct7_530_reset },
		pass:
			oct6_430 === true &&
			oct7_500 === true &&
			oct7_530_no_reset === false &&
			oct7_530_reset === true,
	});

	// Return-to-previous-day dedup: two different dates both stay tracked
	resetState();
	const dayA_1 = shouldRemind(new Date(2026, 9, 6, 4, 30));  // Oct 6
	const dayB_1 = shouldRemind(new Date(2026, 9, 7, 4, 30));  // Oct 7
	const dayA_2 = shouldRemind(new Date(2026, 9, 6, 5, 0));   // back to Oct 6
	recordBatch({
		name: "Return to previous day suppressed by multi-date dedup Set",
		category: "policy",
		input: {
			sequence: ["2026-10-06 04:30", "2026-10-07 04:30", "2026-10-06 05:00"],
		},
		expected: { dayA_1: true, dayB_1: true, dayA_2: false },
		actual: { dayA_1, dayB_1, dayA_2 },
		pass: dayA_1 === true && dayB_1 === true && dayA_2 === false,
	});
}

// ---------------------------------------------------------------------------
// 2. Single UI cases — one popup / one set of notifications per file
// ---------------------------------------------------------------------------

async function singleUiCases(): Promise<void> {
	// First trigger answers YES
	resetState();
	{
		const ctx = mockCtx(true);
		await checkAndNotify(ctx, atTime(2, 30));
		recordSingle({
			name: "First trigger at 02:30, answer YES",
			category: "ui",
			input: { now: "02:30", answer: "yes" },
			expected: { popup: true, notifications: 2 },
			actual: { popup: !!ctx.popup, notifications: ctx.notifications },
			pass: !!ctx.popup && ctx.notifications.length === 2,
			details: { popup: ctx.popup },
		});
	}

	// First trigger answers NO
	resetState();
	{
		const ctx = mockCtx(false);
		await checkAndNotify(ctx, atTime(5, 59));
		recordSingle({
			name: "First trigger at 05:59, answer NO",
			category: "ui",
			input: { now: "05:59", answer: "no" },
			expected: { popup: true, notifications: 2 },
			actual: { popup: !!ctx.popup, notifications: ctx.notifications },
			pass: !!ctx.popup && ctx.notifications.length === 2,
			details: { popup: ctx.popup },
		});
	}
}

// ---------------------------------------------------------------------------
// 2b. Batch UI cases — multiple interactions grouped
// ---------------------------------------------------------------------------

async function batchUiCases(): Promise<void> {
	// Repeat same day → silent
	resetState();
	{
		const first = mockCtx(true);
		await checkAndNotify(first, atTime(2, 30));
		const repeat = mockCtx(true);
		await checkAndNotify(repeat, atTime(2, 35));
		recordBatch({
			name: "Repeat same day is silent (no popup, no notify)",
			category: "ui",
			input: { first: "02:30", repeat: "02:35" },
			expected: { repeatPopup: false, repeatNotifications: 0 },
			actual: { repeatPopup: !!repeat.popup, repeatNotifications: repeat.notifications.length },
			pass: !repeat.popup && repeat.notifications.length === 0,
		});
	}

	// Out of window → silent
	resetState();
	{
		const ctx = mockCtx(true);
		await checkAndNotify(ctx, atTime(14, 0));
		recordBatch({
			name: "Daytime 14:00 is silent",
			category: "ui",
			input: { now: "14:00" },
			expected: { popup: false, notifications: 0 },
			actual: { popup: !!ctx.popup, notifications: ctx.notifications.length },
			pass: !ctx.popup && ctx.notifications.length === 0,
		});
	}
}

// ---------------------------------------------------------------------------
// 3. Single automatic cases
// ---------------------------------------------------------------------------

async function singleAutomaticCases(): Promise<void> {
	const original = process.env[NOW_OVERRIDE_ENV];
	try {
		// 02:30 → remind
		process.env[NOW_OVERRIDE_ENV] = "02:30";
		setClock();
		resetState();
		const ctx = mockCtx(true);
		await checkAndNotify(ctx);
		recordSingle({
			name: "PIREMINDER_NOW=02:30 fires the automatic reminder",
			category: "automatic",
			input: { PIREMINDER_NOW: "02:30" },
			expected: { popup: true },
			actual: { popup: !!ctx.popup },
			pass: !!ctx.popup,
		});

		// 14:00 → silent
		process.env[NOW_OVERRIDE_ENV] = "14:00";
		setClock();
		resetState();
		const ctx2 = mockCtx(true);
		await checkAndNotify(ctx2);
		recordSingle({
			name: "PIREMINDER_NOW=14:00 stays silent",
			category: "automatic",
			input: { PIREMINDER_NOW: "14:00" },
			expected: { popup: false },
			actual: { popup: !!ctx2.popup },
			pass: !ctx2.popup,
		});
	} finally {
		if (original === undefined) delete process.env[NOW_OVERRIDE_ENV];
		else process.env[NOW_OVERRIDE_ENV] = original;
		setClock();
	}
}

// ---------------------------------------------------------------------------
// 4. Live Pi over RPC
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function liveRpcCases(): Promise<void> {
	const notifications: string[] = [];
	let dialogs = 0;
	let commandRegistered: boolean | null = null;

	const child = spawn(
		PI_BIN,
		["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--extension", EXTENSION, "--offline"],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");

	readline.createInterface({ input: child.stdout }).on("line", (line) => {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.type === "response" && msg.command === "get_commands") {
			const names = (msg.data?.commands || []).map((c: any) => c.name);
			commandRegistered = names.includes("bedtime-test");
		} else if (msg.type === "extension_ui_request") {
			if (msg.method === "notify") notifications.push(msg.message);
			else if (msg.method === "confirm") {
				dialogs++;
				send({ type: "extension_ui_response", id: msg.id, confirmed: true });
			}
		}
	});
	child.stderr.on("data", () => {});

	await wait(900);
	send({ type: "get_commands" });
	for (let i = 0; i < 50 && commandRegistered === null; i++) {
		await wait(100);
	}
	recordSingle({
		name: "Live Pi: bedtime-test command registered",
		category: "live-rpc",
		input: "get_commands",
		expected: true,
		actual: commandRegistered,
		pass: commandRegistered === true,
	});

	async function liveCase(name: string, command: string, expect: "popup" | "silent" | "warning") {
		const n0 = notifications.length;
		const d0 = dialogs;
		send({ type: "prompt", message: command });
		await wait(1800);
		const newN = notifications.slice(n0);
		const newD = dialogs - d0;
		let pass = false;
		if (expect === "popup") pass = newD === 1 && newN.length >= 1;
		else if (expect === "silent") pass = newD === 0 && newN.length === 0;
		else pass = newD === 0 && newN.some((m) => /Usage|Invalid/.test(m));
		recordSingle({
			name,
			category: "live-rpc",
			input: { command },
			expected: expect,
			actual: { dialogs: newD, notifications: newN },
			pass,
		});
	}

	await liveCase(
		"Live Pi: first trigger (reset) shows popup + notify",
		"/bedtime-test 02:30 reset",
		"popup",
	);
	await liveCase("Live Pi: repeat same day is silent", "/bedtime-test 02:35", "silent");
	await liveCase(
		"Live Pi: daytime 14:00 is silent",
		"/bedtime-test 14:00 reset",
		"silent",
	);
	await liveCase(
		"Live Pi: invalid hour 25:00 warns",
		"/bedtime-test 25:00 reset",
		"warning",
	);
	await liveCase(
		"Live Pi: invalid format 'abc' warns",
		"/bedtime-test abc reset",
		"warning",
	);

	child.kill("SIGTERM");
}

// ---------------------------------------------------------------------------
// 5. Live Pi startup with a fake clock
// ---------------------------------------------------------------------------

function liveBootCase(
	fakeTime: string,
	expectReminder: boolean,
	opts: { statePath?: string; sessionSuffix?: string; name?: string } = {},
): Promise<void> {
	return new Promise((resolve) => {
		let reminded = false;
		let done = false;
		const suffix = (opts.sessionSuffix ?? fakeTime).replace(/[:]/g, "");
		const env: Record<string, string> = { ...process.env, PIREMINDER_NOW: fakeTime } as Record<string, string>;
		if (opts.statePath) env.PIREMINDER_STATE = opts.statePath;
		const child = spawn(
			PI_BIN,
			[
				"--mode",
				"rpc",
				"--no-tools",
				"--no-extensions",
				"--extension",
				EXTENSION,
				"--offline",
				"--session-dir",
				path.join(os.tmpdir(), "pireminder-report-" + suffix),
			],
			{ stdio: ["pipe", "pipe", "pipe"], env },
		);
		const finish = () => {
			if (done) return;
			done = true;
			recordSingle({
				name:
					opts.name ??
					`Live Pi startup: PIREMINDER_NOW=${fakeTime} ${
						expectReminder ? "reminds" : "stays silent"
					}`,
				category: "live-boot",
				input: { PIREMINDER_NOW: fakeTime,
					...(opts.statePath ? { sharedStateFile: true } : {}) },
				expected: expectReminder ? "reminder" : "silent",
				actual: reminded ? "reminder" : "silent",
				pass: reminded === expectReminder,
			});
			child.kill("SIGTERM");
			resolve();
		};
		readline.createInterface({ input: child.stdout }).on("line", (line) => {
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (msg.type === "extension_ui_request" && msg.method === "confirm") {
				reminded = true;
				child.stdin.write(
					JSON.stringify({ type: "extension_ui_response", id: msg.id, confirmed: true }) + "\n",
				);
				setTimeout(finish, 600);
			}
		});
		child.stderr.on("data", () => {});
		setTimeout(finish, expectReminder ? 12000 : 8000);
	});
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function writeResults(
	dir: string,
	results: CaseResult[],
	label: string,
): void {
	fs.mkdirSync(dir, { recursive: true });
	// Remove stale test_N.json files from previous runs.
	for (const f of fs.readdirSync(dir)) {
		if (/^test_\d+\.json$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
	}
	results.forEach((r, i) => {
		const file = { id: i + 1, ...r };
		fs.writeFileSync(
			path.join(dir, `test_${i + 1}.json`),
			JSON.stringify(file, null, 2) + "\n",
		);
	});

	const passed = results.filter((r) => r.pass).length;
	const failed = results.length - passed;
	fs.writeFileSync(
		path.join(dir, "summary.json"),
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				systemTime: new Date().toString(),
				pi: {
					provider: process.env.PI_PROVIDER ?? null,
					model: process.env.PI_MODEL ?? null,
					sessionId: process.env.PI_SESSION_ID ?? null,
				},
				totals: { cases: results.length, passed, failed },
				cases: results.map((r, i) => ({
					file: `test_${i + 1}.json`,
					name: r.name,
					category: r.category,
					pass: r.pass,
				})),
			},
			null,
			2,
		) + "\n",
	);

	for (const [i, r] of results.entries()) {
		console.log(`test_${i + 1}.json  [${r.pass ? "PASS" : "FAIL"}] (${r.category}) ${r.name}`);
	}
	console.log(`${passed}/${results.length} passed → ${dir}  (${label})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	singlePolicyCases();
	batchPolicyCases();
	await singleUiCases();
	await batchUiCases();
	await singleAutomaticCases();

	if (RUN_LIVE) {
		try {
			await liveRpcCases();
		} catch (e) {
			recordSingle({
				name: "Live Pi RPC (spawn)",
				category: "live-rpc",
				input: "spawn pi --mode rpc",
				expected: "runs",
				actual: String(e),
				pass: false,
			});
		}
		// Standalone boot cases use isolated state so a prior run's dedup does
		// not make the 02:30 reminder silent.
		const bootA = path.join(os.tmpdir(), `pireminder-boot-a-${Date.now()}.json`);
		const bootB = path.join(os.tmpdir(), `pireminder-boot-b-${Date.now()}.json`);
		try {
			fs.rmSync(bootA, { force: true });
			fs.rmSync(bootB, { force: true });
			await liveBootCase("02:30", true, { sessionSuffix: "a", statePath: bootA });
			await liveBootCase("06:00", false, { sessionSuffix: "b", statePath: bootB });
		} finally {
			fs.rmSync(bootA, { force: true });
			fs.rmSync(bootB, { force: true });
		}

		// Cross-session persistence: two separate Pi processes sharing one
		// state file. The first reminds; the second stays silent.
		const sharedState = path.join(os.tmpdir(), `pireminder-persist-${Date.now()}.json`);
		try {
			fs.rmSync(sharedState, { force: true });
			await liveBootCase("02:30", true, {
				statePath: sharedState,
				sessionSuffix: "persist-1",
				name: "Live Pi: session 1 on a night reminds (writes state)",
			});
			await liveBootCase("02:30", false, {
				statePath: sharedState,
				sessionSuffix: "persist-2",
				name: "Live Pi: session 2 same night is silent (persistent dedup)",
			});
		} finally {
			fs.rmSync(sharedState, { force: true });
		}
	}

	writeResults(SINGLE_DIR, singleResults, "single-test");
	writeResults(BATCH_DIR, batchResults, "batch-test");

	const totalFailed = singleResults.filter((r) => !r.pass).length + batchResults.filter((r) => !r.pass).length;
	if (totalFailed > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
