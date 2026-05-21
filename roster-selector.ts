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
	getThinktankModelReference,
	getThinktankModelsForLab,
	getThinktankSupportedThinkingLevels,
	type LabId,
	THINKTANK_LAB_DEFINITIONS,
	type ThinktankLabDefinition,
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
	return Object.fromEntries(
		Object.entries(selections).map(([labId, entry]) => [labId, entry ? { ...entry } : undefined]),
	) as ThinktankRoster;
}

function compareModelsForLab(definition: ThinktankLabDefinition, selectedEntry: ThinktankRosterEntry | undefined) {
	return (a: RosterModelItem, b: RosterModelItem): number => {
		const aSelected = modelsAreEqual(a.model, selectedEntry?.model);
		const bSelected = modelsAreEqual(b.model, selectedEntry?.model);
		if (aSelected && !bSelected) return -1;
		if (!aSelected && bSelected) return 1;

		const aPreferred = definition.preferredModelIds.indexOf(a.model.id);
		const bPreferred = definition.preferredModelIds.indexOf(b.model.id);
		if (aPreferred >= 0 || bPreferred >= 0) {
			if (aPreferred < 0) return 1;
			if (bPreferred < 0) return -1;
			if (aPreferred !== bPreferred) return aPreferred - bPreferred;
		}

		const aProvider = definition.providerCandidates.indexOf(a.model.provider);
		const bProvider = definition.providerCandidates.indexOf(b.model.provider);
		if (aProvider !== bProvider) return aProvider - bProvider;

		return a.model.id.localeCompare(b.model.id);
	};
}

export class RosterSelectorComponent extends Container implements Focusable {
	private allModels: Model<Api>[];
	private selections: ThinktankRoster;
	private callbacks: RosterSelectorCallbacks;
	private selectedLabIndex = 0;
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
		this.addChild(new Text(this.theme.fg("muted", "Saved roster. Changes apply immediately when you select."), 0, 0));
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

	private get activeLab(): ThinktankLabDefinition {
		return THINKTANK_LAB_DEFINITIONS[this.selectedLabIndex] ?? THINKTANK_LAB_DEFINITIONS[0]!;
	}

	private getFooterText(): string {
		return this.theme.fg(
			"dim",
			[
				rawKeyHint("↑↓", "model"),
				rawKeyHint("←→", "effort"),
				keyHint("tui.input.tab", "slot"),
				rawKeyHint("Space", "enable/disable"),
				keyHint("tui.select.confirm", "select"),
				keyHint("tui.select.cancel", "close"),
			].join("  "),
		);
	}

	private buildActiveModelItems(): RosterModelItem[] {
		const lab = this.activeLab;
		const selectedEntry = this.selections[lab.id];
		return getThinktankModelsForLab(this.allModels, lab)
			.map((model) => ({
				fullId: getThinktankModelReference(model),
				model,
			}))
			.sort(compareModelsForLab(lab, selectedEntry));
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildActiveModelItems();
		this.filteredModels = query
			? fuzzyFilter(items, query, (item) => `${item.fullId} ${item.model.name ?? ""}`)
			: items;

		const currentEntry = this.selections[this.activeLab.id];
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(item.model, currentEntry?.model));
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
		for (let i = 0; i < THINKTANK_LAB_DEFINITIONS.length; i++) {
			const lab = THINKTANK_LAB_DEFINITIONS[i]!;
			const entry = this.selections[lab.id];
			const isActive = i === this.selectedLabIndex;
			const prefix = isActive ? this.theme.fg("accent", "→ ") : "  ";
			const labText = isActive ? this.theme.fg("accent", lab.shortName.padEnd(9)) : lab.shortName.padEnd(9);
			const modelText = entry
				? entry.disabled
					? this.theme.fg("muted", `disabled ${entry.model.provider}/${entry.model.id}:${entry.thinkingLevel}`)
					: `${entry.model.provider}/${entry.model.id}:${entry.thinkingLevel}`
				: this.theme.fg("warning", `missing ${lab.providerCandidates.join("|")}`);
			this.slotContainer.addChild(new Text(`${prefix}${labText} ${modelText}`, 0, 0));
		}
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(
				new Text(this.theme.fg("muted", `  No configured ${this.activeLab.shortName} models`), 0, 0),
			);
			this.listContainer.addChild(
				new Text(this.theme.fg("muted", `  Providers: ${this.activeLab.providerCandidates.join(", ")}`), 0, 0),
			);
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedModelIndex - Math.floor(this.maxVisible / 2),
				this.filteredModels.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredModels.length);
		const currentEntry = this.selections[this.activeLab.id];

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
			this.listContainer.addChild(
				new Text(`${prefix}${modelText}${providerBadge}${effort}${disabled}${checkmark}`, 0, 0),
			);
		}

		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			this.listContainer.addChild(
				new Text(this.theme.fg("muted", `  (${this.selectedModelIndex + 1}/${this.filteredModels.length})`), 0, 0),
			);
		}

		const selected = this.filteredModels[this.selectedModelIndex];
		if (selected) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
			this.listContainer.addChild(
				new Text(
					this.theme.fg("muted", `  Effort: ${getThinktankSupportedThinkingLevels(selected.model).join(", ")}`),
					0,
					0,
				),
			);
		}
	}

	private moveLab(delta: number): void {
		const count = THINKTANK_LAB_DEFINITIONS.length;
		this.selectedLabIndex = (this.selectedLabIndex + delta + count) % count;
		this.selectedModelIndex = 0;
		this.refresh();
	}

	private selectCurrentModel(): void {
		const item = this.filteredModels[this.selectedModelIndex];
		if (!item) {
			return;
		}
		const labId: LabId = this.activeLab.id;
		const previousEntry = this.selections[labId];
		this.selections = {
			...this.selections,
			[labId]: {
				model: item.model,
				thinkingLevel: clampThinktankThinkingLevel(item.model, previousEntry?.thinkingLevel),
				disabled: false,
			},
		};
		void this.callbacks.onChange(cloneSelections(this.selections));
		this.moveLab(1);
	}

	private toggleActiveLabEnabled(): void {
		const labId: LabId = this.activeLab.id;
		const currentEntry = this.selections[labId];
		const model = currentEntry?.model ?? this.filteredModels[this.selectedModelIndex]?.model;
		if (!model) {
			return;
		}

		this.selections = {
			...this.selections,
			[labId]: {
				model,
				thinkingLevel: currentEntry?.thinkingLevel ?? clampThinktankThinkingLevel(model, undefined),
				disabled: !currentEntry?.disabled,
			},
		};
		void this.callbacks.onChange(cloneSelections(this.selections));
		this.refresh();
	}

	private cycleActiveThinkingLevel(delta: number): void {
		const labId: LabId = this.activeLab.id;
		const currentEntry = this.selections[labId];
		const model = currentEntry?.model ?? this.filteredModels[this.selectedModelIndex]?.model;
		if (!model) {
			return;
		}

		const levels = getThinktankSupportedThinkingLevels(model);
		if (levels.length === 0) {
			return;
		}

		const currentLevel: ThinkingLevel = currentEntry?.thinkingLevel ?? clampThinktankThinkingLevel(model, undefined);
		const currentIndex = Math.max(0, levels.indexOf(currentLevel));
		const nextLevel = levels[(currentIndex + delta + levels.length) % levels.length]!;
		this.selections = {
			...this.selections,
			[labId]: {
				model,
				thinkingLevel: nextLevel,
				disabled: currentEntry?.disabled,
			},
		};
		void this.callbacks.onChange(cloneSelections(this.selections));
		this.refresh();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.input.tab")) {
			this.moveLab(1);
			return;
		}

		if (matchesKey(data, Key.shift("tab"))) {
			this.moveLab(-1);
			return;
		}

		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedModelIndex =
				this.selectedModelIndex === 0 ? this.filteredModels.length - 1 : this.selectedModelIndex - 1;
			this.updateList();
			return;
		}

		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedModelIndex =
				this.selectedModelIndex === this.filteredModels.length - 1 ? 0 : this.selectedModelIndex + 1;
			this.updateList();
			return;
		}

		if (this.searchInput.getValue() === "" && matchesKey(data, Key.space)) {
			this.toggleActiveLabEnabled();
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
