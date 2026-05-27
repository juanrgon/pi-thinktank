# ADR 0001: Public readiness gates for Thinktank

## Status

Proposed

## Date

2026-05-27

## Context

Thinktank has moved past a fragile prototype. It now supports multi-agent rooms, persistent lab sessions, visible transcript events, proactive context refresh, interruption handling, agent failure classification, repeated-failure suppression, and a real runtime test harness with fake dependencies.

That creates a tempting but risky ambiguity: the extension is usable by its author, and it is installable from a public Git repository, but that does not mean it is ready to be recommended broadly to Pi users.

The core trade-off is between early feedback and trust. Publishing too late delays feedback on the room experience. Publishing too early as "ready" risks surprising users with silent delays, stale private memory, uncontrolled resource use, and prompt-only write safety.

## Decision

Thinktank will use three readiness states:

1. **Internal alpha** — suitable for Juan's own use and development feedback.
2. **Public preview** — suitable for adventurous Pi users who explicitly opt in to an experimental extension.
3. **Public ready** — suitable for broad recommendation to Pi users.

Thinktank is currently **internal alpha**.

Thinktank may become **public preview** before all public-ready gates are complete, but only if the README and user-facing docs label it experimental and the default capability set is made safe enough for opt-in users.

Thinktank must not be called **public ready** until the public-ready gates below are met.

## Threat model for v1.0

The v1.0 public-readiness gates target **well-behaved models that occasionally make mistakes**.

In scope:

- a Lab Agent gets confused by stale private context;
- a Lab Agent fails because of provider, authentication, or model-compatibility issues;
- a Lab Agent calls a tool at the wrong time;
- a room runs longer or costs more than the user expects;
- a model produces malformed control JSON;
- a user cannot tell whether an agent is waiting, refreshing context, composing, failed, suppressed, or idle.

Out of scope for v1.0:

- adversarial model containment;
- malicious human users;
- sandbox escape resistance;
- hostile prompt-injection defense as a security boundary;
- universal human approval for every write.

Those harder security goals may require a later hardening ADR.

## Public preview gates

Public preview requires:

1. **Experimental labeling**
   - README and usage docs clearly say Thinktank is experimental.
   - Docs explain that breaking changes and rough edges are expected.

2. **Room observability baseline**
   - Users can see when an agent is refreshing private context, composing, errored, suppressed, interrupted, or idle.
   - Users do not need to inspect JSONL logs to understand ordinary delays or missing turns.

3. **Safer default capabilities (moderate allowlist)**
   - Lab Agent tool access is restricted by a runtime allowlist, not by prompt instruction alone.
   - The preview default allowlist is:
     - **Always allowed:** read-only tools (`read`, `find`, `grep`, `ls`).
     - **Allowed with a small enumerated denylist:** `bash`, restricted to refuse known-destructive patterns (`rm -rf` on absolute paths, `git push --force` / `--force-with-lease`, `git reset --hard`, `npm publish`, `gh release create`, and shell redirection that truncates tracked source files). The denylist is enumerated, not heuristic.
     - **Allowed:** `edit`, `write` against the project working directory.
     - **Disallowed by default:** writes outside the project working directory; network egress beyond model-provider calls; package installation that mutates the host environment.
   - The user can override the default allowlist per room, but the override is recorded in the transcript.
   - Rationale: read-only-only kills the core multi-agent coding use case; permissive-with-warning is just the current prompt-etiquette governance with a banner. A small enumerated denylist on writes is the smallest credible runtime governance that still preserves the product.

4. **Memory transparency baseline**
   - Docs explain persistent private lab sessions and shared transcripts.
   - There is a documented way to inspect and reset persisted room state.

5. **Operational guardrail baseline**
   - The extension has documented stop/reset commands.
   - Long-running rooms emit visible status and do not appear frozen.

Public preview does not require the full write-governance state machine.

## Public-ready gates

Public ready requires all public-preview gates plus:

1. **Runtime governance for dangerous actions**
   - Destructive shell commands are blocked or require runtime confirmation.
   - File writes and edits happen under an auditable runtime policy rather than prompt etiquette alone.
   - Transcript events explain why elevated capabilities were granted.

2. **Operational guardrails by default**
   - Turn limits, wall-clock limits, and memory controls are explicit user-facing policy, not hidden constants.
   - Users can inspect and reset policy.

3. **Model compatibility clarity**
   - Unsupported thinking levels and provider quirks produce visible, actionable errors.
   - The roster UI does not make unsupported model configurations look silently valid.

4. **Documentation completeness**
   - README covers install, setup, roster selection, common commands, memory behavior, limitations, and troubleshooting.
   - Public docs describe the readiness state and known non-goals.

5. **Regression coverage for core room behavior**
   - Runtime tests cover opening turns, continuation, proactive context refresh, interruption, agent suppression, and compaction retry behavior.
   - CI runs those tests and syntax checks the runtime entry points.

## Governance layers

The project will use the following governance layers as release gates:

- **L1: Documentation warnings** — required for public preview and public ready.
- **L2: Tool allowlists / safer default capabilities** — required for public preview and public ready.
- **L3: Runtime confirmation or blocking for destructive operations** — required for public ready.
- **L4: Sandboxing** — non-goal for v1.0.
- **L5: Universal approval queue for every write** — non-goal for v1.0.

## Consequences

- The project can seek early user feedback without pretending the extension is finished.
- Public communication must distinguish "installable" from "public ready".
- Some work that is useful for Juan remains insufficient for public readiness if it is not documented, visible, or enforced at runtime.
- Write governance becomes a public-ready gate, not an optional polish item.
- Sandboxing and adversarial security are explicitly deferred so v1.0 scope does not expand without bound.

## Non-goals

This ADR does not design the write-governance state machine in detail. The existing improvement plan covers that separately.

This ADR does not define a semver policy, release process, or package-distribution strategy.

This ADR does not require Thinktank to defend against malicious users or adversarial model behavior in v1.0.

**Session resume is a v1.0 non-goal.** Rooms in v1.0 are single-sitting: closing the terminal or losing the process ends the room, and there is no `/thinktank resume` command. Lab sessions persist (each agent's private memory survives), but the shared room transcript is not re-instantiable from disk. Adding resume requires either re-hydrating each Lab Agent's runtime session from its on-disk lab session directory at room startup, or replaying the JSONL transcript with correctness guarantees we do not have today. Both are real architectural work, and v1.0 ships honestly without them by documenting rooms as single-sitting. A later ADR can revisit this once a clear resume contract is needed.

## Reversal cost

Calling the extension public ready too early would be expensive to reverse because users would anchor on that claim and failures would damage trust. The three-state model keeps the project honest while preserving a path for early feedback.

If this ADR is accepted and later needs to be reversed, the reversal should take the form of a new ADR that names the new threat model and explains why the current gates are too strict or too weak.
