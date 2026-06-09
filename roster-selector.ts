import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import { DynamicBorder, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import {
	clampThinktankThinkingLevel,
	getThinktankSupportedThinkingLevels,
} from "./roster-thinking.ts";
import {
	createThinktankAgentId,
	getThinktankModelReference,
	type ThinktankRoster,
	type ThinktankRosterEntry,
} from "./roster.ts";

interface RosterModelItem {
	fullId: string;
	model: Model<Api>;
}

export interface RosterSelectorConfig {
	allModels: Model<Api>[];
	selections: ThinktankRoster;
	theme: Theme;
}

export interface RosterSelectorCallbacks {
	onChange: (selections: ThinktankRoster) => void | Promise<void>;
	onCancel: () => void;
}

function cloneSelections(selections: ThinktankRoster): ThinktankRoster {
	return selections.map((entry) => ({ ...entry }));
}

function compareModels(selectedEntry: ThinktankRosterEntry | undefined) {
	return (a: RosterModelItem, b: RosterModelItem): number => {
		const aSelected = modelsAreEqual(a.model, selectedEntry?.model);
		const bSelected = modelsAreEqual(b.model, selectedEntry?.model);
		if (aSelected && !bSelected) return -1;
		if (!aSelected && bSelected) return 1;
		return a.fullId.localeCompare(b.fullId);
	};
}

export class RosterSelectorComponent extends Container implements Focusable {
	private allModels: Model<Api>[];
	private selections: ThinktankRoster;
	private callbacks: RosterSelectorCallbacks;
	private selectedAgentIndex = 0;
	private selectedModelIndex = 0;
	private searchInput: Input;
	private slotContainer: Container;
	private listContainer: Container;
	private footerText: Text;
	private filteredModels: RosterModelItem[] = [];
	private maxVisible = 8;
	private theme: Theme;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(config: RosterSelectorConfig, callbacks: RosterSelectorCallbacks) {
		super();
		this.allModels = config.allModels;
		this.selections = cloneSelections(config.selections);
		this.theme = config.theme;
		this.callbacks = callbacks;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold("Thinktank Roster")), 0, 0));
		this.addChild(new Text(this.theme.fg("muted", "Add any Pi model any number of times. Changes apply immediately."), 0, 0));
		this.addChild(new Spacer(1));

		this.slotContainer = new Container();
		this.addChild(this.slotContainer);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));

		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);
		this.addChild(new DynamicBorder());

		this.refresh();
	}

	private get activeEntry(): ThinktankRosterEntry | undefined {
		return this.selections[this.selectedAgentIndex];
	}

	private getFooterText(): string {
		return this.theme.fg(
			"dim",
			[
				rawKeyHint("↑↓", "model"),
				rawKeyHint("←→", "effort"),
				keyHint("tui.input.tab", "agent"),
				rawKeyHint("+", "add"),
				rawKeyHint("Delete", "remove"),
				rawKeyHint("Space", "enable/disable"),
				keyHint("tui.select.confirm", this.activeEntry ? "set model" : "add"),
				keyHint("tui.select.cancel", "close"),
			].join("  "),
		);
	}

	private buildActiveModelItems(): RosterModelItem[] {
		return this.allModels
			.map((model) => ({ fullId: getThinktankModelReference(model), model }))
			.sort(compareModels(this.activeEntry));
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildActiveModelItems();
		this.filteredModels = query
			? fuzzyFilter(items, query, (item) => `${item.fullId} ${item.model.name ?? ""}`)
			: items;

		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(item.model, this.activeEntry?.model));
		this.selectedModelIndex =
			currentIndex >= 0
				? currentIndex
				: Math.min(this.selectedModelIndex, Math.max(0, this.filteredModels.length - 1));

		this.updateSlots();
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private updateSlots(): void {
		this.slotContainer.clear();
		if (this.selections.length === 0) {
			this.slotContainer.addChild(new Text(this.theme.fg("warning", "  No agents configured. Select a model and press Enter or + to add one."), 0, 0));
			return;
		}
		const maxVisibleAgents = 6;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedAgentIndex - Math.floor(maxVisibleAgents / 2), this.selections.length - maxVisibleAgents),
		);
		const endIndex = Math.min(startIndex + maxVisibleAgents, this.selections.length);
		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.selections[i]!;
			const isActive = i === this.selectedAgentIndex;
			const prefix = isActive ? this.theme.fg("accent", "→ ") : "  ";
			const agentText = isActive ? this.theme.fg("accent", `Agent ${i + 1}`.padEnd(9)) : `Agent ${i + 1}`.padEnd(9);
			const modelText = entry.disabled
				? this.theme.fg("muted", `disabled ${entry.model.provider}/${entry.model.id}:${entry.thinkingLevel}`)
				: `${entry.model.provider}/${entry.model.id}:${entry.thinkingLevel}`;
			this.slotContainer.addChild(new Text(`${prefix}${agentText} ${modelText}`, 0, 0));
		}
		if (startIndex > 0 || endIndex < this.selections.length) {
			this.slotContainer.addChild(new Text(this.theme.fg("muted", `  Agent ${this.selectedAgentIndex + 1}/${this.selections.length}`), 0, 0));
		}
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No configured Pi models match the search."), 0, 0));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedModelIndex - Math.floor(this.maxVisible / 2), this.filteredModels.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredModels.length);
		const currentEntry = this.activeEntry;

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i]!;
			const isSelected = i === this.selectedModelIndex;
			const isCurrent = modelsAreEqual(item.model, currentEntry?.model);
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const modelText = isSelected ? this.theme.fg("accent", item.model.id) : item.model.id;
			const providerBadge = this.theme.fg("muted", ` [${item.model.provider}]`);
			const effort = isCurrent ? this.theme.fg("muted", `:${currentEntry?.thinkingLevel}`) : "";
			const disabled = isCurrent && currentEntry?.disabled ? this.theme.fg("muted", " disabled") : "";
			const checkmark = isCurrent ? this.theme.fg(currentEntry?.disabled ? "muted" : "success", " ✓") : "";
			this.listContainer.addChild(new Text(`${prefix}${modelText}${providerBadge}${effort}${disabled}${checkmark}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedModelIndex + 1}/${this.filteredModels.length})`), 0, 0));
		}

		const selected = this.filteredModels[this.selectedModelIndex];
		if (selected) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  Model Name: ${selected.model.name ?? selected.model.id}`), 0, 0));
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  Effort: ${getThinktankSupportedThinkingLevels(selected.model).join(", ")}`), 0, 0));
		}
	}

	private moveAgent(delta: number): void {
		if (this.selections.length === 0) return;
		this.selectedAgentIndex = (this.selectedAgentIndex + delta + this.selections.length) % this.selections.length;
		this.selectedModelIndex = 0;
		this.refresh();
	}

	private emitChange(): void {
		void this.callbacks.onChange(cloneSelections(this.selections));
		this.refresh();
	}

	private addCurrentModel(): void {
		const item = this.filteredModels[this.selectedModelIndex];
		if (!item) return;
		this.selections = [
			...this.selections,
			{
				id: createThinktankAgentId(this.selections.map((entry) => entry.id)),
				model: item.model,
				thinkingLevel: clampThinktankThinkingLevel(item.model, undefined),
				disabled: false,
			},
		];
		this.selectedAgentIndex = this.selections.length - 1;
		this.emitChange();
	}

	private selectCurrentModel(): void {
		const item = this.filteredModels[this.selectedModelIndex];
		if (!item) return;
		const previousEntry = this.activeEntry;
		if (!previousEntry) {
			this.addCurrentModel();
			return;
		}
		this.selections = this.selections.map((entry, index) =>
			index === this.selectedAgentIndex
				? {
						...entry,
						model: item.model,
						thinkingLevel: clampThinktankThinkingLevel(item.model, previousEntry.thinkingLevel),
						disabled: false,
					}
				: entry,
		);
		this.emitChange();
	}

	private removeActiveAgent(): void {
		if (!this.activeEntry) return;
		this.selections = this.selections.filter((_entry, index) => index !== this.selectedAgentIndex);
		this.selectedAgentIndex = Math.min(this.selectedAgentIndex, Math.max(0, this.selections.length - 1));
		this.emitChange();
	}

	private toggleActiveAgentEnabled(): void {
		if (!this.activeEntry) return;
		this.selections = this.selections.map((entry, index) =>
			index === this.selectedAgentIndex ? { ...entry, disabled: !entry.disabled } : entry,
		);
		this.emitChange();
	}

	private cycleActiveThinkingLevel(delta: number): void {
		const currentEntry = this.activeEntry;
		if (!currentEntry) return;
		const levels = getThinktankSupportedThinkingLevels(currentEntry.model);
		if (levels.length === 0) return;
		const currentLevel: ThinkingLevel = currentEntry.thinkingLevel;
		const currentIndex = Math.max(0, levels.indexOf(currentLevel));
		const nextLevel = levels[(currentIndex + delta + levels.length) % levels.length]!;
		this.selections = this.selections.map((entry, index) =>
			index === this.selectedAgentIndex ? { ...entry, thinkingLevel: nextLevel } : entry,
		);
		this.emitChange();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.input.tab")) {
			this.moveAgent(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.moveAgent(-1);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedModelIndex = this.selectedModelIndex === 0 ? this.filteredModels.length - 1 : this.selectedModelIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedModelIndex = this.selectedModelIndex === this.filteredModels.length - 1 ? 0 : this.selectedModelIndex + 1;
			this.updateList();
			return;
		}
		if (this.searchInput.getValue() === "" && data === "+") {
			this.addCurrentModel();
			return;
		}
		if (this.searchInput.getValue() === "" && matchesKey(data, Key.delete)) {
			this.removeActiveAgent();
			return;
		}
		if (this.searchInput.getValue() === "" && matchesKey(data, Key.space)) {
			this.toggleActiveAgentEnabled();
			return;
		}
		if (this.searchInput.getValue() === "" && matchesKey(data, Key.left)) {
			this.cycleActiveThinkingLevel(-1);
			return;
		}
		if (this.searchInput.getValue() === "" && matchesKey(data, Key.right)) {
			this.cycleActiveThinkingLevel(1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.selectCurrentModel();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.callbacks.onCancel();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}
		this.searchInput.handleInput(data);
		this.refresh();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
