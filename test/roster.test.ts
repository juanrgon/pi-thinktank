// Tests for thinktank roster model eligibility, especially the github-copilot
// family-needle gate that decides which Copilot models appear under each lab.
//
// roster.ts has only type-only Pi imports, so it loads under
// --experimental-strip-types without resolving Pi peer dependencies.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	getThinktankModelsForLab,
	getThinktankVisibleName,
	isThinktankModelEligibleForLab,
	selectThinktankLabModel,
	THINKTANK_LAB_DEFINITIONS,
} from "../roster.ts";

const anthropic = THINKTANK_LAB_DEFINITIONS.find((d) => d.id === "anthropic")!;
const openai = THINKTANK_LAB_DEFINITIONS.find((d) => d.id === "openai")!;
const google = THINKTANK_LAB_DEFINITIONS.find((d) => d.id === "google")!;

// Minimal Model<Api> stand-in; the roster functions only read provider/id/name.
function model(provider: string, id: string, name?: string): any {
	return { provider, id, name: name ?? id, contextWindow: 128_000, api: "anthropic-messages" };
}

describe("thinktank roster eligibility (github-copilot family gate)", () => {
	test("Copilot Claude Quiche (EAP) is eligible for the Anthropic lab", () => {
		assert.equal(
			isThinktankModelEligibleForLab(model("github-copilot", "claude-quiche-eap", "Claude Quiche (EAP)"), anthropic),
			true,
		);
	});

	test("Copilot opus stays eligible for the Anthropic lab", () => {
		assert.equal(isThinktankModelEligibleForLab(model("github-copilot", "claude-opus-4.7"), anthropic), true);
	});

	test("Copilot gpt-5.5 is not eligible for the Anthropic lab", () => {
		assert.equal(isThinktankModelEligibleForLab(model("github-copilot", "gpt-5.5"), anthropic), false);
	});

	test("Copilot Claude is not eligible for the OpenAI lab", () => {
		assert.equal(isThinktankModelEligibleForLab(model("github-copilot", "claude-quiche-eap"), openai), false);
	});

	test("Copilot gemini is eligible for Google but not Anthropic", () => {
		assert.equal(isThinktankModelEligibleForLab(model("github-copilot", "gemini-3.1-pro-preview"), google), true);
		assert.equal(isThinktankModelEligibleForLab(model("github-copilot", "gemini-3.1-pro-preview"), anthropic), false);
	});

	test("native anthropic provider bypasses the family needle gate", () => {
		assert.equal(isThinktankModelEligibleForLab(model("anthropic", "some-future-claude-codename"), anthropic), true);
	});

	test("getThinktankModelsForLab keeps only Copilot Claude models for Anthropic", () => {
		const models = [
			model("github-copilot", "gpt-5.5"),
			model("github-copilot", "claude-quiche-eap", "Claude Quiche (EAP)"),
			model("github-copilot", "claude-opus-4.7"),
			model("github-copilot", "gemini-3.1-pro-preview"),
		];
		const ids = getThinktankModelsForLab(models, anthropic)
			.map((m) => m.id)
			.sort();
		assert.deepEqual(ids, ["claude-opus-4.7", "claude-quiche-eap"]);
	});

	test("auto-selection prefers claude-quiche-eap for the Anthropic lab when present", () => {
		const models = [
			model("github-copilot", "claude-opus-4.7"),
			model("github-copilot", "claude-quiche-eap", "Claude Quiche (EAP)"),
		];
		assert.equal(selectThinktankLabModel(models, anthropic)?.id, "claude-quiche-eap");
	});

	test("quiche keeps a truthful visible name rather than the Opus display name", () => {
		const name = getThinktankVisibleName(
			anthropic,
			model("github-copilot", "claude-quiche-eap", "Claude Quiche (EAP)"),
		);
		assert.equal(name, "Anthropic (Claude Quiche (EAP))");
	});
});
