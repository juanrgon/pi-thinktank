import type { LeaderControl } from "./leader-control.ts";
import type { AgentId } from "./roster.ts";

export interface LeaderSchedulerInput {
	leaderId: AgentId;
	activeAgentIds: AgentId[];
	lastSpeakerId?: AgentId;
	lastLeaderControl?: LeaderControl;
	turnsUsed: number;
	maxTurns: number;
}

export type LeaderSchedulerDecision =
	| { action: "speak"; agentId: AgentId; reason: "leader" | "consult" | "return_to_leader" }
	| { action: "stop"; reason: "final" | "turn_limit" | "leader_unavailable" };

/** Pure hub-and-spoke routing for leader-led rooms. */
export function pickNextLeaderSpeaker(input: LeaderSchedulerInput): LeaderSchedulerDecision {
	if (!input.activeAgentIds.includes(input.leaderId)) {
		return { action: "stop", reason: "leader_unavailable" };
	}
	if (input.lastLeaderControl?.action === "final") {
		return { action: "stop", reason: "final" };
	}
	if (input.turnsUsed >= input.maxTurns) {
		return { action: "stop", reason: "turn_limit" };
	}
	if (input.lastSpeakerId && input.lastSpeakerId !== input.leaderId) {
		return { action: "speak", agentId: input.leaderId, reason: "return_to_leader" };
	}
	const requested = input.lastLeaderControl?.action === "consult" ? input.lastLeaderControl.next : null;
	if (requested && input.activeAgentIds.includes(requested) && requested !== input.leaderId) {
		return { action: "speak", agentId: requested, reason: "consult" };
	}
	return { action: "speak", agentId: input.leaderId, reason: "leader" };
}
