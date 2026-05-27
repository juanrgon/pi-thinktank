# Context Glossary

This glossary defines domain terms for the Thinktank extension. It intentionally avoids implementation details and release plans.

## Lab Agent

A model-backed participant in a Thinktank room. A Lab Agent has a lab identity, a configured model, and a visible name in the room transcript. A Lab Agent retains a private memory across rooms (its lab session) that persists even when the room itself ends.

## Lab session

The private, persistent per-agent context owned by a Lab Agent. Lab sessions live on disk separately from any single room transcript and are the mechanism by which a Lab Agent remembers prior conversations with the human participant. Resetting a lab session is distinct from ending a room.

## Thinktank room

A shared multi-agent conversation hosted inside a Pi session. The room lets the human participant and enabled Lab Agents coordinate through a public transcript.

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
