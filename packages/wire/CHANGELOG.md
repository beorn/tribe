# tribe-wire

## Unreleased

### Added

- **Register launch-declared notification filters atomically.** MCP adapters
  accept `TRIBE_FILTER_MODE=focus|normal|ambient` and declare it in protocol v7
  registration, so a focus-mode session cannot receive an ambient wake before
  its durable preference is applied. Suppressed rows remain fetchable.

## 0.1.4 — 2026-05-27

### Fixed

- **Disable Claude-only channel notifications in MCP pull mode.** Generic
  ACP/MCP clients such as Hermes reject `notifications/claude/channel`, so
  `TRIBE_DELIVERY=pull` now suppresses both the experimental `claude/channel`
  capability advertisement and the channel notification stream.

## 0.1.3 — 2026-05-27

### Changed

- **Use `tribe-wire` as the executable name.** Package runners can now use
  the direct form `bunx tribe-wire mcp ...` / `npx -y tribe-wire mcp ...`
  because the npm package name and binary name match. This replaces the
  previous `tribe` binary alias from 0.1.2.

## 0.1.2 — 2026-05-27

### Fixed

- **Correct npm-published `tribe` binary metadata after the broken 0.1.1
  publish.** 0.1.1 was published with `npm publish`, which ignored
  `publishConfig` and left the registry metadata pointing at `src/cli.ts`.
  0.1.2 republishes with `pnpm publish` so package runners install the
  built `dist/cli.mjs` binary and dist subpath exports.
- **Fail fast on the wrong publisher.** `prepublishOnly` now rejects non-pnpm
  publish attempts with an explicit explanation and verification commands.

## 0.1.1 — 2026-05-27

### Fixed

- **Suppress stdio-adapter console logs by default** so `tribe-wire mcp` emits only
  JSON-RPC messages on stdout. This keeps MCP clients from losing the server
  during startup when the adapter logs connection or hot-reload status.

### Added

- **README documenting the npm-consumer protocol surface** + the surface delineation
  vs `vendor/tribe/tools/tribe-cli.ts` (the bearly-monorepo dev surface). Phase A.2
  rounded out at 12 verbs — daemon-lifecycle / install / hooks intentionally stay
  in the source-tree dev tooling per chief verdict 2026-05-26 (`Q3 approved`).
  See `@km/bearly/19231-tribe-cli-unify-phase-a2-verbs` for the rationale.

### Fixed

- **`src/cli.ts` top-level `await` needed an explicit `export {}` marker** to make
  TypeScript treat the file as a module. Cleared the `TS1375: 'await' expressions
are only allowed at the top level of a file when that file is a module` red.
- **`tests/cli.test.ts` updated for Commander dispatcher semantics** — earlier
  assertions were written for Phase A.MVP's hand-rolled help/usage surface; round 1
  swapped the dispatcher to `@silvery/commander`. Test now strips ANSI before
  matching word-boundary regex, accepts Commander's exit-1-on-missing-command, and
  reads the no-args help text from stderr (not stdout).

## 0.4.1 — 2026-05-25

### Fixed

- **`src/cli.ts` mode bit (chmod 755) — fixes recurring km CI format-check failures.**
  `bun install` chmod's bin sources to 755 on every install (correct npm
  behavior). When the source was committed at 644 in 0.4.0, every install
  produced a one-line mode-only diff that dirtied the bearly submodule in
  km's working tree → km format-check assert-clean-tree gate tripped on
  every PR. Now committed at 755 so install is a no-op. See
  `@km/bearly/tribe-client-cli-source-mode-bit`.
- Sibling fix in `@bearly/llm` (`plugins/llm/src/cli.ts` had the same
  shape) — both bin sources now ship at 755.

## 0.4.0 — 2026-05-25

### Known issue (fixed in 0.4.1)

- `src/cli.ts` was committed at mode 644. `bun install` chmod-fixed it
  on every install, producing a mode-only diff that dirtied the bearly
  submodule in km's working tree. Affects all installs against the 0.4.0
  tag. Workaround for anyone pinning 0.4.0: `chmod +x
node_modules/tribe-wire/dist/cli.mjs` post-install. Upgrade
  to 0.4.1 to fix.

### Added

- **`tribe-wire` CLI binary (Phase A.MVP of `@km/bearly/tribe-cli-unify-phase-a-substrate`).**
  The package now ships a `tribe-wire` bin entry (`./src/cli.ts` in local dev,
  `./dist/cli.mjs` post-publish). Subcommand dispatcher with `tribe-wire mcp`
  as the only subcommand in this release — runs the stdio MCP adapter
  with the same flag surface (`--name`, `--role`, `--socket`, `--account`,
  `--provider`, `--domains`) as the underlying `stdio-adapter.ts`. The
  `mcp` subcommand exists to be invocable as `tribe-wire mcp` from the bin
  entry rather than `bun packages/wire/src/stdio-adapter.ts`.
- **`tribe-wire/cli` subpath export.** Importing the cli module
  directly is supported for embedding scenarios; the bin entry is the
  primary surface.

### Not yet (deferred to Phase A.2)

- Verb subcommands (`status`, `sessions`, `send`, `log`, `retro`,
  `install`, `uninstall`, `doctor`, `lifecycle`, `hook`, …) — these
  remain in `vendor/tribe/tools/tribe-cli.ts` for now. The verb
  migration adds ~6 transitive deps from `tools/lib/tribe/`
  (`retro.ts`, `install.ts`, `hook-dispatch.ts`, `activity-watch.ts`,
  `autostart-config.ts`, `hooks/index.ts`); some are daemon-internal
  (retro reads DB directly). The scope-split was chief-approved per the
  "rename first, split later" refactor lesson — `tribe-wire mcp` ships first
  to unblock downstream consumers (`@bearly/tribe` plugin, daemon
  hardening, notification renderer), verb migration follows.

## 0.3.0 — 2026-05-25

### Added

- **`tribe-wire/stdio` subpath export.** The stdio MCP adapter
  (formerly `tools/stdio-adapter.ts`) now lives at
  `packages/wire/src/stdio-adapter.ts`. Importing the subpath runs
  the adapter's module-level bootstrap — used by `@bearly/tribe`'s
  `server.ts` so the plugin no longer ships a committed bundle.
- **`tribe-wire/lib/socket`** — tribe-flavored facade over the
  core IPC primitives. Exports `TRIBE_PROTOCOL_VERSION`, `probeDaemonPid`,
  and a `createReconnectingClient` wrapper with a default `daemonScript`
  resolver (env-var-overridable via `TRIBE_DAEMON_SCRIPT`).
- **`tribe-wire/lib/config`** — tribe arg parser + session-id /
  project-name / DB-path resolvers (moved from `tools/lib/tribe/config.ts`).
- **`tribe-wire/lib/tools-list`** — canonical MCP tools list
  (moved from `tools/lib/tribe/tools-list.ts`); the daemon now imports it
  from here as the single source of truth.
- **`tribe-wire/lib/cwd-guardrail`** — cwd policy probe and
  evaluator (moved from `tools/lib/tribe/cwd-guardrail.ts`).
- **`tribe-wire/lib/hot-reload`** — file-watch + re-exec helper
  (moved from `tools/lib/tribe/hot-reload.ts`).
- **`tribe-wire/lib/transcript`** — pure readers for
  `resolveTranscriptPath` and `readTranscriptSlug`, extracted from
  `tools/lib/tribe/session.ts` (the rest of session.ts stays in `tools/`
  because it is TribeContext-coupled).
- **`tribe-wire/lib/defang`** — vendored copy of
  `defangModelInput` from `@bearly/injection-envelope`, so the published
  tribe-client has zero plugin-cross dependencies.

### Changed

- **Package flipped public** (`"private": false`) — first publish.
- Added `@modelcontextprotocol/sdk` as a runtime dependency.

### Migration

External consumers of `tools/lib/tribe/{socket,config,tools-list,cwd-guardrail,hot-reload}.ts`
should import from `tribe-wire/lib/<x>` instead. In bearly's own
tree, that migration is already complete — `tools/tribe-daemon.ts`,
`tools/tribe-cli.ts`, `tools/bg-recall.ts`, the daemon's `tools/lib/tribe/compose/*`,
and the integration tests now all source the shared lib from
`tribe-wire/lib/<x>`. No re-export shims in the legacy paths —
they were deleted, not aliased (per `docs/lessons/refactoring.md` Case
Study 7).

## 0.2.0 — 2026-04-27

### Breaking

- **Renamed from `@bearly/daemon-spine` → `tribe-wire`.** Directory
  also renamed from `packages/daemon-spine/` → `packages/wire/`.
  Closes the "(rename pending)" annotation tracked in `hub/architecture.md`
  under the km-tribe.refactor post-close package-rename wave.

  Migration: replace `@bearly/daemon-spine` with `tribe-wire` in
  every import. Public surface (factory exports, types, log namespaces inside
  the package) is unchanged — only the import path moves.

  Internal log namespaces follow the rename:
  - `daemon-spine:client` → `tribe-client:client`
  - `daemon-spine:parser` → `tribe-client:parser`

  Rationale: the package is conceptually a "tribe client" library — it owns
  the JSON-RPC wire, the line-delimited parser, the daemon client, the
  reconnection policy, and the composition primitives (pipe, Scope, tool
  registry). The `daemon-spine` name predated the tribe vocabulary
  stabilization and confused readers ("spine of what?").

## 0.1.0 — 2026-04-26

Initial release as `@bearly/daemon-spine`. Shared Unix-socket IPC primitives
extracted from `tools/lib/tribe/socket.ts` (and the verbatim copy at
`plugins/claude/lore/lib/socket.ts`):

- JSON-RPC 2.0 wire protocol (types + helpers)
- Line-delimited JSON parser
- `connectToDaemon`, `connectOrStart`, `createReconnectingClient`
- `withDaemonCall` (deadline-bounded call, hook-friendly)
- Socket path discovery (`resolveSocketPath`, `resolvePeerSocketPath`)
- Composition primitives: `pipe`, `Scope` / `createScope`, tool registry
  (`Tool`, `ToolRegistry`, `withTools`, `withTool`)
