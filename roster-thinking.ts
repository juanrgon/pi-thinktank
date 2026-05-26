// Pi-dependent thinking-level helpers extracted from roster.ts so that
// roster.ts stays free of `@earendil-works/pi-ai` value imports.
//
// This file is only loaded by:
//   - roster-selector.ts (the /roster TUI)
//   - lib.ts (public re-exports)
//   - runtime-default-deps.ts (indirectly, via the runtime that injects
//     clampThinkingLevel through ThinktankRuntimeDeps)
//
// room-runtime.ts does NOT import this file directly. Instead, it receives
// `clampThinkingLevel` via ThinktankRuntimeDeps, which lets tests import
// the runtime without resolving Pi peer dependencies.

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { DEFAULT_THINKTANK_THINKING_LEVEL } from "./roster.ts";

export function getThinktankSupportedThinkingLevels(model: Model<Api>): ThinkingLevel[] {
	return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

export function clampThinktankThinkingLevel(
	model: Model<Api>,
	thinkingLevel: ThinkingLevel | undefined,
): ThinkingLevel {
	return clampThinkingLevel(model, thinkingLevel ?? DEFAULT_THINKTANK_THINKING_LEVEL) as ThinkingLevel;
}
