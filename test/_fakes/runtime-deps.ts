import type { ContextUsageSnapshot } from "../../precompaction.ts";
import type {
	ThinkingLevelLike,
	ThinktankAgentMessageLike,
	ThinktankApiKeyResult,
	ThinktankAssistantMessageLike,
	ThinktankCompactionSettingsLike,
	ThinktankCompletionAuthLike,
	ThinktankCompletionPromptLike,
	ThinktankCreateLabSessionOptions,
	ThinktankModelLike,
	ThinktankModelRegistryLike,
	ThinktankPromptOptionsLike,
	ThinktankRuntimeDeps,
	ThinktankServicesLike,
	ThinktankSessionEventLike,
	ThinktankSessionEventListener,
	ThinktankSessionLike,
	ThinktankSettingsManagerLike,
} from "../../runtime-deps.ts";

export function createFakeModel(overrides: Partial<ThinktankModelLike> = {}): ThinktankModelLike {
	return {
		provider: "github-copilot",
		id: "gpt-5.5",
		api: "openai-responses",
		contextWindow: 128_000,
		name: "GPT-5.5",
		...overrides,
	};
}

export function createAssistantMessage(text: string, overrides: Partial<ThinktankAssistantMessageLike> = {}): ThinktankAssistantMessageLike {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		...overrides,
	};
}

type PromptScript =
	| {
			kind: "message";
			message: ThinktankAgentMessageLike;
			events?: ThinktankSessionEventLike[];
	  }
	| {
			kind: "error";
			error: unknown;
			events?: ThinktankSessionEventLike[];
	  }
	| {
			kind: "run";
			run: (session: FakeSession, prompt: string, options: ThinktankPromptOptionsLike) => void | Promise<void>;
	  };

export interface PromptCall {
	prompt: string;
	options: ThinktankPromptOptionsLike;
}

export class FakeSession implements ThinktankSessionLike {
	messages: ThinktankAgentMessageLike[];
	sessionFile?: string;
	contextUsage?: ContextUsageSnapshot;
	promptCalls: PromptCall[] = [];
	compactCalls: string[] = [];
	aborted = false;
	compactionAborted = false;
	disposed = false;
	compactError?: unknown;
	compactResult: unknown = { summary: "fake summary", tokensBefore: 0, firstKeptEntryId: "fake-entry" };
	private listeners = new Set<ThinktankSessionEventListener>();
	private promptScripts: PromptScript[] = [];

	constructor(options: { messages?: ThinktankAgentMessageLike[]; sessionFile?: string; contextUsage?: ContextUsageSnapshot } = {}) {
		this.messages = [...(options.messages ?? [])];
		this.sessionFile = options.sessionFile;
		this.contextUsage = options.contextUsage;
	}

	queuePromptMessage(text: string, overrides: Partial<ThinktankAssistantMessageLike> = {}): this {
		this.promptScripts.push({ kind: "message", message: createAssistantMessage(text, overrides) });
		return this;
	}

	queuePromptScript(script: PromptScript): this {
		this.promptScripts.push(script);
		return this;
	}

	emit(event: ThinktankSessionEventLike): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	subscribe(listener: ThinktankSessionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async prompt(prompt: string, options: ThinktankPromptOptionsLike): Promise<void> {
		this.promptCalls.push({ prompt, options });
		const script = this.promptScripts.shift() ?? { kind: "message" as const, message: createAssistantMessage("ok") };
		if (script.kind === "run") {
			await script.run(this, prompt, options);
			return;
		}

		for (const event of script.events ?? []) {
			this.emit(event);
		}

		if (script.kind === "error") {
			throw script.error;
		}

		this.messages.push(script.message);
		this.emit({ type: "message_end", message: script.message });
	}

	async compact(instructions: string): Promise<unknown> {
		this.compactCalls.push(instructions);
		if (this.compactError !== undefined) {
			throw this.compactError;
		}
		return this.compactResult;
	}

	getContextUsage(): ContextUsageSnapshot | undefined {
		return this.contextUsage;
	}

	async abort(): Promise<void> {
		this.aborted = true;
	}

	async abortCompaction(): Promise<void> {
		this.compactionAborted = true;
	}

	dispose(): void {
		this.disposed = true;
	}
}

export class FakeModelRegistry<TModel extends ThinktankModelLike = ThinktankModelLike>
	implements ThinktankModelRegistryLike<TModel>
{
	models: TModel[];
	authResult: ThinktankApiKeyResult = { ok: true, apiKey: "fake-api-key", headers: { "x-fake": "1" } };
	refreshCount = 0;
	authRequests: TModel[] = [];

	constructor(models: TModel[] = [createFakeModel() as TModel]) {
		this.models = models;
	}

	refresh(): void {
		this.refreshCount++;
	}

	getAvailable(): ReadonlyArray<TModel> {
		return this.models;
	}

	async getApiKeyAndHeaders(model: TModel): Promise<ThinktankApiKeyResult> {
		this.authRequests.push(model);
		return this.authResult;
	}
}

export class FakeSettingsManager implements ThinktankSettingsManagerLike {
	compactionSettings: ThinktankCompactionSettingsLike;

	constructor(settings: ThinktankCompactionSettingsLike = { enabled: true, reserveTokens: 16_384 }) {
		this.compactionSettings = settings;
	}

	getCompactionSettings(): ThinktankCompactionSettingsLike {
		return this.compactionSettings;
	}
}

export class FakeServices<TModel extends ThinktankModelLike = ThinktankModelLike> implements ThinktankServicesLike<TModel> {
	modelRegistry: FakeModelRegistry<TModel>;
	settingsManager: FakeSettingsManager;

	constructor(options: { modelRegistry?: FakeModelRegistry<TModel>; settingsManager?: FakeSettingsManager; models?: TModel[] } = {}) {
		this.modelRegistry = options.modelRegistry ?? new FakeModelRegistry<TModel>(options.models);
		this.settingsManager = options.settingsManager ?? new FakeSettingsManager();
	}
}

export interface CompletionCall {
	model: ThinktankModelLike;
	prompt: ThinktankCompletionPromptLike;
	auth: ThinktankCompletionAuthLike;
}

export class FakeRuntimeDeps implements ThinktankRuntimeDeps {
	completionCalls: CompletionCall[] = [];
	createLabSessionCalls: ThinktankCreateLabSessionOptions[] = [];
	createdSessions: FakeSession[] = [];
	completionQueue: ThinktankAssistantMessageLike[] = [];
	nextSessions: FakeSession[] = [];
	clampedLevel: ThinkingLevelLike | undefined;

	clampThinkingLevel(_model: ThinktankModelLike, level: ThinkingLevelLike): ThinkingLevelLike {
		return this.clampedLevel ?? level;
	}

	async completeSimple(
		model: ThinktankModelLike,
		prompt: ThinktankCompletionPromptLike,
		auth: ThinktankCompletionAuthLike,
	): Promise<ThinktankAssistantMessageLike> {
		this.completionCalls.push({ model, prompt, auth });
		return this.completionQueue.shift() ?? createAssistantMessage("{}", { content: "{}" });
	}

	async createLabSession(options: ThinktankCreateLabSessionOptions): Promise<{ readonly session: ThinktankSessionLike }> {
		this.createLabSessionCalls.push(options);
		const session = this.nextSessions.shift() ?? new FakeSession({ sessionFile: `${options.sessionDir}/fake.jsonl` });
		this.createdSessions.push(session);
		return { session };
	}
}
