// Production adapter that supplies the runtime's injected dependencies
// (`ThinktankRuntimeDeps`) by forwarding to the real @earendil-works/pi-*
// implementations.
//
// This is the ONLY file in the runtime path that imports Pi values. The
// runtime itself (room-runtime.ts) uses type-only imports against Pi,
// which means tests can import room-runtime.ts without resolving any Pi
// peer dependency.
//
// Tests substitute their own ThinktankRuntimeDeps and never import this file.
//
// F2.5 of the F-series (Option Y: deep dependency injection).

import { clampThinkingLevel, completeSimple } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent";

import type {
	ThinkingLevelLike,
	ThinktankAssistantMessageLike,
	ThinktankCompletionAuthLike,
	ThinktankCompletionPromptLike,
	ThinktankCreateLabSessionOptions,
	ThinktankModelLike,
	ThinktankRuntimeDeps,
	ThinktankSessionLike,
} from "./runtime-deps.ts";

/**
 * Pass-through adapter. The `as any` casts at the boundaries are
 * intentional: Pi's real types are strict supersets/subsets of the narrow
 * types in runtime-deps.ts. The casts let us keep strict typing inside the
 * runtime without polluting runtime-deps.ts with Pi-specific imports.
 */
export const defaultRuntimeDeps: ThinktankRuntimeDeps = {
	clampThinkingLevel(model: ThinktankModelLike, level: ThinkingLevelLike): ThinkingLevelLike {
		// biome-ignore lint/suspicious/noExplicitAny: adapter boundary cast
		return clampThinkingLevel(model as any, level as any) as ThinkingLevelLike;
	},

	async completeSimple(
		model: ThinktankModelLike,
		prompt: ThinktankCompletionPromptLike,
		auth: ThinktankCompletionAuthLike,
	): Promise<ThinktankAssistantMessageLike> {
		// biome-ignore lint/suspicious/noExplicitAny: adapter boundary cast
		const result = await completeSimple(model as any, prompt as any, auth as any);
		return result as ThinktankAssistantMessageLike;
	},

	async createLabSession(
		options: ThinktankCreateLabSessionOptions,
	): Promise<{ readonly session: ThinktankSessionLike }> {
		const sessionManager = options.resumeRecentSession
			? SessionManager.continueRecent(options.cwd, options.sessionDir)
			: SessionManager.create(options.cwd, options.sessionDir);
		const created = await createAgentSessionFromServices({
			// biome-ignore lint/suspicious/noExplicitAny: adapter boundary cast
			services: options.services as any,
			sessionManager,
			// biome-ignore lint/suspicious/noExplicitAny: adapter boundary cast
			model: options.model as any,
			// biome-ignore lint/suspicious/noExplicitAny: adapter boundary cast
			thinkingLevel: options.thinkingLevel as any,
			// When an explicit allowlist is given, restrict to it (the SDK activates
			// exactly those). Otherwise omit the allowlist so all built-in +
			// extension/MCP tools are registered, then activate the full set
			// (minus excludeTools) below.
			...(options.tools ? { tools: [...options.tools] } : {}),
		});
		const session = created.session;
		if (!options.tools) {
			const exclude = new Set(options.excludeTools ?? []);
			const activeNames = session
				.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => !exclude.has(name));
			session.setActiveToolsByName(activeNames);
		}
		return { session: session as ThinktankSessionLike };
	},
};
