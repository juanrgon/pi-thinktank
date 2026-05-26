// Phase 0 beachhead tests.
//
// Covers three pure string helpers extracted from room-runtime.ts:
//   - parseTurnImpulse
//   - turnNeedsRoomResponse
//   - isCollaborationPrompt
//
// isContextOverflowException is exported for future tests but not covered
// here because it depends on external pi-ai types.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	parseTurnImpulse,
	turnNeedsRoomResponse,
	isCollaborationPrompt,
} from "../turn-impulse.ts";

describe("parseTurnImpulse", () => {
	test("parses a valid speak impulse", () => {
		const r = parseTurnImpulse('{"action":"speak","kind":"challenge","urgency":82}');
		assert.equal(r?.action, "speak");
		assert.equal(r?.kind, "challenge");
		assert.equal(r?.urgency, 82);
	});

	test("parses a valid finish impulse", () => {
		const r = parseTurnImpulse('{"action":"finish","kind":"final","urgency":70}');
		assert.equal(r?.action, "finish");
		assert.equal(r?.kind, "final");
	});

	test("parses a pass impulse with zero urgency", () => {
		const r = parseTurnImpulse('{"action":"pass","kind":"none","urgency":0}');
		assert.equal(r?.action, "pass");
		assert.equal(r?.urgency, 0);
	});

	test("returns undefined for non-JSON text", () => {
		assert.equal(parseTurnImpulse("hello world"), undefined);
	});

	test("returns undefined for malformed JSON", () => {
		assert.equal(parseTurnImpulse('{"action": "speak"'), undefined);
	});

	test("returns undefined for unknown action", () => {
		assert.equal(
			parseTurnImpulse('{"action":"loiter","kind":"add","urgency":50}'),
			undefined,
		);
	});

	test("returns undefined for unknown kind", () => {
		assert.equal(
			parseTurnImpulse('{"action":"speak","kind":"interpret","urgency":50}'),
			undefined,
		);
	});

	test("clamps urgency above 100 to 100", () => {
		const r = parseTurnImpulse('{"action":"speak","kind":"add","urgency":250}');
		assert.equal(r?.urgency, 100);
	});

	test("clamps negative urgency to 0", () => {
		const r = parseTurnImpulse('{"action":"speak","kind":"add","urgency":-5}');
		assert.equal(r?.urgency, 0);
	});

	test("extracts JSON embedded in surrounding text", () => {
		const r = parseTurnImpulse(
			'thinking... {"action":"pass","kind":"none","urgency":0} done',
		);
		assert.equal(r?.action, "pass");
	});

	test("preserves reason field when present", () => {
		const r = parseTurnImpulse(
			'{"action":"speak","kind":"challenge","urgency":60,"reason":"object to ordering"}',
		);
		assert.equal(r?.reason, "object to ordering");
	});
});

describe("turnNeedsRoomResponse", () => {
	test('detects "your write" handoff (the exact phrase that triggered Phase 1.75)', () => {
		assert.equal(
			turnNeedsRoomResponse("Your write since you announced intent first."),
			true,
		);
	});

	test('detects "your turn"', () => {
		assert.equal(turnNeedsRoomResponse("Your turn to act."), true);
	});

	test('detects "GPT should write" assignment', () => {
		assert.equal(turnNeedsRoomResponse("GPT should write the new docs."), true);
	});

	test('detects "Claude should incorporate"', () => {
		assert.equal(
			turnNeedsRoomResponse("Claude should incorporate these changes."),
			true,
		);
	});

	test('detects "over to" handoff', () => {
		assert.equal(turnNeedsRoomResponse("Over to Claude for the next move."), true);
	});

	test('detects "back to GPT"', () => {
		assert.equal(turnNeedsRoomResponse("Handing this back to GPT."), true);
	});

	test('detects "after you save"', () => {
		assert.equal(turnNeedsRoomResponse("After you save the file, we will validate."), true);
	});

	test('detects coordination question at end', () => {
		assert.equal(
			turnNeedsRoomResponse("Does the room agree on this approach?"),
			true,
		);
	});

	test('detects "any objections"', () => {
		assert.equal(turnNeedsRoomResponse("Any objections to this plan?"), true);
	});

	test('detects "intended action: i will write" pattern', () => {
		assert.equal(
			turnNeedsRoomResponse("Intended action: I will write the new docs file."),
			true,
		);
	});

	test('does not match plain prose without handoff', () => {
		assert.equal(
			turnNeedsRoomResponse("This is interesting. Let me think about it."),
			false,
		);
	});

	test('does not match self-referential statement', () => {
		assert.equal(turnNeedsRoomResponse("I have nothing more to add."), false);
	});

	test('handles empty input', () => {
		assert.equal(turnNeedsRoomResponse(""), false);
	});

	test('handles whitespace-only input', () => {
		assert.equal(turnNeedsRoomResponse("   \n  "), false);
	});

	test('paraphrase evasion: "your contribution" alone does not trigger', () => {
		// Plan-mandated test: regex is a stop-gap, paraphrase should not be
		// over-triggered. This test pins down the current behavior.
		assert.equal(
			turnNeedsRoomResponse("Your contribution to the discussion was helpful."),
			false,
		);
	});
});

describe("isCollaborationPrompt", () => {
	test('matches "both" keyword', () => {
		assert.equal(isCollaborationPrompt("can you both create a plan"), true);
	});

	test('matches "together"', () => {
		assert.equal(isCollaborationPrompt("work on this together"), true);
	});

	test('matches "iterate"', () => {
		assert.equal(isCollaborationPrompt("iterate on the doc"), true);
	});

	test('matches "Socratic" (case-insensitive)', () => {
		assert.equal(isCollaborationPrompt("debate using the Socratic method"), true);
	});

	test('matches "socratic" lowercase', () => {
		assert.equal(isCollaborationPrompt("use a socratic approach"), true);
	});

	test('matches "without me"', () => {
		assert.equal(isCollaborationPrompt("solve this without me"), true);
	});

	test('matches "amongst yourselves"', () => {
		assert.equal(isCollaborationPrompt("debate amongst yourselves"), true);
	});

	test('matches "back and forth"', () => {
		assert.equal(isCollaborationPrompt("go back and forth on it"), true);
	});

	test('matches "each of you"', () => {
		assert.equal(isCollaborationPrompt("each of you propose something"), true);
	});

	test('does not match unrelated coding prose', () => {
		assert.equal(isCollaborationPrompt("fix the bug in line 42"), false);
	});

	test('does not match single-agent task', () => {
		assert.equal(isCollaborationPrompt("write a function that sorts an array"), false);
	});

	test('empty input is not collaboration', () => {
		assert.equal(isCollaborationPrompt(""), false);
	});
});
