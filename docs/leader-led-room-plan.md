# Leader-Led Supervisor Room Plan

**Status:** Accepted direction; ready to implement
**Date:** 2026-06-09

## 1. Decision

Make **leader-led** the default Thinktank room shape once the user explicitly configures one trusted leader.

The leader acts as a supervisor: it works on the human's request, consults advisors when useful, may exchange multiple messages with them, uses tools, and produces the final response. Advisor and intermediate leader prose is collapsed by default. The user primarily sees compact activity, important leader actions, failures, and the leader's final answer.

Keep the existing freeform trailer-routed room as an opt-in **debate mode**.

Leader-led being the default mode does **not** mean Thinktank is default-on. An unconfigured installation or a leader-led roster without exactly one enabled leader must not intercept ordinary Pi prompts.

## 2. Product contract

Leader-led mode must guarantee:

1. **The user chooses the leader.** The runtime never infers trust from roster order or auto-promotes an advisor.
2. **The leader owns the answer.** Only the selected leader can produce the normal final output.
3. **The leader controls consultation.** It chooses which advisors to consult, what to ask, and whether another exchange is useful.
4. **Advisors always return the floor.** Advisors can inform the leader but cannot redirect, finalize, or take over the room.
5. **Work is collapsed, not secret.** Hidden conversation and tool activity remain recorded and inspectable.
6. **The foreground stays quiet.** Intermediate prose does not flood the user's session.
7. **Leader actions are prominent.** Important leader tool actions and failures remain visible even while conversation is collapsed.
8. **Leader does not mean unrestricted executor.** Role authority never bypasses configured tool, mutation, or destructive-command policy.
9. **Leader failure does not transfer trust.** If the leader fails or is suppressed, halt and ask the human what to do.
10. **Hidden work remains bounded.** The UI shows progress/budget and the runtime enforces a turn cap.

## 3. User experience

### Normal foreground

During a run, show a compact activity strip or live widget rather than every message:

```text
Kepler working…                                  2 / 12 turns
Kepler consulting Claude Opus 4.8…               3 / 12 turns
Claude Opus 4.8 replying…                        4 / 12 turns
Kepler editing src/scheduler.ts…                  5 / 12 turns
Kepler running tests…                             5 / 12 turns
```

When complete, show the leader's final response as the normal prominent answer.

### Visibility hierarchy

**Foreground:**

- the human prompt;
- current compact activity;
- important leader actions, especially mutations, commands, validation results, and failures;
- runtime safety warnings and failures from any participant;
- the leader's final response.

**Collapsed work drawer:**

- intermediate leader messages;
- advisor requests and replies;
- advisor read/search activity;
- routine leader reads/searches;
- per-turn metadata and model provenance.

**Durable audit log:**

- every room event and full participant contribution in `transcript.jsonl`;
- tool starts/results and failures;
- routing and finalization decisions.

“Hidden” always means collapsed in the normal UI, never omitted from the transcript.

### Leader actions

Leader actions receive greater prominence than advisor work:

- routine leader reads/searches update the activity strip and remain in the drawer;
- leader mutations, shell commands, test/validation results, and tool failures create persistent visible action rows;
- advisor actions remain subdued by default because advisors are read-only;
- all runtime-blocked operations and errors remain visible regardless of role.

The activity label should derive useful detail from tool arguments when safe, for example:

```text
Kepler reading room-runtime.ts…
Kepler editing docs/leader-led-room-plan.md…
Kepler running npm test…
```

Avoid exposing sensitive arguments in the compact status line; full arguments remain in the audit drawer/transcript.

## 4. Supervisor conversation model

Leader-led mode is a hub-and-spoke conversation, not a panel or opening round.

1. The leader always receives the human prompt first.
2. On each leader turn, it may:
   - use tools and continue its own work;
   - consult one advisor with a focused request;
   - produce the final answer.
3. A consulted advisor receives the human request, relevant room context, and the leader's latest request.
4. After one advisor reply, the runtime always returns the floor to the leader.
5. The leader may consult the same or another advisor again, use more tools, or finalize.
6. Only an explicit leader final signal completes the room normally.

There is no advisor opening lap, advisor bidding, advisor-to-advisor routing, voting, quorum, or advisor veto in leader-led mode.

### Routing protocol

Extend the hidden `CONTROL` payload for leader-led turns:

```ts
type LeaderControl =
  | { action: "consult"; next: AgentId }
  | { action: "continue" }
  | { action: "final" };

type AdvisorControl = {
  action: "return";
};
```

The visible text before a leader `consult` control is the leader's request to that advisor. The visible text before `final` is the final user-facing answer. Intermediate visible text is stored but collapsed in the normal UI.

Runtime rules:

- only the leader's `consult` and `final` controls affect routing;
- advisor control fields other than `return` are ignored and audited;
- after every advisor turn, route to the leader even if the advisor emits malformed or absent control;
- a leader `consult` target must be an enabled advisor;
- an invalid leader control gets one bounded repair attempt, then halts visibly;
- when the turn budget is exhausted without `final`, halt and return control to the human instead of treating the latest text as final.

### Context supplied to participants

The leader should receive advisor replies and useful action summaries directly in its private room context. It should not need to reconstruct hidden work from the UI transcript.

An advisor receives only what it needs:

- the human prompt;
- the leader's focused request;
- relevant recent context/action summaries;
- its own private session context.

V1 should not give advisors the full conversation with other advisors. This reduces anchoring, context growth, and accidental advisor-to-advisor debate.

## 5. Roles and defaults

Extend roster selections with a role:

```ts
role?: "leader" | "advisor";
```

Rules:

- exactly one enabled leader is required for leader-led mode;
- all other enabled entries are advisors;
- duplicate provider/models remain allowed;
- the leader is selected explicitly in `/thinktank roster`;
- assigning a new leader demotes the previous leader to advisor;
- removing/disabling the leader makes leader-led configuration incomplete;
- the runtime never chooses a replacement leader automatically.

Add room mode configuration:

```ts
roomMode: "leader-led" | "debate";
```

Defaults and migration:

- leader-led is the default mode for a newly configured roster once a leader is selected;
- existing installations with no role metadata remain in debate mode until the user chooses a leader;
- `/thinktank mode leader-led|debate` changes the mode explicitly;
- leader-led mode with no valid leader must not swallow/intercept an ordinary Pi prompt;
- Thinktank remains off until intentionally enabled/configured; mode default and activation are separate.

Status should show, at minimum:

```text
Thinktank: leader-led | Leader: Kepler | 3 advisors | 0 / 12 turns
```

## 6. Capability boundaries

Role authority and tool authority are separate.

### Advisors

Advisors are read-only by default using an explicit per-role allowlist. Initial built-in allowlist:

```text
read, grep, find, ls
```

Additional research or external tools require explicit configuration because the runtime cannot safely infer whether every extension/MCP tool is read-only or private-data-connected.

### Leader

The leader receives the configured leader capability profile and may perform coding actions such as edits when that profile allows them. Being leader never bypasses runtime restrictions or future write governance.

V1 must describe current safety honestly: until runtime mutation governance exists, granting the leader mutation tools still relies on the configured Pi/tool policy. Leader-led mode must not claim that a write is safe merely because it came from the trusted leader.

### Mandatory visible events

Collapsing work must never hide:

- agent/provider errors;
- blocked or denied tool calls;
- mutation and destructive-command approvals/denials when governance exists;
- failed validation/tests;
- turn-budget exhaustion;
- leader failure or suppression.

Advisor warnings are available in the drawer/transcript, but an untrusted advisor cannot force arbitrary prose into the foreground merely by labeling it urgent. Runtime-classified safety and failure events control mandatory visibility.

## 7. Runtime design

Reuse the existing room runtime, lab sessions, transcript, failure handling, callbacks, and live widget. Do not build a second orchestration engine.

Add a role-aware leader scheduler alongside the existing debate scheduler:

```ts
type LeaderLedState = {
  leaderId: AgentId;
  awaiting: "leader" | AgentId;
  turnsUsed: number;
  maxTurns: number;
  repairUsed: boolean;
};
```

The scheduler is pure and deterministic:

- starts on the leader;
- routes a valid leader consultation to the chosen advisor;
- routes every advisor reply back to the leader;
- stops only on valid leader final, leader failure/halt, or budget exhaustion;
- ignores advisor bids/handoffs/finalization attempts.

### Turn budget

Hidden conversation makes accidental cost less visible, so leader-led mode requires a hard, visible budget from V1.

Initial default:

```ts
leaderLedMaxTurns: 12
```

Count every leader and advisor model turn. Tool calls within a turn do not increment the room-turn count but remain visible/audited. Expose the count in status/activity. Later policy work may add token, cost, and wall-clock budgets.

### Final output

A leader turn becomes the final user-facing response only when it carries a valid `action: "final"` control. Strip the control and render the remaining leader text as the final answer.

Prompt the leader to be succinct and answer the human directly. Do not force all answers into a rigid schema; the leader's response should remain a natural Pi answer. The runtime may enforce a generous maximum size or request one repair for empty/malformed final output, but it must not silently replace the leader's answer with another model's summary.

## 8. UI and callback changes

The current extension already exposes most required signals through `onStatus`, `onAgentTurnStart`, `onAgentTurnEnd`, `onAgentEvent`, and `LiveRoomWidget`. Extend these with role/visibility intent rather than duplicating event flow.

Add role and presentation metadata to room callbacks/events, for example:

```ts
type TurnPresentation = "foreground" | "collapsed" | "final";
```

Behavior:

- leader/advisor turn start updates the compact activity strip;
- intermediate streamed prose is not rendered in the foreground;
- advisor tool/read activity updates subdued status only;
- leader tool activity updates status, and important actions create persistent visible rows;
- final leader turn renders as the prominent agent response;
- an expandable Thinktank-work summary opens the complete hidden interaction history;
- the structured JSONL transcript remains the source of truth for audit/debugging.

## 9. Implementation sequence

### Phase A — Roles, protocol, and pure scheduling

- Add roster roles and mode types.
- Add leader `consult` / `continue` / `final` and advisor `return` parsing.
- Add the pure leader scheduler and hard turn-budget handling.
- Unit-test leader-only authority and advisor return behavior.

Likely files:

- `roster.ts`
- new `leader-control.ts`
- new `leader-scheduler.ts`
- focused unit tests

### Phase B — Roster, settings, and activation UX

- Persist leader role, `roomMode`, and `leaderLedMaxTurns`.
- Add leader selection to `RosterSelectorComponent`.
- Make leader-led the default mode after explicit leader selection.
- Add `/thinktank mode leader-led|debate`.
- Show leader, advisor count, mode, and turn progress in status.
- Fix activation so an invalid/empty leader-led room never intercepts normal Pi prompts.

Likely files:

- `roster-selector.ts`
- `index.ts`
- roster/settings/UI tests

### Phase C — Supervisor orchestration

- Route `submitHumanPrompt` through the selected scheduler.
- Add leader and advisor prompt builders.
- Allow repeated, focused leader-advisor exchanges.
- Always return advisor turns to the leader.
- Halt on leader failure; never auto-promote.
- Add per-role lab tool options.
- Preserve all hidden conversation and actions in transcript events.

Likely files:

- `room-runtime.ts`
- `runtime-deps.ts` if per-role session options require it
- runtime integration tests

### Phase D — Quiet foreground and leader prominence

- Replace intermediate message cards with compact activity updates.
- Keep leader mutations/commands/validation and mandatory failures visible.
- Render only valid leader final output as the normal final answer.
- Add an expandable work/audit drawer for collapsed interactions.
- Document leader-led versus debate mode and their trust models.

Likely files:

- `index.ts`
- `README.md`
- a new ADR after implementation details are validated

### Phase E — Evaluation and default rollout

Before migrating existing debate users automatically, compare leader-led, debate, and a solo trusted leader on representative tasks:

- answer quality;
- missed risks;
- turns/time/cost;
- usefulness of advisor consultations;
- frequency of users opening the audit drawer;
- user trust in the final answer.

Keep existing installations stable until the leader-led workflow proves reliable.

## 10. Acceptance tests

Leader-led mode is complete when tests prove:

1. A configured leader always receives the first turn.
2. A leader can consult any enabled advisor and receives the next turn after the reply.
3. A leader can consult the same or different advisors repeatedly within budget.
4. An advisor cannot redirect, finalize, bid for, or retain the floor.
5. Only a valid leader `final` turn becomes the normal final answer.
6. Intermediate leader/advisor prose is collapsed while remaining in the audit transcript.
7. Leader mutations/commands/validation and mandatory failures remain visible.
8. Advisors cannot access mutation tools under the default advisor policy.
9. Leader role does not bypass the configured capability policy.
10. Leader failure halts without auto-promoting an advisor.
11. Budget exhaustion halts visibly and does not promote the latest intermediate text to final.
12. An invalid leader configuration does not intercept/swallow a normal Pi prompt.
13. Existing debate-mode scheduling and tests remain unchanged.
14. The activity strip identifies actor/action safely without leaking sensitive tool arguments.

## 11. Non-goals for V1

- Automatic leader selection or failover.
- Advisor voting, quorum, or veto.
- A mandatory consultation/opening round for every advisor.
- Advisor-to-advisor conversation.
- Advisor mutation authority by default.
- Making hidden work unavailable to the user.
- Treating leader-led mode as a substitute for runtime capability/write governance.
- Solving general token/cost accounting or transcript compaction beyond the required turn cap.

Those remain separate concerns. Leader-led mode should express the user's actual trust model: **leader decides, advisors inform, runtime enforces, and the UI stays quiet until the leader has the answer.**
