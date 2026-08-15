# tribe-recall

Session history search for Claude Code. FTS5-indexed search across past sessions with LLM synthesis and file recovery.

Ships with the tribe repository (`packages/recall`); the daemon lazy-loads it
for the memory verbs (`tribe.ask`, `tribe.brief`, delta injection) and the
`tribe hook` handlers index sessions through it. LLM-backed features (synthesis,
planner, summaries) need `TRIBE_LLM_DIR` pointed at an external backend (see the
repo README); FTS search and file recovery work without one.

## CLI

```bash
bun packages/recall/src/cli.ts "query terms"
```

The `bun tools/recall.ts …` spellings below are the bearly-era host alias for
the same CLI; substitute `packages/recall/src/cli.ts` when running from this
repository.

## Modes

By default, `recall` returns a **synthesized narrative** — the LLM digests raw FTS5 hits into a coherent summary that points to the original sessions. This is the "pointer mode" surface area: users see _what_ was found and _where_ to read more, not raw conversation snippets that could carry decoded prompt-injection or stuck-loop noise.

The legacy snippet mode (raw FTS5 hits with surrounding text) is opt-in via `--raw` (alias `--snippets`). Power-user flags (`--question`, `--response`, `--tool`, `--session`, `--include`, `--grep`) also imply raw mode.

## Commands

```bash
# Search with LLM synthesis (default — pointer mode)
bun tools/recall.ts "query terms"

# Raw FTS5 results (legacy snippet mode)
bun tools/recall.ts "query" --raw
bun tools/recall.ts "query" --snippets    # alias

# Build/rebuild FTS5 index
bun tools/recall.ts index [--incremental]

# Skip the auto-refresh-before-search subprocess (for batch / scripted use)
bun tools/recall.ts "query" --no-refresh

# Dashboard: activity + stats + index health
bun tools/recall.ts status

# List sessions or show details
bun tools/recall.ts sessions [id]

# List/search file writes
bun tools/recall.ts files [pattern]

# Recover file content
bun tools/recall.ts files --restore <file>

# Daily/weekly summaries
bun tools/recall.ts summarize
bun tools/recall.ts weekly

# Export quality-gated transcript markdown for qmd
bun tools/recall.ts export --all
bun tools/recall.ts export --catchup --hook
```

## qmd runtime and native ABI repair

Recall search is FTS-backed; qmd is pinned at `2.5.3` only for the transcript
export/index workflow. The package root trusts `better-sqlite3` so Bun installs
the native addon that qmd's Node launcher will load. The hh checkout exposes
that exact package through `tools/installed/qmd`; it never falls back to an
unmanaged global qmd cache.

The 2026-08-01 failure was a mixed-runtime install: the native addon had Bun's
embedded Node ABI while the qmd launcher used system Node. Repair the repo-owned
installation with one install/runtime pair, then verify the actual search seam:

```bash
bun install --force
qmd doctor
qmd search "<known term>"
```

After a Node or qmd upgrade, compare `process.versions.modules` in Node and Bun
instead of hard-coding an ABI number, rerun the install, and require the native
load plus isolated `qmd search` tests to pass. Do not repair this by installing
qmd globally: that recreates the cache/runtime ambiguity that caused the
incident.

## How it works

1. Claude Code session transcripts are indexed into a SQLite FTS5 database
2. Searches match against messages, tool calls, and file contents
3. LLM synthesis (optional) summarizes results into a coherent narrative
4. File recovery extracts written file contents from past sessions

### Freshness — `RECALL_STALE_THRESHOLD`

The FTS5 index is rebuilt by the SessionStart hook on session entry, but during long sessions fresh transcripts (the user's last few minutes of work + any sibling `-wtN/` sessions) drop out of search results until the next rebuild. To avoid silently-empty results, `bun recall <query>` checks the index age **before** searching and auto-runs `bun recall index --incremental` if it is stale.

- Default threshold: **5m** (matches Anthropic's prompt-cache TTL).
- Override: `RECALL_STALE_THRESHOLD=10m` (or `1h`, `30s`, `500ms`, bare number = minutes).
- Opt out per-call: `bun recall "query" --no-refresh` (skips the subprocess).

On auto-refresh the search prints a one-line note to stderr: `[recall] index was Nm stale — refreshed (Xms) before search`. On refresh failure it warns and proceeds with the possibly-stale index (never breaks the search).

The same threshold gates the SessionStart hook's background index rebuild — one knob covers both paths.

## When to use

- Before debugging — check if prior sessions already diagnosed the problem
- Recovering file content from past sessions
- Finding what was discussed or decided about a topic
- Checking session activity and index health

## License

MIT
