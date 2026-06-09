import type { AgentId } from "./roster.ts";

export type LeaderControlAction = "continue" | "consult" | "final" | "return";

export interface LeaderControl {
	present: boolean;
	action: LeaderControlAction;
	next: AgentId | null;
	raw?: string;
}

export interface ParsedLeaderTurn {
	visibleText: string;
	control: LeaderControl;
}

export const ABSENT_LEADER_CONTROL: LeaderControl = {
	present: false,
	action: "continue",
	next: null,
};

function normalizeAdvisorId(raw: unknown, validAdvisorIds: readonly AgentId[]): AgentId | null {
	if (typeof raw !== "string") return null;
	const requested = raw.trim().toLowerCase();
	return validAdvisorIds.find((id) => id.toLowerCase() === requested) ?? null;
}

/** Strip and parse the last CONTROL trailer used by a leader-led room turn. */
export function parseLeaderControl(text: string, validAdvisorIds: readonly AgentId[] = []): ParsedLeaderTurn {
	const markers = [...text.matchAll(/CONTROL\s*:/gi)];
	if (markers.length === 0) {
		return { visibleText: text.trim(), control: { ...ABSENT_LEADER_CONTROL } };
	}

	const marker = markers[markers.length - 1]!;
	const markerStart = marker.index ?? 0;
	const visibleText = text.slice(0, markerStart).trim();
	const jsonMatch = text.slice(markerStart + marker[0].length).match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		return { visibleText, control: { ...ABSENT_LEADER_CONTROL } };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonMatch[0]);
	} catch {
		return { visibleText, control: { ...ABSENT_LEADER_CONTROL } };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { visibleText, control: { ...ABSENT_LEADER_CONTROL } };
	}

	const record = parsed as Record<string, unknown>;
	const action: LeaderControlAction =
		record.action === "consult" || record.action === "final" || record.action === "return" || record.action === "continue"
			? record.action
			: "continue";
	const next = action === "consult" ? normalizeAdvisorId(record.next, validAdvisorIds) : null;
	return {
		visibleText,
		control: {
			present: true,
			action: action === "consult" && next === null ? "continue" : action,
			next,
			raw: jsonMatch[0],
		},
	};
}

export function leaderControlInstructions(validAdvisorIds: readonly AgentId[], isLeader: boolean): string {
	if (!isLeader) {
		return `Reply only to the leader's focused request. End with exactly one line:\nCONTROL: {"action":"return"}`;
	}
	const advisors = validAdvisorIds.length > 0 ? validAdvisorIds.join(", ") : "no enabled advisors";
	return `You are the trusted leader. Work on the human's request and decide what the user ultimately sees.
End every turn with exactly one CONTROL line using one of:
- CONTROL: {"action":"consult","next":"<advisor-id>"} — ask an enabled advisor a focused question. Valid advisors: ${advisors}
- CONTROL: {"action":"continue"} — keep working yourself on another turn.
- CONTROL: {"action":"final"} — the visible text before CONTROL is your final answer to the human.
Only use final when your visible text directly and succinctly answers the human. Intermediate text is collapsed in the normal UI.`;
}
