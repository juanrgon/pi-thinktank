// Unit tests for the pure speaker-routing scheduler (scheduler.ts).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ABSENT_TRAILER, type SpeakerTrailer } from "../control-trailer.ts";
import { pickNextSpeaker, type SchedulerInput } from "../scheduler.ts";

function trailer(overrides: Partial<SpeakerTrailer> = {}): SpeakerTrailer {
	return { present: true, done: false, yield: false, next: null, bid: 50, ...overrides };
}

function input(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
	return {
		activeAgentIds: ["openai", "google", "anthropic"],
		spokenAgentIds: [],
		trailers: {},
		...overrides,
	};
}

describe("pickNextSpeaker — stop conditions", () => {
	test("stops when there are no active agents", () => {
		assert.deepEqual(pickNextSpeaker(input({ activeAgentIds: [] })), {
			action: "stop",
			reason: "no_active_agents",
		});
	});

	test("stops with all_done when every active agent is done", () => {
		const d = pickNextSpeaker(
			input({
				activeAgentIds: ["openai", "anthropic"],
				spokenAgentIds: ["openai", "anthropic"],
				lastSpeakerId: "anthropic",
				trailers: { openai: trailer({ done: true }), anthropic: trailer({ done: true }) },
			}),
		);
		assert.deepEqual(d, { action: "stop", reason: "all_done" });
	});

	test("stops with converged when no eager candidate remains", () => {
		const d = pickNextSpeaker(
			input({
				activeAgentIds: ["openai", "anthropic"],
				spokenAgentIds: ["openai", "anthropic"],
				lastSpeakerId: "anthropic",
				// openai (the only candidate) is yielding; anthropic is excluded as last speaker.
				trailers: { openai: trailer({ yield: true }), anthropic: trailer({ bid: 90 }) },
			}),
		);
		assert.deepEqual(d, { action: "stop", reason: "converged" });
	});

	test("a lone agent with an absent trailer stops after speaking", () => {
		const d = pickNextSpeaker(
			input({
				activeAgentIds: ["openai"],
				spokenAgentIds: ["openai"],
				lastSpeakerId: "openai",
				trailers: { openai: { ...ABSENT_TRAILER } },
			}),
		);
		assert.deepEqual(d, { action: "stop", reason: "converged" });
	});
});

describe("pickNextSpeaker — opening lap", () => {
	test("picks the first unspoken agent in rotation order", () => {
		const d = pickNextSpeaker(input({ spokenAgentIds: [] }));
		assert.deepEqual(d, { action: "speak", agentId: "openai", reason: "opening" });
	});

	test("after the first opening turn, picks the next unspoken (not the last speaker)", () => {
		const d = pickNextSpeaker(
			input({ spokenAgentIds: ["openai"], lastSpeakerId: "openai", trailers: { openai: trailer() } }),
		);
		assert.deepEqual(d, { action: "speak", agentId: "google", reason: "opening" });
	});

	test("prefers an agent mentioned in the human prompt during opening", () => {
		const d = pickNextSpeaker(input({ spokenAgentIds: [], mentionedAgentIds: ["anthropic"] }));
		assert.deepEqual(d, { action: "speak", agentId: "anthropic", reason: "opening" });
	});

	test("opening priority beats consensus: an unspoken agent speaks even if others are done", () => {
		const d = pickNextSpeaker(
			input({
				spokenAgentIds: ["openai", "google"],
				lastSpeakerId: "google",
				trailers: { openai: trailer({ done: true }), google: trailer({ done: true }) },
			}),
		);
		assert.deepEqual(d, { action: "speak", agentId: "anthropic", reason: "opening" });
	});
});

describe("pickNextSpeaker — handoff and bidding", () => {
	const allSpoken = ["openai", "google", "anthropic"];

	test("directed handoff: the last speaker's next nomination wins", () => {
		const d = pickNextSpeaker(
			input({
				spokenAgentIds: allSpoken,
				lastSpeakerId: "openai",
				trailers: {
					openai: trailer({ next: "anthropic" }),
					google: trailer({ bid: 99 }),
					anthropic: trailer({ bid: 1 }),
				},
			}),
		);
		assert.deepEqual(d, { action: "speak", agentId: "anthropic", reason: "handoff" });
	});

	test("nomination overrides a yielding nominee", () => {
		const d = pickNextSpeaker(
			input({
				spokenAgentIds: allSpoken,
				lastSpeakerId: "openai",
				trailers: {
					openai: trailer({ next: "anthropic" }),
					google: trailer({ bid: 80 }),
					anthropic: trailer({ yield: true }),
				},
			}),
		);
		assert.deepEqual(d, { action: "speak", agentId: "anthropic", reason: "handoff" });
	});

	test("nomination of the last speaker is ignored (no self-loop), falls through to bid", () => {
		const d = pickNextSpeaker(
			input({
				spokenAgentIds: allSpoken,
				lastSpeakerId: "openai",
				trailers: {
					openai: trailer({ next: "openai" }),
					google: trailer({ bid: 70 }),
					anthropic: trailer({ bid: 90 }),
				},
			}),
		);
		assert.deepEqual(d, { action: "speak", agentId: "anthropic", reason: "bid" });
	});

	test("highest bid wins among eager candidates", () => {
		const d = pickNextSpeaker(
			input({
				spokenAgentIds: allSpoken,
				lastSpeakerId: "openai",
				trailers: {
					openai: trailer({ bid: 100 }),
					google: trailer({ bid: 30 }),
					anthropic: trailer({ bid: 75 }),
				},
			}),
		);
		// openai is excluded as last speaker; anthropic outbids google.
		assert.deepEqual(d, { action: "speak", agentId: "anthropic", reason: "bid" });
	});

	test("bid ties resolve to rotation order after the last speaker", () => {
		const d = pickNextSpeaker(
			input({
				spokenAgentIds: allSpoken,
				lastSpeakerId: "openai",
				trailers: {
					openai: trailer({ bid: 10 }),
					google: trailer({ bid: 60 }),
					anthropic: trailer({ bid: 60 }),
				},
			}),
		);
		// google comes right after openai in rotation, so it wins the tie.
		assert.deepEqual(d, { action: "speak", agentId: "google", reason: "bid" });
	});

	test("yielding candidates are skipped in favor of an eager one", () => {
		const d = pickNextSpeaker(
			input({
				spokenAgentIds: allSpoken,
				lastSpeakerId: "openai",
				trailers: {
					openai: trailer({ bid: 100 }),
					google: trailer({ yield: true }),
					anthropic: trailer({ bid: 20 }),
				},
			}),
		);
		assert.deepEqual(d, { action: "speak", agentId: "anthropic", reason: "bid" });
	});
});

describe("pickNextSpeaker — two-agent no-stall guarantee", () => {
	test("two engaged agents alternate without stalling", () => {
		const trailers = { openai: trailer({ bid: 50 }), anthropic: trailer({ bid: 50 }) };
		const afterOpenai = pickNextSpeaker(
			input({
				activeAgentIds: ["openai", "anthropic"],
				spokenAgentIds: ["openai", "anthropic"],
				lastSpeakerId: "openai",
				trailers,
			}),
		);
		assert.deepEqual(afterOpenai, { action: "speak", agentId: "anthropic", reason: "bid" });

		const afterAnthropic = pickNextSpeaker(
			input({
				activeAgentIds: ["openai", "anthropic"],
				spokenAgentIds: ["openai", "anthropic"],
				lastSpeakerId: "anthropic",
				trailers,
			}),
		);
		assert.deepEqual(afterAnthropic, { action: "speak", agentId: "openai", reason: "bid" });
	});
});
