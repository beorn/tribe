# Daemon lifecycle

`tribe-daemon` (`packages/daemon/`) is the broker: one process per machine
(scoped by socket path), Unix socket server, SQLite state, session registry,
message journal, and daemon plugins. This is the standalone-install view of
its lifecycle — autostart, socket/DB location, election, hot-reload,
stop/restart, and troubleshooting — all read directly from
`packages/daemon/src/daemon.ts` and its `lib/compose/*.ts` factories.

## Autostart

Autostart is **not** something the daemon or a provider-owned MCP bridge does to
itself. It belongs to an explicit lifecycle caller, such as hook dispatch or a
standalone install. The core helper is
`ensureTribeDaemonIfConfigured()` (`packages/daemon/src/lib/autostart.ts`):

1. Resolve the configured mode (`resolveAutostart()` — see
   [install.md](install.md) for the config file). `"library"` or `"never"`
   → no-op, immediately.
2. Probe the socket with a short (50–200ms) connect attempt.
   Already alive → no-op.
3. If dead and mode is `"daemon"`, detach one stable standalone supervisor.
   That owner starts the daemon as its ordinary child and the hook returns
   immediately without waiting for the socket.

The whole operation is budgeted at **300ms** by default and is designed to
never block a Claude Code hook: probe failures and spawn failures are
swallowed with a single log line, and the caller falls through to its own
library-mode fallback for that one turn.

Provider-owned stdio, HTTP, and recall bridges are deliberately
**connect-only**. Their reconnecting clients set `noSpawn: true` on the initial
connection and every reconnect, so a missing singleton fails loudly without
letting an arbitrary agent seat create an orphan daemon. A standalone
hook/install path may detach the repo-local supervisor, never the daemon
itself; a managed deployment such as Hab supplies the stable owner instead.

## Socket location

Resolved by `resolveSocketPath()` (`packages/wire/src/paths.ts`), priority
order:

1. Explicit `--socket <path>` argument
2. `TRIBE_SOCKET` env var
3. `$XDG_RUNTIME_DIR/tribe.sock`
4. `~/.local/share/tribe/tribe.sock` (default when no XDG runtime dir)

The daemon `chmod`s the socket to `0600` right after binding.

### Process environment

The daemon removes caller session identity (`TRIBE_NAME`, role, account,
provider, launch, takeover, and plugin-adapter fields) at its own process
boundary. It accepts an operator-capability fd and standalone lifecycle markers
only when those markers identify its actual parent supervisor. A Hab-managed
service therefore does not need blank environment overrides to avoid inheriting
the identity of whichever seat invoked `hab up`.

### Optional delivery fallbacks

`TRIBE_DELIVERY_FALLBACKS` accepts an ordered JSON array of generic
`{"prefix":"...","to":"..."}` rows. When a direct recipient has no live
transport, the first matching row persists the original mail, routes an
attention-bearing `dead-letter` copy to `to`, and makes that fallback recipient
own the original request id. Concrete rows are composition policy; Tribe never
infers a parent from a name:

```bash
TRIBE_DELIVERY_FALLBACKS='[{"prefix":"@worker/","to":"@manager"}]' tribe-daemon
```

Empty fields, duplicate prefixes, unknown keys, malformed JSON, and a
self-bounce fail loudly at startup/send time.

## SQLite state location

Resolved by `resolveDbPath()` (`packages/wire/src/lib/config.ts`), priority
order:

1. Explicit `--db <path>` argument
2. `TRIBE_DB` env var
3. `$XDG_DATA_HOME/tribe/tribe.db` (or `~/.local/share/tribe/tribe.db`)
4. **Legacy migration**: if step 3's file doesn't exist yet but a
   `.beads/tribe.db` is found by walking up from cwd, it's moved (not
   copied) to the XDG path, including `-wal`/`-shm` sidecars on a
   best-effort basis, and a `<legacy>.moved` breadcrumb file is dropped at
   the old location. This lets a project retire `.beads/` without taking
   tribe's own state down with it. The whole check-and-migrate sequence
   runs under a `flock`-based lock file (`<dbpath>.migration.lock`) so two
   daemons racing to start don't both try to migrate/create at once.

There's a second, separate DB for the recall/"lore" subsystem
(`resolveRecallDbPath()`, defaulting under `~/.local/share/lore/lore.db`,
overridable via `TRIBE_RECALL_DB`) — see [recall.md](recall.md).

## Single-daemon election

Two daemons can legitimately race to bind the same socket (e.g. two hooks
firing at once, both seeing "dead"). The daemon handles this in two stages:

1. **Pre-bind probe** (`probeAndCleanSocket()`): if a socket file already
   exists, retry-probe its liveness (biased toward detecting life — a single
   failed probe against a live daemon under load must not cause a false
   "stale" verdict). If genuinely dead, unlink it and proceed; if alive,
   the caller logs "another daemon is already listening" and exits `0`.
2. **Bind race** (`withSocketServer`): if two processes get past the probe
   simultaneously, only one wins the actual `server.listen()` call; the
   loser's bind fails with `EADDRINUSE`, which resolves its `binding`
   promise to `"occupied"` rather than rejecting. The loser logs "another
   daemon won the bind election," disposes its own scope, and exits `0` —
   critically, it never unlinks the winner's socket, because its
   own-socket-ownership flag (`bound`) was never set.

## Hot-reload

`withHotReload` keeps the replacement mechanism aligned with the daemon's
lifecycle owner:

- **Standalone daemon** — the repo-local supervisor is the durable parent of
  every daemon generation. `tribe.restart` (RPC), `tribe-wire restart` (CLI), and
  `SIGHUP` stop plugins and exit with a private reload code; the same supervisor
  starts the successor with a fresh bind. If a user launched the first
  generation directly, that generation installs the supervisor and asks it to
  wait for the predecessor to exit before starting the replacement. The
  supervisor carries operator capability in memory and reconstructs a fresh
  anonymous pipe for each generation. No daemon self-detaches or inherits a
  seat's identity environment.

- **Hab-supervised workload** — when `HAB_SERVICE_KIND` is present, the same reload
  entry points stop plugins and request clean shutdown. They do **not** mark
  the socket handed off, unlink it early, or spawn a detached successor. Scope
  disposal closes the socket, then Hab's declared restart policy starts the
  replacement inside the same supervisor. The daemon also suppresses its source
  watcher in this mode, so managed deployments do not need to declare a
  `TRIBE_NO_AUTORELOAD` environment override.

- **Source-file watcher** — `fs.watch` on the daemon's own source
  directories, debounced (default 500ms), hashes the watched `.ts` files and
  emits `SIGHUP` to itself on a real change. Skipped in tests
  (`disableWatch`) or with `TRIBE_NO_AUTORELOAD=1`.

## Idle auto-quit

`withIdleQuit` ties liveness to connection count, not a fixed schedule:

- `--quit-timeout <seconds>` (default **1800** = 30 min). `markIdle()` sets
  a deadline that many seconds out whenever the client registry empties;
  `markActive()` (called on any client connect) clears it. A 1s tick
  (`checkLiveness`) evaluates whether the deadline has passed.
  - `-1` disables auto-quit entirely.
  - `0` quits immediately once the registry is empty.
- **Stale pending-session reap**: any connection that never completed a
  `register` call within 60s (`pendingExpiryMs`) is dropped.
- **Socket-path-gone backstop**: if the daemon bound its own socket
  (`inheritFd === null`) and that path has been missing from disk for ≥30s
  (`socketPathGoneTimeoutMs`) while zero clients are connected, the daemon
  self-exits. This is a defensive backstop against an orphaned successor
  process spinning forever after some other process cleaned up its socket
  file out from under it.

Net effect for standalone installs: the daemon costs nothing while idle (it
exits itself, and its standalone supervisor exits with it) and an explicit
autostart-eligible lifecycle path can bring both back. Provider bridges never
assume that ownership. A managed supervisor may instead declare its own
always-on/restart policy.

### Host adapter recovery across daemon generations

Every stdio adapter re-registers after its reconnecting client reaches a new
daemon generation. Hosts with the stable plugin wrapper additionally re-exec
current-disk adapter code with a bounded five-attempt exponential backoff
(250ms through 4s), so rapid restart bursts do not exhaust a one-replacement
budget. Other re-exec reasons retain a one-retry fail-loud path, so a protocol
mismatch does not spend the daemon-restart budget. Hosts that execute
`tribe-wire mcp` directly have no process
supervisor: after their successful re-registration they stay in-process rather
than exiting to request a replacement that cannot be created.

The wrapper also carries the adapter's explicit-join bit across a replacement.
The replacement registers as push only when its predecessor had joined; an
unjoined adapter remains pull-gated. Direct adapters retain the same bit
in-process and recompute registration delivery on every daemon connection.

This distinction explains the mixed recovery observed in 22322. A wrapped
adapter spanning two quick generations used to die on its second re-exec,
while a direct adapter rejoined the daemon and then closed its own MCP
transport. Adapters launched after the first generation saw only one change
and appeared to recover.

## Stop / restart

There is no dedicated `stop` subcommand. In practice:

- **Graceful stop**: send `SIGTERM`/`SIGINT` to the daemon's pid (find it via
  `tribe-wire status`/`health`, both of which print `daemon.pid`) — the
  `withSignals` factory routes both to the same shutdown path as idle-quit.
- **Restart from the current pinned module root**: `tribe-wire restart` (or the
  `tribe.restart` MCP tool) — see Hot-reload above. Restart changes no code;
  standalone daemons replace themselves, while supervised daemons exit cleanly
  and let their supervisor replace them. To change code, materialize and
  activate a different module root first.
- **Force a clean respawn** (e.g. after `tribe-wire doctor` reports stale
  code and a restart isn't trusted): stop the process manually, then let the
  next autostart-eligible connection spawn a fresh one from current disk —
  `doctor --fix`'s printed remedy is exactly this sequence.

## Daemon plugins

`daemon.ts` loads a fixed plugin list unless `TRIBE_NO_PLUGINS` is set:
`gitPlugin`, `githubPlugin`, `healthMonitorPlugin`, `accountlyPlugin`. Each is
self-gating via an `available()` check, so none of them require anything from a
standalone/non-hab install:

| Plugin           | Gate                                           | What it does                                                                                                                                                          |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git`            | `git rev-parse HEAD` succeeds in cwd           | Broadcasts a status message when `git log -1` HEAD advances (30s poll).                                                                                               |
| `github`         | `GITHUB_TOKEN` env or `gh auth token` succeeds | Polls the GitHub API and broadcasts push/workflow_run/pull_request/issues events; configurable via `GITHUB_POLL_INTERVAL`, `GITHUB_EVENTS`, `GITHUB_WORKFLOW_NOTIFY`. |
| `health-monitor` | (always available)                             | Backs `tribe.health()`'s diagnostics.                                                                                                                                 |
| `accountly`      | `~/.config/ag/accounts.json` exists            | Monitors Claude subscription quota usage and warns near thresholds (`AG_THRESHOLD_5HOUR`/`AG_THRESHOLD_7DAY`/`AG_THRESHOLD_MONTHLY`).                                 |

None of these are project-specific coordination policy (no coordinator
roles, task queues, or branch-assignment concepts) — that boundary is intentional; see
`docs/architecture.md`.

## Stale transport-row cleanup

Authenticated sockets are the only transport-connectedness authority. Complete
`(launch_id, launch_parent_pid)` provenance declares a durable registration;
complete absence declares a legacy connection-scoped registration. Numeric PID
existence does not identify the original process after disconnect because PIDs
are reusable.

The daemon protects all rows during the wire client's bounded startup/reconnect
window. When the last sibling transport closes, that session gets a fresh grace
window. After grace, the first automatic pass and the existing six-hour cleanup
cadence call the same synchronous classifier used by
`tribe-wire repair --reap-stale-transports`. It checks the authenticated
registry again immediately before one SQLite transaction deletes
`room_members` and `sessions`. Complete launch provenance, partial/malformed
provenance, and every active sibling remain. Messages and pending balls are
never touched. Cleanup never signals a process and never restarts the daemon.

## Troubleshooting

- **`No daemon running (socket: ...)`** from any `tribe-wire` verb → nothing
  is listening at the resolved socket path. Start the declared supervisor
  service, use an explicit autostart-enabled hook/install path, or run
  `bun packages/daemon/src/daemon.ts` yourself from a clone. Provider bridges
  intentionally do not start it. See [install.md](install.md).
- **`tribe-wire doctor` reports STALE** → the _running_ process's code is
  provably older than what's on disk (or on disk is older than the
  superproject's pin). This is the `code_pin` mechanism
  (`packages/daemon/src/lib/code-pin.ts`) — it exists because Bun loads
  source once at process start with no hot-reload of its own, so a
  long-lived daemon can silently keep serving pre-fix handlers after a
  `git pull`. A daemon too old to even populate `code_pin` in its own
  `tribe.health()` reply is treated as stale _by the absence of that field_
  — the detector can't run inside a daemon too old to contain it, so the
  probe lives in the CLI instead. Fix: update the pin if it's behind, stop
  the stale process, then let the declared supervisor or an explicit
  autostart-enabled lifecycle hook start a fresh one.
- **A daemon that "wins" the bind election never seems to update after a
  `git pull`** → that's exactly the `code_pin` case above; `doctor` is the
  detector, `reload` (or a manual stop) is the fix.
- **Split-brain worries during concurrent spawns** → by design, a losing
  candidate never unlinks the winner's socket (see Election above); if you
  see two daemon processes running against the same socket path, one of
  them lost the bind race and should already be exiting on its own —
  give it a moment before investigating further.
