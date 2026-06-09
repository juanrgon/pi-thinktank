# Context Glossary

This glossary defines domain terms for the Thinktank extension. It intentionally avoids implementation details and release plans.

## Lab Agent

A model-backed participant in a Thinktank room. A Lab Agent has a stable agent identity, a configured Pi model, and a visible name in the room transcript. A roster may contain any number of Lab Agents, including several backed by the same provider/model. A Lab Agent retains private context during its lab session even when the room itself becomes idle.

## Lab session

The private per-agent context owned by a Lab Agent for a working directory. Lab sessions live on disk under the room-session directory and are keyed by stable agent identity rather than provider/model. By default a Lab Agent starts a **fresh** lab session each Pi run (ephemeral memory) and does not auto-resume prior sessions; an opt-in persistent mode resumes the most recent session so memory carries across runs. Resetting or not resuming a lab session is distinct from ending a room.

## Thinktank room

A shared multi-agent conversation hosted inside a Pi session. The room lets the human participant and enabled Lab Agents coordinate through an auditable transcript.

## Leader-led room

The default room shape after the human explicitly selects one trusted Lab Agent as leader. The leader works on the request, consults advisors through hub-and-spoke exchanges, and owns the final user-facing answer. Intermediate work is collapsed in the normal UI but remains auditable.

## Leader

The human-selected Lab Agent trusted to supervise a leader-led room and produce its final answer. Leader authority controls routing and presentation; it never bypasses configured tool or mutation policy.

## Advisor

A Lab Agent consulted by the leader for focused evidence, critique, or research. Advisors are read-only by default, always return the floor to the leader, and cannot finalize or redirect a leader-led room.

## Debate room

The opt-in freeform room shape in which Lab Agents route the floor through standing CONTROL trailers without a designated leader.

## Internal alpha

A release state intended for Juan's own use and development feedback. Internal alpha may rely on local knowledge, manual debugging, and known rough edges.

## Public preview

A release state intended for adventurous Pi users who explicitly opt in to experimental behavior. Public preview may include breaking changes and incomplete polish, but it must be honest about its risks and limitations.

## Public ready

A release state suitable for broad recommendation to Pi users without requiring project-specific hand-holding. Public ready implies documented behavior, visible failure modes, default operational guardrails, and runtime enforcement for the most important safety boundaries.

## Room observability

The ability for a human participant to understand what each Lab Agent is doing or why it is absent from the conversation. Room observability covers states such as waiting, refreshing context, composing, speaking, passing, erroring, being suppressed, being interrupted, and room idle.

## Runtime governance

Rules enforced by the extension at runtime rather than by prompt instructions alone. Runtime governance controls what Lab Agents are allowed to do, when elevated capabilities are granted, and how those decisions are recorded.

## Operational guardrails

User-visible limits and controls that prevent surprise resource use or runaway behavior. Operational guardrails include turn limits, wall-clock limits, memory controls, cost-related warnings, and clear stop/reset mechanisms.
