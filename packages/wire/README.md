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

| Family         | Verbs                                                                        | What it does                                                                                                               |
| -------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| read/inspect   | `status`, `sessions`, `pending`, `log`, `health`, `inbox-status`, `activity` | Query daemon state — who's connected, what's pending, what's been said, daemon health, the unified activity log            |
| send/messaging | `send`, `retro`, `alarm`, `alarm-status`, `alarm-ack`                        | Send tribe messages (DM or broadcast), generate a retro, raise/clear the andon-pull alarm                                  |
| MCP adapter    | `mcp` (argv-forwarded; not Commander-parsed)                                 | Bridges Claude Code's stdio MCP wire to the tribe daemon's Unix socket — the entry point referenced by `.mcp.json` configs |

```bash
tribe-wire --help                                 # full Commander help + addHelpText MCP-adapter hint
tribe-wire status                                 # active sessions with uptime + last-seen
tribe-wire send '@alice' 'task X done' --type=notify
tribe-wire send '@ci' 'R656 failed; see journal evidence' --type=notify --delivery=pull
tribe-wire retro --since 2h --format markdown
tribe-wire mcp --name '@bob' --role member    # argv-forwarded; what .mcp.json invokes
```

`send --delivery push|pull` classifies one message independently of the
recipient session's delivery mode. `push` is the default and permits live
channel fanout; `pull` persists the message for inbox reads without a channel
wakeup. Delivery classification is orthogonal to semantic ball tracking: only
the message type and `--request` decide whether a pending ball opens.

### Library exports

```ts
import { connectToDaemon, resolveSocketPath } from "tribe-wire/lib/socket"
import { TRIBE_PROTOCOL_VERSION } from "tribe-wire/lib/socket"
```

JSON-RPC client, reconnecting client, line parser, composition primitives (pipe / Scope / Tool registry). See `src/lib/socket.ts`.

## Surface delineation — protocol vs dev tooling

If a verb belongs on the daemon protocol, it lives **here**. If a verb owns
daemon lifecycle, it belongs in `tribe-daemon`. If a verb is host-specific, it
belongs in that host plugin.

This split is intentional. Standalone npm consumers should not pull in the
daemon, recall wiring, or host-specific hook router just to talk to a daemon.
The protocol verbs above are sufficient for any external agent that wants to
participate in a tribe; daemon lifecycle, install, and hook integration move
to daemon/plugin surfaces.

The read/send/descriptor verb split follows an internal May 2026 CLI-unification decision; `command-descriptors.ts` keeps the CLI and MCP tool list in lockstep.

## License

MIT
