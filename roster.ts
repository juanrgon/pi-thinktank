import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Stable identity for one participant in the room. */
export type AgentId = string;
/** @deprecated Use AgentId. */
export type LabId = AgentId;

export interface ThinktankAgentRosterSelection {
	id: AgentId;
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	disabled?: boolean;
}

export type ThinktankAgentRosterSelections = ThinktankAgentRosterSelection[];

export type ThinktankAgentModelSelection = ThinktankAgentRosterSelection;
export type ThinktankAgentModelSelections = ThinktankAgentRosterSelections;

export interface ThinktankAvailableModel {
	provider: string;
	model: string;
	name?: string;
}

export interface ThinktankRosterEntry {
	id: AgentId;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	disabled?: boolean;
}

export type ThinktankRoster = ThinktankRosterEntry[];
export type ThinktankRosterModels = ThinktankRoster;

export const DEFAULT_THINKTANK_THINKING_LEVEL: ThinkingLevel = "high";

export function createThinktankAgentId(existingIds: readonly string[]): AgentId {
	const existing = new Set(existingIds);
	let id: string;
	do {
		id = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	} while (existing.has(id));
	return id;
}

export function getThinktankModelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function getThinktankRosterEntryReference(entry: ThinktankRosterEntry): string {
	return `${getThinktankModelReference(entry.model)}:${entry.thinkingLevel}`;
}

export function getThinktankVisibleName(model: Model<Api>, duplicateNumber?: number): string {
	const modelLabel = model.name ?? model.id;
	return duplicateNumber === undefined ? modelLabel : `${modelLabel} #${duplicateNumber}`;
}

/** Every model Pi reports as available can participate in a Thinktank room. */
export function getThinktankAvailableModels(availableModels: Model<Api>[]): Model<Api>[] {
	return [...availableModels];
}

export function selectThinktankRosterEntry(
	availableModels: Model<Api>[],
	selection: ThinktankAgentRosterSelection,
	clampLevel?: (model: Model<Api>, level: ThinkingLevel | undefined) => ThinkingLevel,
): ThinktankRosterEntry | undefined {
	const model = availableModels.find(
		(candidate) => candidate.provider === selection.provider && candidate.id === selection.model,
	);
	if (!model) {
		return undefined;
	}
	const requestedLevel = selection.thinkingLevel ?? DEFAULT_THINKTANK_THINKING_LEVEL;
	return {
		id: selection.id,
		model,
		thinkingLevel: clampLevel ? clampLevel(model, requestedLevel) : requestedLevel,
		disabled: selection.disabled,
	};
}

/**
 * Resolve persisted selections against Pi's currently available models.
 *
 * The roster starts empty, preserves order, permits the same provider/model any
 * number of times, and requires only each participant id to be unique.
 */
export function selectThinktankRoster(
	availableModels: Model<Api>[],
	selections: ThinktankAgentRosterSelections = [],
	clampLevel?: (model: Model<Api>, level: ThinkingLevel | undefined) => ThinkingLevel,
): ThinktankRoster {
	const roster: ThinktankRoster = [];
	const seenIds = new Set<AgentId>();
	for (const selection of selections) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(selection.id) || seenIds.has(selection.id)) {
			continue;
		}
		seenIds.add(selection.id);
		const entry = selectThinktankRosterEntry(availableModels, selection, clampLevel);
		if (entry) {
			roster.push(entry);
		}
	}
	return roster;
}

/** @deprecated Use selectThinktankRoster. */
export const selectDefaultThinktankRoster = selectThinktankRoster;
/** @deprecated Use selectThinktankRoster. */
export const selectDefaultThinktankRosterModels = selectThinktankRoster;
