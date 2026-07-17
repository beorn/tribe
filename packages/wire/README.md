# tribe-wire

Tribe wire client library + unified `tribe-wire` CLI binary. Connects to the
Tribe daemon via Unix-socket IPC over JSON-RPC 2.0.

Package-runner entrypoint:

```bash
bunx tribe-wire mcp --socket /path/to/tribe.sock
npx -y tribe-wire mcp --socket /path/to/tribe.sock
```

If installed globally, the command is still `tribe-wire`:

```bash
tribe-wire mcp --socket /path/to/tribe.sock
tribe-wire status
```

## What's in the box

This package is the **wire/protocol surface** for the tribe daemon —
everything an external coding agent (Claude Code, Codex, Gemini, etc.) needs
to participate in a tribe without bundling the daemon itself.

### `tribe-wire` CLI

12 protocol verbs that read or send via the daemon's Unix socket. Each is a thin RPC wrapper:

| Family         | Verbs                                                                                   | What it does                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| read/inspect   | `status`, `sessions`, `members`, `pending`, `log`, `health`, `inbox-status`, `activity` | Query daemon state — who's connected, what's pending, what's been said, daemon health, the unified activity log            |
| send/messaging | `send`, `retro`, `alarm`, `alarm-status`, `alarm-ack`                                   | Send tribe messages (DM or broadcast), generate a retro, raise/clear the andon-pull alarm                                  |
| MCP adapter    | `mcp` (argv-forwarded; not Commander-parsed)                                            | Bridges Claude Code's stdio MCP wire to the tribe daemon's Unix socket — the entry point referenced by `.mcp.json` configs |

```bash
tribe-wire --help                                 # full Commander help + addHelpText MCP-adapter hint
tribe-wire status                                 # active sessions with uptime + last-seen
tribe-wire members --all                          # JSON transport + owner verdicts, including disconnected rows
tribe-wire send '@chief' 'task X done' --type=notify
tribe-wire retro --since 2h --format markdown
tribe-wire mcp --name '@agent/3' --role member    # argv-forwarded; what .mcp.json invokes
```

### Library exports

```ts
import { connectToDaemon, resolveSocketPath } from "tribe-wire/lib/socket"
import { TRIBE_PROTOCOL_VERSION } from "tribe-wire/lib/socket"
```

JSON-RPC client, reconnecting client, line parser, composition primitives (pipe / Scope / Tool registry). See `src/lib/socket.ts`.

`members --all` is the daemon-side rejoin verdict. `transport_state` is derived
from the authenticated socket registry; `owner_state` is separate process
evidence. `last_seen_sec` reports activity age only. A host MCP dialog may say
connected while the daemon reports the member disconnected, so host UI state is
not a substitute for this projection.

## Surface delineation — protocol vs dev tooling

If a verb belongs on the daemon protocol, it lives **here**. If a verb owns
daemon lifecycle, it belongs in `tribe-daemon`. If a verb is host-specific, it
belongs in that host plugin.

This split is intentional. Standalone npm consumers should not pull in the
daemon, recall wiring, or host-specific hook router just to talk to a daemon.
The protocol verbs above are sufficient for any external agent that wants to
participate in a tribe; daemon lifecycle, install, and hook integration move
to daemon/plugin surfaces.

See [`@km/bearly/19231-tribe-cli-unify-phase-a2-verbs`](https://github.com/beorn/km/blob/main/%40km/bearly/19231-tribe-cli-unify-phase-a2-verbs.md) for the architectural decision (chief verdict 2026-05-26 — "Q3 approved").

## License

MIT
