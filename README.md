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

Use the roster to select the OpenAI, Google, and Anthropic models you want in the room:

```text
/roster
```

If the roster shows no available models, run `/login` first to configure your provider credentials.

Turn on the Thinktank:

```text
/thinktank on
```

Type a prompt. The models will take turns discussing the prompt, with tool use visible in the shared transcript.

## Memory and persistence

The room transcript is saved to `~/.ai-thinktank/room-sessions/<sanitized-cwd>/transcript.jsonl` and persists across Pi runs.

Each lab agent also keeps a **private session** under the same directory (`labs/<lab-id>/`), and **resumes its most recent session on every new Pi run in the same working directory**. This means agents may carry forward context, conclusions, and assumptions from prior prompts — even ones from days ago — without that history being visible in the current room transcript.

To reset agents to a clean state, remove the persisted directory for your project:

```bash
rm -rf ~/.ai-thinktank/room-sessions/<sanitized-cwd>/
```

The sanitized cwd is your project path with `/` replaced by `-`. List `~/.ai-thinktank/room-sessions/` to find yours.

An in-app `/thinktank memory` command (with `ephemeral`, `persistent`, and `artifact-only` modes) is planned. See [`docs/thinktank-improvement-plan.md`](docs/thinktank-improvement-plan.md) Phase 6 for the full design.
