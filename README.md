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
