import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { classifyAgentError, type ClassifiedAgentError } from "./agent-error.ts";
import {
	DEFAULT_AGENT_FAILURE_POLICY_OPTIONS,
	evaluateAgentFailure,
	resetAgentFailurePolicyState,
	type AgentFailurePolicyState,
} from "./agent-failure-policy.ts";
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
import type {
	ThinktankAgentMessageLike,
	ThinktankModelLike,
	ThinktankRuntimeDeps,
	ThinktankSessionEventLike,
	ThinktankSessionLike,
	ThinktankServicesLike,
} from "./runtime-deps.ts";
import {
	formatInterruptionRecoveryContext,
	formatInterruptionTranscriptText,
	type InterruptionContext,
} from "./interruption.ts";
import { formatTranscript } from "./transcript-text.ts";
import {
	ABSENT_TRAILER,
	controlTrailerInstructions,
	parseControlTrailer,
	type SpeakerTrailer,
} from "./control-trailer.ts";
import { pickNextSpeaker } from "./scheduler.ts";

export { classifyAgentError, type AgentErrorCategory, type ClassifiedAgentError } from "./agent-error.ts";
export {
	DEFAULT_AGENT_FAILURE_POLICY_OPTIONS,
	evaluateAgentFailure,
	resetAgentFailurePolicyState,
	type AgentFailurePolicyDecision,
	type AgentFailurePolicyOptions,
	type AgentFailurePolicyResult,
	type AgentFailurePolicyState,
} from "./agent-failure-policy.ts";
export {
	formatInterruptionRecoveryContext,
	formatInterruptionTranscriptText,
	type InterruptionContext,
} from "./interruption.ts";
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
	ABSENT_TRAILER,
	controlTrailerInstructions,
	normalizeNextId,
	parseControlTrailer,
	type ParsedTurn,
	type SpeakerTrailer,
} from "./control-trailer.ts";
export {
	pickNextSpeaker,
	type SchedulerDecision,
	type SchedulerInput,
	type SchedulerStopReason,
} from "./scheduler.ts";

export interface ThinktankRoomAgentInfo {
	id: LabId;
	visibleName: string;
	lab: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
}

export type AgentTurnPhase = "opening" | "discussion" | "closing" | "response";

/** Why a room run ended, surfaced to the UI so idle/consensus is legible. */
export type RoomIdleReason =
	| "consensus"
	| "converged"
	| "turn_limit"
	| "halted"
	| "all_suppressed"
	| "no_active_agents"
	| "internal";

export interface RoomIdleSummary {
	reason: RoomIdleReason;
	turns: number;
	lastSpeaker?: string;
}

export interface ThinktankAgentTurnError extends ClassifiedAgentError {
	partialText?: string;
}

export interface ThinktankRoomCallbacks {
	onStatus?(message: string): void;
	onAgentTurnStart?(agent: ThinktankRoomAgentInfo): void;
	onAgentTurnEnd?(agent: ThinktankRoomAgentInfo, text: string): void;
	onAgentTurnError?(agent: ThinktankRoomAgentInfo, phase: AgentTurnPhase, error: ThinktankAgentTurnError): void;
	onAgentEvent?(
		agent: ThinktankRoomAgentInfo,
		session: ThinktankSessionLike,
		event: ThinktankSessionEventLike,
	): void | Promise<void>;
	onInterrupt?(
		interruptedAgent: ThinktankRoomAgentInfo,
		interrupter: ThinktankRoomAgentInfo | "user" | "runtime",
		reason: string,
	): void;
	onRoomIdle?(summary: RoomIdleSummary): void;
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
	model: ThinktankModelLike;
	thinkingLevel: ThinkingLevel;
	visibleName: string;
	session: ThinktankSessionLike;
	lastCompactionEvent?: CompactionRetryState;
	lastPrecompactionAtMs?: number;
	suppressedForCurrentRoom?: boolean;
	suppressionReason?: string;
	unsubscribe: () => void;
}

export interface ThinktankLabSessionInfo {
	id: LabId;
	lab: string;
	active: boolean;
	visibleName?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	sessionDir: string;
	sessionFile?: string;
}

const MAX_ROOM_TURNS = 1000;
const DEFAULT_MAX_ROUNDS = 8;
const MAX_POST_COMPACTION_PROMPT_RETRIES = 1;
// Interactive desktop-control tools excluded from lab agents by default: they
// drive the human participant's physical machine (mouse, keyboard, screen) and
// must not be wielded autonomously by in-room agents. Pass labTools: "all" to
// include them, or an explicit allowlist to choose exactly what is enabled.
const THINKTANK_INTERACTIVE_DESKTOP_TOOLS = [
	"screen_capture",
	"mouse_position",
	"mouse_move",
	"mouse_click",
	"mouse_double_click",
	"mouse_right_click",
	"type_text",
	"press_keys",
	"wait",
	"frontmost_app",
] as const;
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

export function getThinktankRoomSessionDir(cwd: string): string {
	const safeCwd = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(homedir(), ".ai-thinktank", "room-sessions", safeCwd);
}

export function getThinktankLabSessionRoot(cwd: string): string {
	return join(getThinktankRoomSessionDir(cwd), "labs");
}

export function getThinktankTranscriptPath(cwd: string): string {
	return join(getThinktankRoomSessionDir(cwd), "transcript.jsonl");
}

function createRoomSessionDir(cwd: string): string {
	const dir = getThinktankRoomSessionDir(cwd);
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

function getTextFromMessage(message: ThinktankAgentMessageLike): string {
	if (message.role !== "assistant" && message.role !== "user") {
		return "";
	}

	const content = message.content;
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("")
		.trim();
}

function getLastAssistantMessage(session: ThinktankSessionLike): ThinktankAgentMessageLike | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

function getLastAssistantText(session: ThinktankSessionLike): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role === "assistant") {
			return getTextFromMessage(message);
		}
	}
	return "";
}

export function isContextOverflowException(_error: unknown, _model: ThinktankModelLike): boolean {
	// Deprecated. The runtime no longer uses this function; it was kept exported
	// across earlier patches but never called internally or externally.
	// Use ThinktankRuntimeDeps.completeSimple's stopReason/errorMessage handling
	// or shouldRetryPromptAfterCompactionFailure from compaction-retry.ts instead.
	// Stub returns false so any historical caller fails closed.
	return false;
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
	private services: ThinktankServicesLike;
	private deps: ThinktankRuntimeDeps;
	private cwd: string;
	private roomSessionDir: string;
	private callbacks: ThinktankRoomCallbacks;
	private transcriptPath: string;
	private agents: LabAgentRuntime[] = [];
	private transcript: TranscriptTurn[] = [];
	private publicActions: PublicActionSummary[] = [];
	private pendingPublicActions = new Map<string, PublicActionSummary>();
	private failurePolicyStates = new Map<LabId, AgentFailurePolicyState>();
	private standingTrailers = new Map<LabId, SpeakerTrailer>();
	private maxRounds: number;
	private labTools?: readonly string[] | "all";
	private labMemory: "ephemeral" | "persistent";
	private roomHalted = false;
	private currentHumanPrompt = "";
	private currentHumanImages: ImageContent[] = [];
	private agentsThatReceivedHumanImages = new Set<LabId>();
	private running = false;
	private disposed = false;
	private readyPromise: Promise<void>;
	activeTurn?: ActiveRoomTurn;
	interruptionLock = false;
	lastGlobalInterruptAt = 0;
	private lastInterruption?: InterruptionContext;

	constructor(options: {
		services: ThinktankServicesLike;
		deps: ThinktankRuntimeDeps;
		cwd: string;
		rosterSelections: ThinktankRosterModels;
		callbacks: ThinktankRoomCallbacks;
		maxRounds?: number;
		/**
		 * Tool access for lab agents:
		 *  - undefined (default): the built-in coding tools plus all extension/MCP
		 *    tools, minus the interactive desktop-control tools.
		 *  - "all": every registered tool, including desktop control.
		 *  - string[]: an explicit allowlist (exactly these tool names).
		 */
		labTools?: readonly string[] | "all";
		/**
		 * Lab agent private memory:
		 *  - "ephemeral" (default): each lab starts a fresh session; no prior
		 *    on-disk session is auto-resumed across Pi runs.
		 *  - "persistent": resume each lab's most recent session for this cwd
		 *    (carries context across runs).
		 */
		labMemory?: "ephemeral" | "persistent";
	}) {
		this.services = options.services;
		this.deps = options.deps;
		this.cwd = options.cwd;
		this.callbacks = options.callbacks;
		this.maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
		this.labTools = options.labTools;
		this.labMemory = options.labMemory ?? "ephemeral";
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

	get sessionRoot(): string {
		return this.roomSessionDir;
	}

	get labSessionRoot(): string {
		return join(this.roomSessionDir, "labs");
	}

	getLabSessionInfos(): ThinktankLabSessionInfo[] {
		return THINKTANK_LAB_DEFINITIONS.map((definition) => {
			const agent = this.agents.find((candidate) => candidate.definition.id === definition.id);
			return {
				id: definition.id,
				lab: definition.shortName,
				active: agent !== undefined,
				visibleName: agent?.visibleName,
				provider: agent?.model.provider,
				model: agent?.model.id,
				thinkingLevel: agent?.thinkingLevel,
				sessionDir: join(this.roomSessionDir, "labs", definition.id),
				sessionFile: agent?.session.sessionFile,
			};
		});
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
		const availableModels = this.services.modelRegistry.getAvailable() as Model<Api>[];
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
			// Inject the deps clamp so roster.ts doesn't import pi-ai value imports.
			(model, level) =>
				this.deps.clampThinkingLevel(model, level ?? "high") as ThinkingLevel,
		);

		for (const definition of THINKTANK_LAB_DEFINITIONS) {
			const rosterEntry = selectedRoster[definition.id];
			if (!rosterEntry || rosterEntry.disabled) {
				continue;
			}
			const { model, thinkingLevel } = rosterEntry;

			const sessionDir = join(this.roomSessionDir, "labs", definition.id);
			mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
			const created = await this.deps.createLabSession({
				cwd: this.cwd,
				sessionDir,
				services: this.services,
				model,
				thinkingLevel,
				resumeRecentSession: this.labMemory === "persistent",
				...this.resolveLabToolOptions(),
			});

			const labAgent: LabAgentRuntime = {
				definition,
				model,
				thinkingLevel,
				visibleName: getThinktankVisibleName(definition, model),
				session: created.session as ThinktankSessionLike,
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

	// Translate the room's labTools policy into createLabSession options.
	// An explicit allowlist is passed through as `tools`; otherwise the session is
	// created with no allowlist (all tools available) and the adapter activates
	// the full set minus `excludeTools`.
	private resolveLabToolOptions(): { tools?: readonly string[]; excludeTools?: readonly string[] } {
		if (Array.isArray(this.labTools)) {
			return { tools: this.labTools };
		}
		if (this.labTools === "all") {
			return { excludeTools: [] };
		}
		return { excludeTools: [...THINKTANK_INTERACTIVE_DESKTOP_TOOLS] };
	}

	private recordAgentSessionEvent(agent: LabAgentRuntime, event: ThinktankSessionEventLike): void {
		this.recordActiveTurnProgress(agent, event);
		this.recordPublicAction(agent, event);
		this.recordCompactionEvent(agent, event);
	}

	private recordActiveTurnProgress(agent: LabAgentRuntime, event: ThinktankSessionEventLike): void {
		if (!this.activeTurn || this.activeTurn.agent !== agent) {
			return;
		}

		if (event.type === "message_update" && event.message.role === "assistant") {
			const text = getTextFromMessage(event.message);
			if (text) {
				this.activeTurn.partialText = text;
			}
			return;
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			const text = getTextFromMessage(event.message);
			if (text) {
				this.activeTurn.partialText = text;
			}
			return;
		}

		if (event.type === "tool_execution_end") {
			this.activeTurn.toolCallsCompleted++;
			if (event.isError) {
				this.activeTurn.toolErrors++;
			}
		}
	}

	private recordCompactionEvent(agent: LabAgentRuntime, event: ThinktankSessionEventLike): void {
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

		const firstKeptEntryId =
			event.result?.firstKeptEntryId === undefined ? undefined : String(event.result.firstKeptEntryId);
		const state: CompactionRetryState = {
			reason: event.reason,
			willRetry: event.willRetry,
			aborted: event.aborted,
			errorMessage: event.errorMessage,
			tokensBefore: event.result?.tokensBefore,
			firstKeptEntryId,
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
			firstKeptEntryId,
		});
	}

	private recordPublicAction(agent: LabAgentRuntime, event: ThinktankSessionEventLike): void {
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

	private recordInterruptedTurn(agent: LabAgentRuntime, phase: AgentTurnPhase, result: Extract<AgentTurnResult, { status: "interrupted" }>): string {
		const partialText = formatInterruptionTranscriptText(result.text);
		const interrupter = typeof result.interrupter === "string" ? result.interrupter : result.interrupter.visibleName;
		const text = [
			"Interrupted before completion.",
			`Reason: ${result.reason}`,
			`Interrupted by: ${interrupter}`,
			"",
			"Partial visible output:",
			partialText,
		].join("\n");

		this.transcript.push({ speaker: agent.visibleName, text });
		this.appendRoomEvent({
			type: "agent_interrupted",
			phase,
			agent: agent.visibleName,
			provider: agent.model.provider,
			model: agent.model.id,
			interrupter,
			reason: result.reason,
			partialText,
		});
		return text;
	}

	private getUnsuppressedAgentCount(): number {
		return this.agents.filter((agent) => !agent.suppressedForCurrentRoom).length;
	}

	private activeAgents(): LabAgentRuntime[] {
		return this.agents.filter((agent) => !agent.suppressedForCurrentRoom);
	}

	private applyFailurePolicy(agent: LabAgentRuntime, phase: AgentTurnPhase, error: ThinktankAgentTurnError): void {
		const result = evaluateAgentFailure({
			agentId: agent.definition.id,
			category: error.category,
			nowMs: Date.now(),
			previous: this.failurePolicyStates.get(agent.definition.id),
			unsuppressedAgentCountBeforeFailure: this.getUnsuppressedAgentCount(),
			options: DEFAULT_AGENT_FAILURE_POLICY_OPTIONS,
		});
		this.failurePolicyStates.set(agent.definition.id, result.state);

		if (result.decision === "continue") {
			return;
		}

		if (result.decision === "suppress_agent") {
			agent.suppressedForCurrentRoom = true;
			agent.suppressionReason = `${result.reason}: ${error.category}`;
			const text = `${agent.visibleName} is suppressed for the rest of this room after ${result.state.count} consecutive ${error.category} failures.`;
			this.transcript.push({ speaker: "system", text });
			this.appendRoomEvent({
				type: "agent_suppressed",
				phase,
				agent: agent.visibleName,
				provider: agent.model.provider,
				model: agent.model.id,
				category: error.category,
				count: result.state.count,
				reason: result.reason,
			});
			return;
		}

		this.roomHalted = true;
		const text = `Thinktank room halted: ${agent.visibleName} is the last active Lab Agent and hit ${result.state.count} consecutive ${error.category} failures.`;
		this.transcript.push({ speaker: "system", text });
		this.appendRoomEvent({
			type: "room_halted",
			phase,
			agent: agent.visibleName,
			provider: agent.model.provider,
			model: agent.model.id,
			category: error.category,
			count: result.state.count,
			reason: result.reason,
		});
	}

	private recordAgentTurnSuccess(agent: LabAgentRuntime): void {
		this.failurePolicyStates = resetAgentFailurePolicyState(this.failurePolicyStates, agent.definition.id);
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
		this.applyFailurePolicy(agent, phase, turnError);
		return turnError;
	}

	private async completeHidden(
		agent: LabAgentRuntime,
		prompt: string,
		systemPrompt: string,
	): Promise<string> {
		const auth = await this.services.modelRegistry.getApiKeyAndHeaders(agent.model);
		if (!auth.ok) {
			throw new Error(auth.error);
		}
		const model = agent.model as Model<Api>;
		const reasoning = this.deps.clampThinkingLevel(model, "low");
		const message = await this.deps.completeSimple(
			model,
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

	private getMentionedAgentIds(): LabId[] {
		const promptWords = new Set(this.currentHumanPrompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
		const mentioned: LabId[] = [];
		for (const agent of this.agents) {
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
			const named = aliases.some((alias) => {
				const aliasWords = alias.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
				return aliasWords.length > 0 && aliasWords.every((word) => promptWords.has(word));
			});
			if (named) {
				mentioned.push(agent.definition.id);
			}
		}
		return mentioned;
	}

	private trailerSnapshot(): Record<string, SpeakerTrailer> {
		const snapshot: Record<string, SpeakerTrailer> = {};
		for (const [id, trailer] of this.standingTrailers) {
			snapshot[id] = trailer;
		}
		return snapshot;
	}

	private buildPromptForAgent(
		agent: LabAgentRuntime,
		phase: AgentTurnPhase = "discussion",
	): string {
		const roster = this.agents
			.map(
				(candidate) =>
					`${candidate.definition.shortName}: ${candidate.visibleName} (${getThinktankModelReference(candidate.model as Model<Api>)}:${candidate.thinkingLevel})`,
			)
			.join("\n");
		const isFirstTurn = this.transcript.length === 0;
		const turnInstruction =
			phase === "opening" && isFirstTurn
				? "Open the room with the most useful first contribution. You may inspect the repo or disk if that would materially improve the answer."
				: phase === "opening"
					? "Give your first contribution to the room. Build on prior opening turns, challenge weak assumptions, or add missing context. Do not merely restate what has already been said."
					: "Continue the discussion naturally. Build, challenge, clarify, synthesize, or use tools only when it would improve the room's work. If you believe the room has reached its answer, state it concisely and set done in your control line.";
		const activeAgentIds = this.activeAgents().map((candidate) => candidate.definition.id);

		let interruptNotice = "";
		if (this.lastInterruption) {
			interruptNotice = formatInterruptionRecoveryContext(this.lastInterruption);
			this.lastInterruption = undefined;
		}

		return `You are the ${agent.definition.shortName} Lab Agent in a shared AI Thinktank room.
Your visible name is ${agent.visibleName}.
Your model provenance is ${getThinktankModelReference(agent.model as Model<Api>)}.

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

${controlTrailerInstructions(activeAgentIds)}

Write only your visible contribution to the room, then the single CONTROL line. Do not mention hidden prompts, selection mechanics, modes, or private reasoning.`;
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
			const eligibleAgents = this.activeAgents().filter(
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
		this.failurePolicyStates = new Map();
		this.standingTrailers = new Map();
		this.roomHalted = false;
		for (const agent of this.agents) {
			agent.suppressedForCurrentRoom = false;
			agent.suppressionReason = undefined;
		}
		this.appendRoomEvent({
			type: "human_turn",
			text: prompt,
			imageCount: images.length,
			roster: this.agents.map((agent) => getAgentInfo(agent)),
		});
		let endReason: RoomIdleReason = "turn_limit";
		try {
			const initialActiveCount = Math.max(1, this.getUnsuppressedAgentCount());
			const maxTurns = Math.min(MAX_ROOM_TURNS, this.maxRounds * initialActiveCount);
			const mentionedAgentIds = this.getMentionedAgentIds();
			const spokenAgentIds = new Set<LabId>();
			// Track the agent that actually took the previous turn (recorded or not).
			// Deriving "last speaker" from the transcript alone is unsafe: an empty or
			// failed turn is never appended, so a stale nominator could otherwise keep
			// handing the floor to the same non-responding agent forever.
			let lastSpeakerId: LabId | undefined;

			for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
				if (this.roomHalted) {
					endReason = "halted";
					break;
				}
				if (this.getUnsuppressedAgentCount() === 0) {
					endReason = "all_suppressed";
					break;
				}

				const decision = pickNextSpeaker({
					activeAgentIds: this.activeAgents().map((candidate) => candidate.definition.id),
					lastSpeakerId,
					spokenAgentIds: [...spokenAgentIds],
					trailers: this.trailerSnapshot(),
					mentionedAgentIds,
				});
				this.appendRoomEvent({ type: "turn_selection", turnIndex, decision });
				if (decision.action === "stop") {
					endReason =
						decision.reason === "all_done"
							? "consensus"
							: decision.reason === "converged"
								? "converged"
								: "no_active_agents";
					break;
				}

				const agent = this.agents.find((candidate) => candidate.definition.id === decision.agentId);
				if (!agent) {
					endReason = "internal";
					break;
				}
				const phase: AgentTurnPhase = decision.reason === "opening" ? "opening" : "discussion";
				const activeAgentIds = this.activeAgents().map((candidate) => candidate.definition.id);

				spokenAgentIds.add(agent.definition.id);
				this.callbacks.onStatus?.(phase === "opening" ? "Opening the room." : "Discussing.");
				this.callbacks.onAgentTurnStart?.(getAgentInfo(agent));

				let finalText = "";
				let trailer: SpeakerTrailer = { ...ABSENT_TRAILER };
				let turnErrored = false;
				let turnInterrupted = false;
				try {
					const result = await this.promptAgentWithInterrupts(
						agent,
						this.buildPromptForAgent(agent, phase),
						this.getImagesForAgentPrompt(agent),
					);
					if (result.status === "interrupted") {
						turnInterrupted = true;
						finalText = this.recordInterruptedTurn(agent, phase, result);
					} else {
						// Some providers report a failed turn without throwing: prompt()
						// resolves but the last assistant message carries stopReason
						// "error"/"aborted" and no content. Surface it as a real failure
						// instead of silently treating it as an (empty) completed turn.
						const lastMessage = getLastAssistantMessage(agent.session);
						const stop = lastMessage?.stopReason;
						if (stop === "error" || stop === "aborted") {
							turnErrored = true;
							const message = lastMessage?.errorMessage || `${agent.visibleName} turn reported stopReason "${stop}"`;
							this.recordAgentTurnError(agent, phase, new Error(message));
						} else {
							const parsed = parseControlTrailer(result.text, activeAgentIds);
							finalText = parsed.visibleText;
							// A turn with no visible contribution does not earn the floor
							// again: treat it as a yield so the scheduler moves on.
							trailer = finalText ? parsed.trailer : { ...ABSENT_TRAILER };
						}
					}
				} catch (error) {
					turnErrored = true;
					const parsed = parseControlTrailer(getLastAssistantText(agent.session), activeAgentIds);
					finalText = parsed.visibleText;
					this.recordAgentTurnError(agent, phase, error, finalText);
				}

				if (!turnErrored && !turnInterrupted && finalText) {
					this.transcript.push({ speaker: agent.visibleName, text: finalText });
					this.appendRoomEvent({
						type: "agent_turn",
						phase,
						agent: agent.visibleName,
						provider: agent.model.provider,
						model: agent.model.id,
						text: finalText,
						trailer,
					});
				}

				// Record the standing trailer the scheduler reads next. Only a cleanly
				// completed turn carries a meaningful signal; interrupted/errored turns
				// reset to absent so the agent is not auto-selected (it can still be
				// nominated by a peer's handoff).
				this.standingTrailers.set(
					agent.definition.id,
					!turnErrored && !turnInterrupted ? trailer : { ...ABSENT_TRAILER },
				);
				lastSpeakerId = agent.definition.id;

				if (!turnErrored) {
					this.recordAgentTurnSuccess(agent);
					this.callbacks.onAgentTurnEnd?.(getAgentInfo(agent), finalText);
				}
			}
		} finally {
			this.running = false;
			const idleSummary: RoomIdleSummary = {
				reason: endReason,
				turns: this.transcript.length,
				lastSpeaker: this.transcript[this.transcript.length - 1]?.speaker,
			};
			this.appendRoomEvent({ type: "room_idle", ...idleSummary });
			this.callbacks.onRoomIdle?.(idleSummary);
		}
	}
}
