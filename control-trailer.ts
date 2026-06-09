// Pure helpers for the per-turn CONTROL trailer that drives speaker routing.
//
// Each Lab Agent ends its visible turn with one line of the form:
//
//   CONTROL: {"done": false, "yield": false, "next": "agent-k3x9", "bid": 70}
//
// The runtime strips this line from the visible transcript and records the
// parsed signal as that agent's "standing trailer", which scheduler.ts reads
// to decide who speaks next. See docs/adr/0002-trailer-based-speaker-routing.md.
//
// This file intentionally has no external dependencies so it can be unit-tested
// without resolving Pi peer dependencies.

export interface SpeakerTrailer {
	/** Whether a CONTROL trailer was actually found and parsed. */
	present: boolean;
	/** The agent believes the room has reached its answer. */
	done: boolean;
	/** The agent has nothing more to add right now. */
	yield: boolean;
	/** The agent the speaker thinks should respond next, or null. */
	next: string | null;
	/** How strongly the agent wants the floor again next (0-100). */
	bid: number;
	/** The raw JSON object text that was parsed, for auditing. */
	raw?: string;
}

/**
 * The trailer used when none is present (or it cannot be parsed). Conservative
 * by design: an agent that did not explicitly ask to continue is treated as
 * yielding, so a lone agent stops after speaking and the room does not run away
 * when models ignore the protocol.
 */
export const ABSENT_TRAILER: SpeakerTrailer = {
	present: false,
	done: false,
	yield: true,
	next: null,
	bid: 0,
};

/** Default bid when a trailer is present but omits an explicit bid. */
const DEFAULT_PRESENT_BID = 50;

export const DEFAULT_TRAILER_AGENT_IDS: readonly string[] = [];

export function normalizeNextId(raw: unknown, validIds: readonly string[]): string | null {
	if (typeof raw !== "string") {
		return null;
	}
	const lower = raw.trim().toLowerCase();
	if (lower === "" || lower === "null" || lower === "none" || lower === "any") {
		return null;
	}
	return validIds.find((id) => id.toLowerCase() === lower) ?? null;
}

function clampBid(raw: unknown): number {
	const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
	if (!Number.isFinite(value)) {
		return DEFAULT_PRESENT_BID;
	}
	return Math.max(0, Math.min(100, Math.round(value)));
}

export interface ParsedTurn {
	/** The visible message with the CONTROL line removed and trimmed. */
	visibleText: string;
	/** The parsed control signal (or ABSENT_TRAILER). */
	trailer: SpeakerTrailer;
}

/**
 * Split a raw turn into its visible text and control trailer. Tolerant of
 * casing ("CONTROL:" / "Control :"), surrounding prose, and multiple markers
 * (the last one wins).
 */
export function parseControlTrailer(
	text: string,
	validIds: readonly string[] = DEFAULT_TRAILER_AGENT_IDS,
): ParsedTurn {
	const markers = [...text.matchAll(/CONTROL\s*:/gi)];
	if (markers.length === 0) {
		return { visibleText: text.trim(), trailer: { ...ABSENT_TRAILER } };
	}

	const lastMarker = markers[markers.length - 1]!;
	const markerStart = lastMarker.index ?? 0;
	const afterMarker = text.slice(markerStart + lastMarker[0].length);
	const jsonMatch = afterMarker.match(/\{[\s\S]*\}/);
	const visibleBeforeMarker = text.slice(0, markerStart).trim();

	if (!jsonMatch) {
		// A CONTROL marker with no JSON object: strip the marker line, treat as absent.
		return { visibleText: visibleBeforeMarker, trailer: { ...ABSENT_TRAILER } };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonMatch[0]);
	} catch {
		return { visibleText: visibleBeforeMarker, trailer: { ...ABSENT_TRAILER } };
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { visibleText: visibleBeforeMarker, trailer: { ...ABSENT_TRAILER } };
	}

	const record = parsed as Record<string, unknown>;
	return {
		visibleText: visibleBeforeMarker,
		trailer: {
			present: true,
			done: record.done === true,
			yield: record.yield === true,
			next: normalizeNextId(record.next, validIds),
			bid: clampBid(record.bid),
			raw: jsonMatch[0],
		},
	};
}

/**
 * The instructions appended to every agent turn prompt telling it how to emit
 * the CONTROL trailer. `validIds` are the currently active agent ids that may
 * appear in `next`.
 */
export function controlTrailerInstructions(validIds: readonly string[]): string {
	const idList = validIds.length > 0 ? validIds.join(", ") : "no active agent ids";
	const exampleNext = validIds[0] ?? "agent-id";
	return `After your visible message, end with exactly one line that starts with "CONTROL:" followed by a compact JSON object. This line is removed before other agents see your message and never appears in the room transcript.
Fields (all optional):
  "bid": integer 0-100 — how strongly you want the floor again next (higher means more eager to continue).
  "next": one of [${idList}] — name the agent who should respond next, if one specifically should.
  "yield": true — you have nothing more to add right now.
  "done": true — you believe the room has reached its answer and can stop.
Omit a field to leave it at its default. Example: CONTROL: {"bid": 70, "next": "${exampleNext}"}`;
}
