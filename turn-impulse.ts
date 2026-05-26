// Pure string helpers extracted from room-runtime.ts so they can be unit-tested
// without loading the full runtime's import graph (which pulls in pi-ai et al).
//
// This file intentionally has no external dependencies.

export type TurnImpulseKind =
	| "add"
	| "challenge"
	| "clarify"
	| "synthesize"
	| "final"
	| "none";

export interface TurnImpulse {
	action: "speak" | "finish" | "pass";
	kind: TurnImpulseKind;
	urgency: number;
	reason?: string;
}

export function parseTurnImpulse(text: string): TurnImpulse | undefined {
	const jsonText = text.trim().match(/\{[\s\S]*\}/)?.[0];
	if (!jsonText) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}

	const record = parsed as Record<string, unknown>;
	const action = record.action;
	const kind = record.kind;
	if ((action !== "speak" && action !== "finish" && action !== "pass") || typeof kind !== "string") {
		return undefined;
	}
	if (!["add", "challenge", "clarify", "synthesize", "final", "none"].includes(kind)) {
		return undefined;
	}

	const rawUrgency =
		typeof record.urgency === "number" ? record.urgency : Number.parseInt(String(record.urgency ?? 0), 10);
	const urgency = Number.isFinite(rawUrgency) ? Math.max(0, Math.min(100, rawUrgency)) : 0;
	return {
		action,
		kind: kind as TurnImpulseKind,
		urgency,
		reason: typeof record.reason === "string" ? record.reason : undefined,
	};
}

export function turnNeedsRoomResponse(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
	if (!normalized) {
		return false;
	}

	const asksRoomForCoordination =
		/\b(does|do|can|should|shall)\s+(the\s+)?room\s+(agree|want|prefer|approve|confirm)\b/.test(normalized) ||
		/\b(room|everyone|we)\s+(agree|aligned|comfortable|ready)\b/.test(normalized) ||
		/\b(any|no)\s+(objections|concerns)\b/.test(normalized) ||
		/\b(can|should|shall)\s+i\s+(proceed|write|edit|create|make|apply)\b/.test(normalized);

	const proposesImmediateWrite =
		/\bintended action:\s*i\s+will\s+(write|edit|create|update|modify|apply)\b/.test(normalized) ||
		/\bi\s+will\s+(write|edit|create|update|modify|apply)\s+.+\b(file|deck|document|patch|change)\b/.test(normalized);

	const endsWithCoordinationQuestion =
		/\?\s*$/.test(normalized) &&
		/\b(agree|agreement|aligned|approval|approve|proceed|next step|filename|write|edit|create|room)\b/.test(
			normalized,
		);

	const assignsNextActionOrHandsOff =
		/\byour (write|turn|move|response|call|update|edit|save|critique|reply)\b/.test(normalized) ||
		/\b(gpt|claude|anthropic|openai|gemini|google)[^.!?\n]{0,60}\b(should|will|please|needs? to|must)\s+(write|edit|update|save|create|respond|confirm|reply|do|add|fix|patch|address|review|critique|push back|weigh in|take|incorporate|fold|draft)\b/.test(normalized) ||
		/\b(over to|handing (this|the floor|over)( back)?( to)?|back to)\s+(you|gpt|claude|anthropic|openai|gemini|google)\b/.test(normalized) ||
		/\bafter you (save|write|edit|finish|respond|reply|incorporate|update)\b/.test(normalized) ||
		/\b(next,?\s+|then,?\s+)?(gpt|claude|anthropic|openai|gemini|google|you)\s+(should|will|please|needs? to|must)\s+(write|edit|update|save|create|respond|do|incorporate|fold|address)\b/.test(normalized) ||
		/\byour (write|update|edit|save|response|critique)\s+(since|because|now|next|first)\b/.test(normalized);

	return (
		asksRoomForCoordination ||
		endsWithCoordinationQuestion ||
		proposesImmediateWrite ||
		assignsNextActionOrHandsOff
	);
}

export function isCollaborationPrompt(humanPrompt: string): boolean {
	const p = humanPrompt.toLowerCase();
	return /\b(both|together|debate|back\s*and\s*forth|iterate|until complete|until done|socrat(ic|es)|without me|amongst yoursel(f|ves)|with each other|each of you)\b/.test(
		p,
	);
}
