// Unit tests for the CONTROL trailer parser (control-trailer.ts).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	ABSENT_TRAILER,
	controlTrailerInstructions,
	normalizeNextId,
	parseControlTrailer,
} from "../control-trailer.ts";

describe("parseControlTrailer", () => {
	test("absent trailer yields a conservative yielding default", () => {
		const { visibleText, trailer } = parseControlTrailer("Just some prose with no control line.");
		assert.equal(visibleText, "Just some prose with no control line.");
		assert.equal(trailer.present, false);
		assert.equal(trailer.yield, true);
		assert.equal(trailer.done, false);
		assert.equal(trailer.next, null);
		assert.equal(trailer.bid, 0);
	});

	test("strips the CONTROL line from visible text", () => {
		const { visibleText, trailer } = parseControlTrailer(
			'My contribution to the room.\nCONTROL: {"bid": 70, "next": "anthropic"}',
		);
		assert.equal(visibleText, "My contribution to the room.");
		assert.equal(trailer.present, true);
		assert.equal(trailer.bid, 70);
		assert.equal(trailer.next, "anthropic");
		assert.equal(trailer.yield, false);
		assert.equal(trailer.done, false);
	});

	test("present trailer with no bid defaults to 50 and engaged", () => {
		const { trailer } = parseControlTrailer("text\nCONTROL: {}");
		assert.equal(trailer.present, true);
		assert.equal(trailer.bid, 50);
		assert.equal(trailer.yield, false);
		assert.equal(trailer.done, false);
		assert.equal(trailer.next, null);
	});

	test("parses done and yield booleans", () => {
		const done = parseControlTrailer('ok\nCONTROL: {"done": true}').trailer;
		assert.equal(done.done, true);
		const yielded = parseControlTrailer('ok\nCONTROL: {"yield": true}').trailer;
		assert.equal(yielded.yield, true);
	});

	test("clamps bid into 0-100 and rounds", () => {
		assert.equal(parseControlTrailer('x\nCONTROL: {"bid": 250}').trailer.bid, 100);
		assert.equal(parseControlTrailer('x\nCONTROL: {"bid": -5}').trailer.bid, 0);
		assert.equal(parseControlTrailer('x\nCONTROL: {"bid": 42.6}').trailer.bid, 43);
	});

	test("normalizes next aliases (claude -> anthropic, gpt -> openai, gemini -> google)", () => {
		assert.equal(parseControlTrailer('x\nCONTROL: {"next": "claude"}').trailer.next, "anthropic");
		assert.equal(parseControlTrailer('x\nCONTROL: {"next": "GPT"}').trailer.next, "openai");
		assert.equal(parseControlTrailer('x\nCONTROL: {"next": "gemini"}').trailer.next, "google");
	});

	test("rejects next that is not an active agent id", () => {
		const { trailer } = parseControlTrailer('x\nCONTROL: {"next": "anthropic"}', ["openai", "google"]);
		assert.equal(trailer.next, null);
	});

	test("is case-insensitive about the CONTROL marker", () => {
		const { trailer } = parseControlTrailer('text\ncontrol: {"bid": 33}');
		assert.equal(trailer.present, true);
		assert.equal(trailer.bid, 33);
	});

	test("uses the last CONTROL marker when several appear", () => {
		const { visibleText, trailer } = parseControlTrailer(
			'I might say CONTROL: later.\nReal answer here.\nCONTROL: {"bid": 12}',
		);
		assert.equal(trailer.bid, 12);
		assert.ok(visibleText.endsWith("Real answer here."));
	});

	test("malformed JSON after CONTROL is treated as absent but stripped", () => {
		const { visibleText, trailer } = parseControlTrailer("answer\nCONTROL: {bid: 70");
		assert.equal(trailer.present, false);
		assert.equal(trailer.yield, true);
		assert.equal(visibleText, "answer");
	});

	test("does not mutate the shared ABSENT_TRAILER constant", () => {
		const { trailer } = parseControlTrailer("no control");
		trailer.bid = 99;
		assert.equal(ABSENT_TRAILER.bid, 0);
	});
});

describe("normalizeNextId", () => {
	test("returns null for null/none/any sentinels", () => {
		assert.equal(normalizeNextId(null, ["openai"]), null);
		assert.equal(normalizeNextId("none", ["openai"]), null);
		assert.equal(normalizeNextId("any", ["openai"]), null);
	});

	test("passes through a valid id", () => {
		assert.equal(normalizeNextId("openai", ["openai", "anthropic"]), "openai");
	});

	test("returns null for non-string input", () => {
		assert.equal(normalizeNextId(42, ["openai"]), null);
	});
});

describe("controlTrailerInstructions", () => {
	test("lists the provided active agent ids", () => {
		const text = controlTrailerInstructions(["openai", "anthropic"]);
		assert.match(text, /CONTROL:/);
		assert.match(text, /openai, anthropic/);
		assert.match(text, /"bid"/);
		assert.match(text, /"next"/);
	});

	test("falls back to default ids when given an empty list", () => {
		const text = controlTrailerInstructions([]);
		assert.match(text, /openai, google, anthropic/);
	});
});
