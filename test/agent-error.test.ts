import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { classifyAgentError } from "../agent-error.ts";

describe("classifyAgentError", () => {
	test("classifies Copilot Claude thinking parameter failure", () => {
		const error = new Error(
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.enabled\\" is not supported for this model. Use \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."}}',
		);
		const classified = classifyAgentError(error);
		assert.equal(classified.category, "unsupported_thinking_level");
		assert.match(classified.summary, /thinking\.type\.enabled/i);
		assert.match(classified.hint ?? "", /roster/i);
	});

	test("classifies unsupported thinking errors through cause chain", () => {
		const cause = new Error("output_config.effort is required for this model");
		const error = new Error("provider failed", { cause });
		const classified = classifyAgentError(error);
		assert.equal(classified.category, "unsupported_thinking_level");
		assert.match(classified.raw, /cause=/);
	});

	test("classifies auth failures", () => {
		const classified = classifyAgentError("401 unauthorized: invalid API key");
		assert.equal(classified.category, "auth");
		assert.match(classified.hint ?? "", /login|credentials/i);
	});

	test("classifies errors with status property as auth when status is 403", () => {
		const error = Object.assign(new Error("request failed"), { status: 403 });
		const classified = classifyAgentError(error);
		assert.equal(classified.category, "auth");
		assert.match(classified.raw, /status=403/);
	});

	test("contextOverflow option has priority", () => {
		const classified = classifyAgentError("500 provider outage", { contextOverflow: true });
		assert.equal(classified.category, "context_overflow");
	});

	test("classifies context limit strings", () => {
		const classified = classifyAgentError("maximum context window exceeded");
		assert.equal(classified.category, "context_overflow");
	});

	test("classifies provider errors", () => {
		const classified = classifyAgentError("500 provider unavailable");
		assert.equal(classified.category, "provider_error");
		assert.match(classified.hint ?? "", /provider/i);
	});

	test("classifies errors with status property as provider errors", () => {
		const error = Object.assign(new Error("request failed"), { status: 500 });
		const classified = classifyAgentError(error);
		assert.equal(classified.category, "provider_error");
		assert.match(classified.raw, /status=500/);
	});

	test("classifies arbitrary thrown values as unknown", () => {
		const classified = classifyAgentError(42);
		assert.equal(classified.category, "unknown");
		assert.equal(classified.summary, "42");
	});

	test("truncates long summaries and raw text", () => {
		const classified = classifyAgentError(`unknown ${"x".repeat(5000)}`);
		assert.equal(classified.category, "unknown");
		assert.ok(classified.summary.length <= 240);
		assert.ok(classified.raw.length <= 4000);
		assert.match(classified.summary, /\.\.\.$/);
		assert.match(classified.raw, /\.\.\.$/);
	});
});
