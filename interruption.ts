// Pure helpers for formatting interruption-recovery context shown to the
// next agent, and the transcript text shown to all agents.
//
// Extracted from room-runtime.ts so the prompt text is testable without
// loading the full Pi runtime graph. Matches the Phase 0 pattern used for
// turn-impulse, agent-error, compaction-retry, precompaction, and
// transcript-text.
//
// This file intentionally has no external dependencies.

export interface InterruptionContext {
	interruptedAgentName: string;
	reason: string;
	partialText: string;
	toolCallsCompleted: number;
}

const NO_PARTIAL_OUTPUT_FALLBACK = "(No visible output captured before interruption.)";

/**
 * Format the recovery prompt fragment shown to the agent whose turn comes
 * after an interruption. The output is injected verbatim into that agent's
 * system prompt; whitespace and section order matter.
 */
export function formatInterruptionRecoveryContext(interruption: InterruptionContext): string {
	const toolCallWarning =
		interruption.toolCallsCompleted > 0
			? "The interrupted turn may already have performed tool actions. Verify repository or disk state before continuing."
			: "";

	return `
The previous turn was interrupted.

Interrupted speaker:
${interruption.interruptedAgentName}

Reason:
${interruption.reason}

${toolCallWarning}

Partial visible output:
${interruption.partialText}

Respond to the interruption. Recover the useful content, correct course, and continue the room's work.`;
}

/**
 * Build the partial-output line for the public transcript entry that
 * follows an interrupted turn. Trims whitespace and substitutes a
 * placeholder when nothing visible was captured before the interrupt.
 */
export function formatInterruptionTranscriptText(partialText: string): string {
	const trimmed = partialText.trim();
	return trimmed === "" ? NO_PARTIAL_OUTPUT_FALLBACK : trimmed;
}
