#!/usr/bin/env node
/**
 * live-startup-test.js
 *
 * Proves the AUTOMATIC reminder path in a real Pi process. Instead of running
 * a command, this spawns `pi --mode rpc` with PIREMINDER_NOW=02:30 set, so the
 * extension's session_start handler believes it is 02:30 and fires the
 * reminder on its own.
 *
 * If Pi shows the notification + yes/no popup with no user prompt, the
 * automatic behavior is confirmed without waiting until midnight.
 *
 * Usage: node live-startup-test.js
 *        PIREMINDER_NOW=05:30 node live-startup-test.js   # any time you like
 */

const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const PI_BIN = process.env.PI_BIN || "/Users/davidle/.pi/agent/bin/pi";
const EXTENSION = path.join(__dirname, "reminder.ts");
const FAKE_TIME = process.env.PIREMINDER_NOW || "02:30";

const captured = { notifications: [], dialogs: [] };
let answered = false;

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
		// NOTE: session_start does not fire with --no-session, so use a temp dir.
		"--session-dir",
		require("os").tmpdir() + "/pireminder-startup-test",
	],
	{
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PIREMINDER_NOW: FAKE_TIME },
	},
);

function send(obj) {
	child.stdin.write(JSON.stringify(obj) + "\n");
}

readline.createInterface({ input: child.stdout }).on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.type !== "extension_ui_request") return;

	if (msg.method === "notify") {
		captured.notifications.push(msg.message);
		console.log(`notify(${msg.notifyType}): ${msg.message}`);
	} else if (msg.method === "confirm") {
		captured.dialogs.push({ title: msg.title, message: msg.message });
		console.log(`confirm [${msg.title}]: ${msg.message}`);
		console.log("→ answering: confirmed=true");
		answered = true;
		send({ type: "extension_ui_response", id: msg.id, confirmed: true });
		setTimeout(finish, 3000);
	}
});

child.stderr.on("data", (d) => {
	const s = d.toString().trim();
	if (s && process.env.DEBUG) console.error("[pi stderr]", s);
});

function finish() {
	const pass = captured.dialogs.length === 1 && captured.notifications.length >= 1;
	console.log(`\n=== AUTOMATIC STARTUP TEST (PIREMINDER_NOW=${FAKE_TIME}) ===`);
	console.log(
		JSON.stringify(
			{
				simulatedTime: FAKE_TIME,
				triggeredWithoutCommand: true,
				notifications: captured.notifications,
				dialogs: captured.dialogs,
				pass,
			},
			null,
			2,
		),
	);
	child.kill("SIGTERM");
	process.exit(pass ? 0 : 1);
}

setTimeout(() => {
	if (!answered) {
		console.error(
			`No automatic reminder appeared within timeout (PIREMINDER_NOW=${FAKE_TIME})`,
		);
		child.kill("SIGTERM");
		process.exit(1);
	}
}, 15000);
