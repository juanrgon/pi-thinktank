import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { clampThinkingLevel, completeSimple, isContextOverflow } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	getThinktankModelReference,
	getThinktankVisibleName,
	type LabId,
	selectDefaultThinktankRosterModels,
	THINKTANK_LAB_DEFINITIONS,
	type ThinktankLabDefinition,
	type ThinktankRosterModels,
} from "./roster.ts";

type TurnImpulseKind = "add" | "challenge" | "clarify" | "synthesize" | "final" | "none";

interface TurnImpulse {
	action: "speak" | "finish" | "pass";
	kind: TurnImpulseKind;
	urgency: number;
	reason?: string;
}

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

export interface ThinktankRoomCallbacks {
	onStatus?(message: string): void;
	onAgentTurnStart?(agent: ThinktankRoomAgentInfo): void;
	onAgentTurnEnd?(agent: ThinktankRoomAgentInfo, text: string): void;
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
	unsubscribe: () => void;
}

const MAX_ROOM_TURNS = 10;
const MIN_DYNAMIC_TURNS_AFTER_OPENING = 0;
const MIN_URGENCY_TO_SPEAK = 18;
const MAX_CONTEXT_OVERFLOW_RETRIES = 1;
const MAX_OPEN_QUESTION_RESPONSE_TURNS = 2;
const READ_WRITE_TOOL_WARNING = `Tool use is public in this room. Reads, searches, and bash exploration may proceed.
Before edits, writes, or destructive shell commands, state the intended change in the public conversation and wait for the room to converge.`;

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
Most thoughts are not worth saying. Pass unless your contribution would clearly improve the conversation now.
Speak when you have a useful addition, correction, challenge, clarification, synthesis, or final answer.
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

function isContextOverflowException(error: unknown, model: Model<Api>): boolean {
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

function transcriptText(turns: TranscriptTurn[]): string {
	if (turns.length === 0) {
		return "(No Lab Agent has spoken yet.)";
	}
	return turns.map((turn) => `${turn.speaker}:\n${turn.text}`).join("\n\n");
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

function parseTurnImpulse(text: string): TurnImpulse | undefined {
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

function turnNeedsRoomResponse(text: string): boolean {
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

	return asksRoomForCoordination || endsWithCoordinationQuestion || proposesImmediateWrite;
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
			const sessionManager = SessionManager.create(this.cwd, sessionDir);
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
				this.recordPublicAction(labAgent, event);
				void this.callbacks.onAgentEvent?.(getAgentInfo(labAgent), created.session, event);
			});
			this.agents.push(labAgent);
		}
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
			this.publicActions.push({
				agent: agent.visibleName,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
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

		const existing = [...this.publicActions]
			.reverse()
			.find(
				(action) =>
					action.agent === agent.visibleName &&
					action.toolCallId === event.toolCallId &&
					action.result === undefined,
			);
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
	}

	private appendRoomEvent(entry: Record<string, unknown>): void {
		appendFileSync(this.transcriptPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
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

	private async chooseOpeningTurn(
		turnIndex: number,
		spokenAgentIds: Set<LabId>,
	): Promise<{ action: "speak"; agent: LabAgentRuntime; kind: TurnImpulseKind } | { action: "idle" }> {
		const lastSpeakerId = this.getLastSpeakerId();
		const candidates = this.agents.filter(
			(agent) => !spokenAgentIds.has(agent.definition.id) && agent.definition.id !== lastSpeakerId,
		);
		const eligibleAgents =
			candidates.length > 0 ? candidates : this.agents.filter((agent) => !spokenAgentIds.has(agent.definition.id));
		if (eligibleAgents.length === 0) {
			return { action: "idle" };
		}

		const impulseResults = await Promise.all(
			eligibleAgents.map(async (agent): Promise<RankedTurnImpulse> => {
				try {
					const raw = await this.completeHidden(
						agent,
						`Human prompt:

${this.currentHumanPrompt}

Your identity:
${agent.definition.shortName}: ${agent.visibleName} (${getThinktankModelReference(agent.model)})

Opening turn number:
${turnIndex + 1}

Public transcript:

${transcriptText(this.transcript)}

You have not yet given your first visible contribution. Decide whether you should take the floor now.
The room is still opening, so do not finish the discussion. If you speak, contribute something useful rather than repeating prior turns. If you have nothing useful to add, pass; the room may go quiet.`,
					);
					const impulse = parseTurnImpulse(raw) ?? { action: "pass" as const, kind: "none" as const, urgency: 0 };
					return {
						agent,
						impulse: impulse.action === "finish" ? { ...impulse, action: "speak", kind: "synthesize" } : impulse,
					};
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
			.filter((entry) => entry.impulse.action === "speak")
			.sort((a, b) => b.impulse.urgency - a.impulse.urgency)[0];
		if (!strongest || strongest.impulse.urgency < MIN_URGENCY_TO_SPEAK) {
			if (turnIndex === 0) {
				return { action: "speak", agent: eligibleAgents[0]!, kind: "add" };
			}
			return { action: "idle" };
		}
		return {
			action: "speak",
			agent: strongest.agent,
			kind: strongest.impulse.kind === "none" ? "add" : strongest.impulse.kind,
		};
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

${transcriptText(this.transcript)}

Public action summaries:

${actionSummaryText(this.publicActions)}

Decide whether you want to take the next visible turn. Pass unless you have something worth adding now. If nothing is worth saying, pass; the room may go quiet.`,
					);
					return {
						agent,
						impulse: parseTurnImpulse(raw) ?? { action: "pass", kind: "none", urgency: 0 },
					};
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

		if (!strongest || strongest.impulse.urgency < MIN_URGENCY_TO_SPEAK) {
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

${transcriptText(this.transcript.slice(-2))}

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
	private async promptAgentWithOverflowRecovery(
		agent: LabAgentRuntime,
		prompt: string,
		images?: ImageContent[],
	): Promise<void> {
		for (let attempt = 0; attempt <= MAX_CONTEXT_OVERFLOW_RETRIES; attempt++) {
			try {
				await agent.session.prompt(prompt, {
					expandPromptTemplates: false,
					images,
					source: "extension",
				});
				return;
			} catch (error) {
				const canRecover = attempt < MAX_CONTEXT_OVERFLOW_RETRIES && isContextOverflowException(error, agent.model);
				if (!canRecover) {
					throw error;
				}

				this.callbacks.onStatus?.(`${agent.visibleName} hit the context limit. Compacting and retrying.`);
				this.appendRoomEvent({
					type: "compaction_start",
					reason: "overflow",
					agent: agent.visibleName,
					provider: agent.model.provider,
					model: agent.model.id,
				});

				try {
					const result = await agent.session.compact(
						"Summarize this Lab Agent's private room-session context so it can continue the shared AI Thinktank discussion. Preserve the human's goals, prior Lab Agent conclusions, public tool actions, important files or commands, and any unresolved decisions. Keep the summary compact enough to avoid another context overflow.",
					);
					this.appendRoomEvent({
						type: "compaction_end",
						reason: "overflow",
						agent: agent.visibleName,
						provider: agent.model.provider,
						model: agent.model.id,
						tokensBefore: result.tokensBefore,
						firstKeptEntryId: result.firstKeptEntryId,
					});
				} catch (compactionError) {
					const message = compactionError instanceof Error ? compactionError.message : String(compactionError);
					this.appendRoomEvent({
						type: "compaction_end",
						reason: "overflow",
						agent: agent.visibleName,
						provider: agent.model.provider,
						model: agent.model.id,
						error: message,
					});
					throw new Error(`${agent.visibleName} hit the context limit, and compaction failed: ${message}`);
				}
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
				await this.promptAgentWithOverflowRecovery(
					agent,
					this.buildPromptForAgent(agent, next.kind, "opening"),
					this.getImagesForAgentPrompt(agent),
				);
				const finalText = getLastAssistantText(agent.session);
				if (finalText) {
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
				this.callbacks.onAgentTurnEnd?.(getAgentInfo(agent), finalText);
			}

			const remainingTurns = Math.max(0, MAX_ROOM_TURNS - this.transcript.length);
			let extraTurnBudget = 0;
			let forcedResponseTurnsRemaining = 0;
			for (let dynamicTurnIndex = 0; dynamicTurnIndex < remainingTurns + extraTurnBudget; dynamicTurnIndex++) {
				const isRespondingToOpenQuestion = forcedResponseTurnsRemaining > 0;
				this.callbacks.onStatus?.(
					isRespondingToOpenQuestion
						? "Waiting for the room to answer the open question."
						: "Listening for who wants the floor.",
				);
				const next = await this.chooseNextTurn(this.transcript.length);
				if (next.action === "idle") {
					break;
				}
				const agent = next.agent;
				const canClose = !isRespondingToOpenQuestion && dynamicTurnIndex >= MIN_DYNAMIC_TURNS_AFTER_OPENING;
				const requestedKind = next.action === "finish" ? "final" : next.kind;
				const kind = isRespondingToOpenQuestion
					? "synthesize"
					: requestedKind === "final" && canClose
						? "final"
						: "synthesize";
				const phase = isRespondingToOpenQuestion ? "response" : kind === "final" ? "closing" : "discussion";

				this.callbacks.onAgentTurnStart?.(getAgentInfo(agent));
				await this.promptAgentWithOverflowRecovery(
					agent,
					this.buildPromptForAgent(agent, kind, phase),
					this.getImagesForAgentPrompt(agent),
				);
				const finalText = getLastAssistantText(agent.session);
				if (finalText) {
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
				this.callbacks.onAgentTurnEnd?.(getAgentInfo(agent), finalText);

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
