# pi-subagent

Delegate tasks to specialized subagents with isolated context windows.

Each subagent runs as a separate `pi` process, so it gets its own context window and
cannot pollute yours. Supports single, parallel, and chained execution.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Run history**: Optionally persist conversations to `~/.pi/subagent-runs/` and search them

## Requirements

- [pi](https://github.com/badlogic/pi-mono) ≥ 0.84
- Linux or macOS. Each subagent is spawned as a POSIX child process and killed via
  signals; **Windows is not supported.**

## Installation

```bash
pi install git:github.com/Carbyne/pi-subagent
```

Then start `pi` and the `subagent` / `search_subagent` tools are available. Pin a
release with `@v0.1.0`, or try it without installing:

```bash
pi -e git:github.com/Carbyne/pi-subagent
```

## Structure

```
<package-root>/
├── README.md
├── LICENSE
├── package.json          # pi manifest + peer deps
└── extensions/pi-subagent/
    ├── index.ts          # The extension (entry point)
    ├── agents.ts         # Agent discovery logic (helper module)
    ├── agents/           # Bundled sample agents (auto-discovered)
    │   ├── scout.md      # Fast recon, returns compressed context
    │   ├── planner.md    # Creates implementation plans
    │   ├── reviewer.md   # Code review
    │   └── worker.md     # General-purpose (full capabilities)
    └── prompts/          # Workflow presets (prompt templates)
        ├── implement.md              # scout → planner → worker
        ├── scout-and-plan.md         # scout → planner (no implementation)
        └── implement-and-review.md   # worker → reviewer → worker
```

The bundled `agents/` are **discovered automatically** from the package directory —
you do **not** need to copy or symlink them into `~/.pi/agent/agents/`. User-level
(`~/.pi/agent/agents/*.md`) and project-level (`.pi/agents/*.md`) agents override a
bundled agent of the same name.

`agents/` is not a pi resource type; the extension finds it itself, so it needs no
manifest entry. The manifest deliberately points `pi.extensions` at `index.ts` rather
than at the directory — otherwise `agents.ts` would be loaded as a second extension.

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and
tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can
instruct the model to read files, run bash commands, etc.

**Default behavior:** only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do
this for repositories you trust.

When running interactively, the tool prompts for confirmation before running
project-local agents. Set `confirmProjectAgents: false` to disable.

Run history written by `saveConversation` lands in `~/.pi/subagent-runs/`. If you
delegate secrets, those transcripts contain them.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents; sequential by default, set `concurrency` to run N at once |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Subagent Environment

Each subagent is a separate `pi --mode json -p --no-session` process. By default it
inherits your full configuration for its working directory — **extensions, skills,
context files (`AGENTS.md`), providers, and environment variables** are all loaded,
just like a normal session. The extension only sets the model, the tools flag, the
appended system prompt, and `cwd`. Two guards are applied automatically:

- **Headless trim:** subagents run with `--no-themes --no-prompt-templates` (no UI in
  `-p` mode, so these are pure startup cost).
- **Recursion guard:** the `subagent` and `search_subagent` tools are excluded from
  subagents (`--exclude-tools`) so a subagent cannot spawn its own subagents — each is
  a full `pi` startup and parallel mode would fan out unboundedly. Set
  `allowNesting: true` to opt in. (Skipped automatically when `tools: []`, since no
  tools are available anyway.)

For a leaner/more predictable leaf agent you can disable inherited resources on demand
via `piArgs`, e.g. `piArgs: ["--no-skills", "--no-extensions", "--no-context-files"]`.
Note that `--tools`/`--no-tools` only gates which tools are *exposed* to the model;
extensions still load (their hooks, providers, and system-prompt contributions run)
unless you pass `--no-extensions`.

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
# model: optional. If omitted, the agent inherits the current session model.
#        Pin one with a provider-qualified id, e.g. anthropic/claude-haiku-4-5
---

System prompt for the agent goes here.
```

`model` is optional: when omitted, the agent runs on the **current session model**
(matching inline-agent behavior). Provide a provider-qualified id to pin a model.

**Locations (low → high precedence):**
- Bundled `agents/*.md` shipped with this extension — always available (the base layer)
- `~/.pi/agent/agents/*.md` — User-level
- `.pi/agents/*.md` — Project-level (only with `agentScope: "project"` or `"both"`)

User agents override bundled agents of the same name; project agents override both
when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | session default | read, grep, find, ls, bash |
| `planner` | Implementation plans | session default | read, grep, find, ls |
| `reviewer` | Code review | session default | read, grep, find, ls, bash |
| `worker` | General-purpose | session default | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at the first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode runs sequentially by default (`concurrency: 1`); raise `concurrency` to run more at once

## Development

Work from a checkout instead of publishing, by pointing pi at the directory:

```bash
pi install /absolute/path/to/pi-subagent     # local checkout, no copying
pi -e ./pi-subagent                          # or try it for one run only
```

`npm run typecheck` requires `npm install` first (dev dependencies are not installed
by `pi install`).

## License

MIT — see [LICENSE](LICENSE).
