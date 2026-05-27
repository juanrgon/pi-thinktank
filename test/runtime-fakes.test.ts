import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { ThinktankServicesLike, ThinktankSessionLike } from "../runtime-deps.ts";
import {
	createAssistantMessage,
	createFakeModel,
	FakeModelRegistry,
	FakeRuntimeDeps,
	FakeServices,
	FakeSession,
	FakeSettingsManager,
} from "./_fakes/runtime-deps.ts";

describe("runtime dependency fakes", () => {
	test("FakeSession records prompts, appends scripted assistant messages, and emits events", async () => {
		const session: ThinktankSessionLike = new FakeSession({ sessionFile: "/tmp/fake.jsonl" });
		const events: string[] = [];
		const unsubscribe = session.subscribe((event) => events.push(event.type));

		(session as FakeSession).queuePromptMessage("hello from fake");
		await session.prompt("prompt text", { expandPromptTemplates: false, source: "extension" });

		assert.equal((session as FakeSession).promptCalls.length, 1);
		assert.equal((session as FakeSession).promptCalls[0]?.prompt, "prompt text");
		assert.equal(session.messages.length, 1);
		assert.deepEqual(events, ["message_end"]);

		unsubscribe();
		(session as FakeSession).emit({ type: "message_update", message: createAssistantMessage("ignored") });
		assert.deepEqual(events, ["message_end"]);
	});

	test("FakeSession can emit scripted events before failing a prompt", async () => {
		const session = new FakeSession();
		const seen: string[] = [];
		session.subscribe((event) => seen.push(event.type));
		session.queuePromptScript({
			kind: "error",
			error: new Error("boom"),
			events: [{ type: "message_update", message: createAssistantMessage("partial") }],
		});

		await assert.rejects(() => session.prompt("fail", { expandPromptTemplates: false }), /boom/);
		assert.deepEqual(seen, ["message_update"]);
		assert.equal(session.messages.length, 0);
	});

	test("FakeSession records compaction and can fail compaction", async () => {
		const session = new FakeSession();
		await session.compact("summarize");
		assert.deepEqual(session.compactCalls, ["summarize"]);

		session.compactError = new Error("compact failed");
		await assert.rejects(() => session.compact("again"), /compact failed/);
		assert.deepEqual(session.compactCalls, ["summarize", "again"]);
	});

	test("FakeSession tracks abort and dispose state", async () => {
		const session = new FakeSession();
		await session.abort();
		await session.abortCompaction();
		session.dispose();
		assert.equal(session.aborted, true);
		assert.equal(session.compactionAborted, true);
		assert.equal(session.disposed, true);
	});

	test("FakeServices satisfies ThinktankServicesLike and exposes models/settings", async () => {
		const model = createFakeModel({ id: "claude-opus-4.7", provider: "github-copilot" });
		const services: ThinktankServicesLike = new FakeServices({ models: [model] });
		services.modelRegistry.refresh();

		assert.equal(services.modelRegistry.getAvailable()[0]?.id, "claude-opus-4.7");
		assert.deepEqual(services.settingsManager.getCompactionSettings(), { enabled: true, reserveTokens: 16_384 });

		const auth = await services.modelRegistry.getApiKeyAndHeaders(model);
		assert.equal(auth.ok, true);
		assert.equal((services.modelRegistry as FakeModelRegistry).refreshCount, 1);
	});

	test("FakeSettingsManager can be configured", () => {
		const settings = new FakeSettingsManager({ enabled: false, reserveTokens: 42 });
		assert.deepEqual(settings.getCompactionSettings(), { enabled: false, reserveTokens: 42 });
	});

	test("FakeRuntimeDeps records completion calls and returns queued completions", async () => {
		const deps = new FakeRuntimeDeps();
		const model = createFakeModel();
		deps.completionQueue.push(createAssistantMessage("{\"action\":\"pass\"}"));

		const result = await deps.completeSimple(
			model,
			{ systemPrompt: "system", messages: [{ role: "user", content: "prompt", timestamp: 1 }] },
			{ apiKey: "key", reasoning: "low" },
		);

		assert.equal(result.role, "assistant");
		assert.equal(deps.completionCalls.length, 1);
		assert.equal(deps.completionCalls[0]?.auth.reasoning, "low");
	});

	test("FakeRuntimeDeps returns queued lab sessions", async () => {
		const deps = new FakeRuntimeDeps();
		const session = new FakeSession({ sessionFile: "/tmp/session.jsonl" });
		deps.nextSessions.push(session);

		const created = await deps.createLabSession({
			cwd: "/tmp/project",
			sessionDir: "/tmp/lab",
			services: new FakeServices(),
			model: createFakeModel(),
			thinkingLevel: "high",
			tools: ["read"],
		});

		assert.equal(created.session, session);
		assert.equal(deps.createLabSessionCalls.length, 1);
		assert.deepEqual(deps.createLabSessionCalls[0]?.tools, ["read"]);
	});

	test("FakeRuntimeDeps clampThinkingLevel defaults to identity and can be overridden", () => {
		const deps = new FakeRuntimeDeps();
		const model = createFakeModel();
		assert.equal(deps.clampThinkingLevel(model, "xhigh"), "xhigh");
		deps.clampedLevel = "low";
		assert.equal(deps.clampThinkingLevel(model, "xhigh"), "low");
	});
});
