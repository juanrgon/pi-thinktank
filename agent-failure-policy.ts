import type { AgentErrorCategory } from "./agent-error.ts";

export type AgentFailurePolicyDecision = "continue" | "suppress_agent" | "halt_room";

export interface AgentFailurePolicyState {
	agentId: string;
	category: AgentErrorCategory;
	count: number;
	firstFailureAtMs: number;
	lastFailureAtMs: number;
}

export interface AgentFailurePolicyOptions {
	suppressAfterConsecutiveFailures: number;
	failureWindowMs: number;
}

export interface EvaluateAgentFailureInput {
	agentId: string;
	category: AgentErrorCategory;
	nowMs: number;
	previous?: AgentFailurePolicyState;
	unsuppressedAgentCountBeforeFailure: number;
	options: AgentFailurePolicyOptions;
}

export interface AgentFailurePolicyResult {
	decision: AgentFailurePolicyDecision;
	state: AgentFailurePolicyState;
	reason: string;
}

export const DEFAULT_AGENT_FAILURE_POLICY_OPTIONS: AgentFailurePolicyOptions = {
	suppressAfterConsecutiveFailures: 2,
	failureWindowMs: 15 * 60 * 1000,
};

export function evaluateAgentFailure(input: EvaluateAgentFailureInput): AgentFailurePolicyResult {
	const threshold = Math.max(1, input.options.suppressAfterConsecutiveFailures);
	const withinWindow =
		input.previous !== undefined &&
		input.previous.agentId === input.agentId &&
		input.previous.category === input.category &&
		input.nowMs - input.previous.lastFailureAtMs <= input.options.failureWindowMs;

	const previous = input.previous;
	const state: AgentFailurePolicyState =
		withinWindow && previous !== undefined
			? {
					...previous,
					count: previous.count + 1,
					lastFailureAtMs: input.nowMs,
				}
			: {
					agentId: input.agentId,
					category: input.category,
					count: 1,
					firstFailureAtMs: input.nowMs,
					lastFailureAtMs: input.nowMs,
				};

	if (state.count < threshold) {
		return {
			decision: "continue",
			state,
			reason: "isolated_failure",
		};
	}

	if (input.unsuppressedAgentCountBeforeFailure <= 1) {
		return {
			decision: "halt_room",
			state,
			reason: "last_unsuppressed_agent_repeated_failure",
		};
	}

	return {
		decision: "suppress_agent",
		state,
		reason: "repeated_same_agent_category_failure",
	};
}

export function resetAgentFailurePolicyState(
	states: ReadonlyMap<string, AgentFailurePolicyState>,
	agentId: string,
): Map<string, AgentFailurePolicyState> {
	const next = new Map(states);
	next.delete(agentId);
	return next;
}
