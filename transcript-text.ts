// Pure helper for formatting the room transcript shown to agents.
//
// Extracted from room-runtime.ts so the truncation behavior is testable
// without loading the full Pi runtime graph. Used by:
//   - the visible-turn prompt builder (no limit; full transcript)
//   - chooseNextTurn's impulse poll (limit: 20; bounds hidden-completion cost)
//   - pollForInterruptions (limit: 2; only last exchange matters)
//
// This file intentionally has no external dependencies.

export function formatTranscript(
	turns: readonly { readonly speaker: string; readonly text: string }[],
	options?: { limit?: number },
): string {
	if (turns.length === 0) {
		return "(No Lab Agent has spoken yet.)";
	}

	const limit = options?.limit;
	const shouldTruncate =
		typeof limit === "number" && Number.isFinite(limit) && limit > 0 && turns.length > limit;
	const slice = shouldTruncate ? turns.slice(-(limit as number)) : turns;
	const header = shouldTruncate
		? `(showing last ${slice.length} of ${turns.length} turns)\n\n`
		: "";

	return header + slice.map((turn) => `${turn.speaker}:\n${turn.text}`).join("\n\n");
}
