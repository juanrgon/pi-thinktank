# Thinktank Extension Improvement Plan

**Status:** v1.2 — Implementation plan converged; ready to execute
**Date:** 2026-05-26
**Authors:** GPT-5.5 (`github-copilot/gpt-5.5:xhigh`), Anthropic Claude Opus 4.7 1M Internal (`github-copilot/claude-opus-4.7-1m-internal:xhigh`)
**Method:** In-room Socratic debate without human participant, per user instruction

---

## 1. Problem statement

The `pi-thinktank` extension turns a Pi session into a shared room of multiple LLM Lab Agents who can converse, use tools, and produce work together. Today the room *looks* collaborative, but several guarantees that make a room trustworthy are only implicit:

1. **Presence is unreliable.** Agents can fail (API/config errors) and disappear from the public transcript without explanation, breaking the illusion of a shared room. Concretely: during the planning sessions that produced this very document, the Anthropic agent failed silently four times in a row due to a `thinking.type.enabled` parameter mismatch on `github-copilot/claude-opus-4.7-1m-internal`. The user had to ask *"anthropic, why didn't you respond?"* — the room itself never said.

2. **Debate is emergent.** Multi-agent deliberation, write convergence, and artifact iteration depend on prompt obedience and self-organization. There is no first-class workflow or runtime support, only conventions in the system prompt.

3. **Write safety is prompt-based.** Agents are instructed to announce edits and wait for room convergence, but `edit` / `write` / `bash` tools are unconditionally available. Safety relies on obedience rather than runtime policy.

4. **Interruption is partially wired.** `pollForInterruptions` and `interruptActiveTurn` exist, but the main turn loop calls `promptAgentWithOverflowRecovery` directly and never feeds active-turn state (`partialText`, `toolCallsCompleted`) from streaming or tool events. `/interrupt` and model-to-model interruption are weaker than intended.

5. **Caps and persistence are hidden constants.** `MAX_ROOM_TURNS` and `MAX_OPEN_QUESTION_RESPONSE_TURNS` are bare constants (recently raised from 10/2 to 1000/1000). `SessionManager.continueRecent` makes private lab sessions leak across runs with no UX surface. Neither is configurable, neither is user-documented.

6. **There is no test harness.** Zero `test(...)` / `describe(...)` calls in any of the 5 source files (`index.ts`, `room-runtime.ts`, `roster.ts`, `roster-selector.ts`, `lib.ts`). A 1,082-line `room-runtime.ts` with regex-based detection (`turnNeedsRoomResponse`), JSON parsing of LLM output (`parseTurnImpulse`), and a manual interrupt state machine — all behaviorally critical, none covered.

## 2. Goal

Make Thinktank a **reliable deliberative coding room**:

- Every enabled agent is visibly present and accountable.
- Debate, convergence, and artifact creation are reliable workflows, not lucky prompts.
- Writes happen under explicit, auditable governance.
- Internal state (memory, caps, persistence) is legible to the user.

The ordering is intentional: **trust → governed autonomy → maintainability**. Autonomy without trust is dangerous; maintainability without visible improvement won't solve the user's current frustration.

## 3. Socratic debate summary

### Q1 (GPT-5.5)
> Which single failure mode should dominate the plan: runaway/cost control, unenforced write safety, dead interruption wiring, or lack of artifact-oriented collaboration?

- GPT-5.5 initial answer: interruption wiring first, then policy, then artifact mode.
- Anthropic challenge: *the user just asked "why didn't you respond" — that is the failure mode they actually hit. Trust > autonomy.*
- **Convergence:** trust first. Phase 1 is visible agent failure handling.

### Q2 (Anthropic)
> How do you plan to validate Phase 1 error-surfacing changes if there's no test harness? You'd be adding error handling to a 1,082-line file with zero tests — your error-handling code itself could silently fail, recreating the exact class of problem you're trying to fix.

- **Convergence:** add a *minimal* validation seam as Phase 0 — just enough to test the new pure helpers, not a full refactor. Phase 1 then builds with tests from the start, not retroactively.

### Q3 (Anthropic)
> Isn't the artifact workflow — debate, save, iterate — already emergent from prompts and the `write` tool? Is the real blocker missing runtime support, or silent agent failure that prevented the emergent behavior from ever completing?

- GPT-5.5 partial counter: yes the emergent path works, but only if the user phrases it perfectly each time. Repeatable workflows deserve runtime support.
- **Convergence:** Phase 2 downgrades to "prove the pattern with existing primitives first." Promotion to a first-class `/thinktank plan` mode is gated on demonstrated value (concrete trigger in Phase 2).

### Q4 (GPT-5.5)
> Trust, autonomy, or maintainability — what are we optimizing for?

- **Convergence:** trust first, with *just enough* maintainability (Phase 0) to prevent trust from regressing. Autonomy is downstream of trust.

## 4. Ranked plan

### Phase 0 — Minimal validation seam

**Goal:** make Phase 1 testable from day one.

**Tasks:**

- Add `scripts` block in `package.json`: `typecheck`, `test`. **Decision (v1.1):** use `node:test` from the Node.js standard library. Rationale: the extension has no `devDependencies` today and the Phase 0 test surface is small (3 pure helpers, ~30 cases total) — vitest's watch-mode advantage doesn't pay for itself at this scale, and avoiding a new dep keeps install footprint minimal.
- Extract or expose pure helpers (already pure, just need to be importable from a test file):
  - `turnNeedsRoomResponse(text)` — currently `room-runtime.ts:263–286`
  - `parseTurnImpulse(text)` — currently `room-runtime.ts:226–262`
  - `isContextOverflowException(error, model)` — currently `room-runtime.ts:182–203`
- Write focused tests (5–10 cases each), including the failure modes we already know about:
  - `turnNeedsRoomResponse`: paraphrase weakness, multi-language, false positives on the literal phrase "Intended action: I will" that the codebase itself trains agents to use.
  - `parseTurnImpulse`: malformed JSON, missing fields, urgency clamping, unknown `kind`.

**Non-goals:**

- Do **not** refactor `room-runtime.ts` structurally. Carve out only enough seam to make Phase 1 testable.
- Do **not** ship a full test framework — this is a beachhead, not a coverage drive.

**Acceptance:** `npm run test` runs in under 10 seconds and covers the three helpers above, including at least one paraphrase-evasion case for `turnNeedsRoomResponse`.

### Phase 1 — Visible agent failures

**Goal:** no enabled agent ever silently disappears.

**Tasks:**

- New transcript event: `{ type: "agent_error", agent, provider, model, thinkingLevel, errorSummary, errorRaw, category }`.
- Classify common failure categories: `unsupported_thinking_level`, `auth`, `context_overflow`, `provider_error`, `unknown`.
- New TUI rendering for `agent_error` (red badge, agent name, one-line summary, expandable details).
- `promptAgentWithOverflowRecovery` catches all errors (not just context overflow), emits `agent_error`, then decides per `policy.onAgentError` whether to continue, ask, or halt.
- Distinguish four agent states explicitly in the public transcript: `spoke`, `passed`, `errored`, `interrupted`.
- **Decision (v1.2):** do not silently auto-downgrade unsupported thinking levels. Surface a visible, classified, targeted error first. Add explicit retry/remediation later (for example, a roster quick-fix or `/thinktank retry-agent anthropic --thinking off`).

**Acceptance:** Replaying the actual 16:26:13Z transcript event from `transcript.jsonl` (where Anthropic 4.7 1M internal silently failed) would produce a visible `agent_error` event for the Anthropic lab, not a silent skip. The user would not need to ask "why didn't you respond."

### Phase 1.5 — Runtime hygiene (bundled with Phase 1 PR or immediately after)

**Goal:** clean up two cheap-but-real warts in the runtime hot path while we're already in the file. Deliberately scoped tight so it doesn't bloat Phase 0/1.

**Tasks:**

- `recordPublicAction` (`room-runtime.ts:421`): replace the reverse-linear-scan tool-call/end correlation with a `Map<toolCallId, PublicActionSummary>` lookup. O(1) per tool event instead of O(N).
- `appendRoomEvent` (`room-runtime.ts:481`): move off `appendFileSync` for the hot path. Either (a) batch events through an async write queue, or (b) keep sync but justify it explicitly in a comment. The latter is the simpler near-term move; the former is the right long-term answer once we have async ergonomics elsewhere.

**Non-goals:**

- Don't refactor surrounding code. Touch only the two methods named above.
- Don't change event semantics or transcript format.

**Acceptance:** Phase 1's `agent_error` events still flow correctly. Tool-call correlation works under a synthetic test with 100 concurrent tool calls. No transcript format change.

### Phase 1.75 — Turn-continuation policy (shipped 2026-05-26, superseded 2026-05-27)

> **Superseded by [ADR 0002](adr/0002-trailer-based-speaker-routing.md).** The
> impulse-poll scheduler and every stall band-aid described below
> (`turnNeedsRoomResponse`, `isCollaborationPrompt`, `minDynamicExchanges`,
> forced continuation, `turn_impulse_poll`/`collaboration_mode`/`forced_continuation`
> events) were removed and replaced by deterministic trailer-based speaker routing.
> This section is retained as history.

**Goal:** prevent collaborative rooms from going idle immediately after opening turns.

**Status:** shipped in `8a5306b` (`fix room stalling: invert impulse default, honor opening handoffs, force continuation in collaboration mode`). This phase landed before Phase 0 because the stall blocked the very process producing this plan.

**Failure mode:** rooms appeared to run `GPT-5.5 → Anthropic → stop`, even when the prompt explicitly asked both agents to debate, save, and iterate. This is distinct from Phase 1's agent-error problem: both agents could speak successfully, but the scheduler still stopped too early.

**Causes identified:**

1. The impulse prompt's old "pass unless useful" default was miscalibrated for high-turn collaborative rooms.
2. `chooseNextTurn` is structurally fragile in the two-agent case: after Anthropic speaks, only GPT is eligible; if GPT privately passes, the room stops.
3. `turnNeedsRoomResponse` was only applied inside the dynamic loop, not after opening turns.
4. The English regex missed common handoff/action phrases like "your write", "back to GPT", and "after you save".
5. Hidden impulse decisions were not logged, so private pass/malformed/error decisions looked identical from the public transcript.
6. Collaboration-style prompts had no minimum dynamic exchange floor.

**Shipped fixes:**

- Inverted the impulse prompt default: agents now default to speaking unless they would merely restate prior turns.
- Expanded `turnNeedsRoomResponse` with `assignsNextActionOrHandsOff` patterns.
- Added `isCollaborationPrompt(...)` detection.
- Added `minDynamicExchanges = agents.length * 2` for collaborative prompts.
- Seeded forced responses from opening-turn handoffs.
- Added forced continuation when the chooser returns idle before required response/minimum exchange conditions are satisfied.
- Added `turn_impulse_poll`, `collaboration_mode`, and `forced_continuation` transcript events.

**Caveat:** this is a stop-gap, not the final governance model. The regex expansion makes current rooms behave better, but Phase 3's structured `writeIntent` field remains the correct long-term replacement for regex-driven write/handoff detection.

**Acceptance:** a collaborative prompt emits `collaboration_mode`, logs `turn_impulse_poll` during dynamic turns, and continues past the old `GPT-5.5 → Anthropic → stop` pattern.

### Phase 2 — Artifact collaboration as a proven pattern (not yet a runtime mode)

**Goal:** make debate → save → iterate reliable through existing primitives, *then* formalize.

**Tasks (near-term):**

- Document the pattern in this very file (recursive — *this document is Phase 2's first acceptance test*).
- Use the room as-is to validate the workflow: this plan saved + iterated at least once via emergent agent collaboration.

**Tasks (Phase 2b, deferred):**

- After the promotion trigger fires, add:
  - Command form: `/thinktank plan <path>`
  - Auto-detection from prompts like "save the plan and iterate"
  - Runtime phases: diagnose → debate → draft → save → reread → critique → revise → save → summarize

**Promotion trigger for Phase 2b:** ≥3 plan artifacts produced via the emergent pattern in real use, each with ≥1 in-room revision. Promotion is justified only when the pattern is being reinvented frequently enough that canning it would save real work — not preemptively.

**Acceptance:** This file exists, contains a real plan with debate notes, and is revised at least once via in-room iteration without leaving the room.

### Phase 3 — Runtime write governance

**Goal:** make "wait for convergence before writes" enforceable, not just polite.

**Tasks:**

**Write-governance state machine (v1.1, intent-ID based):**

Every turn starts in `read_only` mode. Lab agents have only `read`, `grep`, `find`, `ls`, and `bash` restricted to a read-only command allowlist. Elevation to write tools happens only via an explicit, scoped, single-turn authorization keyed on an `intentId`.

**Required prerequisite (v1.1):** the agent turn-impulse output must gain a structured `writeIntent` field — `turnNeedsRoomResponse`'s English regex is too brittle to carry path scoping. New impulse shape:

```ts
interface WriteIntent {
  intentId: string;            // UUID generated by the agent
  operation: "edit" | "write" | "bash";
  paths: string[];             // required for edit/write; empty for bash
  commandPrefix?: string;      // required for bash, e.g. "git commit"
  rationale: string;
}
```

**Flow:**

1. Agent declares a `writeIntent` in its turn impulse → runtime emits a public `write_intent` event with the full structured intent.
2. Runtime forces a response turn from another enabled agent. The peer can:
   - **Approve** (no objection marker, no counter-intent) → intent advances to authorized.
   - **Object** (objection marker in turn output) → intent is killed; runtime emits `write_intent_rejected` event.
   - **Counter-propose** (peer's turn declares its own `writeIntent` with a different `intentId`) → original intent is killed; the new intent becomes the active one and starts the flow over.
3. On approval, runtime emits `write_authorized` and grants the original proposer's *next turn only* an elevated toolset scoped exactly to the declared `paths` (for edit/write) or `commandPrefix` (for bash). Tool calls outside that scope are rejected by the runtime.
4. After the write, runtime emits `write_completed` with the `intentId` and the resulting diff or bash output.
5. If the authorized turn doesn't actually perform the write, the authorization auto-decays at turn end.

**Destructive bash denylist** (`rm -rf`, `mv` onto existing paths, `git push -f`, `git reset --hard`, etc.) is gated identically even if `bash` is otherwise allowed — i.e. these always require an explicit `writeIntent` with `operation: "bash"`.

Every state transition is a transcript event.

**Acceptance:** No file mutation happens without a preceding `write_intent` event and at least one peer-response event in the transcript. Audit log answers "why did this write happen?" from the transcript alone.

### Phase 4 — Interruption wiring

**Goal:** make `/interrupt` and model-to-model interruption actually meaningful.

**Tasks:**

- Route opening and dynamic turns through an interruption-aware prompt path (build the equivalent of the unused `promptAgentWithInterrupts` lineage).
- Subscribe to session `message_update` events and update `activeTurn.partialText` live.
- Increment `activeTurn.toolCallsCompleted` and `toolErrors` on tool start/end events.
- Emit transcript events for interruption decisions: `interrupt_requested`, `interrupt_granted`, `interrupt_aborted`.
- Preserve partial text and feed it into the next agent's prompt under the existing `Partial visible output:` slot in the prompt template (the slot is already there; we just need to populate it).
- Audit every path that sets `interruptionLock = true` and confirm a release path exists. Stuck-lock recovery via a watchdog timer if needed.

**Acceptance:** `/interrupt` during an active turn aborts the turn and the next speaker receives the partial output in its prompt. At least one model-to-model interruption fires successfully in a long room and is visible in the transcript.

### Phase 5 — Configurable room policy (with cost/wall-clock guardrails)

**Goal:** replace hidden constants with explicit, persisted settings — *and* close the cost-runaway gap that the recent cap raise opened.

**Tasks:**

- New type:

  ```ts
  interface ThinktankRoomPolicy {
    maxTurns: number;                        // default 1000
    maxOpenQuestionResponseTurns: number;    // default 1000
    maxRuntimeMs: number;                    // default 30 * 60_000 (30 min)
    maxTokensPerPrompt?: number;             // optional, requires SDK counter
    onAgentError: "halt" | "continue" | "ask"; // default "continue"
    writePolicy: "prompt" | "consensus" | "autonomous"; // default "consensus" after Phase 3
    memoryPolicy: "ephemeral" | "persistent" | "artifact"; // default "persistent" (today's behavior)
  }
  ```

- Persist under `~/.ai-thinktank/settings.json`. Migrate the current hardcoded constants to defaults — existing rooms behave identically.

- **Cost / wall-clock guardrails** (sub-item, added in v1.0):
  - Soft `onStatus` warnings at turn 25 / 50 / 100 in long rooms.
  - Hard `maxRuntimeMs` enforcement; on exceed, emit a `room_halt` event and stop accepting new turns.
  - Optional `maxTokensPerPrompt` if/when the SDK exposes a cumulative-per-prompt counter.

**Tasks (Phase 5b):**

- **Decision (v1.2):** ship minimal policy commands with the policy type. A policy type without commands is developer-complete but user-hostile.
- Minimum user-facing commands:
  - `/thinktank policy` (show current)
  - `/thinktank policy set maxTurns <n>`
  - `/thinktank policy set maxRuntimeMs <ms>`
  - `/thinktank policy reset`
- Defer richer UI/overlay controls and specialized shorthands such as `/thinktank writes prompt|consensus|autonomous` and `/thinktank memory ephemeral|persistent|artifact` until the minimal command path has proven useful.
- Policy-setting commands mutate user configuration under `~/.ai-thinktank/settings.json`, not project files. They should not be governed by the future Phase 3 write-intent gate.

**Acceptance:** No critical loop behavior is hardcoded; defaults reproduce today's behavior exactly so this is a non-breaking change. `maxRuntimeMs` triggers in a synthetic test room.

### Phase 6 — Memory transparency

**Goal:** make persistent / private context legible and controllable.

**Known footgun (already shipped, must be documented immediately):**

`SessionManager.continueRecent` was committed on 2026-05-26 with no UX surface for resetting. This means lab agents walk into a fresh-looking room carrying primed framing from prior prompts in the same cwd. **Until Phase 6 lands, document this in the README explicitly.** A user-facing README note is a 5-minute change and should ship before any later Phase 6 work.

**Tasks:**

- Document current behavior in README:
  - Room transcript is per-cwd at `~/.ai-thinktank/room-sessions/<cwd>/transcript.jsonl`.
  - Lab agent private sessions use `SessionManager.continueRecent(...)` — sessions persist across runs and across human prompts within a cwd.
- Add `/thinktank memory status|clear|ephemeral|persistent` (Phase 6b).
- Support three memory modes:
  - `ephemeral` — fresh private session per human prompt.
  - `persistent` — today's behavior, kept as opt-in default.
  - `artifact` — only persisted on-disk artifacts (transcripts, plans) influence next run; private sessions reset.

**Acceptance:** `/thinktank memory status` shows exactly what each lab remembers and from when. `/thinktank memory clear` returns the room to a fresh state without restarting Pi.

## 5. Out of plan (deliberately deferred)

These are real issues we identified, but they're either lower-leverage or upstream:

- **Full `room-runtime.ts` refactor / file split.** Tempting but risky without the Phase 0 seam. Revisit after Phase 4 once we have real test coverage of the hot paths.
- **Provider-layer fix for `thinking.type.enabled` on Copilot Claude internal models.** That's a `pi-ai` / `pi-agent-core` issue, not this extension's. Phase 1 makes the symptom visible; the proper fix lives upstream in Pi itself.
- **Lab roster extensibility** (adding a 4th lab without code changes — currently requires editing `roster.ts:7`, `roster.ts:47`, and the iteration in `room-runtime.ts:389`, plus the `LabId` union). Real issue, lower urgency than trust/visibility.
- **Image re-grounding per turn.** `agentsThatReceivedHumanImages` (line 299) marks images as delivered after the first turn per agent. Real issue but affects only image-heavy rooms.
- **`recordPublicAction` O(N) tool-call/end correlation.** Harmless at 10 turns, less so at 1000. Optimize after Phase 0 makes the change easy to test.
- **Synchronous `appendFileSync` on the hot path** for every tool start/end. Same logic — defer until refactor.
- **Pi extension dev-loop friction.** Pi loads installed git extensions from a separate checkout under `~/.pi/agent/git/...`, not from the developer repo. After every extension change, the actual loop is: edit dev repo → commit + push → `pi update <source>` → `/reload` in Pi. Forgetting either update/reload makes a fix look broken even when the repository is correct. Mitigations belong upstream in Pi (for example: `pi dev <local-path>`, an "installed extension behind remote" startup warning, or auto-reload on install-dir source changes), but the footgun is recorded here so future sessions do not lose the same debugging cycle.

## 5.5 Execution sequence

1. **README footgun note for `SessionManager.continueRecent`.** Cheapest user-visible fix; can ship before or alongside Phase 0.
2. **Phase 0 — validation seam.** Establish `node:test` coverage for the pure helpers and error/event formatting.
3. **Phase 1 — visible agent failures.** Add classified `agent_error` transcript/UI handling.
4. **Phase 1.5 — runtime hygiene.** Keep the `recordPublicAction` and transcript-write cleanup near Phase 1 but scoped separately.
5. **Phase 5 — policy type, cost/wall-clock guardrails, and minimal policy commands.** Make runtime behavior explicit and user-configurable.
6. **Phase 4 — interruption wiring.** Can proceed in parallel with Phase 3 once the validation seam exists.
7. **Phase 3 — write governance.** Largest scope; depends on structured `writeIntent` rather than regex handoff detection.
8. **Phase 6 — memory controls.** Add status/clear/mode commands after policy infrastructure exists.
9. **Phase 2b — formal artifact workflow.** Promote only after the documented trigger fires: at least three emergent plan artifacts with at least one in-room revision each.

## 6. Iteration log

- **v1.0 — 2026-05-26 (this session, in-room):**
  GPT-5.5 drafted v0 across multiple opening rounds (Anthropic silent due to provider config error).
  Anthropic finally landed via Claude Opus 4.6, then 4.7 1M Internal, and challenged:
  - the validation-seam-before-error-handling ordering,
  - the runtime-vs-pattern framing of the artifact workflow.
  GPT-5.5 produced v1 incorporating Phase 0 (validation seam) and the artifact-pattern-before-runtime split.
  Anthropic added three v1.0 amendments:
  - Cost / wall-clock guardrails folded into Phase 5 (not a separate phase).
  - `SessionManager.continueRecent` named explicitly as an already-shipped footgun under Phase 6.
  - Concrete promotion trigger for Phase 2 → Phase 2b (≥3 emergent artifacts with ≥1 revision each).
  Saved to `docs/thinktank-improvement-plan.md`.

- **v1.1 — 2026-05-26 (this session, iteration round 1):**
  After v1.0 saved, Anthropic raised three iteration candidates:
  - (A) resolve test framework choice now,
  - (B) tighten Phase 3's authorization race when a peer counter-proposes,
  - (C) consider bundling small hygiene fixes into Phase 0.
  GPT-5.5 responded with proposed resolutions; user noted the room had not actually concluded; Anthropic accepted GPT-5.5's positions with one tightening, producing v1.1:
  - **Phase 0:** lock `node:test` as the test framework (closes Open Question 1).
  - **Phase 3:** redesigned around `intentId`-scoped, single-turn authorization with explicit counter-propose handling. Names a new prerequisite: structured `writeIntent` field in the turn impulse, replacing the brittle `turnNeedsRoomResponse` regex for write-governance purposes specifically (closes Open Question 2).
  - **New Phase 1.5:** runtime hygiene bucket for `recordPublicAction` O(N) walk and `appendFileSync` on the hot path. Kept out of Phase 0/1 to bound blast radius.
  Saved via targeted edits to `docs/thinktank-improvement-plan.md`. Room declared converged.

- **v1.2 — 2026-05-26 (this session, iteration round 2):**
  The room closed the final two open questions and incorporated the scheduler fix that reality forced ahead of the planned Phase 0:
  - **Open Question 3:** no silent thinking-level downgrade. Phase 1 should surface classified, targeted `agent_error` messages; explicit retry/remediation can come later.
  - **Open Question 4:** minimal policy commands ship with the policy type; richer UI/overlay commands are deferred.
  - **New Phase 1.75:** documented the already-shipped turn-continuation policy fix (`8a5306b`) that prevents collaborative rooms from stalling after opening turns.
  - **Execution sequence:** added a concrete implementation order so the plan is actionable.
  - **Out-of-plan footgun:** recorded Pi's dev-repo vs install-dir update/reload trap after it caused a false negative test of `8a5306b`.
  Status updated to "Implementation plan converged; ready to execute."

## 7. Resolved questions

1. ~~**Phase 0 test framework choice.**~~ **Resolved in v1.1:** `node:test`.

2. ~~**Phase 3 write-governance strictness.**~~ **Resolved in v1.1:** authorization is keyed on `intentId` and is granted by default if the peer response does not contain an objection marker or a counter-intent. Counter-proposals are first-class new intents with distinct IDs. The scope is path-bounded (edit/write) or command-prefix-bounded (bash) and expires after one turn.

3. ~~**Phase 1 graceful-downgrade behavior.**~~ **Resolved in v1.2:** do not silently auto-downgrade unsupported thinking levels. Surface a visible, classified, targeted error and add explicit retry/remediation later.

4. ~~**Phase 5b timing.**~~ **Resolved in v1.2:** ship minimal policy commands with the policy type. Defer richer UI/overlay controls.

---

*This document is the first artifact produced by Thinktank's emergent debate-save-iterate pattern. Whether the pattern needs runtime support (Phase 2b) is itself a question this document is built to help answer over time.*
