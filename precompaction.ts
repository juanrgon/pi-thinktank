// Pure helpers for deciding when a Thinktank lab should proactively compact
// before taking another turn. This keeps room-specific policy testable without
// loading the full Pi runtime graph.

export interface ContextUsageSnapshot {
	tokens: number | null;
	contextWindow: number;
	percent?: number | null;
}

export interface PrecompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens?: number;
}

export type PrecompactionDecisionReason =
	| "disabled"
	| "unknown_usage"
	| "unknown_tokens"
	| "invalid_context_window"
	| "below_threshold"
	| "cooldown"
	| "near_threshold"
	| "over_threshold";

export interface PrecompactionDecision {
	shouldCompact: boolean;
	reason: PrecompactionDecisionReason;
	tokens?: number;
	contextWindow?: number;
	coreThresholdTokens?: number;
	triggerTokens?: number;
	thresholdRatio: number;
	cooldownMs?: number;
	cooldownRemainingMs?: number;
	lastCompactionAtMs?: number;
	nowMs?: number;
}

export interface PrecompactionCooldown {
	nowMs: number;
	lastCompactionAtMs?: number;
	cooldownMs: number;
}

export const DEFAULT_PRECOMPACTION_THRESHOLD_RATIO = 0.9;

function clampRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) {
		return DEFAULT_PRECOMPACTION_THRESHOLD_RATIO;
	}
	return Math.max(0, Math.min(1, ratio));
}

export function applyPrecompactionCooldown(
	decision: PrecompactionDecision,
	cooldown: PrecompactionCooldown,
): PrecompactionDecision {
	if (decision.reason !== "near_threshold" || !decision.shouldCompact) {
		return decision;
	}
	if (cooldown.lastCompactionAtMs === undefined || cooldown.cooldownMs <= 0) {
		return decision;
	}

	const elapsedMs = cooldown.nowMs - cooldown.lastCompactionAtMs;
	if (elapsedMs >= cooldown.cooldownMs) {
		return decision;
	}

	return {
		...decision,
		shouldCompact: false,
		reason: "cooldown",
		cooldownMs: cooldown.cooldownMs,
		cooldownRemainingMs: Math.max(0, cooldown.cooldownMs - Math.max(0, elapsedMs)),
		lastCompactionAtMs: cooldown.lastCompactionAtMs,
		nowMs: cooldown.nowMs,
	};
}

export function decidePrecompaction(
	usage: ContextUsageSnapshot | undefined,
	settings: PrecompactionSettings,
	thresholdRatio = DEFAULT_PRECOMPACTION_THRESHOLD_RATIO,
): PrecompactionDecision {
	const ratio = clampRatio(thresholdRatio);
	if (!settings.enabled) {
		return { shouldCompact: false, reason: "disabled", thresholdRatio: ratio };
	}
	if (!usage) {
		return { shouldCompact: false, reason: "unknown_usage", thresholdRatio: ratio };
	}
	if (usage.tokens === null) {
		return {
			shouldCompact: false,
			reason: "unknown_tokens",
			contextWindow: usage.contextWindow,
			thresholdRatio: ratio,
		};
	}
	if (!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
		return {
			shouldCompact: false,
			reason: "invalid_context_window",
			tokens: usage.tokens,
			contextWindow: usage.contextWindow,
			thresholdRatio: ratio,
		};
	}

	const reserveTokens = Math.max(0, settings.reserveTokens);
	const coreThresholdTokens = Math.max(0, usage.contextWindow - reserveTokens);
	const triggerTokens = Math.floor(coreThresholdTokens * ratio);
	const base = {
		tokens: usage.tokens,
		contextWindow: usage.contextWindow,
		coreThresholdTokens,
		triggerTokens,
		thresholdRatio: ratio,
	};

	if (usage.tokens >= coreThresholdTokens) {
		return { shouldCompact: true, reason: "over_threshold", ...base };
	}
	if (usage.tokens >= triggerTokens) {
		return { shouldCompact: true, reason: "near_threshold", ...base };
	}
	return { shouldCompact: false, reason: "below_threshold", ...base };
}
