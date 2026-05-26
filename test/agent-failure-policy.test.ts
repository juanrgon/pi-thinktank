import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_AGENT_FAILURE_POLICY_OPTIONS,
	evaluateAgentFailure,
	resetAgentFailurePolicyState,
	type AgentFailurePolicyState,
} from "../agent-failure-policy.ts";

const options = DEFAULT_AGENT_FAILURE_POLICY_OPTIONS;

function previous(overrides: Partial<AgentFailurePolicyState> = {}): AgentFailurePolicyState {
	return {
		agentId: "openai",
		category: "provider_error",
		count: 1,
		firstFailureAtMs: 0,
		lastFailureAtMs: 0,
		...overrides,
	};
}

describe("evaluateAgentFailure", () => {
	test("continues after an isolated failure", () => {
		const result = evaluateAgentFailure({
			agentId: "openai",
			category: "provider_error",
			nowMs: 1_000,
			unsuppressedAgentCountBeforeFailure: 2,
			options,
		});
		assert.equal(result.decision, "continue");
		assert.equal(result.state.count, 1);
		assert.equal(result.reason, "isolated_failure");
	});

	test("suppresses repeated same-agent same-category failures", () => {
		const result = evaluateAgentFailure({
			agentId: "openai",
			category: "provider_error",
			nowMs: 1_000,
			previous: previous(),
			unsuppressedAgentCountBeforeFailure: 2,
			options,
		});
		assert.equal(result.decision, "suppress_agent");
		assert.equal(result.state.count, 2);
		assert.equal(result.reason, "repeated_same_agent_category_failure");
	});

	test("different category starts a new streak", () => {
		const result = evaluateAgentFailure({
			agentId: "openai",
			category: "auth",
			nowMs: 1_000,
			previous: previous(),
			unsuppressedAgentCountBeforeFailure: 2,
			options,
		});
		assert.equal(result.decision, "continue");
		assert.equal(result.state.category, "auth");
		assert.equal(result.state.count, 1);
	});

	test("different agent starts a new streak", () => {
		const result = evaluateAgentFailure({
			agentId: "anthropic",
			category: "provider_error",
			nowMs: 1_000,
			previous: previous(),
			unsuppressedAgentCountBeforeFailure: 2,
			options,
		});
		assert.equal(result.decision, "continue");
		assert.equal(result.state.agentId, "anthropic");
		assert.equal(result.state.count, 1);
	});

	test("expired window starts a new streak", () => {
		const result = evaluateAgentFailure({
			agentId: "openai",
			category: "provider_error",
			nowMs: options.failureWindowMs + 1,
			previous: previous({ lastFailureAtMs: 0 }),
			unsuppressedAgentCountBeforeFailure: 2,
			options,
		});
		assert.equal(result.decision, "continue");
		assert.equal(result.state.count, 1);
	});

	test("halts when the last unsuppressed agent repeats a failure", () => {
		const result = evaluateAgentFailure({
			agentId: "openai",
			category: "provider_error",
			nowMs: 1_000,
			previous: previous(),
			unsuppressedAgentCountBeforeFailure: 1,
			options,
		});
		assert.equal(result.decision, "halt_room");
		assert.equal(result.reason, "last_unsuppressed_agent_repeated_failure");
	});

	test("honors a higher suppression threshold", () => {
		const result = evaluateAgentFailure({
			agentId: "openai",
			category: "provider_error",
			nowMs: 1_000,
			previous: previous({ count: 1 }),
			unsuppressedAgentCountBeforeFailure: 2,
			options: { ...options, suppressAfterConsecutiveFailures: 3 },
		});
		assert.equal(result.decision, "continue");
		assert.equal(result.state.count, 2);
	});
});

describe("resetAgentFailurePolicyState", () => {
	test("successful turn clears the agent failure streak", () => {
		const states = new Map<string, AgentFailurePolicyState>([
			["openai", previous()],
			["anthropic", previous({ agentId: "anthropic", category: "auth" })],
		]);
		const next = resetAgentFailurePolicyState(states, "openai");
		assert.equal(next.has("openai"), false);
		assert.equal(next.has("anthropic"), true);
		assert.equal(states.has("openai"), true);
	});
});
