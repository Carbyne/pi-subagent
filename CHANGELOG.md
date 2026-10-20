# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

### Added

- **Background subagents** — `background: true` (single + parallel modes) launches the child as a
  long-lived `pi --mode rpc` process: returns an id immediately, notifies on settle (with final
  output), keeps the process warm for follow-ups (`idleTtl`), and survives `/reload`
- **`subagent_control` tool** — `list` | `peek` (last few turns) | `send` (steer / follow-up into a
  running or idle run) | `reply` (answer a subagent question) | `abort` | `kill` | `wait` |
  `remind` (re-arm the peek reminder); plus `/subagents` slash command
- **Subagent → main messaging** — every child loads a companion extension registering
  `ask_main_agent`, which BLOCKS until an answer arrives over a unix-socket mailbox:
  background runs → the question is injected into the main agent's conversation (answer via
  `subagent_control action="reply"`); foreground runs → surfaced to the user through an input
  dialog (the main agent is blocked awaiting the run itself, so the human is the responder)
- **Peek reminders** — `peekAfter` (per-call or `"subagent".peekAfter` setting): after the delay,
  the most recent turns are injected so you can course-correct long-running subagents
- **pi-bg-jobs adoption** — background runs are registered as real bg-jobs over the
  `bg-jobs:adopt` event: visible to `bg_jobs list/output/kill` + the sidebar, and counted by
  `pi-ralph-loop`'s job-awareness (no follow-up fires while subagents work). Graceful internal
  tracking when pi-bg-jobs isn't loaded
- Settings block `"subagent"`: `peekAfter`, `idleTtl`, `askTimeout`, `notifyMode`,
  `maxBackground`, `peekTurns`
- `returnPrompt` is now actually accepted (top-level single mode + inline agent configs) — it was
  documented before but missing from the schemas

### Changed

- **Mode validation is now self-explanatory and forgiving.** Invalid calls return the exact shapes
  for all three modes with examples, and identify the specific mistake (e.g. "you passed `agent`
  without `task` — single mode requires BOTH keys"). A top-level `task` with no `agent` now runs on
  the bundled `worker` agent instead of failing
- Descriptions + tool text now state explicitly that parallel/chain modes run **sequentially**
  unless `concurrency > 1` (previously agents assumed real parallelism)
- Children additionally exclude `subagent_control` in the default recursion guard

## 0.1.0

### Added

- `subagent` tool with three modes: single, parallel (`tasks`), and chain (`chain` with
  `{previous}` substitution)
- Isolated context per subagent — each runs as its own `pi --mode json -p --no-session`
  process
- Inline agent definitions (`systemPrompt` / `tools` / `model`) with no markdown files required
- Bundled sample agents: `scout`, `planner`, `reviewer`, `worker` — auto-discovered from the
  package, overridable by user-level and project-level agents of the same name
- Agent discovery across `builtin` < `user` < `project` scopes via `agentScope`
- `search_subagent` for querying persisted run history in `~/.pi/subagent-runs/`
- Workflow prompt templates: `/implement`, `/scout-and-plan`, `/implement-and-review`
- Live streaming status for parallel mode, collapsed/expanded rendering, and per-agent
  usage tracking (turns, tokens, cache, cost, context)
- Recursion guard excluding `subagent` / `search_subagent` from child agents, with
  `allowNesting` to opt in; headless trim (`--no-themes --no-prompt-templates`)
- `concurrency` control for parallel and chain modes; `returnPrompt` to control what a
  subagent reports back
- Confirmation gate before running project-local agents (`confirmProjectAgents`)
