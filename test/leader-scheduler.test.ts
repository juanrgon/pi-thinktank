import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { pickNextLeaderSpeaker } from "../leader-scheduler.ts";

const active = ["leader", "advisor-a", "advisor-b"];

describe("leader-led scheduler", () => {
	test("leader always opens", () => {
		assert.deepEqual(pickNextLeaderSpeaker({ leaderId: "leader", activeAgentIds: active, turnsUsed: 0, maxTurns: 12 }), {
			action: "speak", agentId: "leader", reason: "leader",
		});
	});

	test("leader may consult an advisor and advisor always returns to leader", () => {
		const control = { present: true, action: "consult" as const, next: "advisor-b" };
		assert.deepEqual(pickNextLeaderSpeaker({ leaderId: "leader", activeAgentIds: active, lastSpeakerId: "leader", lastLeaderControl: control, turnsUsed: 1, maxTurns: 12 }), {
			action: "speak", agentId: "advisor-b", reason: "consult",
		});
		assert.deepEqual(pickNextLeaderSpeaker({ leaderId: "leader", activeAgentIds: active, lastSpeakerId: "advisor-b", lastLeaderControl: control, turnsUsed: 2, maxTurns: 12 }), {
			action: "speak", agentId: "leader", reason: "return_to_leader",
		});
	});

	test("only leader final stops normally", () => {
		assert.deepEqual(pickNextLeaderSpeaker({ leaderId: "leader", activeAgentIds: active, lastSpeakerId: "leader", lastLeaderControl: { present: true, action: "final", next: null }, turnsUsed: 1, maxTurns: 12 }), {
			action: "stop", reason: "final",
		});
	});

	test("turn budget and missing leader halt", () => {
		assert.deepEqual(pickNextLeaderSpeaker({ leaderId: "leader", activeAgentIds: active, turnsUsed: 12, maxTurns: 12 }), { action: "stop", reason: "turn_limit" });
		assert.deepEqual(pickNextLeaderSpeaker({ leaderId: "leader", activeAgentIds: ["advisor-a"], turnsUsed: 0, maxTurns: 12 }), { action: "stop", reason: "leader_unavailable" });
	});
});
