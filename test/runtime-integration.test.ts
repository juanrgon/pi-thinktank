// First true integration test of ThinktankRoomRuntime, instantiating the
// real class against the fakes from test/_fakes/runtime-deps.ts.
//
// This file is the F4 milestone: it imports room-runtime.ts directly,
// which was only made possible by F1 (narrow dep interfaces), F2 (shallow
// refactor), and F2.5 (deep dependency injection, so no Pi value imports
// remain in the runtime's transitive graph).
//
// F4.0: smallest viable scenario — construct the runtime, run rebuildAgents
//       via ready(), verify the injected createLabSession was called with
//       the model selected by the roster logic.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ThinktankRoomRuntime } from "../room-runtime.ts";
import {
	createFakeModel,
	FakeRuntimeDeps,
	FakeServices,
	FakeSession,
} from "./_fakes/runtime-deps.ts";

describe("ThinktankRoomRuntime integration (F4)", () => {
	test("rebuilds one agent from a fake registry and routes session creation through injected deps", async () => {
		// Seed the registry with a single model that satisfies the OpenAI lab
		// definition (provider: github-copilot, id contains "gpt-5.5").
		const services = new FakeServices({
			models: [
				createFakeModel({
					provider: "github-copilot",
					id: "gpt-5.5",
					name: "GPT-5.5",
				}),
			],
		});
		const deps = new FakeRuntimeDeps();

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: {},
			callbacks: {},
		});

		// rebuildAgents runs inside the constructor via readyPromise.
		await room.ready();

		// 1. The runtime should have populated exactly one agent in the room.
		const agents = room.agentInfos;
		assert.equal(agents.length, 1, "expected one agent");
		assert.equal(agents[0]?.id, "openai");
		assert.equal(agents[0]?.provider, "github-copilot");
		assert.equal(agents[0]?.model, "gpt-5.5");

		// 2. rebuildAgents must have routed session creation through the
		//    injected dependency. If F2.5's dep injection regressed and the
		//    runtime called SessionManager.continueRecent directly, this fails.
		assert.equal(
			deps.createLabSessionCalls.length,
			1,
			"createLabSession should be called once per enabled lab",
		);
		const call = deps.createLabSessionCalls[0];
		assert.ok(call, "createLabSession call recorded");
		assert.equal(call.model.id, "gpt-5.5");
		assert.equal(call.model.provider, "github-copilot");
		assert.deepEqual(
			[...call.tools],
			["read", "bash", "edit", "write", "grep", "find", "ls"],
		);

		// 3. The fake session created by deps.createLabSession should be
		//    tracked and reachable from the test.
		assert.equal(deps.createdSessions.length, 1);

		// 4. modelRegistry.refresh() was called to populate the available
		//    model list before roster selection.
		assert.ok(services.modelRegistry.refreshCount >= 1, "refresh called");

		room.dispose();
	});

	test("submitHumanPrompt drives an opening turn on the only enabled agent", async () => {
		const services = new FakeServices({
			models: [
				createFakeModel({
					provider: "github-copilot",
					id: "gpt-5.5",
					name: "GPT-5.5",
				}),
			],
		});
		const deps = new FakeRuntimeDeps();
		const events: string[] = [];

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: {},
			callbacks: {
				onAgentTurnStart: (agent) => events.push(`start:${agent.id}`),
				onAgentTurnEnd: (agent, text) => events.push(`end:${agent.id}:${text}`),
				onRoomIdle: () => events.push("idle"),
			},
		});
		await room.ready();

		// Script the assistant response for the agent's opening turn. The fake
		// session pushes the message into its messages array and emits
		// message_end when prompt() is called, which is what the runtime reads
		// via getLastAssistantText.
		const session = deps.createdSessions[0];
		assert.ok(session, "runtime should have created exactly one fake session");
		session.queuePromptMessage("hello from gpt");

		// Use a prompt without collaboration keywords so the dynamic phase
		// goes idle immediately after openings (default minDynamicExchanges=0).
		// completeSimple is not seeded so the impulse poll returns malformed
		// JSON, which is treated as pass with urgency 0 -> chooser returns idle.
		await room.submitHumanPrompt("simple test prompt without keywords");

		// The runtime should have invoked session.prompt exactly once for the
		// opening turn.
		assert.equal(session.promptCalls.length, 1, "expected one prompt call for the opening turn");

		// The prompt the runtime built should embed the human prompt text.
		const promptText = session.promptCalls[0]?.prompt ?? "";
		assert.ok(
			promptText.includes("simple test prompt without keywords"),
			"built prompt should contain the human input verbatim",
		);

		// Callbacks should have fired in the expected sequence.
		assert.ok(events.includes("start:openai"), `turn start callback fired (events: ${events.join(",")})`);
		assert.ok(
			events.some((e) => e.startsWith("end:openai") && e.includes("hello from gpt")),
			`turn end callback fired with scripted text (events: ${events.join(",")})`,
		);
		assert.ok(events.includes("idle"), `room idle callback fired (events: ${events.join(",")})`);

		room.dispose();
	});

	test("pre-turn compaction runs before prompting an agent near the threshold", async () => {
		const services = new FakeServices({
			models: [
				createFakeModel({
					provider: "github-copilot",
					id: "gpt-5.5",
					name: "GPT-5.5",
					contextWindow: 128_000,
				}),
			],
		});
		const deps = new FakeRuntimeDeps();
		const statuses: string[] = [];
		const session = new FakeSession({
			contextUsage: {
				tokens: 110_000,
				contextWindow: 128_000,
			},
		});
		deps.nextSessions.push(session);

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: {},
			callbacks: {
				onStatus: (status) => statuses.push(status),
			},
		});
		await room.ready();

		// The fake prompt implementation runs this assertion at the moment
		// session.prompt() is invoked, so it proves compaction already happened.
		session.queuePromptScript({
			kind: "run",
			run: (fakeSession) => {
				assert.equal(fakeSession.compactCalls.length, 1, "compact() should be called before prompt()");
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "compaction happened first" }],
				};
				fakeSession.messages.push(message);
				fakeSession.emit({ type: "message_end", message });
			},
		});

		await room.submitHumanPrompt("simple prompt that should trigger one opening turn");

		assert.equal(session.compactCalls.length, 1, "expected exactly one proactive compaction");
		assert.equal(session.promptCalls.length, 1, "expected exactly one visible prompt");
		assert.ok(
			session.compactCalls[0]?.includes("Summarize this Lab Agent's private Thinktank room-session context"),
			"precompaction instructions should be passed to compact()",
		);
		assert.ok(
			statuses.some((status) => status.includes("refreshing private context")),
			`expected user-facing precompaction status (statuses: ${statuses.join(", ")})`,
		);

		room.dispose();
	});

	test("disabled labs are excluded from the agent list", async () => {
		const services = new FakeServices({
			models: [
				createFakeModel({ provider: "github-copilot", id: "gpt-5.5" }),
				createFakeModel({
					provider: "anthropic",
					id: "claude-opus-4.7",
					name: "Claude Opus",
				}),
			],
		});
		const deps = new FakeRuntimeDeps();

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: {
				anthropic: {
					provider: "anthropic",
					model: "claude-opus-4.7",
					thinkingLevel: "high",
					disabled: true,
				},
			},
			callbacks: {},
		});
		await room.ready();

		const agents = room.agentInfos;
		assert.equal(agents.length, 1, "anthropic should be excluded (disabled)");
		assert.equal(agents[0]?.id, "openai");

		// createLabSession should only have fired for the enabled lab.
		assert.equal(deps.createLabSessionCalls.length, 1);
		assert.equal(deps.createLabSessionCalls[0]?.model.provider, "github-copilot");

		room.dispose();
	});
});
