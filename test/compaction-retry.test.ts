import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	isAssistantContinuationAfterCompactionError,
	shouldRetryPromptAfterCompactionFailure,
	type CompactionRetryState,
} from "../compaction-retry.ts";

function compactionState(overrides: Partial<CompactionRetryState> = {}): CompactionRetryState {
	return {
		reason: "overflow",
		willRetry: true,
		aborted: false,
		timestampMs: Date.now(),
		...overrides,
	};
}

describe("isAssistantContinuationAfterCompactionError", () => {
	test("matches the Pi core continuation error", () => {
		assert.equal(isAssistantContinuationAfterCompactionError(new Error("Cannot continue from message role: assistant")), true);
	});

	test("matches case-insensitively and through cause chains", () => {
		const error = new Error("prompt failed", {
			cause: new Error("cannot continue from message role: ASSISTANT"),
		});
		assert.equal(isAssistantContinuationAfterCompactionError(error), true);
	});

	test("does not match unrelated provider errors", () => {
		assert.equal(isAssistantContinuationAfterCompactionError("500 provider unavailable"), false);
	});
});

describe("shouldRetryPromptAfterCompactionFailure", () => {
	test("retries once after overflow compaction requested a retry", () => {
		assert.equal(
			shouldRetryPromptAfterCompactionFailure(
				new Error("Cannot continue from message role: assistant"),
				compactionState(),
				0,
				1,
			),
			true,
		);
	});

	test("does not retry after max attempts", () => {
		assert.equal(
			shouldRetryPromptAfterCompactionFailure(
				new Error("Cannot continue from message role: assistant"),
				compactionState(),
				1,
				1,
			),
			false,
		);
	});

	test("requires overflow reason", () => {
		assert.equal(
			shouldRetryPromptAfterCompactionFailure(
				new Error("Cannot continue from message role: assistant"),
				compactionState({ reason: "threshold" }),
				0,
				1,
			),
			false,
		);
	});

	test("requires willRetry", () => {
		assert.equal(
			shouldRetryPromptAfterCompactionFailure(
				new Error("Cannot continue from message role: assistant"),
				compactionState({ willRetry: false }),
				0,
				1,
			),
			false,
		);
	});

	test("does not retry aborted compactions", () => {
		assert.equal(
			shouldRetryPromptAfterCompactionFailure(
				new Error("Cannot continue from message role: assistant"),
				compactionState({ aborted: true }),
				0,
				1,
			),
			false,
		);
	});

	test("requires the exact continuation failure", () => {
		assert.equal(shouldRetryPromptAfterCompactionFailure(new Error("No messages to continue from"), compactionState(), 0, 1), false);
	});
});
