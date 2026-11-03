# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.6

### Fixed

- **Foreground subagents showed no live output** — the 0.3.3 foreground→RPC
  rewrite left the streaming pump (`onUpdate`) reading the pre-harvest empty
  `currentResult.messages`, so the tool view sat at "(running...)" until the
  child finished (or you interrupted it). `emitUpdate` now mirrors the live
  RPC child (messages, usage, model, stopReason) on every `message_end`, so
  partial answers and the usage line stream as they happen.

## 0.4.5

### Fixed

- **Windows host crash (`uncaughtException: listen EACCES …parent-<pid>.sock`)
  taking all of pi down.** Three compounding bugs in the mailbox hub:
  1. `net.Server` reports `listen()` failures asynchronously via `'error'`
     events — the existing try/catch could never see them and with no error
     listener the EACCES escaped as an uncaughtException. Server now gets an
     `'error'` listener that marks the hub down and degrades gracefully.
  2. Filesystem-path “unix sockets” (`%TEMP%\…\.sock`) are not valid on
     Windows — the hub now uses a proper named pipe
     (`\\.\pipe\pi-subagent-mail-<pid>`) on win32; the companion skips
     unreliable pipe existence probes there and degrades via connect errors.
  3. `os.userInfo().uid` is `-1` on Windows → junk dir name
     (`pi-subagent-mail--1`); uid resolution is now validated with a
     `shared` fallback.
  Effect: mailbox unavailable ⇒ subagents still run, `ask_main_agent` simply
  isn’t registered — the host never dies. Windows is now best-effort supported
  (README updated); POSIX signal-based killing still degrades to direct kill.

## 0.4.4

### Changed

- **Fork children are now strict parent-parity: tool additions are never
  allowed.** No mailbox credentials reach forks ⇒ the companion registers no
  tools there (it remains loaded purely as the invisible `tool_call` policy
  enforcer). `childExtensions` is rejected for `sessionMode:"fork"` with a
  pointer to `"fresh"` when a child truly needs tools the parent lacks. The
  `childToolAdditions` setting is removed — one rule, no drift surface.
- Fresh children are unchanged: companion `ask_main_agent` questions and
  `childExtensions` (operator-gated) still work — there is no prefix to protect.

## 0.4.3

### Changed — fork tool policy now "parent-parity + runtime guard" (the simple, cache-safe design)

- Fork children keep the parent's **exact tool declarations** (no
  `--exclude-tools`, no `--tools`, no persona append, no auto system-prompt
  drift — the copied parent system entry is used verbatim; thinking level is
  inherited). Zero head divergence ⇒ the parent's cached KV prefix is reused
  from the child's very first request; sibling forks and later rounds share it.
- Restrictions are **runtime checks**: the companion blocks denied tools via
  pi's `tool_call` permission hook (policies: agent defaults
  `{subagent, search_subagent, subagent_control}` unless `allowNesting`, plus
  `"subagent".blockTools` settings and per-call `blockTools`), backed by the
  `PI_SUBAGENT_CHILD` execute-level guard.
- The child is **told** what is disabled: a `[Policy] Disabled for this session…`
  banner is auto-prepended to the first prompt (new tokens ⇒ cache-neutral), so
  the model rarely even attempts a blocked call.
- Children may NOT declare tools the parent lacks (e.g. companion's
  `ask_main_agent`) unless `"subagent".childToolAdditions: true` (default true).
- New settings: `forkToolMode` (`"guard"` default | `"real"` = pi-native
  `setActiveTools` loadout patch, removals cost one recompute per lineage;`cli`
  legacy alias), `forkUseAgentPersona` (default false), `childToolAdditions`
  (default true), `blockTools` (operator-wide globs).

## 0.4.2

### Changed

- **Cache-preserving forks.** Fork children no longer pass `--exclude-tools` —
  measured on the gateway: removals rewrite the request head (`params.tools`
  resolves from the transcript's system fold), so the entire copied history
  billed cold (`cacheRead: 0`). Additions (companion `ask_main_agent`, appended
  system sections) are cache-safe and stay. Fork children now keep the parent's
  EXACT tool declarations; nested delegation is instead blocked by
  1. an appended "Forked session rules" system section (rides after history), and
  2. a runtime guard: `PI_SUBAGENT_CHILD=1` makes the `subagent` tool refuse
     execution in fork children (unless `allowNesting:true` AND the operator's
     `controls.nesting:true`).
  Result: fork child first request now hits the parent's KV prefix
  (`cacheRead` observed ≈ half the prompt tokens vs 0 before).
- Fresh (non-fork) children keep CLI exclusions unchanged — no prefix to protect.

## 0.4.1

### Fixed

- Foreground subagent children ran in the wrong mode (print instead of RPC) due to a
  partially-applied edit batch — single-task foreground calls could hang waiting for
  agent_settled that print mode never emits. Unified on the RPC child.
- Forking a live session copied the parent's in-flight dangling toolCall, making the
  child stall minutes trying to resolve the call that spawned it. Forks now use a
  sanitized raw-line copy (tail truncation only, kept bytes untouched).

## 0.4.0

### Added

- **`sessionMode: "fresh" | "fork"`** — launch a subagent that CONTINUES the current
  conversation instead of starting empty. `fork` passes the parent's live session file to
  the child via pi's `--fork` (the child gets full history as its starting context and
  answers from it — ideal for “review what we just did”, “continue with fresh eyes”,
  delegation-with-context without re-explaining). The forked session file is written to a
  private swept tmp dir (`/tmp/pi-subagent-runs-<uid>/forked-sessions`, entries older than
  24h removed at session start) — it never pollutes your session list. `--fork` forbids
  `--no-session`, so ephemeral parents get a clear error telling them to use `fresh`.
- Setting `"subagent".sessionMode: "fresh" | "fork"` — the default for calls (per-call
  `sessionMode` param overrides). **Default stays `"fresh"`** (today's behavior).
- `controls.sessionModes: ["fresh", "fork"]` — operator allowlist of permitted modes
  (e.g. pin to `["fresh"]` to forbid context inheritance, or `["fork"]` to force
  context-carrying delegation). Requests outside the list are rejected with a clear error.
- Applies to foreground, background, parallel and chain children uniformly.

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
