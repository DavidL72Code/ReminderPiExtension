module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	roots: ["<rootDir>"],
	testMatch: ["**/*.test.ts"],
	moduleFileExtensions: ["ts", "js"],
	moduleNameMapper: {
		"^@earendil-works/pi-coding-agent$": "<rootDir>/node_modules/@earendil-works/pi-coding-agent",
	},
	transform: {
		"^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
	},
};
