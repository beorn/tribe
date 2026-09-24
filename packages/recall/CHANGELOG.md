# Changelog

## Unreleased

### Changed — the vault is bound only explicitly

- `recall --vault-db <path> <command|query…>` binds the km vault database for the whole call and outranks `KM_VAULT_DB`. It is a leading global option, so every command reads the same binding (`recall --vault-db X summarize`, `recall --vault-db X "some query"`, `recall --vault-db X --agent q`). `search` takes no `--vault-db` of its own. The flag refuses with exit 2 (a usage error), naming the fault, when it has no value, has an empty value (a failed `$(…)` substitution), or names a missing file. The tribe daemon's launch line and `tribe hook` lines apply the same rule.
- Recall no longer walks up from the cwd looking for `.km/state.db`. With nothing bound, search prints `vault: not bound (pass --vault-db)` on stderr instead of silently searching no vault.
- Prompt injection (the hook and the tribe daemon's `inject_delta`) says the same once per session: with no vault bound, the session's first injection carries `recall: vault: not bound (pass --vault-db); vault notes were not searched`, framed inside the recall `<injected_context>` envelope (as `<vault-notice>`, `mode="notice"` when there are no snippets) and followed by the protocol footer.

## 0.2.0 (2026-04-27)

### Added — quality gate

- `src/lib/quality-gate.ts` — `analyzeQuality()` + `isAcceptable()` heuristics that reject corrupted session exports (stuck-loop ≥10× contiguous repeats, decayed-LLM short-sentence ratio + low stopword density, single 4/8/16-gram covering >20% of tokens). Adversarial fixtures in `tests/quality-gate.fixtures/` cover all three corruption classes plus a clean-good control.
- `src/lib/purge-corrupted.ts` — one-shot script scanning `~/Bear/Vault/raw/chats/` and reversibly quarantining corrupted docs to `chats-quarantine/` with `.reason` sidecars.

### Changed — `bun recall` defaults

- Pointer mode (LLM-synthesized narrative) is now the default. The legacy `--snippets` alias has been removed (use `--raw` for the raw FTS5 path).
- README updated to reflect the new default.

### Composes with

- `plugins/recall/src/qmd-export.ts` — index-time gate (rejects to `chats-rejected/` before qmd indexes) plus query-time backstop in `cmdHook()` (drops bad qmd hits silently). Cross-session contamination root-fix in `renderSessionMarkdown` (drops fragments whose `sessionId` differs from the file's primary `sessionId`).
- `@bearly/bg-recall` — uses `analyzeQuality` at the daemon's pre-scoring layer.

bead km-tribe.recall-quality-gate

## 0.1.0 (2026-04-17)

Initial extraction into a first-class package. The recall library was
previously spread across `vendor/bearly/tools/recall/` and
`vendor/bearly/tools/lib/history/`. Promoted to `@bearly/recall` at
`plugins/recall/` so `@bearly/lore` (the memory daemon) can depend on
it cleanly — matching the runtime relationship (lore builds on recall).

### Contents

- `src/lib/` — recall-specific: agent (LLM-driven multi-round search),
  plan (query planner), fanout (parallel FTS), context (project
  vocabulary for the planner), session-context (current-session brief),
  trace (agent-mode observability), hooks (UserPromptSubmit /
  SessionStart / SessionEnd), status (dashboard), sessions, files,
  summarize-beads / summarize-daily / summarize-session / summarize,
  search (CLI wrapper), format (render helpers), extract
- `src/history/` — core FTS library: search (BM25 + coverage rerank),
  synthesize (LLM race-of-N + remember), scanner (JSONL parse + hookRecall),
  db / db-schema / db-queries, formatters, indexer, project-sources,
  recall-shared, types
- `src/cli.ts` — the `bun recall` CLI (93 test files in `tests/history/`)
- `src/index.ts` — barrel export for consumers

### Verification

- 93/93 recall tests pass (was at `tests/history/*` before the move)
- 0 new TypeScript errors
- `bun vendor/bearly/tools/recall.ts` shim still works via `main` export

### Notes

- `private: true` at this version — published when the tribe family
  (tribe + lore + recall) is stable for ≥2 weeks.
- Consumed by `@bearly/lore` via workspace resolution (Bun `workspaces`).
- A thin 3-line shim at `vendor/bearly/tools/recall.ts` preserves the
  `~/.claude/settings.json` hook path (`bun vendor/bearly/tools/recall.ts session-start`).
