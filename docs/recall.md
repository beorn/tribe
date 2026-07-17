# Recall

`tribe-recall` (`packages/recall/`) is FTS5-indexed search over Claude Code
session transcripts, with optional LLM synthesis and file recovery. It ships
with this repository (not published to npm) and has two distinct surfaces:
an **explicit CLI you query**, and an **automatic per-prompt injection hook**
that only fires if you wire it up yourself (see
["Wiring the hooks"](#wiring-the-hooks) — this is the part standalone
adopters most often miss).

## What's indexed

Session transcripts (Claude Code JSONL) are scanned and written into a
SQLite FTS5 database — messages, tool calls, and file contents are all
searchable. `recall index --project-root <path>` additionally indexes
project sources (beads, docs, memory) when a project root is given; without
it, indexing is transcript-only.

## The CLI — explicit, on-demand search

From a clone of this repo:

```bash
bun packages/recall/src/cli.ts "query terms"
```

(Host projects that vendor this repo as a submodule typically alias this to
a bare `recall` command — substitute accordingly. The commands below are the
CLI's own subcommands, read directly from `packages/recall/src/cli.ts`.)

| Command                                                        | What it does                                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall "query"`                                               | Search **with LLM synthesis** — the default. Digests raw FTS5 hits into a narrative that points at the source sessions ("pointer mode" surface area) rather than dumping raw conversation snippets. |
| `recall "query" --raw` (alias `--snippets`)                    | Legacy mode: raw FTS5 hits with surrounding text. `--question`, `--response`, `--tool <name>`, `--session <id>`, `--include <types>`, and `--grep` all imply `--raw`.                               |
| `recall "query" --agent`                                       | LLM query-planner mode: plan → fan out → rerank → synthesize, with `--round2 auto\|wider\|deeper\|off` and `--max-rounds <1\|2>` controlling how far it goes.                                       |
| `recall "query" --no-refresh`                                  | Skip the auto-refresh-before-search subprocess (for batch/scripted use).                                                                                                                            |
| `recall index [--incremental] [--project-root <path>]`         | Build/rebuild the FTS5 index.                                                                                                                                                                       |
| `recall status [--json] [--bench]`                             | Dashboard: activity, stats, index health, hook config. No LLM calls unless `--bench`.                                                                                                               |
| `recall sessions [id] [-p, --project <glob>]`                  | List sessions, or show one session's details.                                                                                                                                                       |
| `recall files [pattern] [--restore <file>] [--date <YYYY-MM>]` | List/search file writes, or recover a file's content from a past session.                                                                                                                           |
| `recall summarize [date] [-p, --project <glob>]`               | Daily summary across sessions (default: all unprocessed days).                                                                                                                                      |
| `recall show [date\|week]`                                     | Show existing summaries.                                                                                                                                                                            |
| `recall weekly [date]`                                         | Weekly summary rolled up from daily summaries.                                                                                                                                                      |
| `recall current-brief [--json]`                                | Compact summary of the _current_ agent session — used by the `/recall` skill embed.                                                                                                                 |

Two hook-only subcommands (`remember`, and the removed `session-start` /
`session-end` / `hook`) are `{ hidden: true }` in the CLI and exist for
Claude Code's hook protocol, not for interactive use — running the removed
ones by hand now fails loud with a redirect to `tribe hook <event>` (see
below).

### Freshness — `RECALL_STALE_THRESHOLD`

The FTS5 index can go stale between rebuilds. Before every search, `recall`
checks the index age and auto-runs `recall index --incremental` if it's
stale, printing `[recall] index was Nm stale — refreshed (Xms) before
search` to stderr. Default threshold: **5 minutes** (matches Anthropic's
prompt-cache TTL). Override with `RECALL_STALE_THRESHOLD=10m` (accepts
`1h`, `30s`, `500ms`, or a bare number = minutes). Opt out per-call with
`--no-refresh`. The same threshold gates the SessionStart hook's own
background rebuild (below), and `RECALL_NO_BG_INDEX=1` disables that
background spawn entirely.

## Automatic injection — hook-driven, not tool-driven

Verified in `packages/recall/src/lib/hooks.ts` and
`packages/daemon/src/lib/hook-dispatch.ts`: results are **not** surfaced by
the model calling a `recall` MCP tool. They arrive as hook-injected context
on `UserPromptSubmit`, wrapped by the injection-envelope library so the
model can't mistake them for typed user input or an instruction.

The event flow, once wired (see below):

1. **`SessionStart`** → `tribe hook session-start` → writes a session
   sentinel file (`~/.claude/bearly-sessions/pid-<claudePid>.json`), makes a
   best-effort 1s-budget registration attempt against a recall/"lore" daemon
   socket, and — if the FTS5 index is stale — spawns a detached
   `recall index --incremental` in the background. Never blocks session
   startup; every step is best-effort and swallows its own errors.
2. **`UserPromptSubmit`** → `tribe hook prompt` → tries a daemon RPC path
   first (`tribe.inject_delta`, short 2.5s budget) for cross-turn dedup
   state; on any daemon error it falls straight through — no daemon
   requirement — to an in-process library call (`hookRecall(prompt)`) that
   does the FTS5 lookup directly. Either way the result becomes
   `additionalContext` on the hook's JSON stdout response, run through
   `injection-envelope`'s `emitHookJson()`.
3. **`SessionEnd`** → `tribe hook session-end` → always spawns a detached
   `recall index --incremental` (a session just produced new transcript
   content). Note: there is a separate, fully-implemented `cmdRemember`
   handler (`recall remember`, a hidden CLI subcommand) whose own docstring
   says it's the `SessionEnd` hook and that it triggers daily-summary
   generation for unprocessed past days — but `packages/daemon/src/lib/hook-dispatch.ts`'s
   `dispatchHook()` only ever calls `cmdSessionEnd` for the `session-end`
   event, never `cmdRemember`. As wired today, `SessionEnd` refreshes the
   index; it does not generate daily summaries. Run `recall summarize` (or
   the hidden `recall remember`) yourself if you want that.
4. **`PreCompact`** → currently a passthrough to the same `prompt` handler.

**A note on the daemon-RPC leg above**: it resolves its socket via
`resolveRecallSocketPath()` (`~/.local/share/lore/lore.sock` by default,
distinct from the main tribe daemon's `tribe.sock`). Whether anything binds
that socket in a given install depends on the daemon build/plugin wiring in
use — if nothing does, this leg simply errors and falls back to the library
path every time, which is functionally fine (same result, no daemon-side
dedup cache) but worth knowing if you're chasing "why is the daemon-inject
path never taken."

### Wiring the hooks

**The Claude Code plugin (`/plugin install tribe@tribe`) does not install
these hooks.** Its `.mcp.json` only registers the `tribe` MCP server; there
is no `hooks.json` in `plugins/claude/`. To get automatic per-prompt
injection, add the hooks to `~/.claude/settings.json` yourself, pointing at
a real clone's `daemon.ts`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "bun /path/to/tribe/packages/daemon/src/daemon.ts hook session-start" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "bun /path/to/tribe/packages/daemon/src/daemon.ts hook prompt" }]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "bun /path/to/tribe/packages/daemon/src/daemon.ts hook session-end" }]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "bun /path/to/tribe/packages/daemon/src/daemon.ts hook pre-compact" }]
      }
    ]
  }
}
```

(`tribe-daemon hook <event>` is a real, dispatched subcommand — see
`daemon.ts`'s `argv[2] === "hook"` branch — it exits immediately after
dispatch and never boots the broker in-process.) There is a fully-built
`planInstall`/`applyInstall` helper in `packages/daemon/src/lib/install.ts`
that generates exactly this JSON (plus a matching `.mcp.json` entry) from a
one-shot plan/apply pair, complete with idempotent re-runs and a `doctor`
diagnostic — but as of this snapshot it isn't wired to any shipped CLI
command (`tribe-wire`/`tribe-daemon` have no `install`/`uninstall`/`doctor`
subcommand that calls it; it's covered only by its own unit tests). Treat
the JSON above as the manual equivalent until that lands on a real command.

## The injection-envelope defense

Every `additionalContext` emission in this pipeline routes through
`tribe-injection-envelope` (`packages/injection-envelope/`) — the single
chokepoint for prompt-injection defense on Claude Code's `UserPromptSubmit`
hook response. This exists because of a real incident (`km-ambot`,
2026-04-21): a session treated hook-injected `<session_memory>` content as
user-typed, fabricated file edits, then confabulated the source when
questioned — root-caused to two parallel hook paths building their own
wrapper, one hardened and one not.

What the envelope does:

- **`wrapInjectedContext()`** — emits an `<injected_context>` wrapper with
  directive attributes (`authority="reference"`, `changes_goal="false"`,
  `tool_trigger="forbidden"`, `trust="untrusted-reference"`), sanitizes every
  item, rewrites imperative-mood content as reported speech (prefixed
  `[historical — prior session context, not a current instruction]`), and
  always appends a trailing `CONTEXT_PROTOCOL_FOOTER` boundary tag.
- **Two emission modes** — `snippet` (full body prose, legacy, larger attack
  surface) and `pointer` (title + path + date + tags + 1-line summary + a
  `retrieve_memory(id)` hint, no body prose — the current default/preferred
  shape, matching recall's own "pointer mode" search default above).
- **`sanitize()`** — strips tag-escape attempts, leading quote markers, code
  fences; collapses whitespace.
- **A closed `RegisteredSource` union** — every emitter must declare itself
  as one of `recall`, `qmd`, `tribe`, `telegram`, `github`, `beads`, `mcp`,
  `system-reminder`. Adding a new source is a compile-time change to
  `src/registry.ts`; `tools/lint-injection-emitters.ts` enforces that no
  `additionalContext` is emitted outside this library.
- **Turn manifest** — `writeTurnManifest`/`readTurnManifest`/
  `clearTurnManifest`, one JSON file per session at
  `$BEARLY_SESSIONS_DIR/turn-manifest-<sessionId>.json` (default
  `~/.claude/bearly-sessions/`). Written as a side effect of
  `wrapInjectedContext()` when a `sessionId` is passed; a `PreToolUse` gate
  can read it later to tell whether a pending write is authorized by typed
  text or driven by injected content — that consuming gate itself
  (`tools/injection-gate.ts`) lives in the _host_ project (km), not in this
  repo.
- **Observability** — every decision emits a `injection:wrap` or
  `injection:skip` event over `loggily`'s `injection:*` namespace. Wire a
  JSONL file with `LOGGILY_FILE=/tmp/observability.log DEBUG='injection:*' claude`
  (or the one-release back-compat alias `INJECTION_DEBUG_LOG=/tmp/injection.log`).

## Config summary

| Env var                                   | Effect                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RECALL_STALE_THRESHOLD`                  | Index-staleness window before auto-refresh (default `5m`).                                                                                                                                               |
| `RECALL_NO_BG_INDEX=1`                    | Disable the background incremental-index spawn on `SessionStart`/`SessionEnd`.                                                                                                                           |
| `TRIBE_NO_DAEMON=1`                       | Skip the daemon-RPC leg of hook injection (and daemon registration) entirely; library path only.                                                                                                         |
| `TRIBE_RECALL_SOCKET` / `TRIBE_RECALL_DB` | Override the recall/"lore" daemon socket / DB path (default under `~/.local/share/lore/`).                                                                                                               |
| `TRIBE_LLM_DIR`                           | Point at an external backend (`lib/types.ts`, `lib/research.ts`, `lib/providers.ts`) to enable synthesis/planner/summaries. Without it those features degrade to their documented no-LLM paths — loudly. |
| `TRIBE_RECALL_ENGINE_DIR`                 | Override where `tribe hook <event>` loads the recall hook engine from (fork/experiment seam; normally unset).                                                                                            |
| `TRIBE_INJECTION_DEBUG_DIR`               | Same idea for the injection-envelope debug recorder.                                                                                                                                                     |
| `LOGGILY_FILE` / `INJECTION_DEBUG_LOG`    | JSONL observability sink for `injection:*` events.                                                                                                                                                       |

## Related: `bg-recall` (not wired up here)

`packages/bg-recall/` (`@bearly/bg-recall` in its own docs) is a documented,
tested, standalone package for **background**, entity-driven recall: a
daemon watches tool calls (`PostToolUse`), extracts entities, runs recall
queries in the background, and pushes high-relevance hints over the tribe
channel — instead of blocking `UserPromptSubmit` on every turn. It's real
code with real tests (`bun vitest run tests/` from the package), but it has
no `bin`, and nothing in `plugins/claude/` or `packages/daemon/` imports or
starts it — it's a library you'd wire up yourself
(`createBgRecallDaemon({...})`), not part of the out-of-the-box hook
pipeline described above.
