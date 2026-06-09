# ADR 0005: Dynamic model roster

## Status

Accepted

## Date

2026-06-09

## Context

Thinktank originally modeled the roster as three fixed provider-family slots:
OpenAI, Google, and Anthropic. Each slot could contain at most one model and its
selector filtered Pi's available models through family-specific provider and model
name rules.

That design prevented rooms with other Pi models, more or fewer than three
participants, or multiple participants backed by the same model. It also coupled
speaker-routing identities and private session directories to provider families.

## Decision

Represent the roster as an ordered list of participants instead of a record of
provider-family slots.

- A new installation starts with an empty roster.
- `/thinktank roster` is the only roster command; the standalone `/roster` command
  is removed.
- Any model reported by Pi's available model registry may be added.
- The roster may contain any number of participants, including multiple
  participants using the exact same provider/model.
- Each participant has a stable, unique agent id independent of its model. That id
  is used for routing, failure tracking, and its private session directory.
- Duplicate model instances receive numbered visible names so their transcript
  contributions remain distinguishable.
- Persisted legacy fixed-slot settings are read as dynamic participants, but no
  family-based defaults are synthesized.

## Consequences

Thinktank no longer assumes GPT, Gemini, or Claude participation. The scheduler and
CONTROL trailer validate dynamic active agent ids rather than provider aliases.
Changing a participant's model preserves its identity and private-session path;
adding the same model again creates a separate identity and private session.

Unavailable saved models are omitted when the roster is resolved against Pi's
current model registry. Users must explicitly add at least one participant before
an empty room can run.
