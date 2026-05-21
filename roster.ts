import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export type LabId = "openai" | "google" | "anthropic";

export const THINKTANK_LAB_IDS: LabId[] = ["openai", "google", "anthropic"];

export interface ThinktankLabDefinition {
	id: LabId;
	displayName: string;
	shortName: string;
	providerCandidates: string[];
	preferredModelIds: string[];
	displayModelIds: string[];
	modelIdNeedles: string[];
}

export interface ThinktankAgentRosterSelection {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	disabled?: boolean;
}

export type ThinktankAgentRosterSelections = Partial<Record<LabId, ThinktankAgentRosterSelection>>;

export type ThinktankAgentModelSelection = ThinktankAgentRosterSelection;
export type ThinktankAgentModelSelections = ThinktankAgentRosterSelections;

export interface ThinktankAvailableModel {
	provider: string;
	model: string;
	name?: string;
}

export interface ThinktankRosterEntry {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	disabled?: boolean;
}

export type ThinktankRoster = Partial<Record<LabId, ThinktankRosterEntry>>;
export type ThinktankRosterModels = ThinktankRoster;

export const DEFAULT_THINKTANK_THINKING_LEVEL: ThinkingLevel = "high";

export const THINKTANK_LAB_DEFINITIONS: ThinktankLabDefinition[] = [
	{
		id: "openai",
		displayName: "GPT-5.5",
		shortName: "OpenAI",
		providerCandidates: ["openai-codex", "openai", "azure-openai-responses", "github-copilot"],
		preferredModelIds: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5"],
		displayModelIds: ["gpt-5.5"],
		modelIdNeedles: ["gpt-5.5", "gpt-5", "gpt"],
	},
	{
		id: "google",
		displayName: "Gemini 3.1 Pro",
		shortName: "Google",
		providerCandidates: ["google", "google-vertex", "github-copilot"],
		preferredModelIds: ["gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-3-pro", "gemini-2.5-pro"],
		displayModelIds: ["gemini-3.1-pro-preview"],
		modelIdNeedles: ["gemini-3.1-pro", "gemini-3", "gemini"],
	},
	{
		id: "anthropic",
		displayName: "Opus 4.7",
		shortName: "Anthropic",
		providerCandidates: ["anthropic", "github-copilot"],
		preferredModelIds: ["claude-opus-4.7", "claude-opus-4-7", "claude-opus-4.6", "claude-opus-4.5"],
		displayModelIds: ["claude-opus-4.7", "claude-opus-4-7"],
		modelIdNeedles: ["claude-opus-4-7", "claude-opus-4.7", "opus-4-7", "opus-4.7", "opus"],
	},
];

export function getThinktankModelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function getThinktankSupportedThinkingLevels(model: Model<Api>): ThinkingLevel[] {
	return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

export function clampThinktankThinkingLevel(
	model: Model<Api>,
	thinkingLevel: ThinkingLevel | undefined,
): ThinkingLevel {
	return clampThinkingLevel(model, thinkingLevel ?? DEFAULT_THINKTANK_THINKING_LEVEL) as ThinkingLevel;
}

export function getThinktankRosterEntryReference(entry: ThinktankRosterEntry): string {
	return `${getThinktankModelReference(entry.model)}:${entry.thinkingLevel}`;
}

export function getThinktankVisibleName(definition: ThinktankLabDefinition, model: Model<Api>): string {
	const modelLabel = model.name ?? model.id;
	if (definition.displayModelIds.includes(model.id)) {
		return definition.displayName;
	}
	return `${definition.shortName} (${modelLabel})`;
}

function modelMatchesLabFamily(model: Model<Api>, definition: ThinktankLabDefinition): boolean {
	const text = `${model.id} ${model.name ?? ""}`.toLowerCase();
	return definition.modelIdNeedles.some((needle) => text.includes(needle.toLowerCase()));
}

export function isThinktankModelEligibleForLab(model: Model<Api>, definition: ThinktankLabDefinition): boolean {
	if (!definition.providerCandidates.includes(model.provider)) {
		return false;
	}
	if (model.provider !== "github-copilot") {
		return true;
	}
	return modelMatchesLabFamily(model, definition);
}

export function getThinktankModelsForLab(
	availableModels: Model<Api>[],
	definition: ThinktankLabDefinition,
): Model<Api>[] {
	return availableModels.filter((model) => isThinktankModelEligibleForLab(model, definition));
}

function selectExactModel(availableModels: Model<Api>[], provider: string, modelIds: string[]): Model<Api> | undefined {
	for (const modelId of modelIds) {
		const match = availableModels.find((model) => model.provider === provider && model.id === modelId);
		if (match) {
			return match;
		}
	}
	return undefined;
}

function selectFuzzyModel(
	availableModels: Model<Api>[],
	provider: string,
	modelIdNeedles: string[],
): Model<Api> | undefined {
	const providerModels = availableModels.filter((model) => model.provider === provider);
	for (const needle of modelIdNeedles) {
		const lowerNeedle = needle.toLowerCase();
		const match = providerModels.find(
			(model) => model.id.toLowerCase().includes(lowerNeedle) || model.name?.toLowerCase().includes(lowerNeedle),
		);
		if (match) {
			return match;
		}
	}
	return providerModels[0];
}

export function selectThinktankLabModel(
	availableModels: Model<Api>[],
	definition: ThinktankLabDefinition,
	selection?: ThinktankAgentRosterSelection,
): Model<Api> | undefined {
	if (selection) {
		const selected = availableModels.find(
			(model) => model.provider === selection.provider && model.id === selection.model,
		);
		if (selected && isThinktankModelEligibleForLab(selected, definition)) {
			return selected;
		}
	}

	const eligibleModels = getThinktankModelsForLab(availableModels, definition);

	for (const provider of definition.providerCandidates) {
		const exact = selectExactModel(eligibleModels, provider, definition.preferredModelIds);
		if (exact) {
			return exact;
		}
	}

	for (const provider of definition.providerCandidates) {
		const fuzzy = selectFuzzyModel(eligibleModels, provider, definition.modelIdNeedles);
		if (fuzzy) {
			return fuzzy;
		}
	}

	return undefined;
}

export function selectThinktankRosterEntry(
	availableModels: Model<Api>[],
	definition: ThinktankLabDefinition,
	selection?: ThinktankAgentRosterSelection,
): ThinktankRosterEntry | undefined {
	const model = selectThinktankLabModel(availableModels, definition, selection);
	if (!model) {
		return undefined;
	}
	return {
		model,
		thinkingLevel: clampThinktankThinkingLevel(model, selection?.thinkingLevel),
		disabled: selection?.disabled,
	};
}

export function selectDefaultThinktankRoster(
	availableModels: Model<Api>[],
	selections: ThinktankAgentRosterSelections = {},
): ThinktankRoster {
	const roster: ThinktankRoster = {};
	for (const definition of THINKTANK_LAB_DEFINITIONS) {
		const entry = selectThinktankRosterEntry(availableModels, definition, selections[definition.id]);
		if (entry) {
			roster[definition.id] = entry;
		}
	}
	return roster;
}

export const selectDefaultThinktankRosterModels = selectDefaultThinktankRoster;
