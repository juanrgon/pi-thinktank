// Tests for the dynamic Thinktank roster. roster.ts has only type-only Pi
// imports, so it loads under --experimental-strip-types without resolving Pi
// peer dependencies.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	getThinktankAvailableModels,
	getThinktankVisibleName,
	selectThinktankRoster,
} from "../roster.ts";

// Minimal Model<Api> stand-in; the roster functions only read provider/id/name.
function model(provider: string, id: string, name?: string): any {
	return { provider, id, name: name ?? id, contextWindow: 128_000, api: "anthropic-messages" };
}

describe("dynamic thinktank roster", () => {
	test("starts empty even when Pi has available models", () => {
		const available = [model("openai", "gpt-5.5"), model("ollama", "llama3.1:8b")];
		assert.deepEqual(selectThinktankRoster(available), []);
	});

	test("allows any Pi-available model without provider or family gates", () => {
		const available = [
			model("ollama", "llama3.1:8b"),
			model("custom-proxy", "deepseek-v4-pro"),
		];
		const roster = selectThinktankRoster(available, [
			{ id: "local", provider: "ollama", model: "llama3.1:8b" },
			{ id: "deepseek", provider: "custom-proxy", model: "deepseek-v4-pro" },
		]);
		assert.deepEqual(roster.map((entry) => `${entry.model.provider}/${entry.model.id}`), [
			"ollama/llama3.1:8b",
			"custom-proxy/deepseek-v4-pro",
		]);
	});

	test("allows the exact same provider/model more than once", () => {
		const available = [model("anthropic", "claude-sonnet")];
		const roster = selectThinktankRoster(available, [
			{ id: "agent-a", provider: "anthropic", model: "claude-sonnet" },
			{ id: "agent-b", provider: "anthropic", model: "claude-sonnet" },
		]);
		assert.equal(roster.length, 2);
		assert.deepEqual(roster.map((entry) => entry.id), ["agent-a", "agent-b"]);
		assert.equal(roster[0]?.model, roster[1]?.model);
	});

	test("drops duplicate or unsafe agent identities while preserving duplicate models", () => {
		const available = [model("openai", "gpt")];
		const roster = selectThinktankRoster(available, [
			{ id: "same-id", provider: "openai", model: "gpt" },
			{ id: "same-id", provider: "openai", model: "gpt" },
			{ id: "../outside", provider: "openai", model: "gpt" },
		]);
		assert.equal(roster.length, 1);
	});

	test("ignores saved selections whose models are no longer available", () => {
		const roster = selectThinktankRoster([model("openai", "gpt")], [
			{ id: "missing", provider: "ollama", model: "gone" },
		]);
		assert.deepEqual(roster, []);
	});

	test("preserves order, disabled state, and clamps thinking through the injected helper", () => {
		const available = [model("custom", "a"), model("custom", "b")];
		const roster = selectThinktankRoster(
			available,
			[
				{ id: "b", provider: "custom", model: "b", thinkingLevel: "xhigh", disabled: true },
				{ id: "a", provider: "custom", model: "a", thinkingLevel: "low" },
			],
			(_model, level) => (level === "xhigh" ? "high" : (level ?? "off")),
		);
		assert.deepEqual(roster.map((entry) => entry.id), ["b", "a"]);
		assert.equal(roster[0]?.thinkingLevel, "high");
		assert.equal(roster[0]?.disabled, true);
		assert.equal(roster[1]?.thinkingLevel, "low");
	});

	test("getThinktankAvailableModels returns every model", () => {
		const available = [model("github-copilot", "gpt"), model("github-copilot", "claude"), model("local", "qwen")];
		assert.deepEqual(getThinktankAvailableModels(available), available);
	});

	test("duplicate visible names can be numbered", () => {
		const duplicate = model("custom", "id", "Same Model");
		assert.equal(getThinktankVisibleName(duplicate), "Same Model");
		assert.equal(getThinktankVisibleName(duplicate, 2), "Same Model #2");
	});
});
