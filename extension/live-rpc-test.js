#!/usr/bin/env node
/**
 * live-rpc-test.js
 *
 * Drives a REAL Pi process in RPC mode to prove the extension works in the
 * live environment. It runs a sequence of success and failure cases and
 * reports pass/fail for each.
 *
 * Cases:
 *   1. get_commands           → /bedtime-test is registered
 *   2. /bedtime-test 4:30 reset     → first trigger: notify + yes/no popup
 *   3. /bedtime-test 4:35           → repeat same day: silent
 *   4. /bedtime-test 14:00 reset    → daytime (out of window): silent
 *   5. /bedtime-test 25:00 reset    → invalid hour: warning notification
 *   6. /bedtime-test abc  reset     → invalid format: warning notification
 *   7. /bedtime-test off, status, on → persisted toggle notifications
 *   8. /bedtime-test time …         → default/custom window notifications
 *   9. custom window behavior       → fires once inside, silent after/outside
 *
 * Success cases (2) and failure cases (3–6) are all verified.
 *
 * Usage: node live-rpc-test.js
 */

const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const os = require("os");

const PI_BIN = process.env.PI_BIN || "/Users/davidle/.pi/agent/bin/pi";
const EXTENSION = path.join(__dirname, "reminder.ts");
// Isolate persistence so /bedtime-test off never touches the real user state.
const STATE_FILE = path.join(os.tmpdir(), `pireminder-live-${process.pid}.json`);

const notifications = [];
const dialogs = [];
const transcriptMessages = [];
const results = [];
let commandRegistered = null;

const child = spawn(
	PI_BIN,
	[
		"--mode",
		"rpc",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--extension",
		EXTENSION,
		"--offline",
	],
	{
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PIREMINDER_STATE: STATE_FILE },
	},
);

function send(obj) {
	child.stdin.write(JSON.stringify(obj) + "\n");
}

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

readline.createInterface({ input: child.stdout }).on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}

	if (msg.type === "response" && msg.command === "get_commands") {
		const names = (msg.data?.commands || []).map((c) => c.name);
		const hasCommand = names.includes("bedtime-test");
		commandRegistered = hasCommand;
		console.log(
			`[command registered] get_commands → /bedtime-test: ${hasCommand}`,
		);
		results.push({
			label: "command registered",
			command: "get_commands (via /bedtime-test)",
			expect: "bedtime-test present",
			observed: `bedtime-test=${hasCommand}`,
			pass: commandRegistered === true,
		});
		return;
	}

	if (msg.type === "response" && msg.command === "get_messages") {
		transcriptMessages.length = 0;
		for (const m of msg.data?.messages || []) transcriptMessages.push(m);
		return;
	}

	if (msg.type === "extension_ui_request") {
		if (msg.method === "notify") {
			notifications.push(msg.message);
			console.log(`      notify(${msg.notifyType}): ${msg.message}`);
		} else if (msg.method === "confirm") {
			dialogs.push({ title: msg.title, message: msg.message });
			console.log(`      confirm [${msg.title}]: ${msg.message}`);
			console.log("      → answering: confirmed=true");
			send({ type: "extension_ui_response", id: msg.id, confirmed: true });
		}
	}
});

child.stderr.on("data", (d) => {
	const s = d.toString().trim();
	if (s && process.env.DEBUG) console.error("[pi stderr]", s);
});

/** Snapshot current UI counts. */
function snapshot() {
	return { n: notifications.length, d: dialogs.length };
}

/** Run one prompt and evaluate the UI delta against `expect`. */
async function runCase(label, command, expect, needle) {
	const before = snapshot();
	console.log(`\n[${label}] ${command}`);
	send({ type: "prompt", message: command });
	await wait(1800);

	const newNotifies = notifications.slice(before.n);
	const newDialogs = dialogs.slice(before.d);
	let pass = false;
	let observed = "";

	if (expect === "popup+notify") {
		pass = newDialogs.length === 1 && newNotifies.length >= 1;
		observed = `dialogs=${newDialogs.length} notifications=${newNotifies.length}`;
	} else if (expect === "notify") {
		const matched = needle ? newNotifies.some((m) => m.includes(needle)) : true;
		pass = newDialogs.length === 0 && newNotifies.length >= 1 && matched;
		observed = `dialogs=${newDialogs.length} notifications=${newNotifies.length} match=${matched}`;
	} else if (expect === "silent") {
		pass = newDialogs.length === 0 && newNotifies.length === 0;
		observed = `dialogs=${newDialogs.length} notifications=${newNotifies.length}`;
	} else if (expect === "warning") {
		const isWarning =
			newNotifies.length >= 1 &&
			newNotifies.some((m) => /Usage|Invalid/.test(m));
		pass = newDialogs.length === 0 && isWarning;
		observed = `dialogs=${newDialogs.length} notifications=${newNotifies.length} warning=${isWarning}`;
	}

	results.push({ label, command, expect, observed, pass });
	console.log(`      expected=${expect} observed=${observed} → ${pass ? "PASS" : "FAIL"}`);
	return pass;
}

async function main() {
	await wait(900);

	// Case 1: command registration
	console.log("[command registered] get_commands");
	send({ type: "get_commands" });
	await wait(600);

	await runCase("first trigger (reset)", "/bedtime-test 4:30 reset", "popup+notify");
	await runCase("repeat same day", "/bedtime-test 4:35", "silent");
	await runCase("daytime out-of-window", "/bedtime-test 14:00 reset", "silent");
	await runCase("invalid hour", "/bedtime-test 25:00 reset", "warning");
	await runCase("invalid format", "/bedtime-test abc reset", "warning");
	await runCase("disable reminders", "/bedtime-test off", "notify", "disabled");
	await runCase("status while off", "/bedtime-test status", "notify", "currently off");
	await runCase("manual check while off", "/bedtime-test 4:30 reset", "popup+notify");
	await runCase("enable reminders", "/bedtime-test on", "notify", "enabled");
	await runCase("status while on", "/bedtime-test status", "notify", "currently on");
	await runCase(
		"bare command shows menu",
		"/bedtime-test",
		"notify",
		"available commands",
	);
	await runCase(
		"run in-extension self-test",
		"/bedtime-test run_test",
		"notify",
		"Self-test passed",
	);

	// The run_test report is written to the transcript as a custom message.
	send({ type: "get_messages" });
	await wait(800);
	const selfTestMsg = transcriptMessages.find(
		(m) => m.customType === "bedtime-test-selftest",
	);
	const selfTestText =
		typeof selfTestMsg?.content === "string"
			? selfTestMsg.content
			: JSON.stringify(selfTestMsg?.content || "");
	const hasLabels =
		selfTestText.includes("Test situation:") &&
		selfTestText.includes("Command:") &&
		selfTestText.includes("Output:") &&
		selfTestText.includes("Expected:") &&
		selfTestText.includes("Pass/Fail:");
	const hasScenarios =
		selfTestText.includes("Consecutive (dedup)") &&
		selfTestText.includes("Wrap window") &&
		selfTestText.includes("Out of boundary");
	const hasSeed = /Seed: \d+/.test(selfTestText);
	const allChecksPass =
		(selfTestText.match(/Pass\/Fail: PASS/g) || []).length > 0 &&
		!selfTestText.includes("Pass/Fail: FAIL");
	const transcriptOk =
		!!selfTestMsg && hasLabels && hasScenarios && hasSeed && allChecksPass;
	results.push({
		label: "run_test transcript report",
		command: "get_messages (after /bedtime-test run_test)",
		expect: "labeled report, scenarios, seed, all PASS",
		observed: `labels=${hasLabels} scenarios=${hasScenarios} seed=${hasSeed} allPass=${allChecksPass}`,
		pass: transcriptOk,
	});
	console.log(
		`      transcript report: labels=${hasLabels} scenarios=${hasScenarios} seed=${hasSeed} allPass=${allChecksPass} → ${transcriptOk ? "PASS" : "FAIL"}`,
	);
	// Custom window behavior: fires once inside, silent after, silent outside.
	await runCase(
		"set custom window",
		"/bedtime-test time 02:00 04:00",
		"notify",
		"02:00–04:00",
	);
	await runCase("show custom window", "/bedtime-test time", "notify", "custom");
	await runCase("inside custom window", "/bedtime-test 3:00 reset", "popup+notify");
	await runCase("repeat in custom window", "/bedtime-test 3:30", "silent");
	await runCase(
		"outside custom window",
		"/bedtime-test 4:30 reset",
		"silent",
	);
	// Wrap-around custom window (22:00–06:00): 23:00 reminds, 02:00 silent.
	await runCase(
		"set wrap custom window",
		"/bedtime-test time 22:00 06:00",
		"notify",
		"22:00–06:00",
	);
	await runCase("wrap: night reminds", "/bedtime-test 23:00 reset", "popup+notify");
	await runCase("wrap: repeat silent", "/bedtime-test 02:00", "silent");
	await runCase(
		"reset window to default",
		"/bedtime-test time default",
		"notify",
		"default",
	);

	const allPass = results.every((r) => r.pass);
	console.log("\n=== LIVE PI RPC RESULTS ===");
	console.log(JSON.stringify({ results, allPass }, null, 2));
	child.kill("SIGTERM");
	try {
		require("fs").rmSync(STATE_FILE, { force: true });
	} catch {
		// Ignore cleanup failures.
	}
	process.exit(allPass ? 0 : 1);
}

main();
