import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { decidePrecompaction } from "../precompaction.ts";

const enabledSettings = { enabled: true, reserveTokens: 100, keepRecentTokens: 50 };
const usage = { tokens: 800, contextWindow: 1000, percent: 80 };

describe("decidePrecompaction", () => {
	test("does not compact when compaction is disabled", () => {
		const decision = decidePrecompaction(usage, { ...enabledSettings, enabled: false });
		assert.equal(decision.shouldCompact, false);
		assert.equal(decision.reason, "disabled");
	});

	test("does not compact when usage is unavailable", () => {
		const decision = decidePrecompaction(undefined, enabledSettings);
		assert.equal(decision.shouldCompact, false);
		assert.equal(decision.reason, "unknown_usage");
	});

	test("does not compact when token estimate is unknown", () => {
		const decision = decidePrecompaction({ tokens: null, contextWindow: 1000 }, enabledSettings);
		assert.equal(decision.shouldCompact, false);
		assert.equal(decision.reason, "unknown_tokens");
	});

	test("does not compact for invalid context windows", () => {
		const decision = decidePrecompaction({ tokens: 500, contextWindow: 0 }, enabledSettings);
		assert.equal(decision.shouldCompact, false);
		assert.equal(decision.reason, "invalid_context_window");
	});

	test("does not compact below the proactive threshold", () => {
		const decision = decidePrecompaction({ tokens: 800, contextWindow: 1000 }, enabledSettings, 0.9);
		assert.equal(decision.shouldCompact, false);
		assert.equal(decision.reason, "below_threshold");
		assert.equal(decision.coreThresholdTokens, 900);
		assert.equal(decision.triggerTokens, 810);
	});

	test("compacts near the proactive threshold", () => {
		const decision = decidePrecompaction({ tokens: 810, contextWindow: 1000 }, enabledSettings, 0.9);
		assert.equal(decision.shouldCompact, true);
		assert.equal(decision.reason, "near_threshold");
		assert.equal(decision.coreThresholdTokens, 900);
		assert.equal(decision.triggerTokens, 810);
	});

	test("compacts over Pi core threshold", () => {
		const decision = decidePrecompaction({ tokens: 900, contextWindow: 1000 }, enabledSettings, 0.9);
		assert.equal(decision.shouldCompact, true);
		assert.equal(decision.reason, "over_threshold");
	});

	test("clamps invalid threshold ratios to the default", () => {
		const decision = decidePrecompaction({ tokens: 810, contextWindow: 1000 }, enabledSettings, Number.NaN);
		assert.equal(decision.thresholdRatio, 0.9);
		assert.equal(decision.shouldCompact, true);
	});

	test("clamps threshold ratio above one", () => {
		const decision = decidePrecompaction({ tokens: 899, contextWindow: 1000 }, enabledSettings, 2);
		assert.equal(decision.thresholdRatio, 1);
		assert.equal(decision.shouldCompact, false);
		assert.equal(decision.reason, "below_threshold");
	});
});
