#!/usr/bin/env node
/**
 * live-rpc-test.js
 *
 * Drives a REAL Pi process in RPC mode to prove the extension works in the
 * live environment. It runs a sequence of success and failure cases and
 * reports pass/fail for each.
 *
 * Cases:
 *   1. get_commands           → reminder-check is registered
 *   2. /reminder-check 02:30 reset  → first trigger: notify + yes/no popup
 *   3. /reminder-check 02:35        → repeat same day: silent
 *   4. /reminder-check 14:00 reset  → daytime (out of window): silent
 *   5. /reminder-check 25:00 reset  → invalid hour: warning notification
 *   6. /reminder-check abc  reset   → invalid format: warning notification
 *
 * Success cases (2) and failure cases (3–6) are all verified.
 *
 * Usage: node live-rpc-test.js
 */

const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const PI_BIN = process.env.PI_BIN || "/Users/davidle/.pi/agent/bin/pi";
const EXTENSION = path.join(__dirname, "reminder.ts");

const notifications = [];
const dialogs = [];
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
	{ stdio: ["pipe", "pipe", "pipe"] },
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
		commandRegistered = names.includes("reminder-check");
		console.log(
			`[command registered] get_commands → reminder-check: ${commandRegistered}`,
		);
		results.push({
			label: "command registered",
			command: "get_commands (via /reminder-check)",
			expect: "reminder-check present",
			observed: `registered=${commandRegistered}`,
			pass: commandRegistered === true,
		});
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
async function runCase(label, command, expect) {
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

	await runCase("first trigger (reset)", "/reminder-check 02:30 reset", "popup+notify");
	await runCase("repeat same day", "/reminder-check 02:35", "silent");
	await runCase("daytime out-of-window", "/reminder-check 14:00 reset", "silent");
	await runCase("invalid hour", "/reminder-check 25:00 reset", "warning");
	await runCase("invalid format", "/reminder-check abc reset", "warning");

	const allPass = results.every((r) => r.pass);
	console.log("\n=== LIVE PI RPC RESULTS ===");
	console.log(JSON.stringify({ results, allPass }, null, 2));
	child.kill("SIGTERM");
	process.exit(allPass ? 0 : 1);
}

main();
