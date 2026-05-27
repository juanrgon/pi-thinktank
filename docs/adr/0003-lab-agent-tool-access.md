# ADR 0003: Lab agent tool access

## Status

Accepted

## Date

2026-05-27

## Context

Lab sessions were created with a hard-coded allowlist of seven built-in tools —
`read, bash, edit, write, grep, find, ls` — and no `customTools`. The Pi SDK
treats a provided `tools` list as a strict allowlist, so every extension/custom
tool (e.g. `pi-web-access`'s `web_search`, `code_search`, `fetch_content`) and any
MCP tool was filtered out. Lab agents could not research the web or use any
capability the human's own Pi session had, which limited their usefulness for
real coding and analysis tasks.

Empirically, a lab-style session *does* register extension tools without a
`sessionStartEvent` (verified against the installed SDK), so the only thing
blocking them was the allowlist.

## Decision

Lift the built-in-only restriction. By default, lab agents get the built-in
coding tools **plus** all registered extension/custom/MCP tools, with one
deliberate exclusion: the **interactive desktop-control tools**.

### Default policy

Active tools for each lab agent =
`(all registered tools) − (interactive desktop-control tools)`.

The excluded interactive tools are:
`screen_capture, mouse_position, mouse_move, mouse_click, mouse_double_click,
mouse_right_click, type_text, press_keys, wait, frontmost_app`.

Rationale: those drive the **human participant's physical machine** (mouse,
keyboard, screen). Letting three autonomous in-room agents wield them is the
"tool at the wrong time" hazard called out in ADR 0001's threat model, with no
upside for in-room deliberation. Research/coding tools (`web_search`,
`code_search`, `fetch_content`, `execute_typescript`, etc.) are included.

### Configurability

A `labTools` room option controls the policy:

- **omitted (default):** all tools minus the interactive desktop-control list.
- **`"all"`:** every registered tool, including desktop control (full parity
  with the human's session).
- **`string[]`:** an explicit allowlist — exactly those tool names (this can
  reproduce the old built-ins-only behavior, or any custom subset).

### Mechanism

- `ThinktankCreateLabSessionOptions` gains optional `tools?` and `excludeTools?`.
- When `tools` is provided, the SDK allowlist restricts and activates exactly
  those (unchanged behavior).
- When `tools` is omitted, the session is created with **no** allowlist (all
  built-in + extension/MCP tools registered), then the adapter activates
  `getAllTools()` minus `excludeTools` via `setActiveToolsByName(...)`. This is
  required because, without an allowlist, the SDK leaves `grep`/`find`/`ls`
  inactive by default.

## Consequences

- Lab agents can now research (web/code search, page fetch) and use any
  installed extension/MCP tool, matching the human's toolset minus desktop control.
- The room prompt is larger (more tool definitions) and per-turn token cost rises
  with the number of installed tools.
- **Write safety is still prompt-only** (ADR 0001's runtime write-governance gate
  remains unmet). Lifting tools widens what a misbehaving agent can do; the
  `READ_WRITE_TOOL_WARNING` etiquette is unchanged. Operators who want a tighter
  blast radius can set an explicit `labTools` allowlist.
- Some extension tools have interactive side effects (e.g. `web_search` may open
  a browser curator UI by default). Agents can opt out per-call, but this is not
  enforced by the room.

## Non-goals

- Per-tool runtime governance or approval (deferred; see ADR 0001 / improvement plan).
- Distinguishing read-only vs mutating extension tools — the desktop exclusion is
  an enumerated denylist, not a capability classifier.
