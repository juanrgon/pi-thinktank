import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionServices,
	createAgentSessionServices,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { ClassifiedAgentError } from "./agent-error.ts";
import { defaultRuntimeDeps } from "./runtime-default-deps.ts";
import { parseControlTrailer } from "./control-trailer.ts";
import {
	type AgentTurnPhase,
	getThinktankLabSessionRoot,
	getThinktankRoomSessionDir,
	getThinktankTranscriptPath,
	type RoomIdleSummary,
	type ThinktankLabSessionInfo,
	type ThinktankRoomMode,
	type TurnPresentation,
	type ThinktankRoomAgentInfo,
	ThinktankRoomRuntime,
} from "./room-runtime.ts";
import {
	getThinktankRosterEntryReference,
	selectThinktankRoster,
	type ThinktankAgentRosterSelections,
	type ThinktankRoster,
} from "./roster.ts";
import { RosterSelectorComponent } from "./roster-selector.ts";
import type { ThinktankSessionEventLike } from "./runtime-deps.ts";

const MESSAGE_TYPE = "thinktank-room";
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const LIVE_TEXT_LIMIT = 5000;
const LIVE_THINKING_LIMIT = 2200;
const LIVE_TOOL_ARGS_LIMIT = 1000;
const ROSTER_SETTINGS_PATH = join(homedir(), ".ai-thinktank", "settings.json");

type ThinktankMessageKind = "roster" | "human" | "agent" | "tool" | "status" | "error";

interface ThinktankSettings {
	enabled?: boolean;
	roster?: unknown;
	roomMode?: ThinktankRoomMode;
	leaderLedMaxTurns?: number;
}

interface ThinktankToolMessage {
	agent: ThinktankRoomAgentInfo;
	toolName: string;
	toolCallId: string;
	phase: "start" | "end";
	args?: unknown;
	result?: unknown;
	isError?: boolean;
}

interface ThinktankRoomMessageDetails {
	kind: ThinktankMessageKind;
	title?: string;
	text?: string;
	agent?: ThinktankRoomAgentInfo;
	tool?: ThinktankToolMessage;
	roster?: string;
	imageCount?: number;
	transcriptFile?: string;
	timestamp: number;
}

interface QueuedRoomPrompt {
	ctx: ExtensionContext;
	text: string;
	images: ImageContent[];
}

interface LiveToolCall {
	name: string;
	args: unknown;
}

interface LiveRoomState {
	visible: boolean;
	status: string;
	agent?: ThinktankRoomAgentInfo;
	text: string;
	thinking: string;
	toolCalls: LiveToolCall[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)
		? (value as ThinkingLevel)
		: undefined;
}

function readThinktankSettings(): ThinktankSettings {
	if (!existsSync(ROSTER_SETTINGS_PATH)) {
		return {};
	}
	try {
		const parsed = JSON.parse(readFileSync(ROSTER_SETTINGS_PATH, "utf8")) as unknown;
		return isObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeThinktankSettings(settings: ThinktankSettings): void {
	mkdirSync(join(homedir(), ".ai-thinktank"), { recursive: true, mode: 0o700 });
	writeFileSync(ROSTER_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readThinktankEnabled(): boolean {
	return readThinktankSettings().enabled ?? false;
}

function persistThinktankEnabled(enabled: boolean): void {
	writeThinktankSettings({ ...readThinktankSettings(), enabled });
}

function readSavedRosterSelections(): ThinktankAgentRosterSelections {
	const saved = readThinktankSettings().roster;
	const rawEntries: Array<{ id?: unknown; value: unknown }> = Array.isArray(saved)
		? saved.map((value) => ({ value, id: isObject(value) ? value.id : undefined }))
		: isObject(saved)
			? Object.entries(saved).map(([id, value]) => ({ id, value }))
			: [];
	const selections: ThinktankAgentRosterSelections = [];

	for (const raw of rawEntries) {
		const entry = raw.value;
		if (!isObject(entry) || typeof raw.id !== "string" || typeof entry.provider !== "string" || typeof entry.model !== "string") {
			continue;
		}
		selections.push({
			id: raw.id,
			provider: entry.provider,
			model: entry.model,
			thinkingLevel: normalizeThinkingLevel(entry.thinkingLevel),
			disabled: entry.disabled === true,
			role: entry.role === "leader" || entry.role === "advisor" ? entry.role : undefined,
		});
	}

	return selections;
}

function persistRosterSelections(roster: ThinktankRoster): void {
	const settings = readThinktankSettings();
	const saved = roster.map((entry) => ({
		id: entry.id,
		provider: entry.model.provider,
		model: entry.model.id,
		thinkingLevel: entry.thinkingLevel,
		disabled: entry.disabled,
		role: entry.role,
	}));
	writeThinktankSettings({ ...settings, roster: saved });
}

function resolveRoomMode(roster: ThinktankRoster): ThinktankRoomMode {
	const saved = readThinktankSettings().roomMode;
	if (saved === "leader-led" || saved === "debate") return saved;
	return roster.some((entry) => !entry.disabled && entry.role === "leader") ? "leader-led" : "debate";
}

function persistRoomMode(roomMode: ThinktankRoomMode): void {
	writeThinktankSettings({ ...readThinktankSettings(), roomMode });
}

function hasValidLeader(roster: ThinktankRoster): boolean {
	return roster.filter((entry) => !entry.disabled && entry.role === "leader").length === 1;
}

function refreshAvailableModels(ctx: ExtensionContext): Model<Api>[] {
	ctx.modelRegistry.refresh();
	return ctx.modelRegistry.getAvailable();
}

function resolveRoster(ctx: ExtensionContext): ThinktankRoster {
	return selectThinktankRoster(refreshAvailableModels(ctx), readSavedRosterSelections());
}

function formatRoster(roster: ThinktankRoster): string {
	if (roster.length === 0) {
		return "no agents";
	}
	return roster
		.map((entry, index) => `${index + 1}: ${entry.role === "leader" ? "leader " : "advisor "}${entry.disabled ? "disabled " : ""}${getThinktankRosterEntryReference(entry)}`)
		.join(" | ");
}

function formatLabSessionInfo(info: ThinktankLabSessionInfo): string {
	const configured = info.provider && info.model ? `${info.provider}/${info.model}:${info.thinkingLevel}` : "not configured";
	const role = info.role ? `${info.role}; ` : "";
	const status = info.active ? `${info.visibleName ?? info.lab} (${role}${configured})` : `${role}${configured}`;
	const sessionFile = info.sessionFile ? `\n  session file: \`${info.sessionFile}\`` : "";
	return `- **${info.lab}**: ${status}\n  directory: \`${info.sessionDir}\`${sessionFile}`;
}

function formatThinktankSessions(ctx: ExtensionContext, activeRoom: ThinktankRoomRuntime | undefined): string {
	const roomSessionRoot = activeRoom?.sessionRoot ?? getThinktankRoomSessionDir(ctx.cwd);
	const labSessionRoot = activeRoom?.labSessionRoot ?? getThinktankLabSessionRoot(ctx.cwd);
	const transcriptFile = activeRoom?.transcriptFile ?? getThinktankTranscriptPath(ctx.cwd);
	const labs: ThinktankLabSessionInfo[] =
		activeRoom?.getLabSessionInfos() ??
		resolveRoster(ctx).map((entry, index) => ({
			id: entry.id,
			lab: `Agent ${index + 1}`,
			active: false,
			provider: entry.model.provider,
			model: entry.model.id,
			thinkingLevel: entry.thinkingLevel,
			role: entry.role,
			sessionDir: join(labSessionRoot, `agent-${entry.id.replace(/[^a-zA-Z0-9._-]/g, "-") || "unnamed"}`),
		}));

	return [
		activeRoom ? "Active Thinktank room session:" : "No active Thinktank room has been created yet. These paths will be used when it starts:",
		"",
		`- Structured room transcript: \`${transcriptFile}\``,
		`- Room session root: \`${roomSessionRoot}\``,
		`- Lab session root: \`${labSessionRoot}\``,
		"",
		"Lab sessions:",
		...labs.map(formatLabSessionInfo),
	].join("\n");
}

function preview(value: unknown, maxLength = 900): string {
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(value, null, 2);
		} catch {
			text = String(value);
		}
	}

	text = text.trim();
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}...`;
}

function tailText(text: string, maxLength: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) {
		return trimmed;
	}
	return `...${trimmed.slice(-maxLength)}`;
}

function codeBlock(language: string, content: string): string {
	const longestBacktickRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
	return `${fence}${language}\n${content}\n${fence}`;
}

function formatToolArgsMarkdown(toolName: string, args: unknown, maxLength: number): string {
	if (toolName === "execute_typescript" && isObject(args) && typeof args.code === "string") {
		return codeBlock("typescript", preview(args.code, maxLength));
	}
	return codeBlock("json", preview(args, maxLength));
}

function formatToolText(tool: ThinktankToolMessage): string {
	if (tool.phase === "start") {
		return `Calling \`${tool.toolName}\`\n\n${formatToolArgsMarkdown(tool.toolName, tool.args, 700)}`;
	}

	const status = tool.isError ? "finished with an error" : "finished";
	return `\`${tool.toolName}\` ${status}\n\n\`\`\`json\n${preview(tool.result, 900)}\n\`\`\``;
}

function isThinktankRoomMessageDetails(value: unknown): value is ThinktankRoomMessageDetails {
	return isObject(value) && typeof value.kind === "string";
}

function addMarkdown(
	container: { addChild(component: Component): void },
	text: string,
	color: (text: string) => string,
): void {
	container.addChild(
		new Markdown(text, 0, 0, getMarkdownTheme(), {
			color,
		}),
	);
}

function extractLiveStateFromAssistantMessage(
	message: AssistantMessage,
): Pick<LiveRoomState, "text" | "thinking" | "toolCalls"> {
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	const toolCalls: LiveToolCall[] = [];

	for (const content of message.content) {
		if (content.type === "text" && content.text.trim()) {
			textParts.push(content.text);
		} else if (content.type === "thinking" && content.thinking.trim() && !content.redacted) {
			thinkingParts.push(content.thinking);
		} else if (content.type === "toolCall") {
			toolCalls.push({ name: content.name, args: content.arguments });
		}
	}

	// Hide the CONTROL routing trailer from the live stream. parseControlTrailer
	// strips both a completed trailer and an in-progress one (a dangling
	// "CONTROL:" with no closed JSON yet), so the user never sees control syntax.
	const visibleText = parseControlTrailer(textParts.join("\n\n")).visibleText;

	return {
		text: tailText(visibleText, LIVE_TEXT_LIMIT),
		thinking: tailText(thinkingParts.join("\n\n"), LIVE_THINKING_LIMIT),
		toolCalls,
	};
}

function formatRoomIdle(summary: RoomIdleSummary): { title: string; text: string; status: string } {
	const turns = `${summary.turns} turn${summary.turns === 1 ? "" : "s"}`;
	const yourTurn = "\n\n**Your turn** — reply to continue the room, or `/thinktank off` to stop.";
	switch (summary.reason) {
		case "consensus":
			return {
				title: "✓ Room reached consensus",
				text: `The agents agreed the discussion is complete after ${turns}.${yourTurn}`,
				status: "Thinktank: consensus · your turn",
			};
		case "converged":
			return {
				title: "✓ Room settled",
				text: `No agent had more to add after ${turns}.${yourTurn}`,
				status: "Thinktank: settled · your turn",
			};
		case "leader_final":
			return {
				title: "✓ Leader finished",
				text: `The leader completed the request after ${turns}.${yourTurn}`,
				status: "Thinktank: leader finished · your turn",
			};
		case "leader_unavailable":
			return {
				title: "⚠ Leader unavailable",
				text: `The configured leader could not complete the room. Select a leader or switch to debate mode.${yourTurn}`,
				status: "Thinktank: leader unavailable · your turn",
			};
		case "turn_limit":
			return {
				title: "⏸ Room paused — turn limit reached",
				text: `The room hit its turn budget after ${turns} without a final answer.${yourTurn}`,
				status: "Thinktank: paused (turn limit) · your turn",
			};
		case "halted":
			return {
				title: "⚠ Room halted — repeated agent failures",
				text: `The last active agent kept failing after ${turns}; see the error(s) above.${yourTurn}`,
				status: "Thinktank: halted · your turn",
			};
		case "all_suppressed":
			return {
				title: "⚠ Room idle — all agents suppressed",
				text: `Every agent was suppressed after repeated failures.${yourTurn}`,
				status: "Thinktank: idle (suppressed) · your turn",
			};
		case "no_active_agents":
			return {
				title: "Room idle — no active agents",
				text: "No enabled agents are available. Use `/thinktank roster` to add models, or `/login`.",
				status: "Thinktank: idle (no agents)",
			};
		default:
			return {
				title: "Room idle",
				text: `The room is idle after ${turns}.${yourTurn}`,
				status: "Thinktank: idle · your turn",
			};
	}
}

function formatAgentTurnErrorText(error: ClassifiedAgentError & { partialText?: string }): string {
	const lines = [`Category: \`${error.category}\``, "", error.summary];
	if (error.hint) {
		lines.push("", `Hint: ${error.hint}`);
	}
	if (error.partialText) {
		lines.push("", "Partial output before failure:", "", error.partialText);
	}
	return lines.join("\n");
}

class LiveRoomWidget implements Component {
	private getState: () => LiveRoomState;
	private theme: Theme;

	constructor(getState: () => LiveRoomState, theme: Theme) {
		this.getState = getState;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		if (!state.visible) {
			return [];
		}

		const box = new Box(1, 1, (content) => this.theme.bg("customMessageBg", content));
		const title = state.agent
			? `Live: ${state.agent.visibleName} ${this.theme.fg(
					"dim",
					`[${state.agent.provider}/${state.agent.model}:${state.agent.thinkingLevel}]`,
				)}`
			: "Live: Thinktank";
		box.addChild(new Text(this.theme.fg("customMessageLabel", this.theme.bold(title)), 0, 0));

		if (state.status) {
			box.addChild(new Text(this.theme.fg("muted", state.status), 0, 0));
		}

		if (state.thinking) {
			box.addChild(new Spacer(1));
			box.addChild(new Text(this.theme.italic(this.theme.fg("thinkingText", "Thinking")), 0, 0));
			addMarkdown(box, state.thinking, (content) => this.theme.italic(this.theme.fg("thinkingText", content)));
		}

		if (state.text) {
			box.addChild(new Spacer(1));
			addMarkdown(box, state.text, (content) => this.theme.fg("customMessageText", content));
		}

		for (const toolCall of state.toolCalls) {
			box.addChild(new Spacer(1));
			box.addChild(new Text(this.theme.fg("warning", `Preparing tool: ${toolCall.name}`), 0, 0));
			addMarkdown(box, formatToolArgsMarkdown(toolCall.name, toolCall.args, LIVE_TOOL_ARGS_LIMIT), (content) =>
				this.theme.fg("toolOutput", content),
			);
		}

		if (!state.text && !state.thinking && state.toolCalls.length === 0) {
			box.addChild(new Spacer(1));
			box.addChild(new Text(this.theme.fg("muted", "Waiting for streamed output from the active model."), 0, 0));
		}

		return box.render(width);
	}
}

function renderBoxed(details: ThinktankRoomMessageDetails, theme: ExtensionContext["ui"]["theme"]): Box {
	const box = new Box(1, 1, (content) => theme.bg("customMessageBg", content));
	const title = details.title ?? "Thinktank";
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(title)), 0, 0));
	if (details.text) {
		box.addChild(new Spacer(1));
		addMarkdown(box, details.text, (content) => theme.fg("customMessageText", content));
	}
	return box;
}

function renderHumanMessage(details: ThinktankRoomMessageDetails, theme: ExtensionContext["ui"]["theme"]): Container {
	const container = new Container();
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (content) => theme.bg("userMessageBg", content));
	const suffix = details.imageCount
		? `\n\n[${details.imageCount} image attachment${details.imageCount === 1 ? "" : "s"}]`
		: "";
	addMarkdown(box, `${details.text ?? ""}${suffix}`, (content) => theme.fg("userMessageText", content));
	container.addChild(box);
	return container;
}

function renderAgentMessage(details: ThinktankRoomMessageDetails, theme: ExtensionContext["ui"]["theme"]): Container {
	const container = new Container();
	container.addChild(new Spacer(1));
	const agent = details.agent;
	const label = agent
		? `${agent.visibleName} ${theme.fg("dim", `[${agent.provider}/${agent.model}:${agent.thinkingLevel}]`)}`
		: (details.title ?? "Lab Agent");
	container.addChild(new Text(theme.fg("accent", theme.bold(label)), 0, 0));
	if (details.text) {
		container.addChild(new Spacer(1));
		addMarkdown(container, details.text, (content) => content);
	}
	return container;
}

function renderToolMessage(details: ThinktankRoomMessageDetails, theme: ExtensionContext["ui"]["theme"]): Container {
	const container = new Container();
	container.addChild(new Spacer(1));
	const tool = details.tool;
	const title = tool
		? `${tool.agent.visibleName} ${tool.phase === "start" ? "started" : "completed"} ${tool.toolName}`
		: (details.title ?? "Tool action");
	const color = tool?.isError ? "error" : tool?.phase === "start" ? "warning" : "success";
	container.addChild(new Text(theme.fg(color, theme.bold(title)), 0, 0));
	if (tool) {
		container.addChild(new Spacer(1));
		addMarkdown(container, formatToolText(tool), (content) => theme.fg("toolOutput", content));
	}
	return container;
}

function renderThinktankMessage(message: { content: unknown; details?: unknown }, options: { expanded: boolean }) {
	const details = isThinktankRoomMessageDetails(message.details)
		? message.details
		: ({
				kind: "status",
				title: "Thinktank",
				text: typeof message.content === "string" ? message.content : "",
				timestamp: Date.now(),
			} satisfies ThinktankRoomMessageDetails);

	return (_theme: ExtensionContext["ui"]["theme"]) => {
		const theme = _theme;
		if (details.kind === "human") {
			return renderHumanMessage(details, theme);
		}
		if (details.kind === "agent") {
			return renderAgentMessage(details, theme);
		}
		if (details.kind === "tool") {
			return renderToolMessage(details, theme);
		}

		const nextDetails =
			options.expanded && details.transcriptFile
				? {
						...details,
						text: `${details.text ?? ""}\n\nTranscript: \`${details.transcriptFile}\``,
					}
				: details;
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(renderBoxed(nextDetails, theme));
		return container;
	};
}

export default function (pi: ExtensionAPI) {
	let services: AgentSessionServices | undefined;
	let servicesPromise: Promise<AgentSessionServices> | undefined;
	let servicesCwd: string | undefined;
	let room: ThinktankRoomRuntime | undefined;
	let roster: ThinktankRoster | undefined;
	let pendingRosterApply = false;
	let queue: QueuedRoomPrompt[] = [];
	let drainingQueue = false;
	let shuttingDown = false;
	let thinktankEnabled = readThinktankEnabled();
	let liveWidget: LiveRoomWidget | undefined;
	let requestLiveRender: (() => void) | undefined;
	let liveState: LiveRoomState = {
		visible: false,
		status: "",
		text: "",
		thinking: "",
		toolCalls: [],
	};

	function updateLiveState(next: Partial<LiveRoomState>): void {
		liveState = { ...liveState, ...next };
		liveWidget?.invalidate();
		requestLiveRender?.();
	}

	function resetLiveTurn(agent: ThinktankRoomAgentInfo, status: string): void {
		updateLiveState({
			visible: true,
			status,
			agent,
			text: "",
			thinking: "",
			toolCalls: [],
		});
	}

	function installLiveWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setWidget(
			"thinktank-live",
			(tui, theme) => {
				requestLiveRender = () => tui.requestRender();
				liveWidget = new LiveRoomWidget(() => liveState, theme);
				return liveWidget;
			},
			{ placement: "aboveEditor" },
		);
	}

	function clearLiveWidget(ctx: ExtensionContext): void {
		updateLiveState({ visible: false, status: "", agent: undefined, text: "", thinking: "", toolCalls: [] });
		liveWidget = undefined;
		requestLiveRender = undefined;
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setWidget("thinktank-live", undefined);
	}

	function send(details: Omit<ThinktankRoomMessageDetails, "timestamp">): void {
		pi.sendMessage<ThinktankRoomMessageDetails>({
			customType: MESSAGE_TYPE,
			content: `[thinktank:${details.kind}]`,
			display: true,
			details: { ...details, timestamp: Date.now() },
		});
	}

	function updateRosterStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			return;
		}
		if (!thinktankEnabled) {
			ctx.ui.setStatus("thinktank-roster", ctx.ui.theme.fg("dim", "Thinktank: off"));
			return;
		}
		const currentRoster = roster ?? resolveRoster(ctx);
		roster = currentRoster;
		const mode = resolveRoomMode(currentRoster);
		const leader = currentRoster.find((entry) => !entry.disabled && entry.role === "leader");
		const modeStatus = mode === "leader-led"
			? `leader-led | Leader: ${leader ? getThinktankRosterEntryReference(leader) : "not configured"}`
			: "debate";
		ctx.ui.setStatus("thinktank-roster", `Thinktank: on | ${modeStatus} | ${formatRoster(currentRoster)}`);
	}

	function setThinktankEnabled(ctx: ExtensionContext, enabled: boolean): void {
		thinktankEnabled = enabled;
		persistThinktankEnabled(enabled);
		if (!enabled) {
			queue = [];
			clearLiveWidget(ctx);
			ctx.ui.setWorkingMessage();
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setStatus("thinktank-active", undefined);
		} else {
			installLiveWidget(ctx);
		}
		updateRosterStatus(ctx);
	}

	async function ensureServices(ctx: ExtensionContext): Promise<AgentSessionServices> {
		if (!servicesPromise || servicesCwd !== ctx.cwd) {
			servicesCwd = ctx.cwd;
			servicesPromise = createAgentSessionServices({ cwd: ctx.cwd, modelRegistry: ctx.modelRegistry });
			services = undefined;
		}

		services = await servicesPromise;
		for (const diagnostic of services.diagnostics) {
			if (diagnostic.type === "error") {
				ctx.ui.notify(diagnostic.message, "error");
			}
		}
		return services;
	}

	function getCurrentRoster(ctx: ExtensionContext): ThinktankRoster {
		roster = resolveRoster(ctx);
		updateRosterStatus(ctx);
		return roster;
	}

	async function applyRosterToRoom(ctx: ExtensionContext): Promise<void> {
		if (!room || !roster) {
			return;
		}
		if (room.isRunning) {
			pendingRosterApply = true;
			ctx.ui.notify("Roster saved. It will apply after the current room turn.", "info");
			return;
		}

		pendingRosterApply = false;
		room.setMode(resolveRoomMode(roster));
		await room.setRoster(roster);
		updateRosterStatus(ctx);
	}

	function isLeaderLedRoom(): boolean {
		return room?.mode === "leader-led";
	}

	function budgetSuffix(): string {
		return liveState.status.match(/ · \d+\/\d+$/)?.[0] ?? "";
	}

	function toolActivity(agent: ThinktankRoomAgentInfo, toolName: string, args: unknown): string {
		const path = isObject(args) && typeof args.path === "string" ? args.path.slice(0, 120) : undefined;
		const budget = budgetSuffix();
		if (path && toolName === "read") return `${agent.visibleName} reading ${path}…${budget}`;
		if (path && (toolName === "edit" || toolName === "write")) return `${agent.visibleName} editing ${path}…${budget}`;
		return `${agent.visibleName} running ${toolName}…${budget}`;
	}

	function shouldDisplayTool(agent: ThinktankRoomAgentInfo, toolName: string, isError = false): boolean {
		if (!isLeaderLedRoom()) return true;
		if (isError) return true;
		return agent.role === "leader" && !new Set(["read", "grep", "find", "ls"]).has(toolName);
	}

	function handleAgentEvent(agent: ThinktankRoomAgentInfo, event: ThinktankSessionEventLike): void {
		if (event.type === "message_update" && event.message.role === "assistant") {
			updateLiveState({
				visible: true,
				status: `${agent.visibleName} replying…${budgetSuffix()}`,
				agent,
				...(isLeaderLedRoom()
					? { text: "", thinking: "", toolCalls: [] }
					: extractLiveStateFromAssistantMessage(event.message)),
			});
			return;
		}

		if (event.type === "tool_execution_start") {
			updateLiveState({
				visible: true,
				status: toolActivity(agent, event.toolName, event.args),
				agent,
			});
			if (shouldDisplayTool(agent, event.toolName)) {
				send({
					kind: "tool",
					tool: {
						agent,
						phase: "start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					},
				});
			}
			return;
		}

		if (event.type === "tool_execution_end") {
			updateLiveState({
				visible: true,
				status: `${agent.visibleName} finished ${event.toolName}${budgetSuffix()}`,
				agent,
				toolCalls: [],
			});
			if (shouldDisplayTool(agent, event.toolName, event.isError === true)) {
				send({
					kind: "tool",
					tool: {
						agent,
						phase: "end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
					},
				});
			}
			return;
		}

		if (event.type === "compaction_start") {
			send({
				kind: "status",
				title: `${agent.visibleName} compaction`,
				text: `Compacting private context because of ${event.reason}.`,
				transcriptFile: room?.transcriptFile,
			});
			return;
		}

		if (event.type === "compaction_end") {
			const text = event.errorMessage
				? `Compaction failed: ${event.errorMessage}`
				: event.aborted
					? "Compaction aborted."
					: event.result
						? `Compaction completed. Tokens before: ${event.result.tokensBefore}. ${event.willRetry ? "Pi will retry the turn." : ""}`
						: "Compaction ended without a result.";
			send({
				kind: event.errorMessage ? "error" : "status",
				title: `${agent.visibleName} compaction ${event.errorMessage ? "failed" : "finished"}`,
				text,
				transcriptFile: room?.transcriptFile,
			});
		}
	}

	function createCallbacks(ctx: ExtensionContext) {
		return {
			onStatus(message: string): void {
				ctx.ui.setStatus("thinktank-active", message);
				updateLiveState({
					visible: true,
					status: message,
					agent: undefined,
					text: "",
					thinking: "",
					toolCalls: [],
				});
			},
			onAgentTurnStart(agent: ThinktankRoomAgentInfo): void {
				const status = isLeaderLedRoom()
					? (liveState.status || `${agent.visibleName} ${agent.role === "leader" ? "working" : "replying"}…`)
					: `${agent.visibleName} has the floor`;
				ctx.ui.setStatus("thinktank-active", status);
				ctx.ui.setWorkingMessage(status);
				ctx.ui.setWorkingVisible(true);
				resetLiveTurn(agent, status);
			},
			onAgentTurnEnd(agent: ThinktankRoomAgentInfo, text: string, presentation?: TurnPresentation): void {
				updateLiveState({
					visible: true,
					status: `${agent.visibleName} finished this turn`,
					agent,
					text: "",
					thinking: "",
					toolCalls: [],
				});
				if (!text.trim() || presentation === "collapsed") {
					return;
				}
				send({
					kind: "agent",
					title: presentation === "final" ? `${agent.visibleName} final answer` : undefined,
					agent,
					text,
					transcriptFile: room?.transcriptFile,
				});
			},
			onAgentTurnError(
				agent: ThinktankRoomAgentInfo,
				phase: AgentTurnPhase,
				error: ClassifiedAgentError & { partialText?: string },
			): void {
				const text = formatAgentTurnErrorText(error);
				ctx.ui.setStatus("thinktank-active", `${agent.visibleName} failed during ${phase}`);
				ctx.ui.setWorkingMessage(`${agent.visibleName} failed`);
				updateLiveState({
					visible: true,
					status: `${agent.visibleName} failed during ${phase}`,
					agent,
					text,
					thinking: "",
					toolCalls: [],
				});
				send({
					kind: "error",
					title: `${agent.visibleName} failed (${error.category})`,
					agent,
					text,
					transcriptFile: room?.transcriptFile,
				});
			},
			onInterrupt(
				interruptedAgent: ThinktankRoomAgentInfo,
				interrupter: ThinktankRoomAgentInfo | "user" | "runtime",
				reason: string,
			): void {
				const interrupterName = typeof interrupter === "string" ? interrupter : interrupter.visibleName;
				const text = `${interruptedAgent.visibleName} was interrupted by ${interrupterName}.\n\nReason: ${reason}`;
				ctx.ui.setStatus("thinktank-active", `${interruptedAgent.visibleName} interrupted`);
				updateLiveState({
					visible: true,
					status: `${interruptedAgent.visibleName} interrupted`,
					agent: interruptedAgent,
					text,
					thinking: "",
					toolCalls: [],
				});
				send({
					kind: "status",
					title: `${interruptedAgent.visibleName} interrupted`,
					text,
					transcriptFile: room?.transcriptFile,
				});
			},
			onAgentEvent(agent: ThinktankRoomAgentInfo, _session: unknown, event: ThinktankSessionEventLike): void {
				handleAgentEvent(agent, event);
			},
			onRoomIdle(summary: RoomIdleSummary): void {
				const idle = formatRoomIdle(summary);
				ctx.ui.setStatus("thinktank-active", idle.status);
				ctx.ui.setWorkingMessage();
				ctx.ui.setWorkingVisible(false);
				updateLiveState({ visible: false, status: "", agent: undefined, text: "", thinking: "", toolCalls: [] });
				// In leader-led mode the leader's final answer should remain the last
				// prominent output; the footer still reports that the room finished.
				if (summary.reason !== "leader_final") {
					send({
						kind: "status",
						title: idle.title,
						text: idle.text,
						transcriptFile: room?.transcriptFile,
					});
				}
				if (pendingRosterApply) {
					void applyRosterToRoom(ctx).catch((error: unknown) => {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					});
				}
			},
		};
	}

	async function ensureRoom(ctx: ExtensionContext): Promise<ThinktankRoomRuntime> {
		const currentRoster = roster ?? getCurrentRoster(ctx);
		if (room) {
			return room;
		}

		const settings = readThinktankSettings();
		room = new ThinktankRoomRuntime({
			services: await ensureServices(ctx),
			deps: defaultRuntimeDeps,
			cwd: ctx.cwd,
			rosterSelections: currentRoster,
			roomMode: resolveRoomMode(currentRoster),
			leaderLedMaxTurns: typeof settings.leaderLedMaxTurns === "number" ? settings.leaderLedMaxTurns : undefined,
			callbacks: createCallbacks(ctx),
		});
		await room.ready();
		return room;
	}

	async function runRoomPrompt(ctx: ExtensionContext, text: string, images: ImageContent[]): Promise<void> {
		if (!liveWidget) {
			installLiveWidget(ctx);
		}
		const activeRoster = getCurrentRoster(ctx);
		const activeRoom = await ensureRoom(ctx);
		updateRosterStatus(ctx);

		send({
			kind: "roster",
			title: "Roster",
			text: formatRoster(activeRoster),
			roster: formatRoster(activeRoster),
			transcriptFile: activeRoom.transcriptFile,
		});
		send({
			kind: "human",
			title: "You",
			text,
			imageCount: images.length,
			transcriptFile: activeRoom.transcriptFile,
		});

		ctx.ui.setWorkingMessage("Thinktank room is opening");
		ctx.ui.setWorkingVisible(true);
		await activeRoom.submitHumanPrompt(text, images);
	}

	async function drainQueue(): Promise<void> {
		if (drainingQueue) {
			return;
		}
		drainingQueue = true;

		try {
			while (queue.length > 0 && !shuttingDown) {
				const next = queue.shift();
				if (!next) {
					continue;
				}

				try {
					await runRoomPrompt(next.ctx, next.text, next.images);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					next.ctx.ui.setWorkingVisible(false);
					next.ctx.ui.setWorkingMessage();
					next.ctx.ui.setStatus("thinktank-active", undefined);
					updateLiveState({
						visible: true,
						status: "Thinktank error",
						agent: undefined,
						text: message,
						thinking: "",
						toolCalls: [],
					});
					send({
						kind: "error",
						title: "Thinktank error",
						text: message,
						transcriptFile: room?.transcriptFile,
					});
				}
			}
		} finally {
			drainingQueue = false;
		}
	}

	function enqueueRoomPrompt(ctx: ExtensionContext, text: string, images: ImageContent[]): void {
		queue.push({ ctx, text, images });
		if (queue.length > 1 || drainingQueue || room?.isRunning) {
			ctx.ui.notify("Queued for the Thinktank room", "info");
		}
		void drainQueue();
	}

	async function resetThinktankLabSessions(ctx: ExtensionContext): Promise<void> {
		if (room?.isRunning || drainingQueue) {
			ctx.ui.notify("Wait for the current Thinktank room turn to finish before resetting lab sessions.", "error");
			return;
		}

		const labSessionRoot = room?.labSessionRoot ?? getThinktankLabSessionRoot(ctx.cwd);
		const confirmed = await ctx.ui.confirm(
			"Reset Thinktank lab sessions?",
			`This deletes private Lab Agent session files under:\n\n${labSessionRoot}\n\nThe shared room transcript is preserved.`,
		);
		if (!confirmed) {
			ctx.ui.notify("Thinktank lab session reset cancelled.", "info");
			return;
		}

		queue = [];
		room?.dispose();
		room = undefined;
		rmSync(labSessionRoot, { recursive: true, force: true });
		mkdirSync(labSessionRoot, { recursive: true, mode: 0o700 });
		updateLiveState({
			visible: true,
			status: "Thinktank lab sessions reset",
			agent: undefined,
			text: `Deleted private Lab Agent sessions under:\n\n${labSessionRoot}`,
			thinking: "",
			toolCalls: [],
		});
		send({
			kind: "status",
			title: "Thinktank lab sessions reset",
			text: `Deleted private Lab Agent sessions under:\n\n\`${labSessionRoot}\`\n\nThe next Thinktank prompt will create fresh private lab sessions.`,
			transcriptFile: getThinktankTranscriptPath(ctx.cwd),
		});
		ctx.ui.notify("Thinktank lab sessions reset. The next prompt will start fresh private lab sessions.", "info");
		updateRosterStatus(ctx);
	}

	async function openRoster(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("/thinktank roster requires interactive mode", "error");
			return;
		}

		const availableModels = refreshAvailableModels(ctx);
		roster = selectThinktankRoster(availableModels, readSavedRosterSelections());
		updateRosterStatus(ctx);

		await ctx.ui.custom<void>(
			(_tui, _theme, _keybindings, done) =>
				new RosterSelectorComponent(
					{
						allModels: availableModels,
						selections: roster ?? [],
						theme: _theme,
					},
					{
						onChange: async (nextRoster) => {
							roster = nextRoster;
							persistRosterSelections(nextRoster);
							updateRosterStatus(ctx);
							try {
								await applyRosterToRoom(ctx);
							} catch (error) {
								ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
							}
						},
						onCancel: () => done(undefined),
					},
				),
			{ overlay: true },
		);
	}

	pi.registerMessageRenderer<ThinktankRoomMessageDetails>(MESSAGE_TYPE, (message, options, theme) =>
		renderThinktankMessage(message, options)(theme),
	);

	pi.registerCommand("thinktank", {
		description: "Configure Thinktank: /thinktank [on|off|status|roster|mode|sessions|reset-labs]",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (!value || value === "status") {
				updateRosterStatus(ctx);
				ctx.ui.notify(`Thinktank is ${thinktankEnabled ? "on" : "off"}`, "info");
				return;
			}

			if (value === "roster") {
				await openRoster(ctx);
				return;
			}

			if (value === "mode" || value.startsWith("mode ")) {
				const requested = value.slice("mode".length).trim();
				if (!requested) {
					ctx.ui.notify(`Thinktank mode: ${resolveRoomMode(roster ?? resolveRoster(ctx))}`, "info");
					return;
				}
				if (requested !== "leader-led" && requested !== "debate") {
					ctx.ui.notify("Usage: /thinktank mode [leader-led|debate]", "error");
					return;
				}
				const currentRoster = roster ?? resolveRoster(ctx);
				if (requested === "leader-led" && !hasValidLeader(currentRoster)) {
					ctx.ui.notify("Leader-led mode requires exactly one enabled leader. Choose one in /thinktank roster.", "error");
					return;
				}
				persistRoomMode(requested);
				if (room?.isRunning) {
					pendingRosterApply = true;
				} else if (room) {
					// Recreate sessions so per-role tool policy changes with the mode.
					room.dispose();
					room = undefined;
				}
				updateRosterStatus(ctx);
				ctx.ui.notify(`Thinktank mode set to ${requested}`, "info");
				return;
			}

			if (value === "sessions") {
				const transcriptFile = room?.transcriptFile ?? getThinktankTranscriptPath(ctx.cwd);
				send({
					kind: "status",
					title: "Thinktank sessions",
					text: formatThinktankSessions(ctx, room),
					transcriptFile,
				});
				updateRosterStatus(ctx);
				return;
			}

			if (value === "reset-labs" || value === "reset labs") {
				await resetThinktankLabSessions(ctx);
				return;
			}

			if (value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /thinktank [on|off|status|roster|mode|sessions|reset-labs]", "error");
				return;
			}

			if (value === "on") {
				const currentRoster = roster ?? resolveRoster(ctx);
				if (currentRoster.filter((entry) => !entry.disabled).length === 0) {
					ctx.ui.notify("Add at least one enabled model in /thinktank roster before turning Thinktank on.", "error");
					return;
				}
				if (resolveRoomMode(currentRoster) === "leader-led" && !hasValidLeader(currentRoster)) {
					ctx.ui.notify("Choose exactly one enabled leader in /thinktank roster before turning Thinktank on.", "error");
					return;
				}
			}

			setThinktankEnabled(ctx, value === "on");
			ctx.ui.notify(`Thinktank ${value === "on" ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("interrupt", {
		description: "Interrupt the active Thinktank agent: /interrupt [reason]",
		handler: async (args, ctx) => {
			if (!room || !room.isRunning) {
				ctx.ui.notify("Room is not currently running an active turn.", "error");
				return;
			}
			const reason = args.trim() || "User requested interruption.";
			await room.interruptActiveTurn(reason, "user");
			ctx.ui.notify("Interruption requested...", "info");
		},
	});

	pi.registerCommand("thinktank-log", {
		description: "Show the current Thinktank transcript path",
		handler: async (_args, ctx) => {
			const transcriptFile = room?.transcriptFile;
			send({
				kind: "status",
				title: "Thinktank transcript",
				text: transcriptFile
					? `Structured room transcript:\n\n\`${transcriptFile}\``
					: "No Thinktank room transcript exists in this session yet.",
				transcriptFile,
			});
			updateRosterStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}
		shuttingDown = false;
		thinktankEnabled = readThinktankEnabled();
		roster = resolveRoster(ctx);
		updateRosterStatus(ctx);
		if (thinktankEnabled) {
			installLiveWidget(ctx);
		}
		ctx.ui.setTitle("pi thinktank");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		queue = [];
		room?.dispose();
		room = undefined;
		clearLiveWidget(ctx);
		ctx.ui.setStatus("thinktank-active", undefined);
		ctx.ui.setStatus("thinktank-roster", undefined);
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingVisible(false);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !ctx.hasUI) {
			return { action: "continue" };
		}
		if (!thinktankEnabled) {
			return { action: "continue" };
		}

		const text = event.text.trim();
		if (text.startsWith("/") || (!text && !event.images?.length)) {
			return { action: "continue" };
		}

		const resolvedRoster = resolveRoster(ctx);
		const activeRoster = resolvedRoster.filter((entry) => !entry.disabled);
		if (activeRoster.length === 0) {
			return { action: "continue" };
		}
		if (resolveRoomMode(resolvedRoster) === "leader-led" && !hasValidLeader(resolvedRoster)) {
			return { action: "continue" };
		}

		roster = resolvedRoster;
		const prompt = text || "Discuss the attached image prompt.";
		enqueueRoomPrompt(ctx, prompt, event.images ?? []);
		return { action: "handled" };
	});
}
