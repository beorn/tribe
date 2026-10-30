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

### Read an immutable index

`recall --snapshot /path/to/index.db search --raw --json -i m --since all -- "query"`
uses the existing indexed search against exactly that file. The leading selector
opens SQLite with `mode=ro&immutable=1`: it never initializes, migrates, refreshes,
or writes the index. Prepare a checkpointed copy first; an existing `-wal` or `-journal` sibling
or a schema version different from this Recall build is an error naming the file.
Provenance is `snapshot`, with the canonical path and stored `last_rebuild` (null
when missing), without a freshness judgment against the clock. Valid empty searches
return `results: []`, `total: 0`, exit 0; query rejection still reports degradation.

This selector supports raw or implied-raw indexed search only. Other commands,
regex, agent/synthesis mode and a simultaneous `--vault-db` are unavailable;
human output does not enrich results from the current live transcript.
`--since all` removes the lower time bound; omission retains the 30-day default,
and invalid window text remains an error. A stable snapshot does not establish
an evaluation's qrels or as-of correctness.

`--until <instant>` adds an inclusive upper bound inside indexed search, before
counting, ranking and either mode's candidate limit. Both bounds use the same
parser: `Nh`, `Nd`, `Nw`, `today`, `yesterday`, or an absolute
`YYYY-MM-DDTHH:mm:ss[.SSS]Z` / `YYYY-MM-DDTHH:mm:ss[.SSS]+HH:mm` instant.
Absolute instants require a zone and at most three fractional digits; missing
zones, finer precision, invalid calendar dates and reversed bounds are errors
naming the requested bound. `all` is only a lower bound. Library `untilTime`
values must be integer milliseconds, including signed values before 1970.

The CLI supports this bound for raw/implied-raw indexed JSON searches (and raw
snapshot output). Regex, agent/debug-plan, synthesis, bound-vault searches and
ordinary human message output with live-transcript enrichment refuse it by
name. Direct `recall()` calls must request raw indexed phases, exclude the live
session and leave the vault unbound. Numeric fanout bounds apply to message
and content candidates; the planner does not generate an upper bound.
The existing four-times raw window, copy collapse, rank and annotations are
unchanged. UUID representatives remain global: their selection subquery does
not apply the caller's time window. An upper bound does not guarantee a full
distinct page under eligible-copy pressure.

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

Recall search is FTS-backed; qmd is pinned at `2.8.3` only for the transcript
export/index workflow. Its `better-sqlite3` 13 dependency ships native binaries
for the supported platforms. The package root trusts only the first-party
`tribe-recall` workspace package, excluding Bun's default trusted list: running
the SQLite build during a clean install requires an unavailable `node-gyp`.
The hh checkout exposes that exact qmd package through `tools/installed/qmd`;
it never falls back to an unmanaged global qmd cache.

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

### Query stopwords, all-stopword fallback, and context exclusions

`toFts5Query`, vault FTS (`vaultTerms`), and raw-probe token extraction share one 95-word query stopword set (`QUERY_STOPWORDS` / `isStopword` in `src/history/recall-shared.ts`).

- **Positive bare tokens**: `toFts5Query` strips stopwords in `QUERY_STOPWORDS` from unquoted positive tokens while keeping `"quoted phrases"`, `-term` (`NOT "term"`), and punctuation-only tokens (`""`), joining the remaining parts by space (implicit FTS5 `AND`). Code verbs and domain terms (`make`, `new`, `user`, `set`, `get`, `run`, `use`, `try`, `see`, `need`, `want`, `work`, `first`, `last`) are not in `QUERY_STOPWORDS` and remain searchable.
- **All-stopword fallback vs. vault `none`**: When stopword filtering leaves no positive content term and no quoted phrase (for example `"what is this?"` or `"what -bad"`), `toFts5Query` falls back to the literal query as written (`rawParts.join(" ")`), so message/content FTS and vault `as-written` queries run the literal query. By contrast, natural-language vault search (`searchVault` when the input does not contain explicit FTS syntax) strips `QUERY_STOPWORDS` via `vaultTerms` and reports `vaultQuery.form: "none"` with `terms: []` when no content terms remain.
- **Planner rare-vocabulary exclusions (`CONTEXT_STOPWORDS`)**: Query-planner rare-vocabulary extraction (`src/lib/context.ts`) combines `QUERY_STOPWORDS` (95 words) with a 55-word conversational/verb delta (`CONTEXT_STOPWORDS`, 150 words total — 38 more entries than the legacy 112-word list, including 20 words of length >= 3: `after`, `again`, `before`, `being`, `between`, `during`, `kind`, `name`, `other`, `perhaps`, `really`, `still`, `such`, `things`, `well`, `while`, `whom`, `whose`, `your`, `yours`).
- **Message rank tie-break**: Exact (`ftsSearchWithSnippet`) and hook (`hookMessageSearch`) message searches order by `ORDER BY rank, m.id ASC` so equal BM25 scores break ties deterministically by ascending message ID.

### Live index freshness — `RECALL_STALE_THRESHOLD`

The session hooks never write the index: run `recall index --incremental` outside them, for example on a schedule, so the index has one writer. An index older than the threshold reads as stale. Search itself is read-only: `bun recall <query>` checks the index age, reports degraded provenance when it is stale or unavailable, and never starts index work.

- Default threshold: **cadence plus run time** (75m at the hourly `recall-index` timer: 1h + 10m timeout + 5m slack). Hab's timer cadence is locked to `RECALL_INDEX_CADENCE` by `tools/hab-live-config.test.ts` (fragments cannot import this module). Slower or delayed rebuilds still report stale provenance.
- Override: `RECALL_STALE_THRESHOLD=10m` (or `1h`, `30s`, `500ms`, bare number = minutes).
- Legacy compatibility: `bun recall "query" --no-refresh` skips live-index freshness classification, reports `unknown` provenance, and exits 3. With `--snapshot`, provenance remains `snapshot` even with `--no-refresh`.

Every search result envelope includes top-level `provenance`: live-index searches report `complete`, `stale`, `missing`, or `unknown`; immutable snapshot searches report `snapshot`. Positive stale hits remain available but the command exits 3. A degraded empty JSON response uses `results: null` and `total: null`; human output labels the count `UNPROVEN`. A `complete` or `snapshot` empty response uses `results: []`, `total: 0`, and exit 0. Snapshot absence is scoped only to the selected file.

For the live index, the same threshold is the ONE freshness verdict: `recall status`'s `isStale` and `recall search`'s `provenance` are
both derived from it, by one judge over `index_meta.last_rebuild` (@ag/recall/27930) — they cannot disagree about one
index. A stale answer names the root and the window it judged: `provenanceDetail` on a search result, and
`indexHealth.freshness` on `recall status --json`
(`{ root, lastRebuild, ageMs, windowMs, windowSource, provenance }`).

## When to use

- Before debugging — check if prior sessions already diagnosed the problem
- Recovering file content from past sessions
- Finding what was discussed or decided about a topic
- Checking session activity and index health

## License

MIT
