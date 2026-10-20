---
description: "Tribe coordination — check sessions, send messages, view health/history. Use when user says /tribe."
allowed-tools: mcp__tribe__tribe.members, mcp__tribe__tribe.send, mcp__tribe__tribe.fetch, mcp__tribe__tribe.rename, mcp__tribe__tribe.health, Bash(sqlite3:*)
---

# Tribe

Cross-session coordination. Parse the subcommand from ARGUMENTS.

## Command Mapping

| User Says                      | Action                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tribe`                       | `tribe.members()` — show registrations, connector transport and mailbox progress                                                                                    |
| `/tribe status`                | `tribe.members()` + `tribe.health()` — full dashboard                                                                                                               |
| `/tribe health`                | `tribe.health()` — warnings, silent members, unread counts                                                                                                          |
| `/tribe sessions`              | `tribe.members()` — list known registrations without an agent-life verdict                                                                                          |
| `/tribe sessions --all`        | `tribe.members(all=true)` — add retained registration history to transport and mailbox observations                                                                 |
| `/tribe send <to> <message>`   | `tribe.send(to, message)` — send notify message                                                                                                                     |
| `/tribe assign <to> <message>` | `tribe.send(to, message, type="assign")` — assign work                                                                                                              |
| `/tribe query <to> <message>`  | `tribe.send(to, message, type="query")` — ask a question                                                                                                            |
| `/tribe broadcast <message>`   | `tribe.send(to="*", message)` — message everyone                                                                                                                    |
| `/tribe history`               | `tribe.fetch(since=0, limit=20)` — recent visible messages                                                                                                          |
| `/tribe history <name>`        | `tribe.fetch(with=name, limit=20)` — messages with specific session                                                                                                 |
| `/tribe rename <new_name>`     | `tribe.rename(new_name)` — rename this session                                                                                                                      |
| `/tribe whoami`                | Show this session's name, role, and domains                                                                                                                         |
| `/tribe db <sql>`              | `sqlite3 <tribe-db-path> "<sql>"` — raw query                                                                                                                       |
| `/tribe log`                   | `sqlite3 <tribe-db-path> "SELECT sender, recipient, type, substr(content,1,80), datetime(ts/1000,'unixepoch','localtime') FROM messages ORDER BY ts DESC LIMIT 20"` |
| `/tribe events`                | `sqlite3 <tribe-db-path> "SELECT type, sender, datetime(ts/1000,'unixepoch','localtime') FROM messages WHERE kind = 'event' ORDER BY ts DESC LIMIT 20"`             |
| `/tribe sync`                  | Broadcast asking all members to ensure their work is tracked (see below)                                                                                            |
| `/tribe rollcall`              | Broadcast asking all members to report name, status, and current work                                                                                               |

## Output Format

Keep output concise. For `tribe.members`, format as a table. For `tribe.health`, highlight warnings. For `tribe.fetch`, show as a chat log with timestamps.

## `/tribe sync` Protocol

Broadcast this message to all members:

```
Sync check: report your current status.

1. Your session name (/rename) and Claude session ID (echo $CLAUDE_SESSION_ID)
2. What you're working on — tasks/issues created, updated, closed this session
3. BLOCKERS: anything you're blocked on, what's blocking, and what would unblock
4. NEEDS: anything another member could help with (review, info, shared resources)
5. INFRASTRUCTURE: active worktrees, in-flight refactors, running test suites, unpublished packages, or shared config changes

Reply to the requesting coordinator with your summary.
```

After responses come in:

1. Summarize the results as a table for the user
2. **Cross-match blockers**: if member A is blocked on something member B could unblock, proactively suggest the assignment or send a tribe.send to coordinate
3. **Infrastructure conflicts**: check for overlapping worktrees, concurrent test runs, half-migrated code, unpublished package dependencies
4. **Suggest renames**: if a member has a generic name (member-N) but clear domain focus, suggest they `/tribe rename` to a domain name
5. Flag any tasks that have been in_progress too long without updates

## `/tribe rollcall` Protocol

Broadcast this message:

```
Roll call: please report your current session name (/rename), what you're working on, and your status (idle/busy/blocked). Reply with tribe.send to the coordinator who asked.
```

Collect responses and present as a table.

## Notes

- If tribe tools are not available (MCP server not loaded), tell the user to launch with: `claude --dangerously-load-development-channels server:tribe`
- `/tribe whoami` reads from the MCP server instructions (check if "chief" or "member" appears)
- The tribe DB is at `~/.local/share/tribe/tribe.db` (user-level default). Legacy `.beads/tribe.db` is auto-migrated to the XDG path on first daemon start after upgrade. Override via `--db` flag or `TRIBE_DB` env.

## Delivery modes — `push` vs `pull`

Each session declares a delivery mode at join time. The daemon routes broadcasts and DMs accordingly. **Senders stay transport-blind** — `tribe.send({to: "codex1", message: "..."})` works the same regardless of how the recipient receives it.

| Mode     | When to declare                                                                         | How it works                                                                               |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **push** | Default. Claude Code, Agent SDK, or any client with an MCP notification-channel reader. | Daemon fans events out on the MCP channel; client sees them as `<channel source="tribe">`. |
| **pull** | Codex, Gemini, or any MCP-only client without a notification reader.                    | Events queue in SQLite; client drains via `tribe.fetch`.                                   |

**How to declare on join.** Pass `delivery: "push" | "pull"` to `tribe.join`. The stdio-adapter reads the `TRIBE_DELIVERY` env var and threads it into the join call automatically — pull-mode clients usually never call `tribe.join` directly; setting the env on the MCP server entry is enough.

**Codex example** (`~/.codex/config.toml`):

```toml
[mcp_servers.tribe.env]
TRIBE_DELIVERY = "pull"
```

MCP `inbox.wait` is diagnostic-only: it defaults to a host-safe 5,000ms and the
measured native-host ceiling is 10,000ms. Requests at or above that ceiling
return typed `host_cut` with `advice: "cli_wait"` before the daemon wait starts.
Use one bounded `tribe inbox-wait` CLI call for longer idle waits; never re-arm
short MCP calls as a polling loop.

**Draining in pull mode.** `tribe.fetch()` is the canonical "give me my events" call. Default drain returns a read-only `attention` projection first (`actionable_unread` contains unacknowledged direct request/query/verdict/assign/response rows, direct status/notify rows from another named seat whose ref names an open request ball the reader owns or sent, plus tracked actionable direct or broadcast messages (including automatically tracked authenticated request/query/assign broadcasts) still awaiting this owner's TAKING or settlement; responses and those status/notify rows remain quiet for default waits), plus the 10 oldest `pending_balls` and a lossless `pending_balls_summary` from the existing tracker, followed by the bounded chronological `events`, and advances the existing cursors. Use `tribe.pending` for the full ball pile. Filtered reads remain snapshots and omit `attention`.

**Watch clients** (`tribe-watch`, `tribe-cli` log/events) always receive push regardless of the recipient's declared mode — the per-session toggle only gates _agent-bound_ fanout.

**Future arc.** Once silvercode squad mode merges, it will wrap codex/gemini sessions and re-advertise them as push by proxying the notification channel through the host. Pull is the transitional fallback for MCP-only clients today; long-term the host owns the channel and squad members go back to push.

**Internals** (for daemon work): per-session delivery lives in `sessions.delivery` (schema v12, NOT NULL DEFAULT `'push'`). The fanout filter is in `tools/lib/tribe/compose/with-broadcast.ts` — `toConnected` skips socket fanout for pull-mode recipients.

## Topic Trust Tiers

The canonical topic-to-trust registry lives in `vendor/tribe/tools/lib/tribe/trust.ts` and is exported through `tribe-wire` for prompt adapters. Unknown topics fail closed to `external`.

| Topic glob   | Trust tier | Treatment                                                    |
| ------------ | ---------- | ------------------------------------------------------------ |
| `tribe.send` | `internal` | Rostered peer messages: sanitized, length-capped, fenced     |
| `daemon:*`   | `daemon`   | Daemon lifecycle/session events: fenced                      |
| `health:*`   | `daemon`   | Daemon health/account/reaper/git-lock events: fenced         |
| `bead:*`     | `internal` | Local bead observer events: sanitized, length-capped, fenced |
| `git:commit` | `external` | ID-only stub by default                                      |
| `github:*`   | `external` | ID-only stub by default                                      |
| `ci:*`       | `external` | ID-only stub by default                                      |

## Tool reference — what the MCP schemas do not say inline

Every listed MCP tool is re-read by the model on every turn, so the tool descriptions and schemas carry only what a call needs; the semantics below are read here, on demand. Two daemon verbs the installed CLI covers are not listed as MCP tools at all: `tribe repair` (`--reap-stale-transports --json`, or `--inbox-cursor tail --session <name>`) and `tribe retro` (`--since <duration>`, `--format markdown|json`). Both stay daemon verbs the MCP server still answers by name. `filter`, `lifecycle.publish`, `health.publish`, `lifecycle` and `debug` have no CLI verb and stay listed.

### `send`

- **Body and summary.** `message` is capped at 4096 characters; the client rejects more before sending, so put larger content in a file and send a pointer with its sha. `summary` is required from an LLM sender; a non-LLM caller that omits it gets one derived from the first line, flagged `summary_derived: true`. `message_id` is a client UUID; retrying it is a no-op that returns the original id (`deduplicated: true`).
- **Balls.** Direct `request`/`query`/`assign` messages, and authenticated broadcasts of those types, automatically open recipient-owned balls. `request: true` tracks another eligible message; a string other than `"true"` sets the ball id. A broadcast ball defaults to `fanout: "first"` (one ball, the first reply settles it for everyone); `all` opens one ball per recipient. Requests and queries default to a 20-minute deadline; `expires_in_ms` overrides it up to one day. Expiry never settles ownership.
- **Settling.** `reply: "<request id>"` with `response` or `verdict` settles; `tracker.closed > 0` is the only proof of release, and `tracker.cause` names the exact journal-backed reason when it is 0 (already settled and by whom, settled by another owner under `fanout: first`, or never tracked). `reply_close_failed: true` means the message was delivered but nothing was settled, so re-read `pending` and reply again with the exact id; `sent: true` never means the ball closed. `status`/`notify` + `reply` only correlate, as `ref` does, and leave the ball and its deadline open.
- **TAKING receipts.** `status` + `ref` naming an open ball you own is a TAKING receipt. With `expires_in_ms` it re-sets that ball's due from now, within one day of the ball's opening; the result reports it under `applied_due`.
- **Incidents.** `incident: { emitter, subject, condition }` holds one standing ball per live condition; repeats on the same triple upsert it and `active: false` clears it. The summary is the condition and the body the observation: the open, and an upsert whose summary changed, wake the owner's inbox wait; a repeat with the same summary, and the clear, never do. The result's `incident.transition` is `opened | changed | repeated | cleared` with `wakesOwner`. Exactly one recipient, and mutually exclusive with `request`. `incident_data` is an opaque JSON value stored with the observation and preserved by archive. `if_current` is the complete expected set of `{ recipient, message_id }` holdings for the incident identity, compared inside the mutation transaction (`[]` expects none); a mismatch returns `sent: false` with `conflict` and mutates nothing. Policy-managed emitters must pass it; an accepted UUID retry is reauthorized before deduplication.
- **Delivery report.** Each direct delivery (`delivery`, or `deliveries` for several recipients) carries `state: online | offline | bounced | parked`; an online, offline or parked row adds the recipient's answer reason and `last_mailbox_read_age_ms` (null when it never read). `offline` with reason `connected-no-consumer` is a live seat nothing is consuming right now: the mail is in its mailbox and it reads at its next tick, so judge it by the read age, never the bare state. A tracked request with no reachable recipient and no declared fallback is journaled and refused: `error` with `delivery_failure_id` and `observed_at`, and no message or pending row is created. `warning` is set when the summary was derived, an older daemon truncated the body (`truncated: true`, legacy daemons only), or an untracked direct notify/status named a recipient with no live transport; delivery is not refused. `original_length` is always present and is the length the cap was measured against.

### `pending`

- **Views.** The default view lists the open requests an owner must answer, and keeps live deadline-passed requests visible. `expired: true` adds journal-backed history: rows collapse to one per `(request_id, recipient)` with older generations under `superseded_count`, each carrying `backing: "live"` (a pending request still stands behind it, so it is genuinely owed) or `"journal"` (manual close, incident cleared, gc-expired, sender withdrawn, or an unsettled ghost no close can reach). Answered rows are always omitted; `owed: true` keeps only the live rows. `emitter` returns the complete open-incident snapshot for one emitter across every recipient; it requires emitter authority, excludes every other selector, and acknowledges no mailbox. A stored row whose `incident_data` is not valid JSON is still returned, with `incident_data: null` and `incident_data_invalid: true` on that row; one corrupt observation never costs the caller the rest of the snapshot.
- **Owner snapshot on every row.** `owner_transport_registered`, `owner_transport_state`, `owner_state`, `owner_answer_capability`, `owner_transport_reason`, `owner_last_mailbox_read_age_ms` (null when the owner never read) and `owner_transport_observed_at`. Answer capability is observed only when the owner has a connected, PID-live transport, a readable mailbox, and something consuming it (push delivery to a registered client, or an inbox wait the owner parked). `connected-no-consumer` means reachable and reading at its next tick, so branch on the reason and the read age, never the bare capability; `mailbox-read-unavailable` means the owner cannot read its mailbox. These describe observation time only and never auto-close or reroute an obligation. With no transport source wired, the snapshot is the honest absence rather than a guess: `owner_transport_live: null`, `owner_transport_registered: null`, `owner_transport_state: "unknown"`, `owner_transport_reason: "no-transport-source"`. Test the live flag with `=== false`, never truthiness — `!null` would read "not measured" as offline.
- **Closing without a reply.** `close: "<request id>"` closes one ordinary request after verified out-of-band completion. An incident needs `close_evidence` (a verbatim attestation, recorded with the authenticated actor and not verified) and its owner or dispatcher `@chief`; its emitter clears it instead with `--incident-cleared`. Read, prune, batch and ordinary closes refuse evidence. When a close closed 0 rows, `warning` leads with the journal-backed cause and then names the owner's other open ids. `prune` with `stale_ms` settles the owner's older requests as gc-expired.

### `inbox.wait`

- `unread_count` is unread attention plus tracked actionable direct or broadcast messages without a later owner TAKING receipt, de-duplicated by message; incident balls are excluded. `timed_out` is true only when no qualifying row newer than the wait baseline arrived AND no actionable attention row arrived during the window: at the deadline, a retained `actionable_unread` row that arrived after the baseline (a direct response wakes nothing live unless correlated, yet it is attention) settles `woken` with `woken_by` naming the newest such row (30414); attention that predates the wait keeps `timeout` and stays listed.
- `woken_by.kind` is `message` (with `seq`, `message_id`, `type`, `sender`, `summary`, the ball it opened or moved as `request_id`, and for a correlated reply `settles_request_id`), `daemon-shutdown` (reconnect), or `row-retired` (only `seq`). `replay: true` means the wake re-presents an untaken ball the mailbox already passed, so it is not new and must not be re-acknowledged; `sent_at` keeps the original timestamp.
- `wake_on_correlated_reply: true` also wakes on a validated reply settlement to one of this seat's tracked requests, and on a direct status or response whose ref names an open ball this seat requested; verdicts already wake, and status/notify correlation never closes anything.

### `fetch`

- `receipt: false` is for a relay that forwards fire-and-forget and cannot know the model saw a row (an adapter wake-up drain, a host-stream bridge): the read returns attention and may advance the ambient cursor, but never acknowledges the mailbox and never counts as the seat's attention read, so the rows stay in `actionable_unread` until the model's own read returns them (21757). A model-initiated read is always a receipt.
- `ids` accepts a full id or a unique prefix of at least 8 characters; an ambiguous or unknown prefix is refused by name. Each event is `{ id, rowid, type, from, to, content, bead?, ref?, ts, delivery, topic?, room_id? }`; the default drain omits rows already carried in `attention.actionable_unread`, so attention ∪ events is the delivered set.

### `members` and `health` — separate contracts

- **`members`: `tribe-members/2`.** Default contains connected rows plus each otherwise absent name's latest nonfinished durable registration. `all:true` adds retained history. `registration` records provenance/state; `transport_state`, `owner_state` and `transport_pids` describe connectors only. There is no agent `alive` flag or Hab supervisor PID in this envelope.
- **Mailbox facts:** `mailbox_read_capability` reports authority. `mailbox_progress` reports the actual canonical READ timestamp, age and mailbox-name scope, or explicitly unobserved fields. A name-scoped READ does not identify which launch consumed an assignment; a successful `join` acknowledges registration only, not bootstrap's separate useful turn. Working CLI inbox reads need no persistent socket. Missing transport alone proves neither agent death nor a need to reconnect; use independent runtime evidence for process life.
- **`health.members` only (unchanged):** `delivery` (push|pull); `transport_state`/`transport_alive` (connected|disconnected, daemon-authoritative, pid-probed at read time for connected rows and never asserted from registry presence alone); `owner_state` (live|dead|unknown: a disconnected row's stored numeric PID is reusable and proves nothing, so without identity-bound process evidence the owner is unknown); `mailbox_read_capability` (available|unavailable, with the observed reason); `answer_capability` with `answer_reason` (`connected-pid-live-transport`, `connected-no-consumer`, `mailbox-read-unavailable`, or a transport-down reason) and `last_mailbox_read_age_ms`; `transport_registered` (the raw registry fact: a registration whose pids are provably dead reads registered but disconnected with reason `registered-transport-pids-dead`, so no row pairs a connected transport with a dead pid); `agent_alive`, `pid_alive`, silence-derived `is_silent`, and legacy `alive` as their conservative conjunction (disconnected rows are never pid-probed, so their `pid_alive`/`agent_alive` read true by default while `alive` stays false). Also `transport_pids`, `uptime_min`, activity-only `last_seen_sec`, `adapter_exit_record` for a supervised plugin adapter, and `foreign_transport` (name, launch_id, pid, refused_at) with reason `transport-carries-another-seats-identity` when the daemon refused a connector for presenting this seat's authority under another seat's name. An identity retired by explicit delivery policy stays visible under `all` but no longer counts as a missing live seat.
- `membership_discrepancy` (same projection in both tools, so missing is never aliased to absent): connected-durable, known-durable and missing counts with the missing launch identities, plus `finished_count` for disconnected durable rows whose journaled departure was the last thing that happened to them (`members.finished_launches`; never a degradation signal). With a declared roster (`TRIBE_EXPECTED_MEMBERS`, or the file in `TRIBE_EXPECTED_MEMBERS_FILE`, a plain per-name expected boolean) it adds `expected_count` and `connected_expected_count`, `missing` can carry `never-registered` or `foreign-identity-transport`, and `dormant_count`/`departed_sibling_count`/`departed_foreign_count` appear for on-demand or undeclared rows (`members.dormant_launches`, `departed_launches` with `why: undeclared-sibling` when the name's family, the part before its last `/`, matches a declared name, else `undeclared-foreign`; and `unexpected_connected`, which `health` never lists). Absent a declaration none of this moves.
- `health` adds `transport_wedges` (disconnected addressable launch rows with `wedge_reason`; retired identities excluded, unidentified rows counted under `anonymous_disconnected`), `cadence` (24h response latency, open balls, connected-session cursor lag and database growth, every subprojection stamped `as_of_ms`; cursor lag is projection-only and never a seat-liveness verdict), and `identity` (the verifier path the daemon booted with, null when none, `supplies_gen`, and live sessions per authority: `verified`, or `claimed` for a session registered without a verified token, which cannot read its own mailbox). A pending-request projection that disagrees with the tracker, or a stored count that could not be read, is an `issues` entry starting `projection_incomplete`; the page is still the answer, and a missing count is never reported as a measured zero.

### The diagnostic and publisher verbs

- `filter` governs both the push wakeup and what a fetch drain returns: `focus` is addressed plus actionable only, `normal` everything minus active mutes, `ambient` everything; `mute` silences topic globs until `until` (unix ms; absent means persistent); empty args clear the filter. Filtered rows stay durable and reachable through an explicit history read (`from`/`with`/`since`); they are simply not delivered. The stdio adapter's `TRIBE_FILTER_MODE` sets the initial mode at launch.
- `tribe repair` (CLI): `--inbox-cursor tail` advances only the ambient inbox cursor to the journal tail; `reconcile` is refused because the actionable mailbox cursor is advance-only (21757), and `tribe inbox-drain --session <name>` acknowledges a seat's unread actionables on its behalf. `--reap-stale-transports` reaps disconnected connection-scoped registrations after the reconnect grace and preserves durable launch rows, active siblings, messages and pending balls; the result reports examined/reaped counts and reasons.
- `lifecycle.publish` stores an opaque, publisher-owned snapshot (for example `{ currentState, activeTool, elapsedMs, softDeadlineMs, hardDeadlineMs }`), last write wins per seat; `sessionName` keys it for a multiplexing publisher that observes many sessions over one connection. `lifecycle` reads one seat's latest snapshot (`{ sessionName, sessionId, receivedAt, payload }`, or null) or every cached snapshot newest first.
- `health.publish` broadcasts an agent recovery (force-settle, restart, rotation) with the server-set topic `health:recovery`; clients cannot set topics through `send`. `agent` and `seq` are consumer metadata for de-duplication and ordering.
- `rename` renames the live session; `join` with a new name does the same and reports `previous_name`. `tribe retro` (CLI) is the coordination retrospective. `debug` dumps clients and per-session cursors.
