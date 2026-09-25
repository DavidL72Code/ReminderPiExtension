/**
 * CLI wrapper: writes test.json from the audit log built by buildLog().
 *
 * Kept separate from generate-test-log.ts because jiti does not set
 * `require.main`, so the generator module stays side-effect free.
 *
 * Run: jiti generate-log-cli.ts   (or: npm run generate-log)
 */

import * as fs from "fs";
import * as path from "path";
import { buildLog } from "./generate-test-log";

async function main() {
	const log = await buildLog();
	const outPath = path.join(process.cwd(), "test.json");
	fs.writeFileSync(outPath, JSON.stringify(log, null, 2) + "\n");

	for (const s of log.scenarios) {
		const popups = s.checks.filter((c) => c.outcome === "popup+notify").length;
		const silent = s.checks.filter((c) => c.outcome === "silent").length;
		console.log(
			`${s.name}\n  checks=${s.checks.length} popups=${popups} silent=${silent}`,
		);
	}
	console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
