import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	formatInterruptionRecoveryContext,
	formatInterruptionTranscriptText,
	type InterruptionContext,
} from "../interruption.ts";

const baseContext: InterruptionContext = {
	interruptedAgentName: "Anthropic",
	reason: "Higher-urgency intervention",
	partialText: "I was about to say...",
	toolCallsCompleted: 0,
};

describe("formatInterruptionRecoveryContext", () => {
	test("includes the interrupted agent name", () => {
		const out = formatInterruptionRecoveryContext(baseContext);
		assert.match(out, /Interrupted speaker:\nAnthropic/);
	});

	test("includes the reason verbatim", () => {
		const out = formatInterruptionRecoveryContext({
			...baseContext,
			reason: "Higher-urgency intervention",
		});
		assert.match(out, /Reason:\nHigher-urgency intervention/);
	});

	test("includes the partial output", () => {
		const out = formatInterruptionRecoveryContext({
			...baseContext,
			partialText: "Started investigating cause...",
		});
		assert.match(out, /Partial visible output:\nStarted investigating cause\.\.\./);
	});

	test("omits tool-call warning when toolCallsCompleted is 0", () => {
		const out = formatInterruptionRecoveryContext({ ...baseContext, toolCallsCompleted: 0 });
		assert.equal(out.includes("Verify repository or disk state"), false);
	});

	test("includes tool-call warning when toolCallsCompleted > 0", () => {
		const out = formatInterruptionRecoveryContext({ ...baseContext, toolCallsCompleted: 3 });
		assert.match(out, /The interrupted turn may already have performed tool actions/);
		assert.match(out, /Verify repository or disk state before continuing\./);
	});

	test("ends with the recovery directive", () => {
		const out = formatInterruptionRecoveryContext(baseContext);
		assert.match(out, /Respond to the interruption\. Recover the useful content[\s\S]*$/);
	});

	test("preserves multi-line reasons", () => {
		const out = formatInterruptionRecoveryContext({
			...baseContext,
			reason: "line one\nline two",
		});
		assert.match(out, /Reason:\nline one\nline two/);
	});

	test("preserves multi-line partial output", () => {
		const out = formatInterruptionRecoveryContext({
			...baseContext,
			partialText: "step 1\nstep 2\nstep 3",
		});
		assert.match(out, /Partial visible output:\nstep 1\nstep 2\nstep 3/);
	});
});

describe("formatInterruptionTranscriptText", () => {
	test("returns trimmed content when present", () => {
		assert.equal(
			formatInterruptionTranscriptText("  Hello world  \n"),
			"Hello world",
		);
	});

	test("returns fallback placeholder for empty input", () => {
		assert.equal(
			formatInterruptionTranscriptText(""),
			"(No visible output captured before interruption.)",
		);
	});

	test("returns fallback placeholder for whitespace-only input", () => {
		assert.equal(
			formatInterruptionTranscriptText("   \n\t  "),
			"(No visible output captured before interruption.)",
		);
	});

	test("preserves internal whitespace in content", () => {
		assert.equal(
			formatInterruptionTranscriptText("first line\n\nsecond line"),
			"first line\n\nsecond line",
		);
	});
});
