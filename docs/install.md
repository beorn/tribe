# Install

Tribe has two independent install paths: the **Claude Code plugin** (bundled
MCP registration + daemon autostart) and the **npm `tribe-wire` package**
(protocol client only — for any other MCP host, or for scripting against a
daemon directly). Both talk to the same daemon and the same Unix socket; pick
based on what's launching the client.

## Requirements

- **Bun `>=1.3.13`** — the daemon, wire client, and recall engine are all
  `.ts` files run directly by Bun (no build step for local/source use).
  `node >=22.5.0` (root workspace: `>=23.6.0`) is declared in `engines` but
  Bun is the runtime every script in this repo assumes.
- **A Unix domain socket** — the daemon binds a `node:net` Unix socket
  (`createServer().listen(socketPath)`). There is no Windows code path
  anywhere in the wire/daemon source (no `win32` branches) — this is
  macOS/Linux only today.
- **Nothing else is required to get FTS5 search working.** LLM-backed recall
  features (synthesis, query planner, session summaries) are optional and
  degrade loudly to their no-LLM path without `TRIBE_LLM_DIR` configured —
  see [recall.md](recall.md).

## Path A — Claude Code plugin

```text
/plugin marketplace add beorn/tribe
/plugin install tribe@tribe
```

This adds the marketplace at this repo's `.claude-plugin/marketplace.json`
(plugin id `tribe`, source `./plugins/claude`) and installs the plugin.
Restart Claude Code. Two sessions on the same machine can then talk:

```text
tribe.join({name: "a"})     # in session 1
tribe.send({to: "a", ...})  # in session 2
```

**What the plugin actually wires up — and what it does not.** The plugin's
only artifacts are `.claude-plugin/plugin.json` and `.mcp.json` — there is no
`hooks.json` and no `hooks` field anywhere in the plugin. Installing the
plugin registers the `tribe` MCP server (`tribe.join` / `send` / `fetch` /
`members` / `health` / … tools, plus the `/tribe` skill) and gets you daemon
autostart for that MCP connection. **It does not install the
SessionStart / UserPromptSubmit / SessionEnd hooks that drive automatic
recall injection.** If you want recall's per-prompt context injection, see
["Wiring the recall hooks" in recall.md](recall.md#wiring-the-hooks) — that
part is currently a manual `~/.claude/settings.json` edit, not something
`/plugin install` does for you.

The plugin's `.mcp.json` runs:

```text
(cd "$CLAUDE_PLUGIN_ROOT" && bun install --no-summary); exec bun "$CLAUDE_PLUGIN_ROOT/server.ts"
```

`server.ts` sets `TRIBE_DAEMON_SCRIPT` to the resolved path of the `tribe-daemon`
package (`import.meta.resolve("tribe-daemon")`) before delegating to
`tribe-wire`'s stdio adapter — that env var is what lets this path autostart a
daemon on first use, spawning it detached if the socket isn't already alive.
`tribe-daemon` is a **private, unpublished** package (`"private": true` in its
`package.json`) — it only exists inside a full clone of this repository, which
is exactly what `/plugin install` gives you (the whole marketplace repo, not
just the `plugins/claude` subtree — that's why `workspace:*` deps in
`plugins/claude/package.json` resolve at all).

**Direct `.mcp.json` alternative** (no plugin marketplace, no channels) — for
a project that vendors this repo directly:

```json
{
  "mcpServers": {
    "tribe": { "command": "bunx", "args": ["tribe-wire", "mcp"] }
  }
}
```

This route does **not** set `TRIBE_DAEMON_SCRIPT`, so it expects an existing
or forwarded daemon socket — it will not spawn one for you. See "Self-hosting
the daemon" below.

## Path B — npm `tribe-wire`

`tribe-wire` is the only package in this repo published to npm. It is a
**client** — the Unix-socket JSON-RPC protocol, a reconnecting client, the
MCP stdio adapter, and the `tribe-wire` CLI. It does not bundle a daemon.

```bash
bunx tribe-wire mcp --socket /path/to/tribe.sock
npx -y tribe-wire mcp --socket /path/to/tribe.sock
tribe-wire mcp --socket /path/to/tribe.sock   # if installed globally
```

Use this path for any MCP host that isn't the Claude Code plugin — Codex,
Gemini, a custom agent harness, or a remote box reached over an
SSH-forwarded socket. Because `tribe-wire mcp` has no `TRIBE_DAEMON_SCRIPT`
by default, it needs a **reachable daemon** already:

- another process on the same machine already started one (e.g. the Claude
  Code plugin, or a manual `tribe-daemon` run — see below), or
- a remote daemon's socket forwarded over SSH to a local path, or
- you export `TRIBE_DAEMON_SCRIPT=/path/to/tribe-daemon/src/daemon.ts`
  yourself, from a clone of this repo, so `tribe-wire`'s `connectOrStart`
  spawns it on demand exactly like the plugin does.

Without any of those, `tribe-wire mcp` connects, fails, and — per
`connectOrStart` — throws `no daemon at <socket> and no daemonScript provided
to spawn one` (or, from the stdio adapter specifically, degrades to a "loud
but soft" solo mode: the MCP handshake still succeeds, and every tribe tool
call returns one clear sentence saying tribe is unavailable, rather than
hanging or crashing the host session).

### Self-hosting the daemon

`tribe-daemon` is not on npm. To run one yourself (for Path B, or on a
headless box you'll forward a socket from), clone the full repo:

```bash
git clone https://github.com/beorn/tribe.git
cd tribe
bun install
bun packages/daemon/src/daemon.ts                 # auto-discovers the socket path
bun packages/daemon/src/daemon.ts --socket /path   # explicit socket
```

See [daemon.md](daemon.md) for socket/DB path resolution, election between
concurrent spawns, hot-reload, and idle auto-quit.

## Verifying the daemon started

Once you have a `tribe-wire` binary reachable (from either path):

```bash
tribe-wire status    # active sessions, uptime, daemon pid/clients
tribe-wire health     # diagnostics: silent members, unread counts, cadence
tribe-wire doctor     # is the RUNNING daemon's code stale vs on-disk/pin?
```

`status`/`health`/`sessions`/`log`/etc. all report the same failure the same
way when nothing is listening:

```text
No daemon running (socket: /Users/you/.local/share/tribe/tribe.sock)
Start one with: bun tribe-daemon (package tribe-daemon), or let a host autostart it
```

You can also check the socket file directly — default location is
`$XDG_RUNTIME_DIR/tribe.sock` if set, else `~/.local/share/tribe/tribe.sock`
(full resolution rules in [daemon.md](daemon.md)):

```bash
ls -la ~/.local/share/tribe/     # tribe.sock, tribe.db (+ -wal/-shm)
```

A daemon that answers `tribe-wire status` but whose code predates a recent
fix is a different failure mode — that's what `tribe-wire doctor` catches
(`tribe.health()`'s `code_pin` field: running-vs-on-disk-vs-superproject-pin
SHA comparison). `doctor --fix` prints the manual remedy (update the pin,
kill the stale pid, let autostart respawn) — it does not restart anything
for you.

## Autostart config — `tribe-daemon install` / `uninstall` / `doctor`

There is a documented autostart config file,
`~/.claude/tribe/config.json`, read by `resolveAutostart()`:

```json
{ "autostart": "daemon" }
```

- `"daemon"` (default) — hooks/autostart paths spawn a detached daemon
  on first use if none is reachable.
- `"library"` — never spawn; equivalent to setting `TRIBE_NO_DAEMON=1`.
- `"never"` — skip the daemon entirely, even if one is running.

The `tribe-daemon` binary (`packages/daemon/src/daemon.ts`) wires the
plan/apply/doctor logic in `packages/daemon/src/lib/install.ts` into three
subcommands — dispatch-and-exit, same shape as `daemon.ts hook <event>`,
never boots the daemon pipe:

```bash
bun packages/daemon/src/daemon.ts install --dry-run   # preview hooks/mcp/autostart changes
bun packages/daemon/src/daemon.ts install              # write them
bun packages/daemon/src/daemon.ts install --autostart library
bun packages/daemon/src/daemon.ts uninstall [--dry-run]
bun packages/daemon/src/daemon.ts doctor               # is the integration wired up?
```

`install` writes the four Claude Code hooks into `~/.claude/settings.json`,
adds the `tribe` MCP server to `.mcp.json` in `cwd` (skipped if no
`.mcp.json` exists there), and writes the autostart mode above. `doctor`
here is a different check from `tribe-wire doctor` — this one verifies the
Claude Code _integration_ (hooks present and pointing at a real file, MCP
entry present, autostart mode readable), not whether a running daemon's code
is stale. If you'd still rather hand-write the JSON file, that keeps
working; `TRIBE_NO_DAEMON=1` remains the reliable env-var equivalent for a
single process.
