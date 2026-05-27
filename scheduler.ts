// Pure, deterministic speaker-routing scheduler.
//
// Replaces the LLM "impulse poll" (chooseNextTurn) with a function of the
// standing CONTROL trailers, the active agents, and conversation state. Costs
// zero model calls per decision and is fully auditable from the transcript.
//
// See docs/adr/0002-trailer-based-speaker-routing.md.
//
// This file intentionally has no external dependencies beyond the SpeakerTrailer
// type so it can be unit-tested without resolving Pi peer dependencies.

import { ABSENT_TRAILER, type SpeakerTrailer } from "./control-trailer.ts";

export interface SchedulerInput {
	/** Active (non-suppressed) agent ids, in rotation order. */
	activeAgentIds: string[];
	/** The id of the agent who spoke most recently, if any. */
	lastSpeakerId?: string;
	/** Ids of agents that have spoken at least once this room. */
	spokenAgentIds: string[];
	/** Latest standing trailer per agent id. Missing entries are treated as absent. */
	trailers: Record<string, SpeakerTrailer | undefined>;
	/** Agent ids explicitly named in the human prompt (opening preference). */
	mentionedAgentIds?: string[];
}

export type SchedulerStopReason = "no_active_agents" | "all_done" | "converged";

export type SchedulerDecision =
	| { action: "speak"; agentId: string; reason: "opening" | "handoff" | "bid" }
	| { action: "stop"; reason: SchedulerStopReason };

/**
 * Order `ids` by their distance in `rotation` after `last`, so ties resolve to
 * whoever is next in round-robin order. Ids absent from the rotation sort last.
 */
function orderAfter(ids: string[], rotation: string[], last: string | undefined): string[] {
	const n = rotation.length;
	if (!last || n === 0) {
		return [...ids];
	}
	const lastPos = rotation.indexOf(last);
	if (lastPos < 0) {
		return [...ids];
	}
	const key = (id: string): number => {
		const pos = rotation.indexOf(id);
		if (pos < 0) {
			return Number.MAX_SAFE_INTEGER;
		}
		return (pos - lastPos - 1 + n) % n;
	};
	return [...ids].sort((a, b) => key(a) - key(b));
}

export function pickNextSpeaker(input: SchedulerInput): SchedulerDecision {
	const active = input.activeAgentIds;
	if (active.length === 0) {
		return { action: "stop", reason: "no_active_agents" };
	}

	const last = input.lastSpeakerId;
	// No back-to-back turns when more than one agent is active.
	const candidates = active.length > 1 ? active.filter((id) => id !== last) : [...active];

	const spoken = new Set(input.spokenAgentIds);
	const trailerOf = (id: string): SpeakerTrailer => input.trailers[id] ?? ABSENT_TRAILER;

	// 1. Opening priority: anyone who has not spoken yet goes first, in rotation
	//    order. Agents named in the human prompt are preferred among the unspoken.
	const unspoken = candidates.filter((id) => !spoken.has(id));
	if (unspoken.length > 0) {
		const mentioned = new Set(input.mentionedAgentIds ?? []);
		const preferred = unspoken.filter((id) => mentioned.has(id));
		const pool = orderAfter(preferred.length > 0 ? preferred : unspoken, active, last);
		return { action: "speak", agentId: pool[0]!, reason: "opening" };
	}

	// 2. Consensus stop: every active agent considers the room done.
	if (active.every((id) => trailerOf(id).done)) {
		return { action: "stop", reason: "all_done" };
	}

	// 3. Directed handoff: the last speaker nominated an active candidate.
	if (last) {
		const nextId = trailerOf(last).next;
		if (nextId && candidates.includes(nextId)) {
			return { action: "speak", agentId: nextId, reason: "handoff" };
		}
	}

	// 4. Reactive priority among eager candidates (not done, not yielding).
	const eager = candidates.filter((id) => {
		const t = trailerOf(id);
		return !t.done && !t.yield;
	});
	if (eager.length === 0) {
		return { action: "stop", reason: "converged" };
	}

	const ordered = orderAfter(eager, active, last);
	let best = ordered[0]!;
	for (const id of ordered) {
		if (trailerOf(id).bid > trailerOf(best).bid) {
			best = id;
		}
	}
	return { action: "speak", agentId: best, reason: "bid" };
}
