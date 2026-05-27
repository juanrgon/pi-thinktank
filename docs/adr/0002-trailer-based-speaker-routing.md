# ADR 0002: Trailer-based speaker routing

## Status

Accepted

## Date

2026-05-27

## Context

Thinktank's turn-taking is decided by an **LLM impulse poll**. On every dynamic
turn, `chooseNextTurn` fires one hidden `completeSimple` call to *every* eligible
Lab Agent in parallel, asks each whether it wants the floor and with what
`urgency`, parses the JSON impulses, and picks the strongest. The opening phase
is a separate code path (`chooseOpeningTurn`).

This one decision — *let the listeners vote, via extra model calls, on who speaks
next* — is the root of most of the runtime's accidental complexity and cost:

1. **Cost.** Each visible turn costs `N` extra hidden completions just to choose a
   speaker (`N` = eligible agents), on top of the visible turn itself.
2. **Stall band-aids.** The poll stalls in the two-agent case (after A speaks only
   B is eligible; if B privately passes, the room dies). A pile of corrective
   machinery grew to fight this: `turnNeedsRoomResponse` (a brittle English-only
   regex), `isCollaborationPrompt`, `minDynamicExchanges`, `forcedResponseTurnsRemaining`,
   `extraTurnBudget`, and `forced_continuation`. The improvement plan itself calls
   the regex a "stop-gap."
3. **Opacity.** "Why did this agent speak next?" can only be answered by replaying a
   hidden completion, not from the transcript.
4. **Fragility.** Malformed impulse JSON is silently treated as "pass," so
   continuation depends on prompt obedience and well-formed JSON.

The project's stated priorities (ADR 0001) are **trust, legibility, and
auditability**, not an organic "feel" for its own sake. A deterministic scheduler
serves those priorities better than an LLM vote.

## Decision

Replace the impulse poll with **trailer-based speaker routing**: a deterministic,
pure scheduler that reads cheap control signals which ride on the *visible* turn we
already pay for. Zero extra model calls per scheduling decision.

### Control trailer

Each agent ends its visible turn with one line carrying a compact JSON control
signal. The runtime strips this line before other agents see the message and
records the parsed signal as that agent's *standing trailer*.

```
CONTROL: {"done": false, "yield": false, "next": "anthropic", "bid": 70}
```

| field   | type                                  | meaning                                              |
| ------- | ------------------------------------- | ---------------------------------------------------- |
| `bid`   | int 0–100                             | how strongly the agent wants the floor again next     |
| `next`  | `openai` \| `google` \| `anthropic` \| null | the agent it thinks should respond next ("over to you") |
| `yield` | bool                                  | "I have nothing more to add right now"               |
| `done`  | bool                                  | "I believe the room has reached its answer"          |

`next`/`bid` together reproduce the impulse poll's two outputs (who / how
urgently) — but sourced from turns already bought, and recorded in the transcript.

### Trailer parsing semantics (`control-trailer.ts`)

- **Absent / unparseable** trailer → `{present:false, done:false, yield:true, next:null, bid:0}`.
  An agent that did not ask to continue is conservatively treated as yielding. This
  makes a lone agent stop after it speaks and prevents runaway when models ignore
  the protocol.
- **Present** trailer with missing fields → engaged defaults: `yield:false`,
  `done:false`, `bid:50`. A participating agent that emits `CONTROL: {}` stays in
  the conversation.
- `next` is normalized through an alias map (`gpt`→`openai`, `gemini`→`google`,
  `claude`/`opus`→`anthropic`) and validated against the active agent ids; unknown
  → `null`.

### Scheduler (`scheduler.ts`, pure)

`pickNextSpeaker` is a pure function of the standing trailers, the active agents,
the rotation order, the last speaker, the set of agents who have spoken, and the
agent ids mentioned in the human prompt:

1. No active agents → `stop("no_active_agents")`.
2. Candidates = active agents minus the last speaker (no back-to-back), unless only
   one agent is active.
3. **Opening priority.** Any candidate that has not spoken yet goes first, in
   rotation order; agents named in the human prompt are preferred. This is the
   opening lap, unified into the same loop — no separate opening code path.
4. Once everyone has spoken: if every active agent's standing trailer has
   `done:true` → `stop("all_done")`.
5. **Directed handoff.** If the last speaker's `next` names an active candidate,
   pick it (overrides `yield`/`done`).
6. **Reactive priority.** Among *eager* candidates (not `done`, not `yield`), pick
   the highest `bid`; ties resolve to whoever is next in rotation order after the
   last speaker. If no eager candidate exists → `stop("converged")`.

Every decision is recorded as a `turn_selection` transcript event with its reason
(`opening` | `handoff` | `bid`).

### How "organic" qualities are recovered (zero extra model calls)

| organic quality                | mechanism                                   |
| ------------------------------ | ------------------------------------------- |
| variable speaker order         | `bid` reranks the queue each step           |
| "over to you, Claude"          | speaker's `next` nomination                 |
| pass when nothing to add       | `yield`                                     |
| urgent interjection            | high `bid` jumps the queue at the next turn |
| natural convergence / stop     | `done` from all, or all eager exhausted     |
| everyone contributes once      | opening-priority for unspoken agents        |

### Runtime caps

A `maxRounds` constructor option (default `8`) bounds the room at
`min(MAX_ROOM_TURNS, maxRounds * initialActiveAgents)` turns. `MAX_ROOM_TURNS`
(1000) remains as an absolute ceiling. Continuation is otherwise driven by explicit
agent demand, not hidden polling.

## Consequences

### Removed

- `chooseNextTurn` and its `N` hidden completions per turn.
- `chooseOpeningTurn` (opening folded into the unified loop).
- `parseTurnImpulse`, `turnNeedsRoomResponse`, `isCollaborationPrompt`,
  `TurnImpulse`/`TurnImpulseKind`, and the whole `turn-impulse.ts` module.
- The stall band-aids: `minDynamicExchanges`, `forcedResponseTurnsRemaining`,
  `extraTurnBudget`, `forced_continuation`, `collaboration_mode`,
  `MIN_DYNAMIC_TURNS_AFTER_OPENING`, `MAX_OPEN_QUESTION_RESPONSE_TURNS`,
  `TURN_IMPULSE_SYSTEM_PROMPT`, `turn_impulse_poll`, `room_response_required`.

### Added

- `control-trailer.ts` + `scheduler.ts` (pure, dependency-free, fully unit-tested).
- `turn_selection` transcript events.
- A `maxRounds` room option.

### Net effect

Scheduling LLM calls per visible turn drop from `N` (+ interrupt polling) to `0`.
Turn selection becomes a pure, transcript-auditable function. The two-agent stall
is structurally impossible (opening lap + rotation fallback), so the band-aids are
deleted rather than maintained.

## Non-goals

- **Model-to-model interruption** (`pollForInterruptions`) is untouched. It is an
  orthogonal concern and remains as-is, including its own hidden completion. A
  later ADR may revisit it.
- **Transcript windowing.** The per-turn prompt still embeds the full transcript.
  Bounding it is a separate cost fix, deferred to keep this change reviewable.
- **Write governance / memory transparency.** Unchanged; see the improvement plan.

## Alternatives considered

- **Pure round-robin (no trailer).** Simplest, but loses targeting and dynamic
  ordering, and forces every agent to speak every round even with nothing to add.
- **Keep the impulse poll but cache it.** Still `N` calls amortized and still
  opaque. Rejected.
- **Default absent trailer to "engaged."** Risks runaway when models ignore the
  protocol; rejected in favor of conservative "yield" + a guaranteed opening lap.
