/**
 * write-test-files.ts
 *
 * Runs every reminder test case and writes two sets of JSON reports:
 *
 *   ../test/single-test/test_1.json …   one scenario per file: a single check
 *                                       with a single expectation
 *   ../test/batch-test/test_1.json …    several scenarios per file, run in
 *                                       order against shared state (e.g.
 *                                       wrap-around boundaries + in-window +
 *                                       dedup), with a pass/fail per step
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
	getWindow,
	isDefaultWindow,
	setWindow,
	NOW_OVERRIDE_ENV,
	STATE_ENV,
} from "./reminder";

const BASE_DIR = path.join(__dirname, "..", "test");
const SINGLE_DIR = path.join(BASE_DIR, "single-test");
const BATCH_DIR = path.join(BASE_DIR, "batch-test");
const PI_BIN = process.env.PI_BIN || "/Users/davidle/.pi/agent/bin/pi";
const EXTENSION = path.join(__dirname, "reminder.ts");
const RUN_LIVE = !process.argv.includes("--no-live");

type Category = "policy" | "ui" | "automatic" | "live-rpc" | "live-boot";

/** A single-test file: one check, one expectation. */
interface CaseResult {
	id?: number;
	name: string;
	category: Category;
	input: unknown;
	expected: unknown;
	actual: unknown;
	pass: boolean;
	details?: unknown;
}

/** One step of a batch, labeled with the scenario it exercises. */
interface BatchStep {
	scenario: string;
	/** What was run, e.g. the equivalent /bedtime-test command. */
	check: string;
	expected: unknown;
	actual: unknown;
	pass: boolean;
}

/** A batch-test file: several scenarios run in order against shared state. */
interface BatchResult {
	id?: number;
	name: string;
	category: Category;
	setup?: string;
	scenarios: string[];
	steps: BatchStep[];
	pass: boolean;
}

const singleResults: CaseResult[] = [];
const batchResults: BatchResult[] = [];

function recordSingle(r: CaseResult): void {
	singleResults.push(r);
}

function recordBatch(
	name: string,
	category: Category,
	steps: BatchStep[],
	setup?: string,
): void {
	batchResults.push({
		name,
		category,
		...(setup ? { setup } : {}),
		scenarios: [...new Set(steps.map((s) => s.scenario))],
		steps,
		pass: steps.every((s) => s.pass),
	});
}

function atTime(hour: number, minute: number = 0): Date {
	return new Date(2025, 0, 1, hour, minute);
}

/** Parse "YYYY-MM-DD HH:MM" as local time. */
function at(stamp: string): Date {
	const [, y, mo, d, h, mi] = stamp
		.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/)!
		.map(Number);
	return new Date(y, mo - 1, d, h, mi);
}

/** Clear dedup but keep the window, like the `reset` keyword on /bedtime-test. */
function clearDedup(): void {
	const custom = isDefaultWindow() ? null : getWindow();
	resetState();
	if (custom) setWindow(custom.start, custom.end);
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
// 1b. Batch policy cases — several scenarios per file, steps share dedup state
// ---------------------------------------------------------------------------

/** One shouldRemind check at `stamp`; `reset` clears dedup first. */
function policyStep(
	scenario: string,
	stamp: string,
	expected: boolean,
	reset = false,
): BatchStep {
	if (reset) clearDedup();
	const actual = shouldRemind(at(stamp));
	return {
		scenario,
		check: `/bedtime-test ${stamp}${reset ? " reset" : ""}`,
		expected,
		actual,
		pass: actual === expected,
	};
}

function batchPolicyCases(): void {
	// Default window: both boundaries, inside, dedup, then the next day.
	resetState();
	recordBatch("Default window 00:00–06:00: boundaries, in-window, dedup, next day", "policy", [
		policyStep("out of boundary", "2026-10-06 23:59", false),
		policyStep("boundary: start inclusive", "2026-10-07 00:00", true),
		policyStep("dedup: same day", "2026-10-07 03:00", false),
		policyStep("in boundary: last minute", "2026-10-07 05:59", true, true),
		policyStep("boundary: end exclusive", "2026-10-07 06:00", false, true),
		policyStep("next day resumes", "2026-10-08 01:00", true),
	]);

	// Wrap-around window: edges on both sides of midnight, plus dedup. Dedup is
	// per calendar day, so crossing midnight re-arms the reminder.
	resetState();
	setWindow(22 * 60, 2 * 60);
	recordBatch(
		"Wrap-around window 22:00–02:00: boundaries, in-window, dedup",
		"policy",
		[
			policyStep("wrap boundary: before start", "2026-10-06 21:59", false),
			policyStep("wrap boundary: start inclusive", "2026-10-06 22:00", true),
			policyStep("dedup: same evening", "2026-10-06 23:30", false),
			policyStep("wrap boundary: past midnight is a new calendar day", "2026-10-07 00:00", true),
			policyStep("dedup: after midnight", "2026-10-07 01:00", false),
			policyStep("in boundary: last minute", "2026-10-07 01:59", true, true),
			policyStep("wrap boundary: end exclusive", "2026-10-07 02:00", false, true),
			policyStep("out of boundary: midday", "2026-10-07 12:00", false, true),
			policyStep("in boundary: before midnight", "2026-10-07 23:59", true, true),
		],
		"/bedtime-test time 22:00 02:00",
	);

	// Multi-day dedup: every reminded date stays tracked; then a daytime sweep.
	resetState();
	recordBatch("Multi-day dedup and daytime sweep", "policy", [
		policyStep("in boundary: day 1", "2026-10-06 04:30", true),
		policyStep("next day resumes", "2026-10-07 05:00", true),
		policyStep("dedup: same day", "2026-10-07 05:30", false),
		policyStep("dedup: return to previous day", "2026-10-06 05:00", false),
		policyStep("reset re-arms the day", "2026-10-07 05:30", true, true),
		...Array.from({ length: 18 }, (_, i) =>
			policyStep(
				"out of boundary: daytime sweep",
				`2026-10-08 ${String(i + 6).padStart(2, "0")}:30`,
				false,
			),
		),
	]);
}

// ---------------------------------------------------------------------------
// 2a. Single UI cases — one popup / one set of notifications per file
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

	// Out of window → silent
	resetState();
	{
		const ctx = mockCtx(true);
		await checkAndNotify(ctx, atTime(14, 0));
		recordSingle({
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
// 2b. Batch UI cases — several interactions in one file, shared dedup state
// ---------------------------------------------------------------------------

/** One checkAndNotify at `stamp` answering `answer`; `reset` clears dedup first. */
async function uiStep(
	scenario: string,
	stamp: string,
	answer: boolean,
	expectPopup: boolean,
	reset = false,
): Promise<BatchStep> {
	if (reset) clearDedup();
	const ctx = mockCtx(answer);
	await checkAndNotify(ctx, at(stamp));
	const expected = { popup: expectPopup, notifications: expectPopup ? 2 : 0 };
	const actual = { popup: !!ctx.popup, notifications: ctx.notifications.length };
	return {
		scenario,
		check: `/bedtime-test ${stamp}${reset ? " reset" : ""} (answer ${answer ? "YES" : "NO"})`,
		expected,
		actual,
		pass: actual.popup === expected.popup && actual.notifications === expected.notifications,
	};
}

async function batchUiCases(): Promise<void> {
	resetState();
	recordBatch("UI flow: popup, dedup, daytime, next day", "ui", [
		await uiStep("in boundary: first trigger", "2025-01-01 02:30", true, true),
		await uiStep("dedup: repeat same day", "2025-01-01 02:35", true, false),
		await uiStep("out of boundary: daytime", "2025-01-01 14:00", true, false, true),
		await uiStep("next day resumes (answer NO)", "2025-01-02 05:59", false, true),
	]);

	resetState();
	setWindow(22 * 60, 2 * 60);
	recordBatch(
		"UI flow in wrap-around window 22:00–02:00: boundaries, in-window, dedup",
		"ui",
		[
			await uiStep("wrap boundary: before start", "2025-01-01 21:59", true, false),
			await uiStep("wrap boundary: start inclusive", "2025-01-01 22:00", true, true),
			await uiStep("dedup: same evening", "2025-01-01 23:45", true, false),
			await uiStep("in boundary: after midnight (answer NO)", "2025-01-02 01:59", false, true, true),
			await uiStep("wrap boundary: end exclusive", "2025-01-02 02:00", true, false, true),
		],
		"/bedtime-test time 22:00 02:00",
	);
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
// 4. Live Pi over RPC — one session, many scenarios → one batch file
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

type LiveExpect = "popup" | "silent" | "warning" | "window-set";

async function liveRpcCases(statePath: string): Promise<void> {
	const notifications: string[] = [];
	let dialogs = 0;
	let commandRegistered: boolean | null = null;
	const steps: BatchStep[] = [];

	const child = spawn(
		PI_BIN,
		["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--extension", EXTENSION, "--offline"],
		{ stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, [STATE_ENV]: statePath } },
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
	steps.push({
		scenario: "registration",
		check: "get_commands",
		expected: true,
		actual: commandRegistered,
		pass: commandRegistered === true,
	});

	async function liveStep(scenario: string, command: string, expect: LiveExpect) {
		const n0 = notifications.length;
		const d0 = dialogs;
		send({ type: "prompt", message: command });
		await wait(1800);
		const newN = notifications.slice(n0);
		const newD = dialogs - d0;
		let pass = false;
		if (expect === "popup") pass = newD === 1 && newN.length >= 1;
		else if (expect === "silent") pass = newD === 0 && newN.length === 0;
		else if (expect === "window-set") pass = newD === 0 && newN.some((m) => /window set to/.test(m));
		else pass = newD === 0 && newN.some((m) => /Usage|Invalid/.test(m));
		steps.push({
			scenario,
			check: command,
			expected: expect,
			actual: { dialogs: newD, notifications: newN },
			pass,
		});
	}

	await liveStep("in boundary: first trigger", "/bedtime-test 02:30 reset", "popup");
	await liveStep("dedup: repeat same day", "/bedtime-test 02:35", "silent");
	await liveStep("out of boundary: daytime", "/bedtime-test 14:00 reset", "silent");
	await liveStep("invalid input: hour", "/bedtime-test 25:00 reset", "warning");
	await liveStep("invalid input: format", "/bedtime-test abc reset", "warning");
	await liveStep("wrap window setup", "/bedtime-test time 22:00 02:00", "window-set");
	await liveStep("wrap boundary: start inclusive", "/bedtime-test 2026-10-06 22:00 reset", "popup");
	await liveStep("dedup: same evening", "/bedtime-test 2026-10-06 23:30", "silent");
	await liveStep("wrap boundary: end exclusive", "/bedtime-test 2026-10-07 02:00 reset", "silent");
	await liveStep("in boundary: after midnight", "/bedtime-test 2026-10-07 01:59 reset", "popup");

	child.kill("SIGTERM");
	recordBatch(
		"Live Pi RPC session: popup, dedup, daytime, invalid input, wrap window",
		"live-rpc",
		steps,
	);
}

// ---------------------------------------------------------------------------
// 5. Live Pi startup with a fake clock
// ---------------------------------------------------------------------------

/** Start a real Pi at `fakeTime`; resolves with whether the reminder fired. */
function liveBootCase(
	fakeTime: string,
	expectReminder: boolean,
	opts: { statePath: string; sessionSuffix: string },
): Promise<boolean> {
	return new Promise((resolve) => {
		let reminded = false;
		let done = false;
		const env: Record<string, string> = {
			...process.env,
			[NOW_OVERRIDE_ENV]: fakeTime,
			[STATE_ENV]: opts.statePath,
		} as Record<string, string>;
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
				path.join(os.tmpdir(), "pireminder-report-" + opts.sessionSuffix),
			],
			{ stdio: ["pipe", "pipe", "pipe"], env },
		);
		const finish = () => {
			if (done) return;
			done = true;
			child.kill("SIGTERM");
			resolve(reminded);
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

/** Single boot case with its own fresh state file. */
async function bootSingle(fakeTime: string, expectReminder: boolean, suffix: string): Promise<void> {
	const statePath = path.join(os.tmpdir(), `pireminder-boot-${suffix}-${Date.now()}.json`);
	try {
		fs.rmSync(statePath, { force: true });
		const reminded = await liveBootCase(fakeTime, expectReminder, { statePath, sessionSuffix: suffix });
		recordSingle({
			name: `Live Pi startup: PIREMINDER_NOW=${fakeTime} ${expectReminder ? "reminds" : "stays silent"}`,
			category: "live-boot",
			input: { PIREMINDER_NOW: fakeTime },
			expected: expectReminder ? "reminder" : "silent",
			actual: reminded ? "reminder" : "silent",
			pass: reminded === expectReminder,
		});
	} finally {
		fs.rmSync(statePath, { force: true });
	}
}

/**
 * Separate Pi processes sharing one state file pre-seeded with a wrap-around
 * window: checks the persisted window boundary and cross-session dedup.
 */
async function bootBatch(): Promise<void> {
	const statePath = path.join(os.tmpdir(), `pireminder-persist-${Date.now()}.json`);
	const bootStep = async (
		scenario: string,
		session: number,
		fakeTime: string,
		expectReminder: boolean,
	): Promise<BatchStep> => {
		const reminded = await liveBootCase(fakeTime, expectReminder, {
			statePath,
			sessionSuffix: `persist-${session}`,
		});
		return {
			scenario,
			check: `${NOW_OVERRIDE_ENV}=${fakeTime} pi (session ${session})`,
			expected: expectReminder ? "reminder" : "silent",
			actual: reminded ? "reminder" : "silent",
			pass: reminded === expectReminder,
		};
	};
	try {
		fs.writeFileSync(
			statePath,
			JSON.stringify({ remindedDates: [], enabled: true, windowStart: 22 * 60, windowEnd: 2 * 60 }) + "\n",
		);
		recordBatch(
			"Live Pi startup across sessions in wrap-around window 22:00–02:00",
			"live-boot",
			[
				await bootStep("wrap boundary: before start", 1, "21:59", false),
				await bootStep("wrap boundary: start inclusive", 2, "22:00", true),
				await bootStep("dedup: next session same night (persisted)", 3, "23:30", false),
			],
			"state file seeded with window 22:00–02:00",
		);
	} finally {
		fs.rmSync(statePath, { force: true });
	}
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function writeResults<T extends { name: string; category: Category; pass: boolean }>(
	dir: string,
	results: T[],
	label: string,
	describe: (r: T) => Record<string, unknown> = () => ({}),
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
					...describe(r),
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
	// setWindow persists, so in-process cases write to a scratch state file
	// instead of the real ~/.pi/agent/pireminder-state.json.
	const scratchState = path.join(os.tmpdir(), `pireminder-report-${Date.now()}.json`);
	const originalState = process.env[STATE_ENV];
	process.env[STATE_ENV] = scratchState;
	try {
		singlePolicyCases();
		batchPolicyCases();
		await singleUiCases();
		await batchUiCases();
		await singleAutomaticCases();
	} finally {
		resetState();
		if (originalState === undefined) delete process.env[STATE_ENV];
		else process.env[STATE_ENV] = originalState;
		fs.rmSync(scratchState, { force: true });
	}

	if (RUN_LIVE) {
		const rpcState = path.join(os.tmpdir(), `pireminder-rpc-${Date.now()}.json`);
		try {
			await liveRpcCases(rpcState);
		} catch (e) {
			recordBatch("Live Pi RPC session", "live-rpc", [
				{ scenario: "spawn", check: "pi --mode rpc", expected: "runs", actual: String(e), pass: false },
			]);
		} finally {
			fs.rmSync(rpcState, { force: true });
		}
		await bootSingle("02:30", true, "a");
		await bootSingle("06:00", false, "b");
		await bootBatch();
	}

	writeResults(SINGLE_DIR, singleResults, "single-test");
	writeResults(BATCH_DIR, batchResults, "batch-test", (r) => ({
		scenarios: r.scenarios,
		steps: `${r.steps.filter((s) => s.pass).length}/${r.steps.length} passed`,
	}));
	for (const r of batchResults) {
		for (const s of r.steps.filter((s) => !s.pass)) {
			console.log(
				`  FAIL ${r.name} → [${s.scenario}] ${s.check}: expected ${JSON.stringify(s.expected)}, got ${JSON.stringify(s.actual)}`,
			);
		}
	}

	const totalFailed = singleResults.filter((r) => !r.pass).length + batchResults.filter((r) => !r.pass).length;
	if (totalFailed > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
