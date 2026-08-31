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

# Legacy compatibility flag: skip freshness classification
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

SessionStart starts a detached incremental index when the index is stale, and SessionEnd starts one after a session produces new transcript content. Search itself is read-only: `bun recall <query>` checks the index age, reports degraded provenance when it is stale or unavailable, and never starts index work.

- Default threshold: **5m** (matches Anthropic's prompt-cache TTL).
- Override: `RECALL_STALE_THRESHOLD=10m` (or `1h`, `30s`, `500ms`, bare number = minutes).
- Legacy compatibility: `bun recall "query" --no-refresh` skips freshness classification, reports `unknown` provenance, and exits 3.

Every search result envelope includes top-level `provenance`: `complete`, `stale`, `missing`, or `unknown`. Positive stale hits remain available but the command exits 3. A degraded empty JSON response uses `results: null` and `total: null`; human output labels the count `UNPROVEN`. Only a `complete` empty response uses `results: []`, `total: 0`, and exit 0.

The same threshold gates search classification and SessionStart's background index rebuild.

## When to use

- Before debugging — check if prior sessions already diagnosed the problem
- Recovering file content from past sessions
- Finding what was discussed or decided about a topic
- Checking session activity and index health

## License

MIT
