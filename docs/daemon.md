# Daemon lifecycle

`tribe-daemon` (`packages/daemon/`) is the broker: one process per machine
(scoped by socket path), Unix socket server, SQLite state, session registry,
message journal, and daemon plugins. This is the standalone-install view of
its lifecycle — autostart, socket/DB location, election, hot-reload,
stop/restart, and troubleshooting — all read directly from
`packages/daemon/src/daemon.ts` and its `lib/compose/*.ts` factories.

## Autostart

Autostart is **not** something the daemon does to itself — it's something a
_caller_ (a hook dispatch, or the stdio adapter's `connectOrStart`) does when
it can't reach a socket. The core helper is
`ensureTribeDaemonIfConfigured()` (`packages/daemon/src/lib/autostart.ts`):

1. Resolve the configured mode (`resolveAutostart()` — see
   [install.md](install.md) for the config file). `"library"` or `"never"`
   → no-op, immediately.
2. Probe the socket with a short (50–200ms) connect attempt.
   Already alive → no-op.
3. If dead and mode is `"daemon"`, spawn a **detached, unref'd** child
   (`spawn(bunPath, [scriptPath, ...], { detached: true, stdio: "ignore" })`)
   and return immediately — this is fire-and-forget; the caller does not
   wait for the socket to become ready.

The whole operation is budgeted at **300ms** by default and is designed to
never block a Claude Code hook: probe failures and spawn failures are
swallowed with a single log line, and the caller falls through to its own
library-mode fallback for that one turn.

The Claude Code plugin path autostarts by a different, simpler mechanism:
`plugins/claude/server.ts` sets `TRIBE_DAEMON_SCRIPT` before importing the
stdio adapter, so the wire client's own `connectOrStart(socketPath, {
daemonScript, ... })` spawns the daemon on first connect failure instead of
throwing. Either path lands at the same place: a detached `bun
packages/daemon/src/daemon.ts` process.

## Socket location

Resolved by `resolveSocketPath()` (`packages/wire/src/paths.ts`), priority
order:

1. Explicit `--socket <path>` argument
2. `TRIBE_SOCKET` env var
3. `$XDG_RUNTIME_DIR/tribe.sock`
4. `~/.local/share/tribe/tribe.sock` (default when no XDG runtime dir)

The daemon `chmod`s the socket to `0600` right after binding.

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

Two independent pieces, both in `withHotReload`:

- **`tribe.reload` (RPC) / `tribe-wire reload` (CLI) / `SIGHUP`** — all three
  trigger the same `reload()`. It stops daemon plugins first (so any
  file-cursor state flushes before the process changes), marks the socket as
  "handed off," closes + unlinks it, then spawns a **detached** replacement
  with a **fresh** bind (no fd inheritance). The old process exits ~1s
  later (`spawnDelayMs`), with a hard `SIGKILL` self-destruct backstop at
  +1.5s in case the clean shutdown path is somehow starved. Reconnecting
  clients (`createReconnectingClient`) ride out the sub-second gap
  transparently via their own backoff.

  (An earlier version tried to hand off the _listening fd itself_ to the
  child for a zero-gap reload — abandoned because Bun's `node:net` throws on
  `server.listen({ fd })`, which crash-looped the child under Bun. The
  close-then-fresh-bind approach costs a brief reconnect window but actually
  works.)

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

Net effect: the daemon costs nothing while idle (it exits itself) and comes
back on the next connect attempt (via autostart) — no lifecycle ceremony
either way, by design.

## Stop / restart

There is no dedicated `stop` subcommand. In practice:

- **Graceful stop**: send `SIGTERM`/`SIGINT` to the daemon's pid (find it via
  `tribe-wire status`/`health`, both of which print `daemon.pid`) — the
  `withSignals` factory routes both to the same shutdown path as idle-quit.
- **Restart to pick up new code**: `tribe-wire reload` (or the `tribe.reload`
  MCP tool) — see Hot-reload above. This is the normal path; it's what you
  want after pulling new tribe source.
- **Force a clean respawn** (e.g. after `tribe-wire doctor` reports stale
  code and a reload isn't trusted): stop the process manually, then let the
  next autostart-eligible connection spawn a fresh one from current disk —
  `doctor --fix`'s printed remedy is exactly this sequence.

## Daemon plugins

`daemon.ts` loads a fixed plugin list unless `TRIBE_NO_PLUGINS` is set:
`gitPlugin`, `beadsPlugin`, `githubPlugin`, `healthMonitorPlugin`,
`accountlyPlugin`. Each is self-gating via an `available()` check, so none
of them require anything from a standalone/non-hab install:

| Plugin           | Gate                                                               | What it does                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git`            | `git rev-parse HEAD` succeeds in cwd                               | Broadcasts a status message when `git log -1` HEAD advances (30s poll).                                                                                               |
| `beads`          | `.beads/backup/issues.jsonl` exists (found by walking up from cwd) | Broadcasts issue-tracker (bead) state transitions (new/claimed/closed/status-change), snapshotting current state on start so history isn't replayed.                  |
| `github`         | `GITHUB_TOKEN` env or `gh auth token` succeeds                     | Polls the GitHub API and broadcasts push/workflow_run/pull_request/issues events; configurable via `GITHUB_POLL_INTERVAL`, `GITHUB_EVENTS`, `GITHUB_WORKFLOW_NOTIFY`. |
| `health-monitor` | (always available)                                                 | Backs `tribe.health()`'s diagnostics.                                                                                                                                 |
| `accountly`      | `~/.config/ag/accounts.json` exists                                | Monitors Claude subscription quota usage and warns near thresholds (`AG_THRESHOLD_5HOUR`/`AG_THRESHOLD_7DAY`/`AG_THRESHOLD_MONTHLY`).                                 |

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
  is listening at the resolved socket path. Either let autostart spawn one
  (if you're on a path that has `TRIBE_DAEMON_SCRIPT` wired) or run
  `bun packages/daemon/src/daemon.ts` yourself from a clone. See
  [install.md](install.md).
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
  the stale process, let the next connection autostart a fresh one.
- **A daemon that "wins" the bind election never seems to update after a
  `git pull`** → that's exactly the `code_pin` case above; `doctor` is the
  detector, `reload` (or a manual stop) is the fix.
- **Split-brain worries during concurrent spawns** → by design, a losing
  candidate never unlinks the winner's socket (see Election above); if you
  see two daemon processes running against the same socket path, one of
  them lost the bind race and should already be exiting on its own —
  give it a moment before investigating further.
