// Pure helpers for recognizing the Pi core overflow-compaction edge case
// where auto-compaction succeeds, then the built-in retry attempts to continue
// from a context whose last message is an assistant message.

export interface CompactionRetryState {
	reason: string;
	willRetry?: boolean;
	aborted?: boolean;
	errorMessage?: string;
	tokensBefore?: number;
	firstKeptEntryId?: string;
	timestampMs: number;
}

const ASSISTANT_CONTINUATION_ERROR = /cannot\s+continue\s+from\s+message\s+role:\s*assistant/i;

function stringifyError(error: unknown): string {
	if (error instanceof Error) {
		const cause = error.cause === undefined ? "" : ` cause=(${stringifyError(error.cause)})`;
		return `${error.name}: ${error.message}${cause}`;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

export function isAssistantContinuationAfterCompactionError(error: unknown): boolean {
	return ASSISTANT_CONTINUATION_ERROR.test(stringifyError(error));
}

export function shouldRetryPromptAfterCompactionFailure(
	error: unknown,
	lastCompaction: CompactionRetryState | undefined,
	attempt: number,
	maxAttempts: number,
): boolean {
	if (attempt >= maxAttempts) {
		return false;
	}
	if (!isAssistantContinuationAfterCompactionError(error)) {
		return false;
	}
	return lastCompaction?.reason === "overflow" && lastCompaction.willRetry === true && lastCompaction.aborted !== true;
}
