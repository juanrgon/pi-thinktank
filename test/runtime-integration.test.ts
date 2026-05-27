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

import { readFileSync } from "node:fs";
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

	test("agent suppressed after two same-category failures inside one collaborative prompt", async () => {
		// Two enabled labs so the failing one can be suppressed rather than
		// triggering the last-agent halt path.
		const services = new FakeServices({
			models: [
				createFakeModel({
					provider: "github-copilot",
					id: "gpt-5.5",
					name: "GPT-5.5",
				}),
				createFakeModel({
					provider: "anthropic",
					id: "claude-opus-4.7",
					name: "Claude Opus 4.7",
				}),
			],
		});
		const deps = new FakeRuntimeDeps();
		const errorEvents: { id: string; category: string }[] = [];

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-suppress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: {},
			callbacks: {
				onAgentTurnError: (agent, _phase, error) => {
					errorEvents.push({ id: agent.id, category: error.category });
				},
			},
		});
		await room.ready();

		assert.equal(deps.createdSessions.length, 2);
		const openaiIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "github-copilot");
		const anthropicIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "anthropic");
		assert.ok(openaiIdx >= 0 && anthropicIdx >= 0, "both labs should have session-create calls");
		const openaiSession = deps.createdSessions[openaiIdx];
		const anthropicSession = deps.createdSessions[anthropicIdx];
		assert.ok(openaiSession && anthropicSession);

		// Script openai to fail with the same error category every time.
		// "503" classifies as provider_error in agent-error.ts. Queue many
		// errors; only the first two should actually be consumed because the
		// second failure triggers suppression for the rest of the prompt.
		const providerError = new Error("503 Service Unavailable from provider");
		for (let i = 0; i < 5; i++) {
			openaiSession.queuePromptScript({ kind: "error", error: providerError });
		}

		// Script anthropic to succeed many times so the dynamic phase has
		// something to keep doing while the room satisfies the collaboration
		// minimum exchange floor.
		for (let i = 0; i < 8; i++) {
			anthropicSession.queuePromptMessage(`anthropic reply ${i + 1}`);
		}

		// Use a collaboration-style human prompt so isCollaborationPrompt fires
		// and minDynamicExchanges = agents.length * 2 = 4. The forced_continuation
		// fallback will then re-pick openai during the dynamic phase even after
		// its opening turn failed, giving it a second chance to fail and trip
		// the suppression threshold.
		await room.submitHumanPrompt("please iterate on this together");

		// Suppression triggers after the SECOND same-category failure. Once it
		// trips, activeAgents() filters openai out, so subsequent turns can
		// only be assigned to anthropic. Therefore openai's prompt() should
		// have been called exactly twice, not more.
		assert.equal(
			openaiSession.promptCalls.length,
			2,
			`openai should have been called exactly twice (opening + one forced-continuation) before suppression; recorded: ${openaiSession.promptCalls.length}`,
		);

		// Anthropic should have been called several times: opening turn +
		// one or more dynamic turns once openai is out of the pool.
		assert.ok(
			anthropicSession.promptCalls.length >= 3,
			`anthropic should have been called at least 3 times; recorded: ${anthropicSession.promptCalls.length}`,
		);

		// Both errors should have been classified the same way (provider_error)
		// for suppression to fire. If classify drifted, this catches it.
		const openaiErrors = errorEvents.filter((e) => e.id === "openai");
		assert.equal(openaiErrors.length, 2, "expected exactly two openai errors");
		assert.equal(openaiErrors[0]?.category, "provider_error");
		assert.equal(openaiErrors[1]?.category, "provider_error");

		room.dispose();
	});

	test("collaboration prompts force continuation even when impulse polls pass", async () => {
		const services = new FakeServices({
			models: [
				createFakeModel({
					provider: "github-copilot",
					id: "gpt-5.5",
					name: "GPT-5.5",
				}),
				createFakeModel({
					provider: "anthropic",
					id: "claude-opus-4.7",
					name: "Claude Opus 4.7",
				}),
			],
		});
		const deps = new FakeRuntimeDeps();
		const endedTurns: string[] = [];

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-force-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: {},
			callbacks: {
				onAgentTurnEnd: (agent, text) => endedTurns.push(`${agent.id}:${text}`),
			},
		});
		await room.ready();

		const openaiIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "github-copilot");
		const anthropicIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "anthropic");
		assert.ok(openaiIdx >= 0 && anthropicIdx >= 0, "both labs should have session-create calls");
		const openaiSession = deps.createdSessions[openaiIdx];
		const anthropicSession = deps.createdSessions[anthropicIdx];
		assert.ok(openaiSession && anthropicSession);

		openaiSession.queuePromptMessage("openai opening");
		openaiSession.queuePromptMessage("openai forced 1");
		openaiSession.queuePromptMessage("openai forced 2");
		anthropicSession.queuePromptMessage("anthropic opening");
		anthropicSession.queuePromptMessage("anthropic forced 1");
		anthropicSession.queuePromptMessage("anthropic forced 2");

		// FakeRuntimeDeps.completeSimple defaults to malformed impulse JSON ("{}"),
		// so every hidden impulse poll passes. The collaboration prompt should
		// still force four dynamic turns after the two opening turns.
		await room.submitHumanPrompt("please iterate together without me");

		assert.deepEqual(endedTurns, [
			"openai:openai opening",
			"anthropic:anthropic opening",
			"openai:openai forced 1",
			"anthropic:anthropic forced 1",
			"openai:openai forced 2",
			"anthropic:anthropic forced 2",
		]);
		assert.equal(openaiSession.promptCalls.length, 3);
		assert.equal(anthropicSession.promptCalls.length, 3);

		const roomEvents = readFileSync(room.transcriptFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; reason?: string });
		const forcedContinuations = roomEvents.filter((event) => event.type === "forced_continuation");
		assert.equal(forcedContinuations.length, 4, "expected one forced continuation per required dynamic turn");
		assert.ok(
			forcedContinuations.every((event) => event.reason === "below_minimum_collaboration_exchanges"),
			"forced continuations should be due to collaboration minimum",
		);

		room.dispose();
	});

	test("interrupting an active turn records partial output and primes recovery context for the next agent", async () => {
		const services = new FakeServices({
			models: [
				createFakeModel({
					provider: "github-copilot",
					id: "gpt-5.5",
					name: "GPT-5.5",
				}),
				createFakeModel({
					provider: "anthropic",
					id: "claude-opus-4.7",
					name: "Claude Opus 4.7",
				}),
			],
		});
		const deps = new FakeRuntimeDeps();
		const interruptions: { interrupted: string; interrupter: string; reason: string }[] = [];

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: {},
			callbacks: {
				onInterrupt: (agent, interrupter, reason) => {
					interruptions.push({
						interrupted: agent.id,
						interrupter: typeof interrupter === "string" ? interrupter : interrupter.id,
						reason,
					});
				},
			},
		});
		await room.ready();

		assert.equal(deps.createdSessions.length, 2);
		const openaiIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "github-copilot");
		const anthropicIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "anthropic");
		const openaiSession = deps.createdSessions[openaiIdx];
		const anthropicSession = deps.createdSessions[anthropicIdx];
		assert.ok(openaiSession && anthropicSession);

		// Openai's opening turn uses a 'run' script: it emits a partial
		// message_update with visible text, then waits for session.aborted to
		// flip true (which happens when the runtime forwards the interrupt to
		// session.abort()). Resolving normally is fine; the runtime detects
		// the interruption via activeTurn.interruptedBy regardless of how
		// session.prompt settled.
		openaiSession.queuePromptScript({
			kind: "run",
			run: async (session) => {
				session.emit({
					type: "message_update",
					message: { role: "assistant", content: "partial output before interruption" },
				});
				// Spin until the test triggers interruption.
				const start = Date.now();
				while (!session.aborted) {
					await new Promise((r) => setTimeout(r, 5));
					if (Date.now() - start > 5_000) throw new Error("timeout waiting for abort");
				}
			},
		});

		// Anthropic should run normally after openai is interrupted.
		anthropicSession.queuePromptMessage("anthropic recovers cleanly");

		const promptDone = room.submitHumanPrompt("please respond briefly");

		// Wait until openai's run script has started.
		const openaiStart = Date.now();
		while (openaiSession.promptCalls.length === 0) {
			await new Promise((r) => setTimeout(r, 5));
			if (Date.now() - openaiStart > 5_000) {
				throw new Error("timeout waiting for openai prompt to start");
			}
		}

		// Fire the interruption while openai's prompt is still in-flight.
		await room.interruptActiveTurn("test-user pressed /interrupt", "user");

		await promptDone;

		assert.equal(openaiSession.aborted, true, "openai session should have been aborted");

		assert.equal(interruptions.length, 1, "onInterrupt should fire once");
		assert.equal(interruptions[0]?.interrupted, "openai");
		assert.equal(interruptions[0]?.interrupter, "user");
		assert.match(interruptions[0]?.reason ?? "", /test-user pressed/);

		// After the interruption, anthropic's prompt should include the
		// recovery context produced by formatInterruptionRecoveryContext.
		assert.ok(
			anthropicSession.promptCalls.length >= 1,
			"anthropic should have been prompted after the interruption",
		);
		const anthropicFirstPrompt = anthropicSession.promptCalls[0]?.prompt ?? "";
		assert.match(
			anthropicFirstPrompt,
			/The previous turn was interrupted\./,
			"next agent's prompt should include the interruption recovery fragment",
		);
		assert.match(
			anthropicFirstPrompt,
			/partial output before interruption/,
			"next agent should see the interrupted agent's partial visible output",
		);

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
