# ADR 0004: Ephemeral lab memory by default

## Status

Accepted

## Date

2026-05-27

## Context

Lab sessions were created with `SessionManager.continueRecent(cwd, sessionDir)`,
which resumes each Lab Agent's most recent on-disk session for the working
directory. The effect: on every new Pi run, agents silently reload private
context — conclusions, framing, assumptions — from prior prompts, possibly days
old, none of which is visible in the current room transcript.

This was flagged as a footgun in ADR 0001 and the improvement plan (Phase 6): a
fresh-looking room can be primed by invisible history, so agents act on context
the human cannot see or audit. In practice that is surprising and erodes trust in
the room far more than it helps.

## Decision

Lab agent private memory is **ephemeral by default**. Each lab session is created
fresh per Pi run via `SessionManager.create(cwd, sessionDir)`; no prior on-disk
session is auto-resumed.

Within a single run the agents still share context across turns (the room is one
sitting, and `rebuildAgents` only runs on construction / roster change). That
context is dropped when the run ends.

A `labMemory` room option controls the policy:

- **`"ephemeral"` (default):** fresh session each run; no cross-run resume.
- **`"persistent"`:** resume the most recent session per cwd (the old
  `continueRecent` behavior), carrying memory across runs. Opt-in only.

### Mechanism

- `ThinktankCreateLabSessionOptions` gains `resumeRecentSession?: boolean`.
- The adapter chooses `SessionManager.continueRecent(...)` when
  `resumeRecentSession` is true, else `SessionManager.create(...)`.
- The room passes `resumeRecentSession: labMemory === "persistent"`.

## Consequences

- A new room starts from a clean slate: no invisible primed context, so the
  visible transcript reflects what the agents actually know.
- The room transcript (`transcript.jsonl`) still persists on disk; this change is
  only about whether private lab sessions auto-resume.
- Fresh sessions are still written to disk (inspectable, crash-recoverable); they
  are simply never auto-loaded. New session files accumulate per run under
  `labs/agent-<agent-id>/`; periodic cleanup can be added later.
- Anyone who wants cross-run continuity can opt in with `labMemory: "persistent"`.

## Cross-session behavior

Ephemeral memory also defines how separate pi sessions (same or different working
directory, concurrent or sequential) interact:

- **Conversational context is never shared** between sessions in the default mode:
  each room creates fresh lab sessions and no session reads another's discussion.
- **Global config is shared.** `~/.ai-thinktank/settings.json` (roster + enabled
  flag) is read/written by all pi sessions regardless of cwd. This is intended
  configuration, not context — toggling or roster edits in one session affect the
  others on their next read.
- **The per-cwd transcript is shared but write-only.** `transcript.jsonl` is keyed
  by working directory and append-only; rooms in the same cwd interleave events
  into it, but it is never read back into a room, so it does not cross-contaminate
  context. Different cwds use different files.
- **`persistent` is the only context-sharing mode.** It resumes the most recent
  lab session for a cwd, which may belong to another session — the reason it is
  opt-in.

## Non-goals

- An in-app `/thinktank memory` command and an `artifact-only` mode remain future
  work (improvement plan Phase 6).
- Automatic pruning of accumulated per-run lab session files.
