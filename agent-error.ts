// Pure helpers for classifying agent-turn failures without loading the full
// Thinktank runtime import graph.

export type AgentErrorCategory =
	| "unsupported_thinking_level"
	| "auth"
	| "context_overflow"
	| "provider_error"
	| "unknown";

export interface ClassifiedAgentError {
	category: AgentErrorCategory;
	summary: string;
	raw: string;
	hint?: string;
}

interface ClassifyAgentErrorOptions {
	contextOverflow?: boolean;
}

const SUMMARY_LIMIT = 240;
const RAW_LIMIT = 4000;

function truncate(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getProperty(value: unknown, property: string): unknown {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[property] : undefined;
}

function stringifyError(value: unknown, seen = new Set<unknown>()): string {
	if (value instanceof Error) {
		if (seen.has(value)) {
			return "[Circular Error]";
		}
		seen.add(value);

		const parts = [`${value.name}: ${value.message}`];
		const status = getProperty(value, "status") ?? getProperty(value, "statusCode");
		const code = getProperty(value, "code");
		if (status !== undefined) {
			parts.push(`status=${String(status)}`);
		}
		if (code !== undefined) {
			parts.push(`code=${String(code)}`);
		}
		if (value.cause !== undefined) {
			parts.push(`cause=(${stringifyError(value.cause, seen)})`);
		}
		return parts.join(" ");
	}

	if (typeof value === "string") {
		return value;
	}

	if (typeof value !== "object" || value === null) {
		return String(value);
	}

	if (seen.has(value)) {
		return "[Circular object]";
	}
	seen.add(value);

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function classifyAgentError(
	error: unknown,
	options: ClassifyAgentErrorOptions = {},
): ClassifiedAgentError {
	const raw = truncate(stringifyError(error), RAW_LIMIT);
	const normalized = raw.toLowerCase();

	if (options.contextOverflow || /\b(context (window|limit|overflow)|token limit|maximum context)\b/.test(normalized)) {
		return {
			category: "context_overflow",
			summary: truncate(raw || "Agent hit the context limit.", SUMMARY_LIMIT),
			raw,
			hint: "The agent exceeded its context window. Compacting or clearing old room session state may help.",
		};
	}

	if (
		normalized.includes("thinking.type.enabled") ||
		normalized.includes("thinking.type.adaptive") ||
		normalized.includes("output_config.effort")
	) {
		return {
			category: "unsupported_thinking_level",
			summary: truncate(raw || "Model does not support the configured thinking level.", SUMMARY_LIMIT),
			raw,
			hint:
				"This model/provider does not support the configured thinking parameter. Use /roster to lower thinking effort or choose a different model.",
		};
	}

	if (/\b(api key|apikey|auth|authentication|unauthorized|forbidden|permission denied|401|403)\b/.test(normalized)) {
		return {
			category: "auth",
			summary: truncate(raw || "Authentication failed.", SUMMARY_LIMIT),
			raw,
			hint: "Check provider login/API credentials, or run /login if credentials are missing.",
		};
	}

	if (/\b(provider|api|invalid_request_error|bad request|rate limit|429|400|500|502|503|504)\b/.test(normalized)) {
		return {
			category: "provider_error",
			summary: truncate(raw || "Provider request failed.", SUMMARY_LIMIT),
			raw,
			hint: "The model provider rejected or failed the request. Check the provider/model selection and retry.",
		};
	}

	return {
		category: "unknown",
		summary: truncate(raw || "Unknown agent failure.", SUMMARY_LIMIT),
		raw,
	};
}
