# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.3

### Added

- **Ctrl+C semantics for subagents.** Foreground runs are now RPC children
  (same machinery as background mode): interrupting the main session (Ctrl+C)
  sends pi's own RPC `abort` to the subagent — its current turn stops
  gracefully instead of being SIGTERM'd mid-stream, and the tool result
  reports `Agent aborted: Interrupted by user (Ctrl+C)` plus any partial
  output. Chain/parallel steps preserve partial output on interruption too.
- **`/subagent-abort [id]`** — user-facing Ctrl+C for background runs
  (interrupts the current turn; the warm process stays alive for follow-ups).
  Model-side equivalent already existed: `subagent_control action="abort"`.

### Fixed

- **Stray peek reminders** — reminders re-fired on their original schedule
  even when nothing was pending: a settled run with no in-flight work and no
  unanswered question was still nagging every `peekAfter`. Reminders are now
  armed only for genuinely-running rounds, cancelled on settle (the settle
  notice is itself the report), re-armed when `send` starts a new round, and
  self-suppress if the run is idle with no pending question. Background runs
  no longer arm an initial reminder at all — they announce themselves.

## 0.3.2

### Changed

- **Parallelism is now operator-controlled, not model-controlled.** The `concurrency`
  parameter is advisory: effective parallelism is `min(requested, controls.maxConcurrency)`
  with a default operator cap of **3** (`OPERATOR_CONCURRENCY_DEFAULT`). A model can request
  fewer, never more, and the cap cannot be raised from a session.
- **Silent downgrades are gone**: when a request is clamped, the tool result leads with
  `NOTE: you requested concurrency=6, but the operator cap … is 3 — ran 3 at a time`
  (same announcement on background launches). Previously agents had to infer the cap from
  observed behaviour.
- Background runs declined by bg-jobs (e.g. its own `maxConcurrent` reached) are reported
  per-run as `not tracked by bg-jobs (<reason> — ralph-loop will not wait on it)` instead
  of a generic 'not loaded' note.

## 0.3.1

### Added

- `controls.foreground: false` — blocks **foreground** subagent execution entirely:
  every call must detach (`background: true` or the `defaultBackground` setting),
  explicit `background:false` and chain mode (inherently foreground) are rejected
  with a guidance error. The inverse of `controls.background: false`, which
  previously was the only run-mode control.

## 0.3.0

### Added

- **Default-background mode** — `"subagent".defaultBackground: true` makes
  subagent calls background unless `background: false` is passed explicitly
  (chain stays foreground). No more remembering the flag.
- **Peek reminders default to 30m** (`peekAfter`, like bg-jobs' check cadence);
  per-call `peekAfter` still overrides.
- **Operator control plane** — `"subagent".controls` restricts what the main
  agent may do: `background/parallel/chain/inlineAgents/nesting/piArgs` toggles,
  `agentScope` cap, `allowedAgents`/`blockedAgents` (globs over named agents),
  `maxConcurrency` clamp, and **model policy**:
  `modelPolicy: { "mode": "free"|"inherit"|"allowlist"|"denylist", "allow": [...], "deny": [...] }`
  — e.g. `"inherit"` forces every child onto the current session model; an
  allowlist always implicitly includes the current model, matches `provider/*`,
  full `provider/id`, or bare-id globs ("qwen*"). Violations are reported before
  spawn, not silently ignored.
- **Broken-model health** — background runs now fail loudly instead of hanging:
  - startup watchdog: no agent activity within `startupTimeout` (default 120s)
    → child killed, `🚨 produced NO agent activity … likely a broken
    model/provider configuration (model: X)` notification
  - pi rejecting the prompt (unknown model etc.) → immediate kill +
    `pi rejected the prompt: …` report
  - a settle whose final assistant message has `stopReason: "error"` → the
    completion notice becomes `⚠️ ended with a MODEL ERROR: … · model: X —
    do not reuse it` instead of a false ✅

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
