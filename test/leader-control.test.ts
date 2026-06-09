import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { leaderControlInstructions, parseLeaderControl } from "../leader-control.ts";

describe("leader control protocol", () => {
	test("parses a valid consultation and strips control text", () => {
		const parsed = parseLeaderControl('Please inspect auth.\nCONTROL: {"action":"consult","next":"ADVISOR-A"}', ["advisor-a"]);
		assert.equal(parsed.visibleText, "Please inspect auth.");
		assert.equal(parsed.control.action, "consult");
		assert.equal(parsed.control.next, "advisor-a");
	});

	test("rejects consultation of an unknown advisor", () => {
		const parsed = parseLeaderControl('question\nCONTROL: {"action":"consult","next":"missing"}', ["advisor-a"]);
		assert.equal(parsed.control.action, "continue");
		assert.equal(parsed.control.next, null);
	});

	test("parses final and return controls", () => {
		assert.equal(parseLeaderControl('answer\nCONTROL: {"action":"final"}').control.action, "final");
		assert.equal(parseLeaderControl('advice\nCONTROL: {"action":"return"}').control.action, "return");
	});

	test("absent or malformed control continues conservatively", () => {
		assert.equal(parseLeaderControl("working").control.action, "continue");
		assert.equal(parseLeaderControl("working\nCONTROL: nope").control.action, "continue");
	});

	test("instructions distinguish leader and advisor authority", () => {
		assert.match(leaderControlInstructions(["advisor-a"], true), /"action":"final"/);
		assert.match(leaderControlInstructions(["advisor-a"], true), /advisor-a/);
		assert.doesNotMatch(leaderControlInstructions(["advisor-a"], false), /"action":"final"/);
		assert.match(leaderControlInstructions(["advisor-a"], false), /"action":"return"/);
	});
});
