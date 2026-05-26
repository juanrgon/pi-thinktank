import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { clampThinkingLevel, completeSimple, isContextOverflow } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { classifyAgentError, type ClassifiedAgentError } from "./agent-error.ts";
import {
	shouldRetryPromptAfterCompactionFailure,
	type CompactionRetryState,
} from "./compaction-retry.ts";
import {
	applyPrecompactionCooldown,
	decidePrecompaction,
	DEFAULT_PRECOMPACTION_THRESHOLD_RATIO,
} from "./precompaction.ts";
import {
	getThinktankModelReference,
	getThinktankVisibleName,
	type LabId,
	selectDefaultThinktankRosterModels,
	THINKTANK_LAB_DEFINITIONS,
	type ThinktankLabDefinition,
	type ThinktankRosterModels,
} from "./roster.ts";
import { formatTranscript } from "./transcript-text.ts";
import {
	isCollaborationPrompt,
	parseTurnImpulse,
	turnNeedsRoomResponse,
	type TurnImpulse,
	type TurnImpulseKind,
} from "./turn-impulse.ts";

export { classifyAgentError, type AgentErrorCategory, type ClassifiedAgentError } from "./agent-error.ts";
export {
	isAssistantContinuationAfterCompactionError,
	shouldRetryPromptAfterCompactionFailure,
	type CompactionRetryState,
} from "./compaction-retry.ts";
export {
	applyPrecompactionCooldown,
	decidePrecompaction,
	DEFAULT_PRECOMPACTION_THRESHOLD_RATIO,
	type ContextUsageSnapshot,
	type PrecompactionCooldown,
	type PrecompactionDecision,
	type PrecompactionDecisionReason,
	type PrecompactionSettings,
} from "./precompaction.ts";
export {
	isCollaborationPrompt,
	parseTurnImpulse,
	turnNeedsRoomResponse,
	type TurnImpulse,
	type TurnImpulseKind,
} from "./turn-impulse.ts";

interface RankedTurnImpulse {
	agent: LabAgentRuntime;
	impulse: TurnImpulse;
}

export interface ThinktankRoomAgentInfo {
	id: LabId;
	visibleName: string;
	lab: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
}

export type AgentTurnPhase = "opening" | "discussion" | "closing" | "response";

export interface ThinktankAgentTurnError extends ClassifiedAgentError {
	partialText?: string;
}

export interface ThinktankRoomCallbacks {
	onStatus?(message: string): void;
	onAgentTurnStart?(agent: ThinktankRoomAgentInfo): void;
	onAgentTurnEnd?(agent: ThinktankRoomAgentInfo, text: string): void;
	onAgentTurnError?(agent: ThinktankRoomAgentInfo, phase: AgentTurnPhase, error: ThinktankAgentTurnError): void;
	onAgentEvent?(agent: ThinktankRoomAgentInfo, session: AgentSession, event: AgentSessionEvent): void | Promise<void>;
	onInterrupt?(
		interruptedAgent: ThinktankRoomAgentInfo,
		interrupter: ThinktankRoomAgentInfo | "user" | "runtime",
		reason: string,
	): void;
	onRoomIdle?(): void;
}

interface ActiveRoomTurn {
	agent: LabAgentRuntime;
	startedAt: number;
	partialText: string;
	toolCallsCompleted: number;
	toolErrors: number;
	interruptedBy?: LabAgentRuntime | "user" | "runtime";
	interruptReason?: string;
}

export type AgentTurnResult =
	| { status: "completed"; text: string }
	| {
			status: "interrupted";
			text: string;
			interrupter: LabAgentRuntime | "user" | "runtime";
			reason: string;
	  };

interface TranscriptTurn {
	speaker: string;
	text: string;
}

interface PublicActionSummary {
	agent: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: string;
	isError?: boolean;
}

interface LabAgentRuntime {
	definition: ThinktankLabDefinition;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	visibleName: string;
	session: AgentSession;
	lastCompactionEvent?: CompactionRetryState;
	lastPrecompactionAtMs?: number;
	unsubscribe: () => void;
}

const MAX_ROOM_TURNS = 1000;
const MIN_DYNAMIC_TURNS_AFTER_OPENING = 0;
const MAX_POST_COMPACTION_PROMPT_RETRIES = 1;
const MAX_OPEN_QUESTION_RESPONSE_TURNS = 1000;
const THINKTANK_PRECOMPACTION_THRESHOLD_RATIO = DEFAULT_PRECOMPACTION_THRESHOLD_RATIO;
const THINKTANK_PRECOMPACTION_COOLDOWN_MS = 10 * 60 * 1000;
const READ_WRITE_TOOL_WARNING = `Tool use is public in this room. Reads, searches, and bash exploration may proceed.
Before edits, writes, or destructive shell commands, state the intended change in the public conversation and wait for the room to converge.`;

const THINKTANK_PRECOMPACTION_INSTRUCTIONS =
	"Summarize this Lab Agent's private Thinktank room-session context before it takes another turn. Preserve the human's goals, the room's current task, prior Lab Agent conclusions, public tool actions, important files or commands, and unresolved decisions. Keep the summary compact enough for several more Thinktank turns.";

const INTERRUPT_DECISION_SYSTEM_PROMPT = `You are a Lab Agent observing another Lab Agent's in-progress turn in a shared room.
Decide only whether to interrupt the active speaker right now.

Respond with strict JSON, no prose:
{"action":"interrupt"|"pass","urgency":0-100,"reason":string}

Urgency rubric:
  0-40   speaker is fine, possibly slow
  41-79  speaker is drifting but recoverable on their own
  80-89  speaker is looping or off-track and unlikely to self-correct
  90-100 speaker is doing something actively harmful (wrong file, destructive command, factual error that will be acted on)

Only return urgency >= 80 if you have a concrete next move that materially changes
the room's trajectory. "I would phrase it differently" is not grounds.
Never request to interrupt yourself.
If you interrupt, your reason must name the concrete failure mode and the next corrective move.`;

const TURN_IMPULSE_SYSTEM_PROMPT = `You are a Lab Agent's private conversational impulse in an AI Thinktank CLI.

You just heard the latest visible turn. Decide whether you want to take the floor next.
Default to speaking. Pass only if you would clearly only restate prior turns or have nothing new to add.
Speak when you have a useful addition, correction, challenge, clarification, synthesis, response to an open question, response to a handoff or action assignment, or final answer.
If the latest visible turn assigns the next action to you, hands the floor to you, asks for your approval, proposes a write you should respond to, or otherwise expects another agent to act, you must speak.
You are not allowed to speak if you were the Lab Agent who spoke most recently.

Return exactly one JSON object and no prose:
{"action":"speak","kind":"challenge","urgency":82,"reason":"short reason"}
{"action":"finish","kind":"final","urgency":70,"reason":"short reason"}
{"action":"pass","kind":"none","urgency":0,"reason":"short reason"}

Urgency is an integer from 0 to 100.`;

function createRoomSessionDir(cwd: string): string {
	const safeCwd = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	const dir = join(homedir(), ".ai-thinktank", "room-sessions", safeCwd);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function getAgentInfo(agent: LabAgentRuntime): ThinktankRoomAgentInfo {
	return {
		id: agent.definition.id,
		visibleName: agent.visibleName,
		lab: agent.definition.shortName,
		provider: agent.model.provider,
		model: agent.model.id,
		thinkingLevel: agent.thinkingLevel,
	};
}

function getTextFromMessage(message: AgentMessage): string {
	if (message.role !== "assistant" && message.role !== "user") {
		return "";
	}

	const content = message.content;
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}

function getLastAssistantText(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role === "assistant") {
			return getTextFromMessage(message);
		}
	}
	return "";
}

export function isContextOverflowException(error: unknown, model: Model<Api>): boolean {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const message = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	} as AssistantMessage;
	return isContextOverflow(message, model.contextWindow);
}

function transcriptText(turns: TranscriptTurn[], options?: { limit?: number }): string {
	return formatTranscript(turns, options);
}

function actionSummaryText(actions: PublicActionSummary[]): string {
	if (actions.length === 0) {
		return "(No public tool actions yet.)";
	}
	return actions
		.slice(-12)
		.map((action) => {
			const result = action.result ? ` -> ${action.result.replace(/\s+/g, " ").slice(0, 240)}` : "";
			const error = action.isError ? " [error]" : "";
			return `- ${action.agent}: ${action.toolName}${error} ${JSON.stringify(action.args).slice(0, 240)}${result}`;
		})
		.join("\n");
}


export class ThinktankRoomRuntime {
	private services: AgentSessionServices;
	private cwd: string;
	private roomSessionDir: string;
	private callbacks: ThinktankRoomCallbacks;
	private transcriptPath: string;
	private agents: LabAgentRuntime[] = [];
	private transcript: TranscriptTurn[] = [];
	private publicActions: PublicActionSummary[] = [];
	private pendingPublicActions = new Map<string, PublicActionSummary>();
	private currentHumanPrompt = "";
	private currentHumanImages: ImageContent[] = [];
	private agentsThatReceivedHumanImages = new Set<LabId>();
	private running = false;
	private disposed = false;
	private readyPromise: Promise<void>;
	activeTurn?: ActiveRoomTurn;
	forcedNextSpeaker?: LabAgentRuntime;
	interruptionLock = false;
	lastGlobalInterruptAt = 0;
	private lastInterruption?: {
		interruptedAgentName: string;
		reason: string;
		partialText: string;
		toolCallsCompleted: number;
	};

	constructor(options: {
		services: AgentSessionServices;
		cwd: string;
		rosterSelections: ThinktankRosterModels;
		callbacks: ThinktankRoomCallbacks;
	}) {
		this.services = options.services;
		this.cwd = options.cwd;
		this.callbacks = options.callbacks;
		this.roomSessionDir = createRoomSessionDir(options.cwd);
		this.transcriptPath = join(this.roomSessionDir, "transcript.jsonl");
		this.readyPromise = this.rebuildAgents(options.rosterSelections);
	}

	get isRunning(): boolean {
		return this.running;
	}

	get agentInfos(): ThinktankRoomAgentInfo[] {
		return this.agents.map(getAgentInfo);
	}

	get transcriptFile(): string {
		return this.transcriptPath;
	}

	async ready(): Promise<void> {
		await this.readyPromise;
	}

	async setRoster(rosterSelections: ThinktankRosterModels): Promise<void> {
		if (this.running) {
			throw new Error("Roster changes can be made once the room is idle.");
		}
		this.readyPromise = this.rebuildAgents(rosterSelections);
		await this.readyPromise;
	}

	dispose(): void {
		this.disposed = true;
		for (const agent of this.agents) {
			agent.unsubscribe();
			agent.session.dispose();
		}
		this.agents = [];
	}

	private async rebuildAgents(rosterSelections: ThinktankRosterModels): Promise<void> {
		for (const agent of this.agents) {
			agent.unsubscribe();
			agent.session.dispose();
		}
		this.agents = [];

		this.services.modelRegistry.refresh();
		const availableModels = this.services.modelRegistry.getAvailable();
		const selectedRoster = selectDefaultThinktankRosterModels(
			availableModels,
			Object.fromEntries(
				Object.entries(rosterSelections).map(([labId, entry]) => [
					labId,
					entry
						? {
								provider: entry.model.provider,
								model: entry.model.id,
								thinkingLevel: entry.thinkingLevel,
								disabled: entry.disabled,
							}
						: undefined,
				]),
			),
		);

		for (const definition of THINKTANK_LAB_DEFINITIONS) {
			const rosterEntry = selectedRoster[definition.id];
			if (!rosterEntry || rosterEntry.disabled) {
				continue;
			}
			const { model, thinkingLevel } = rosterEntry;

			const sessionDir = join(this.roomSessionDir, "labs", definition.id);
			mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
			const sessionManager = SessionManager.continueRecent(this.cwd, sessionDir);
			const created = await createAgentSessionFromServices({
				services: this.services,
				sessionManager,
				model,
				thinkingLevel,
				tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			});

			const labAgent: LabAgentRuntime = {
				definition,
				model,
				thinkingLevel,
				visibleName: getThinktankVisibleName(definition, model),
				session: created.session,
				unsubscribe: () => {},
			};
			labAgent.unsubscribe = created.session.subscribe((event) => {
				this.recordAgentSessionEvent(labAgent, event);
				void this.callbacks.onAgentEvent?.(getAgentInfo(labAgent), created.session, event);
			});
			this.agents.push(labAgent);
		}
	}

	private getPublicActionKey(agent: LabAgentRuntime, toolCallId: string): string {
		return `${agent.definition.id}:${toolCallId}`;
	}

	private recordAgentSessionEvent(agent: LabAgentRuntime, event: AgentSessionEvent): void {
		this.recordPublicAction(agent, event);
		this.recordCompactionEvent(agent, event);
	}

	private recordCompactionEvent(agent: LabAgentRuntime, event: AgentSessionEvent): void {
		if (event.type === "compaction_start") {
			agent.lastCompactionEvent = {
				reason: event.reason,
				timestampMs: Date.now(),
			};
			this.appendRoomEvent({
				type: "compaction_start",
				reason: event.reason,
				agent: agent.visibleName,
				provider: agent.model.provider,
				model: agent.model.id,
			});
			return;
		}

		if (event.type !== "compaction_end") {
			return;
		}

		const state: CompactionRetryState = {
			reason: event.reason,
			willRetry: event.willRetry,
			aborted: event.aborted,
			errorMessage: event.errorMessage,
			tokensBefore: event.result?.tokensBefore,
			firstKeptEntryId: event.result?.firstKeptEntryId,
			timestampMs: Date.now(),
		};
		agent.lastCompactionEvent = state;
		this.appendRoomEvent({
			type: "compaction_end",
			reason: event.reason,
			agent: agent.visibleName,
			provider: agent.model.provider,
			model: agent.model.id,
			aborted: event.aborted,
			willRetry: event.willRetry,
			error: event.errorMessage,
			tokensBefore: event.result?.tokensBefore,
			firstKeptEntryId: event.result?.firstKeptEntryId,
		});
	}

	private recordPublicAction(agent: LabAgentRuntime, event: AgentSessionEvent): void {
		if (event.type === "tool_execution_start") {
			this.appendRoomEvent({
				type: "tool_start",
				agent: agent.visibleName,
				provider: agent.model.provider,
				model: agent.model.id,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
			const summary: PublicActionSummary = {
				agent: agent.visibleName,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			this.publicActions.push(summary);
			this.pendingPublicActions.set(this.getPublicActionKey(agent, event.toolCallId), summary);
			return;
		}

		if (event.type !== "tool_execution_end") {
			return;
		}

		this.appendRoomEvent({
			type: "tool_end",
			agent: agent.visibleName,
			provider: agent.model.provider,
			model: agent.model.id,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		});

		const key = this.getPublicActionKey(agent, event.toolCallId);
		const existing = this.pendingPublicActions.get(key);
		if (!existing) {
			this.publicActions.push({
				agent: agent.visibleName,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: {},
				result: JSON.stringify(event.result.content),
				isError: event.isError,
			});
			return;
		}
		existing.result = JSON.stringify(event.result.content);
		existing.isError = event.isError;
		this.pendingPublicActions.delete(key);
	}

	private appendRoomEvent(entry: Record<string, unknown>): void {
		// Keep transcript writes synchronous for now: events are tiny JSONL records,
		// ordering is important for room debugging, and an async write queue belongs
		// in a broader runtime refactor.
		appendFileSync(this.transcriptPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	}

	private recordAgentTurnError(
		agent: LabAgentRuntime,
		phase: AgentTurnPhase,
		error: unknown,
		partialText?: string,
	): ThinktankAgentTurnError {
		const classified = classifyAgentError(error);
		const trimmedPartialText = partialText?.trim();
		const turnError: ThinktankAgentTurnError = trimmedPartialText
			? { ...classified, partialText: trimmedPartialText }
			: classified;

		this.appendRoomEvent({
			type: "agent_error",
			phase,
			agent: agent.visibleName,
			provider: agent.model.provider,
			model: agent.model.id,
			thinkingLevel: agent.thinkingLevel,
			category: classified.category,
			errorSummary: classified.summary,
			errorRaw: classified.raw,
			hint: classified.hint,
			partialText: trimmedPartialText,
		});

		const hint = classified.hint ? `\nHint: ${classified.hint}` : "";
		const partial = trimmedPartialText ? `\nPartial output before failure:\n${trimmedPartialText}` : "";
		this.transcript.push({
			speaker: `system (${agent.visibleName} error)`,
			text: `Turn failed: ${classified.category} — ${classified.summary}${hint}${partial}`,
		});

		this.callbacks.onAgentTurnError?.(getAgentInfo(agent), phase, turnError);
		return turnError;
	}

	private async completeHidden(
		agent: LabAgentRuntime,
		prompt: string,
		systemPrompt: string = TURN_IMPULSE_SYSTEM_PROMPT,
	): Promise<string> {
		const auth = await this.services.modelRegistry.getApiKeyAndHeaders(agent.model);
		if (!auth.ok) {
			throw new Error(auth.error);
		}
		const reasoning = clampThinkingLevel(agent.model, "low");
		const message = await completeSimple(
			agent.model,
			{
				systemPrompt,
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				reasoning: reasoning === "off" ? undefined : reasoning,
			},
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage || `${agent.visibleName} impulse failed`);
		}
		return getTextFromMessage(message);
	}

	private getLastSpeakerId(): LabId | undefined {
		const lastSpeaker = this.transcript[this.transcript.length - 1]?.speaker;
		return this.agents.find((agent) => agent.visibleName === lastSpeaker)?.definition.id;
	}

	private chooseOpeningTurn(
		turnIndex: number,
		spokenAgentIds: Set<LabId>,
	): { action: "speak"; agent: LabAgentRuntime; kind: TurnImpulseKind } | { action: "idle" } {
		const unspokenAgents = this.agents.filter((agent) => !spokenAgentIds.has(agent.definition.id));
		if (unspokenAgents.length === 0) {
			return { action: "idle" };
		}

		const promptWords = new Set(this.currentHumanPrompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
		const targetedAgents = unspokenAgents.filter((agent) => {
			const aliases = [
				agent.definition.id,
				agent.definition.shortName,
				agent.definition.displayName,
				agent.visibleName,
				agent.model.id,
				agent.model.name ?? "",
				...agent.definition.modelIdNeedles,
			];
			if (agent.definition.id === "openai") {
				aliases.push("openai", "gpt");
			}
			if (agent.definition.id === "anthropic") {
				aliases.push("anthropic", "claude", "opus");
			}
			if (agent.definition.id === "google") {
				aliases.push("google", "gemini");
			}

			return aliases.some((alias) => {
				const aliasWords = alias.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
				return aliasWords.length > 0 && aliasWords.every((word) => promptWords.has(word));
			});
		});

		const lastSpeakerId = this.getLastSpeakerId();
		const candidates = targetedAgents.length > 0 ? targetedAgents : unspokenAgents;
		const agent = candidates.find((candidate) => candidate.definition.id !== lastSpeakerId) ?? candidates[0]!;
		return { action: "speak", agent, kind: turnIndex === 0 ? "add" : "synthesize" };
	}

	private async chooseNextTurn(
		turnIndex: number,
	): Promise<
		| { action: "speak"; agent: LabAgentRuntime; kind: TurnImpulseKind }
		| { action: "finish"; agent: LabAgentRuntime }
		| { action: "idle" }
	> {
		const lastSpeakerId = this.getLastSpeakerId();
		const eligibleAgents =
			this.agents.length > 1 ? this.agents.filter((agent) => agent.definition.id !== lastSpeakerId) : this.agents;
		const impulseResults = await Promise.all(
			eligibleAgents.map(async (agent): Promise<RankedTurnImpulse> => {
				try {
					const raw = await this.completeHidden(
						agent,
						`Human prompt:

${this.currentHumanPrompt}

Your identity:
${agent.definition.shortName}: ${agent.visibleName} (${getThinktankModelReference(agent.model)})

Turn number:
${turnIndex + 1}

Most recent speaker:
${lastSpeakerId ?? "none"}

Public transcript:

${transcriptText(this.transcript, { limit: 20 })}

Public action summaries:

${actionSummaryText(this.publicActions)}

Decide whether the room should continue. Take the floor when the latest turn challenges, corrects, extends, or questions your position, or when a useful synthesis would move the conversation forward. Pass if you would mostly restate prior turns, if the latest turn is only asking the human for missing context, or if the exchange is complete.`,
					);
					const impulse = parseTurnImpulse(raw) ?? {
						action: "pass" as const,
						kind: "none" as const,
						urgency: 0,
						reason: `Malformed impulse JSON: ${raw.trim().slice(0, 240)}`,
					};
					return { agent, impulse };
				} catch (error) {
					return {
						agent,
						impulse: {
							action: "pass",
							kind: "none",
							urgency: 0,
							reason: error instanceof Error ? error.message : String(error),
						},
					};
				}
			}),
		);

		const strongest = impulseResults
			.filter((entry) => entry.impulse.action === "speak" || entry.impulse.action === "finish")
			.sort((a, b) => b.impulse.urgency - a.impulse.urgency)[0];

		this.appendRoomEvent({
			type: "turn_impulse_poll",
			turnIndex,
			lastSpeaker: lastSpeakerId,
			impulses: impulseResults.map((r) => ({
				agent: r.agent.visibleName,
				provider: r.agent.model.provider,
				model: r.agent.model.id,
				action: r.impulse.action,
				kind: r.impulse.kind,
				urgency: r.impulse.urgency,
				reason: r.impulse.reason,
			})),
			decision: strongest
				? {
						agent: strongest.agent.visibleName,
						action: strongest.impulse.action,
						kind: strongest.impulse.kind,
						urgency: strongest.impulse.urgency,
					}
				: { action: "idle" },
		});

		if (!strongest) {
			return { action: "idle" };
		}
		if (strongest.impulse.action === "finish") {
			return { action: "finish", agent: strongest.agent };
		}
		return { action: "speak", agent: strongest.agent, kind: strongest.impulse.kind };
	}

	private buildPromptForAgent(
		agent: LabAgentRuntime,
		kind: TurnImpulseKind,
		phase: "opening" | "discussion" | "closing" | "response" = "discussion",
	): string {
		const roster = this.agents
			.map(
				(candidate) =>
					`${candidate.definition.shortName}: ${candidate.visibleName} (${getThinktankModelReference(candidate.model)}:${candidate.thinkingLevel})`,
			)
			.join("\n");
		const isFirstTurn = this.transcript.length === 0;
		const turnInstruction =
			phase === "opening" && isFirstTurn
				? "Open the room with the most useful first contribution. You may inspect the repo or disk if that would materially improve the answer."
				: phase === "opening"
					? "Give your first contribution to the room. Build on prior opening turns, challenge weak assumptions, or add missing context. Do not merely restate what has already been said."
					: phase === "response"
						? "Respond directly to the room's open question or proposed immediate action. State agreement, concern, or a concrete correction. If the proposed action is ready and safe, you may execute it; otherwise say exactly what must change. Do not leave another yes/no approval question hanging."
						: phase === "closing" || kind === "final"
							? "State the room's current answer or plan concisely. Preserve important uncertainty. Do not end with a request for room agreement or propose an immediate file write as the final line."
							: "Continue the discussion naturally. Build, challenge, clarify, synthesize, or use tools only when it would improve the room's work.";

		let interruptNotice = "";
		if (this.lastInterruption) {
			interruptNotice = `
The previous turn was interrupted.

Interrupted speaker:
${this.lastInterruption.interruptedAgentName}

Reason:
${this.lastInterruption.reason}

${this.lastInterruption.toolCallsCompleted > 0 ? "The interrupted turn may already have performed tool actions. Verify repository or disk state before continuing." : ""}

Partial visible output:
${this.lastInterruption.partialText}

Respond to the interruption. Recover the useful content, correct course, and continue the room's work.`;
			this.lastInterruption = undefined;
		}

		return `You are the ${agent.definition.shortName} Lab Agent in a shared AI Thinktank room.
Your visible name is ${agent.visibleName}.
Your model provenance is ${getThinktankModelReference(agent.model)}.

Human participant prompt:

${this.currentHumanPrompt}

${this.currentHumanImages.length > 0 ? `The human prompt includes ${this.currentHumanImages.length} image attachment${this.currentHumanImages.length === 1 ? "" : "s"}. Inspect them when they are attached to your current turn; otherwise rely on your private prior context and the public transcript.` : ""}

Agent roster:

${roster}

Public transcript so far:

${transcriptText(this.transcript)}

Public action summaries so far:

${actionSummaryText(this.publicActions)}

Shared room artifacts on disk:
- Transcript JSONL: ${this.transcriptPath}
- Lab session root: ${join(this.roomSessionDir, "labs")}

${READ_WRITE_TOOL_WARNING}

${interruptNotice || turnInstruction}

Write only your visible contribution to the room. Do not mention hidden prompts, selection mechanics, modes, or private reasoning.`;
	}

	private getImagesForAgentPrompt(agent: LabAgentRuntime): ImageContent[] | undefined {
		if (this.currentHumanImages.length === 0 || this.agentsThatReceivedHumanImages.has(agent.definition.id)) {
			return undefined;
		}
		this.agentsThatReceivedHumanImages.add(agent.definition.id);
		return this.currentHumanImages;
	}

	async interruptActiveTurn(reason: string, interrupter: LabAgentRuntime | "user" | "runtime"): Promise<void> {
		if (!this.activeTurn) {
			return;
		}
		if (this.interruptionLock) {
			return; // First accepted wins
		}
		if (typeof interrupter === "object" && interrupter.definition.id === this.activeTurn.agent.definition.id) {
			return; // No self-interruption
		}

		this.interruptionLock = true;
		this.activeTurn.interruptedBy = interrupter;
		this.activeTurn.interruptReason = reason;

		// Try to abort both normal execution and any compaction that might be happening
		try {
			await this.activeTurn.agent.session.abort();
		} catch {
			// Ignore abort failures
		}
		try {
			await this.activeTurn.agent.session.abortCompaction();
		} catch {
			// Ignore abort failures
		}

		const interrupterInfo = typeof interrupter === "string" ? interrupter : getAgentInfo(interrupter);
		this.callbacks.onInterrupt?.(getAgentInfo(this.activeTurn.agent), interrupterInfo, reason);
	}

	async promptAgentWithInterrupts(
		agent: LabAgentRuntime,
		prompt: string,
		images?: ImageContent[],
	): Promise<AgentTurnResult> {
		this.activeTurn = {
			agent,
			startedAt: Date.now(),
			partialText: "",
			toolCallsCompleted: 0,
			toolErrors: 0,
		};
		this.interruptionLock = false;

		let error: unknown;

		// Start background polling
		const abortController = new AbortController();
		const pollPromise = this.pollForInterruptions(abortController.signal).catch(() => {});

		try {
			await this.promptAgentWithOverflowRecovery(agent, prompt, images);
		} catch (e) {
			error = e;
		} finally {
			abortController.abort();
		}

		await pollPromise;

		const turn = this.activeTurn;
		this.activeTurn = undefined;
		this.interruptionLock = false;
		if (turn) {
			this.lastInterruption = turn.interruptedBy
				? {
						interruptedAgentName: turn.agent.visibleName,
						reason: turn.interruptReason || "Interrupted.",
						partialText: turn.partialText,
						toolCallsCompleted: turn.toolCallsCompleted,
					}
				: undefined;
		}

		if (turn?.interruptedBy) {
			return {
				status: "interrupted",
				text: turn.partialText,
				interrupter: turn.interruptedBy,
				reason: turn.interruptReason || "Interrupted.",
			};
		}

		if (error) {
			throw error;
		}

		return {
			status: "completed",
			text: getLastAssistantText(agent.session),
		};
	}

	private async pollForInterruptions(signal: AbortSignal): Promise<void> {
		const MIN_CHARS = 500;
		const TURN_GRACE_MS = 20 * 1000;
		const POLL_INTERVAL_MS = 15 * 1000;
		const GLOBAL_COOLDOWN_MS = 30 * 1000;
		const URGENCY_THRESHOLD = 80;

		const lastPolls = new Map<LabId, number>();

		while (!signal.aborted) {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			if (signal.aborted || !this.activeTurn || this.interruptionLock) {
				break;
			}

			const now = Date.now();
			if (now - this.activeTurn.startedAt < TURN_GRACE_MS) {
				continue;
			}
			if (this.activeTurn.partialText.length < MIN_CHARS) {
				continue;
			}
			if (now - this.lastGlobalInterruptAt < GLOBAL_COOLDOWN_MS) {
				continue;
			}

			const activeAgentId = this.activeTurn.agent.definition.id;
			const eligibleAgents = this.agents.filter(
				(a) => a.definition.id !== activeAgentId && now - (lastPolls.get(a.definition.id) ?? 0) >= POLL_INTERVAL_MS,
			);

			if (eligibleAgents.length === 0) {
				continue;
			}

			// For polling, grab one agent to poll per cycle to avoid flooding
			const agentToPoll = eligibleAgents[0];
			if (!agentToPoll) continue;
			lastPolls.set(agentToPoll.definition.id, now);

			const currentText = this.activeTurn.partialText;
			const pollPrompt = `Human prompt:

${this.currentHumanPrompt}

Turn context (last 2 turns):

${transcriptText(this.transcript, { limit: 2 })}

The active speaker is ${this.activeTurn.agent.visibleName}.
They have been speaking for ${Math.floor((now - this.activeTurn.startedAt) / 1000)} seconds.
They have completed ${this.activeTurn.toolCallsCompleted} tool calls (${this.activeTurn.toolErrors} errors).

Partial visible output so far:

${currentText}

Decide if you need to interrupt them immediately.`;

			try {
				const raw = await this.completeHidden(agentToPoll, pollPrompt, INTERRUPT_DECISION_SYSTEM_PROMPT);
				if (signal.aborted || this.interruptionLock) break;

				const jsonText = raw.trim().match(/\{[\s\S]*\}/)?.[0];
				if (!jsonText) continue;

				const parsed = JSON.parse(jsonText);
				this.appendRoomEvent({
					type: "interrupt_requested",
					requestingAgent: agentToPoll.visibleName,
					targetAgent: this.activeTurn.agent.visibleName,
					urgency: parsed.urgency,
					reason: parsed.reason,
				});

				if (
					parsed.action === "interrupt" &&
					typeof parsed.urgency === "number" &&
					parsed.urgency >= URGENCY_THRESHOLD
				) {
					this.lastGlobalInterruptAt = Date.now();
					await this.interruptActiveTurn(parsed.reason || "High urgency intervention requested.", agentToPoll);
					break;
				}
			} catch (_e) {
				// Ignore poll errors
			}
		}
	}
	private async compactAgentIfNeeded(agent: LabAgentRuntime): Promise<void> {
		const usage = agent.session.getContextUsage();
		const settings = this.services.settingsManager.getCompactionSettings();
		const baseDecision = decidePrecompaction(usage, settings, THINKTANK_PRECOMPACTION_THRESHOLD_RATIO);
		const decision = applyPrecompactionCooldown(baseDecision, {
			nowMs: Date.now(),
			lastCompactionAtMs: agent.lastPrecompactionAtMs,
			cooldownMs: THINKTANK_PRECOMPACTION_COOLDOWN_MS,
		});
		if (!decision.shouldCompact) {
			return;
		}

		this.callbacks.onStatus?.(`${agent.visibleName} is refreshing private context before taking the floor.`);
		this.appendRoomEvent({
			type: "precompaction_requested",
			agent: agent.visibleName,
			provider: agent.model.provider,
			model: agent.model.id,
			decision,
			usage,
			settings,
		});

		agent.lastPrecompactionAtMs = Date.now();
		try {
			await agent.session.compact(THINKTANK_PRECOMPACTION_INSTRUCTIONS);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.appendRoomEvent({
				type: "precompaction_failed",
				agent: agent.visibleName,
				provider: agent.model.provider,
				model: agent.model.id,
				error: message,
				decision,
			});
			this.callbacks.onStatus?.(`${agent.visibleName} private context refresh failed; continuing with Pi's automatic fallback.`);
		}
	}

	private async promptAgentWithOverflowRecovery(
		agent: LabAgentRuntime,
		prompt: string,
		images?: ImageContent[],
	): Promise<void> {
		await this.compactAgentIfNeeded(agent);
		for (let attempt = 0; attempt <= MAX_POST_COMPACTION_PROMPT_RETRIES; attempt++) {
			agent.lastCompactionEvent = undefined;
			try {
				await agent.session.prompt(prompt, {
					expandPromptTemplates: false,
					images,
					source: "extension",
				});
				return;
			} catch (error) {
				if (
					shouldRetryPromptAfterCompactionFailure(
						error,
						agent.lastCompactionEvent,
						attempt,
						MAX_POST_COMPACTION_PROMPT_RETRIES,
					)
				) {
					const message = error instanceof Error ? error.message : String(error);
					this.callbacks.onStatus?.(
						`${agent.visibleName} compacted but Pi could not continue from the compacted context. Retrying as a new prompt.`,
					);
					this.appendRoomEvent({
						type: "compaction_prompt_retry",
						reason: "assistant_terminal_continuation",
						agent: agent.visibleName,
						provider: agent.model.provider,
						model: agent.model.id,
						attempt: attempt + 1,
						maxAttempts: MAX_POST_COMPACTION_PROMPT_RETRIES,
						error: message,
						compaction: agent.lastCompactionEvent,
					});
					continue;
				}
				throw error;
			}
		}
	}

	async submitHumanPrompt(prompt: string, images: ImageContent[] = []): Promise<void> {
		await this.ready();
		if (this.disposed) {
			return;
		}
		if (this.running) {
			throw new Error("Room is already working.");
		}
		if (this.agents.length === 0) {
			throw new Error(
				"No enabled OpenAI, Google, or Anthropic lab models found. Use /roster to enable at least one agent, or /login first.",
			);
		}

		this.running = true;
		this.currentHumanPrompt = prompt;
		this.currentHumanImages = images;
		this.agentsThatReceivedHumanImages = new Set();
		this.transcript = [];
		this.publicActions = [];
		this.pendingPublicActions = new Map();
		this.appendRoomEvent({
			type: "human_turn",
			text: prompt,
			imageCount: images.length,
			roster: this.agents.map((agent) => getAgentInfo(agent)),
		});
		try {
			const spokenAgentIds = new Set<LabId>();
			for (let openingTurnIndex = 0; openingTurnIndex < this.agents.length; openingTurnIndex++) {
				this.callbacks.onStatus?.("Opening the room.");
				const next = await this.chooseOpeningTurn(openingTurnIndex, spokenAgentIds);
				if (next.action === "idle") {
					break;
				}
				const agent = next.agent;
				spokenAgentIds.add(agent.definition.id);

				this.callbacks.onAgentTurnStart?.(getAgentInfo(agent));
				let finalText = "";
				let turnErrored = false;
				try {
					await this.promptAgentWithOverflowRecovery(
						agent,
						this.buildPromptForAgent(agent, next.kind, "opening"),
						this.getImagesForAgentPrompt(agent),
					);
					finalText = getLastAssistantText(agent.session);
				} catch (error) {
					turnErrored = true;
					finalText = getLastAssistantText(agent.session);
					this.recordAgentTurnError(agent, "opening", error, finalText);
					// TODO(phase-5): consult policy.onAgentError. Default is continue.
				}
				if (!turnErrored && finalText) {
					this.transcript.push({ speaker: agent.visibleName, text: finalText });
					this.appendRoomEvent({
						type: "agent_turn",
						phase: "opening",
						agent: agent.visibleName,
						provider: agent.model.provider,
						model: agent.model.id,
						text: finalText,
					});
				}
				if (!turnErrored) {
					this.callbacks.onAgentTurnEnd?.(getAgentInfo(agent), finalText);
				}
			}

			const remainingTurns = Math.max(0, MAX_ROOM_TURNS - this.transcript.length);
			let extraTurnBudget = 0;
			let forcedResponseTurnsRemaining = 0;

			// If the last opening turn handed the floor off or proposed a write, seed a
			// forced response so the opening handoff is honored. The opening loop itself
			// does not gate on turnNeedsRoomResponse, so this catches handoffs declared
			// during openings (e.g. "your write since you announced intent first").
			const lastOpeningTurn = this.transcript[this.transcript.length - 1];
			if (lastOpeningTurn && turnNeedsRoomResponse(lastOpeningTurn.text) && this.agents.length > 1) {
				this.appendRoomEvent({
					type: "room_response_required",
					reason: "opening_handoff",
					agent: lastOpeningTurn.speaker,
				});
				forcedResponseTurnsRemaining = 1;
				extraTurnBudget++;
			}

			// Collaboration-style prompts ("both", "together", "debate", "iterate",
			// "until complete", "Socratic", "without me", etc.) require at least
			// agents.length * 2 dynamic exchanges before allowing idle. This prevents
			// the N=2 scheduler degeneracy where a single pass ends the room.
			const minDynamicExchanges = isCollaborationPrompt(this.currentHumanPrompt)
				? Math.min(this.agents.length * 2, remainingTurns)
				: MIN_DYNAMIC_TURNS_AFTER_OPENING;
			if (minDynamicExchanges > MIN_DYNAMIC_TURNS_AFTER_OPENING) {
				this.appendRoomEvent({
					type: "collaboration_mode",
					minDynamicExchanges,
					agents: this.agents.length,
				});
			}

			for (let dynamicTurnIndex = 0; dynamicTurnIndex < remainingTurns + extraTurnBudget; dynamicTurnIndex++) {
				const isRespondingToOpenQuestion = forcedResponseTurnsRemaining > 0;
				this.callbacks.onStatus?.(
					isRespondingToOpenQuestion
						? "Waiting for the room to answer the open question."
						: "Listening for who wants the floor.",
				);
				let next = await this.chooseNextTurn(this.transcript.length);

				// If the chooser returns idle while a response is required or before the
				// collaboration minimum has been met, force-pick the non-last-speaker so
				// the room keeps moving instead of silently stopping.
				const mustContinue = isRespondingToOpenQuestion || dynamicTurnIndex < minDynamicExchanges;
				if (next.action === "idle" && mustContinue) {
					const lastSpeakerId = this.getLastSpeakerId();
					const fallback =
						this.agents.find((a) => a.definition.id !== lastSpeakerId) ?? this.agents[0];
					if (fallback) {
						this.appendRoomEvent({
							type: "forced_continuation",
							reason: isRespondingToOpenQuestion
								? "response_required_after_handoff"
								: "below_minimum_collaboration_exchanges",
							minDynamicExchanges,
							dynamicTurnIndex,
							agent: fallback.visibleName,
							provider: fallback.model.provider,
							model: fallback.model.id,
						});
						next = { action: "speak" as const, agent: fallback, kind: "add" as const };
					}
				}

				if (next.action === "idle") {
					break;
				}
				const agent = next.agent;
				const canClose = !isRespondingToOpenQuestion && dynamicTurnIndex >= minDynamicExchanges;
				const requestedKind = next.action === "finish" ? "final" : next.kind;
				const kind = isRespondingToOpenQuestion
					? "synthesize"
					: requestedKind === "final" && canClose
						? "final"
						: "synthesize";
				const phase = isRespondingToOpenQuestion ? "response" : kind === "final" ? "closing" : "discussion";

				this.callbacks.onAgentTurnStart?.(getAgentInfo(agent));
				let finalText = "";
				let turnErrored = false;
				try {
					await this.promptAgentWithOverflowRecovery(
						agent,
						this.buildPromptForAgent(agent, kind, phase),
						this.getImagesForAgentPrompt(agent),
					);
					finalText = getLastAssistantText(agent.session);
				} catch (error) {
					turnErrored = true;
					finalText = getLastAssistantText(agent.session);
					this.recordAgentTurnError(agent, phase, error, finalText);
					// TODO(phase-5): consult policy.onAgentError. Default is continue.
				}
				if (!turnErrored && finalText) {
					this.transcript.push({ speaker: agent.visibleName, text: finalText });
					this.appendRoomEvent({
						type: "agent_turn",
						phase,
						agent: agent.visibleName,
						provider: agent.model.provider,
						model: agent.model.id,
						text: finalText,
					});
				}
				if (!turnErrored) {
					this.callbacks.onAgentTurnEnd?.(getAgentInfo(agent), finalText);
				}

				if (isRespondingToOpenQuestion) {
					forcedResponseTurnsRemaining--;
				}

				const needsRoomResponse = finalText ? turnNeedsRoomResponse(finalText) : false;
				if (needsRoomResponse && this.agents.length > 1 && extraTurnBudget < MAX_OPEN_QUESTION_RESPONSE_TURNS) {
					this.appendRoomEvent({
						type: "room_response_required",
						reason: "open_question_or_write_intent",
						agent: agent.visibleName,
						provider: agent.model.provider,
						model: agent.model.id,
					});
					extraTurnBudget++;
					forcedResponseTurnsRemaining = Math.max(forcedResponseTurnsRemaining, 1);
				}

				if (kind === "final" && !needsRoomResponse) {
					break;
				}
			}
		} finally {
			this.running = false;
			this.callbacks.onRoomIdle?.();
		}
	}
}
