# Thinktank Extension

This Pi extension turns ordinary interactive Pi prompts into a shared room of Lab Agents. The room uses normal Pi's public SDK, model/provider/auth configuration, extension loading, and TUI.

## Installation

Install the extension directly into Pi with one command:

```bash
pi install git:github.com/juanrgon/pi-thinktank
```

## Usage

After installation, reload Pi:

```text
/reload
```

A new installation starts **off** with an empty roster. Use the Thinktank roster to add any models currently available in Pi and mark the model you trust as the leader:

```text
/thinktank roster
```

The roster can contain any number of agents, including multiple agents using the exact same provider/model. The first added model becomes leader; press `L` in the roster to choose a different leader. If the roster shows no available models, run `/login` first to configure your provider credentials.

Turn on the Thinktank:

```text
/thinktank on
```

Type a prompt. In the default **leader-led** mode, the leader works on the request, consults read-only advisors when useful, and produces the final answer. Intermediate conversation is collapsed into compact activity such as `Leader consulting Advisor…`; the complete audit trail remains in `transcript.jsonl`.

Use `/thinktank mode debate` for the original freeform shared-room discussion, or `/thinktank mode leader-led` to switch back. Existing rosters without a selected leader remain in debate mode until you choose one.

## Lab agent tools

In leader-led mode, the leader gets the normal Thinktank tool policy while advisors are read-only by default (`read`, `grep`, `find`, `ls`). In debate mode, each lab agent gets the built-in coding tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) **plus** every installed extension/MCP tool (for example web/code search and page fetch), so agents can research and use the same capabilities you have.

The one exception is the **interactive desktop-control tools** (`screen_capture`, mouse/keyboard, `type_text`, `press_keys`, etc.). These drive your physical machine and are excluded by default so autonomous in-room agents can't take over your desktop.

Note: write safety is still prompt-based — `edit`, `write`, and `bash` are available and gated only by in-room etiquette, not runtime policy. See [`docs/adr/0003-lab-agent-tool-access.md`](docs/adr/0003-lab-agent-tool-access.md) for the full policy and the `labTools` option (`"all"` for full parity including desktop control, or an explicit allowlist to restrict).

## Memory and persistence

The room transcript is saved to `~/.ai-thinktank/room-sessions/<sanitized-cwd>/transcript.jsonl` and persists across Pi runs.

Each lab agent keeps a **private session** under the same directory (`labs/agent-<agent-id>/`). By default this memory is **ephemeral**: every Pi run starts each lab from a clean session, so agents do **not** silently carry forward conclusions or assumptions from prior prompts. Within a single run the agents share context across turns (the room is one sitting); that context is dropped when the run ends.

If you explicitly want agents to resume their most recent prior session for a working directory (carrying memory across runs), construct the room with `labMemory: "persistent"`. This is opt-in because auto-resuming stale private context is a footgun — agents can act on framing you can't see in the current transcript. See [`docs/adr/0004-ephemeral-lab-memory-default.md`](docs/adr/0004-ephemeral-lab-memory-default.md).

To wipe all persisted room state for a project:

```bash
rm -rf ~/.ai-thinktank/room-sessions/<sanitized-cwd>/
```

The sanitized cwd is your project path with `/` replaced by `-`. List `~/.ai-thinktank/room-sessions/` to find yours.

### State shared across pi sessions

Lab agent **conversational context is never shared between pi sessions** in the default (ephemeral) mode: each room starts its agents fresh, and no session reads another session's discussion. A few on-disk artifacts are shared, but none of them feed back into what the models see:

- **Global config** — `~/.ai-thinktank/settings.json` holds the roster and the on/off flag and is shared by *every* pi session regardless of working directory. Changing the roster or toggling `/thinktank on|off` in one session affects the others the next time they read it.
- **Room transcript** — `transcript.jsonl` is keyed by working directory and append-only. Two rooms running in the **same** directory at once will interleave their events into that one log file, but the runtime never reads it back into a room, so it does not leak into either conversation. Different directories never collide.
- **`labMemory: "persistent"`** is the one exception: it resumes the most recent lab session for a working directory, which can belong to another session. That cross-session carryover is exactly why persistent mode is opt-in.
