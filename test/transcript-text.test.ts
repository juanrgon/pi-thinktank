import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatTranscript } from "../transcript-text.ts";

describe("formatTranscript", () => {
	test("returns empty marker for no turns", () => {
		assert.equal(formatTranscript([]), "(No Lab Agent has spoken yet.)");
	});

	test("formats two turns with speaker:text and blank-line separator", () => {
		const out = formatTranscript([
			{ speaker: "GPT-5.5", text: "hello" },
			{ speaker: "Anthropic", text: "world" },
		]);
		assert.equal(out, "GPT-5.5:\nhello\n\nAnthropic:\nworld");
	});

	test("no truncation when limit is undefined", () => {
		const turns = Array.from({ length: 25 }, (_, i) => ({ speaker: `A${i}`, text: `t${i}` }));
		const out = formatTranscript(turns);
		assert.equal(out.includes("(showing last"), false);
		assert.match(out, /A0:/);
		assert.match(out, /A24:/);
	});

	test("no truncation when turns.length <= limit", () => {
		const turns = Array.from({ length: 5 }, (_, i) => ({ speaker: `A${i}`, text: `t${i}` }));
		const out = formatTranscript(turns, { limit: 10 });
		assert.equal(out.includes("(showing last"), false);
		assert.match(out, /A0:/);
		assert.match(out, /A4:/);
	});

	test("no truncation when turns.length === limit (boundary)", () => {
		const turns = Array.from({ length: 5 }, (_, i) => ({ speaker: `A${i}`, text: `t${i}` }));
		const out = formatTranscript(turns, { limit: 5 });
		assert.equal(out.includes("(showing last"), false);
	});

	test("truncates to last N turns when over limit, with header", () => {
		const turns = Array.from({ length: 30 }, (_, i) => ({ speaker: `A${i}`, text: `t${i}` }));
		const out = formatTranscript(turns, { limit: 5 });
		assert.match(out, /^\(showing last 5 of 30 turns\)/);
		assert.equal(out.includes("A0:"), false, "oldest turns should be dropped");
		assert.match(out, /A29:/, "newest turn must be included");
		assert.match(out, /A25:/, "5th-from-last must be included");
	});

	test("truncation keeps the most recent turns, not the oldest", () => {
		const turns = [
			{ speaker: "old", text: "first" },
			{ speaker: "mid", text: "second" },
			{ speaker: "new", text: "third" },
		];
		const out = formatTranscript(turns, { limit: 2 });
		assert.equal(out.includes("old:"), false);
		assert.match(out, /mid:/);
		assert.match(out, /new:/);
	});

	test("limit=0 disables truncation defensively (treated as no limit)", () => {
		const turns = [{ speaker: "A", text: "x" }];
		const out = formatTranscript(turns, { limit: 0 });
		assert.equal(out.includes("(showing"), false);
	});

	test("negative limit disables truncation defensively", () => {
		const turns = Array.from({ length: 10 }, (_, i) => ({ speaker: `A${i}`, text: `t${i}` }));
		const out = formatTranscript(turns, { limit: -5 });
		assert.equal(out.includes("(showing"), false);
	});

	test("does not produce trailing newline", () => {
		const out = formatTranscript([
			{ speaker: "A", text: "first" },
			{ speaker: "B", text: "second" },
		]);
		assert.equal(out.endsWith("\n"), false);
	});
});
