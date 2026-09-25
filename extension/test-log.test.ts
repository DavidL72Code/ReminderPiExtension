/**
 * Validates the audit log produced by generate-test-log.ts.
 * These assertions encode the required behavior in machine-checkable form.
 */

import { buildLog } from "./generate-test-log";

describe("test.json audit log", () => {
	it("records Pi/system timing context", async () => {
		const log = await buildLog();
		expect(log.systemTime).toBeTruthy();
		expect(log.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(log.policy.window).toContain("00:00");
		expect(log.answers.notifyOnFirstTrigger).toBe(true);
	});

	it("first in-window trigger shows popup+notify, repeats are silent", async () => {
		const log = await buildLog();
		const firstScenario = log.scenarios[0]; // 00:00, answers YES
		expect(firstScenario.checks[0].outcome).toBe("popup+notify");
		expect(firstScenario.checks[0].popup).not.toBeNull();
		expect(firstScenario.checks[0].popup?.answer).toBe("yes");
		// Subsequent in-window checks are silent
		for (const check of firstScenario.checks.slice(1)) {
			expect(check.outcome).toBe("silent");
			expect(check.notifications).toHaveLength(0);
			expect(check.popup).toBeNull();
		}
	});

	it("a 'no' answer still suppresses further reminders", async () => {
		const log = await buildLog();
		const noScenario = log.scenarios[1]; // 05:59, answers NO
		expect(noScenario.checks[0].outcome).toBe("popup+notify");
		expect(noScenario.checks[0].popup?.answer).toBe("no");
		expect(noScenario.checks[1].outcome).toBe("silent");
	});

	it("no popups anywhere from 06:00 to 23:59", async () => {
		const log = await buildLog();
		const daytime = log.scenarios.find((s) => s.name.includes("06:00 to 23:59"));
		expect(daytime).toBeDefined();
		expect(daytime!.checks.length).toBe(18);
		for (const check of daytime!.checks) {
			expect(check.inWindow).toBe(false);
			expect(check.outcome).toBe("silent");
			expect(check.popup).toBeNull();
		}
	});

	it("next calendar day resumes reminders", async () => {
		const log = await buildLog();
		const nextDay = log.scenarios.find((s) => s.name.includes("Next calendar day"));
		expect(nextDay).toBeDefined();
		const popups = nextDay!.checks.filter((c) => c.outcome === "popup+notify");
		expect(popups).toHaveLength(2); // one per day
	});
});
