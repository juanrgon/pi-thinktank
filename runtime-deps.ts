// Narrow structural interfaces describing exactly the surface that
// ThinktankRoomRuntime touches on its Pi dependencies (AgentSession,
// AgentSessionServices, AgentSessionEvent, Model<Api>).
//
// Defining these lets the runtime be tested with fakes without pulling in
// the full @earendil-works/pi-* peer-dependency graph. Real Pi types
// satisfy these interfaces via structural typing, so no public API change
// is required in the runtime constructor or its callers.
//
// This file intentionally has no external dependencies.
//
// F1 of the F-series (Option 2: invert dependencies). F2 will refactor
// room-runtime.ts internals to consume these narrow types. F3 will build
// test fakes implementing them. F4 will write integration tests that
// instantiate ThinktankRoomRuntime against the fakes.

import type { ContextUsageSnapshot } from "./precompaction.ts";

// ============================================================================
// Thinking levels
// ============================================================================

/**
 * Pi's ThinkingLevel type as a structural string union. Pi's real type is
 * imported by runtime-default-deps.ts; this narrow version is what the
 * runtime and tests work with.
 */
export type ThinkingLevelLike =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

// ============================================================================
// Agent messages
// ============================================================================

/**
 * Minimal AgentMessage shape: just enough for the runtime's getTextFromMessage
 * helper. Pi's real AgentMessage has many additional fields (timestamps,
 * tool calls, usage, etc.) that the runtime ignores.
 */
export interface ThinktankAgentMessageLike {
	readonly role: string;
	readonly content:
		| string
		| ReadonlyArray<{ readonly type: string; readonly text?: string }>;
	/**
	 * Present on assistant messages. Some providers report a failed turn by
	 * recording an assistant message with stopReason "error"/"aborted" instead
	 * of throwing from prompt(); the runtime inspects this to surface the failure.
	 */
	readonly stopReason?: string;
	readonly errorMessage?: string;
}

// ============================================================================
// Session events
//
// Real AgentSessionEvent is a wider discriminated union. The runtime only
// inspects the variants below; others reach the listener but fall through.
// ============================================================================

export interface ThinktankMessageUpdateEvent {
	readonly type: "message_update";
	readonly message: ThinktankAgentMessageLike;
}

export interface ThinktankMessageEndEvent {
	readonly type: "message_end";
	readonly message: ThinktankAgentMessageLike;
}

export interface ThinktankToolStartEvent {
	readonly type: "tool_execution_start";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
}

export interface ThinktankToolEndEvent {
	readonly type: "tool_execution_end";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly result: {
		readonly content: unknown;
	};
	readonly isError?: boolean;
}

export interface ThinktankCompactionStartEvent {
	readonly type: "compaction_start";
	readonly reason: string;
}

export interface ThinktankCompactionEndEvent {
	readonly type: "compaction_end";
	readonly reason: string;
	readonly willRetry: boolean;
	readonly aborted?: boolean;
	readonly errorMessage?: string;
	readonly result?: {
		readonly tokensBefore?: number;
		readonly firstKeptEntryId?: string | number;
	};
}

/**
 * Catch-all for event variants the runtime receives via subscribe() but
 * does not currently inspect. Listed last so the discriminated union still
 * narrows for the typed variants above.
 */
export interface ThinktankUnhandledSessionEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

export type ThinktankSessionEventLike =
	| ThinktankMessageUpdateEvent
	| ThinktankMessageEndEvent
	| ThinktankToolStartEvent
	| ThinktankToolEndEvent
	| ThinktankCompactionStartEvent
	| ThinktankCompactionEndEvent
	| ThinktankUnhandledSessionEvent;

export type ThinktankSessionEventListener = (event: ThinktankSessionEventLike) => void;

// ============================================================================
// Session
// ============================================================================

/**
 * Options accepted by session.prompt(). Images are unknown[] in the narrow
 * interface because the runtime only passes them through — real callers
 * provide pi-ai's ImageContent[] which satisfies this via covariance.
 */
export interface ThinktankPromptOptionsLike {
	readonly expandPromptTemplates?: boolean;
	readonly images?: ReadonlyArray<unknown>;
	readonly source?: string;
}

/**
 * The nine-method session surface used by room-runtime.ts. Real Pi
 * AgentSession satisfies this structurally; F3's FakeSession will
 * implement it directly without needing pi-coding-agent installed.
 */
export interface ThinktankSessionLike {
	readonly messages: ReadonlyArray<ThinktankAgentMessageLike>;
	readonly sessionFile?: string;

	prompt(prompt: string, options: ThinktankPromptOptionsLike): Promise<void>;
	compact(instructions: string): Promise<unknown>;
	subscribe(listener: ThinktankSessionEventListener): () => void;
	getContextUsage(): ContextUsageSnapshot | undefined;
	abort(): Promise<void>;
	abortCompaction(): Promise<void>;
	dispose(): void;
}

// ============================================================================
// Models
// ============================================================================

/**
 * Minimal Model shape the runtime accesses. Pi's Model<Api> has many
 * additional fields (cost tables, capabilities, etc.) that the runtime
 * does not touch directly.
 */
export interface ThinktankModelLike {
	readonly id: string;
	readonly provider: string;
	readonly contextWindow?: number;
	readonly api?: string;
	readonly name?: string;
}

// ============================================================================
// Services: settings manager
// ============================================================================

/**
 * Compaction settings the runtime reads via settingsManager. Wider than
 * what precompaction.ts uses internally — that module re-derives its own
 * PrecompactionSettings from this surface.
 */
export interface ThinktankCompactionSettingsLike {
	readonly enabled: boolean;
	readonly reserveTokens: number;
}

export interface ThinktankSettingsManagerLike {
	getCompactionSettings(): ThinktankCompactionSettingsLike;
}

// ============================================================================
// Services: model registry
// ============================================================================

export type ThinktankApiKeyResult =
	| {
			readonly ok: true;
			readonly apiKey: string;
			readonly headers?: Record<string, string>;
	  }
	| {
			readonly ok: false;
			readonly error: string;
	  };

export interface ThinktankModelRegistryLike<
	TModel extends ThinktankModelLike = ThinktankModelLike,
> {
	refresh(): void;
	getAvailable(): ReadonlyArray<TModel>;
	getApiKeyAndHeaders(model: TModel): Promise<ThinktankApiKeyResult>;
}

// ============================================================================
// Services aggregate
// ============================================================================

export interface ThinktankServicesLike<
	TModel extends ThinktankModelLike = ThinktankModelLike,
> {
	readonly modelRegistry: ThinktankModelRegistryLike<TModel>;
	readonly settingsManager: ThinktankSettingsManagerLike;
}

// ============================================================================
// Runtime dependency injection surface (Option Y / F2.5)
//
// These are the Pi-package value imports that room-runtime.ts used to call
// directly. Injecting them via the constructor lets tests substitute fakes
// without resolving @earendil-works/pi-* at module load time.
//
// Production code passes `defaultRuntimeDeps` from runtime-default-deps.ts,
// which is a thin pass-through to the real Pi functions. That file is the
// only place in the runtime path that imports Pi values; room-runtime.ts
// itself stays type-only against Pi.
// ============================================================================

/**
 * Minimal shape of a Pi AssistantMessage as the runtime uses it. Pi's real
 * AssistantMessage is wider; only these fields are read.
 */
export interface ThinktankAssistantMessageLike extends ThinktankAgentMessageLike {
	readonly stopReason: string;
	readonly errorMessage?: string;
}

export interface ThinktankCompletionPromptLike {
	readonly systemPrompt: string;
	readonly messages: ReadonlyArray<{
		readonly role: string;
		readonly content: string;
		readonly timestamp: number;
	}>;
}

export interface ThinktankCompletionAuthLike {
	readonly apiKey: string;
	readonly headers?: Record<string, string>;
	readonly reasoning?: ThinkingLevelLike;
}

export interface ThinktankCreateLabSessionOptions {
	readonly cwd: string;
	readonly sessionDir: string;
	readonly services: ThinktankServicesLike;
	readonly model: ThinktankModelLike;
	readonly thinkingLevel: ThinkingLevelLike;
	/**
	 * Explicit tool allowlist. When provided, only these tools are enabled.
	 * When omitted, the session is created with no allowlist (all built-in +
	 * extension/MCP tools available) and the adapter activates the full set
	 * minus `excludeTools`.
	 */
	readonly tools?: ReadonlyArray<string>;
	/** Tool names to exclude from the full set when `tools` is omitted. */
	readonly excludeTools?: ReadonlyArray<string>;
}

/**
 * The three Pi value-imports that room-runtime.ts needs at runtime,
 * exposed as injectable functions. Tests provide stubs; production uses
 * `defaultRuntimeDeps` from runtime-default-deps.ts which forwards to the
 * real Pi implementations.
 */
export interface ThinktankRuntimeDeps {
	/** Wraps pi-ai clampThinkingLevel(model, level) -> level. */
	clampThinkingLevel(model: ThinktankModelLike, level: ThinkingLevelLike): ThinkingLevelLike;

	/** Wraps pi-ai completeSimple(model, prompt, auth) -> assistant message. */
	completeSimple(
		model: ThinktankModelLike,
		prompt: ThinktankCompletionPromptLike,
		auth: ThinktankCompletionAuthLike,
	): Promise<ThinktankAssistantMessageLike>;

	/**
	 * Bundles pi-coding-agent's SessionManager.continueRecent +
	 * createAgentSessionFromServices into a single injection point. Hides the
	 * intermediate SessionManager handle from the runtime.
	 */
	createLabSession(options: ThinktankCreateLabSessionOptions): Promise<{
		readonly session: ThinktankSessionLike;
	}>;
}
