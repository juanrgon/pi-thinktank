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

function rosterFor(services: FakeServices) {
	const counts = new Map<string, number>();
	return services.modelRegistry.getAvailable().map((model, index) => {
		const family = model.id.includes("gpt")
			? "openai"
			: model.id.includes("gemini")
				? "google"
				: model.id.includes("claude")
					? "anthropic"
					: `agent-${index + 1}`;
		const occurrence = (counts.get(family) ?? 0) + 1;
		counts.set(family, occurrence);
		return {
			id: occurrence === 1 ? family : `${family}-${occurrence}`,
			model,
			thinkingLevel: "high" as const,
		};
	});
}

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
			rosterSelections: rosterFor(services),
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
		// Default lab tool policy: no explicit allowlist (all built-in + extension
		// tools available), excluding the interactive desktop-control tools.
		assert.equal(call.tools, undefined);
		assert.deepEqual(
			[...(call.excludeTools ?? [])],
			[
				"screen_capture",
				"mouse_position",
				"mouse_move",
				"mouse_click",
				"mouse_double_click",
				"mouse_right_click",
				"type_text",
				"press_keys",
				"wait",
				"frontmost_app",
			],
		);

		// 3. The fake session created by deps.createLabSession should be
		//    tracked and reachable from the test.
		assert.equal(deps.createdSessions.length, 1);

		// 4. modelRegistry.refresh() was called to populate the available
		//    model list before roster selection.
		assert.ok(services.modelRegistry.refreshCount >= 1, "refresh called");

		room.dispose();
	});

	test("accepts arbitrary Pi models and multiple agents using the exact same model", async () => {
		const sharedModel = createFakeModel({ provider: "ollama", id: "qwen2.5-coder:7b", name: "Qwen Local" });
		const services = new FakeServices({ models: [sharedModel] });
		const deps = new FakeRuntimeDeps();
		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-dynamic-roster-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: [
				{ id: "local-a", model: sharedModel, thinkingLevel: "high" },
				{ id: "local-b", model: sharedModel, thinkingLevel: "high" },
			],
			callbacks: {},
		});
		await room.ready();

		assert.deepEqual(room.agentInfos.map((agent) => agent.id), ["local-a", "local-b"]);
		assert.deepEqual(room.agentInfos.map((agent) => agent.visibleName), ["Qwen Local #1", "Qwen Local #2"]);
		assert.equal(deps.createLabSessionCalls.length, 2);
		assert.ok(deps.createLabSessionCalls.every((call) => call.model.provider === "ollama"));
		assert.notEqual(deps.createLabSessionCalls[0]?.sessionDir, deps.createLabSessionCalls[1]?.sessionDir);

		room.dispose();
	});

	test("agent suppressed after two same-category failures, driven by a peer handoff", async () => {
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
			rosterSelections: rosterFor(services),
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

		// openai fails with the same category every time it is selected.
		// "503" classifies as provider_error in agent-error.ts.
		const providerError = new Error("503 Service Unavailable from provider");
		for (let i = 0; i < 5; i++) {
			openaiSession.queuePromptScript({ kind: "error", error: providerError });
		}

		// anthropic speaks the opening turn and hands the floor back to openai via
		// a CONTROL trailer, forcing openai's second selection (and second failure,
		// which trips suppression). Then anthropic declares the room done.
		anthropicSession.queuePromptMessage('anthropic opening reply\nCONTROL: {"next": "openai", "bid": 90}');
		anthropicSession.queuePromptMessage('anthropic wraps up\nCONTROL: {"done": true}');

		await room.submitHumanPrompt("please review this change");

		// Opening picks openai first (rotation order), it fails (#1). Opening then
		// picks anthropic, which nominates openai. The handoff re-selects openai,
		// it fails (#2) and is suppressed. openai is therefore prompted exactly twice.
		assert.equal(
			openaiSession.promptCalls.length,
			2,
			`openai should have been called exactly twice (opening + handoff) before suppression; recorded: ${openaiSession.promptCalls.length}`,
		);

		assert.ok(
			anthropicSession.promptCalls.length >= 1,
			`anthropic should have spoken at least once; recorded: ${anthropicSession.promptCalls.length}`,
		);

		const openaiErrors = errorEvents.filter((e) => e.id === "openai");
		assert.equal(openaiErrors.length, 2, "expected exactly two openai errors");
		assert.equal(openaiErrors[0]?.category, "provider_error");
		assert.equal(openaiErrors[1]?.category, "provider_error");

		room.dispose();
	});

	test("control trailers drive dynamic continuation and stop on consensus, with zero scheduling model calls", async () => {
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
		let idleReason: string | undefined;

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-trailers-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: rosterFor(services),
			callbacks: {
				onAgentTurnEnd: (agent, text) => endedTurns.push(`${agent.id}:${text}`),
				onRoomIdle: (summary) => {
					idleReason = summary.reason;
				},
			},
		});
		await room.ready();

		const openaiIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "github-copilot");
		const anthropicIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "anthropic");
		const openaiSession = deps.createdSessions[openaiIdx];
		const anthropicSession = deps.createdSessions[anthropicIdx];
		assert.ok(openaiSession && anthropicSession);

		// Opening lap: both stay engaged with a bid. Then they alternate by bid
		// until both declare done. The CONTROL lines must be stripped from the
		// visible transcript text the callbacks receive.
		openaiSession.queuePromptMessage('openai opening\nCONTROL: {"bid": 80}');
		openaiSession.queuePromptMessage('openai second\nCONTROL: {"done": true}');
		anthropicSession.queuePromptMessage('anthropic opening\nCONTROL: {"bid": 80}');
		anthropicSession.queuePromptMessage('anthropic second\nCONTROL: {"done": true}');

		await room.submitHumanPrompt("please discuss this design");

		assert.deepEqual(endedTurns, [
			"openai:openai opening",
			"anthropic:anthropic opening",
			"openai:openai second",
			"anthropic:anthropic second",
		]);
		assert.equal(openaiSession.promptCalls.length, 2);
		assert.equal(anthropicSession.promptCalls.length, 2);

		// The core ADR-0002 guarantee: scheduling spends zero model calls.
		assert.equal(
			deps.completionCalls.length,
			0,
			`scheduling must not call completeSimple; recorded ${deps.completionCalls.length}`,
		);

		const roomEvents = readFileSync(room.transcriptFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; decision?: { action?: string; reason?: string } });
		const selections = roomEvents.filter((event) => event.type === "turn_selection");
		const speakReasons = selections
			.filter((event) => event.decision?.action === "speak")
			.map((event) => event.decision?.reason);
		assert.deepEqual(speakReasons, ["opening", "opening", "bid", "bid"]);
		assert.ok(
			selections.some((event) => event.decision?.action === "stop" && event.decision?.reason === "all_done"),
			"the room should stop via the all_done consensus",
		);
		// The idle summary must report consensus, and a room_idle event must be logged.
		assert.equal(idleReason, "consensus");
		const idleEvents = roomEvents.filter((event) => (event as { type?: string }).type === "room_idle");
		assert.equal(idleEvents.length, 1);
		assert.equal((idleEvents[0] as { reason?: string }).reason, "consensus");

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
			rosterSelections: rosterFor(services),
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

	test("post-compaction assistant-continuation failure retries the same prompt once", async () => {
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
		const endedTurns: string[] = [];
		const turnErrors: string[] = [];

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-compaction-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: rosterFor(services),
			callbacks: {
				onAgentTurnEnd: (agent, text) => endedTurns.push(`${agent.id}:${text}`),
				onAgentTurnError: (agent, _phase, error) => turnErrors.push(`${agent.id}:${error.category}`),
			},
		});
		await room.ready();

		const session = deps.createdSessions[0];
		assert.ok(session, "runtime should have created exactly one fake session");
		session.queuePromptScript({
			kind: "error",
			error: new Error("Cannot continue from message role: assistant"),
			events: [{ type: "compaction_end", reason: "overflow", willRetry: true }],
		});
		session.queuePromptMessage("retry succeeded after compaction");

		await room.submitHumanPrompt("simple prompt that should recover from compaction retry");

		assert.equal(session.promptCalls.length, 2, "runtime should retry the visible prompt exactly once");
		assert.equal(
			session.promptCalls[0]?.prompt,
			session.promptCalls[1]?.prompt,
			"retry should re-use the same visible prompt text",
		);
		assert.deepEqual(endedTurns, ["openai:retry succeeded after compaction"]);
		assert.deepEqual(turnErrors, [], "recovered compaction retry should not surface as an agent turn error");

		const roomEvents = readFileSync(room.transcriptFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; reason?: string; attempt?: number });
		const retryEvents = roomEvents.filter((event) => event.type === "compaction_prompt_retry");
		assert.equal(retryEvents.length, 1, "expected exactly one compaction prompt retry event");
		assert.equal(retryEvents[0]?.reason, "assistant_terminal_continuation");
		assert.equal(retryEvents[0]?.attempt, 1);

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
			rosterSelections: rosterFor(services),
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

		// A single agent emits no CONTROL trailer, so its standing trailer is
		// absent (treated as yielding). After the one opening turn the scheduler
		// has no eager candidate left and stops, giving exactly one prompt call.
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
			rosterSelections: rosterFor(services),
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
			rosterSelections: rosterFor(services).map((entry) =>
				entry.id === "anthropic" ? { ...entry, disabled: true } : entry,
			),
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

	test("labTools controls the lab session tool policy passed to createLabSession", async () => {
		const capture = async (labTools?: readonly string[] | "all") => {
			const services = new FakeServices({
				models: [createFakeModel({ provider: "github-copilot", id: "gpt-5.5" })],
			});
			const deps = new FakeRuntimeDeps();
			const room = new ThinktankRoomRuntime({
				services,
				deps,
				cwd: `/tmp/thinktank-labtools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				rosterSelections: rosterFor(services),
				labTools,
				callbacks: {},
			});
			await room.ready();
			const call = deps.createLabSessionCalls[0];
			room.dispose();
			assert.ok(call);
			return call;
		};

		// Explicit allowlist passes straight through as `tools`.
		const explicit = await capture(["read", "web_search"]);
		assert.deepEqual([...(explicit.tools ?? [])], ["read", "web_search"]);
		assert.equal(explicit.excludeTools, undefined);

		// "all" means no allowlist and no exclusions (full parity, incl. desktop).
		const all = await capture("all");
		assert.equal(all.tools, undefined);
		assert.deepEqual([...(all.excludeTools ?? [])], []);
	});

	test("lab memory is ephemeral by default and resumes only when persistent", async () => {
		const capture = async (labMemory?: "ephemeral" | "persistent") => {
			const services = new FakeServices({
				models: [createFakeModel({ provider: "github-copilot", id: "gpt-5.5" })],
			});
			const deps = new FakeRuntimeDeps();
			const room = new ThinktankRoomRuntime({
				services,
				deps,
				cwd: `/tmp/thinktank-labmem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				rosterSelections: rosterFor(services),
				labMemory,
				callbacks: {},
			});
			await room.ready();
			const call = deps.createLabSessionCalls[0];
			room.dispose();
			assert.ok(call);
			return call;
		};

		// Default: do NOT auto-resume a prior session.
		assert.notEqual((await capture()).resumeRecentSession, true);
		// Explicit persistent opt-in resumes.
		assert.equal((await capture("persistent")).resumeRecentSession, true);
		// Explicit ephemeral does not.
		assert.notEqual((await capture("ephemeral")).resumeRecentSession, true);
	});

	test("a non-throwing provider error (stopReason=error) is surfaced, not silently swallowed", async () => {
		// Reproduces the real claude-opus-4.7 case found in manual testing: the
		// provider returns an assistant message with stopReason "error" and empty
		// content WITHOUT throwing from prompt(). The runtime must still surface it.
		const services = new FakeServices({
			models: [createFakeModel({ provider: "github-copilot", id: "gpt-5.5", name: "GPT-5.5" })],
		});
		const deps = new FakeRuntimeDeps();
		const turnErrors: string[] = [];

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-nonthrow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: rosterFor(services),
			callbacks: {
				onAgentTurnError: (agent, _phase, error) => turnErrors.push(`${agent.id}:${error.category}`),
			},
		});
		await room.ready();

		const session = deps.createdSessions[0];
		assert.ok(session);
		session.queuePromptScript({
			kind: "message",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage:
					'400 {"error":{"message":"output_config.effort \\"low\\" is not supported by model claude-opus-4.7","code":"invalid_reasoning_effort"}}',
			} as never,
		});

		await room.submitHumanPrompt("answer briefly");

		// The failed turn must surface exactly once and classify correctly, and the
		// runtime must not loop re-selecting the failing agent.
		assert.deepEqual(turnErrors, ["openai:unsupported_thinking_level"]);
		assert.equal(session.promptCalls.length, 1, "a surfaced error must not loop into re-selection");

		room.dispose();
	});

	test("leader-led mode consults a read-only advisor, returns to leader, and exposes only leader final", async () => {
		const leaderModel = createFakeModel({ provider: "github-copilot", id: "gpt-5.5", name: "Kepler" });
		const advisorModel = createFakeModel({ provider: "anthropic", id: "claude-opus", name: "Claude Opus" });
		const services = new FakeServices({ models: [leaderModel, advisorModel] });
		const deps = new FakeRuntimeDeps();
		const turns: Array<{ id: string; text: string; presentation?: string }> = [];
		let idleReason: string | undefined;
		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-leader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			roomMode: "leader-led",
			rosterSelections: [
				{ id: "leader", role: "leader", model: leaderModel, thinkingLevel: "high" },
				{ id: "advisor", role: "advisor", model: advisorModel, thinkingLevel: "high" },
			],
			callbacks: {
				onAgentTurnEnd: (agent, text, presentation) => turns.push({ id: agent.id, text, presentation }),
				onRoomIdle: (summary) => { idleReason = summary.reason; },
			},
		});
		await room.ready();

		const leaderIndex = deps.createLabSessionCalls.findIndex((call) => call.model.id === "gpt-5.5");
		const advisorIndex = deps.createLabSessionCalls.findIndex((call) => call.model.id === "claude-opus");
		const leaderSession = deps.createdSessions[leaderIndex];
		const advisorSession = deps.createdSessions[advisorIndex];
		assert.ok(leaderSession && advisorSession);
		assert.equal(deps.createLabSessionCalls[leaderIndex]?.tools, undefined, "leader keeps configured room tools");
		assert.deepEqual([...(deps.createLabSessionCalls[advisorIndex]?.tools ?? [])], ["read", "grep", "find", "ls"]);

		leaderSession.queuePromptMessage('Check the parser edge cases.\nCONTROL: {"action":"consult","next":"advisor"}');
		advisorSession.queuePromptMessage('The parser mishandles malformed JSON.\nCONTROL: {"action":"final"}');
		leaderSession.queuePromptMessage('Implemented and verified the parser fix.\nCONTROL: {"action":"final"}');

		await room.submitHumanPrompt("fix the parser");

		assert.equal(leaderSession.promptCalls.length, 2);
		assert.equal(advisorSession.promptCalls.length, 1);
		assert.match(advisorSession.promptCalls[0]?.prompt ?? "", /Check the parser edge cases/);
		assert.match(leaderSession.promptCalls[1]?.prompt ?? "", /parser mishandles malformed JSON/);
		assert.deepEqual(turns.map((turn) => `${turn.id}:${turn.presentation}`), [
			"leader:collapsed",
			"advisor:collapsed",
			"leader:final",
		]);
		assert.equal(idleReason, "leader_final");
		room.dispose();
	});

	test("leader-led mode halts without a leader and enforces its hidden-turn budget", async () => {
		const model = createFakeModel();
		const noLeaderServices = new FakeServices({ models: [model] });
		const noLeaderDeps = new FakeRuntimeDeps();
		let noLeaderReason: string | undefined;
		const noLeaderRoom = new ThinktankRoomRuntime({
			services: noLeaderServices,
			deps: noLeaderDeps,
			cwd: `/tmp/thinktank-no-leader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			roomMode: "leader-led",
			rosterSelections: [{ id: "advisor", role: "advisor", model, thinkingLevel: "high" }],
			callbacks: { onRoomIdle: (summary) => { noLeaderReason = summary.reason; } },
		});
		await noLeaderRoom.ready();
		await noLeaderRoom.submitHumanPrompt("hello");
		assert.equal(noLeaderReason, "leader_unavailable");
		assert.equal(noLeaderDeps.createdSessions[0]?.promptCalls.length, 0);
		noLeaderRoom.dispose();

		const budgetServices = new FakeServices({ models: [model] });
		const budgetDeps = new FakeRuntimeDeps();
		let budgetReason: string | undefined;
		const budgetRoom = new ThinktankRoomRuntime({
			services: budgetServices,
			deps: budgetDeps,
			cwd: `/tmp/thinktank-budget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			roomMode: "leader-led",
			leaderLedMaxTurns: 2,
			rosterSelections: [{ id: "leader", role: "leader", model, thinkingLevel: "high" }],
			callbacks: { onRoomIdle: (summary) => { budgetReason = summary.reason; } },
		});
		await budgetRoom.ready();
		const session = budgetDeps.createdSessions[0]!;
		session.queuePromptMessage('still working\nCONTROL: {"action":"continue"}');
		session.queuePromptMessage('still working again\nCONTROL: {"action":"continue"}');
		await budgetRoom.submitHumanPrompt("work forever");
		assert.equal(session.promptCalls.length, 2);
		assert.equal(budgetReason, "turn_limit");
		budgetRoom.dispose();
	});

	test("a handoff to a non-responding agent does not loop the room", async () => {
		// Reproduces the manual-test loop: agent A nominates B via CONTROL next, but
		// B produces no visible contribution. The room must not hand the floor to B
		// indefinitely (the old transcript-derived last-speaker did exactly that).
		const services = new FakeServices({
			models: [
				createFakeModel({ provider: "github-copilot", id: "gpt-5.5", name: "GPT-5.5" }),
				createFakeModel({ provider: "anthropic", id: "claude-opus-4.7", name: "Claude Opus 4.7" }),
			],
		});
		const deps = new FakeRuntimeDeps();

		const room = new ThinktankRoomRuntime({
			services,
			deps,
			cwd: `/tmp/thinktank-f4-noloop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rosterSelections: rosterFor(services),
			maxRounds: 3,
			callbacks: {},
		});
		await room.ready();

		const openaiIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "github-copilot");
		const anthropicIdx = deps.createLabSessionCalls.findIndex((c) => c.model.provider === "anthropic");
		const openaiSession = deps.createdSessions[openaiIdx];
		const anthropicSession = deps.createdSessions[anthropicIdx];
		assert.ok(openaiSession && anthropicSession);

		// openai nominates anthropic and bids to stay engaged.
		openaiSession.queuePromptMessage('openai opening\nCONTROL: {"next": "anthropic", "bid": 80}');
		// anthropic only ever emits an (empty-prose) control line with a high bid:
		// no visible contribution. It must be treated as a yield, not re-selected.
		for (let i = 0; i < 8; i++) {
			anthropicSession.queuePromptMessage('CONTROL: {"bid": 99}');
		}

		await room.submitHumanPrompt("discuss briefly");

		assert.equal(
			anthropicSession.promptCalls.length,
			1,
			`anthropic should be selected once (its opening) and then treated as yielding, not looped; recorded: ${anthropicSession.promptCalls.length}`,
		);

		room.dispose();
	});
});
