# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
